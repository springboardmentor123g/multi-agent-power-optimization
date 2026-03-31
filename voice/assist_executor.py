from home_layout import ROOMS


def build_assist_execution_plan(command, room_id):
    room_name = ROOMS[room_id]["name"]
    if command.get("message_type") != "command":
        return {"kind": "noop", "message": "Assistant did not return a command."}
    if command.get("target_room") != room_name:
        return {"kind": "noop", "message": "Assistant returned a mismatched room target."}
    command_type = command.get("command_type")
    changes = command.get("changes", {}) or {}
    if command_type == "noop" or not changes:
        return {"kind": "noop", "message": command.get("acknowledgement", "No changes made.")}
    plan = {"kind": "batch", "operations": []}
    if changes.get("room_mode"):
        plan["operations"].append({"type": "room_mode", "room_id": room_id, "mode": changes["room_mode"]})
    if changes.get("fan_percent") is not None:
        plan["operations"].append({"type": "device", "appliance": f"{room_id}_fan", "level": int(changes["fan_percent"])})
    if changes.get("light_percent") is not None:
        plan["operations"].append({"type": "device", "appliance": f"{room_id}_light", "level": int(changes["light_percent"])})
    if not plan["operations"]:
        return {"kind": "noop", "message": command.get("acknowledgement", "No changes made.")}
    return plan
