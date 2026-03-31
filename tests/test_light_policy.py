import unittest

from control.light_policy import recommended_brightness


class LightPolicyTestCase(unittest.TestCase):
    def test_recommended_brightness_is_zero_without_occupancy(self):
        self.assertEqual(recommended_brightness(0, 10), 0)

    def test_recommended_brightness_changes_continuously_with_ambient_light(self):
        values = [
            recommended_brightness(1, ambient)
            for ambient in [0, 10, 20, 30, 45, 60, 75]
        ]
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertEqual(values[0], 85)
        self.assertEqual(values[-1], 0)
        self.assertEqual(recommended_brightness(1, 50), 29)
        self.assertEqual(recommended_brightness(1, 60), 18)


if __name__ == "__main__":
    unittest.main()
