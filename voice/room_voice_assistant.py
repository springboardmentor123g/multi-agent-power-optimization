import json
import os
from urllib import request

from home_layout import ROOMS
from voice.assist_schema import (
    VOICE_ASSIST_REPLY_PROMPT,
    VOICE_ASSIST_REPLY_SCHEMA,
    VOICE_ASSIST_START_PROMPT,
    VOICE_ASSIST_START_SCHEMA,
)
from voice.command_parser import extract_output_text, load_local_settings


class RoomVoiceAssistant:
    def __init__(self, api_key=None, model=None):
        local_settings = load_local_settings()
        self.api_key = (
            api_key
            if api_key is not None
            else os.environ.get("OPENAI_API_KEY", "").strip() or local_settings.get("openai_api_key", "").strip()
        )
        self.model = (
            model
            if model is not None
            else os.environ.get("OPENAI_VOICE_MODEL", "").strip() or local_settings.get("openai_voice_model", "gpt-5-nano").strip()
        )

    def start_with_debug(self, room_id, room_snapshot):
        if not self.api_key:
            response = fallback_start(room_snapshot)
            return response, {"source": "fallback", "model": self.model, "llm_output": None, "error": "OPENAI_API_KEY is not configured."}
        try:
            response, llm_output = self._call_openai(
                VOICE_ASSIST_START_PROMPT,
                VOICE_ASSIST_START_SCHEMA,
                {
                    "room": room_snapshot["name"],
                    "readings": build_room_context_text(room_snapshot),
                },
                "room_voice_assist_question",
            )
            return response, {"source": "openai", "model": self.model, "llm_output": llm_output, "error": None}
        except Exception as exc:
            response = fallback_start(room_snapshot)
            return response, {"source": "fallback_after_error", "model": self.model, "llm_output": None, "error": str(exc)}

    def reply_with_debug(self, room_id, room_snapshot, previous_spoken_text, user_reply):
        if not self.api_key:
            response = fallback_reply(room_snapshot, user_reply)
            return response, {"source": "fallback", "model": self.model, "llm_output": None, "error": "OPENAI_API_KEY is not configured."}
        try:
            response, llm_output = self._call_openai(
                VOICE_ASSIST_REPLY_PROMPT,
                VOICE_ASSIST_REPLY_SCHEMA,
                {
                    "room": room_snapshot["name"],
                    "readings": build_room_context_text(room_snapshot),
                    "previous_assistant_spoken_text": previous_spoken_text,
                    "user_reply": user_reply,
                    "allowed_changes": "fan_percent 0-100, light_percent 0-100, room_mode FOLLOW_GLOBAL|LOCAL_AUTO|LOCAL_MANUAL|null",
                },
                "room_voice_assist_command",
            )
            return response, {"source": "openai", "model": self.model, "llm_output": llm_output, "error": None}
        except Exception as exc:
            response = fallback_reply(room_snapshot, user_reply)
            return response, {"source": "fallback_after_error", "model": self.model, "llm_output": None, "error": str(exc)}

    def _call_openai(self, system_prompt, schema, payload, schema_name):
        body = {
            "model": self.model,
            "max_output_tokens": 220,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": json.dumps(payload)}]},
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "strict": True,
                    "schema": schema,
                }
            },
        }
        response = request.urlopen(
            request.Request(
                "https://api.openai.com/v1/responses",
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            ),
            timeout=6,
        )
        response_body = json.loads(response.read().decode("utf-8"))
        output_text = extract_output_text(response_body)
        return json.loads(output_text), output_text


def build_room_context(room_snapshot):
    return {
        "temperature": room_snapshot["sensors"]["temperature"],
        "ambient_light": room_snapshot["sensors"]["ambient_light"],
        "fan_state": room_snapshot["devices"]["fan"]["state"],
        "fan_percent": room_snapshot["devices"]["fan"]["speed_percent"],
        "light_state": room_snapshot["devices"]["light"]["state"],
        "light_percent": room_snapshot["devices"]["light"]["brightness"],
        "occupancy_count": room_snapshot["sensors"]["occupancy_count"],
        "room_mode": room_snapshot["resolved_mode"],
    }


def build_room_context_text(room_snapshot):
    context = build_room_context(room_snapshot)
    return (
        f"temp={context['temperature']}C, ambient={context['ambient_light']}%, "
        f"fan={context['fan_state']} {context['fan_percent']}%, "
        f"light={context['light_state']} {context['light_percent']}%, "
        f"occupancy={context['occupancy_count']}, mode={context['room_mode']}"
    )


def fallback_start(room_snapshot):
    temperature = float(room_snapshot["sensors"]["temperature"])
    ambient = float(room_snapshot["sensors"]["ambient_light"])
    occupancy = int(room_snapshot["sensors"]["occupancy_count"])
    fan_percent = int(room_snapshot["devices"]["fan"]["speed_percent"])
    light_percent = int(room_snapshot["devices"]["light"]["brightness"])
    temp_label = "warm" if temperature >= 30 else "comfortable" if temperature >= 24 else "cool"
    light_label = "dim" if ambient <= 35 else "bright" if ambient >= 70 else "balanced"
    occupancy_label = "occupied" if occupancy > 0 else "quiet"
    summary = f"The room feels {temp_label} with {light_label} lighting and is currently {occupancy_label}."
    if temperature >= 30 and ambient <= 40:
        spoken = (
            "The room feels a bit warm and dim right now. "
            "Would you like me to nudge the fan up and brighten the lights a little?"
        )
        suggested = "comfort_adjustment"
    elif ambient <= 35:
        spoken = (
            f"The room looks slightly dim with the lights around {light_percent} percent. "
            "Would you like me to brighten it a little?"
        )
        suggested = "brightness_adjustment"
    elif temperature >= 28:
        spoken = (
            f"The room is leaning warm and the fan is at {fan_percent} percent. "
            "Would you like me to make it a bit cooler?"
        )
        suggested = "comfort_adjustment"
    else:
        spoken = (
            "The room feels fairly steady at the moment. "
            "Would you like me to fine tune the fan or lights for comfort?"
        )
        suggested = "room_check"
    return {
        "message_type": "question",
        "summary": summary,
        "spoken_text": spoken,
        "suggested_intent": suggested,
    }


def fallback_reply(room_snapshot, user_reply):
    room_name = room_snapshot["name"]
    text = str(user_reply or "").strip().lower()
    unclear = {
        "message_type": "command",
        "command_type": "noop",
        "target_room": room_name,
        "changes": {},
        "acknowledgement": "I didn’t make any changes. Please use the mic button to tell me exactly what you want.",
    }
    if not text:
        return unclear

    fan = int(room_snapshot["devices"]["fan"]["speed_percent"])
    light = int(room_snapshot["devices"]["light"]["brightness"])
    changes = {}
    acknowledged = []

    if any(token in text for token in ["yes", "do it", "go ahead", "sure", "okay", "ok"]):
        if float(room_snapshot["sensors"]["temperature"]) >= 30:
            changes["fan_percent"] = min(100, max(fan, 70))
            acknowledged.append("increased the fan speed")
        if float(room_snapshot["sensors"]["ambient_light"]) <= 40 or int(room_snapshot["sensors"]["occupancy_count"]) > 0:
            changes["light_percent"] = min(100, max(light, 60))
            acknowledged.append("brightened the lights")
    if "fan" in text:
        if "off" in text:
            changes["fan_percent"] = 0
            acknowledged.append("turned the fan off")
        elif "high" in text or "faster" in text or "increase" in text:
            changes["fan_percent"] = min(100, max(fan + 15, 70))
            acknowledged.append("increased the fan speed")
        elif "low" in text or "slower" in text or "decrease" in text:
            changes["fan_percent"] = max(0, fan - 15)
            acknowledged.append("reduced the fan speed")
    if "light" in text:
        if "off" in text:
            changes["light_percent"] = 0
            acknowledged.append("turned the lights off")
        elif "bright" in text or "brighter" in text or "increase" in text:
            changes["light_percent"] = min(100, max(light + 15, 55))
            acknowledged.append("brightened the lights")
        elif "dim" in text or "dimmer" in text or "reduce" in text:
            changes["light_percent"] = max(0, light - 15)
            acknowledged.append("dimmed the lights")

    if not changes:
        return unclear
    acknowledgement = "Done. I’ve " + " and ".join(dict.fromkeys(acknowledged)) + "."
    return {
        "message_type": "command",
        "command_type": "device_adjustment",
        "target_room": room_name,
        "changes": changes,
        "acknowledgement": acknowledgement,
    }
