import os
import tempfile
import unittest


class PowerOptimizationTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["POWER_OPT_DB_PATH"] = os.path.join(self.temp_dir.name, "test.db")
        os.environ["POWER_OPT_LOCAL_SETTINGS_PATH"] = os.path.join(self.temp_dir.name, "missing-local-settings.json")
        os.environ["OPENAI_API_KEY"] = ""

        import importlib
        import database
        import app

        importlib.reload(database)
        importlib.reload(app)

        self.client = app.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("POWER_OPT_DB_PATH", None)
        os.environ.pop("POWER_OPT_LOCAL_SETTINGS_PATH", None)
        os.environ.pop("OPENAI_API_KEY", None)

    def set_global_mode(self, mode):
        return self.client.post("/api/system-mode", json={"mode": mode})

    def set_room_mode(self, room_id, mode):
        return self.client.post("/api/room-mode", json={"room_id": room_id, "mode": mode})

    def test_system_state_exposes_room_local_model(self):
        response = self.client.get("/api/system-state")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["global_mode"], "AUTO")
        self.assertIn("living_room", payload["rooms"])
        self.assertIn("sensors", payload["rooms"]["bedroom"])
        self.assertIn("devices", payload["rooms"]["bedroom"])
        self.assertIn("metrics", payload["rooms"]["bedroom"])
        self.assertEqual(payload["rooms"]["study"]["sensors"]["occupancy_level"], "Absent")
        self.assertIn("policy", payload["rooms"]["living_room"]["devices"]["fan"])

    def test_room_sensor_update_only_changes_target_room(self):
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "bedroom",
                "temperature": 24,
                "humidity": 52,
                "ambient_light": 18,
                "occupancy_count": 3,
            },
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 201)
        self.assertEqual(payload["rooms"]["bedroom"]["sensors"]["temperature"], 24.0)
        self.assertEqual(payload["rooms"]["bedroom"]["sensors"]["occupancy_level"], "Medium")
        self.assertEqual(payload["rooms"]["study"]["sensors"]["temperature"], 29.0)

    def test_auto_evaluation_updates_only_auto_rooms(self):
        self.set_room_mode("study", "LOCAL_MANUAL")
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 33,
                "humidity": 78,
                "ambient_light": 10,
                "occupancy_count": 4,
            },
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 201)
        self.assertEqual(payload["rooms"]["living_room"]["devices"]["fan"]["state"], "ON")
        self.assertGreater(payload["rooms"]["living_room"]["devices"]["fan"]["speed_percent"], 0)
        self.assertEqual(payload["rooms"]["study"]["resolved_mode"], "MANUAL")
        self.assertEqual(payload["rooms"]["study"]["devices"]["fan"]["speed_percent"], 0)

    def test_manual_control_is_available_without_visible_mode_switch(self):
        response = self.client.post(
            "/api/control/appliance",
            json={"appliance": "bedroom_light", "level": 70},
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["rooms"]["bedroom"]["devices"]["light"]["brightness"], 70)

    def test_manual_light_brightness_is_held_during_automation(self):
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "bedroom",
                "temperature": 25,
                "humidity": 55,
                "ambient_light": 60,
                "occupancy_count": 1,
            },
        )
        self.client.post(
            "/api/control/appliance",
            json={"appliance": "bedroom_light", "level": 85},
        )

        response = self.client.post("/api/decision/evaluate")
        payload = response.get_json()
        light = payload["rooms"]["bedroom"]["devices"]["light"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(light["brightness"], 85)

    def test_slider_zero_preserves_light_switch_on(self):
        response = self.client.post(
            "/api/control/appliance",
            json={"appliance": "bedroom_light", "level": 0, "preserve_on_zero": True},
        )
        payload = response.get_json()
        light = payload["rooms"]["bedroom"]["devices"]["light"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(light["state"], "ON")
        self.assertEqual(light["brightness"], 0)

    def test_slider_zero_preserves_fan_switch_on(self):
        response = self.client.post(
            "/api/control/appliance",
            json={"appliance": "bedroom_fan", "level": 0, "preserve_on_zero": True},
        )
        payload = response.get_json()
        fan = payload["rooms"]["bedroom"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fan["state"], "ON")
        self.assertEqual(fan["speed_percent"], 0)

    def test_light_returns_to_ambient_auto_target_after_hold_expires(self):
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "bedroom",
                "temperature": 25,
                "humidity": 55,
                "ambient_light": 60,
                "occupancy_count": 1,
            },
        )
        self.client.post(
            "/api/control/appliance",
            json={"appliance": "bedroom_light", "level": 85},
        )

        import database
        from control.light_policy import runtime_from_record, runtime_to_record

        runtime = runtime_from_record(database.get_light_policy_states()["bedroom"])
        expired = runtime.__class__(
            hold_until_epoch=0,
            user_brightness=None,
            phase=runtime.phase,
            last_reason=runtime.last_reason,
        )
        database.save_light_policy_state("bedroom", runtime_to_record(expired))

        response = self.client.post("/api/decision/evaluate")
        payload = response.get_json()
        light = payload["rooms"]["bedroom"]["devices"]["light"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(light["brightness"], 18)

    def test_manual_fan_control_starts_hold_policy(self):
        response = self.client.post(
            "/api/control/appliance",
            json={"appliance": "bedroom_fan", "level": 46},
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["rooms"]["bedroom"]["devices"]["fan"]["speed_percent"], 46)
        self.assertEqual(payload["rooms"]["bedroom"]["devices"]["fan"]["policy"]["state"], "hold")

    def test_follow_global_resolves_against_global_manual_mode(self):
        self.set_global_mode("MANUAL")
        response = self.client.get("/api/system-state")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["rooms"]["living_room"]["resolved_mode"], "MANUAL")

    def test_room_local_auto_override_works_while_global_manual(self):
        self.set_global_mode("MANUAL")
        self.set_room_mode("kitchen", "LOCAL_AUTO")
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "kitchen",
                "temperature": 31,
                "humidity": 70,
                "ambient_light": 12,
                "occupancy_count": 2,
            },
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 201)
        self.assertEqual(payload["rooms"]["kitchen"]["resolved_mode"], "AUTO")
        self.assertEqual(payload["rooms"]["kitchen"]["devices"]["light"]["state"], "ON")

    def test_run_evaluation_now_returns_activity_summary(self):
        response = self.client.post("/api/decision/evaluate")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertIn("activity_summary", payload)
        self.assertIn("latest_actions", payload)

    def test_system_state_includes_dashboard_payload(self):
        response = self.client.get("/api/system-state")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertIn("dashboard", payload)
        self.assertIn("summary", payload["dashboard"])
        self.assertIn("room_comparison", payload["dashboard"])
        self.assertIn("hourly_trend", payload["dashboard"])

    def test_metrics_react_aggressively_to_room_load_changes(self):
        baseline = self.client.get("/api/system-state").get_json()
        baseline_power = baseline["metrics"]["active_power_watts"]

        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 37,
                "ambient_light": 8,
                "occupancy_count": 4,
            },
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 201)
        self.assertGreater(payload["metrics"]["active_power_watts"], baseline_power)
        self.assertGreater(payload["rooms"]["living_room"]["metrics"]["active_power_watts"], 0)
        self.assertGreater(payload["metrics"]["hourly_cost_inr"], baseline["metrics"]["hourly_cost_inr"])

    def test_repeated_evaluations_keep_hot_room_speed_stable(self):
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 35,
                "humidity": 65,
                "ambient_light": 20,
                "occupancy_count": 2,
            },
        )
        payload = response.get_json()
        speeds = [payload["rooms"]["living_room"]["devices"]["fan"]["speed_percent"]]

        for _ in range(3):
            response = self.client.post("/api/decision/evaluate")
            payload = response.get_json()
            speeds.append(payload["rooms"]["living_room"]["devices"]["fan"]["speed_percent"])

        self.assertTrue(all(speed == speeds[0] for speed in speeds))

    def test_hot_room_starts_fan_at_temperature_matched_speed(self):
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 40,
                "humidity": 55,
                "ambient_light": 20,
                "occupancy_count": 1,
            },
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 201)
        self.assertEqual(fan["speed_percent"], 95)
        self.assertEqual(fan["policy"]["auto_target_percent"], 95)
        self.assertEqual(fan["speed"], "HIGH")

    def test_turning_fan_back_on_resumes_previous_speed(self):
        self.client.post("/api/control/appliance", json={"appliance": "living_room_fan", "level": 46})
        self.client.post("/api/control/appliance", json={"appliance": "living_room_fan", "level": 0})

        response = self.client.post(
            "/api/control/appliance",
            json={"appliance": "living_room_fan", "level": 90, "resume": True},
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fan["speed_percent"], 46)
        self.assertEqual(fan["speed"], "MEDIUM")

    def test_stale_manual_low_fan_is_released_by_room_climate_change(self):
        self.client.post("/api/control/appliance", json={"appliance": "living_room_fan", "level": 22})

        import database
        from control.fan_policy import runtime_from_record, runtime_to_record

        states = database.get_fan_policy_states()
        runtime = runtime_from_record(states["living_room"])
        runtime = runtime.__class__(
            smoothed_temp=runtime.smoothed_temp,
            smoothed_humidity=runtime.smoothed_humidity,
            last_occupied_epoch=runtime.last_occupied_epoch,
            hold_until_epoch=runtime.hold_until_epoch,
            reclaim_end_epoch=runtime.reclaim_end_epoch,
            last_manual_intent_epoch=runtime.last_manual_intent_epoch - 30,
            user_anchor_temp=runtime.user_anchor_temp,
            user_anchor_percent=runtime.user_anchor_percent,
            last_user_preference_percent=runtime.last_user_preference_percent,
            applied_percent=runtime.applied_percent,
            auto_target_percent=runtime.auto_target_percent,
            blended_target_percent=runtime.blended_target_percent,
            device_level=runtime.device_level,
            last_device_change_epoch=runtime.last_device_change_epoch,
            phase=runtime.phase,
            last_reason=runtime.last_reason,
        )
        database.save_fan_policy_state("living_room", runtime_to_record(runtime))

        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 37,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 1,
            },
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 201)
        self.assertGreater(fan["speed_percent"], 22)
        self.assertEqual(fan["policy"]["state"], "reclaim")

    def test_system_state_syncs_initial_fan_speed_to_room_temperature(self):
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 37,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 1,
            },
        )

        import database
        database.set_appliance_state("living_room_fan", "ON", 22, speed="LOW")

        response = self.client.get("/api/system-state")
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(fan["speed_percent"], 90)
        self.assertEqual(fan["speed"], "HIGH")

    def test_system_state_ignores_stale_manual_fan_history(self):
        self.client.post("/api/control/appliance", json={"appliance": "living_room_fan", "level": 22})
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 38,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 1,
            },
        )

        response = self.client.get("/api/system-state")
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(fan["speed_percent"], 90)
        self.assertEqual(fan["speed"], "HIGH")

    def test_high_temperature_reload_syncs_even_when_room_is_vacant(self):
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 38,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 0,
            },
        )

        response = self.client.get("/api/system-state")
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(fan["speed_percent"], 84)
        self.assertEqual(fan["speed"], "HIGH")

    def test_very_cool_room_keeps_fan_armed_at_zero_for_auto_restart(self):
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 17,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 0,
            },
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 201)
        self.assertEqual(fan["state"], "ON")
        self.assertEqual(fan["speed_percent"], 0)
        self.assertEqual(fan["speed"], "OFF")

        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 38,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 0,
            },
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 201)
        self.assertEqual(fan["state"], "ON")
        self.assertGreater(fan["speed_percent"], 0)
        self.assertNotEqual(fan["speed"], "OFF")

    def test_vacant_room_above_eighteen_degrees_keeps_low_background_fan(self):
        response = self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "living_room",
                "temperature": 24,
                "humidity": 55,
                "ambient_light": 40,
                "occupancy_count": 0,
            },
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 201)
        self.assertEqual(fan["state"], "ON")
        self.assertGreater(fan["speed_percent"], 0)
        self.assertNotEqual(fan["speed"], "OFF")

    def test_manual_fan_off_stays_fully_off_during_hold(self):
        self.client.post("/api/control/appliance", json={"appliance": "living_room_fan", "level": 46})

        response = self.client.post(
            "/api/control/appliance",
            json={"appliance": "living_room_fan", "level": 0},
        )
        payload = response.get_json()
        fan = payload["rooms"]["living_room"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fan["state"], "OFF")
        self.assertEqual(fan["speed_percent"], 0)
        self.assertEqual(fan["policy"]["state"], "hold")

    def test_voice_command_route_executes_room_local_fan_speed(self):
        response = self.client.post(
            "/api/voice/command",
            json={
                "room_id": "bedroom",
                "raw_text": "set fan speed to 64 percent",
            },
        )
        payload = response.get_json()
        fan = payload["rooms"]["bedroom"]["devices"]["fan"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["voice_command"]["intent"], "set_fan_speed")
        self.assertEqual(payload["voice_command"]["room_id"], "bedroom")
        self.assertIn("voice_debug", payload)
        self.assertEqual(fan["speed_percent"], 64)

    def test_voice_command_rejects_other_room_target(self):
        response = self.client.post(
            "/api/voice/command",
            json={
                "room_id": "bedroom",
                "raw_text": "turn on the kitchen light",
            },
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["voice_command"]["intent"], "reject")
        self.assertEqual(payload["rooms"]["kitchen"]["devices"]["light"]["state"], "OFF")

    def test_voice_turn_light_on_uses_room_sensor_based_brightness(self):
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "bedroom",
                "temperature": 25,
                "humidity": 55,
                "ambient_light": 50,
                "occupancy_count": 1,
            },
        )
        self.client.post("/api/control/appliance", json={"appliance": "bedroom_light", "level": 0})

        response = self.client.post(
            "/api/voice/command",
            json={
                "room_id": "bedroom",
                "raw_text": "turn on the light",
            },
        )
        payload = response.get_json()
        light = payload["rooms"]["bedroom"]["devices"]["light"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["voice_command"]["intent"], "turn_light_on")
        self.assertEqual(light["brightness"], 35)

    def test_voice_turn_light_on_still_lights_room_when_auto_recommendation_is_zero(self):
        self.client.post(
            "/api/sensor-reading",
            json={
                "room_id": "bedroom",
                "temperature": 25,
                "humidity": 55,
                "ambient_light": 90,
                "occupancy_count": 0,
            },
        )
        self.client.post("/api/control/appliance", json={"appliance": "bedroom_light", "level": 0})

        response = self.client.post(
            "/api/voice/command",
            json={
                "room_id": "bedroom",
                "raw_text": "turn on the light",
            },
        )
        payload = response.get_json()
        light = payload["rooms"]["bedroom"]["devices"]["light"]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["voice_command"]["intent"], "turn_light_on")
        self.assertEqual(light["brightness"], 35)

    def test_usage_history_returns_room_sensor_history(self):
        response = self.client.get("/api/usage/history")
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertIn("room_sensor_history", payload)
        self.assertIn("decision_history", payload)


if __name__ == "__main__":
    unittest.main()
