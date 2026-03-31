from dataclasses import asdict, dataclass
from enum import Enum
from typing import Optional


class LightControlState(str, Enum):
    HOLD = "hold"
    ASSIST = "assist"


@dataclass(frozen=True)
class LightPolicyConfig:
    hold_duration_sec: int = 120
    min_occupied_brightness: int = 12


@dataclass(frozen=True)
class LightPolicyRuntime:
    hold_until_epoch: int = 0
    user_brightness: Optional[int] = None
    phase: LightControlState = LightControlState.ASSIST
    last_reason: str = "Initialized."


@dataclass(frozen=True)
class LightPolicyResult:
    state: LightControlState
    auto_target_brightness: int
    applied_brightness: int
    hold_remaining_sec: int
    explanation: str
    runtime: LightPolicyRuntime


def describe_runtime(runtime: LightPolicyRuntime, now_epoch: int) -> dict:
    return {
        "state": runtime.phase.value,
        "hold_remaining_sec": max(0, runtime.hold_until_epoch - now_epoch),
        "user_brightness": runtime.user_brightness,
        "reason": runtime.last_reason,
    }


def runtime_from_record(record: Optional[dict]) -> LightPolicyRuntime:
    if not record:
        return LightPolicyRuntime()
    return LightPolicyRuntime(
        hold_until_epoch=int(record.get("hold_until_epoch", 0) or 0),
        user_brightness=record.get("user_brightness"),
        phase=LightControlState(record.get("phase", "assist")),
        last_reason=record.get("last_reason", "Initialized."),
    )


def runtime_to_record(runtime: LightPolicyRuntime) -> dict:
    record = asdict(runtime)
    record["phase"] = runtime.phase.value
    return record


def apply_manual_light_intent(
    runtime: LightPolicyRuntime,
    *,
    requested_brightness: int,
    now_epoch: int,
    config: LightPolicyConfig,
) -> LightPolicyResult:
    requested_brightness = clamp_percent(requested_brightness)
    next_runtime = LightPolicyRuntime(
        hold_until_epoch=now_epoch + config.hold_duration_sec,
        user_brightness=requested_brightness,
        phase=LightControlState.HOLD,
        last_reason=f"User set light brightness to {requested_brightness}%. Holding that preference temporarily.",
    )
    return LightPolicyResult(
        state=next_runtime.phase,
        auto_target_brightness=requested_brightness,
        applied_brightness=requested_brightness,
        hold_remaining_sec=config.hold_duration_sec,
        explanation=next_runtime.last_reason,
        runtime=next_runtime,
    )


def evaluate_light_policy(
    runtime: LightPolicyRuntime,
    *,
    occupancy_count: int,
    ambient_light: float,
    now_epoch: int,
    config: LightPolicyConfig,
) -> LightPolicyResult:
    auto_target = recommended_brightness(
        occupancy_count,
        ambient_light,
        min_occupied_brightness=config.min_occupied_brightness,
    )
    hold_remaining = max(0, runtime.hold_until_epoch - now_epoch)
    if hold_remaining > 0 and runtime.user_brightness is not None:
        next_runtime = LightPolicyRuntime(
            hold_until_epoch=runtime.hold_until_epoch,
            user_brightness=runtime.user_brightness,
            phase=LightControlState.HOLD,
            last_reason="Recent user light input is being respected during the hold window.",
        )
        return LightPolicyResult(
            state=next_runtime.phase,
            auto_target_brightness=auto_target,
            applied_brightness=int(runtime.user_brightness),
            hold_remaining_sec=hold_remaining,
            explanation=next_runtime.last_reason,
            runtime=next_runtime,
        )
    next_runtime = LightPolicyRuntime(
        hold_until_epoch=0,
        user_brightness=None,
        phase=LightControlState.ASSIST,
        last_reason="Light brightness is following occupancy and ambient light conditions.",
    )
    return LightPolicyResult(
        state=next_runtime.phase,
        auto_target_brightness=auto_target,
        applied_brightness=auto_target,
        hold_remaining_sec=0,
        explanation=next_runtime.last_reason,
        runtime=next_runtime,
    )


def release_hold_for_sensor_intent(
    runtime: LightPolicyRuntime,
    *,
    now_epoch: int,
    config: LightPolicyConfig,
) -> LightPolicyRuntime:
    hold_remaining = max(0, runtime.hold_until_epoch - now_epoch)
    if hold_remaining <= 0 or runtime.user_brightness is None:
        return runtime
    recent_intent_window = max(10, min(30, config.hold_duration_sec // 4))
    if hold_remaining <= recent_intent_window:
        return runtime
    return LightPolicyRuntime(
        hold_until_epoch=0,
        user_brightness=None,
        phase=LightControlState.ASSIST,
        last_reason="Ambient conditions changed, so light assistance resumed for this room.",
    )


def recommended_brightness(occupancy_count: int, ambient_light: float, *, min_occupied_brightness: int = 12) -> int:
    if occupancy_count <= 0:
        return 0
    return interpolate_brightness(float(ambient_light), min_occupied_brightness=min_occupied_brightness)


def interpolate_brightness(ambient_light: float, *, min_occupied_brightness: int = 12) -> int:
    points = [
        (0.0, 85),
        (20.0, 65),
        (45.0, 35),
        (75.0, 18),
        (100.0, max(8, min_occupied_brightness)),
    ]
    if ambient_light <= points[0][0]:
        return points[0][1]
    if ambient_light >= points[-1][0]:
        return points[-1][1]
    for index in range(1, len(points)):
        left_x, left_y = points[index - 1]
        right_x, right_y = points[index]
        if ambient_light <= right_x:
            span = right_x - left_x
            progress = (ambient_light - left_x) / span
            value = left_y + (right_y - left_y) * progress
            return clamp_percent(round(value))
    return 0


def clamp_percent(value: int) -> int:
    return max(0, min(100, int(round(value))))
