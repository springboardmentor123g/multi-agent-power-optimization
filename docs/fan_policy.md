## Fan Policy

### Module Structure

- `control/fan_policy.py`
  - state model
  - EMA smoothing
  - occupied/vacant target curves
  - HOLD/RECLAIM/ASSIST/VACANT/LOCKED transitions
  - bounded applied-speed movement
  - observability payload
- `control/device_mapping.py`
  - percent-to-device-level mapping
  - hysteresis bands
  - minimum dwell handling
- `decision_engine.py`
  - orchestration only
  - light recommendation
  - room policy calls
  - action list assembly

### State Table

| State | Meaning | Exit Condition |
| --- | --- | --- |
| `HOLD` | Recent manual fan change is being respected. | Hold timer expires or safety override. |
| `RECLAIM` | Automation is gradually blending back from the user anchor to the auto target. | Reclaim duration completes or a new manual change restarts HOLD. |
| `ASSIST` | Normal occupied or grace-period automatic assistance. | Vacancy grace expires, a manual change starts HOLD, or a safety override triggers LOCKED. |
| `VACANT` | Room is vacant beyond grace. Only mild background cooling is allowed. | Occupancy returns or a manual change starts HOLD. |
| `LOCKED` | Extreme-condition safety correction. | Conditions fall out of the extreme range on the next cycle. |

### Control Loop Pseudocode

```text
read current sensors
smooth temperature and humidity with EMA
update last_occupied_epoch when occupancy_count > 0

if extreme condition:
    state = LOCKED
    auto target = max(user anchor, safety target)
    applied = move_toward(applied, auto target, extreme step limits)
elif hold active:
    state = HOLD
    target = user_anchor_speed
    applied = user_anchor_speed
elif reclaim active:
    state = RECLAIM
    progress = elapsed reclaim time / reclaim duration
    if confidence is low:
        progress *= low_confidence_scale
    target = blend(user anchor, auto target, progress)
    applied = move_toward(applied, target, auto step limits)
else:
    state = ASSIST or VACANT
    auto target = occupied curve or vacant curve
    if confidence is low:
        target = blend(last user preference, auto target, low-confidence factor)
    else:
        target = auto target
    if fan is currently off and target > 0:
        target = hybrid startup target
        applied = startup floor
    else:
        applied = move_toward(applied, target, auto step limits)

map applied percent into OFF/LOW/MEDIUM/HIGH with hysteresis + dwell
persist runtime for the next control cycle
```

### Algorithm Summary

Occupied rooms use a continuous target curve:

```text
target =
  clamp(
    min_occupied_speed
    + temp_gain * max(0, smoothed_temp - comfort_temp)
    + hot_gain * max(0, smoothed_temp - hot_temp)
    + humidity_gain * max(0, smoothed_humidity - comfort_humidity)
    + occupancy_gain * max(0, occupancy_count - 1),
    min_occupied_speed,
    100
  )
```

Vacant rooms use a separate mild background curve with a lower cap:

```text
target =
  clamp(
    max(
      empty_temp_gain * max(0, smoothed_temp - empty_temp_start),
      empty_humidity_gain * max(0, smoothed_humidity - empty_humidity_start)
    ),
    0,
    empty_max_speed
  )
```

The controller never jumps directly to the target. It keeps both:

- `target_percent`
- `applied_percent`

`applied_percent` moves toward `target_percent` with bounded steps, so the fan never appears to fight the user or snap between presets.

### Why This UX Is Better Than Auto/Manual

Explicit Auto/Manual toggles force users to think about system mode instead of comfort. This policy behaves closer to a real smart device:

- user input gets immediate priority
- the system waits before reclaiming
- reclaim is gradual and explainable
- occupied rooms avoid abrupt shutoff
- empty rooms still save energy
- extreme conditions can still trigger safety-oriented correction
