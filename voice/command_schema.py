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

SYSTEM_PROMPT = """Convert one room-local smart-home voice command into STRICT JSON.

Return JSON only.
Use the provided active_room_id as the only valid target.
If the user targets another room, multiple rooms, or the whole house, return intent="reject".
If unclear, unsupported, or missing a usable target, return intent="clarify".
Keep reason short and factual.
Keep raw_text unchanged.

Absolute target:
- "set fan to 60"
- "lower the fan to 25 percent"
- "make the light 40 percent"

Relative delta:
- "increase fan by 10 percent"
- "reduce fan by 15"

For increase/decrease intents, value_percent is the delta, default 10.
For set_fan_speed and set_light_brightness, value_percent is the absolute target.
"""
