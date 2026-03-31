import unittest

from voice.command_executor import build_execution_plan
from voice.command_parser import VoiceCommandParser


class VoiceCommandParserTestCase(unittest.TestCase):
    def setUp(self):
        self.parser = VoiceCommandParser(api_key="")

    def test_room_local_fallback_parses_absolute_fan_speed(self):
        command = self.parser.parse("Set the fan speed to 64 percent", "bedroom")

        self.assertEqual(command["intent"], "set_fan_speed")
        self.assertEqual(command["room_id"], "bedroom")
        self.assertEqual(command["device"], "fan")
        self.assertEqual(command["value_percent"], 64)

    def test_room_local_fallback_treats_reduce_to_as_absolute(self):
        command = self.parser.parse("Reduce the fan to 30 percent", "bedroom")

        self.assertEqual(command["intent"], "set_fan_speed")
        self.assertEqual(command["room_id"], "bedroom")
        self.assertEqual(command["device"], "fan")
        self.assertEqual(command["value_percent"], 30)

    def test_room_local_fallback_treats_reduce_by_as_relative(self):
        command = self.parser.parse("Reduce the fan by 15 percent", "bedroom")

        self.assertEqual(command["intent"], "decrease_fan_speed")
        self.assertEqual(command["room_id"], "bedroom")
        self.assertEqual(command["device"], "fan")
        self.assertEqual(command["value_percent"], 15)

    def test_room_local_fallback_rejects_cross_room_requests(self):
        command = self.parser.parse("Turn on the kitchen light", "bedroom")

        self.assertEqual(command["intent"], "reject")
        self.assertEqual(command["room_id"], "bedroom")

    def test_execution_plan_scopes_turn_fan_on_to_same_room(self):
        command = self.parser.parse("Turn on the fan", "study")
        room_snapshot = {
            "devices": {
                "fan": {"speed_percent": 0, "policy": {"auto_target_percent": 72}},
                "light": {"brightness": 0},
            }
        }

        plan = build_execution_plan(command, room_snapshot)

        self.assertEqual(plan["kind"], "device")
        self.assertEqual(plan["appliance"], "study_fan")
        self.assertEqual(plan["level"], 72)
        self.assertTrue(plan["resume"])


if __name__ == "__main__":
    unittest.main()
