from home_layout import ROOMS


VOICE_ASSIST_START_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["message_type", "summary", "spoken_text", "suggested_intent"],
    "properties": {
        "message_type": {"type": "string", "enum": ["question"]},
        "summary": {"type": "string", "maxLength": 160},
        "spoken_text": {"type": "string", "maxLength": 260},
        "suggested_intent": {"type": "string", "maxLength": 80},
    },
}


VOICE_ASSIST_REPLY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["message_type", "command_type", "target_room", "changes", "acknowledgement"],
    "properties": {
        "message_type": {"type": "string", "enum": ["command"]},
        "command_type": {"type": "string", "enum": ["device_adjustment", "room_mode_change", "noop"]},
        "target_room": {"type": "string", "enum": [ROOMS[room_id]["name"] for room_id in ROOMS]},
        "changes": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "fan_percent": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
                "light_percent": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
                "room_mode": {"type": ["string", "null"], "enum": ["FOLLOW_GLOBAL", "LOCAL_AUTO", "LOCAL_MANUAL", None]},
            },
            "required": [],
        },
        "acknowledgement": {"type": "string", "maxLength": 220},
    },
}


VOICE_ASSIST_START_PROMPT = """You are the first step of a bounded 2-turn smart-home voice assistant.

You will receive current readings for exactly one room.

Return STRICT JSON only.

Rules:
- Always return message_type=\"question\"
- spoken_text must contain:
  1. a brief natural summary of the room condition
  2. exactly one follow-up question
- Do not ask multiple questions
- Do not output commands yet
- Sound like a natural home assistant, not a sensor report
- Do not just repeat raw readings mechanically
- Prefer warm, conversational phrasing like \"The room feels a bit warm and dim right now\"
- Keep it short, natural, and helpful
- suggested_intent should be a short label like comfort_adjustment, energy_saving, or brightness_adjustment
"""


VOICE_ASSIST_REPLY_PROMPT = """You are the second and final step of a bounded 2-turn smart-home voice assistant.

You will receive:
- current room readings
- previous assistant spoken_text
- one user reply

Return STRICT JSON only.

Rules:
- Always return message_type=\"command\"
- Never ask another question
- Never start a longer conversation
- If the user reply is unclear, return:
  command_type=\"noop\"
  acknowledgement that says no changes were made and the user should use the mic button to say exactly what they want
- target_room must match the provided active room
- changes should only include fan_percent, light_percent, or room_mode when needed
- acknowledgement must be natural language confirming what happened
"""
