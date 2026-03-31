from time import time

from flask import Flask, jsonify, request, send_from_directory

from control.fan_policy import (
    apply_manual_intent,
    describe_runtime,
    reset_runtime_for_auto_sync,
    resume_from_off,
    release_hold_for_sensor_intent,
    runtime_from_record,
    runtime_to_record,
)
from control.light_policy import (
    apply_manual_light_intent,
    runtime_from_record as light_runtime_from_record,
    runtime_to_record as light_runtime_to_record,
)
from database import (
    build_recent_activity_summary,
    get_fan_policy_states,
    get_light_policy_states,
    get_appliance_states,
    get_global_mode,
    get_recent_decision_logs,
    get_recent_room_sensor_readings,
    get_room_modes,
    get_latest_room_sensor_readings,
    init_db,
    log_decision,
    reset_room_modes,
    save_fan_policy_state,
    save_light_policy_state,
    set_global_mode,
    set_room_mode,
)
from decision_engine import (
    DEFAULT_FAN_POLICY_CONFIG,
    DEFAULT_LIGHT_POLICY_CONFIG,
    TARIFF_PER_KWH,
    build_dashboard_payload,
    build_insights,
    build_room_metrics,
    calculate_metrics,
    evaluate_rules,
)
from device_controller import build_device_controller
from home_layout import ROOM_MODE_OPTIONS, ROOMS, build_rooms_payload
from voice.command_executor import build_execution_plan
from voice.command_parser import VoiceCommandParser


app = Flask(__name__, static_folder="static", static_url_path="/static")
device_controller = build_device_controller()
voice_command_parser = VoiceCommandParser()


def build_snapshot():
    global_mode = get_global_mode()
    room_modes = get_room_modes()
    room_sensors = get_latest_room_sensor_readings()
    appliances = get_appliance_states()
    fan_policy_states = get_fan_policy_states()
    light_policy_states = get_light_policy_states()
    now_epoch = time()
    room_metrics = {
        room_id: build_room_metrics(room_id, room_sensors[room_id], appliances)
        for room_id in ROOMS
    }
    metrics = calculate_metrics(room_sensors, appliances)
    _, pattern, _, _ = evaluate_rules(
        room_sensors,
        appliances,
        global_mode,
        room_modes,
        fan_policy_states,
        light_policy_states,
        now_epoch=now_epoch,
    )
    insights = build_insights(room_sensors, room_metrics, metrics, pattern)
    dashboard = build_dashboard_payload(room_sensors, appliances)
    return {
        "tariff_inr_per_kwh": TARIFF_PER_KWH,
        "deployment_model": "single-node-raspberry-pi",
        "device_mode": device_controller.get_mode(),
        "global_mode": global_mode,
        "metrics": metrics,
        "rooms": build_rooms_payload(
            appliances,
            room_sensors,
            room_modes,
            global_mode,
            room_metrics,
            {
                room_id: describe_runtime(runtime_from_record(fan_policy_states.get(room_id)), now_epoch)
                for room_id in ROOMS
            },
        ),
        "insights": insights,
        "dashboard": dashboard,
        "recent_decisions": get_recent_decision_logs(limit=30),
        "activity_summary": build_recent_activity_summary(limit=4),
    }


def log_action(room_id, appliance, action, reason, source, appliances):
    power_watts = calculate_metrics(get_latest_room_sensor_readings(), appliances)["active_power_watts"]
    device = appliances[appliance]
    if device["device_type"] == "light":
        label = f"{device['level']}%"
    elif device["state"] == "ON" and int(device["level"]) == 0:
        label = "IDLE (0%)"
    else:
        label = f"{device['speed']} ({device['level']}%)"
    log_decision(
        {
            "room_id": room_id,
            "agent": "Decision Layer" if source == "auto" else "Action Layer",
            "appliance": appliance,
            "action": label if action == "ON" else "OFF",
            "reason": reason,
            "source": source,
            "estimated_power_watts": power_watts,
            "estimated_hourly_cost": (power_watts / 1000) * TARIFF_PER_KWH,
        }
    )


def apply_room_mode_update(room_id, mode):
    set_room_mode(room_id, mode)
    actions = run_decision_cycle()
    snapshot = build_snapshot()
    snapshot["latest_actions"] = actions
    snapshot["device_message"] = f"{ROOMS[room_id]['name']} mode updated to {mode}."
    return snapshot


def apply_appliance_update(appliance, level, *, resume=False):
    return apply_appliance_update_internal(appliance, level, resume=resume, preserve_on_zero=False)


def apply_appliance_update_internal(appliance, level, *, resume=False, preserve_on_zero=False):
    level = int(level)
    room_id = appliance.replace("_light", "").replace("_fan", "")
    state = "OFF" if level == 0 else "ON"
    speed = None
    policy_result = None
    if appliance.endswith("_fan"):
        now_epoch = time()
        policy_states = get_fan_policy_states()
        current_runtime = runtime_from_record(policy_states.get(room_id))
        current_appliances = get_appliance_states()
        if resume and current_appliances[appliance]["state"] == "OFF":
            policy_result = resume_from_off(
                current_runtime,
                now_epoch=now_epoch,
                config=DEFAULT_FAN_POLICY_CONFIG,
            )
        else:
            policy_result = apply_manual_intent(
                current_runtime,
                requested_percent=level,
                now_epoch=now_epoch,
                config=DEFAULT_FAN_POLICY_CONFIG,
            )
        level = policy_result.applied_percent
        state = "ON" if preserve_on_zero and level == 0 else ("OFF" if level == 0 else "ON")
        speed = policy_result.device_level
    elif appliance.endswith("_light"):
        now_epoch = time()
        policy_states = get_light_policy_states()
        policy_result = apply_manual_light_intent(
            light_runtime_from_record(policy_states.get(room_id)),
            requested_brightness=level,
            now_epoch=now_epoch,
            config=DEFAULT_LIGHT_POLICY_CONFIG,
        )
        level = policy_result.applied_brightness
        state = "ON" if preserve_on_zero and level == 0 else ("OFF" if level == 0 else "ON")
    controller_result = device_controller.set_device_state(
        appliance,
        state,
        level,
        speed=speed,
        preserve_on_zero=preserve_on_zero,
    )
    if appliance.endswith("_fan"):
        save_fan_policy_state(room_id, runtime_to_record(policy_result.runtime))
    elif appliance.endswith("_light"):
        save_light_policy_state(room_id, light_runtime_to_record(policy_result.runtime))
    appliances = get_appliance_states()
    reason = (
        policy_result.explanation
        if appliance.endswith("_fan") or appliance.endswith("_light")
        else "Manual room override applied."
    )
    log_action(room_id, appliance, state, reason, "manual", appliances)
    snapshot = build_snapshot()
    snapshot["device_message"] = controller_result["message"]
    return snapshot


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/system-state", methods=["GET"])
def system_state():
    run_decision_cycle(sync_snapshot=True)
    return jsonify(build_snapshot())


@app.route("/api/system-mode", methods=["POST"])
def system_mode():
    payload = request.get_json(force=True)
    mode = str(payload.get("mode", "AUTO")).upper()
    if mode not in {"AUTO", "MANUAL"}:
        return jsonify({"error": f"Invalid mode: {mode}"}), 400
    set_global_mode(mode)
    actions = run_decision_cycle() if mode == "AUTO" else []
    snapshot = build_snapshot()
    snapshot["latest_actions"] = actions
    snapshot["device_message"] = f"Global mode switched to {mode}."
    return jsonify(snapshot)


@app.route("/api/room-mode", methods=["POST"])
def room_mode():
    payload = request.get_json(force=True)
    room_id = payload["room_id"]
    mode = str(payload.get("mode", "FOLLOW_GLOBAL")).upper()
    if room_id not in ROOMS:
        return jsonify({"error": f"Unknown room: {room_id}"}), 400
    if mode not in ROOM_MODE_OPTIONS:
        return jsonify({"error": f"Invalid room mode: {mode}"}), 400
    return jsonify(apply_room_mode_update(room_id, mode))


@app.route("/api/sensor-reading", methods=["POST"])
def sensor_reading():
    payload = request.get_json(force=True)
    room_id = payload.get("room_id")
    target_rooms = [room_id] if room_id in ROOMS else list(ROOMS)
    previous_sensors = get_latest_room_sensor_readings()
    policy_states = get_fan_policy_states()
    now_epoch = time()
    for target_room in target_rooms:
        previous = previous_sensors[target_room]
        reading = {
            "temperature": float(payload.get("temperature", 29)),
            "humidity": float(previous.get("humidity", 55)),
            "ambient_light": float(payload.get("ambient_light", 45)),
            "occupancy_count": int(payload.get("occupancy_count", payload.get("occupancy", 0))),
        }
        device_controller.submit_sensor_values(target_room, reading)
        if climate_intent_changed(previous_sensors[target_room], reading):
            next_runtime = release_hold_for_sensor_intent(
                runtime_from_record(policy_states.get(target_room)),
                now_epoch=now_epoch,
                config=DEFAULT_FAN_POLICY_CONFIG,
            )
            if next_runtime != runtime_from_record(policy_states.get(target_room)):
                save_fan_policy_state(target_room, runtime_to_record(next_runtime))
    actions = run_decision_cycle()
    snapshot = build_snapshot()
    snapshot["latest_actions"] = actions
    snapshot["device_message"] = (
        f"Updated local sensor values for {ROOMS[room_id]['name']}."
        if room_id in ROOMS
        else "Updated fallback sensor values for all rooms."
    )
    return jsonify(snapshot), 201


@app.route("/api/sensors/read", methods=["POST"])
def read_sensors():
    payload = request.get_json(silent=True) or {}
    room_id = payload.get("room_id")
    controller_result = device_controller.read_sensor_values(room_id if room_id in ROOMS else None)
    actions = run_decision_cycle()
    snapshot = build_snapshot()
    snapshot["latest_actions"] = actions
    snapshot["device_message"] = controller_result["message"]
    return jsonify(snapshot)


@app.route("/api/control/appliance", methods=["POST"])
def control_appliance():
    payload = request.get_json(force=True)
    appliance = payload["appliance"]
    level = int(payload.get("level", payload.get("brightness", 0)))
    resume = bool(payload.get("resume", False))
    preserve_on_zero = bool(payload.get("preserve_on_zero", False))
    try:
        return jsonify(
            apply_appliance_update_internal(
                appliance,
                level,
                resume=resume,
                preserve_on_zero=preserve_on_zero,
            )
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 500


@app.route("/api/voice/command", methods=["POST"])
def voice_command():
    payload = request.get_json(force=True)
    room_id = payload.get("room_id")
    raw_text = payload.get("raw_text", "")
    if room_id not in ROOMS:
        return jsonify({"error": f"Unknown room: {room_id}"}), 400
    command, voice_debug = voice_command_parser.parse_with_debug(raw_text, room_id)
    room_snapshot = build_snapshot()["rooms"][room_id]
    plan = build_execution_plan(command, room_snapshot)
    if plan["kind"] == "noop":
        snapshot = build_snapshot()
        snapshot["voice_command"] = command
        snapshot["voice_debug"] = {
            **voice_debug,
            "transcript": raw_text,
        }
        snapshot["device_message"] = f"Voice command not executed: {plan['message']}"
        return jsonify(snapshot)
    try:
        if plan["kind"] == "room_mode":
            snapshot = apply_room_mode_update(plan["room_id"], plan["mode"])
        else:
            snapshot = apply_appliance_update(
                plan["appliance"],
                plan["level"],
                resume=plan.get("resume", False),
            )
    except ValueError as error:
        return jsonify({"error": str(error), "voice_command": command, "voice_debug": voice_debug}), 400
    except RuntimeError as error:
        return jsonify({"error": str(error), "voice_command": command, "voice_debug": voice_debug}), 500
    snapshot["voice_command"] = command
    snapshot["voice_debug"] = {
        **voice_debug,
        "transcript": raw_text,
    }
    snapshot["device_message"] = f'Heard: "{command["raw_text"]}" -> {command["intent"]}.'
    return jsonify(snapshot)


@app.route("/api/decision/evaluate", methods=["POST"])
def evaluate_decisions():
    actions = run_decision_cycle()
    snapshot = build_snapshot()
    snapshot["latest_actions"] = actions
    snapshot["device_message"] = "Run Evaluation Now completed."
    return jsonify(snapshot)


@app.route("/api/usage/history", methods=["GET"])
def usage_history():
    return jsonify(
        {
            "room_sensor_history": get_recent_room_sensor_readings(limit=60),
            "decision_history": get_recent_decision_logs(limit=40),
        }
    )


def run_decision_cycle(sync_snapshot=False):
    global_mode = get_global_mode()
    room_modes = get_room_modes()
    room_sensors = get_latest_room_sensor_readings()
    appliances = get_appliance_states()
    fan_policy_states = get_fan_policy_states()
    light_policy_states = get_light_policy_states()
    now_epoch = time()
    if sync_snapshot:
        fan_policy_states = {
            room_id: runtime_to_record(
                reset_runtime_for_auto_sync(
                    runtime_from_record(fan_policy_states.get(room_id)),
                    raw_temp=float(room_sensors[room_id]["temperature"]),
                    raw_humidity=float(room_sensors[room_id].get("humidity", 55.0)),
                )
            )
            for room_id in ROOMS
        }
    actions, _, fan_results, light_results = evaluate_rules(
        room_sensors,
        appliances,
        global_mode,
        room_modes,
        fan_policy_states,
        light_policy_states,
        now_epoch=now_epoch,
    )
    applied = []
    for action in actions:
        controller_result = device_controller.set_device_state(
            action["appliance"],
            action["action"],
            action["level"],
            speed=action.get("speed"),
            preserve_on_zero=action.get("preserve_on_zero", False),
        )
        updated = get_appliance_states()
        log_action(
            action["room_id"],
            action["appliance"],
            action["action"],
            action["reason"],
            "auto",
            updated,
        )
        applied.append({**action, "device_message": controller_result["message"]})
    for room_id, fan_result in fan_results.items():
        save_fan_policy_state(room_id, runtime_to_record(fan_result.runtime))
    for room_id, light_result in light_results.items():
        save_light_policy_state(room_id, light_runtime_to_record(light_result.runtime))
    return applied


def climate_intent_changed(previous_reading, next_reading):
    return (
        abs(float(previous_reading["temperature"]) - float(next_reading["temperature"])) >= 0.5
        or int(previous_reading["occupancy_count"]) != int(next_reading["occupancy_count"])
        or abs(float(previous_reading["ambient_light"]) - float(next_reading["ambient_light"])) >= 2.0
    )


def bootstrap():
    init_db()
    set_global_mode("AUTO")
    reset_room_modes("FOLLOW_GLOBAL")


bootstrap()


if __name__ == "__main__":
    app.run(debug=True)
