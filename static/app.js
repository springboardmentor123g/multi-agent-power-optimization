const roomElements = new Map();
const sensorSyncTimers = new Map();
const deviceSyncTimers = new Map();
const sliderAnimations = new Map();
const metricAnimations = new Map();
const roomVoiceFeedback = new Map();
const roomVoiceDebug = new Map();
const latestRooms = new Map();
let latestSnapshotRequestId = 0;
let latestAppliedSnapshotId = 0;
let activeRecognition = null;
let activeListeningRoomId = null;
let latestSnapshot = null;
let dashboardRange = "today";
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function voiceLog(event, payload = {}) {
  console.log(`[smart-home][voice] ${event}`, payload);
}

function voiceError(event, payload = {}) {
  console.error(`[smart-home][voice] ${event}`, payload);
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed for ${url}`);
  }
  return payload;
}

async function requestSnapshot(url, options = {}) {
  const requestId = ++latestSnapshotRequestId;
  const snapshot = await fetchJSON(url, options);
  if (requestId < latestAppliedSnapshotId) {
    return null;
  }
  latestAppliedSnapshotId = requestId;
  return snapshot;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  document.getElementById("tariffValue").textContent = `₹${snapshot.tariff_inr_per_kwh.toFixed(2)} / kWh`;
  document.getElementById("deviceMode").textContent = `Mode: ${snapshot.device_mode} · ${snapshot.deployment_model}`;
  renderGlobalMetrics(snapshot.metrics);

  document.getElementById("analysisStatus").innerHTML = [
    statusRow("Temperature", snapshot.metrics.temperature_status),
    statusRow("Occupied rooms", countOccupiedRooms(snapshot.rooms)),
    statusRow("Recent activity", snapshot.activity_summary),
  ].join("");

  document.getElementById("insightsList").innerHTML = snapshot.insights
    .map((insight) => `<li>${insight}</li>`)
    .join("");

  document.getElementById("activitySummary").textContent = snapshot.activity_summary;
  document.getElementById("decisionLog").innerHTML = snapshot.recent_decisions.length
    ? snapshot.recent_decisions
        .map(
          (entry) => `
            <div class="log-item">
              <small>${entry.created_at} · ${entry.room_id} · ${entry.source}</small>
              <strong>${entry.appliance} → ${entry.action}</strong>
              <div>${entry.reason}</div>
            </div>
          `
        )
        .join("")
    : `<div class="log-item"><strong>No decision logs yet.</strong></div>`;

  document.getElementById("deviceMessage").textContent =
    snapshot.device_message || "Simulation mode active. Room-local state synced.";

  renderRooms(snapshot.rooms);
  renderDashboard(snapshot.dashboard);
}

function renderGlobalMetrics(metrics) {
  animateMetricValue(document.getElementById("activePower"), Number(metrics.active_power_watts), { suffix: " W", decimals: 0 });
  animateMetricValue(document.getElementById("hourlyCost"), Number(metrics.hourly_cost_inr), { prefix: "₹", decimals: 2 });
  animateMetricValue(document.getElementById("sessionCost"), Number(metrics.session_cost_inr), { prefix: "₹", decimals: 2 });
  animateMetricValue(document.getElementById("dailyCost"), Number(metrics.daily_cost_projection_inr), { prefix: "₹", decimals: 2 });
}

function statusRow(label, value) {
  return `
    <div class="status-item">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function countOccupiedRooms(rooms) {
  return Object.values(rooms).filter((room) => Number(room.sensors.occupancy_count) > 0).length;
}

function renderRooms(rooms) {
  const container = document.getElementById("houseGrid");
  Object.values(rooms).forEach((room) => {
    latestRooms.set(room.id, room);
    if (!roomElements.has(room.id)) {
      const card = buildRoomCard(room);
      roomElements.set(room.id, card);
      container.append(card.root);
    }
    updateRoomCard(roomElements.get(room.id), room);
  });
}

function buildRoomCard(room) {
  const root = document.createElement("article");
  root.className = "room-card";
  root.dataset.roomId = room.id;
  root.innerHTML = `
    <div class="room-header">
      <div class="room-title">
        <h3 class="room-name" id="room-name-${room.id}"></h3>
      </div>
      <div class="room-actions">
        <span class="room-badge" id="room-badge-${room.id}"></span>
        <button class="mic-button" type="button" data-room-id="${room.id}" data-voice-kind="mic" id="voice-mic-${room.id}" aria-label="Speak a command for ${room.name}">Mic</button>
        <details class="sensor-popover" id="sensor-popover-${room.id}">
          <summary class="sensor-chip">Sensors</summary>
          <div class="sensor-flyout sensor-panel compact">
            ${sensorSlider(room.id, "temperature", "Temp", 16, 40, "°C")}
            ${sensorSlider(room.id, "ambient_light", "Light", 0, 100, "%")}
            <div class="stepper-field">
              <div class="slider-head">
                <span>Occupancy</span>
                <strong id="sensor-value-${room.id}-occupancy_count">0 persons</strong>
              </div>
              <div class="occupancy-stepper">
                <button type="button" class="stepper-button" data-room-id="${room.id}" data-occupancy-step="-1">-</button>
                <span class="stepper-value" id="occupancy-stepper-${room.id}">0</span>
                <button type="button" class="stepper-button" data-room-id="${room.id}" data-occupancy-step="1">+</button>
              </div>
            </div>
          </div>
        </details>
      </div>
    </div>
    <div class="room-stage" id="room-stage-${room.id}">
      <div class="scene-haze"></div>
      <div class="light-pool"></div>
      <div class="scene-decor" id="scene-decor-${room.id}"></div>
      <div class="fan" id="fan-wrap-${room.id}">
        <div class="fan-rotor" id="fan-rotor-${room.id}">
          <span class="fan-blade"></span>
          <span class="fan-blade"></span>
          <span class="fan-blade"></span>
        </div>
        <span class="fan-hub"></span>
      </div>
    </div>
    <div class="room-footer">
      <div class="room-inline-metrics">
        <span class="metric-pill"><strong id="room-power-${room.id}">0 W</strong></span>
        <span class="metric-pill"><strong id="room-cost-${room.id}">₹0.00</strong></span>
        <span class="metric-pill"><strong id="occupancy-label-${room.id}">Absent</strong></span>
      </div>
      <div class="voice-note" id="voice-status-${room.id}">Voice idle.</div>
      <details class="room-drawer voice-drawer">
        <summary>Voice debug</summary>
        <pre class="voice-debug-log" id="voice-debug-${room.id}">No voice activity yet.</pre>
      </details>
      <div class="control-deck">
        <div class="hud-module">
          <div class="hud-meta">
            <span>Light</span>
            <strong id="light-status-${room.id}"></strong>
          </div>
          <div class="hud-control">
            ${deviceSlider(room.id, room.devices.light.id, "light", "brightness", "", "%")}
            <button class="toggle" type="button" data-room-id="${room.id}" data-device-id="${room.devices.light.id}" data-device-kind="light-toggle" id="light-toggle-${room.id}"></button>
          </div>
        </div>
        <div class="hud-module">
          <div class="hud-meta">
            <span>Fan</span>
            <strong id="fan-status-${room.id}"></strong>
          </div>
          <div class="hud-control">
            ${deviceSlider(room.id, room.devices.fan.id, "fan", "speed_percent", "", "%")}
            <button class="toggle" type="button" data-room-id="${room.id}" data-device-id="${room.devices.fan.id}" data-device-kind="fan-toggle" id="fan-toggle-${room.id}"></button>
          </div>
        </div>
      </div>
    </div>
  `;

  const stage = root.querySelector(`#room-stage-${room.id}`);
  room.layout.leds.forEach((led, index) => {
    const ledNode = document.createElement("span");
    ledNode.className = "room-led";
    ledNode.id = `room-led-${room.id}-${index}`;
    ledNode.style.left = led.x;
    ledNode.style.top = led.y;
    stage.append(ledNode);
  });
  root.querySelector(`#scene-decor-${room.id}`).innerHTML = buildSceneDecor(room.id);

  return {
    root,
    name: root.querySelector(`#room-name-${room.id}`),
    badge: root.querySelector(`#room-badge-${room.id}`),
    voiceStatus: root.querySelector(`#voice-status-${room.id}`),
    voiceDebug: root.querySelector(`#voice-debug-${room.id}`),
    sensorPopover: root.querySelector(`#sensor-popover-${room.id}`),
    micButton: root.querySelector(`#voice-mic-${room.id}`),
    fanRotor: root.querySelector(`#fan-rotor-${room.id}`),
    lightStatus: root.querySelector(`#light-status-${room.id}`),
    fanStatus: root.querySelector(`#fan-status-${room.id}`),
    lightToggle: root.querySelector(`#light-toggle-${room.id}`),
    fanToggle: root.querySelector(`#fan-toggle-${room.id}`),
    occupancyLabel: root.querySelector(`#occupancy-label-${room.id}`),
    roomPower: root.querySelector(`#room-power-${room.id}`),
    roomCost: root.querySelector(`#room-cost-${room.id}`),
    leds: [...root.querySelectorAll(`[id^="room-led-${room.id}-"]`)],
  };
}

function sensorSlider(roomId, key, label, min, max, suffix) {
  return `
    <label class="slider-field">
      <div class="slider-head">
        <span>${label}</span>
        <strong id="sensor-value-${roomId}-${key}">0${suffix}</strong>
      </div>
      <input type="range" min="${min}" max="${max}" value="${min}" data-room-id="${roomId}" data-sensor-key="${key}" data-sensor-suffix="${suffix}" />
    </label>
  `;
}

function deviceSlider(roomId, deviceId, kind, key, label, suffix) {
  return `
    <label class="slider-field hud-slider">
      <div class="slider-head">
        <span>${label}</span>
        <strong id="device-value-${roomId}-${kind}">0${suffix}</strong>
      </div>
      <input type="range" min="0" max="100" value="0" data-room-id="${roomId}" data-device-id="${deviceId}" data-device-kind="${kind}" data-device-key="${key}" data-device-suffix="${suffix}" />
    </label>
  `;
}

function updateRoomCard(card, room) {
  latestRooms.set(room.id, room);
  const light = room.devices.light;
  const fan = room.devices.fan;
  const sensors = room.sensors;
  const lightOn = light.state === "ON";
  const glow = hexToRgba(light.color, Math.max(0.16, light.brightness / 100));
  const glowSoft = hexToRgba(light.color, Math.max(0.1, light.brightness / 260));
  const fanOn = Number(fan.speed_percent) > 0;
  const fanSwitchOn = fan.state === "ON";
  const fanPolicy = fan.policy || {};
  const fanModeLabel = formatPolicyState(fanPolicy.state);
  const voiceFeedback = roomVoiceFeedback.get(room.id) || "Tap mic and speak for this room.";
  const voiceDebug = roomVoiceDebug.get(room.id) || "No voice activity yet.";

  card.name.textContent = room.name;
  card.badge.textContent = lightOn || fanSwitchOn ? "Live" : "Idle";
  card.voiceStatus.textContent = voiceFeedback;
  card.voiceDebug.textContent = voiceDebug;
  card.micButton.classList.toggle("listening", activeListeningRoomId === room.id);
  card.micButton.disabled = !SpeechRecognition;
  card.micButton.textContent = activeListeningRoomId === room.id ? "Listening" : "Mic";
  card.root.classList.toggle("light-on", lightOn);
  card.root.style.setProperty("--light-color", light.color);
  card.root.style.setProperty("--room-glow", glow);
  card.root.style.setProperty("--room-glow-soft", glowSoft);
  card.root.style.setProperty("--fan-left", room.layout.fan_position.x);
  card.root.style.setProperty("--fan-top", room.layout.fan_position.y);

  card.lightStatus.textContent = `${light.brightness}%`;
  const fanSpeedLabel = fanSwitchOn && Number(fan.speed_percent) === 0 ? "Armed" : fan.speed;
  card.fanStatus.textContent = fanModeLabel
    ? `${fan.speed_percent}% · ${fanModeLabel}`
    : `${fan.speed_percent}%`;
  card.occupancyLabel.textContent = `${room.sensors.occupancy_level} (${room.sensors.occupancy_count})`;
  const occupancyStepper = card.root.querySelector(`#occupancy-stepper-${room.id}`);
  if (occupancyStepper) {
    occupancyStepper.textContent = String(room.sensors.occupancy_count);
  }
  animateMetricValue(card.roomPower, Number(room.metrics.active_power_watts), { suffix: " W", decimals: 0 });
  animateMetricValue(card.roomCost, Number(room.metrics.hourly_cost_inr), { prefix: "₹", suffix: "/hr", decimals: 2 });

  card.lightToggle.classList.toggle("on", lightOn);
  card.lightToggle.dataset.level = lightOn ? "0" : String(recommendedLightStartupLevel(room));
  card.lightToggle.disabled = false;

  card.fanToggle.classList.toggle("on", fanSwitchOn);
  card.fanToggle.dataset.level = fanSwitchOn ? "0" : String(recommendedFanStartupLevel(room));
  card.fanToggle.dataset.resume = fanSwitchOn ? "false" : "true";
  card.fanToggle.disabled = false;

  updateSlider(card.root, room.id, "temperature", sensors.temperature, "°C", false);
  updateSlider(card.root, room.id, "ambient_light", sensors.ambient_light, "%", false);
  const occupancyValue = card.root.querySelector(`#sensor-value-${room.id}-occupancy_count`);
  if (occupancyValue) {
    occupancyValue.textContent = `${Math.round(Number(sensors.occupancy_count))} persons`;
  }
  updateSlider(card.root, room.id, "light", light.brightness, "%", !lightOn, true, {
    animate: true,
  });
  updateSlider(card.root, room.id, "fan", fan.speed_percent, "%", false, true, {
    animate: true,
    onFrame: (animatedValue) => {
      card.fanRotor.style.animationDuration = fanDuration(animatedValue);
    },
  });

  card.fanRotor.style.animationPlayState = fanOn ? "running" : "paused";

  card.leds.forEach((led) => {
    led.classList.toggle("on", lightOn);
    led.style.opacity = lightOn ? String(Math.max(0.35, light.brightness / 100)) : "0.55";
  });
}

function buildSceneDecor(roomId) {
  const decor = {
    living_room: `
      <div class="decor sofa"></div>
      <div class="decor table wide"></div>
      <div class="decor rug"></div>
    `,
    bedroom: `
      <div class="decor bed"></div>
      <div class="decor side"></div>
      <div class="decor rug small"></div>
    `,
    kitchen: `
      <div class="decor counter"></div>
      <div class="decor island"></div>
      <div class="decor shelf"></div>
    `,
    study: `
      <div class="decor desk"></div>
      <div class="decor chair"></div>
      <div class="decor shelf tall"></div>
    `,
  };
  return decor[roomId] || "";
}

function updateSlider(root, roomId, key, value, suffix, disabled, isDevice = false, options = {}) {
  const sliderSelector = isDevice
    ? `[data-room-id="${roomId}"][data-device-kind="${key}"]`
    : `[data-room-id="${roomId}"][data-sensor-key="${key}"]`;
  const labelId = isDevice ? `device-value-${roomId}-${key}` : `sensor-value-${roomId}-${key}`;
  const slider = root.querySelector(sliderSelector);
  const targetValue = Math.round(Number(value));
  const labelNode = root.querySelector(`#${labelId}`);
  if (slider) {
    slider.disabled = disabled;
    const isUserAdjusting = slider.dataset.userAdjusting === "true" || document.activeElement === slider;
    if (options.animate && !isUserAdjusting) {
      animateSliderValue(slider, labelNode, targetValue, suffix, options.onFrame);
    } else {
      stopSliderAnimation(slider);
      slider.value = String(targetValue);
      if (labelNode) {
        labelNode.textContent = suffix ? `${targetValue}${suffix}` : `${targetValue}`;
      }
      if (options.onFrame) {
        options.onFrame(targetValue);
      }
    }
    return;
  }
  if (labelNode) {
    labelNode.textContent = suffix ? `${targetValue}${suffix}` : `${targetValue}`;
  }
}

function animateSliderValue(slider, labelNode, targetValue, suffix, onFrame) {
  stopSliderAnimation(slider);
  const fromValue = Number(slider.value || 0);
  if (fromValue === targetValue) {
    slider.value = String(targetValue);
    if (labelNode) {
      labelNode.textContent = suffix ? `${targetValue}${suffix}` : `${targetValue}`;
    }
    if (onFrame) {
      onFrame(targetValue);
    }
    return;
  }
  const animationKey = slider.dataset.roomId
    ? `${slider.dataset.roomId}:${slider.dataset.deviceKind || slider.dataset.sensorKey}`
    : slider.id;
  const startedAt = performance.now();
  const duration = Math.min(1400, 420 + Math.abs(targetValue - fromValue) * 18);

  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = easeInOutCubic(progress);
    const nextValue = Math.round(fromValue + (targetValue - fromValue) * eased);
    slider.value = String(nextValue);
    if (labelNode) {
      labelNode.textContent = suffix ? `${nextValue}${suffix}` : `${nextValue}`;
    }
    if (onFrame) {
      onFrame(nextValue);
    }
    if (progress < 1) {
      const frameId = requestAnimationFrame(tick);
      sliderAnimations.set(animationKey, frameId);
    } else {
      sliderAnimations.delete(animationKey);
    }
  };

  const frameId = requestAnimationFrame(tick);
  sliderAnimations.set(animationKey, frameId);
}

function animateMetricValue(node, targetValue, options = {}) {
  if (!node) {
    return;
  }
  const {
    prefix = "",
    suffix = "",
    decimals = 0,
  } = options;
  const animationKey = node.id || `${prefix}:${suffix}:${node.textContent}`;
  const previous = Number(node.dataset.numericValue || 0);
  const target = Number(targetValue || 0);
  const existing = metricAnimations.get(animationKey);
  if (existing) {
    cancelAnimationFrame(existing);
    metricAnimations.delete(animationKey);
  }
  if (Math.abs(previous - target) < 0.01) {
    node.dataset.numericValue = String(target);
    node.textContent = `${prefix}${target.toFixed(decimals)}${suffix}`;
    return;
  }
  const startedAt = performance.now();
  const duration = Math.min(820, 220 + Math.abs(target - previous) * 18);
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const nextValue = previous + (target - previous) * eased;
    node.dataset.numericValue = String(nextValue);
    node.textContent = `${prefix}${nextValue.toFixed(decimals)}${suffix}`;
    if (progress < 1) {
      const frameId = requestAnimationFrame(tick);
      metricAnimations.set(animationKey, frameId);
    } else {
      node.dataset.numericValue = String(target);
      node.textContent = `${prefix}${target.toFixed(decimals)}${suffix}`;
      metricAnimations.delete(animationKey);
    }
  };
  const frameId = requestAnimationFrame(tick);
  metricAnimations.set(animationKey, frameId);
}

function easeInOutCubic(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function stopSliderAnimation(slider) {
  const animationKey = slider.dataset.roomId
    ? `${slider.dataset.roomId}:${slider.dataset.deviceKind || slider.dataset.sensorKey}`
    : slider.id;
  const existing = sliderAnimations.get(animationKey);
  if (existing) {
    cancelAnimationFrame(existing);
    sliderAnimations.delete(animationKey);
  }
}

function fanDuration(level) {
  const value = Number(level);
  if (value <= 0) {
    return "2.8s";
  }
  const normalized = Math.pow(value / 100, 0.55);
  const duration = 1.95 - normalized * 1.75;
  return `${Math.max(0.12, duration).toFixed(2)}s`;
}

function recommendedFanStartupLevel(room) {
  const policyTarget = Number(room.devices.fan.policy?.auto_target_percent || 0);
  if (policyTarget > 0) {
    return Math.round(policyTarget);
  }
  const temperature = Number(room.sensors.temperature || 0);
  if (temperature >= 40) return 95;
  if (temperature >= 36) return 82;
  if (temperature >= 32) return 64;
  if (temperature >= 28) return 42;
  return 25;
}

function recommendedLightStartupLevel(room) {
  const occupancy = Number(room.sensors.occupancy_count || 0);
  const ambientLight = Number(room.sensors.ambient_light || 0);
  if (occupancy <= 0) return 0;
  const points = [
    [0, 85],
    [20, 65],
    [45, 35],
    [75, 0],
  ];
  if (ambientLight <= points[0][0]) return points[0][1];
  if (ambientLight >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let index = 1; index < points.length; index += 1) {
    const [leftX, leftY] = points[index - 1];
    const [rightX, rightY] = points[index];
    if (ambientLight <= rightX) {
      const progress = (ambientLight - leftX) / (rightX - leftX);
      return Math.max(0, Math.round(leftY + (rightY - leftY) * progress));
    }
  }
  return 0;
}

function formatPolicyState(state) {
  const labels = {
    hold: "Holding",
    reclaim: "Smoothing",
    assist: "Optimizing",
    vacant: "Background",
    locked: "Safety",
  };
  return labels[state] || "";
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function estimateRoomPowerForUI(room) {
  const occupancy = Number(room.sensors.occupancy_count || 0);
  const light = room.devices.light;
  const fan = room.devices.fan;
  const lightLevel = Number(light.brightness || 0);
  const fanLevel = Number(fan.speed_percent || 0);
  const lightPower = light.state === "ON" || lightLevel > 0
    ? (light.power_watts * (lightLevel <= 0 ? 0.04 : (0.08 + 1.08 * Math.pow(lightLevel / 100, 1.32)) * (1 + Math.min(0.14, occupancy * 0.025))))
    : 0;
  const fanPower = fan.state === "ON" || fanLevel > 0
    ? (fan.power_watts * (fanLevel <= 0 ? 0.05 : (0.12 + 1.24 * Math.pow(fanLevel / 100, 1.58)) * (1 + Math.min(0.18, occupancy * 0.03))))
    : 0;
  const occupancyLoad = occupancy <= 0 ? 0 : (occupancy * 3.8) + (Math.max(0, occupancy - 2) * 2.4);
  return Number((lightPower + fanPower + occupancyLoad).toFixed(2));
}

function calculateSnapshotMetricsForUI(rooms, tariff) {
  const roomEntries = Object.values(rooms);
  const roomMetrics = {};
  let activePower = 0;
  let sessionCost = 0;
  roomEntries.forEach((room) => {
    const power = estimateRoomPowerForUI(room);
    const hourly = Number(((power / 1000) * tariff).toFixed(2));
    const runtimeBias = 0.28 + (Number(room.devices.fan.speed_percent || 0) / 1000) + (Number(room.devices.light.brightness || 0) / 1400);
    const roomSession = Number((hourly * (1 + runtimeBias)).toFixed(2));
    roomMetrics[room.id] = {
      active_power_watts: Number(power.toFixed(2)),
      hourly_cost_inr: hourly,
      session_cost_inr: roomSession,
    };
    activePower += power;
    sessionCost += roomSession;
  });
  const hourlyCost = Number(((activePower / 1000) * tariff).toFixed(2));
  return {
    roomMetrics,
    globalMetrics: {
      active_power_watts: Number(activePower.toFixed(2)),
      hourly_cost_inr: hourlyCost,
      session_cost_inr: Number(sessionCost.toFixed(2)),
      daily_cost_projection_inr: Number((hourlyCost * 24).toFixed(2)),
    },
  };
}

function previewMetricsForRoom(roomId, overrides = {}) {
  if (!latestSnapshot || !latestRooms.has(roomId)) {
    return;
  }
  const tariff = Number(latestSnapshot.tariff_inr_per_kwh || 8);
  const projectedRooms = {};
  Object.entries(latestSnapshot.rooms).forEach(([id, room]) => {
    projectedRooms[id] = {
      ...room,
      sensors: { ...room.sensors },
      devices: {
        light: { ...room.devices.light },
        fan: { ...room.devices.fan, policy: { ...(room.devices.fan.policy || {}) } },
      },
    };
  });
  const targetRoom = projectedRooms[roomId];
  if (!targetRoom) {
    return;
  }
  if (overrides.temperature !== undefined) targetRoom.sensors.temperature = Number(overrides.temperature);
  if (overrides.ambient_light !== undefined) targetRoom.sensors.ambient_light = Number(overrides.ambient_light);
  if (overrides.occupancy_count !== undefined) {
    targetRoom.sensors.occupancy_count = Number(overrides.occupancy_count);
    targetRoom.sensors.occupancy_level = formatOccupancyLevel(Number(overrides.occupancy_count));
  }
  if (overrides.light_brightness !== undefined) {
    targetRoom.devices.light.brightness = Number(overrides.light_brightness);
    targetRoom.devices.light.state = overrides.light_state || targetRoom.devices.light.state;
  }
  if (overrides.fan_speed_percent !== undefined) {
    targetRoom.devices.fan.speed_percent = Number(overrides.fan_speed_percent);
    targetRoom.devices.fan.state = overrides.fan_state || targetRoom.devices.fan.state;
  }
  const { roomMetrics, globalMetrics } = calculateSnapshotMetricsForUI(projectedRooms, tariff);
  Object.entries(roomMetrics).forEach(([id, metric]) => {
    const card = roomElements.get(id);
    if (!card) {
      return;
    }
    animateMetricValue(card.roomPower, metric.active_power_watts, { suffix: " W", decimals: 0 });
    animateMetricValue(card.roomCost, metric.hourly_cost_inr, { prefix: "₹", suffix: "/hr", decimals: 2 });
  });
  renderGlobalMetrics(globalMetrics);
  renderDashboard(buildDashboardPreview(projectedRooms, roomMetrics, globalMetrics));
}

function formatOccupancyLevel(count) {
  if (count <= 0) return "Absent";
  if (count === 1) return "Low";
  if (count <= 3) return "Medium";
  return "High";
}

function buildDashboardPreview(rooms, roomMetrics, globalMetrics) {
  const comparison = Object.values(rooms)
    .map((room) => ({
      room_id: room.id,
      name: room.name,
      energy_kwh: Number(((roomMetrics[room.id].active_power_watts * 4.2) / 1000).toFixed(2)),
      cost_inr: Number((roomMetrics[room.id].hourly_cost_inr * 4.2).toFixed(2)),
      avg_fan_percent: Number(room.devices.fan.speed_percent || 0),
      avg_light_percent: Number(room.devices.light.brightness || 0),
      occupancy_score: Number(room.sensors.occupancy_count || 0),
    }))
    .sort((left, right) => right.cost_inr - left.cost_inr);
  const peak = comparison[0] || { name: "Living Room" };
  return {
    summary: {
      total_energy_today_kwh: Number(((globalMetrics.active_power_watts * 4.2) / 1000).toFixed(2)),
      total_cost_today_inr: Number((globalMetrics.hourly_cost_inr * 4.2).toFixed(2)),
      highest_consuming_room: peak.name,
      peak_usage_hour: "Live",
      efficiency_score: Number(Math.max(58, 100 - globalMetrics.hourly_cost_inr * 8).toFixed(1)),
      savings_opportunity_percent: Number(Math.min(26, Math.max(8, globalMetrics.hourly_cost_inr * 10)).toFixed(1)),
    },
    room_comparison: comparison,
    hourly_trend: comparison.slice(0, 4).map((item, index) => ({
      hour: ["09:00", "13:00", "18:00", "21:00"][index] || "Now",
      power_watts: Number((item.energy_kwh * 220).toFixed(1)),
      cost_inr: Number((item.cost_inr / 4.2).toFixed(2)),
      activity: item.occupancy_score,
    })),
    recommendations: [
      `${peak.name} is leading current demand. A 10-15% trim would show the biggest savings.`,
      "This live preview updates as you move fan, light, and occupancy controls.",
    ],
    inefficiencies: comparison
      .filter((item) => item.occupancy_score === 0 && (item.avg_light_percent > 15 || item.avg_fan_percent > 35))
      .map((item) => `${item.name}: active load with no occupancy`),
    policy_preview: [],
  };
}

function scaleDashboardValue(value) {
  return dashboardRange === "week" ? value * 7 : value;
}

function renderDashboard(dashboard) {
  if (!dashboard) {
    return;
  }
  const summary = dashboard.summary || {};
  document.getElementById("dashboardSummary").innerHTML = [
    summaryCard("Total energy", `${scaleDashboardValue(Number(summary.total_energy_today_kwh || 0)).toFixed(2)} kWh`),
    summaryCard("Total cost", `₹${scaleDashboardValue(Number(summary.total_cost_today_inr || 0)).toFixed(2)}`),
    summaryCard("Highest room", summary.highest_consuming_room || "N/A"),
    summaryCard("Peak usage", summary.peak_usage_hour || "N/A"),
    summaryCard("Efficiency", `${Number(summary.efficiency_score || 0).toFixed(1)} · Save ${Number(summary.savings_opportunity_percent || 0).toFixed(1)}%`),
  ].join("");

  const roomMax = Math.max(1, ...dashboard.room_comparison.map((item) => item.cost_inr || 0));
  document.getElementById("roomComparisonChart").innerHTML = dashboard.room_comparison
    .map((item) => chartRow(item.name, `₹${scaleDashboardValue(item.cost_inr).toFixed(2)} · ${item.avg_fan_percent.toFixed(0)}% fan`, (item.cost_inr / roomMax) * 100))
    .join("");

  const trendMax = Math.max(1, ...dashboard.hourly_trend.map((item) => item.power_watts || 0));
  document.getElementById("hourlyTrendChart").innerHTML = dashboard.hourly_trend
    .map((item) => chartRow(item.hour, `${item.power_watts.toFixed(0)} W · ₹${scaleDashboardValue(item.cost_inr).toFixed(2)}`, (item.power_watts / trendMax) * 100, "cost"))
    .join("");

  document.getElementById("recommendationsPanel").innerHTML = [
    ...(dashboard.recommendations || []),
    ...(dashboard.policy_preview || []),
  ]
    .map((item) => `<div class="recommendation-item">${item}</div>`)
    .join("");

  document.getElementById("inefficiencyPanel").innerHTML = (dashboard.inefficiencies || [])
    .map((item) => `<div class="recommendation-item">${item}</div>`)
    .join("");
}

function summaryCard(label, value) {
  return `<div class="summary-chip"><span>${label}</span><strong>${value}</strong></div>`;
}

function chartRow(label, value, widthPercent, extraClass = "") {
  return `
    <div class="chart-row">
      <div class="chart-row-top">
        <span class="chart-row-label">${label}</span>
        <strong>${value}</strong>
      </div>
      <div class="chart-bar-track">
        <div class="chart-bar-fill ${extraClass}" style="width:${Math.max(6, widthPercent)}%"></div>
      </div>
    </div>
  `;
}

async function refreshDashboard() {
  try {
    const snapshot = await requestSnapshot("/api/system-state");
    if (snapshot) {
      renderSnapshot(snapshot);
    }
  } catch (error) {
    document.getElementById("deviceMessage").textContent = `Failed to load system state: ${error.message}`;
  }
}

async function advanceAutomation() {
  try {
    const snapshot = await requestSnapshot("/api/decision/evaluate", {
      method: "POST",
    });
    if (snapshot) {
      renderSnapshot(snapshot);
    }
  } catch (error) {
    document.getElementById("deviceMessage").textContent = `Automation refresh failed: ${error.message}`;
  }
}

async function updateRoomSensors(roomId, root) {
  const occupancyStepper = root.querySelector(`#occupancy-stepper-${roomId}`);
  const payload = {
    room_id: roomId,
    temperature: Number(root.querySelector(`[data-sensor-key="temperature"]`).value),
    ambient_light: Number(root.querySelector(`[data-sensor-key="ambient_light"]`).value),
    occupancy_count: Number(occupancyStepper ? occupancyStepper.textContent : 0),
  };
  try {
    const snapshot = await requestSnapshot("/api/sensor-reading", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (snapshot) {
      renderSnapshot(snapshot);
    }
  } catch (error) {
    document.getElementById("deviceMessage").textContent = error.message;
  }
}

function scheduleRoomSensorUpdate(roomId, root, delayMs = 180) {
  const existing = sensorSyncTimers.get(roomId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    sensorSyncTimers.delete(roomId);
    updateRoomSensors(roomId, root);
  }, delayMs);
  sensorSyncTimers.set(roomId, timer);
}

async function applyDeviceControl(deviceId, level, options = {}) {
  try {
    const snapshot = await requestSnapshot("/api/control/appliance", {
      method: "POST",
      body: JSON.stringify({
        appliance: deviceId,
        level,
        ...options,
      }),
    });
    if (snapshot) {
      renderSnapshot(snapshot);
    }
  } catch (error) {
    document.getElementById("deviceMessage").textContent = error.message;
    await refreshDashboard();
  }
}

function scheduleDeviceUpdate(deviceId, level, options = {}, delayMs = 35) {
  const existing = deviceSyncTimers.get(deviceId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    deviceSyncTimers.delete(deviceId);
    applyDeviceControl(deviceId, level, options);
  }, delayMs);
  deviceSyncTimers.set(deviceId, timer);
}

function previewDeviceSlider(input) {
  const roomId = input.dataset.roomId;
  const card = roomElements.get(roomId);
  if (!card) {
    return;
  }
  const value = Number(input.value);
  if (input.dataset.deviceKind === "fan") {
    card.fanStatus.textContent = `${value}% preview`;
    card.fanToggle.classList.toggle("on", value > 0);
    card.fanRotor.style.animationDuration = fanDuration(value);
    card.fanRotor.style.animationPlayState = value > 0 ? "running" : "paused";
    return;
  }
  if (input.dataset.deviceKind === "light") {
    const isOn = value > 0;
    const roomColor = getComputedStyle(card.root).getPropertyValue("--light-color").trim() || "#ffd36b";
    card.lightStatus.textContent = `${value}% brightness`;
    card.lightToggle.classList.toggle("on", isOn);
    card.root.classList.toggle("light-on", isOn);
    card.root.style.setProperty("--room-glow", hexToRgba(roomColor, Math.max(0.16, value / 100)));
    card.root.style.setProperty("--room-glow-soft", hexToRgba(roomColor, Math.max(0.1, value / 260)));
    card.leds.forEach((led) => {
      led.classList.toggle("on", isOn);
      led.style.opacity = isOn ? String(Math.max(0.35, value / 100)) : "0.55";
    });
  }
}

function paintVoiceStatus(roomId) {
  const card = roomElements.get(roomId);
  if (!card) {
    return;
  }
  card.voiceStatus.textContent =
    roomVoiceFeedback.get(roomId) || "Tap mic and speak for this room.";
  card.voiceDebug.textContent =
    roomVoiceDebug.get(roomId) || "No voice activity yet.";
  card.micButton.classList.toggle("listening", activeListeningRoomId === roomId);
  card.micButton.textContent = activeListeningRoomId === roomId ? "Listening" : "Mic";
}

async function submitVoiceCommand(roomId, rawText) {
  roomVoiceFeedback.set(roomId, `Heard: "${rawText}"`);
  roomVoiceDebug.set(roomId, `transcript: ${rawText}\nstatus: sending to backend`);
  voiceLog("transcript", { roomId, rawText });
  paintVoiceStatus(roomId);
  try {
    const snapshot = await requestSnapshot("/api/voice/command", {
      method: "POST",
      body: JSON.stringify({
        room_id: roomId,
        raw_text: rawText,
      }),
    });
    if (snapshot) {
      const debugPayload = snapshot.voice_debug || {};
      roomVoiceDebug.set(
        roomId,
        [
          `transcript: ${debugPayload.transcript || rawText}`,
          `parser_source: ${debugPayload.parser_source || "unknown"}`,
          `model: ${debugPayload.model || "n/a"}`,
          `llm_output: ${debugPayload.llm_output || JSON.stringify(snapshot.voice_command || {}, null, 2)}`,
          `command: ${JSON.stringify(snapshot.voice_command || {}, null, 2)}`,
          `error: ${debugPayload.error || "none"}`,
        ].join("\n")
      );
      if (snapshot.voice_command) {
        roomVoiceFeedback.set(
          roomId,
          `${snapshot.voice_command.intent} · ${snapshot.voice_command.reason}`
        );
      }
      voiceLog("parse:result", {
        roomId,
        transcript: rawText,
        voiceDebug: debugPayload,
        command: snapshot.voice_command,
      });
      renderSnapshot(snapshot);
    }
  } catch (error) {
    roomVoiceFeedback.set(roomId, `Voice parse failed: ${error.message}`);
    roomVoiceDebug.set(roomId, `transcript: ${rawText}\nerror: ${error.message}`);
    voiceError("parse:failed", { roomId, rawText, error: error.message });
    document.getElementById("deviceMessage").textContent = error.message;
    await refreshDashboard();
  }
}

function startRoomVoiceCapture(roomId) {
  if (!SpeechRecognition) {
    document.getElementById("deviceMessage").textContent =
      "This browser does not support native speech recognition.";
    return;
  }
  if (activeRecognition) {
    activeRecognition.stop();
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  activeListeningRoomId = roomId;
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  roomVoiceFeedback.set(roomId, "Listening for a room-local command...");
  roomVoiceDebug.set(roomId, "status: browser speech recognition listening");
  voiceLog("listening:start", { roomId });
  paintVoiceStatus(roomId);
  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript.trim();
    voiceLog("listening:result", { roomId, transcript });
    await submitVoiceCommand(roomId, transcript);
  };
  recognition.onerror = (event) => {
    roomVoiceFeedback.set(roomId, "Voice capture failed. Try again.");
    roomVoiceDebug.set(roomId, `status: browser speech recognition error\nerror: ${event.error || "unknown"}`);
    voiceError("listening:error", { roomId, error: event.error || "unknown" });
    paintVoiceStatus(roomId);
  };
  recognition.onend = () => {
    activeRecognition = null;
    activeListeningRoomId = null;
    voiceLog("listening:end", { roomId });
    paintVoiceStatus(roomId);
  };
  recognition.start();
}

document.getElementById("houseGrid").addEventListener("click", async (event) => {
  const micButton = event.target.closest("[data-voice-kind='mic']");
  if (micButton && !micButton.disabled) {
    voiceLog("mic:click", { roomId: micButton.dataset.roomId });
    startRoomVoiceCapture(micButton.dataset.roomId);
    return;
  }
  const toggle = event.target.closest("[data-device-kind$='toggle']");
  if (toggle && !toggle.disabled) {
    await applyDeviceControl(toggle.dataset.deviceId, Number(toggle.dataset.level || 0), {
      resume: toggle.dataset.resume === "true",
    });
  }
  const stepperButton = event.target.closest("[data-occupancy-step]");
  if (stepperButton) {
    const roomId = stepperButton.dataset.roomId;
    const card = roomElements.get(roomId);
    if (!card) {
      return;
    }
    const stepperValue = card.root.querySelector(`#occupancy-stepper-${roomId}`);
    const nextValue = Math.max(0, Math.min(5, Number(stepperValue.textContent) + Number(stepperButton.dataset.occupancyStep)));
    const occupancyValue = card.root.querySelector(`#sensor-value-${roomId}-occupancy_count`);
    if (occupancyValue) occupancyValue.textContent = `${nextValue} persons`;
    if (stepperValue) stepperValue.textContent = String(nextValue);
    previewMetricsForRoom(roomId, { occupancy_count: nextValue });
    scheduleRoomSensorUpdate(roomId, card.root, 60);
  }
});

document.getElementById("houseGrid").addEventListener("input", (event) => {
  const input = event.target;
  if (input.dataset.sensorKey) {
    input.dataset.userAdjusting = "true";
    input.parentElement.querySelector("strong").textContent = `${input.value}${input.dataset.sensorSuffix}`;
    previewMetricsForRoom(input.dataset.roomId, {
      [input.dataset.sensorKey]: Number(input.value),
    });
    scheduleRoomSensorUpdate(input.dataset.roomId, input.closest(".room-card"));
    return;
  }
  if (input.dataset.deviceKind) {
    input.dataset.userAdjusting = "true";
    input.parentElement.querySelector("strong").textContent = `${input.value}${input.dataset.deviceSuffix}`;
    previewDeviceSlider(input);
    previewMetricsForRoom(input.dataset.roomId, input.dataset.deviceKind === "fan"
      ? {
          fan_speed_percent: Number(input.value),
          fan_state: "ON",
        }
      : {
          light_brightness: Number(input.value),
          light_state: "ON",
        });
    if (!input.disabled) {
      scheduleDeviceUpdate(
        input.dataset.deviceId,
        Number(input.value),
        { resume: false, preserve_on_zero: true }
      );
    }
  }
});

document.getElementById("houseGrid").addEventListener("change", async (event) => {
  const input = event.target;
  if (input.dataset.sensorKey) {
    input.dataset.userAdjusting = "false";
    const existing = sensorSyncTimers.get(input.dataset.roomId);
    if (existing) {
      clearTimeout(existing);
      sensorSyncTimers.delete(input.dataset.roomId);
    }
    await updateRoomSensors(input.dataset.roomId, input.closest(".room-card"));
    return;
  }
  if (input.dataset.deviceKind && !input.disabled) {
    input.dataset.userAdjusting = "false";
    const existing = deviceSyncTimers.get(input.dataset.deviceId);
    if (existing) {
      clearTimeout(existing);
      deviceSyncTimers.delete(input.dataset.deviceId);
    }
    await applyDeviceControl(input.dataset.deviceId, Number(input.value), {
      preserve_on_zero: true,
    });
  }
});

document.getElementById("runDecisionButton").addEventListener("click", async () => {
  try {
    const snapshot = await requestSnapshot("/api/decision/evaluate", {
      method: "POST",
    });
    if (snapshot) {
      renderSnapshot(snapshot);
    }
  } catch (error) {
    document.getElementById("deviceMessage").textContent = error.message;
  }
});

document.getElementById("viewTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-view]");
  if (!tab) {
    return;
  }
  document.querySelectorAll(".view-tab").forEach((node) => {
    node.classList.toggle("active", node === tab);
  });
  document.getElementById("homeView").classList.toggle("active", tab.dataset.view === "home");
  document.getElementById("dashboardView").classList.toggle("active", tab.dataset.view === "dashboard");
});

document.getElementById("dashboardRangeTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-range]");
  if (!tab) {
    return;
  }
  dashboardRange = tab.dataset.range;
  document.querySelectorAll(".range-chip").forEach((node) => {
    node.classList.toggle("active", node === tab);
  });
  if (latestSnapshot?.dashboard) {
    renderDashboard(latestSnapshot.dashboard);
  }
});

refreshDashboard();
setInterval(advanceAutomation, 900);
