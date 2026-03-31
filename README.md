# Multi-Agent Power Optimization

Prototype smart-home energy optimization system for households. The project uses a layered pipeline to monitor room-local occupancy and environment data, drive simulated or Raspberry Pi-hosted lights and fans, estimate electricity cost in Indian rupees, and explain automation decisions in a demo-friendly UI.

## Features

- Flask backend with SQLite persistence
- Single-node deployment model for Raspberry Pi hosting
- Layered design: Sensor, Analysis, Decision, Action, and future Voice / LLM integration
- Dashboard for live status, device controls, energy metrics, and AI decisions
- Multi-room smart-home simulation with live light/fan visuals
- Room-local rule logic with transparent explanations
- Room-specific appliance control for lights and fans
- Energy and cost estimation with saving insights
- Automated tests for key scenarios

## Project Structure

- `app.py`: Flask application and API routes
- `database.py`: SQLite schema and persistence helpers
- `decision_engine.py`: Room-local energy rules and insight generation
- `device_controller.py`: Hardware abstraction layer with simulation and Raspberry Pi implementations
- `home_layout.py`: Room config, room mode helpers, and payload shaping
- `docs/architecture.md`: Problem analysis, agent design, and data flow
- `static/`: Dashboard assets
- `tests/test_app.py`: API and decision tests

## Recreate On Another Machine

1. Clone the repository.

```bash
git clone <your-repo-url>
cd multi-agent-power-optimization
```

2. Create and activate a virtual environment.

```bash
python3 -m venv .venv
source .venv/bin/activate
```

3. Install dependencies.

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

4. Configure local settings.

This project intentionally does not commit secrets. Copy the example file and add your own OpenAI key only if you want the OpenAI-backed voice parser.

```bash
cp local_settings.example.json local_settings.json
```

Then edit `local_settings.json`:

```json
{
  "openai_api_key": "YOUR_OPENAI_API_KEY",
  "openai_voice_model": "gpt-5-nano"
}
```

You can also skip `local_settings.json` entirely and use environment variables instead:

```bash
export OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
export OPENAI_VOICE_MODEL="gpt-5-nano"
```

5. Start the app in simulation mode.

```bash
export POWER_OPT_DEVICE_MODE=simulation
python app.py
```

Open `http://127.0.0.1:5000`.

6. Run tests when needed.

```bash
python -m pytest -q
```

## Deployment Model

This project is intentionally designed as a single-node Raspberry Pi application:

- Frontend UI served by Flask from the Raspberry Pi
- Flask API, decision engine, and appliance-control layer in the same application
- Sensors and relay-controlled appliances connected directly to the same Raspberry Pi

There is no separate control microservice, fake Pi server, or message broker in the current design.

## Device Modes

Select the device-controller implementation with `POWER_OPT_DEVICE_MODE`:

- `simulation`: default mode for demos without GPIO hardware
- `raspberry-pi`: uses the Raspberry Pi device controller implementation

Examples:

```bash
POWER_OPT_DEVICE_MODE=simulation python app.py
POWER_OPT_DEVICE_MODE=raspberry-pi python app.py
```

## API Overview

- `GET /api/system-state`: Current room-local sensors, devices, room modes, metrics, insights, and recent decisions
- `POST /api/sensor-reading`: Submit or simulate room-local sensor input
- `POST /api/sensors/read`: Ask the local device controller to read sensor values
- `POST /api/system-mode`: Set global AUTO or MANUAL mode
- `POST /api/room-mode`: Set FOLLOW_GLOBAL, LOCAL_AUTO, or LOCAL_MANUAL for a room
- `POST /api/control/appliance`: Manual light/fan control
- `POST /api/decision/evaluate`: Run the decision engine immediately
- `GET /api/usage/history`: Retrieve recent sensor readings and decision history

## Default Decision Rules

- No motion for a sustained period and no occupancy: turn room lights and fans off
- Low ambient light with occupancy: light preferred rooms such as the living room and study
- Temperature above comfort threshold with occupancy: increase fan speeds by room
- Temperature back in comfort band or no occupancy: turn fans off
- Bright ambient conditions with no room use: prefer room lights off
- High projected cost or extended idle time: emit savings insights

## Testing

```bash
python -m pytest -q
```

## Notes

- `local_settings.json` is ignored by git and should stay local to each machine.
- `.venv/`, `power_optimization.db`, and other local runtime artifacts are ignored.
- Browser speech recognition is used for the current mic UX. The backend voice parser will fall back to a deterministic parser if no OpenAI key is configured.
