from dataclasses import dataclass


@dataclass(frozen=True)
class DeviceMappingConfig:
    off_to_low_enter: int = 18
    low_to_off_exit: int = 10
    low_to_medium_enter: int = 40
    medium_to_low_exit: int = 30
    medium_to_high_enter: int = 72
    high_to_medium_exit: int = 62
    minimum_dwell_sec: int = 6


def clamp_percent(percent: int) -> int:
    return max(0, min(100, int(percent)))


def map_percent_to_level(
    percent: int,
    previous_level: str,
    last_change_epoch: int,
    now_epoch: int,
    config: DeviceMappingConfig,
    *,
    enforce_dwell: bool = True,
) -> tuple[str, int]:
    """Map a continuous percent into hardware-friendly speed bands.

    Hysteresis prevents band flapping around boundaries. Dwell time is enforced
    only for automatic transitions; manual intent can bypass it.
    """

    percent = clamp_percent(percent)
    previous_level = previous_level or "OFF"

    if enforce_dwell and last_change_epoch and now_epoch - last_change_epoch < config.minimum_dwell_sec:
        return previous_level, last_change_epoch

    next_level = previous_level
    if previous_level == "OFF":
        if percent >= config.medium_to_high_enter:
            next_level = "HIGH"
        elif percent >= config.low_to_medium_enter:
            next_level = "MEDIUM"
        elif percent >= config.off_to_low_enter:
            next_level = "LOW"
        else:
            next_level = "OFF"
    elif previous_level == "LOW":
        if percent < config.low_to_off_exit:
            next_level = "OFF"
        elif percent >= config.low_to_medium_enter:
            next_level = "MEDIUM"
        else:
            next_level = "LOW"
    elif previous_level == "MEDIUM":
        if percent < config.medium_to_low_exit:
            next_level = "LOW"
        elif percent >= config.medium_to_high_enter:
            next_level = "HIGH"
        else:
            next_level = "MEDIUM"
    elif previous_level == "HIGH":
        next_level = "MEDIUM" if percent < config.high_to_medium_exit else "HIGH"

    changed_at = now_epoch if next_level != previous_level else last_change_epoch
    return next_level, changed_at
