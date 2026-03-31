import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from home_layout import DEFAULT_APPLIANCES, DEFAULT_ROOM_SENSOR, FAN_SPEED_MULTIPLIERS, ROOMS


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("POWER_OPT_DB_PATH", BASE_DIR / "power_optimization.db"))
DEFAULT_HUMIDITY = 55.0


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS room_sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                ambient_light REAL NOT NULL,
                occupancy_count INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS appliance_states (
                name TEXT PRIMARY KEY,
                room TEXT,
                device_type TEXT,
                display_name TEXT,
                state TEXT NOT NULL,
                speed TEXT NOT NULL DEFAULT 'OFF',
                level INTEGER NOT NULL DEFAULT 0,
                power_watts REAL NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS room_modes (
                room_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS decision_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                agent TEXT NOT NULL,
                appliance TEXT NOT NULL,
                action TEXT NOT NULL,
                reason TEXT NOT NULL,
                source TEXT NOT NULL,
                estimated_power_watts REAL NOT NULL,
                estimated_hourly_cost REAL NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS fan_policy_state (
                room_id TEXT PRIMARY KEY,
                smoothed_temp REAL NOT NULL DEFAULT 29,
                smoothed_humidity REAL NOT NULL DEFAULT 55,
                last_occupied_epoch INTEGER NOT NULL DEFAULT 0,
                hold_until_epoch INTEGER NOT NULL DEFAULT 0,
                reclaim_end_epoch INTEGER NOT NULL DEFAULT 0,
                last_manual_intent_epoch INTEGER NOT NULL DEFAULT 0,
                user_anchor_temp REAL NOT NULL DEFAULT 29,
                user_anchor_percent INTEGER,
                resume_percent INTEGER NOT NULL DEFAULT 0,
                last_user_preference_percent INTEGER,
                applied_percent INTEGER NOT NULL DEFAULT 0,
                auto_target_percent INTEGER NOT NULL DEFAULT 0,
                blended_target_percent INTEGER NOT NULL DEFAULT 0,
                device_level TEXT NOT NULL DEFAULT 'OFF',
                last_device_change_epoch INTEGER NOT NULL DEFAULT 0,
                phase TEXT NOT NULL DEFAULT 'vacant',
                last_reason TEXT NOT NULL DEFAULT 'Initialized.',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS light_policy_state (
                room_id TEXT PRIMARY KEY,
                hold_until_epoch INTEGER NOT NULL DEFAULT 0,
                user_brightness INTEGER,
                phase TEXT NOT NULL DEFAULT 'assist',
                last_reason TEXT NOT NULL DEFAULT 'Initialized.',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS runtime_meter_state (
                meter_key TEXT PRIMARY KEY,
                room_id TEXT,
                current_power_tokens REAL NOT NULL DEFAULT 0,
                current_rate_tokens REAL NOT NULL DEFAULT 0,
                session_tokens REAL NOT NULL DEFAULT 0,
                billing_tokens REAL NOT NULL DEFAULT 0,
                last_tick_epoch REAL NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        ensure_appliance_state_columns(connection)
        ensure_decision_log_columns(connection)
        ensure_fan_policy_columns(connection)
        ensure_light_policy_columns(connection)
        for name, appliance in DEFAULT_APPLIANCES.items():
            connection.execute(
                """
                INSERT INTO appliance_states (
                    name, room, device_type, display_name, state, speed, level, power_watts
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    room = excluded.room,
                    device_type = excluded.device_type,
                    display_name = excluded.display_name,
                    power_watts = excluded.power_watts
                """,
                (
                    name,
                    appliance["room"],
                    appliance["device_type"],
                    appliance["display_name"],
                    appliance["state"],
                    appliance["speed"],
                    appliance["level"],
                    appliance["power_watts"],
                ),
                )
        for room_id in ROOMS:
            connection.execute(
                """
                INSERT INTO room_modes (room_id, mode)
                VALUES (?, 'FOLLOW_GLOBAL')
                ON CONFLICT(room_id) DO NOTHING
                """,
                (room_id,),
            )
            latest = connection.execute(
                """
                SELECT 1
                FROM room_sensor_readings
                WHERE room_id = ?
                LIMIT 1
                """,
                (room_id,),
            ).fetchone()
            if not latest:
                connection.execute(
                    """
                    INSERT INTO room_sensor_readings (
                        room_id, temperature, humidity, ambient_light, occupancy_count
                    )
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        room_id,
                        DEFAULT_ROOM_SENSOR["temperature"],
                        DEFAULT_HUMIDITY,
                        DEFAULT_ROOM_SENSOR["ambient_light"],
                        DEFAULT_ROOM_SENSOR["occupancy_count"],
                    ),
                )
            connection.execute(
                """
                INSERT INTO fan_policy_state (
                    room_id, smoothed_temp, smoothed_humidity, phase
                )
                VALUES (?, ?, ?, 'vacant')
                ON CONFLICT(room_id) DO NOTHING
                """,
                (
                    room_id,
                    DEFAULT_ROOM_SENSOR["temperature"],
                    DEFAULT_HUMIDITY,
                ),
            )
            connection.execute(
                """
                INSERT INTO light_policy_state (
                    room_id, phase
                )
                VALUES (?, 'assist')
                ON CONFLICT(room_id) DO NOTHING
                """,
                (room_id,),
            )
            connection.execute(
                """
                INSERT INTO runtime_meter_state (
                    meter_key, room_id
                )
                VALUES (?, ?)
                ON CONFLICT(meter_key) DO NOTHING
                """,
                (room_id, room_id),
            )
        connection.execute(
            """
            INSERT INTO system_settings (key, value)
            VALUES ('global_mode', 'AUTO')
            ON CONFLICT(key) DO NOTHING
            """
        )
        connection.execute(
            """
            INSERT INTO runtime_meter_state (
                meter_key, room_id
            )
            VALUES ('system', NULL)
            ON CONFLICT(meter_key) DO NOTHING
            """
        )
        connection.commit()


def ensure_appliance_state_columns(connection):
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(appliance_states)").fetchall()
    }
    if "room" not in columns:
        connection.execute("ALTER TABLE appliance_states ADD COLUMN room TEXT")
    if "device_type" not in columns:
        connection.execute("ALTER TABLE appliance_states ADD COLUMN device_type TEXT")
    if "display_name" not in columns:
        connection.execute("ALTER TABLE appliance_states ADD COLUMN display_name TEXT")
    if "speed" not in columns:
        connection.execute("ALTER TABLE appliance_states ADD COLUMN speed TEXT NOT NULL DEFAULT 'OFF'")
    if "level" not in columns:
        connection.execute("ALTER TABLE appliance_states ADD COLUMN level INTEGER NOT NULL DEFAULT 0")


def ensure_decision_log_columns(connection):
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(decision_logs)").fetchall()
    }
    if "room_id" not in columns:
        connection.execute("ALTER TABLE decision_logs ADD COLUMN room_id TEXT DEFAULT 'system'")


def ensure_fan_policy_columns(connection):
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(fan_policy_state)").fetchall()
    }
    if not columns:
        return
    expected_columns = {
        "smoothed_temp": "ALTER TABLE fan_policy_state ADD COLUMN smoothed_temp REAL NOT NULL DEFAULT 29",
        "smoothed_humidity": "ALTER TABLE fan_policy_state ADD COLUMN smoothed_humidity REAL NOT NULL DEFAULT 55",
        "last_occupied_epoch": "ALTER TABLE fan_policy_state ADD COLUMN last_occupied_epoch INTEGER NOT NULL DEFAULT 0",
        "hold_until_epoch": "ALTER TABLE fan_policy_state ADD COLUMN hold_until_epoch INTEGER NOT NULL DEFAULT 0",
        "reclaim_end_epoch": "ALTER TABLE fan_policy_state ADD COLUMN reclaim_end_epoch INTEGER NOT NULL DEFAULT 0",
        "last_manual_intent_epoch": "ALTER TABLE fan_policy_state ADD COLUMN last_manual_intent_epoch INTEGER NOT NULL DEFAULT 0",
        "user_anchor_temp": "ALTER TABLE fan_policy_state ADD COLUMN user_anchor_temp REAL NOT NULL DEFAULT 29",
        "user_anchor_percent": "ALTER TABLE fan_policy_state ADD COLUMN user_anchor_percent INTEGER",
        "resume_percent": "ALTER TABLE fan_policy_state ADD COLUMN resume_percent INTEGER NOT NULL DEFAULT 0",
        "last_user_preference_percent": "ALTER TABLE fan_policy_state ADD COLUMN last_user_preference_percent INTEGER",
        "applied_percent": "ALTER TABLE fan_policy_state ADD COLUMN applied_percent INTEGER NOT NULL DEFAULT 0",
        "auto_target_percent": "ALTER TABLE fan_policy_state ADD COLUMN auto_target_percent INTEGER NOT NULL DEFAULT 0",
        "blended_target_percent": "ALTER TABLE fan_policy_state ADD COLUMN blended_target_percent INTEGER NOT NULL DEFAULT 0",
        "device_level": "ALTER TABLE fan_policy_state ADD COLUMN device_level TEXT NOT NULL DEFAULT 'OFF'",
        "last_device_change_epoch": "ALTER TABLE fan_policy_state ADD COLUMN last_device_change_epoch INTEGER NOT NULL DEFAULT 0",
        "phase": "ALTER TABLE fan_policy_state ADD COLUMN phase TEXT NOT NULL DEFAULT 'vacant'",
        "last_reason": "ALTER TABLE fan_policy_state ADD COLUMN last_reason TEXT NOT NULL DEFAULT 'Initialized.'",
    }
    for column, statement in expected_columns.items():
        if column not in columns:
            connection.execute(statement)


def ensure_light_policy_columns(connection):
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(light_policy_state)").fetchall()
    }
    if not columns:
        return
    expected_columns = {
        "hold_until_epoch": "ALTER TABLE light_policy_state ADD COLUMN hold_until_epoch INTEGER NOT NULL DEFAULT 0",
        "user_brightness": "ALTER TABLE light_policy_state ADD COLUMN user_brightness INTEGER",
        "phase": "ALTER TABLE light_policy_state ADD COLUMN phase TEXT NOT NULL DEFAULT 'assist'",
        "last_reason": "ALTER TABLE light_policy_state ADD COLUMN last_reason TEXT NOT NULL DEFAULT 'Initialized.'",
    }
    for column, statement in expected_columns.items():
        if column not in columns:
            connection.execute(statement)


def insert_room_sensor_reading(room_id, reading):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO room_sensor_readings (
                room_id, temperature, humidity, ambient_light, occupancy_count
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                room_id,
                float(reading["temperature"]),
                float(reading["humidity"]),
                float(reading["ambient_light"]),
                int(reading["occupancy_count"]),
            ),
        )
        connection.commit()


def get_latest_room_sensor_readings():
    sensors = {}
    with get_connection() as connection:
        for room_id in ROOMS:
            row = connection.execute(
                """
                SELECT room_id, temperature, humidity, ambient_light, occupancy_count, created_at
                FROM room_sensor_readings
                WHERE room_id = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (room_id,),
            ).fetchone()
            sensors[room_id] = dict(row) if row else {"room_id": room_id, **DEFAULT_ROOM_SENSOR}
    return sensors


def get_recent_room_sensor_readings(limit=40):
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT room_id, temperature, humidity, ambient_light, occupancy_count, created_at
            FROM room_sensor_readings
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_appliance_states():
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT name, room, device_type, display_name, state, speed, level, power_watts, updated_at
            FROM appliance_states
            ORDER BY name ASC
            """
        ).fetchall()
    return {row["name"]: dict(row) for row in rows if row["name"] in DEFAULT_APPLIANCES}


def get_fan_policy_states():
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT room_id, smoothed_temp, smoothed_humidity, last_occupied_epoch,
                   hold_until_epoch, reclaim_end_epoch, last_manual_intent_epoch, user_anchor_temp, user_anchor_percent,
                   resume_percent,
                   last_user_preference_percent, applied_percent, auto_target_percent,
                   blended_target_percent, device_level, last_device_change_epoch,
                   phase, last_reason
            FROM fan_policy_state
            ORDER BY room_id ASC
            """
        ).fetchall()
    return {row["room_id"]: dict(row) for row in rows}


def get_light_policy_states():
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT room_id, hold_until_epoch, user_brightness, phase, last_reason
            FROM light_policy_state
            ORDER BY room_id ASC
            """
        ).fetchall()
    return {row["room_id"]: dict(row) for row in rows}


def save_fan_policy_state(room_id, state):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO fan_policy_state (
                room_id, smoothed_temp, smoothed_humidity, last_occupied_epoch,
                hold_until_epoch, reclaim_end_epoch, last_manual_intent_epoch, user_anchor_temp, user_anchor_percent,
                resume_percent,
                last_user_preference_percent, applied_percent, auto_target_percent,
                blended_target_percent, device_level, last_device_change_epoch,
                phase, last_reason, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(room_id) DO UPDATE SET
                smoothed_temp = excluded.smoothed_temp,
                smoothed_humidity = excluded.smoothed_humidity,
                last_occupied_epoch = excluded.last_occupied_epoch,
                hold_until_epoch = excluded.hold_until_epoch,
                reclaim_end_epoch = excluded.reclaim_end_epoch,
                last_manual_intent_epoch = excluded.last_manual_intent_epoch,
                user_anchor_temp = excluded.user_anchor_temp,
                user_anchor_percent = excluded.user_anchor_percent,
                resume_percent = excluded.resume_percent,
                last_user_preference_percent = excluded.last_user_preference_percent,
                applied_percent = excluded.applied_percent,
                auto_target_percent = excluded.auto_target_percent,
                blended_target_percent = excluded.blended_target_percent,
                device_level = excluded.device_level,
                last_device_change_epoch = excluded.last_device_change_epoch,
                phase = excluded.phase,
                last_reason = excluded.last_reason,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                room_id,
                float(state["smoothed_temp"]),
                float(state["smoothed_humidity"]),
                int(state["last_occupied_epoch"]),
                int(state["hold_until_epoch"]),
                int(state["reclaim_end_epoch"]),
                int(state["last_manual_intent_epoch"]),
                float(state["user_anchor_temp"]),
                state["user_anchor_percent"],
                int(state["resume_percent"]),
                state["last_user_preference_percent"],
                int(state["applied_percent"]),
                int(state["auto_target_percent"]),
                int(state["blended_target_percent"]),
                state["device_level"],
                int(state["last_device_change_epoch"]),
                state["phase"],
                state["last_reason"],
            ),
        )
        connection.commit()


def save_light_policy_state(room_id, state):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO light_policy_state (
                room_id, hold_until_epoch, user_brightness, phase, last_reason, updated_at
            )
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(room_id) DO UPDATE SET
                hold_until_epoch = excluded.hold_until_epoch,
                user_brightness = excluded.user_brightness,
                phase = excluded.phase,
                last_reason = excluded.last_reason,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                room_id,
                int(state["hold_until_epoch"]),
                state["user_brightness"],
                state["phase"],
                state["last_reason"],
            ),
        )
        connection.commit()


def set_appliance_state(name, state, level=None, speed=None, preserve_on_zero=False):
    current = get_appliance_states()[name]
    if current["device_type"] == "fan":
        effective_state, effective_speed, effective_level = normalize_fan_state(
            state,
            level,
            speed=speed,
            preserve_on_zero=preserve_on_zero,
        )
    else:
        effective_state, effective_speed, effective_level = normalize_light_state(
            state,
            level,
            preserve_on_zero=preserve_on_zero,
        )
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE appliance_states
            SET state = ?, speed = ?, level = ?, updated_at = CURRENT_TIMESTAMP
            WHERE name = ?
            """,
            (effective_state, effective_speed, effective_level, name),
        )
        connection.commit()


def estimate_device_power(device):
    if device["device_type"] == "fan":
        return round(device["power_watts"] * (int(device["level"]) / 100), 2)
    return round(device["power_watts"] * (int(device["level"]) / 100), 2)


def get_global_mode():
    with get_connection() as connection:
        row = connection.execute(
            "SELECT value FROM system_settings WHERE key = 'global_mode'"
        ).fetchone()
    return row["value"] if row else "AUTO"


def set_global_mode(mode):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('global_mode', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            """,
            (mode,),
        )
        connection.commit()


def get_room_modes():
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT room_id, mode FROM room_modes ORDER BY room_id ASC"
        ).fetchall()
    modes = {row["room_id"]: row["mode"] for row in rows}
    for room_id in ROOMS:
        modes.setdefault(room_id, "FOLLOW_GLOBAL")
    return modes


def set_room_mode(room_id, mode):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO room_modes (room_id, mode, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(room_id) DO UPDATE SET
                mode = excluded.mode,
                updated_at = CURRENT_TIMESTAMP
            """,
            (room_id, mode),
        )
        connection.commit()


def reset_room_modes(mode="FOLLOW_GLOBAL"):
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE room_modes
            SET mode = ?, updated_at = CURRENT_TIMESTAMP
            """,
            (mode,),
        )
        connection.commit()


def log_decision(entry):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO decision_logs (
                room_id, agent, appliance, action, reason, source,
                estimated_power_watts, estimated_hourly_cost
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry["room_id"],
                entry["agent"],
                entry["appliance"],
                entry["action"],
                entry["reason"],
                entry["source"],
                float(entry["estimated_power_watts"]),
                float(entry["estimated_hourly_cost"]),
            ),
        )
        connection.commit()


def get_recent_decision_logs(limit=20):
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, room_id, agent, appliance, action, reason, source,
                   estimated_power_watts, estimated_hourly_cost, created_at
            FROM decision_logs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_runtime_meter_states():
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT meter_key, room_id, current_power_tokens, current_rate_tokens,
                   session_tokens, billing_tokens, last_tick_epoch, updated_at
            FROM runtime_meter_state
            ORDER BY meter_key ASC
            """
        ).fetchall()
    return {row["meter_key"]: dict(row) for row in rows}


def update_runtime_meter_state(meter_key, *, room_id, current_power_tokens, current_rate_tokens, session_tokens, billing_tokens, now_epoch):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO runtime_meter_state (
                meter_key, room_id, current_power_tokens, current_rate_tokens,
                session_tokens, billing_tokens, last_tick_epoch, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(meter_key) DO UPDATE SET
                room_id = excluded.room_id,
                current_power_tokens = excluded.current_power_tokens,
                current_rate_tokens = excluded.current_rate_tokens,
                session_tokens = excluded.session_tokens,
                billing_tokens = excluded.billing_tokens,
                last_tick_epoch = excluded.last_tick_epoch,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                meter_key,
                room_id,
                float(current_power_tokens),
                float(current_rate_tokens),
                float(session_tokens),
                float(billing_tokens),
                float(now_epoch),
            ),
        )
        connection.commit()


def build_recent_activity_summary(limit=4):
    logs = get_recent_decision_logs(limit=limit)
    if not logs:
        return "No recent automated adjustments."
    return f"{len(logs)} recent automated adjustments"


def compute_runtime_hours(updated_at):
    if not updated_at:
        return 0.0
    current = datetime.now(timezone.utc)
    started = datetime.strptime(updated_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    return max(0.0, (current - started).total_seconds() / 3600)


def normalize_fan_state(state, level=None, speed=None, preserve_on_zero=False):
    level = 0 if state == "OFF" and level is None else int(level if level is not None else 55)
    level = max(0, min(100, level))
    if level == 0 and preserve_on_zero:
        return "ON", "OFF", 0
    if state == "OFF" or level == 0:
        return "OFF", "OFF", 0
    if speed in {"LOW", "MEDIUM", "HIGH"}:
        return "ON", speed, level
    if level <= 30:
        return "ON", "LOW", level
    if level <= 70:
        return "ON", "MEDIUM", level
    return "ON", "HIGH", level


def normalize_light_state(state, level=None, preserve_on_zero=False):
    level = 0 if state == "OFF" and level is None else int(level if level is not None else 85)
    level = max(0, min(100, level))
    if level == 0 and preserve_on_zero:
        return "ON", "OFF", 0
    if state == "OFF" or level == 0:
        return "OFF", "OFF", 0
    return "ON", "ON", level
