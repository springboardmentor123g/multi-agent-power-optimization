import unittest

from voice.room_voice_assistant import fallback_start


class RoomVoiceAssistantTestCase(unittest.TestCase):
    def test_fallback_start_sounds_natural_and_asks_one_question(self):
        response = fallback_start(
            {
                "name": "Bedroom",
                "sensors": {
                    "temperature": 31,
                    "ambient_light": 24,
                    "occupancy_count": 2,
                },
                "devices": {
                    "fan": {"speed_percent": 42},
                    "light": {"brightness": 30},
                },
                "resolved_mode": "AUTO",
            }
        )

        self.assertEqual(response["message_type"], "question")
        self.assertIn("Would you like", response["spoken_text"])
        self.assertEqual(response["spoken_text"].count("?"), 1)
        self.assertNotIn("Hello sir", response["spoken_text"])


if __name__ == "__main__":
    unittest.main()
