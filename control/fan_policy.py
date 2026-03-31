from dataclasses import asdict, dataclass
from enum import Enum
from typing import Optional

from control.device_mapping import DeviceMappingConfig, map_percent_to_level


class FanControlState(str, Enum):
    HOLD = "hold"
    RECLAIM = "reclaim"
    ASSIST = "assist"
    VACANT = "vacant"
    LOCKED = "locked"


@dataclass(frozen=True)
class FanPolicyConfig:
    comfort_temp: float = 25.0
    hot_temp: float = 30.0
    comfort_humidity: float = 55.0
    min_occupied_speed: int = 22
    humidity_gain: float = 0.18
    occupancy_gain: float = 2.0
    vacancy_grace_sec: int = 180
    empty_temp_start: float = 27.0
    empty_humidity_start: float = 80.0
    empty_temp_gain: float = 5.0
    empty_humidity_gain: float = 1.5
    empty_max_speed: int = 90
    hold_duration_sec: int = 60
    reclaim_duration_sec: int = 120
    sensor_override_manual_grace_sec: int = 12
    sensor_reclaim_duration_sec: int = 45
    sensor_reclaim_progress_bias: float = 0.35
    manual_anchor_expiry_sec: int = 180
    ema_alpha_temp_rise: float = 0.35
    ema_alpha_temp_fall: float = 0.60
    ema_alpha_humidity_rise: float = 0.30
    ema_alpha_humidity_fall: float = 0.45
    confidence_threshold: float = 0.60
    low_confidence_reclaim_scale: float = 0.4
    startup_user_alpha: float = 0.75
    manual_temp_delta_gain: float = 6.0
    manual_step_up: int = 12
    manual_step_down: int = 12
    auto_step_up: int = 2
    auto_step_down: int = 4
    auto_step_up_max: int = 9
    auto_step_down_max: int = 10
    extreme_temp: float = 39.0
    extreme_humidity: float = 92.0
    extreme_step_up: int = 18
    extreme_step_down: int = 12
    cooling_trend_temp_band: float = 0.5
    humidity_relief_band: float = 3.0
    device_mapping: DeviceMappingConfig = DeviceMappingConfig()


@dataclass(frozen=True)
class FanPolicyRuntime:
    smoothed_temp: float = 29.0
    smoothed_humidity: float = 55.0
    last_occupied_epoch: int = 0
    hold_until_epoch: int = 0
    reclaim_end_epoch: int = 0
    last_manual_intent_epoch: int = 0
    user_anchor_temp: float = 29.0
    user_anchor_percent: Optional[int] = None
    resume_percent: int = 0
    last_user_preference_percent: Optional[int] = None
    applied_percent: int = 0
    auto_target_percent: int = 0
    blended_target_percent: int = 0
    device_level: str = "OFF"
    last_device_change_epoch: int = 0
    phase: FanControlState = FanControlState.VACANT
    last_reason: str = "Initialized."


@dataclass(frozen=True)
class FanPolicyResult:
    state: FanControlState
    auto_target_percent: int
    blended_target_percent: int
    applied_percent: int
    device_level: str
    hold_remaining_sec: int
    reclaim_progress: float
    reason_codes: list[str]
    explanation: str
    runtime: FanPolicyRuntime


def runtime_from_record(record: Optional[dict]) -> FanPolicyRuntime:
    """Convert a DB row or payload dict into the immutable runtime model."""
    if not record:
        return FanPolicyRuntime()
    return FanPolicyRuntime(
        smoothed_temp=float(record["smoothed_temp"]),
        smoothed_humidity=float(record["smoothed_humidity"]),
        last_occupied_epoch=int(record["last_occupied_epoch"]),
        hold_until_epoch=int(record["hold_until_epoch"]),
        reclaim_end_epoch=int(record["reclaim_end_epoch"]),
        last_manual_intent_epoch=int(record.get("last_manual_intent_epoch", 0) or 0),
        user_anchor_temp=float(record.get("user_anchor_temp", 29.0) or 29.0),
        user_anchor_percent=record["user_anchor_percent"],
        resume_percent=int(record.get("resume_percent", 0) or 0),
        last_user_preference_percent=record["last_user_preference_percent"],
        applied_percent=int(record["applied_percent"]),
        auto_target_percent=int(record["auto_target_percent"]),
        blended_target_percent=int(record["blended_target_percent"]),
        device_level=record["device_level"],
        last_device_change_epoch=int(record["last_device_change_epoch"]),
        phase=FanControlState(record["phase"]),
        last_reason=record["last_reason"],
    )


def runtime_to_record(runtime: FanPolicyRuntime) -> dict:
    record = asdict(runtime)
    record["phase"] = runtime.phase.value
    return record


def apply_manual_intent(
    runtime: FanPolicyRuntime,
    requested_percent: int,
    now_epoch: int,
    config: FanPolicyConfig,
) -> FanPolicyResult:
    """Capture user input as an anchor and enter a timed HOLD window."""
    requested_percent = clamp_percent(requested_percent)
    device_level, changed_epoch = map_percent_to_level(
        requested_percent,
        runtime.device_level,
        runtime.last_device_change_epoch,
        now_epoch,
        config.device_mapping,
        enforce_dwell=False,
    )
    next_runtime = FanPolicyRuntime(
        smoothed_temp=runtime.smoothed_temp,
        smoothed_humidity=runtime.smoothed_humidity,
        last_occupied_epoch=runtime.last_occupied_epoch,
        hold_until_epoch=now_epoch + config.hold_duration_sec,
        reclaim_end_epoch=now_epoch + config.hold_duration_sec + config.reclaim_duration_sec,
        last_manual_intent_epoch=now_epoch,
        user_anchor_temp=runtime.smoothed_temp,
        user_anchor_percent=requested_percent,
        resume_percent=max(runtime.applied_percent, runtime.resume_percent) if requested_percent == 0 else requested_percent,
        last_user_preference_percent=runtime.last_user_preference_percent if requested_percent == 0 else requested_percent,
        applied_percent=requested_percent,
        auto_target_percent=runtime.auto_target_percent,
        blended_target_percent=requested_percent,
        device_level=device_level,
        last_device_change_epoch=changed_epoch,
        phase=FanControlState.HOLD,
        last_reason=f"User changed fan speed to {requested_percent}%. Holding this preference temporarily.",
    )
    return build_result(
        next_runtime,
        hold_remaining_sec=config.hold_duration_sec,
        reclaim_progress=0.0,
        reason_codes=["user_intent", "hold_started"],
    )


def resume_from_off(
    runtime: FanPolicyRuntime,
    *,
    now_epoch: int,
    config: FanPolicyConfig,
) -> FanPolicyResult:
    """Restore the last meaningful fan speed after a user turns the switch back on."""

    resume_percent = clamp_percent(runtime.resume_percent or runtime.last_user_preference_percent or 25)
    device_level, changed_epoch = map_percent_to_level(
        resume_percent,
        runtime.device_level,
        runtime.last_device_change_epoch,
        now_epoch,
        config.device_mapping,
        enforce_dwell=False,
    )
    next_runtime = FanPolicyRuntime(
        smoothed_temp=runtime.smoothed_temp,
        smoothed_humidity=runtime.smoothed_humidity,
        last_occupied_epoch=runtime.last_occupied_epoch,
        hold_until_epoch=0,
        reclaim_end_epoch=0,
        last_manual_intent_epoch=runtime.last_manual_intent_epoch,
        user_anchor_temp=runtime.smoothed_temp,
        user_anchor_percent=None,
        resume_percent=resume_percent,
        last_user_preference_percent=runtime.last_user_preference_percent,
        applied_percent=resume_percent,
        auto_target_percent=runtime.auto_target_percent,
        blended_target_percent=resume_percent,
        device_level=device_level,
        last_device_change_epoch=changed_epoch,
        phase=FanControlState.ASSIST,
        last_reason=f"Fan resumed from its previous speed of {resume_percent}% before ramping toward the current room setpoint.",
    )
    return build_result(
        next_runtime,
        hold_remaining_sec=0,
        reclaim_progress=0.0,
        reason_codes=["resume_from_off"],
    )


def evaluate_fan_policy(
    runtime: FanPolicyRuntime,
    *,
    occupancy_count: int,
    raw_temp: float,
    raw_humidity: float,
    now_epoch: int,
    config: FanPolicyConfig,
    confidence: float,
) -> FanPolicyResult:
    """Evaluate one deterministic control step for a room-local fan."""
    if is_uninitialized_runtime(runtime):
        smoothed_temp = raw_temp
        smoothed_humidity = raw_humidity
    else:
        smoothed_temp = ema_directional(
            runtime.smoothed_temp,
            raw_temp,
            alpha_rise=config.ema_alpha_temp_rise,
            alpha_fall=config.ema_alpha_temp_fall,
        )
        smoothed_humidity = ema_directional(
            runtime.smoothed_humidity,
            raw_humidity,
            alpha_rise=config.ema_alpha_humidity_rise,
            alpha_fall=config.ema_alpha_humidity_fall,
        )
    last_occupied_epoch = now_epoch if occupancy_count > 0 else runtime.last_occupied_epoch
    vacancy_elapsed = 0 if occupancy_count > 0 else max(0, now_epoch - last_occupied_epoch)
    within_vacancy_grace = occupancy_count > 0 or vacancy_elapsed < config.vacancy_grace_sec
    extreme_condition = smoothed_temp >= config.extreme_temp or smoothed_humidity >= config.extreme_humidity

    occupied_auto_target = occupied_target(
        occupancy_count=occupancy_count,
        smoothed_temp=smoothed_temp,
        smoothed_humidity=smoothed_humidity,
        config=config,
    )
    vacant_auto_target = vacant_target(
        smoothed_temp=smoothed_temp,
        smoothed_humidity=smoothed_humidity,
        config=config,
    )
    auto_target = occupied_auto_target if within_vacancy_grace else vacant_auto_target
    manual_delta_active = has_active_manual_anchor(runtime, now_epoch, config)
    delta_target = manual_delta_target(runtime, smoothed_temp, within_vacancy_grace, config) if manual_delta_active else None
    effective_target = delta_target if delta_target is not None else auto_target

    reason_codes = []
    hold_remaining = max(0, runtime.hold_until_epoch - now_epoch)
    reclaim_progress = 0.0

    if extreme_condition:
        phase = FanControlState.LOCKED
        reason_codes.extend(["extreme_condition", "safety_override"])
        blended_target = max(runtime.user_anchor_percent or 0, effective_target)
        if runtime.applied_percent == 0 and blended_target > 0:
            applied = startup_percent(
                blended_target=blended_target,
                within_vacancy_grace=within_vacancy_grace,
                config=config,
            )
            reason_codes.append("smart_start")
        else:
            applied = move_toward(
                runtime.applied_percent,
                blended_target,
                config.extreme_step_up,
                config.extreme_step_down,
            )
        explanation = "Extreme heat or humidity allows a stronger bounded safety correction."
    elif hold_remaining > 0 and runtime.user_anchor_percent is not None:
        phase = FanControlState.HOLD
        reason_codes.extend(["hold_active", "user_priority"])
        blended_target = runtime.user_anchor_percent
        applied = blended_target
        explanation = "Recent user input is being respected during the hold window."
    elif runtime.reclaim_end_epoch > runtime.hold_until_epoch and now_epoch < runtime.reclaim_end_epoch and runtime.user_anchor_percent is not None:
        phase = FanControlState.RECLAIM
        reclaim_window = max(1, runtime.reclaim_end_epoch - runtime.hold_until_epoch)
        reclaim_progress = clamp_ratio(
            (now_epoch - runtime.hold_until_epoch) / reclaim_window
        )
        reason_codes.append("reclaim")
        blended_target = effective_target
        applied = move_toward_adaptive(
            runtime.applied_percent,
            blended_target,
            config.auto_step_up,
            config.auto_step_down,
            config.auto_step_up_max,
            config.auto_step_down_max,
        )
        explanation = "The controller is gradually reclaiming from the user's anchor using room-temperature deltas."
    else:
        phase = FanControlState.ASSIST if within_vacancy_grace else FanControlState.VACANT
        if delta_target is not None:
            reason_codes.append("manual_delta")
            blended_target = delta_target
            explanation = "The controller is adjusting from the user's chosen fan speed using room temperature deltas."
        else:
            reason_codes.append("assist" if within_vacancy_grace else "vacant")
            blended_target = effective_target
            explanation = "The controller is following the room's smoothed comfort conditions."
        if runtime.applied_percent == 0 and blended_target > 0:
            applied = startup_percent(
                blended_target=blended_target,
                within_vacancy_grace=within_vacancy_grace,
                config=config,
            )
            reason_codes.append("smart_start")
        else:
            applied = move_toward_adaptive(
                runtime.applied_percent,
                blended_target,
                config.auto_step_up,
                config.auto_step_down,
                config.auto_step_up_max,
                config.auto_step_down_max,
            )

    device_level, changed_epoch = map_percent_to_level(
        applied,
        runtime.device_level,
        runtime.last_device_change_epoch,
        now_epoch,
        config.device_mapping,
    )
    next_user_anchor_percent = runtime.user_anchor_percent if manual_delta_active or hold_remaining > 0 or phase == FanControlState.RECLAIM else None
    next_user_anchor_temp = runtime.user_anchor_temp if next_user_anchor_percent is not None else smoothed_temp
    next_resume_percent = runtime.resume_percent
    if applied > 0:
        next_resume_percent = applied
    next_runtime = FanPolicyRuntime(
        smoothed_temp=smoothed_temp,
        smoothed_humidity=smoothed_humidity,
        last_occupied_epoch=last_occupied_epoch,
        hold_until_epoch=runtime.hold_until_epoch,
        reclaim_end_epoch=runtime.reclaim_end_epoch,
        last_manual_intent_epoch=runtime.last_manual_intent_epoch,
        user_anchor_temp=next_user_anchor_temp,
        user_anchor_percent=next_user_anchor_percent,
        resume_percent=next_resume_percent,
        last_user_preference_percent=runtime.last_user_preference_percent,
        applied_percent=applied,
        auto_target_percent=auto_target,
        blended_target_percent=blended_target,
        device_level=device_level,
        last_device_change_epoch=changed_epoch,
        phase=phase,
        last_reason=explanation,
    )
    return build_result(
        next_runtime,
        hold_remaining_sec=hold_remaining,
        reclaim_progress=reclaim_progress,
        reason_codes=reason_codes,
    )


def estimate_confidence(*, occupancy_count: int, raw_temp: float, raw_humidity: float) -> float:
    """Estimate how strongly sensors justify automatic reclaim.

    Confidence stays lower near comfort conditions, which makes the controller
    hold onto user-oriented settings longer. It rises gradually as thermal or
    humidity load increases.
    """

    temp_pressure = min(0.28, max(0.0, raw_temp - 25.0) * 0.035)
    humidity_pressure = min(0.18, max(0.0, raw_humidity - 55.0) * 0.006)
    occupancy_pressure = 0.16 if occupancy_count > 0 else 0.08
    confidence = 0.34 + temp_pressure + humidity_pressure + occupancy_pressure
    return clamp_ratio(confidence)


def release_hold_for_sensor_intent(
    runtime: FanPolicyRuntime,
    *,
    now_epoch: int,
    config: FanPolicyConfig,
) -> FanPolicyRuntime:
    """Release stale manual hold when room-local climate input changes."""

    if runtime.user_anchor_percent is None or runtime.hold_until_epoch <= now_epoch:
        return runtime
    if runtime.last_manual_intent_epoch and (
        now_epoch - runtime.last_manual_intent_epoch < config.sensor_override_manual_grace_sec
    ):
        return runtime
    reclaim_bias_seconds = int(config.sensor_reclaim_duration_sec * config.sensor_reclaim_progress_bias)
    reclaim_bias_seconds = max(1, min(config.sensor_reclaim_duration_sec - 1, reclaim_bias_seconds))
    return FanPolicyRuntime(
        smoothed_temp=runtime.smoothed_temp,
        smoothed_humidity=runtime.smoothed_humidity,
        last_occupied_epoch=runtime.last_occupied_epoch,
        hold_until_epoch=now_epoch - reclaim_bias_seconds,
        reclaim_end_epoch=now_epoch + (config.sensor_reclaim_duration_sec - reclaim_bias_seconds),
        last_manual_intent_epoch=runtime.last_manual_intent_epoch,
        user_anchor_temp=runtime.user_anchor_temp,
        user_anchor_percent=runtime.user_anchor_percent,
        resume_percent=runtime.resume_percent,
        last_user_preference_percent=runtime.last_user_preference_percent,
        applied_percent=runtime.applied_percent,
        auto_target_percent=runtime.auto_target_percent,
        blended_target_percent=runtime.blended_target_percent,
        device_level=runtime.device_level,
        last_device_change_epoch=runtime.last_device_change_epoch,
        phase=FanControlState.RECLAIM,
        last_reason="Room climate changed. Releasing stale hold and resuming smooth optimization.",
    )


def describe_runtime(runtime: FanPolicyRuntime, now_epoch: int) -> dict:
    """Expose a stable snapshot for UI and evaluator-facing observability."""

    hold_remaining = max(0, runtime.hold_until_epoch - now_epoch)
    reclaim_progress = 0.0
    reclaim_span = max(0, runtime.reclaim_end_epoch - runtime.hold_until_epoch)
    if reclaim_span and now_epoch > runtime.hold_until_epoch:
        reclaim_progress = clamp_ratio((now_epoch - runtime.hold_until_epoch) / reclaim_span)
    return {
        "state": runtime.phase.value,
        "auto_target_percent": runtime.auto_target_percent,
        "blended_target_percent": runtime.blended_target_percent,
        "applied_percent": runtime.applied_percent,
        "device_level": runtime.device_level,
        "hold_remaining_sec": hold_remaining,
        "reclaim_progress": reclaim_progress,
        "explanation": runtime.last_reason,
    }


def reset_runtime_for_auto_sync(
    runtime: FanPolicyRuntime,
    *,
    raw_temp: float,
    raw_humidity: float,
) -> FanPolicyRuntime:
    """Clear manual fan history so a fresh page load reflects current room temperature."""

    return FanPolicyRuntime(
        smoothed_temp=raw_temp,
        smoothed_humidity=raw_humidity,
        last_occupied_epoch=runtime.last_occupied_epoch,
        hold_until_epoch=0,
        reclaim_end_epoch=0,
        last_manual_intent_epoch=0,
        user_anchor_temp=raw_temp,
        user_anchor_percent=None,
        resume_percent=runtime.resume_percent,
        last_user_preference_percent=runtime.last_user_preference_percent,
        applied_percent=0,
        auto_target_percent=0,
        blended_target_percent=0,
        device_level="OFF",
        last_device_change_epoch=0,
        phase=FanControlState.VACANT,
        last_reason="Page refresh requested a fresh temperature-based sync.",
    )


def occupied_target(
    *,
    occupancy_count: int,
    smoothed_temp: float,
    smoothed_humidity: float,
    config: FanPolicyConfig,
) -> int:
    base_target = occupied_temp_setpoint_target(smoothed_temp, config)
    humidity_excess = max(0.0, smoothed_humidity - config.comfort_humidity)
    people_excess = max(0, occupancy_count - 1)
    target = base_target + (config.humidity_gain * humidity_excess) + (config.occupancy_gain * people_excess)
    return clamp_percent(round(target), minimum=config.min_occupied_speed)


def occupied_temp_setpoint_target(smoothed_temp: float, config: FanPolicyConfig) -> int:
    """Map occupied-room temperature into evaluator-friendly fan zones."""

    if smoothed_temp >= 39.0:
        return 95
    if smoothed_temp >= 37.0:
        return 90
    if smoothed_temp >= 35.0:
        return 82
    if smoothed_temp >= 33.0:
        return 72
    if smoothed_temp >= 31.0:
        return 60
    if smoothed_temp >= 29.0:
        return 48
    if smoothed_temp >= 27.0:
        return 38
    if smoothed_temp >= 24.0:
        return 30
    return config.min_occupied_speed


def vacant_target(
    *,
    smoothed_temp: float,
    smoothed_humidity: float,
    config: FanPolicyConfig,
) -> int:
    if smoothed_temp >= 39.0:
        base_target = 90
    elif smoothed_temp >= 37.0:
        base_target = 84
    elif smoothed_temp >= 35.0:
        base_target = 76
    elif smoothed_temp >= 33.0:
        base_target = 62
    elif smoothed_temp >= 31.0:
        base_target = 48
    elif smoothed_temp >= 29.0:
        base_target = 34
    elif smoothed_temp >= 27.0:
        base_target = 22
    elif smoothed_temp >= 18.0:
        base_target = config.device_mapping.off_to_low_enter
    else:
        base_target = 0
    humidity_bonus = config.empty_humidity_gain * max(0.0, smoothed_humidity - config.empty_humidity_start)
    return clamp_percent(round(base_target + humidity_bonus), maximum=config.empty_max_speed)


def manual_delta_target(
    runtime: FanPolicyRuntime,
    smoothed_temp: float,
    within_vacancy_grace: bool,
    config: FanPolicyConfig,
) -> Optional[int]:
    if runtime.user_anchor_percent is None or not within_vacancy_grace:
        return None
    target = runtime.user_anchor_percent + config.manual_temp_delta_gain * (
        smoothed_temp - runtime.user_anchor_temp
    )
    return clamp_percent(round(target))


def has_active_manual_anchor(
    runtime: FanPolicyRuntime,
    now_epoch: int,
    config: FanPolicyConfig,
) -> bool:
    if runtime.user_anchor_percent is None:
        return False
    return now_epoch < max(runtime.reclaim_end_epoch, runtime.last_manual_intent_epoch + config.manual_anchor_expiry_sec)


def startup_percent(*, blended_target: int, within_vacancy_grace: bool, config: FanPolicyConfig) -> int:
    """Choose an immediate startup speed that matches current room demand."""

    if within_vacancy_grace:
        return clamp_percent(blended_target, minimum=config.min_occupied_speed)
    return clamp_percent(
        blended_target,
        minimum=min(config.device_mapping.off_to_low_enter, config.empty_max_speed),
        maximum=config.empty_max_speed,
    )


def move_toward(current: int, target: int, max_step_up: int, max_step_down: int) -> int:
    current = clamp_percent(current)
    target = clamp_percent(target)
    if target > current:
        return min(current + max_step_up, target)
    if target < current:
        return max(current - max_step_down, target)
    return current


def move_toward_adaptive(
    current: int,
    target: int,
    min_step_up: int,
    min_step_down: int,
    max_step_up: int,
    max_step_down: int,
) -> int:
    current = clamp_percent(current)
    target = clamp_percent(target)
    delta = abs(target - current)
    if target > current:
        if delta <= 3:
            adaptive_step = 1
        elif delta <= 8:
            adaptive_step = 2
        else:
            adaptive_step = max(min_step_up, round(delta * 0.22))
        return min(current + min(max_step_up, adaptive_step), target)
    if target < current:
        if delta <= 4:
            adaptive_step = 1
        elif delta <= 10:
            adaptive_step = 2
        else:
            adaptive_step = max(2, min_step_down // 2, round(delta * 0.18))
        return max(current - min(max_step_down, adaptive_step), target)
    return current


def ema_directional(previous: float, current: float, *, alpha_rise: float, alpha_fall: float) -> float:
    alpha = alpha_rise if current >= previous else alpha_fall
    return (alpha * current) + ((1 - alpha) * previous)


def clamp_percent(value: int, minimum: int = 0, maximum: int = 100) -> int:
    return max(minimum, min(maximum, int(round(value))))


def clamp_ratio(value: float) -> float:
    return max(0.0, min(1.0, value))


def is_uninitialized_runtime(runtime: FanPolicyRuntime) -> bool:
    return (
        runtime.last_occupied_epoch == 0
        and runtime.hold_until_epoch == 0
        and runtime.reclaim_end_epoch == 0
        and runtime.last_manual_intent_epoch == 0
        and runtime.user_anchor_temp == 29.0
        and runtime.user_anchor_percent is None
        and runtime.resume_percent == 0
        and runtime.last_user_preference_percent is None
        and runtime.applied_percent == 0
        and runtime.auto_target_percent == 0
        and runtime.blended_target_percent == 0
        and runtime.device_level == "OFF"
        and runtime.last_device_change_epoch == 0
        and runtime.phase == FanControlState.VACANT
    )


def build_result(
    runtime: FanPolicyRuntime,
    *,
    hold_remaining_sec: int,
    reclaim_progress: float,
    reason_codes: list[str],
) -> FanPolicyResult:
    return FanPolicyResult(
        state=runtime.phase,
        auto_target_percent=runtime.auto_target_percent,
        blended_target_percent=runtime.blended_target_percent,
        applied_percent=runtime.applied_percent,
        device_level=runtime.device_level,
        hold_remaining_sec=hold_remaining_sec,
        reclaim_progress=round(reclaim_progress, 3),
        reason_codes=reason_codes,
        explanation=runtime.last_reason,
        runtime=runtime,
    )
