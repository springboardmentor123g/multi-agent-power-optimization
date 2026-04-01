import unittest

from control.device_mapping import DeviceMappingConfig, map_percent_to_level
from control.fan_policy import (
    FanControlState,
    FanPolicyConfig,
    FanPolicyRuntime,
    apply_manual_intent,
    evaluate_fan_policy,
    occupied_target,
    occupied_temp_setpoint_target,
    resume_from_off,
    release_hold_for_sensor_intent,
    vacant_target,
)


class FanPolicyTestCase(unittest.TestCase):
    def setUp(self):
        self.config = FanPolicyConfig(
            hold_duration_sec=60,
            reclaim_duration_sec=120,
            vacancy_grace_sec=180,
        )

    def test_occupied_room_mild_temperature_does_not_auto_drop_off(self):
        result = evaluate_fan_policy(
            FanPolicyRuntime(),
            occupancy_count=1,
            raw_temp=24.0,
            raw_humidity=52.0,
            now_epoch=100,
            config=self.config,
            confidence=0.8,
        )

        self.assertEqual(result.state, FanControlState.ASSIST)
        self.assertGreaterEqual(result.auto_target_percent, self.config.min_occupied_speed)
        self.assertGreaterEqual(result.applied_percent, self.config.min_occupied_speed)
        self.assertNotEqual(result.device_level, "OFF")

    def test_small_sensor_noise_does_not_cause_visible_oscillation(self):
        runtime = FanPolicyRuntime()
        applied = []
        levels = []
        for index, (temp, humidity) in enumerate(
            [(25.0, 55.0), (25.3, 56.0), (24.8, 54.0), (25.2, 55.0), (24.9, 54.5)],
            start=1,
        ):
            result = evaluate_fan_policy(
                runtime,
                occupancy_count=1,
                raw_temp=temp,
                raw_humidity=humidity,
                now_epoch=100 + (index * 60),
                config=self.config,
                confidence=0.65,
            )
            runtime = result.runtime
            applied.append(result.applied_percent)
            levels.append(result.device_level)

        self.assertLessEqual(max(applied) - min(applied), 4)
        self.assertTrue(all(level == levels[0] for level in levels))

    def test_manual_speed_change_enters_hold_and_restarts_timer(self):
        first = apply_manual_intent(
            FanPolicyRuntime(),
            requested_percent=42,
            now_epoch=100,
            config=self.config,
        )
        second = apply_manual_intent(
            first.runtime,
            requested_percent=61,
            now_epoch=220,
            config=self.config,
        )

        self.assertEqual(first.state, FanControlState.HOLD)
        self.assertEqual(second.state, FanControlState.HOLD)
        self.assertEqual(second.runtime.user_anchor_percent, 61)
        self.assertEqual(second.runtime.hold_until_epoch, 280)
        self.assertGreater(second.runtime.hold_until_epoch, first.runtime.hold_until_epoch)

    def test_reclaim_after_hold_is_gradual_not_snap(self):
        held = apply_manual_intent(
            FanPolicyRuntime(applied_percent=70, device_level="HIGH"),
            requested_percent=70,
            now_epoch=100,
            config=self.config,
        ).runtime

        result = evaluate_fan_policy(
            held,
            occupancy_count=1,
            raw_temp=24.0,
            raw_humidity=50.0,
            now_epoch=220,
            config=self.config,
            confidence=0.85,
        )

        self.assertEqual(result.state, FanControlState.RECLAIM)
        self.assertGreater(result.reclaim_progress, 0)
        self.assertGreater(result.applied_percent, self.config.min_occupied_speed)
        self.assertLess(result.applied_percent, 70)

    def test_repeated_manual_changes_update_anchor_cleanly(self):
        first = apply_manual_intent(
            FanPolicyRuntime(),
            requested_percent=28,
            now_epoch=100,
            config=self.config,
        ).runtime
        second = apply_manual_intent(
            first,
            requested_percent=54,
            now_epoch=180,
            config=self.config,
        )

        self.assertEqual(second.runtime.user_anchor_percent, 54)
        self.assertEqual(second.runtime.last_user_preference_percent, 54)
        self.assertEqual(second.runtime.applied_percent, 54)

    def test_sensor_intent_releases_stale_hold(self):
        held = apply_manual_intent(
            FanPolicyRuntime(),
            requested_percent=40,
            now_epoch=100,
            config=self.config,
        ).runtime

        released = release_hold_for_sensor_intent(
            held,
            now_epoch=130,
            config=self.config,
        )

        self.assertEqual(released.phase, FanControlState.RECLAIM)
        self.assertLess(released.hold_until_epoch, 130)

    def test_sensor_intent_does_not_release_very_recent_manual_touch(self):
        held = apply_manual_intent(
            FanPolicyRuntime(),
            requested_percent=40,
            now_epoch=100,
            config=self.config,
        ).runtime

        unreleased = release_hold_for_sensor_intent(
            held,
            now_epoch=108,
            config=self.config,
        )

        self.assertEqual(unreleased.phase, FanControlState.HOLD)
        self.assertEqual(unreleased.hold_until_epoch, held.hold_until_epoch)

    def test_vacancy_grace_prevents_immediate_drop(self):
        occupied = evaluate_fan_policy(
            FanPolicyRuntime(),
            occupancy_count=2,
            raw_temp=28.0,
            raw_humidity=58.0,
            now_epoch=100,
            config=self.config,
            confidence=0.8,
        ).runtime

        vacant = evaluate_fan_policy(
            occupied,
            occupancy_count=0,
            raw_temp=28.0,
            raw_humidity=58.0,
            now_epoch=220,
            config=self.config,
            confidence=0.8,
        )

        self.assertNotEqual(vacant.state, FanControlState.VACANT)
        self.assertGreaterEqual(vacant.auto_target_percent, self.config.min_occupied_speed)
        self.assertGreater(vacant.applied_percent, 0)

    def test_empty_room_extreme_heat_gets_high_temperature_matched_fan(self):
        result = evaluate_fan_policy(
            FanPolicyRuntime(last_occupied_epoch=0),
            occupancy_count=0,
            raw_temp=38.0,
            raw_humidity=60.0,
            now_epoch=1000,
            config=self.config,
            confidence=0.9,
        )

        self.assertEqual(result.state, FanControlState.VACANT)
        self.assertEqual(result.auto_target_percent, 84)
        self.assertEqual(result.applied_percent, 84)

    def test_vacant_floor_moves_zero_speed_idle_down_to_eighteen_c(self):
        self.assertEqual(
            vacant_target(
                smoothed_temp=17.0,
                smoothed_humidity=55.0,
                config=self.config,
            ),
            0,
        )
        self.assertGreater(
            vacant_target(
                smoothed_temp=24.0,
                smoothed_humidity=55.0,
                config=self.config,
            ),
            0,
        )
        self.assertEqual(
            vacant_target(
                smoothed_temp=20.0,
                smoothed_humidity=55.0,
                config=self.config,
            ),
            self.config.device_mapping.off_to_low_enter,
        )

    def test_occupied_room_reaches_about_ninety_five_percent_at_forty_c(self):
        target = occupied_target(
            occupancy_count=1,
            smoothed_temp=40.0,
            smoothed_humidity=55.0,
            config=self.config,
        )

        self.assertEqual(target, 95)

    def test_occupied_room_uses_high_setpoint_band_at_thirty_seven_c(self):
        target = occupied_target(
            occupancy_count=1,
            smoothed_temp=37.0,
            smoothed_humidity=55.0,
            config=self.config,
        )

        self.assertEqual(target, 90)

    def test_high_occupancy_room_gets_aggressive_initial_speed(self):
        target = occupied_target(
            occupancy_count=5,
            smoothed_temp=32.0,
            smoothed_humidity=55.0,
            config=self.config,
        )

        self.assertGreaterEqual(target, 80)

    def test_temperature_setpoint_bands_are_monotonic(self):
        config = self.config
        targets = [
            occupied_temp_setpoint_target(temp, config)
            for temp in [23.0, 24.0, 27.0, 29.0, 31.0, 33.0, 35.0, 37.0, 39.0]
        ]

        self.assertEqual(targets, sorted(targets))

    def test_auto_start_from_off_uses_temperature_matched_speed(self):
        result = evaluate_fan_policy(
            FanPolicyRuntime(),
            occupancy_count=1,
            raw_temp=40.0,
            raw_humidity=55.0,
            now_epoch=100,
            config=self.config,
            confidence=0.9,
        )

        self.assertEqual(result.auto_target_percent, 95)
        self.assertEqual(result.applied_percent, 95)
        self.assertEqual(result.device_level, "HIGH")

    def test_cooling_temperature_does_not_increase_applied_speed(self):
        runtime = FanPolicyRuntime()
        for step, temp in enumerate([35.0, 35.0, 35.0, 35.0], start=1):
            result = evaluate_fan_policy(
                runtime,
                occupancy_count=2,
                raw_temp=temp,
                raw_humidity=65.0,
                now_epoch=100 + (step * 2),
                config=self.config,
                confidence=0.85,
            )
            runtime = result.runtime

        applied_before_drop = runtime.applied_percent
        result = evaluate_fan_policy(
            runtime,
            occupancy_count=2,
            raw_temp=29.0,
            raw_humidity=60.0,
            now_epoch=120,
            config=self.config,
            confidence=0.85,
        )

        self.assertLessEqual(result.applied_percent, applied_before_drop)

    def test_device_level_does_not_flap_near_boundaries(self):
        mapping = DeviceMappingConfig(minimum_dwell_sec=45)

        level, changed_at = map_percent_to_level(25, "OFF", 0, 100, mapping)
        self.assertEqual(level, "LOW")

        level, changed_at = map_percent_to_level(41, level, changed_at, 120, mapping)
        self.assertEqual(level, "LOW")

        level, changed_at = map_percent_to_level(41, level, changed_at, 200, mapping)
        self.assertEqual(level, "MEDIUM")

        level, changed_at = map_percent_to_level(31, level, changed_at, 210, mapping)
        self.assertEqual(level, "MEDIUM")

        level, changed_at = map_percent_to_level(29, level, changed_at, 280, mapping)
        self.assertEqual(level, "LOW")

    def test_sensor_released_reclaim_immediately_nudges_upward(self):
        held = apply_manual_intent(
            FanPolicyRuntime(),
            requested_percent=22,
            now_epoch=100,
            config=self.config,
        ).runtime
        released = release_hold_for_sensor_intent(
            held,
            now_epoch=130,
            config=self.config,
        )

        result = evaluate_fan_policy(
            released,
            occupancy_count=1,
            raw_temp=37.0,
            raw_humidity=55.0,
            now_epoch=130,
            config=self.config,
            confidence=0.9,
        )

        self.assertGreater(result.applied_percent, 22)

    def test_manual_anchor_uses_temperature_deltas_instead_of_absolute_setpoint(self):
        runtime = evaluate_fan_policy(
            FanPolicyRuntime(),
            occupancy_count=1,
            raw_temp=30.0,
            raw_humidity=55.0,
            now_epoch=100,
            config=self.config,
            confidence=0.8,
        ).runtime
        held = apply_manual_intent(
            runtime,
            requested_percent=40,
            now_epoch=110,
            config=self.config,
        ).runtime
        released = release_hold_for_sensor_intent(
            held,
            now_epoch=140,
            config=self.config,
        )

        result = evaluate_fan_policy(
            released,
            occupancy_count=1,
            raw_temp=36.0,
            raw_humidity=55.0,
            now_epoch=150,
            config=self.config,
            confidence=0.9,
        )

        self.assertGreater(result.applied_percent, 40)
        self.assertIn("reclaim", result.reason_codes)

    def test_resume_from_off_restores_previous_speed(self):
        runtime = apply_manual_intent(
            FanPolicyRuntime(),
            requested_percent=46,
            now_epoch=100,
            config=self.config,
        ).runtime
        off_runtime = apply_manual_intent(
            runtime,
            requested_percent=0,
            now_epoch=110,
            config=self.config,
        ).runtime

        resumed = resume_from_off(
            off_runtime,
            now_epoch=150,
            config=self.config,
        )

        self.assertEqual(resumed.applied_percent, 46)
        self.assertEqual(resumed.device_level, "MEDIUM")

    def test_manual_anchor_expires_back_to_setpoints(self):
        runtime = evaluate_fan_policy(
            FanPolicyRuntime(),
            occupancy_count=1,
            raw_temp=30.0,
            raw_humidity=55.0,
            now_epoch=100,
            config=self.config,
            confidence=0.8,
        ).runtime
        held = apply_manual_intent(
            runtime,
            requested_percent=40,
            now_epoch=110,
            config=self.config,
        ).runtime

        result = evaluate_fan_policy(
            held,
            occupancy_count=1,
            raw_temp=37.0,
            raw_humidity=55.0,
            now_epoch=400,
            config=self.config,
            confidence=0.9,
        )

        self.assertEqual(result.blended_target_percent, result.auto_target_percent)
        self.assertIsNone(result.runtime.user_anchor_percent)


if __name__ == "__main__":
    unittest.main()
