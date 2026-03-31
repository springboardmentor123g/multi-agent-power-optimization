from home_layout import ROOMS
from control.light_policy import recommended_brightness


def build_execution_plan(command, room_snapshot):
    """Translate a parsed voice command into an internal room-local execution plan."""

    intent = command["intent"]
    room_id = command["room_id"]
    if room_id not in ROOMS:
        raise ValueError(f"Unknown room: {room_id}")
    if intent in {"clarify", "reject"}:
        return {"kind": "noop", "message": command["reason"]}
    if intent == "set_mode_auto":
        return {"kind": "room_mode", "room_id": room_id, "mode": "LOCAL_AUTO"}
    if intent == "set_mode_manual":
        return {"kind": "room_mode", "room_id": room_id, "mode": "LOCAL_MANUAL"}
    if intent == "turn_fan_on":
        current_speed = int(room_snapshot["devices"]["fan"]["speed_percent"])
        target_speed = max(
            current_speed,
            int(room_snapshot["devices"]["fan"].get("policy", {}).get("auto_target_percent", 0)),
            25,
        )
        return {
            "kind": "device",
            "appliance": f"{room_id}_fan",
            "level": target_speed,
            "resume": True,
        }
    if intent == "turn_fan_off":
        return {"kind": "device", "appliance": f"{room_id}_fan", "level": 0, "resume": False}
    if intent == "set_fan_speed":
        return {"kind": "device", "appliance": f"{room_id}_fan", "level": int(command["value_percent"]), "resume": False}
    if intent == "increase_fan_speed":
        next_level = min(100, int(room_snapshot["devices"]["fan"]["speed_percent"]) + int(command["value_percent"] or 10))
        return {"kind": "device", "appliance": f"{room_id}_fan", "level": next_level, "resume": False}
    if intent == "decrease_fan_speed":
        next_level = max(0, int(room_snapshot["devices"]["fan"]["speed_percent"]) - int(command["value_percent"] or 10))
        return {"kind": "device", "appliance": f"{room_id}_fan", "level": next_level, "resume": False}
    if intent == "turn_light_on":
        recommended_level = recommended_brightness(
            int(room_snapshot["sensors"]["occupancy_count"]),
            float(room_snapshot["sensors"]["ambient_light"]),
        )
        next_level = max(
            int(room_snapshot["devices"]["light"]["brightness"]),
            recommended_level,
            35,
        )
        return {"kind": "device", "appliance": f"{room_id}_light", "level": next_level, "resume": False}
    if intent == "turn_light_off":
        return {"kind": "device", "appliance": f"{room_id}_light", "level": 0, "resume": False}
    if intent == "set_light_brightness":
        return {"kind": "device", "appliance": f"{room_id}_light", "level": int(command["value_percent"]), "resume": False}
    return {"kind": "noop", "message": "Command is unsupported."}
