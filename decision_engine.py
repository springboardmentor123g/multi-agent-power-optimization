from time import time

from control.fan_policy import (
    FanControlState,
    FanPolicyConfig,
    describe_runtime,
    estimate_confidence,
    evaluate_fan_policy,
    runtime_from_record,
)
from control.light_policy import (
    LightPolicyConfig,
    evaluate_light_policy,
    runtime_from_record as light_runtime_from_record,
)
from database import compute_runtime_hours, get_recent_decision_logs, get_recent_room_sensor_readings
from home_layout import ROOMS, derive_occupancy_label, resolve_room_mode


TARIFF_PER_KWH = 8.0
DEFAULT_FAN_POLICY_CONFIG = FanPolicyConfig()
DEFAULT_LIGHT_POLICY_CONFIG = LightPolicyConfig()


def estimate_light_power(light, occupancy_count=0):
    level = int(light["level"])
    base_power = float(light["power_watts"])
    if light["state"] != "ON" and level <= 0:
        return 0.0
    if level <= 0:
        return round(base_power * 0.04, 2)
    intensity = level / 100
    occupancy_factor = 1 + min(0.14, max(0, occupancy_count) * 0.025)
    return round(base_power * (0.08 + 1.08 * (intensity ** 1.32)) * occupancy_factor, 2)


def estimate_fan_power(fan, occupancy_count=0):
    level = int(fan["level"])
    base_power = float(fan["power_watts"])
    if fan["state"] != "ON" and level <= 0:
        return 0.0
    if level <= 0:
        return round(base_power * 0.05, 2)
    intensity = level / 100
    occupancy_factor = 1 + min(0.18, max(0, occupancy_count) * 0.03)
    return round(base_power * (0.12 + 1.24 * (intensity ** 1.58)) * occupancy_factor, 2)


def estimate_room_power(room_id, sensors, appliances):
    occupancy_count = int(sensors["occupancy_count"])
    light = appliances[f"{room_id}_light"]
    fan = appliances[f"{room_id}_fan"]
    occupancy_load = 0.0 if occupancy_count <= 0 else (occupancy_count * 3.8) + (max(0, occupancy_count - 2) * 2.4)
    return round(
        estimate_light_power(light, occupancy_count)
        + estimate_fan_power(fan, occupancy_count)
        + occupancy_load,
        2,
    )


def calculate_metrics(room_sensors, appliances):
    room_powers = [
        estimate_room_power(room_id, room_sensors[room_id], appliances)
        for room_id in ROOMS
    ]
    active_power = sum(room_powers)
    hourly_cost = round((active_power / 1000) * TARIFF_PER_KWH, 2)
    daily_cost_projection = round(hourly_cost * 24, 2)
    session_cost = round(
        sum(
            ((estimate_room_power(room_id, room_sensors[room_id], appliances) / 1000) * TARIFF_PER_KWH)
            * max(
                compute_runtime_hours(appliances[f"{room_id}_light"]["updated_at"]),
                compute_runtime_hours(appliances[f"{room_id}_fan"]["updated_at"]),
            )
            for room_id in ROOMS
        ),
        2,
    )
    average_temp = sum(float(reading["temperature"]) for reading in room_sensors.values()) / len(room_sensors)
    return {
        "active_power_watts": round(active_power, 2),
        "hourly_cost_inr": hourly_cost,
        "daily_cost_projection_inr": daily_cost_projection,
        "session_cost_inr": session_cost,
        "temperature_status": get_temperature_status(average_temp),
    }


def build_room_metrics(room_id, sensors, appliances):
    light = appliances[f"{room_id}_light"]
    fan = appliances[f"{room_id}_fan"]
    room_power = estimate_room_power(room_id, sensors, appliances)
    hourly_cost = round((room_power / 1000) * TARIFF_PER_KWH, 2)
    session_cost = round(
        (((room_power / 1000) * TARIFF_PER_KWH) * max(
            compute_runtime_hours(light["updated_at"]),
            compute_runtime_hours(fan["updated_at"]),
        )),
        2,
    )
    return {
        "active_power_watts": round(room_power, 2),
        "hourly_cost_inr": hourly_cost,
        "session_cost_inr": session_cost,
        "occupancy_level": derive_occupancy_label(sensors["occupancy_count"]),
        "temperature_status": get_temperature_status(sensors["temperature"]),
    }


def build_dashboard_payload(room_sensors, appliances):
    room_metrics = {
        room_id: build_room_metrics(room_id, room_sensors[room_id], appliances)
        for room_id in ROOMS
    }
    recent_history = get_recent_room_sensor_readings(limit=240)
    recent_decisions = get_recent_decision_logs(limit=80)
    hourly_buckets = {}
    room_rollups = {
        room_id: {
            "energy_kwh": 0.0,
            "cost_inr": 0.0,
            "avg_fan_percent": 0.0,
            "avg_light_percent": 0.0,
            "occupancy_score": 0.0,
            "samples": 0,
        }
        for room_id in ROOMS
    }
    for reading in reversed(recent_history):
        room_id = reading["room_id"]
        metric = room_metrics[room_id]
        hour_key = reading["created_at"][11:13] if reading.get("created_at") else "00"
        bucket = hourly_buckets.setdefault(hour_key, {"power": 0.0, "cost": 0.0, "activity": 0})
        bucket["power"] += metric["active_power_watts"] * 0.32
        bucket["cost"] += metric["hourly_cost_inr"] * 0.32
        bucket["activity"] += int(reading["occupancy_count"]) + (1 if float(reading["ambient_light"]) < 35 else 0)
        room_rollups[room_id]["energy_kwh"] += (metric["active_power_watts"] * 0.28) / 1000
        room_rollups[room_id]["cost_inr"] += metric["hourly_cost_inr"] * 0.28
        room_rollups[room_id]["avg_fan_percent"] += int(appliances[f"{room_id}_fan"]["level"])
        room_rollups[room_id]["avg_light_percent"] += int(appliances[f"{room_id}_light"]["level"])
        room_rollups[room_id]["occupancy_score"] += int(reading["occupancy_count"])
        room_rollups[room_id]["samples"] += 1

    room_comparison = []
    for room_id, rollup in room_rollups.items():
        samples = max(1, rollup["samples"])
        room_comparison.append(
            {
                "room_id": room_id,
                "name": ROOMS[room_id]["name"],
                "energy_kwh": round(rollup["energy_kwh"] or (room_metrics[room_id]["active_power_watts"] * 3.2 / 1000), 2),
                "cost_inr": round(rollup["cost_inr"] or (room_metrics[room_id]["hourly_cost_inr"] * 3.2), 2),
                "avg_fan_percent": round(rollup["avg_fan_percent"] / samples, 1),
                "avg_light_percent": round(rollup["avg_light_percent"] / samples, 1),
                "occupancy_score": round(rollup["occupancy_score"] / samples, 1),
            }
        )
    room_comparison.sort(key=lambda item: item["cost_inr"], reverse=True)

    hourly_trend = [
        {
            "hour": f"{hour}:00",
            "power_watts": round(values["power"], 1),
            "cost_inr": round(values["cost"], 2),
            "activity": values["activity"],
        }
        for hour, values in sorted(hourly_buckets.items())
    ]
    if not hourly_trend:
        hourly_trend = [
            {"hour": "09:00", "power_watts": 84.0, "cost_inr": 0.67, "activity": 2},
            {"hour": "14:00", "power_watts": 118.0, "cost_inr": 0.94, "activity": 3},
            {"hour": "21:00", "power_watts": 162.0, "cost_inr": 1.30, "activity": 5},
        ]

    highest_room = room_comparison[0] if room_comparison else {"name": "Living Room", "cost_inr": 0.0}
    peak_hour = max(hourly_trend, key=lambda item: item["power_watts"])
    idle_waste_rooms = [
        ROOMS[room_id]["name"]
        for room_id in ROOMS
        if int(room_sensors[room_id]["occupancy_count"]) == 0
        and (
            int(appliances[f"{room_id}_light"]["level"]) > 20
            or int(appliances[f"{room_id}_fan"]["level"]) > 35
        )
    ]
    overcooled_rooms = [
        ROOMS[room_id]["name"]
        for room_id in ROOMS
        if float(room_sensors[room_id]["temperature"]) < 25
        and int(appliances[f"{room_id}_fan"]["level"]) > 55
    ]
    savings_opportunity = round(
        max(8, min(26, (len(idle_waste_rooms) * 7) + (len(overcooled_rooms) * 5) + (highest_room["cost_inr"] * 2))),
        1,
    )

    recommendations = []
    if room_comparison:
        recommendations.append(f'{highest_room["name"]} is the highest load room right now. A 15% brightness cap would save the fastest.')
    if peak_hour:
        recommendations.append(f'Usage is trending toward a peak around {peak_hour["hour"]}. Pre-cooling before that window would flatten the spike.')
    if idle_waste_rooms:
        recommendations.append(f'Low-occupancy waste is visible in {", ".join(idle_waste_rooms[:2])}. Shorter idle timeout would recover cost quickly.')
    if not recommendations:
        recommendations.append("Current usage pattern looks balanced. Mild fan caps during brighter hours would be the next easy saving.")

    inefficiencies = []
    for room_id in ROOMS:
        sensors = room_sensors[room_id]
        if int(sensors["occupancy_count"]) == 0 and int(appliances[f"{room_id}_light"]["level"]) > 15:
            inefficiencies.append(f'{ROOMS[room_id]["name"]}: lights active with no occupancy')
        if float(sensors["temperature"]) < 26 and int(appliances[f"{room_id}_fan"]["level"]) > 60:
            inefficiencies.append(f'{ROOMS[room_id]["name"]}: fan speed is high for current temperature')
    if not inefficiencies:
        inefficiencies.append("No strong inefficiencies detected in the current room mix.")

    total_cost_today = round(sum(item["cost_inr"] for item in room_comparison), 2)
    total_energy_today = round(sum(item["energy_kwh"] for item in room_comparison), 2)
    return {
        "summary": {
            "total_energy_today_kwh": total_energy_today,
            "total_cost_today_inr": total_cost_today,
            "highest_consuming_room": highest_room["name"],
            "peak_usage_hour": peak_hour["hour"],
            "efficiency_score": round(max(58, 100 - (savings_opportunity * 1.5)), 1),
            "savings_opportunity_percent": savings_opportunity,
        },
        "room_comparison": room_comparison,
        "hourly_trend": hourly_trend,
        "inefficiencies": inefficiencies,
        "recommendations": recommendations,
        "policy_preview": [
            "Brightness cap: 85% after sunset",
            "Max fan speed: 90% except extreme heat",
            "Idle timeout suggestion: 4 minutes",
            "Peak-hour saving mode: 7 PM - 10 PM",
        ],
        "decision_count": len(recent_decisions),
    }


def get_temperature_status(temperature):
    if temperature >= 31:
        return "Hot"
    if temperature >= 26:
        return "Warm"
    if temperature <= 22:
        return "Cool"
    return "Comfortable"


def summarize_usage_pattern(room_sensors):
    occupied_rooms = sum(1 for sensors in room_sensors.values() if int(sensors["occupancy_count"]) > 0)
    hot_rooms = sum(1 for sensors in room_sensors.values() if float(sensors["temperature"]) >= 30)
    dark_rooms = sum(1 for sensors in room_sensors.values() if float(sensors["ambient_light"]) <= 35)
    return {
        "occupied_rooms": occupied_rooms,
        "hot_rooms": hot_rooms,
        "dark_rooms": dark_rooms,
    }


def evaluate_rules(
    room_sensors,
    appliances,
    global_mode,
    room_modes,
    fan_policy_states=None,
    light_policy_states=None,
    *,
    now_epoch=None,
    fan_policy_config=DEFAULT_FAN_POLICY_CONFIG,
    light_policy_config=DEFAULT_LIGHT_POLICY_CONFIG,
):
    fan_policy_states = fan_policy_states or {}
    light_policy_states = light_policy_states or {}
    now_epoch = float(now_epoch if now_epoch is not None else time())
    actions = []
    fan_results = {}
    light_results = {}
    for room_id, sensors in room_sensors.items():
        resolved_mode = resolve_room_mode(global_mode, room_modes[room_id])
        if resolved_mode != "AUTO":
            continue
        room_actions, fan_result, light_result = evaluate_room(
            room_id,
            sensors,
            appliances,
            fan_policy_states.get(room_id),
            light_policy_states.get(room_id),
            now_epoch=now_epoch,
            fan_policy_config=fan_policy_config,
            light_policy_config=light_policy_config,
        )
        actions.extend(room_actions)
        fan_results[room_id] = fan_result
        light_results[room_id] = light_result
    return actions, summarize_usage_pattern(room_sensors), fan_results, light_results


def evaluate_room(
    room_id,
    sensors,
    appliances,
    fan_policy_state,
    light_policy_state,
    *,
    now_epoch,
    fan_policy_config,
    light_policy_config,
):
    actions = []
    occupancy_count = int(sensors["occupancy_count"])
    temperature = float(sensors["temperature"])
    ambient_light = float(sensors["ambient_light"])

    light_id = f"{room_id}_light"
    fan_id = f"{room_id}_fan"
    light = appliances[light_id]
    fan = appliances[fan_id]

    light_result = evaluate_light_policy(
        light_runtime_from_record(light_policy_state),
        occupancy_count=occupancy_count,
        ambient_light=ambient_light,
        now_epoch=now_epoch,
        config=light_policy_config,
    )
    target_brightness = light_result.applied_brightness
    desired_light_state = "OFF" if target_brightness == 0 else "ON"
    if light["state"] != desired_light_state or int(light["level"]) != target_brightness:
        actions.append(
            {
                "room_id": room_id,
                "appliance": light_id,
                "action": desired_light_state,
                "level": target_brightness,
                "reason": light_result.explanation,
            }
        )

    fan_result = evaluate_fan_policy(
        runtime_from_record(fan_policy_state),
        occupancy_count=occupancy_count,
        raw_temp=temperature,
        raw_humidity=55.0,
        now_epoch=now_epoch,
        config=fan_policy_config,
        confidence=estimate_confidence(
            occupancy_count=occupancy_count,
            raw_temp=temperature,
            raw_humidity=55.0,
        ),
    )
    preserve_on_zero = (
        fan_result.applied_percent == 0
        and fan_result.state != FanControlState.HOLD
    )
    desired_fan_state = "ON" if preserve_on_zero or fan_result.applied_percent > 0 else "OFF"
    if (
        fan["state"] != desired_fan_state
        or int(fan["level"]) != fan_result.applied_percent
        or fan["speed"] != fan_result.device_level
    ):
        actions.append(
            {
                "room_id": room_id,
                "appliance": fan_id,
                "action": desired_fan_state,
                "level": fan_result.applied_percent,
                "speed": fan_result.device_level,
                "preserve_on_zero": preserve_on_zero,
                "reason": fan_result.explanation,
                "fan_policy": describe_runtime(fan_result.runtime, now_epoch),
            }
        )

    return actions, fan_result, light_result


def build_insights(room_sensors, room_metrics, global_metrics, pattern):
    insights = []
    if pattern["occupied_rooms"] == 0 and global_metrics["active_power_watts"] > 0:
        insights.append("Rooms appear vacant while some devices are still active. Local manual overrides may be increasing idle consumption.")
    if pattern["hot_rooms"] >= 2:
        insights.append("Multiple rooms are above comfort temperature. Ventilation and insulation changes could reduce fan demand.")
    if global_metrics["daily_cost_projection_inr"] >= 20:
        insights.append("Projected daily cost is elevated. Rooms with high occupancy and low daylight are contributing most to active load.")
    if not insights:
        insights.append("Current room conditions are operating within an efficient range.")
    return insights
