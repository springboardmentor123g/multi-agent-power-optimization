import os

from database import (
    get_appliance_states,
    get_latest_room_sensor_readings,
    insert_room_sensor_reading,
    set_appliance_state,
)
from home_layout import DEFAULT_APPLIANCES, ROOMS


VALID_APPLIANCES = set(DEFAULT_APPLIANCES)


class BaseDeviceController:
    mode_name = "base"

    def get_mode(self):
        return self.mode_name

    def read_sensor_values(self, room_id=None):
        raise NotImplementedError

    def submit_sensor_values(self, room_id, reading):
        raise NotImplementedError

    def set_device_state(self, appliance, state, level=None, speed=None, preserve_on_zero=False):
        raise NotImplementedError


class SimulatedDeviceController(BaseDeviceController):
    mode_name = "simulation"

    def read_sensor_values(self, room_id=None):
        readings = get_latest_room_sensor_readings()
        if room_id:
            return {"reading": readings[room_id], "message": f"Read simulated sensors for {room_id}."}
        return {"reading": readings, "message": "Read simulated sensors for every room."}

    def submit_sensor_values(self, room_id, reading):
        insert_room_sensor_reading(room_id, reading)
        return {"reading": get_latest_room_sensor_readings()[room_id], "message": f"Stored simulated sensor values for {room_id}."}

    def set_device_state(self, appliance, state, level=None, speed=None, preserve_on_zero=False):
        validate_device_command(appliance, level)
        set_appliance_state(appliance, state, level, speed=speed, preserve_on_zero=preserve_on_zero)
        device = get_appliance_states()[appliance]
        return {
            "appliance": appliance,
            "state": device["state"],
            "speed": device["speed"],
            "level": device["level"],
            "success": True,
            "message": f"Simulated relay execution succeeded for {appliance}.",
        }


class RpiDeviceController(BaseDeviceController):
    mode_name = "raspberry-pi"

    def __init__(self):
        try:
            import RPi.GPIO as gpio  # type: ignore
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "Raspberry Pi mode requires the RPi.GPIO package and GPIO-capable hardware."
            ) from error
        self.gpio = gpio
        self.pin_map = {
            "living_room_light": 17,
            "living_room_fan": 27,
            "bedroom_light": 5,
            "bedroom_fan": 6,
            "kitchen_light": 13,
            "kitchen_fan": 19,
            "study_light": 20,
            "study_fan": 21,
        }
        self._configure_gpio()

    def _configure_gpio(self):
        self.gpio.setmode(self.gpio.BCM)
        for pin in self.pin_map.values():
            self.gpio.setup(pin, self.gpio.OUT)

    def read_sensor_values(self, room_id=None):
        readings = get_latest_room_sensor_readings()
        if room_id:
            return {"reading": readings[room_id], "message": f"Read GPIO-backed sensors for {room_id}."}
        return {"reading": readings, "message": "Read GPIO-backed sensors for every room."}

    def submit_sensor_values(self, room_id, reading):
        insert_room_sensor_reading(room_id, reading)
        return {"reading": get_latest_room_sensor_readings()[room_id], "message": f"Stored external sensor values for {room_id} while Raspberry Pi mode is active."}

    def set_device_state(self, appliance, state, level=None, speed=None, preserve_on_zero=False):
        validate_device_command(appliance, level)
        pin = self.pin_map[appliance]
        gpio_value = self.gpio.HIGH if state == "ON" else self.gpio.LOW
        self.gpio.output(pin, gpio_value)
        set_appliance_state(appliance, state, level, speed=speed, preserve_on_zero=preserve_on_zero)
        device = get_appliance_states()[appliance]
        return {
            "appliance": appliance,
            "state": device["state"],
            "speed": device["speed"],
            "level": device["level"],
            "success": True,
            "message": f"GPIO relay on pin {pin} set {appliance} to {state}.",
        }


def validate_device_command(appliance, level=None):
    if appliance not in VALID_APPLIANCES:
        raise ValueError(f"Unknown appliance: {appliance}")
    if level is not None and not 0 <= int(level) <= 100:
        raise ValueError(f"Invalid device level: {level}")


def build_device_controller():
    mode = os.environ.get("POWER_OPT_DEVICE_MODE", "simulation").strip().lower()
    if mode in {"simulation", "sim"}:
        return SimulatedDeviceController()
    if mode in {"raspberry-pi", "rpi", "gpio"}:
        return RpiDeviceController()
    raise RuntimeError(f"Unsupported device mode: {mode}")
