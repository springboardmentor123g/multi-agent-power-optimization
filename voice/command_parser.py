import json
import os
import re
from urllib import error, request

from voice.command_schema import (
    ALLOWED_DEVICES,
    ALLOWED_ROOMS,
    SYSTEM_PROMPT,
    VOICE_COMMAND_SCHEMA,
)


class VoiceCommandParser:
    """Parse room-local voice text into a strict command JSON payload."""

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

    def parse(self, raw_text, active_room_id):
        command, _ = self.parse_with_debug(raw_text, active_room_id)
        return command

    def parse_with_debug(self, raw_text, active_room_id):
        if active_room_id not in ALLOWED_ROOMS:
            raise ValueError(f"Unknown room: {active_room_id}")
        raw_text = str(raw_text or "").strip()
        if not raw_text:
            return clarify_command(active_room_id, raw_text, "Empty transcript."), {
                "parser_source": "fallback",
                "model": self.model,
                "llm_output": None,
                "error": "Empty transcript.",
            }
        if not self.api_key:
            return fallback_parse(raw_text, active_room_id), {
                "parser_source": "fallback",
                "model": self.model,
                "llm_output": None,
                "error": "OPENAI_API_KEY is not configured.",
            }
        try:
            command, llm_output = self._parse_with_openai(raw_text, active_room_id)
            return command, {
                "parser_source": "openai",
                "model": self.model,
                "llm_output": llm_output,
                "error": None,
            }
        except Exception as exc:
            return fallback_parse(raw_text, active_room_id), {
                "parser_source": "fallback_after_error",
                "model": self.model,
                "llm_output": None,
                "error": str(exc),
            }

    def _parse_with_openai(self, raw_text, active_room_id):
        payload = {
            "model": self.model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_PROMPT}]},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": json.dumps(
                                {
                                    "active_room_id": active_room_id,
                                    "allowed_rooms": ALLOWED_ROOMS,
                                    "allowed_devices": ALLOWED_DEVICES,
                                    "raw_text": raw_text,
                                }
                            ),
                        }
                    ],
                },
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "room_voice_command",
                    "strict": True,
                    "schema": VOICE_COMMAND_SCHEMA,
                }
            },
        }
        response = request.urlopen(
            request.Request(
                "https://api.openai.com/v1/responses",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            ),
            timeout=20,
        )
        body = json.loads(response.read().decode("utf-8"))
        command_text = extract_output_text(body)
        command = json.loads(command_text)
        return normalize_command(command, raw_text, active_room_id), command_text


def extract_output_text(body):
    if body.get("output_text"):
        return body["output_text"]
    for item in body.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and content.get("text"):
                return content["text"]
    raise error.HTTPError("", 502, "No structured output returned.", None, None)


def load_local_settings():
    settings_path = os.environ.get("POWER_OPT_LOCAL_SETTINGS_PATH") or os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "local_settings.json",
    )
    if not os.path.exists(settings_path):
        return {}
    with open(settings_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def fallback_parse(raw_text, active_room_id):
    text = raw_text.lower().strip()
    if mentions_other_room(text, active_room_id):
        return reject_command(active_room_id, raw_text, "Command targets another room.")
    if any(token in text for token in ["all rooms", "whole house", "every room", "everything"]):
        return reject_command(active_room_id, raw_text, "Multi-room control is not allowed.")

    if "manual mode" in text or "set manual" in text or "manual" == text:
        return build_command("set_mode_manual", active_room_id, None, None, raw_text, "Explicit manual request.")
    if "auto mode" in text or "set auto" in text or text == "auto":
        return build_command("set_mode_auto", active_room_id, None, None, raw_text, "Explicit auto request.")

    device = detect_device(text)
    if not device:
        return clarify_command(active_room_id, raw_text, "Device is not clear.")

    value = extract_percent(text)
    if "turn" in text and "off" in text:
        return build_command(f"turn_{device}_off", active_room_id, device, 0, raw_text, "Explicit off request.")
    if "turn" in text and "on" in text:
        return build_command(f"turn_{device}_on", active_room_id, device, None, raw_text, "Explicit on request.")
    if "increase" in text or "raise" in text or "up" in text:
        return build_command(
            f"increase_{device}_speed" if device == "fan" else "clarify",
            active_room_id,
            device if device == "fan" else None,
            clamp_percent(value if value is not None else 10),
            raw_text,
            "Increase request." if device == "fan" else "Light increase is unsupported.",
        )
    if "decrease" in text or "lower" in text or "down" in text:
        return build_command(
            f"decrease_{device}_speed" if device == "fan" else "clarify",
            active_room_id,
            device if device == "fan" else None,
            clamp_percent(value if value is not None else 10),
            raw_text,
            "Decrease request." if device == "fan" else "Light decrease is unsupported.",
        )
    if device == "fan" and ("set" in text or "speed" in text):
        if value is None:
            return clarify_command(active_room_id, raw_text, "Fan speed value is missing.")
        return build_command("set_fan_speed", active_room_id, "fan", clamp_percent(value), raw_text, "Absolute fan speed request.")
    if device == "light" and ("set" in text or "brightness" in text or "dim" in text):
        if value is None and "dim" in text:
            value = 35
        if value is None:
            return clarify_command(active_room_id, raw_text, "Brightness value is missing.")
        return build_command("set_light_brightness", active_room_id, "light", clamp_percent(value), raw_text, "Absolute light brightness request.")
    return clarify_command(active_room_id, raw_text, "Command is ambiguous.")


def mentions_other_room(text, active_room_id):
    for room_id in ALLOWED_ROOMS:
        room_name = room_id.replace("_", " ")
        if room_id != active_room_id and (room_id in text or room_name in text):
            return True
    return False


def detect_device(text):
    if "fan" in text:
        return "fan"
    if any(token in text for token in ["light", "lights", "lamp", "brightness"]):
        return "light"
    return None


def extract_percent(text):
    match = re.search(r"(\d{1,3})", text)
    if not match:
        return None
    return clamp_percent(int(match.group(1)))


def clamp_percent(value):
    return max(0, min(100, int(value)))


def build_command(intent, room_id, device, value_percent, raw_text, reason):
    return normalize_command(
        {
            "intent": intent,
            "room_id": room_id,
            "device": device,
            "value_percent": value_percent,
            "raw_text": raw_text,
            "reason": reason,
        },
        raw_text,
        room_id,
    )


def clarify_command(room_id, raw_text, reason):
    return build_command("clarify", room_id, None, None, raw_text, reason)


def reject_command(room_id, raw_text, reason):
    return build_command("reject", room_id, None, None, raw_text, reason)


def normalize_command(command, raw_text, active_room_id):
    normalized = {
        "intent": command.get("intent", "clarify"),
        "room_id": command.get("room_id", active_room_id),
        "device": command.get("device"),
        "value_percent": command.get("value_percent"),
        "raw_text": raw_text,
        "reason": str(command.get("reason", "No reason provided.")).strip()[:160],
    }
    if normalized["room_id"] not in ALLOWED_ROOMS:
        normalized["room_id"] = active_room_id
        normalized["intent"] = "clarify"
        normalized["device"] = None
        normalized["value_percent"] = None
        normalized["reason"] = "Room target is invalid."
    if normalized["value_percent"] is not None:
        normalized["value_percent"] = clamp_percent(normalized["value_percent"])
    return normalized
