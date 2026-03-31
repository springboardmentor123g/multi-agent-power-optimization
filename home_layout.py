ROOMS = {
    "living_room": {
        "name": "Living Room",
        "light_color": "#ffd36b",
        "light_power_watts": 48.0,
        "fan_power_watts": 72.0,
        "fan_position": {"x": "54%", "y": "42%"},
        "leds": [
            {"x": "18%", "y": "20%"},
            {"x": "39%", "y": "16%"},
            {"x": "67%", "y": "18%"},
            {"x": "84%", "y": "25%"},
        ],
    },
    "bedroom": {
        "name": "Bedroom",
        "light_color": "#cbe8ff",
        "light_power_watts": 42.0,
        "fan_power_watts": 68.0,
        "fan_position": {"x": "62%", "y": "46%"},
        "leds": [
            {"x": "26%", "y": "18%"},
            {"x": "74%", "y": "24%"},
        ],
    },
    "kitchen": {
        "name": "Kitchen",
        "light_color": "#ffb36f",
        "light_power_watts": 38.0,
        "fan_power_watts": 62.0,
        "fan_position": {"x": "45%", "y": "50%"},
        "leds": [
            {"x": "18%", "y": "24%"},
            {"x": "50%", "y": "15%"},
            {"x": "78%", "y": "22%"},
        ],
    },
    "study": {
        "name": "Study",
        "light_color": "#a9c9ff",
        "light_power_watts": 36.0,
        "fan_power_watts": 58.0,
        "fan_position": {"x": "35%", "y": "44%"},
        "leds": [
            {"x": "72%", "y": "18%"},
            {"x": "30%", "y": "28%"},
        ],
    },
}

FAN_SPEED_MULTIPLIERS = {
    "OFF": 0.0,
    "LOW": 0.45,
    "MEDIUM": 0.72,
    "HIGH": 1.0,
}

DEFAULT_ROOM_SENSOR = {
    "temperature": 29.0,
    "ambient_light": 45.0,
    "occupancy_count": 0,
}

ROOM_MODE_OPTIONS = {"FOLLOW_GLOBAL", "LOCAL_AUTO", "LOCAL_MANUAL"}


def build_default_appliances():
    appliances = {}
    for room_id, room in ROOMS.items():
        appliances[f"{room_id}_light"] = {
            "room": room_id,
            "device_type": "light",
            "display_name": f"{room['name']} Light",
            "state": "OFF",
            "speed": "OFF",
            "level": 0,
            "power_watts": room["light_power_watts"],
        }
        appliances[f"{room_id}_fan"] = {
            "room": room_id,
            "device_type": "fan",
            "display_name": f"{room['name']} Fan",
            "state": "OFF",
            "speed": "OFF",
            "level": 0,
            "power_watts": room["fan_power_watts"],
        }
    return appliances


DEFAULT_APPLIANCES = build_default_appliances()


def derive_occupancy_label(count):
    count = int(count)
    if count <= 0:
        return "Absent"
    if count == 1:
        return "Low"
    if count <= 3:
        return "Medium"
    return "High"


def resolve_room_mode(global_mode, room_mode):
    if room_mode == "LOCAL_AUTO":
        return "AUTO"
    if room_mode == "LOCAL_MANUAL":
        return "MANUAL"
    return global_mode


def build_rooms_payload(appliances, room_sensors, room_modes, global_mode, room_metrics, fan_policy=None):
    fan_policy = fan_policy or {}
    rooms = {}
    for room_id, room in ROOMS.items():
        light = appliances[f"{room_id}_light"]
        fan = appliances[f"{room_id}_fan"]
        sensors = room_sensors[room_id]
        room_mode = room_modes.get(room_id, "FOLLOW_GLOBAL")
        rooms[room_id] = {
            "id": room_id,
            "name": room["name"],
            "mode": room_mode,
            "resolved_mode": resolve_room_mode(global_mode, room_mode),
            "sensors": {
                "temperature": sensors["temperature"],
                "ambient_light": sensors["ambient_light"],
                "occupancy_count": sensors["occupancy_count"],
                "occupancy_level": derive_occupancy_label(sensors["occupancy_count"]),
            },
            "layout": {
                "fan_position": room["fan_position"],
                "leds": room["leds"],
            },
            "devices": {
                "light": {
                    "id": light["name"],
                    "state": light["state"],
                    "brightness": light["level"],
                    "color": room["light_color"],
                    "power_watts": light["power_watts"],
                },
                "fan": {
                    "id": fan["name"],
                    "state": fan["state"],
                    "speed": fan["speed"],
                    "speed_percent": fan["level"],
                    "power_watts": fan["power_watts"],
                    "policy": fan_policy.get(room_id, {}),
                },
            },
            "metrics": room_metrics[room_id],
            "legacy": {
                "light": {
                "id": light["name"],
                "state": light["state"],
                "brightness": light["level"],
                "color": room["light_color"],
                "power_watts": light["power_watts"],
                },
                "fan": {
                "id": fan["name"],
                "state": fan["state"],
                "speed": fan["speed"],
                "level": fan["level"],
                "power_watts": fan["power_watts"],
                },
            },
        }
    return rooms
