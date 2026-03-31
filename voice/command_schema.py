from home_layout import ROOMS


ALLOWED_INTENTS = [
    "set_fan_speed",
    "increase_fan_speed",
    "decrease_fan_speed",
    "turn_fan_on",
    "turn_fan_off",
    "set_light_brightness",
    "turn_light_on",
    "turn_light_off",
    "set_mode_auto",
    "set_mode_manual",
    "clarify",
    "reject",
]

ALLOWED_DEVICES = ["fan", "light"]
ALLOWED_ROOMS = list(ROOMS)

VOICE_COMMAND_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["intent", "room_id", "device", "value_percent", "raw_text", "reason"],
    "properties": {
        "intent": {"type": "string", "enum": ALLOWED_INTENTS},
        "room_id": {"type": "string", "enum": ALLOWED_ROOMS},
        "device": {"type": ["string", "null"], "enum": ALLOWED_DEVICES + [None]},
        "value_percent": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
        "raw_text": {"type": "string"},
        "reason": {"type": "string", "maxLength": 160},
    },
}

SYSTEM_PROMPT = """You are a voice-command parser for a multi-room smart home control system.

Your job is to convert a user's spoken request into a STRICT JSON command.
Do not explain. Do not chat. Output JSON only.

Rules:
1. Each command applies to exactly one room.
2. Never affect other rooms.
3. Only use allowed intents, devices, and fields.
4. If the request is ambiguous, unsupported, or missing a target, return intent="clarify".
5. If the user explicitly gives a command, prefer MANUAL mode_change.
6. Do not invent devices that do not exist in the provided allowed_devices list.
7. Keep numeric values within allowed ranges.
8. Preserve the user's words in raw_text.
9. reason must be short and factual.

The system passes an active_room_id from the clicked room microphone.
Use that room as the only valid target room for execution.
If the user asks to control a different room, multiple rooms, or the whole house, return intent="reject".
For clarify/reject, still return the active_room_id in room_id.
For turn_on/turn_off or mode intents, device may be null only when the intent is a mode or clarify/reject.
For increase/decrease intents, value_percent should be the delta if the user gives one, otherwise use 10.
For set_fan_speed and set_light_brightness, value_percent is the requested absolute percent.
"""

