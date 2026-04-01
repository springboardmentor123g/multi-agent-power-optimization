const roomElements = new Map();
const sensorSyncTimers = new Map();
const deviceSyncTimers = new Map();
const pendingOccupancy = new Map();
const sliderAnimations = new Map();
const metricAnimations = new Map();
const roomVoiceFeedback = new Map();
const roomVoiceDebug = new Map();
const roomVoiceAssist = new Map();
const latestRooms = new Map();
const industryRoomElements = new Map();
const roomOptimizationSessions = new Map();
const manualOffLocks = new Map();
const storedRecommendedSetpoints = new Map();
const roomInitializationBias = new Map();
const optimizationSavingsRuntime = {
  home: { accrued: 0, ratePerHour: 0, lastUpdatedAt: performance.now(), nextBumpAt: 0, roomRates: new Map() },
  industry: { accrued: 0, ratePerHour: 0, lastUpdatedAt: performance.now(), nextBumpAt: 0, roomRates: new Map() },
};
let optimizationSavingsHydrated = false;
let latestSnapshotRequestId = 0;
let latestAppliedSnapshotId = 0;
let activeRecognition = null;
let activeListeningRoomId = null;
let activeAssistListeningRoomId = null;
let activeCommandProcessingRoomId = null;
let latestSnapshot = null;
let latestIndustryState = null;
let latestSnapshotRenderedAt = 0;
let latestIndustryRenderedAt = 0;
const homeDashboardState = { range: "today", roomFilter: "all", metricFilter: "cost", trendWindow: "hourly" };
const industryDashboardState = { range: "today", roomFilter: "all", metricFilter: "cost", trendWindow: "hourly" };
const UI_POWER_TOKEN_SCALE = 1.42;
const UI_BILLING_RATE_TOKEN_SCALE = 960;
const MAX_OCCUPANCY = 8;
const VOICE_ASSIST_REPLY_TIMEOUT_MS = 12000;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const INDUSTRY_ROOM_BLUEPRINTS = [
  { id: "industry_zone_1", name: "Assembly Line 1", template: "living_room", temperature: 32, ambient_light: 42, occupancy: 5 },
  { id: "industry_zone_2", name: "Assembly Line 2", template: "kitchen", temperature: 31, ambient_light: 48, occupancy: 1 },
  { id: "industry_zone_3", name: "Fabrication Bay", template: "study", temperature: 34, ambient_light: 38, occupancy: 6, fan_on: false },
  { id: "industry_zone_4", name: "Control Room", template: "bedroom", temperature: 28, ambient_light: 56, occupancy: 2 },
  { id: "industry_zone_5", name: "Packaging", template: "living_room", temperature: 30, ambient_light: 44, occupancy: 5 },
  { id: "industry_zone_6", name: "Storage", template: "study", temperature: 27, ambient_light: 62, occupancy: 1 },
  { id: "industry_zone_7", name: "Dispatch", template: "kitchen", temperature: 33, ambient_light: 36, occupancy: 4 },
  { id: "industry_zone_8", name: "Maintenance", template: "bedroom", temperature: 29, ambient_light: 52, occupancy: 3 },
  { id: "industry_zone_9", name: "QA Lab", template: "study", temperature: 26, ambient_light: 58, occupancy: 2 },
  { id: "industry_zone_10", name: "Utility Hub", template: "living_room", temperature: 35, ambient_light: 34, occupancy: 6 },
];

const OPTIMIZATION_TARGETS = {
  living_room: { fan: 54, light: 18 },
  bedroom: { fan: 42, light: 14 },
  kitchen: { fan: 58, light: 24 },
  study: { fan: 0, light: 0 },
};

function voiceLog(event, payload = {}) {
  console.log(`[smart-home][voice] ${event}`, payload);
}

function voiceError(event, payload = {}) {
  console.error(`[smart-home][voice] ${event}`, payload);
}

function deviceStateKey(scope, roomId, deviceKind) {
  return `${scope}:${roomId}:${deviceKind}`;
}

function isManualOffLocked(scope, roomId, deviceKind) {
  return manualOffLocks.get(deviceStateKey(scope, roomId, deviceKind)) === true;
}

function setManualOffLock(scope, roomId, deviceKind, locked) {
  const key = deviceStateKey(scope, roomId, deviceKind);
  if (locked) {
    manualOffLocks.set(key, true);
  } else {
    manualOffLocks.delete(key);
  }
}

function getStoredSetpoint(scope, roomId, deviceKind, fallbackValue = 0) {
  const key = deviceStateKey(scope, roomId, deviceKind);
  if (storedRecommendedSetpoints.has(key)) {
    return Number(storedRecommendedSetpoints.get(key) || 0);
  }
  return Number(fallbackValue || 0);
}

function setStoredSetpoint(scope, roomId, deviceKind, value) {
  const key = deviceStateKey(scope, roomId, deviceKind);
  storedRecommendedSetpoints.set(key, Math.max(0, Math.min(100, Number(value || 0))));
}

function assistState(roomId) {
  return roomVoiceAssist.get(roomId)?.ui_state || "idle";
}

function setAssistState(roomId, nextState) {
  const current = roomVoiceAssist.get(roomId) || {};
  roomVoiceAssist.set(roomId, { ...current, ...nextState });
}

function setNodeText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function setNodeHTML(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.innerHTML = value;
  }
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

async function requestInteractiveSnapshot(url, options = {}) {
  const snapshot = await fetchJSON(url, options);
  latestAppliedSnapshotId = Math.max(latestAppliedSnapshotId, latestSnapshotRequestId);
  return snapshot;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  Object.values(latestSnapshot.rooms || {}).forEach((room) => {
    applyDemoInitializationBiasToRoom(room, "home");
  });
  hydrateOptimizationSavings(snapshot.optimization_savings);
  latestSnapshotRenderedAt = performance.now();
  document.getElementById("tariffValue").textContent = `₹${snapshot.tariff_inr_per_kwh.toFixed(2)} / kWh`;
  document.getElementById("deviceMode").textContent = `Mode: ${snapshot.device_mode} · ${snapshot.deployment_model}`;
  renderGlobalMetrics(snapshot.metrics);

  setNodeHTML(
    "analysisStatus",
    [
      statusRow("Temperature", snapshot.metrics.temperature_status),
      statusRow("Occupied rooms", countOccupiedRooms(snapshot.rooms)),
      statusRow("Recent activity", snapshot.activity_summary),
    ].join("")
  );

  setNodeHTML(
    "insightsList",
    snapshot.insights.map((insight) => `<li>${insight}</li>`).join("")
  );

  setNodeText("activitySummary", snapshot.activity_summary);
  setNodeHTML(
    "decisionLog",
    snapshot.recent_decisions.length
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
      : `<div class="log-item"><strong>No decision logs yet.</strong></div>`
  );

  setNodeText(
    "deviceMessage",
    snapshot.device_message || "Simulation mode active. Room-local state synced."
  );

  renderRooms(snapshot.rooms);
  if (!latestIndustryState) {
    latestIndustryState = buildIndustryState(snapshot);
  } else {
    latestIndustryState.tariff = snapshot.tariff_inr_per_kwh;
  }
  recalculateIndustryState();
  renderIndustrySnapshot();
  syncIndustryRoomSelect();
  renderDashboard(snapshot.dashboard, homeDashboardState, {
    summaryId: "dashboardSummary",
    savingsId: "dashboardOptimizationSavings",
    scope: "home",
    comparisonId: "roomComparisonChart",
    trendChartId: "hourlyTrendChart",
    trendTitleId: "trendChartTitle",
    trendSubtitleId: "trendChartSubtitle",
    recommendationsId: "recommendationsPanel",
    inefficienciesId: "inefficiencyPanel",
  });
  renderDashboard(latestIndustryState.dashboard, industryDashboardState, {
    summaryId: "industryDashboardSummary",
    savingsId: "industryDashboardOptimizationSavings",
    scope: "industry",
    comparisonId: "industryRoomComparisonChart",
    trendChartId: "industryHourlyTrendChart",
    trendTitleId: "industryTrendChartTitle",
    trendSubtitleId: "industryTrendChartSubtitle",
    recommendationsId: "industryRecommendationsPanel",
    inefficienciesId: "industryInefficiencyPanel",
  });
}

function renderGlobalMetrics(metrics) {
  animateMetricValue(document.getElementById("activePower"), Number(metrics.power_tokens || 0), { suffix: " tok", decimals: 0 });
  animateMetricValue(document.getElementById("hourlyCost"), Number(metrics.rate_tokens || 0), { suffix: " tok/hr", decimals: 0 });
  primeLiveMeter(document.getElementById("sessionCost"), Number(metrics.billing_tokens || 0), Number(metrics.rate_tokens || 0), " tok");
  animateMetricValue(document.getElementById("dailyCost"), Number(metrics.daily_projection_tokens || 0), { suffix: " tok", decimals: 0 });
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
  renderRoomCollection(document.getElementById("houseGrid"), roomElements, rooms, { voiceEnabled: true });
}

function renderRoomCollection(container, elementMap, rooms, options = {}) {
  Object.values(rooms).forEach((room) => {
    const pendingCount = options.pendingOccupancyMap ? options.pendingOccupancyMap.get(room.id) : pendingOccupancy.get(room.id);
    const roomForRender = pendingCount === undefined
      ? room
      : {
          ...room,
          sensors: {
            ...room.sensors,
            occupancy_count: pendingCount,
            occupancy_level: formatOccupancyLevel(pendingCount),
          },
        };
    if (options.storeLatest !== false) {
      latestRooms.set(room.id, room);
    }
    if (!elementMap.has(room.id)) {
      const card = buildRoomCard(roomForRender, options);
      elementMap.set(room.id, card);
      container.append(card.root);
    }
    updateRoomCard(elementMap.get(room.id), roomForRender);
  });
}

function buildIndustryState(snapshot) {
  const sourceRooms = snapshot.rooms || {};
  const rooms = {};
  INDUSTRY_ROOM_BLUEPRINTS.forEach((blueprint, index) => {
    const templateRoom =
      sourceRooms[blueprint.template]
      || sourceRooms[Object.keys(sourceRooms)[index % Math.max(1, Object.keys(sourceRooms).length)]];
    if (!templateRoom) {
      return;
    }
    const cloned = JSON.parse(JSON.stringify(templateRoom));
    cloned.id = blueprint.id;
    cloned.name = blueprint.name;
    cloned.scope = "industry";
    cloned.optimization_profile = blueprint.template;
    cloned.sensors.temperature = blueprint.temperature;
    cloned.sensors.ambient_light = blueprint.ambient_light;
    cloned.sensors.occupancy_count = blueprint.occupancy;
    cloned.sensors.occupancy_level = formatOccupancyLevel(blueprint.occupancy);
    cloned.devices.light.id = `${blueprint.id}_light`;
    cloned.devices.fan.id = `${blueprint.id}_fan`;
    cloned.devices.fan.policy = { ...(cloned.devices.fan.policy || {}), auto_target_percent: 0 };
    cloned.devices.light.brightness = recommendedLightStartupLevel(cloned);
    cloned.devices.light.state = "ON";
    cloned.devices.fan.speed_percent = recommendedFanStartupLevel(cloned);
    cloned.devices.fan.speed = fanBandFromPercent(cloned.devices.fan.speed_percent);
    cloned.devices.fan.state = "ON";
    applyDemoInitializationBiasToRoom(cloned, "industry");
    if (blueprint.id === "industry_zone_4" || blueprint.id === "industry_zone_7") {
      cloned.devices.light.brightness = 0;
      cloned.devices.light.state = "OFF";
      cloned.devices.fan.speed_percent = 0;
      cloned.devices.fan.speed = "OFF";
      cloned.devices.fan.state = "OFF";
      setManualOffLock("industry", blueprint.id, "light", true);
      setManualOffLock("industry", blueprint.id, "fan", true);
    } else if (blueprint.fan_on === false) {
      cloned.devices.fan.speed_percent = 0;
      cloned.devices.fan.speed = "OFF";
      cloned.devices.fan.state = "OFF";
      setManualOffLock("industry", blueprint.id, "light", false);
      setManualOffLock("industry", blueprint.id, "fan", true);
    } else {
      setManualOffLock("industry", blueprint.id, "light", false);
      setManualOffLock("industry", blueprint.id, "fan", false);
    }
    rooms[blueprint.id] = cloned;
  });
  return {
    tariff: Number(snapshot.tariff_inr_per_kwh || 8),
    rooms,
    metrics: {},
    dashboard: null,
  };
}

function recalculateIndustryState() {
  if (!latestIndustryState) {
    return;
  }
  const { roomMetrics, globalMetrics } = calculateSnapshotMetricsForUI(
    latestIndustryState.rooms,
    latestIndustryState.tariff || 8
  );
  Object.values(latestIndustryState.rooms).forEach((room) => {
    room.metrics = roomMetrics[room.id];
    room.devices.fan.speed = fanBandFromPercent(room.devices.fan.speed_percent);
    room.sensors.occupancy_level = formatOccupancyLevel(room.sensors.occupancy_count);
  });
  latestIndustryState.metrics = globalMetrics;
  latestIndustryState.dashboard = buildDashboardPreview(
    latestIndustryState.rooms,
    roomMetrics,
    globalMetrics
  );
}

function renderIndustrySnapshot() {
  if (!latestIndustryState) {
    return;
  }
  latestIndustryRenderedAt = performance.now();
  renderRoomCollection(
    document.getElementById("industryGrid"),
    industryRoomElements,
    latestIndustryState.rooms,
    { voiceEnabled: false, scope: "industry", storeLatest: false }
  );
  animateMetricValue(document.getElementById("industryActivePower"), Number(latestIndustryState.metrics.power_tokens || 0), { suffix: " tok", decimals: 0 });
  animateMetricValue(document.getElementById("industryHourlyCost"), Number(latestIndustryState.metrics.rate_tokens || 0), { suffix: " tok/hr", decimals: 0 });
  primeLiveMeter(document.getElementById("industrySessionCost"), Number(latestIndustryState.metrics.billing_tokens || 0), Number(latestIndustryState.metrics.rate_tokens || 0), " tok");
  animateMetricValue(document.getElementById("industryDailyCost"), Number(latestIndustryState.metrics.daily_projection_tokens || 0), { suffix: " tok", decimals: 0 });
}

function syncIndustryRoomSelect() {
  const select = document.getElementById("industryDashboardRoomSelect");
  if (!select || !latestIndustryState) {
    return;
  }
  const current = select.value || "all";
  const options = [
    `<option value="all">All rooms</option>`,
    ...Object.values(latestIndustryState.rooms).map(
      (room) => `<option value="${room.id}">${room.name}</option>`
    ),
  ];
  select.innerHTML = options.join("");
  select.value = Object.prototype.hasOwnProperty.call(latestIndustryState.rooms, current) || current === "all"
    ? current
    : "all";
  industryDashboardState.roomFilter = select.value;
}

function fanBandFromPercent(value) {
  const percent = Number(value || 0);
  if (percent <= 0) return "OFF";
  if (percent <= 30) return "LOW";
  if (percent <= 70) return "MEDIUM";
  return "HIGH";
}

function updateIndustryRoom(roomId, mutator) {
  if (!latestIndustryState?.rooms?.[roomId]) {
    return;
  }
  mutator(latestIndustryState.rooms[roomId]);
  recalculateIndustryState();
  renderIndustrySnapshot();
  renderDashboard(latestIndustryState.dashboard, industryDashboardState, {
    summaryId: "industryDashboardSummary",
    savingsId: "industryDashboardOptimizationSavings",
    scope: "industry",
    comparisonId: "industryRoomComparisonChart",
    trendChartId: "industryHourlyTrendChart",
    trendTitleId: "industryTrendChartTitle",
    trendSubtitleId: "industryTrendChartSubtitle",
    recommendationsId: "industryRecommendationsPanel",
    inefficienciesId: "industryInefficiencyPanel",
  });
}

function buildRoomCard(room, options = {}) {
  const root = document.createElement("article");
  root.className = "room-card";
  root.dataset.roomId = room.id;
  root.dataset.scope = options.scope || "home";
  const voiceControls = options.voiceEnabled === false
    ? ""
    : `
        <button class="mic-button speaker-button" type="button" data-room-id="${room.id}" data-voice-kind="speaker" id="voice-speaker-${room.id}" aria-label="Start voice assist for ${room.name}">🔊</button>
        <button class="mic-button" type="button" data-room-id="${room.id}" data-voice-kind="mic" id="voice-mic-${room.id}" aria-label="Speak a command for ${room.name}">🎙</button>
      `;
  root.innerHTML = `
    <div class="room-header">
      <div class="room-title">
        <h3 class="room-name" id="room-name-${room.id}"></h3>
      </div>
      <div class="room-actions">
        <span class="room-badge" id="room-badge-${room.id}"></span>
        ${voiceControls}
        <button class="sensor-chip optimize-chip" type="button" data-room-id="${room.id}" data-optimize-room="true" aria-label="Run power optimization for ${room.name}">⚡ Power optimization</button>
        <details class="sensor-popover" id="sensor-popover-${room.id}">
          <summary class="sensor-chip">Sensors</summary>
          <div class="sensor-flyout sensor-panel compact">
            ${sensorSlider(room.id, "temperature", "Temp", 16, 40, "°C")}
            ${sensorSlider(room.id, "ambient_light", "Light", 0, 100, "%")}
            <div class="stepper-field">
              <div class="slider-head">
                <span>Occupancy</span>
                <strong id="sensor-value-${room.id}-occupancy_count">0</strong>
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
      <div class="sensor-hud" id="sensor-hud-${room.id}" aria-label="Live sensor readings">
        <span class="sensor-hud-item" id="hud-temperature-${room.id}">🌡️ 0 °C</span>
        <span class="sensor-hud-item" id="hud-light-${room.id}">💡 0%</span>
      </div>
      <div class="room-overlay" id="room-overlay-${room.id}" hidden>
        <div class="room-overlay-card">
          <strong id="room-overlay-title-${room.id}">Optimizing...</strong>
        </div>
      </div>
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
        <span class="metric-pill"><span>Power</span><strong id="room-power-${room.id}">0 W</strong></span>
        <span class="metric-pill"><span>Bill</span><strong id="room-cost-${room.id}">₹0.00</strong></span>
        <span class="metric-pill"><span>Occupancy</span><strong id="occupancy-label-${room.id}">Absent</strong></span>
      </div>
      <div class="voice-note" id="voice-status-${room.id}"></div>
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
    scope: root.dataset.scope,
    voiceEnabled: options.voiceEnabled !== false,
    name: root.querySelector(`#room-name-${room.id}`),
    badge: root.querySelector(`#room-badge-${room.id}`),
    voiceStatus: root.querySelector(`#voice-status-${room.id}`),
    sensorPopover: root.querySelector(`#sensor-popover-${room.id}`),
    optimizeButton: root.querySelector(`[data-room-id="${room.id}"][data-optimize-room="true"]`),
    overlay: root.querySelector(`#room-overlay-${room.id}`),
    overlayTitle: root.querySelector(`#room-overlay-title-${room.id}`),
    speakerButton: root.querySelector(`#voice-speaker-${room.id}`),
    micButton: root.querySelector(`#voice-mic-${room.id}`),
    fanRotor: root.querySelector(`#fan-rotor-${room.id}`),
    lightStatus: root.querySelector(`#light-status-${room.id}`),
    fanStatus: root.querySelector(`#fan-status-${room.id}`),
    lightToggle: root.querySelector(`#light-toggle-${room.id}`),
    fanToggle: root.querySelector(`#fan-toggle-${room.id}`),
    lightSlider: root.querySelector(`[data-room-id="${room.id}"][data-device-kind="light"]`),
    fanSlider: root.querySelector(`[data-room-id="${room.id}"][data-device-kind="fan"]`),
    occupancyLabel: root.querySelector(`#occupancy-label-${room.id}`),
    roomPower: root.querySelector(`#room-power-${room.id}`),
    roomCost: root.querySelector(`#room-cost-${room.id}`),
    hudTemperature: root.querySelector(`#hud-temperature-${room.id}`),
    hudLight: root.querySelector(`#hud-light-${room.id}`),
    leds: [...root.querySelectorAll(`[id^="room-led-${room.id}-"]`)],
    occupancyDown: root.querySelector(`[data-room-id="${room.id}"][data-occupancy-step="-1"]`),
    occupancyUp: root.querySelector(`[data-room-id="${room.id}"][data-occupancy-step="1"]`),
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
  const optimizationSession = roomOptimizationSessions.get(`${card.scope}:${room.id}`);
  const lightOffLocked = isManualOffLocked(card.scope, room.id, "light");
  const fanOffLocked = isManualOffLocked(card.scope, room.id, "fan");
  const light = optimizationSession
    ? {
        ...room.devices.light,
        state: optimizationSession.lightOn ? "ON" : "OFF",
        brightness: optimizationSession.lightPercent,
      }
    : room.devices.light;
  const fan = optimizationSession
    ? {
        ...room.devices.fan,
        state: optimizationSession.fanOn ? "ON" : "OFF",
        speed_percent: optimizationSession.fanPercent,
        speed: fanBandFromPercent(optimizationSession.fanPercent),
      }
    : room.devices.fan;
  const effectiveLight = lightOffLocked && !optimizationSession
    ? {
        ...light,
        state: "OFF",
        brightness: 0,
      }
    : light;
  const effectiveFan = fanOffLocked && !optimizationSession
    ? {
        ...fan,
        state: "OFF",
        speed_percent: 0,
        speed: "OFF",
      }
    : fan;
  setStoredSetpoint(card.scope, room.id, "fan", recommendedFanStartupLevel(room));
  setStoredSetpoint(card.scope, room.id, "light", recommendedLightStartupLevel(room));
  const sensors = room.sensors;
  const lightOn = effectiveLight.state === "ON";
  const glow = hexToRgba(effectiveLight.color, Math.max(0.16, effectiveLight.brightness / 100));
  const glowSoft = hexToRgba(effectiveLight.color, Math.max(0.1, effectiveLight.brightness / 260));
  const fanOn = Number(effectiveFan.speed_percent) > 0;
  const fanSwitchOn = effectiveFan.state === "ON";
  const fanPolicy = effectiveFan.policy || {};
  const fanModeLabel = formatPolicyState(fanPolicy.state);
  const voiceFeedback = roomVoiceFeedback.get(room.id) || "";
  const voiceDebug = roomVoiceDebug.get(room.id) || "No voice activity yet.";
  const speakerState = assistState(room.id);
  const optimizing = !!optimizationSession;

  card.name.textContent = room.name;
  const isLive = lightOn || fanSwitchOn;
  card.badge.textContent = isLive ? "Live" : "Idle";
  card.badge.classList.toggle("is-live", isLive);
  card.badge.classList.toggle("is-idle", !isLive);
  card.voiceStatus.textContent = voiceFeedback;
  if (card.voiceDebug) {
    card.voiceDebug.textContent = voiceDebug;
  }
  if (card.speakerButton) {
    card.speakerButton.classList.toggle(
      "listening",
      speakerState === "awaiting_reply" || speakerState === "capturing_reply"
    );
    card.speakerButton.classList.toggle(
      "processing",
      speakerState === "loading" || speakerState === "replying"
    );
    card.speakerButton.disabled = !card.voiceEnabled;
    card.speakerButton.hidden = !card.voiceEnabled;
    card.speakerButton.textContent =
      speakerState === "loading" || speakerState === "replying"
        ? "…"
        : speakerState === "awaiting_reply" || speakerState === "capturing_reply"
          ? "◉"
          : "🔊";
  }
  if (card.micButton) {
    card.micButton.classList.toggle("listening", activeListeningRoomId === room.id);
    card.micButton.classList.toggle("processing", activeCommandProcessingRoomId === room.id);
    card.micButton.disabled = !card.voiceEnabled || !SpeechRecognition;
    card.micButton.hidden = !card.voiceEnabled;
    card.micButton.textContent =
      activeCommandProcessingRoomId === room.id
        ? "…"
        : activeListeningRoomId === room.id
          ? "◉"
          : "🎙";
  }
  if (card.optimizeButton) {
    card.optimizeButton.disabled = optimizing;
  }
  card.root.classList.toggle("light-on", lightOn);
  card.root.style.setProperty("--light-color", light.color);
  card.root.style.setProperty("--room-glow", glow);
  card.root.style.setProperty("--room-glow-soft", glowSoft);
  card.root.style.setProperty("--fan-left", room.layout.fan_position.x);
  card.root.style.setProperty("--fan-top", room.layout.fan_position.y);
  if (optimizationSession) {
    setRoomOverlay(card, optimizationSession.title || "Optimizing...", true);
  } else {
    setRoomOverlay(card, "", false);
  }

  card.lightStatus.textContent = `${effectiveLight.brightness}%`;
  const fanSpeedLabel = fanSwitchOn && Number(effectiveFan.speed_percent) === 0 ? "Armed" : effectiveFan.speed;
  card.fanStatus.textContent = fanModeLabel
    ? `${effectiveFan.speed_percent}% · ${fanModeLabel}`
    : `${effectiveFan.speed_percent}%`;
  card.occupancyLabel.textContent = `${room.sensors.occupancy_level} (${room.sensors.occupancy_count})`;
  card.hudTemperature.textContent = `🌡️ ${Math.round(Number(sensors.temperature || 0))} °C`;
  card.hudLight.textContent = `💡 ${Math.round(Number(sensors.ambient_light || 0))}%`;
  const occupancyStepper = card.root.querySelector(`#occupancy-stepper-${room.id}`);
  if (occupancyStepper) {
    occupancyStepper.textContent = String(room.sensors.occupancy_count);
  }
  if (card.occupancyDown) {
    card.occupancyDown.disabled = Number(room.sensors.occupancy_count) <= 0;
  }
  if (card.occupancyUp) {
    card.occupancyUp.disabled = Number(room.sensors.occupancy_count) >= MAX_OCCUPANCY;
  }
  animateMetricValue(card.roomPower, Number(room.metrics.power_tokens || 0), { suffix: " tok", decimals: 0 });
  primeLiveMeter(card.roomCost, Number(room.metrics.billing_tokens || 0), Number(room.metrics.rate_tokens || 0), " tok");

  card.lightToggle.classList.toggle("on", lightOn);
  card.lightToggle.dataset.level = lightOn
    ? "0"
    : String(getStoredSetpoint(card.scope, room.id, "light", explicitLightToggleLevel(room)));
  card.lightToggle.disabled = false;

  card.fanToggle.classList.toggle("on", fanSwitchOn);
  card.fanToggle.dataset.level = fanSwitchOn
    ? "0"
    : String(getStoredSetpoint(card.scope, room.id, "fan", recommendedFanStartupLevel(room)));
  card.fanToggle.dataset.resume = fanSwitchOn ? "false" : "true";
  card.fanToggle.disabled = false;

  updateSlider(card.root, room.id, "temperature", sensors.temperature, "°C", false);
  updateSlider(card.root, room.id, "ambient_light", sensors.ambient_light, "%", false);
  const occupancyValue = card.root.querySelector(`#sensor-value-${room.id}-occupancy_count`);
  if (occupancyValue) {
    occupancyValue.textContent = `${Math.round(Number(sensors.occupancy_count))}`;
  }
  if (optimizationSession) {
    if (card.lightSlider) {
      stopSliderAnimation(card.lightSlider);
      card.lightSlider.dataset.userAdjusting = "false";
      card.lightSlider.dataset.syncPending = "false";
      card.lightSlider.value = String(Math.round(Number(effectiveLight.brightness || 0)));
      const lightValueNode = card.root.querySelector(`#device-value-${room.id}-light`);
      if (lightValueNode) {
        lightValueNode.textContent = `${Math.round(Number(effectiveLight.brightness || 0))}%`;
      }
    }
    if (card.fanSlider) {
      stopSliderAnimation(card.fanSlider);
      card.fanSlider.dataset.userAdjusting = "false";
      card.fanSlider.dataset.syncPending = "false";
      card.fanSlider.value = String(Math.round(Number(effectiveFan.speed_percent || 0)));
      const fanValueNode = card.root.querySelector(`#device-value-${room.id}-fan`);
      if (fanValueNode) {
        fanValueNode.textContent = `${Math.round(Number(effectiveFan.speed_percent || 0))}%`;
      }
    }
  } else {
    updateSlider(card.root, room.id, "light", effectiveLight.brightness, "%", !lightOn, true, {
      animate: true,
    });
    updateSlider(card.root, room.id, "fan", effectiveFan.speed_percent, "%", false, true, {
      animate: true,
      onFrame: (animatedValue) => {
        card.fanRotor.style.animationDuration = fanDuration(animatedValue);
      },
    });
  }

  card.fanRotor.style.animationPlayState = fanOn ? "running" : "paused";

  card.leds.forEach((led) => {
    led.classList.toggle("on", lightOn);
    led.style.opacity = lightOn ? String(Math.max(0.35, effectiveLight.brightness / 100)) : "0.55";
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
    const isUserAdjusting = slider.dataset.userAdjusting === "true"
      || slider.dataset.syncPending === "true"
      || document.activeElement === slider;
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

function stopMetricAnimation(node) {
  const animationKey = node.id || node.textContent;
  const existing = metricAnimations.get(animationKey);
  if (existing) {
    cancelAnimationFrame(existing);
    metricAnimations.delete(animationKey);
  }
}

function primeLiveMeter(node, baseValue, ratePerHour, suffix) {
  if (!node) {
    return;
  }
  stopMetricAnimation(node);
  const safeBase = Number(baseValue || 0);
  const existingValue = Number(node.dataset.numericValue || safeBase);
  const monotonicBase = Math.max(existingValue, safeBase);
  node.dataset.liveBase = String(monotonicBase);
  node.dataset.liveRate = String(Number(ratePerHour || 0));
  node.dataset.numericValue = String(monotonicBase);
  node.textContent = `${monotonicBase.toFixed(1)}${suffix}`;
}

function updateLiveMeterRate(node, ratePerHour, suffix) {
  if (!node) {
    return;
  }
  stopMetricAnimation(node);
  const currentVisible = Number(node.dataset.numericValue || node.dataset.liveBase || 0);
  node.dataset.liveBase = String(currentVisible);
  node.dataset.liveRate = String(Number(ratePerHour || 0));
  node.dataset.numericValue = String(currentVisible);
  node.textContent = `${currentVisible.toFixed(1)}${suffix}`;
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
  if (room.scope === "industry") {
    return optimizedTargetsForRoom(room).fan;
  }
  const policyTarget = Number(room.devices.fan.policy?.auto_target_percent || 0);
  if (policyTarget > 0) {
    return Math.round(policyTarget);
  }
  return optimizedTargetsForRoom(room).fan;
}

function recommendedLightStartupLevel(room) {
  return optimizedTargetsForRoom(room).light;
}

function explicitLightToggleLevel(room) {
  const recommended = recommendedLightStartupLevel(room);
  return recommended > 0 ? recommended : 12;
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

function applyFanVisualPreview(card, speedPercent, switchOn = true) {
  const value = Math.max(0, Math.min(100, Number(speedPercent || 0)));
  card.fanStatus.textContent = `${value}% ${switchOn || value > 0 ? "preview" : "off"}`;
  card.fanToggle.classList.toggle("on", !!switchOn);
  card.fanRotor.style.animationDuration = fanDuration(value);
  card.fanRotor.style.animationPlayState = switchOn ? "running" : "paused";
  card.fanSlider.value = String(value);
  const fanValueNode = card.root.querySelector(`#device-value-${card.root.dataset.roomId}-fan`);
  if (fanValueNode) {
    fanValueNode.textContent = `${value}%`;
  }
}

function applyLightVisualPreview(card, brightness, switchOn = true) {
  const value = Math.max(0, Math.min(100, Number(brightness || 0)));
  const isOn = !!switchOn;
  const roomColor = getComputedStyle(card.root).getPropertyValue("--light-color").trim() || "#ffd36b";
  card.lightStatus.textContent = `${value}% brightness`;
  card.lightToggle.classList.toggle("on", isOn);
  card.root.classList.toggle("light-on", isOn && value > 0);
  card.root.style.setProperty("--room-glow", hexToRgba(roomColor, isOn ? Math.max(0.08, value / 100) : 0.03));
  card.root.style.setProperty("--room-glow-soft", hexToRgba(roomColor, isOn ? Math.max(0.06, value / 260) : 0.02));
  card.lightSlider.value = String(value);
  const lightValueNode = card.root.querySelector(`#device-value-${card.root.dataset.roomId}-light`);
  if (lightValueNode) {
    lightValueNode.textContent = `${value}%`;
  }
  card.leds.forEach((led) => {
    led.classList.toggle("on", isOn && value > 0);
    led.style.opacity = isOn ? String(Math.max(0.2, value / 100)) : "0.28";
  });
}

function calculateSnapshotMetricsForUI(rooms, tariff) {
  const roomEntries = Object.values(rooms);
  const roomMetrics = {};
  let activePower = 0;
  let sessionCost = 0;
  roomEntries.forEach((room) => {
    const power = estimateRoomPowerForUI(room);
    const hourly = Number(((power / 1000) * tariff).toFixed(2));
    const powerTokens = Number((power * UI_POWER_TOKEN_SCALE).toFixed(1));
    const rateTokens = Number((hourly * UI_BILLING_RATE_TOKEN_SCALE).toFixed(1));
    const runtimeBias = 0.18 + (Number(room.devices.fan.speed_percent || 0) / 1500) + (Number(room.devices.light.brightness || 0) / 1800);
    const roomSession = Number((rateTokens * (0.08 + runtimeBias)).toFixed(1));
    roomMetrics[room.id] = {
      active_power_watts: Number(power.toFixed(2)),
      hourly_cost_inr: hourly,
      session_cost_inr: Number((hourly * (1 + runtimeBias)).toFixed(2)),
      power_tokens: powerTokens,
      rate_tokens: rateTokens,
      session_tokens: roomSession,
      billing_tokens: roomSession,
      daily_projection_tokens: Number((rateTokens * 24).toFixed(1)),
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
      session_cost_inr: Number((sessionCost / 88).toFixed(2)),
      daily_cost_projection_inr: Number((hourlyCost * 24).toFixed(2)),
      power_tokens: Number((activePower * UI_POWER_TOKEN_SCALE).toFixed(1)),
      rate_tokens: Number((hourlyCost * UI_BILLING_RATE_TOKEN_SCALE).toFixed(1)),
      session_tokens: Number(sessionCost.toFixed(1)),
      billing_tokens: Number(sessionCost.toFixed(1)),
      daily_projection_tokens: Number((hourlyCost * UI_BILLING_RATE_TOKEN_SCALE * 24).toFixed(1)),
    },
  };
}

function previewMetricsForRoom(roomId, overrides = {}) {
  if (!latestSnapshot || !latestRooms.has(roomId)) {
    return;
  }
  const scope = "home";
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
  const fanSensorPreview = (
    overrides.temperature !== undefined
    || overrides.occupancy_count !== undefined
  );
  const lightSensorPreview = (
    overrides.ambient_light !== undefined
    || overrides.occupancy_count !== undefined
  );
  const fanHeld = targetRoom.devices.fan.policy?.state === "hold";
  const lightHeld = targetRoom.devices.light.policy?.state === "hold";
  const fanOffLocked = isManualOffLocked(scope, roomId, "fan");
  const lightOffLocked = isManualOffLocked(scope, roomId, "light");
  const card = roomElements.get(roomId);
  if (fanSensorPreview && !fanHeld) {
    const predictedFan = recommendedFanStartupLevel(targetRoom);
    setStoredSetpoint(scope, roomId, "fan", predictedFan);
    if (!fanOffLocked) {
      targetRoom.devices.fan.speed_percent = predictedFan;
      targetRoom.devices.fan.state = "ON";
    }
    if (card && !fanOffLocked) {
      applyFanVisualPreview(card, predictedFan, true);
    }
  }
  if (lightSensorPreview && !lightHeld) {
    const predictedLight = recommendedLightStartupLevel(targetRoom);
    setStoredSetpoint(scope, roomId, "light", predictedLight);
    if (!lightOffLocked) {
      targetRoom.devices.light.brightness = predictedLight;
      targetRoom.devices.light.state = "ON";
    }
    if (card && !lightOffLocked) {
      applyLightVisualPreview(card, predictedLight, true);
    }
  }
  const { roomMetrics, globalMetrics } = calculateSnapshotMetricsForUI(projectedRooms, tariff);
  Object.entries(roomMetrics).forEach(([id, metric]) => {
    const card = roomElements.get(id);
    if (!card) {
      return;
    }
    animateMetricValue(card.roomPower, metric.power_tokens, { suffix: " tok", decimals: 0 });
    updateLiveMeterRate(card.roomCost, metric.rate_tokens, " tok");
  });
  animateMetricValue(document.getElementById("activePower"), Number(globalMetrics.power_tokens || 0), { suffix: " tok", decimals: 0 });
  animateMetricValue(document.getElementById("hourlyCost"), Number(globalMetrics.rate_tokens || 0), { suffix: " tok/hr", decimals: 0 });
  updateLiveMeterRate(document.getElementById("sessionCost"), Number(globalMetrics.rate_tokens || 0), " tok");
  animateMetricValue(document.getElementById("dailyCost"), Number(globalMetrics.daily_projection_tokens || 0), { suffix: " tok", decimals: 0 });
  renderDashboard(buildDashboardPreview(projectedRooms, roomMetrics, globalMetrics), homeDashboardState, {
    summaryId: "dashboardSummary",
    savingsId: "dashboardOptimizationSavings",
    scope: "home",
    comparisonId: "roomComparisonChart",
    trendChartId: "hourlyTrendChart",
    trendTitleId: "trendChartTitle",
    trendSubtitleId: "trendChartSubtitle",
    recommendationsId: "recommendationsPanel",
    inefficienciesId: "inefficiencyPanel",
  });
}

function tickLiveTokenMeters() {
  if (!latestSnapshotRenderedAt) {
    return;
  }
  const elapsedSeconds = Math.max(0, (performance.now() - latestSnapshotRenderedAt) / 1000);
  const globalMeter = document.getElementById("sessionCost");
  if (globalMeter) {
    const base = Number(globalMeter.dataset.liveBase || 0);
    const rate = Number(globalMeter.dataset.liveRate || 0);
    const nextValue = base + ((rate / 3600) * elapsedSeconds);
    globalMeter.dataset.numericValue = String(nextValue);
    globalMeter.textContent = `${nextValue.toFixed(1)} tok`;
  }
  const homeSavingsMeter = document.getElementById("dashboardOptimizationSavings");
  if (homeSavingsMeter) {
    const snapshot = getOptimizationSavingsSnapshot("home");
    homeSavingsMeter.dataset.numericValue = String(snapshot.accrued);
    homeSavingsMeter.textContent = `${snapshot.accrued.toFixed(1)} tok`;
  }
  roomElements.forEach((card) => {
    const base = Number(card.roomCost.dataset.liveBase || 0);
    const rate = Number(card.roomCost.dataset.liveRate || 0);
    const nextValue = base + ((rate / 3600) * elapsedSeconds);
    card.roomCost.dataset.numericValue = String(nextValue);
    card.roomCost.textContent = `${nextValue.toFixed(1)} tok`;
  });
  industryRoomElements.forEach((card) => {
    const industryElapsedSeconds = latestIndustryRenderedAt
      ? Math.max(0, (performance.now() - latestIndustryRenderedAt) / 1000)
      : elapsedSeconds;
    const base = Number(card.roomCost.dataset.liveBase || 0);
    const rate = Number(card.roomCost.dataset.liveRate || 0);
    const nextValue = base + ((rate / 3600) * industryElapsedSeconds);
    card.roomCost.dataset.numericValue = String(nextValue);
    card.roomCost.textContent = `${nextValue.toFixed(1)} tok`;
  });
  const industryMeter = document.getElementById("industrySessionCost");
  if (industryMeter) {
    const industryElapsedSeconds = latestIndustryRenderedAt
      ? Math.max(0, (performance.now() - latestIndustryRenderedAt) / 1000)
      : elapsedSeconds;
    const base = Number(industryMeter.dataset.liveBase || 0);
    const rate = Number(industryMeter.dataset.liveRate || 0);
    const nextValue = base + ((rate / 3600) * industryElapsedSeconds);
    industryMeter.dataset.numericValue = String(nextValue);
    industryMeter.textContent = `${nextValue.toFixed(1)} tok`;
  }
  const industrySavingsMeter = document.getElementById("industryDashboardOptimizationSavings");
  if (industrySavingsMeter) {
    const snapshot = getOptimizationSavingsSnapshot("industry");
    industrySavingsMeter.dataset.numericValue = String(snapshot.accrued);
    industrySavingsMeter.textContent = `${snapshot.accrued.toFixed(1)} tok`;
  }
}

function applyIndustrySensorResponse(room, changedSensorKey = "occupancy_count") {
  const shouldUpdateFan = changedSensorKey === "temperature" || changedSensorKey === "occupancy_count";
  const shouldUpdateLight = changedSensorKey === "ambient_light" || changedSensorKey === "occupancy_count";

  if (shouldUpdateFan) {
    const predictedFan = recommendedFanStartupLevel(room);
    setStoredSetpoint("industry", room.id, "fan", predictedFan);
    if (!isManualOffLocked("industry", room.id, "fan")) {
      room.devices.fan.speed_percent = predictedFan;
      room.devices.fan.state = "ON";
      room.devices.fan.speed = fanBandFromPercent(predictedFan);
    }
  }

  if (shouldUpdateLight) {
    const predictedLight = recommendedLightStartupLevel(room);
    setStoredSetpoint("industry", room.id, "light", predictedLight);
    if (!isManualOffLocked("industry", room.id, "light")) {
      room.devices.light.brightness = predictedLight;
      room.devices.light.state = "ON";
    }
  }
}

function explicitIndustryLightLevel(room) {
  return Math.max(18, recommendedLightStartupLevel(room));
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function roomProfileKey(room) {
  return room.optimization_profile || room.id || "living_room";
}

function clampTarget(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function cloneRoomForPowerEstimate(room) {
  return {
    ...room,
    sensors: { ...room.sensors },
    devices: {
      light: { ...room.devices.light },
      fan: { ...room.devices.fan, policy: { ...(room.devices.fan.policy || {}) } },
    },
  };
}

function estimateOptimizationSavingsRate(room, targets, tariff) {
  const beforeRoom = cloneRoomForPowerEstimate(room);
  const afterRoom = cloneRoomForPowerEstimate(room);
  afterRoom.devices.fan.state = targets.fan > 0 ? "ON" : "OFF";
  afterRoom.devices.fan.speed_percent = targets.fan;
  afterRoom.devices.fan.speed = fanBandFromPercent(targets.fan);
  afterRoom.devices.light.state = targets.light > 0 ? "ON" : "OFF";
  afterRoom.devices.light.brightness = targets.light;
  const beforePower = estimateRoomPowerForUI(beforeRoom);
  const afterPower = estimateRoomPowerForUI(afterRoom);
  const savingsPower = Math.max(0, beforePower - afterPower);
  const hourlyCostSavings = (savingsPower / 1000) * Number(tariff || 8);
  return Number((hourlyCostSavings * UI_BILLING_RATE_TOKEN_SCALE).toFixed(1));
}

function rollOptimizationSavings(scope) {
  const runtime = optimizationSavingsRuntime[scope];
  if (!runtime) {
    return;
  }
  const now = performance.now();
  if (!runtime.nextBumpAt) {
    runtime.nextBumpAt = now + nextOptimizationSavingsDelayMs();
  }
  while (now >= runtime.nextBumpAt) {
    runtime.accrued = Number((runtime.accrued + nextOptimizationSavingsBump()).toFixed(1));
    runtime.nextBumpAt += nextOptimizationSavingsDelayMs();
  }
  runtime.lastUpdatedAt = now;
}

function nextOptimizationSavingsDelayMs() {
  return 1000 + Math.random() * 3000;
}

function nextOptimizationSavingsBump() {
  return Number((0.1 + Math.random() * 0.2).toFixed(1));
}

function setOptimizationSavingsRate(scope, roomId, ratePerHour) {
  const runtime = optimizationSavingsRuntime[scope];
  if (!runtime) {
    return;
  }
  rollOptimizationSavings(scope);
  runtime.roomRates.set(roomId, Number(ratePerHour || 0));
  runtime.ratePerHour = [...runtime.roomRates.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  persistOptimizationSavings(scope);
}

function getOptimizationSavingsSnapshot(scope) {
  const runtime = optimizationSavingsRuntime[scope];
  if (!runtime) {
    return { accrued: 0, ratePerHour: 0 };
  }
  rollOptimizationSavings(scope);
  return {
    accrued: runtime.accrued,
    ratePerHour: runtime.ratePerHour,
  };
}

function hydrateOptimizationSavings(persisted) {
  if (optimizationSavingsHydrated || !persisted) {
    return;
  }
  Object.entries(persisted).forEach(([scope, value]) => {
    const runtime = optimizationSavingsRuntime[scope];
    if (!runtime) {
      return;
    }
    runtime.accrued = Number(value?.accrued_tokens || 0);
    runtime.ratePerHour = Number(value?.rate_per_hour || 0);
    runtime.lastUpdatedAt = performance.now();
    runtime.nextBumpAt = runtime.lastUpdatedAt + nextOptimizationSavingsDelayMs();
  });
  optimizationSavingsHydrated = true;
}

async function persistOptimizationSavings(scope) {
  const runtime = optimizationSavingsRuntime[scope];
  if (!runtime) {
    return;
  }
  rollOptimizationSavings(scope);
  try {
    await fetchJSON("/api/optimization-savings", {
      method: "POST",
      body: JSON.stringify({
        scope,
        accrued_tokens: runtime.accrued,
        rate_per_hour: runtime.ratePerHour,
      }),
    });
  } catch (error) {
    console.error("[smart-home] failed to persist optimization savings", scope, error);
  }
}

function primeSavingsMeter(node, scope) {
  const snapshot = getOptimizationSavingsSnapshot(scope);
  primeLiveMeter(node, snapshot.accrued, snapshot.ratePerHour, " tok");
}

function biasedInitialLevel(scope, roomId, deviceKind, baseValue) {
  const key = deviceStateKey(scope, roomId, `${deviceKind}:initial`);
  if (!roomInitializationBias.has(key)) {
    roomInitializationBias.set(key, Math.random() * 0.3);
  }
  const optimizedValue = Number(baseValue || 0);
  const biasRatio = Number(roomInitializationBias.get(key) || 0);
  const biasedValue = optimizedValue + (optimizedValue * biasRatio);
  return clampTarget(Math.min(100, biasedValue));
}

function applyDemoInitializationBiasToRoom(room, scope) {
  const initKey = deviceStateKey(scope, room?.id, "initialized");
  if (!room || roomInitializationBias.get(initKey) === true) {
    return;
  }
  const fanLevel = Number(room.devices?.fan?.speed_percent || 0);
  const lightLevel = Number(room.devices?.light?.brightness || 0);
  if (room.devices?.fan?.state === "ON" && fanLevel > 0) {
    room.devices.fan.speed_percent = biasedInitialLevel(scope, room.id, "fan", fanLevel);
    room.devices.fan.speed = fanBandFromPercent(room.devices.fan.speed_percent);
  }
  if (room.devices?.light?.state === "ON" && lightLevel > 0) {
    room.devices.light.brightness = biasedInitialLevel(scope, room.id, "light", lightLevel);
  }
  roomInitializationBias.set(initKey, true);
}

function optimizedTargetsForRoom(room) {
  const occupancy = Number(room.sensors.occupancy_count || 0);
  const temperature = Number(room.sensors.temperature || 0);
  const ambientLight = Number(room.sensors.ambient_light || 0);
  const occupied = occupancy > 0;
  let fanTarget = 0;
  let lightTarget = 0;

  if (occupied) {
    const occupancyBoost = occupancy >= 6 ? 16 : occupancy >= 4 ? 12 : occupancy >= 2 ? 8 : 3;
    if (temperature >= 39) fanTarget = 86 + occupancyBoost;
    else if (temperature >= 35) fanTarget = 72 + occupancyBoost;
    else if (temperature >= 32) fanTarget = 58 + occupancyBoost;
    else if (temperature >= 29) fanTarget = 46 + occupancyBoost;
    else if (temperature >= 26) fanTarget = 34 + occupancyBoost;
    else if (temperature >= 23) fanTarget = 24 + Math.round(occupancyBoost * 0.75);
    else fanTarget = 18 + Math.round(occupancyBoost * 0.5);

    if (ambientLight <= 12) lightTarget = 74 + occupancyBoost;
    else if (ambientLight <= 25) lightTarget = 58 + occupancyBoost;
    else if (ambientLight <= 42) lightTarget = 42 + Math.round(occupancyBoost * 0.8);
    else if (ambientLight <= 60) lightTarget = 24 + Math.round(occupancyBoost * 0.6);
    else lightTarget = 12 + Math.round(occupancyBoost * 0.4);
  } else {
    if (temperature >= 38) fanTarget = 34;
    else if (temperature >= 34) fanTarget = 24;
    else if (temperature >= 30) fanTarget = 16;
    else fanTarget = 0;

    if (ambientLight <= 16) lightTarget = 14;
    else if (ambientLight <= 28) lightTarget = 8;
    else lightTarget = 0;
  }

  return {
    fan: clampTarget(fanTarget),
    light: clampTarget(lightTarget),
  };
}

function setRoomOverlay(card, title, visible) {
  if (!card?.overlay || !card?.overlayTitle) {
    return;
  }
  card.overlayTitle.textContent = title;
  card.overlay.hidden = !visible;
  card.overlay.classList.toggle("visible", visible);
  card.root.classList.toggle("optimizing", visible);
}

function updateOptimizationSession(key, next) {
  const current = roomOptimizationSessions.get(key) || {};
  roomOptimizationSessions.set(key, { ...current, ...next });
}

function easeSequence(fromValue, toValue, steps = 16) {
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    points.push(Math.round(fromValue + (toValue - fromValue) * eased));
  }
  return points;
}

function optimizationStepDelay(index, steps) {
  const progress = index / Math.max(1, steps - 1);
  return 140 + Math.round((1 - progress) * 120);
}

function seededOptimizationStart(currentValue, targetValue) {
  if (currentValue > 0 || targetValue <= 0) {
    return currentValue;
  }
  if (targetValue >= 55) {
    return 18;
  }
  if (targetValue >= 28) {
    return 12;
  }
  return 8;
}

function optimizationTargetsForActiveDevices(room) {
  const optimized = optimizedTargetsForRoom(room);
  const fanActive = room.devices?.fan?.state === "ON";
  const lightActive = room.devices?.light?.state === "ON";
  return {
    fan: fanActive ? optimized.fan : Number(room.devices?.fan?.speed_percent || 0),
    light: lightActive ? optimized.light : Number(room.devices?.light?.brightness || 0),
    fanActive,
    lightActive,
  };
}

function driveOptimizationVisual(card, roomId, fanPercent, lightPercent, fanOn, lightOn) {
  if (card.fanSlider) {
    stopSliderAnimation(card.fanSlider);
    card.fanSlider.dataset.userAdjusting = "false";
    card.fanSlider.dataset.syncPending = "false";
    card.fanSlider.value = String(Math.round(Number(fanPercent || 0)));
    const fanValueNode = card.root.querySelector(`#device-value-${roomId}-fan`);
    if (fanValueNode) {
      fanValueNode.textContent = `${Math.round(Number(fanPercent || 0))}%`;
    }
  }
  if (card.lightSlider) {
    stopSliderAnimation(card.lightSlider);
    card.lightSlider.dataset.userAdjusting = "false";
    card.lightSlider.dataset.syncPending = "false";
    card.lightSlider.value = String(Math.round(Number(lightPercent || 0)));
    const lightValueNode = card.root.querySelector(`#device-value-${roomId}-light`);
    if (lightValueNode) {
      lightValueNode.textContent = `${Math.round(Number(lightPercent || 0))}%`;
    }
  }
  applyFanVisualPreview(card, fanPercent, fanOn);
  applyLightVisualPreview(card, lightPercent, lightOn);
}

async function animateHomeOptimization(roomId, card, room, targets) {
  const key = `${card.scope}:${roomId}`;
  const currentFan = seededOptimizationStart(Number(room.devices.fan.speed_percent || 0), targets.fan);
  const currentLight = seededOptimizationStart(Number(room.devices.light.brightness || 0), targets.light);
  const fanFrames = easeSequence(currentFan, targets.fan, 16);
  const lightFrames = easeSequence(currentLight, targets.light, 16);
  const frameCount = Math.max(fanFrames.length, lightFrames.length);
  updateOptimizationSession(key, {
    title: "Analyzing previous trends...",
    fanPercent: currentFan,
    lightPercent: currentLight,
    fanOn: targets.fanActive,
    lightOn: targets.lightActive,
  });
  driveOptimizationVisual(card, roomId, currentFan, currentLight, targets.fanActive, targets.lightActive);
  updateRoomCard(card, room);
  await sleep(650);
  updateOptimizationSession(key, { title: "Optimizing..." });
  for (let index = 0; index < frameCount; index += 1) {
    const nextFan = fanFrames[Math.min(index, fanFrames.length - 1)];
    const nextLight = lightFrames[Math.min(index, lightFrames.length - 1)];
    updateOptimizationSession(key, {
      title: "Optimizing...",
      fanPercent: nextFan,
      lightPercent: nextLight,
      fanOn: targets.fanActive,
      lightOn: targets.lightActive,
    });
    driveOptimizationVisual(card, roomId, nextFan, nextLight, targets.fanActive, targets.lightActive);
    updateRoomCard(card, room);
    const preview = {};
    if (targets.fanActive) {
      preview.fan_speed_percent = nextFan;
      preview.fan_state = "ON";
    }
    if (targets.lightActive) {
      preview.light_brightness = nextLight;
      preview.light_state = "ON";
    }
    previewMetricsForRoom(roomId, preview);
    await sleep(optimizationStepDelay(index, frameCount));
  }
  if (targets.fanActive) {
    await applyDeviceControl(room.devices.fan.id, targets.fan, { preserve_on_zero: false });
  }
  if (targets.lightActive) {
    await applyDeviceControl(room.devices.light.id, targets.light, { preserve_on_zero: false });
  }
}

async function animateIndustryOptimization(roomId, card, room, targets) {
  const key = `${card.scope}:${roomId}`;
  const currentFan = seededOptimizationStart(Number(room.devices.fan.speed_percent || 0), targets.fan);
  const currentLight = seededOptimizationStart(Number(room.devices.light.brightness || 0), targets.light);
  const fanFrames = easeSequence(currentFan, targets.fan, 16);
  const lightFrames = easeSequence(currentLight, targets.light, 16);
  const frameCount = Math.max(fanFrames.length, lightFrames.length);
  updateOptimizationSession(key, {
    title: "Analyzing previous trends...",
    fanPercent: currentFan,
    lightPercent: currentLight,
    fanOn: targets.fanActive,
    lightOn: targets.lightActive,
  });
  driveOptimizationVisual(card, roomId, currentFan, currentLight, targets.fanActive, targets.lightActive);
  updateRoomCard(card, room);
  await sleep(650);
  updateOptimizationSession(key, { title: "Optimizing..." });
  for (let index = 0; index < frameCount; index += 1) {
    const nextFan = fanFrames[Math.min(index, fanFrames.length - 1)];
    const nextLight = lightFrames[Math.min(index, lightFrames.length - 1)];
    updateOptimizationSession(key, {
      title: "Optimizing...",
      fanPercent: nextFan,
      lightPercent: nextLight,
      fanOn: targets.fanActive,
      lightOn: targets.lightActive,
    });
    driveOptimizationVisual(card, roomId, nextFan, nextLight, targets.fanActive, targets.lightActive);
    updateIndustryRoom(roomId, (targetRoom) => {
      if (targets.fanActive) {
        targetRoom.devices.fan.state = "ON";
        targetRoom.devices.fan.speed_percent = nextFan;
        targetRoom.devices.fan.speed = fanBandFromPercent(nextFan);
      }
      if (targets.lightActive) {
        targetRoom.devices.light.state = "ON";
        targetRoom.devices.light.brightness = nextLight;
      }
    });
    await sleep(optimizationStepDelay(index, frameCount));
  }
}

async function startRoomOptimization(roomId, scope) {
  const key = `${scope}:${roomId}`;
  if (roomOptimizationSessions.has(key)) {
    return;
  }
  const elementMap = scope === "industry" ? industryRoomElements : roomElements;
  const initialCard = elementMap.get(roomId);
  if (!initialCard) {
    return;
  }
  if (scope === "home") {
    await flushPendingRoomSensorSync(roomId, initialCard.root);
  }
  const baseRoom = scope === "industry" ? latestIndustryState?.rooms?.[roomId] : latestSnapshot?.rooms?.[roomId];
  cancelPendingRoomDeviceSync(baseRoom);
  const card = elementMap.get(roomId);
  const room = roomWithLiveInputs(baseRoom, card?.root || initialCard.root);
  if (!room) {
    return;
  }
  roomOptimizationSessions.set(key, {
    title: "Optimizing...",
    fanPercent: Number(room.devices.fan.speed_percent || 0),
    lightPercent: Number(room.devices.light.brightness || 0),
    fanOn: room.devices.fan.state === "ON",
    lightOn: room.devices.light.state === "ON",
  });
  updateRoomCard(card, room);
  const targets = optimizationTargetsForActiveDevices(room);
  const savingsRate = estimateOptimizationSavingsRate(
    room,
    targets,
    scope === "industry" ? latestIndustryState?.tariff : latestSnapshot?.tariff_inr_per_kwh
  );
  try {
    if (scope === "industry") {
      await animateIndustryOptimization(roomId, card, room, targets);
    } else {
      await animateHomeOptimization(roomId, card, room, targets);
    }
    updateOptimizationSession(key, {
      title: "Complete",
      fanPercent: targets.fan,
      lightPercent: targets.light,
      fanOn: targets.fanActive,
      lightOn: targets.lightActive,
    });
    setOptimizationSavingsRate(scope, roomId, savingsRate);
    updateRoomCard(card, room);
    await sleep(1000);
  } finally {
    roomOptimizationSessions.delete(key);
    if (scope === "industry") {
      renderIndustrySnapshot();
    } else if (latestSnapshot?.rooms?.[roomId]) {
      updateRoomCard(card, latestSnapshot.rooms[roomId]);
    }
  }
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
      energy_kwh: Number(((roomMetrics[room.id].power_tokens * 4.2) / 1000).toFixed(2)),
      cost_inr: Number((roomMetrics[room.id].rate_tokens * 0.12).toFixed(2)),
      avg_fan_percent: Number(room.devices.fan.speed_percent || 0),
      avg_light_percent: Number(room.devices.light.brightness || 0),
      occupancy_score: Number(room.sensors.occupancy_count || 0),
    }))
    .sort((left, right) => right.cost_inr - left.cost_inr);
  const peak = comparison[0] || { name: "Living Room" };
  const hottest = [...Object.values(rooms)]
    .sort((left, right) => Number(right.sensors.temperature || 0) - Number(left.sensors.temperature || 0))[0];
  const darkest = [...Object.values(rooms)]
    .sort((left, right) => Number(left.sensors.ambient_light || 0) - Number(right.sensors.ambient_light || 0))[0];
  const idleWaste = comparison
    .filter((item) => item.occupancy_score === 0 && (item.avg_light_percent > 10 || item.avg_fan_percent > 15))
    .map((item) => `${item.name}: active load with no occupancy`);
  const fanHeavyRooms = comparison
    .filter((item) => item.avg_fan_percent >= 65)
    .slice(0, 2)
    .map((item) => `${item.name}: fan is running at ${item.avg_fan_percent.toFixed(0)}%, check whether the thermal load is temporary`);
  const brightWhileLit = Object.values(rooms)
    .filter((room) => Number(room.sensors.ambient_light || 0) >= 58 && Number(room.devices.light.brightness || 0) >= 24)
    .slice(0, 2)
    .map((room) => `${room.name}: ambient light is already ${Math.round(Number(room.sensors.ambient_light || 0))}%, trim lighting to recover tokens`);
  const totalBase = Number(globalMetrics.rate_tokens || 0);
  const activeBase = Number(globalMetrics.power_tokens || 0);
  const recommendations = [
    `${peak.name} is leading current demand. A 10-15% trim would show the biggest savings.`,
    hottest ? `${hottest.name} is the hottest zone at ${Math.round(Number(hottest.sensors.temperature || 0))} °C, so ventilation should be prioritized there first.` : null,
    darkest ? `${darkest.name} has the lowest ambient light at ${Math.round(Number(darkest.sensors.ambient_light || 0))}%, making it the best candidate for lighting optimization.` : null,
    "This live preview updates as you move fan, light, and occupancy controls.",
  ].filter(Boolean);
  const inefficiencies = [
    ...idleWaste,
    ...fanHeavyRooms,
    ...brightWhileLit,
  ];
  return {
    summary: {
      total_energy_today_kwh: Number(((globalMetrics.power_tokens * 4.2) / 1000).toFixed(2)),
      total_cost_today_inr: Number((globalMetrics.rate_tokens * 0.5).toFixed(2)),
      highest_consuming_room: peak.name,
      peak_usage_hour: "Live",
      efficiency_score: Number(Math.max(58, 100 - globalMetrics.rate_tokens * 0.08).toFixed(1)),
      savings_opportunity_percent: Number(Math.min(26, Math.max(8, globalMetrics.rate_tokens * 0.1)).toFixed(1)),
    },
    room_comparison: comparison,
    trends: {
      hourly: buildTrendSeries("hourly", comparison, totalBase, activeBase),
      daily: buildTrendSeries("daily", comparison, totalBase, activeBase),
      weekly: buildTrendSeries("weekly", comparison, totalBase, activeBase),
    },
    recommendations,
    inefficiencies: inefficiencies.length
      ? inefficiencies
      : [
          `${peak.name} currently has the heaviest live load, but no severe inefficiency flags are active.`,
          "System load is comparatively balanced right now; the next savings will come from trimming peak rooms rather than correcting waste.",
        ],
    policy_preview: [],
  };
}

function buildTrendSeries(window, comparison, totalRateTokens, totalPowerTokens) {
  const topRooms = comparison.slice(0, 3);
  const roomWeight = topRooms.length
    ? topRooms.reduce((sum, item) => sum + item.occupancy_score + (item.avg_fan_percent / 45) + (item.avg_light_percent / 55), 0) / topRooms.length
    : 1;
  const baseRate = Math.max(40, totalRateTokens || 40);
  const basePower = Math.max(30, totalPowerTokens || 30);
  const heatBias = topRooms.length
    ? topRooms.reduce((sum, item) => sum + item.avg_fan_percent, 0) / (topRooms.length * 100)
    : 0.35;
  const lightBias = topRooms.length
    ? topRooms.reduce((sum, item) => sum + item.avg_light_percent, 0) / (topRooms.length * 100)
    : 0.3;
  const occupancyBias = topRooms.length
    ? topRooms.reduce((sum, item) => sum + item.occupancy_score, 0) / (topRooms.length * 5)
    : 0.4;
  const shapes = {
    hourly: {
      labels: ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
      multipliers: [0.24, 0.18, 0.36, 0.62, 0.78, 0.7, 1.0, 0.66],
      subtitle: "Live room behavior across the day",
      scale: 1.0,
      offset: 0,
    },
    daily: {
      labels: ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      multipliers: [0.64, 0.7, 0.74, 0.82, 0.9, 1.06, 0.86],
      subtitle: "Daily load and billing progression",
      scale: 3.1,
      offset: 0.08,
    },
    weekly: {
      labels: ["Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Week 6"],
      multipliers: [0.54, 0.68, 0.74, 0.88, 1.04, 0.96],
      subtitle: "Weekly optimization and usage drift",
      scale: 7.4,
      offset: 0.16,
    },
  };
  const selected = shapes[window] || shapes.hourly;
  const points = selected.labels.map((label, index) => {
    const shape = selected.multipliers[index];
    const dynamicBias = (
      (heatBias * 0.22) +
      (lightBias * 0.16) +
      (occupancyBias * 0.18) +
      (roomWeight * 0.03)
    );
    const load = (shape + selected.offset + dynamicBias) * selected.scale;
    const value = Number((baseRate * load).toFixed(1));
    return {
      label,
      value,
      rate_tokens: value,
      power_tokens: Number((basePower * load * (0.92 + heatBias * 0.12)).toFixed(1)),
      activity: Number(((0.8 + occupancyBias) * shape * (window === "hourly" ? 2.3 : window === "daily" ? 3.6 : 5.2)).toFixed(1)),
    };
  });
  const peakPoint = points.reduce((peak, point) => (point.value > peak.value ? point : peak), points[0]);
  return {
    window,
    subtitle: selected.subtitle,
    points,
    peak_label: peakPoint.label,
  };
}

function normalizeDashboardPayload(dashboard) {
  const fallbackComparison = Array.isArray(dashboard?.room_comparison) ? dashboard.room_comparison : [];
  const summary = dashboard?.summary || {};
  const inferredRate = Number(summary.total_cost_today_inr || 0) * 2 || 60;
  const inferredPower = Number(summary.total_energy_today_kwh || 0) * 240 || 90;
  const trends = dashboard?.trends
    ? dashboard.trends
    : {
        hourly: buildTrendSeries("hourly", fallbackComparison, inferredRate, inferredPower),
        daily: buildTrendSeries("daily", fallbackComparison, inferredRate, inferredPower),
        weekly: buildTrendSeries("weekly", fallbackComparison, inferredRate, inferredPower),
      };
  return {
    summary,
    room_comparison: fallbackComparison,
    recommendations: dashboard?.recommendations || [],
    inefficiencies: dashboard?.inefficiencies || [],
    policy_preview: dashboard?.policy_preview || [],
    trends,
  };
}

function scaleDashboardValue(value, range = "today") {
  return range === "week" ? value * 7 : value;
}

function averageTrendLoad(series) {
  const points = series?.points || [];
  if (!points.length) {
    return 1;
  }
  const total = points.reduce((sum, point) => sum + Number(point.value || 0), 0);
  const peak = Math.max(1, ...points.map((point) => Number(point.value || 0)));
  return total / (points.length * peak);
}

function deriveWindowRoomComparison(roomComparison, trendSeries, trendWindow) {
  const windowFactor = {
    hourly: 0.42,
    daily: 1,
    weekly: 3.6,
  }[trendWindow] || 1;
  const trendBias = averageTrendLoad(trendSeries);
  return roomComparison.map((item, index) => {
    const rankBias = Math.max(0.84, 1 - (index * 0.035));
    const occupancyBias = 0.92 + (Number(item.occupancy_score || 0) * 0.05);
    const fanBias = 0.88 + (Number(item.avg_fan_percent || 0) / 220);
    const lightBias = 0.9 + (Number(item.avg_light_percent || 0) / 260);
    const blendedBias = Number(((occupancyBias + fanBias + lightBias) / 3).toFixed(3));
    return {
      ...item,
      energy_kwh: Number((Number(item.energy_kwh || 0) * windowFactor * trendBias * blendedBias * rankBias).toFixed(2)),
      cost_inr: Number((Number(item.cost_inr || 0) * windowFactor * trendBias * ((fanBias * 0.55) + (lightBias * 0.45)) * rankBias).toFixed(2)),
      occupancy_score: Number((Number(item.occupancy_score || 0) * (0.86 + trendBias * 0.38)).toFixed(1)),
    };
  });
}

function renderDashboard(dashboard, state, panelIds) {
  if (!dashboard) {
    return;
  }
  const normalizedDashboard = normalizeDashboardPayload(dashboard);
  const roomComparisonSource = normalizedDashboard.room_comparison || [];
  const filteredRoomComparison = roomComparisonSource.filter((item) => (
    state.roomFilter === "all" ? true : item.room_id === state.roomFilter
  ));
  const roomComparison = filteredRoomComparison.length ? filteredRoomComparison : roomComparisonSource;
  const metricAccessor = {
    cost: (item) => ({ value: item.cost_inr, label: `${scaleDashboardValue(item.cost_inr, state.range).toFixed(2)} bill tok` }),
    energy: (item) => ({ value: item.energy_kwh, label: `${scaleDashboardValue(item.energy_kwh, state.range).toFixed(2)} energy tok` }),
    fan: (item) => ({ value: item.avg_fan_percent, label: `${item.avg_fan_percent.toFixed(0)}% avg fan` }),
    light: (item) => ({ value: item.avg_light_percent, label: `${item.avg_light_percent.toFixed(0)}% avg light` }),
    occupancy: (item) => ({ value: item.occupancy_score, label: `${item.occupancy_score.toFixed(1)} persons` }),
  }[state.metricFilter];
  const summary = normalizedDashboard.summary || {};
  const trendSeries = normalizedDashboard.trends?.[state.trendWindow] || normalizedDashboard.trends?.hourly || { points: [], subtitle: "" };
  const trendLabel = {
    hourly: "Hourly trend",
    daily: "Daily trend",
    weekly: "Weekly trend",
  }[state.trendWindow] || "Trend";
  const windowAdjustedComparison = deriveWindowRoomComparison(roomComparison, trendSeries, state.trendWindow);
  document.getElementById(panelIds.summaryId).innerHTML = [
    summaryCard("Energy tokens", `${scaleDashboardValue(Number(summary.total_energy_today_kwh || 0), state.range).toFixed(2)} tok`),
    summaryCard("Bill tokens", `${scaleDashboardValue(Number(summary.total_cost_today_inr || 0), state.range).toFixed(2)} tok`),
    summaryCard("Optimization savings", "0.0 tok", panelIds.savingsId),
    summaryCard("Highest room", summary.highest_consuming_room || "N/A"),
    summaryCard("Peak usage", summary.peak_usage_hour || "N/A"),
    summaryCard("Efficiency", `${Number(summary.efficiency_score || 0).toFixed(1)} · Save ${Number(summary.savings_opportunity_percent || 0).toFixed(1)}%`),
  ].join("");
  if (panelIds.savingsId) {
    primeSavingsMeter(document.getElementById(panelIds.savingsId), panelIds.scope);
  }

  const roomChartData = windowAdjustedComparison.map((item) => {
    const metric = metricAccessor(item);
    return {
      label: item.name,
      value: metric.value,
      meta: metric.label,
    };
  });
  document.getElementById(panelIds.comparisonId).innerHTML = renderBarChartSvg(roomChartData, {
    height: 320,
    gradientId: `${panelIds.comparisonId}Gradient`,
  });

  const trendMetricValue = {
    cost: (item) => ({ value: scaleDashboardValue(item.rate_tokens, state.range), label: `${scaleDashboardValue(item.rate_tokens, state.range).toFixed(0)} bill tok/hr` }),
    energy: (item) => ({ value: scaleDashboardValue(item.power_tokens, state.range), label: `${scaleDashboardValue(item.power_tokens, state.range).toFixed(0)} power tok` }),
    fan: (item) => ({ value: item.activity * 18, label: `${Math.round(item.activity * 12)} fan load` }),
    light: (item) => ({ value: item.activity * 15, label: `${Math.round(item.activity * 10)} light load` }),
    occupancy: (item) => ({ value: item.activity, label: `${item.activity.toFixed(1)} activity` }),
  }[state.metricFilter];
  const trendChartData = trendSeries.points.map((item) => {
    const metric = trendMetricValue(item);
    return {
      label: item.label,
      value: metric.value,
      meta: metric.label,
    };
  });
  document.getElementById(panelIds.trendTitleId).textContent = trendLabel;
  document.getElementById(panelIds.trendSubtitleId).textContent = `${trendSeries.subtitle || "Adaptive room behavior"} · Peak ${trendSeries.peak_label || "N/A"}`;
  document.getElementById(panelIds.trendChartId).innerHTML = renderLineChartSvg(trendChartData, {
    height: 320,
    stroke: "#4a8f86",
    fill: "rgba(74, 143, 134, 0.14)",
    point: "#bd632f",
  });

  const selectedRoom = roomComparison[0]?.name || summary.highest_consuming_room || "Selected room";
  const adaptiveRecommendations = buildAdaptiveRecommendations({
    dashboard: normalizedDashboard,
    trendSeries,
    selectedRoom,
    trendWindow: state.trendWindow,
  });
  document.getElementById(panelIds.recommendationsId).innerHTML = [
    ...adaptiveRecommendations,
    ...(normalizedDashboard.policy_preview || []),
  ]
    .map((item) => `<div class="recommendation-item">${item}</div>`)
    .join("");

  document.getElementById(panelIds.inefficienciesId).innerHTML = (normalizedDashboard.inefficiencies || [])
    .map((item) => `<div class="recommendation-item">${item}</div>`)
    .join("");
}

function buildAdaptiveRecommendations({ dashboard, trendSeries, selectedRoom, trendWindow }) {
  const points = trendSeries.points || [];
  if (!points.length) {
    return dashboard.recommendations || [];
  }
  const peakPoint = points.reduce((peak, point) => (point.value > peak.value ? point : peak), points[0]);
  const lowPoint = points.reduce((low, point) => (point.value < low.value ? point : low), points[0]);
  const windowLabel = {
    hourly: "today",
    daily: "this week",
    weekly: "this cycle",
  }[trendWindow] || "the current trend";
  return [
    `${selectedRoom} is projected to peak around ${peakPoint.label} for ${windowLabel}.`,
    `${selectedRoom} has a softer demand window near ${lowPoint.label}; that is the best time to trim light or fan output.`,
    `Optimization leverage is currently highest in ${dashboard.summary?.highest_consuming_room || selectedRoom}.`,
  ];
}

function summaryCard(label, value, strongId = "") {
  const idAttr = strongId ? ` id="${strongId}"` : "";
  return `<div class="summary-chip"><span>${label}</span><strong${idAttr}>${value}</strong></div>`;
}

function escapeSvgText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortenChartLabel(label, maxLength = 12) {
  const compact = String(label ?? "")
    .replace(/\bAssembly\b/gi, "Asm")
    .replace(/\bLine\b/gi, "Ln")
    .replace(/\bFabrication\b/gi, "Fab")
    .replace(/\bControl\b/gi, "Ctrl")
    .replace(/\bPackaging\b/gi, "Pack")
    .replace(/\bMaintenance\b/gi, "Maint")
    .replace(/\bStorage\b/gi, "Store")
    .replace(/\bDispatch\b/gi, "Disp")
    .replace(/\bUtility\b/gi, "Util")
    .replace(/\bRoom\b/gi, "Rm")
    .replace(/\bLaboratory\b/gi, "Lab")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function splitLabelLines(label, maxLineLength = 10, maxLines = 2) {
  const words = shortenChartLabel(label, maxLineLength * maxLines).split(" ");
  if (!words.length) {
    return [""];
  }
  const lines = [];
  let current = "";
  words.forEach((word) => {
    if (!current.length) {
      current = word;
      return;
    }
    if (`${current} ${word}`.length <= maxLineLength) {
      current = `${current} ${word}`;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current.length) {
    lines.push(current);
  }
  if (lines.length > maxLines) {
    const visible = lines.slice(0, maxLines);
    visible[maxLines - 1] = shortenChartLabel(`${visible[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, maxLineLength);
    return visible;
  }
  return lines;
}

function renderSvgTextLines(x, y, lines, className, options = {}) {
  const lineHeight = options.lineHeight || 14;
  const anchor = options.anchor || "middle";
  const title = options.title ? `<title>${escapeSvgText(options.title)}</title>` : "";
  const tspans = lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeSvgText(line)}</tspan>`)
    .join("");
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${title}${tspans}</text>`;
}

function compactMetricLabel(label) {
  return String(label ?? "")
    .replace(/\bbill tok\/hr\b/gi, "tok/h")
    .replace(/\bbill tok\b/gi, "tok")
    .replace(/\benergy tok\b/gi, "eng")
    .replace(/\bpower tok\b/gi, "pwr")
    .replace(/\bpersons\b/gi, "ppl")
    .replace(/\bavg fan\b/gi, "fan")
    .replace(/\bavg light\b/gi, "light")
    .replace(/\s+/g, " ")
    .trim();
}

function renderBarChartSvg(data, options = {}) {
  if (!data.length) {
    return `<div class="chart-empty">No chart data yet.</div>`;
  }
  const width = Math.max(760, data.length * 92);
  const height = options.height || 320;
  const padding = { top: 28, right: 24, bottom: 92, left: 24 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...data.map((item) => item.value || 0));
  const gap = 22;
  const barWidth = Math.max(38, (innerWidth - gap * (data.length - 1)) / data.length);
  const bars = data
    .map((item, index) => {
      const scaledHeight = (item.value / maxValue) * innerHeight;
      const x = padding.left + index * (barWidth + gap);
      const y = padding.top + (innerHeight - scaledHeight);
      const axisLabel = renderSvgTextLines(
        x + barWidth / 2,
        height - 44,
        splitLabelLines(item.label, 10, 2),
        "svg-axis-label",
        { title: item.label }
      );
      const valueLabel = renderSvgTextLines(
        x + barWidth / 2,
        Math.max(20, y - 12),
        [compactMetricLabel(item.meta)],
        "svg-value-label",
        { title: item.meta }
      );
      return `
        <g class="chart-bar-group">
          <title>${escapeSvgText(`${item.label}: ${item.meta}`)}</title>
          <rect x="${x}" y="${y}" width="${barWidth}" height="${scaledHeight}" rx="16" fill="url(#${options.gradientId || "barGradient"})"></rect>
          ${axisLabel}
          ${valueLabel}
        </g>
      `;
    })
    .join("");
  const gridLines = [0.25, 0.5, 0.75, 1]
    .map((step) => {
      const y = padding.top + innerHeight - innerHeight * step;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="svg-grid-line"></line>`;
    })
    .join("");
  return `
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg" style="min-width:${width}px" role="img" aria-label="Room comparison chart">
        <defs>
          <linearGradient id="${options.gradientId || "barGradient"}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#bd632f"></stop>
            <stop offset="100%" stop-color="#4a8f86"></stop>
          </linearGradient>
        </defs>
        ${gridLines}
        ${bars}
      </svg>
    </div>
  `;
}

function renderLineChartSvg(data, options = {}) {
  if (!data.length) {
    return `<div class="chart-empty">No chart data yet.</div>`;
  }
  const width = Math.max(640, data.length * 100);
  const height = options.height || 320;
  const padding = { top: 24, right: 20, bottom: 62, left: 20 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...data.map((item) => item.value || 0));
  const stepX = data.length === 1 ? 0 : innerWidth / (data.length - 1);
  const points = data.map((item, index) => {
    const x = padding.left + index * stepX;
    const y = padding.top + innerHeight - ((item.value / maxValue) * innerHeight);
    return { ...item, x, y };
  });
  const linePath = buildSmoothPath(points);
  const areaPath = `${linePath} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`;
  const pointNodes = points
    .map((point, index) => {
      const placeBelow = index % 2 === 1;
      const pointLabelY = placeBelow ? Math.min(height - 84, point.y + 22) : Math.max(18, point.y - 12);
      return `
        <g class="chart-point-group">
          <title>${escapeSvgText(`${point.label}: ${point.meta}`)}</title>
          <circle cx="${point.x}" cy="${point.y}" r="5" fill="${options.point || "#bd632f"}"></circle>
          ${renderSvgTextLines(point.x, height - 24, [point.label], "svg-axis-label", { title: point.label })}
          ${renderSvgTextLines(point.x, pointLabelY, [compactMetricLabel(point.meta)], "svg-value-label", { title: point.meta })}
        </g>
      `;
    })
    .join("");
  const gridLines = [0.2, 0.4, 0.6, 0.8, 1]
    .map((step) => {
      const y = padding.top + innerHeight - innerHeight * step;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="svg-grid-line"></line>`;
    })
    .join("");
  return `
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg" style="min-width:${width}px" role="img" aria-label="Hourly trend chart">
        ${gridLines}
        <path d="${areaPath}" fill="${options.fill || "rgba(74, 143, 134, 0.12)"}"></path>
        <path d="${linePath}" fill="none" stroke="${options.stroke || "#4a8f86"}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
        ${pointNodes}
      </svg>
    </div>
  `;
}

function buildSmoothPath(points) {
  if (!points.length) {
    return "";
  }
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const controlX = (current.x + next.x) / 2;
    path += ` C ${controlX} ${current.y}, ${controlX} ${next.y}, ${next.x} ${next.y}`;
  }
  return path;
}

async function refreshDashboard() {
  try {
    const snapshot = await requestSnapshot("/api/system-state");
    if (snapshot) {
      renderSnapshot(snapshot);
    }
  } catch (error) {
    setNodeText("deviceMessage", `Failed to load system state: ${error.message}`);
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
    setNodeText("deviceMessage", `Automation refresh failed: ${error.message}`);
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
      pendingOccupancy.delete(roomId);
      renderSnapshot(snapshot);
    }
  } catch (error) {
    setNodeText("deviceMessage", error.message);
  } finally {
    root.querySelectorAll("[data-sensor-key]").forEach((input) => {
      input.dataset.syncPending = "false";
      input.dataset.userAdjusting = "false";
    });
  }
}

function roomWithLiveInputs(room, root) {
  if (!room || !root) {
    return room;
  }
  const fanSlider = root.querySelector(`[data-room-id="${room.id}"][data-device-kind="fan"]`);
  const lightSlider = root.querySelector(`[data-room-id="${room.id}"][data-device-kind="light"]`);
  const fanToggle = root.querySelector(`#fan-toggle-${room.id}`);
  const lightToggle = root.querySelector(`#light-toggle-${room.id}`);
  const occupancyStepper = root.querySelector(`#occupancy-stepper-${room.id}`);
  const liveRoom = {
    ...room,
    sensors: {
      ...room.sensors,
      temperature: Number(root.querySelector(`[data-sensor-key="temperature"]`)?.value ?? room.sensors.temperature),
      ambient_light: Number(root.querySelector(`[data-sensor-key="ambient_light"]`)?.value ?? room.sensors.ambient_light),
      occupancy_count: Number(occupancyStepper ? occupancyStepper.textContent : room.sensors.occupancy_count),
    },
    devices: {
      ...room.devices,
      fan: {
        ...room.devices.fan,
        speed_percent: Number(fanSlider?.value ?? room.devices.fan.speed_percent),
        state: (fanToggle?.classList.contains("on") ?? (Number(fanSlider?.value ?? room.devices.fan.speed_percent) > 0)) ? "ON" : "OFF",
      },
      light: {
        ...room.devices.light,
        brightness: Number(lightSlider?.value ?? room.devices.light.brightness),
        state: (lightToggle?.classList.contains("on") ?? (Number(lightSlider?.value ?? room.devices.light.brightness) > 0)) ? "ON" : "OFF",
      },
    },
  };
  liveRoom.sensors.occupancy_level = formatOccupancyLevel(Number(liveRoom.sensors.occupancy_count || 0));
  liveRoom.devices.fan.speed = fanBandFromPercent(Number(liveRoom.devices.fan.speed_percent || 0));
  return liveRoom;
}

async function flushPendingRoomSensorSync(roomId, root) {
  const timer = sensorSyncTimers.get(roomId);
  if (!timer || !root) {
    return;
  }
  clearTimeout(timer);
  sensorSyncTimers.delete(roomId);
  await updateRoomSensors(roomId, root);
}

function cancelPendingRoomDeviceSync(room) {
  if (!room) {
    return;
  }
  [room.devices?.fan?.id, room.devices?.light?.id].forEach((deviceId) => {
    const timer = deviceSyncTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      deviceSyncTimers.delete(deviceId);
    }
  });
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
    setNodeText("deviceMessage", error.message);
    await refreshDashboard();
  } finally {
    const slider = document.querySelector(`[data-device-id="${deviceId}"][data-device-kind="light"], [data-device-id="${deviceId}"][data-device-kind="fan"]`);
    if (slider) {
      slider.dataset.syncPending = "false";
      slider.dataset.userAdjusting = "false";
    }
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
    const isOn = input.closest(".room-card").querySelector(`[data-device-kind="light-toggle"]`)?.classList.contains("on") ?? (value > 0);
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
  const speakerState = assistState(roomId);
  card.voiceStatus.textContent =
    roomVoiceFeedback.get(roomId) || "";
  if (card.voiceDebug) {
    card.voiceDebug.textContent =
      roomVoiceDebug.get(roomId) || "No voice activity yet.";
  }
  card.speakerButton.classList.toggle(
    "listening",
    speakerState === "awaiting_reply" || speakerState === "capturing_reply"
  );
  card.speakerButton.classList.toggle(
    "processing",
    speakerState === "loading" || speakerState === "replying"
  );
  card.micButton.classList.toggle("listening", activeListeningRoomId === roomId);
  card.micButton.classList.toggle("processing", activeCommandProcessingRoomId === roomId);
  card.micButton.textContent =
    activeCommandProcessingRoomId === roomId
      ? "…"
      : activeListeningRoomId === roomId
        ? "◉"
        : "🎙";
  card.speakerButton.textContent =
    speakerState === "loading" || speakerState === "replying"
      ? "…"
      : speakerState === "awaiting_reply" || speakerState === "capturing_reply"
        ? "◉"
        : "🔊";
}

async function submitVoiceCommand(roomId, rawText) {
  const startedAt = performance.now();
  activeCommandProcessingRoomId = roomId;
  roomVoiceFeedback.set(roomId, `Heard: "${rawText}"`);
  roomVoiceDebug.set(
    roomId,
    `transcript: ${rawText}\nstatus: transcribed\nstatus: sending to command parser`
  );
  voiceLog("transcript", { roomId, rawText });
  paintVoiceStatus(roomId);
  try {
    const snapshot = await requestInteractiveSnapshot("/api/voice/command", {
      method: "POST",
      body: JSON.stringify({
        room_id: roomId,
        raw_text: rawText,
      }),
    });
    const debugPayload = snapshot.voice_debug || {};
    const elapsedMs = Math.round(performance.now() - startedAt);
    roomVoiceDebug.set(
      roomId,
      [
        `transcript: ${debugPayload.transcript || rawText}`,
        `status: parser response received in ${elapsedMs}ms`,
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
      elapsedMs,
      voiceDebug: debugPayload,
      command: snapshot.voice_command,
    });
    renderSnapshot(snapshot);
  } catch (error) {
    roomVoiceFeedback.set(roomId, `Voice parse failed: ${error.message}`);
    roomVoiceDebug.set(roomId, `transcript: ${rawText}\nerror: ${error.message}`);
    voiceError("parse:failed", { roomId, rawText, error: error.message });
    setNodeText("deviceMessage", error.message);
    await refreshDashboard();
  } finally {
    activeCommandProcessingRoomId = null;
    paintVoiceStatus(roomId);
  }
}

function speakText(text, callbacks = {}) {
  const { onend, onerror } = callbacks;
  if (!("speechSynthesis" in window) || !text) {
    if (onend) {
      onend();
    }
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.06;
  utterance.pitch = 1;
  utterance.onend = () => {
    if (onend) {
      onend();
    }
  };
  utterance.onerror = (event) => {
    voiceError("assist:speech:error", { error: event.error || "unknown" });
    if (onerror) {
      onerror(event);
    }
    if (onend) {
      onend();
    }
  };
  window.speechSynthesis.speak(utterance);
}

async function startVoiceAssist(roomId) {
  voiceLog("assist:start:click", { roomId });
  setAssistState(roomId, { ui_state: "loading", awaiting_reply: false });
  roomVoiceFeedback.set(roomId, "Preparing room suggestion...");
  roomVoiceDebug.set(roomId, "assist:start: requesting room summary from backend");
  paintVoiceStatus(roomId);
  try {
    const snapshot = await requestInteractiveSnapshot("/api/voice/assist/start", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId }),
    });
    const assist = snapshot.voice_assist || {};
    setAssistState(roomId, {
      ...assist,
      ui_state: "awaiting_reply",
      awaiting_reply: true,
    });
    roomVoiceFeedback.set(roomId, assist.spoken_text || "Voice assist started.");
    roomVoiceDebug.set(
      roomId,
      [
        `assist_source: ${snapshot.voice_assist_debug?.source || "unknown"}`,
        `summary: ${assist.summary || ""}`,
        `spoken_text: ${assist.spoken_text || ""}`,
        `suggested_intent: ${assist.suggested_intent || ""}`,
        `llm_output: ${snapshot.voice_assist_debug?.llm_output || "n/a"}`,
        `error: ${snapshot.voice_assist_debug?.error || "none"}`,
      ].join("\n")
    );
    voiceLog("assist:start:result", {
      roomId,
      assist,
      debug: snapshot.voice_assist_debug || {},
    });
    renderSnapshot(snapshot);
    roomVoiceFeedback.set(roomId, "Speaking room suggestion...");
    paintVoiceStatus(roomId);
    speakText(assist.spoken_text || "", {
      onend: () => {
        if (assistState(roomId) === "awaiting_reply") {
          roomVoiceFeedback.set(roomId, "Listening for your reply...");
          roomVoiceDebug.set(roomId, "assist:reply:capture: waiting for one reply");
          paintVoiceStatus(roomId);
          startVoiceAssistCapture(roomId);
        }
      },
    });
  } catch (error) {
    roomVoiceAssist.delete(roomId);
    roomVoiceFeedback.set(roomId, `Voice assist failed: ${error.message}`);
    roomVoiceDebug.set(roomId, `assist:start:error: ${error.message}`);
    voiceError("assist:start:failed", { roomId, error: error.message });
    paintVoiceStatus(roomId);
    setNodeText("deviceMessage", error.message);
  }
}

async function submitVoiceAssistReply(roomId, rawText) {
  voiceLog("assist:reply:submit", { roomId, rawText });
  setAssistState(roomId, { ui_state: "replying", awaiting_reply: false });
  roomVoiceFeedback.set(roomId, "Applying your reply...");
  roomVoiceDebug.set(roomId, `user_reply: ${rawText}\nassist:reply: sending to backend`);
  paintVoiceStatus(roomId);
  try {
    const snapshot = await requestInteractiveSnapshot("/api/voice/assist/reply", {
      method: "POST",
      body: JSON.stringify({
        room_id: roomId,
        raw_text: rawText,
      }),
    });
    const assist = snapshot.voice_assist || {};
    roomVoiceAssist.delete(roomId);
    roomVoiceFeedback.set(roomId, assist.acknowledgement || "Voice assist completed.");
    roomVoiceDebug.set(
      roomId,
      [
        `user_reply: ${rawText}`,
        `assist_source: ${snapshot.voice_assist_debug?.source || "unknown"}`,
        `command: ${JSON.stringify(assist, null, 2)}`,
        `llm_output: ${snapshot.voice_assist_debug?.llm_output || "n/a"}`,
        `error: ${snapshot.voice_assist_debug?.error || "none"}`,
      ].join("\n")
    );
    voiceLog("assist:reply:result", {
      roomId,
      rawText,
      assist,
      debug: snapshot.voice_assist_debug || {},
    });
    renderSnapshot(snapshot);
    speakText(assist.acknowledgement || "");
  } catch (error) {
    roomVoiceAssist.delete(roomId);
    roomVoiceFeedback.set(roomId, `Voice assist reply failed: ${error.message}`);
    roomVoiceDebug.set(roomId, `assist:reply:error: ${error.message}`);
    voiceError("assist:reply:failed", { roomId, rawText, error: error.message });
    paintVoiceStatus(roomId);
    setNodeText("deviceMessage", error.message);
  }
}

function startVoiceAssistCapture(roomId) {
  voiceLog("assist:reply:capture:start", { roomId });
  setAssistState(roomId, { ui_state: "capturing_reply", awaiting_reply: true });
  activeAssistListeningRoomId = roomId;
  if (!SpeechRecognition) {
    voiceLog("assist:reply:capture:fallback-prompt", { roomId });
    roomVoiceFeedback.set(roomId, "Waiting for your one reply...");
    roomVoiceDebug.set(roomId, "assist:reply:capture: using text prompt fallback");
    paintVoiceStatus(roomId);
    const typedReply = window.prompt("Reply to the room assistant:");
    if (typedReply) {
      submitVoiceAssistReply(roomId, typedReply.trim());
    } else {
      roomVoiceFeedback.set(roomId, "No reply captured. Tap the speaker again to retry.");
      roomVoiceDebug.set(roomId, "assist:reply:capture:fallback-prompt: cancelled");
      setAssistState(roomId, { ui_state: "idle", awaiting_reply: false });
      activeAssistListeningRoomId = null;
      paintVoiceStatus(roomId);
    }
    return;
  }
  if (activeRecognition) {
    activeRecognition.stop();
  }
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let transcriptCaptured = false;
  roomVoiceFeedback.set(roomId, "Listening for your one reply...");
  roomVoiceDebug.set(roomId, "assist:awaiting_reply: browser speech recognition listening");
  paintVoiceStatus(roomId);
  const timeoutId = window.setTimeout(() => {
    if (!transcriptCaptured) {
      voiceLog("assist:reply:capture:timeout", { roomId });
      recognition.stop();
      roomVoiceFeedback.set(roomId, "No reply heard. Tap the speaker again to retry.");
      roomVoiceDebug.set(roomId, "assist:reply:capture:timeout");
      setAssistState(roomId, { ui_state: "idle", awaiting_reply: false });
      paintVoiceStatus(roomId);
    }
  }, VOICE_ASSIST_REPLY_TIMEOUT_MS);
  recognition.onresult = async (event) => {
    window.clearTimeout(timeoutId);
    transcriptCaptured = true;
    const transcript = event.results[0][0].transcript.trim();
    voiceLog("assist:reply:capture:result", { roomId, transcript });
    await submitVoiceAssistReply(roomId, transcript);
  };
  recognition.onerror = (event) => {
    window.clearTimeout(timeoutId);
    roomVoiceAssist.delete(roomId);
    activeAssistListeningRoomId = null;
    roomVoiceFeedback.set(roomId, "Voice assist reply failed. Try the speaker button again.");
    roomVoiceDebug.set(roomId, `assist:error: ${event.error || "unknown"}`);
    voiceError("assist:reply:capture:error", { roomId, error: event.error || "unknown" });
    paintVoiceStatus(roomId);
  };
  recognition.onend = () => {
    window.clearTimeout(timeoutId);
    activeRecognition = null;
    activeAssistListeningRoomId = null;
    voiceLog("assist:reply:capture:end", { roomId });
    if (!transcriptCaptured && assistState(roomId) !== "replying") {
      setAssistState(roomId, { ui_state: "idle", awaiting_reply: false });
    }
    paintVoiceStatus(roomId);
  };
  recognition.start();
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
    roomVoiceFeedback.set(roomId, `Transcribed: "${transcript}"`);
    roomVoiceDebug.set(roomId, `transcript: ${transcript}\nstatus: captured from browser speech recognition`);
    paintVoiceStatus(roomId);
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
  const optimizeButton = event.target.closest("[data-optimize-room='true']");
  if (optimizeButton && !optimizeButton.disabled) {
    await startRoomOptimization(optimizeButton.dataset.roomId, "home");
    return;
  }
  const speakerButton = event.target.closest("[data-voice-kind='speaker']");
  if (speakerButton && !speakerButton.disabled) {
    const roomId = speakerButton.dataset.roomId;
    const assist = roomVoiceAssist.get(roomId);
    voiceLog("assist:speaker:click", { roomId, awaitingReply: !!assist?.awaiting_reply });
    if (assist?.awaiting_reply) {
      startVoiceAssistCapture(roomId);
    } else {
      await startVoiceAssist(roomId);
    }
    return;
  }
  const micButton = event.target.closest("[data-voice-kind='mic']");
  if (micButton && !micButton.disabled) {
    voiceLog("mic:click", { roomId: micButton.dataset.roomId });
    startRoomVoiceCapture(micButton.dataset.roomId);
    return;
  }
  const toggle = event.target.closest("[data-device-kind$='toggle']");
  if (toggle && !toggle.disabled) {
    const roomId = toggle.dataset.roomId;
    const deviceKind = toggle.dataset.deviceKind === "fan-toggle" ? "fan" : "light";
    const turningOff = toggle.classList.contains("on");
    setManualOffLock("home", roomId, deviceKind, turningOff);
    if (!turningOff) {
      setManualOffLock("home", roomId, deviceKind, false);
    }
    await applyDeviceControl(toggle.dataset.deviceId, Number(toggle.dataset.level || 0), {
      resume: toggle.dataset.resume === "true",
    });
    return;
  }
  const stepperButton = event.target.closest("[data-occupancy-step]");
  if (stepperButton) {
    const roomId = stepperButton.dataset.roomId;
    const card = roomElements.get(roomId);
    if (!card) {
      return;
    }
    const stepperValue = card.root.querySelector(`#occupancy-stepper-${roomId}`);
    const nextValue = Math.max(0, Math.min(MAX_OCCUPANCY, Number(stepperValue.textContent) + Number(stepperButton.dataset.occupancyStep)));
    const occupancyValue = card.root.querySelector(`#sensor-value-${roomId}-occupancy_count`);
    if (occupancyValue) occupancyValue.textContent = `${nextValue}`;
    if (stepperValue) stepperValue.textContent = String(nextValue);
    if (card.occupancyDown) {
      card.occupancyDown.disabled = nextValue <= 0;
    }
    if (card.occupancyUp) {
      card.occupancyUp.disabled = nextValue >= MAX_OCCUPANCY;
    }
    pendingOccupancy.set(roomId, nextValue);
    previewMetricsForRoom(roomId, { occupancy_count: nextValue });
    scheduleRoomSensorUpdate(roomId, card.root, 60);
  }
});

document.getElementById("houseGrid").addEventListener("input", (event) => {
  const input = event.target;
  if (input.dataset.sensorKey) {
    input.dataset.userAdjusting = "true";
    input.dataset.syncPending = "true";
    input.parentElement.querySelector("strong").textContent = `${input.value}${input.dataset.sensorSuffix}`;
    previewMetricsForRoom(input.dataset.roomId, {
      [input.dataset.sensorKey]: Number(input.value),
    });
    scheduleRoomSensorUpdate(input.dataset.roomId, input.closest(".room-card"));
    return;
  }
  if (input.dataset.deviceKind) {
    setManualOffLock("home", input.dataset.roomId, input.dataset.deviceKind, false);
    input.dataset.userAdjusting = "true";
    input.dataset.syncPending = "true";
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
    const existing = sensorSyncTimers.get(input.dataset.roomId);
    if (existing) {
      clearTimeout(existing);
      sensorSyncTimers.delete(input.dataset.roomId);
    }
    await updateRoomSensors(input.dataset.roomId, input.closest(".room-card"));
    return;
  }
  if (input.dataset.deviceKind && !input.disabled) {
    setManualOffLock("home", input.dataset.roomId, input.dataset.deviceKind, false);
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

document.getElementById("industryGrid").addEventListener("click", (event) => {
  const optimizeButton = event.target.closest("[data-optimize-room='true']");
  if (optimizeButton && !optimizeButton.disabled) {
    startRoomOptimization(optimizeButton.dataset.roomId, "industry");
    return;
  }
  const toggle = event.target.closest("[data-device-kind$='toggle']");
  if (toggle && !toggle.disabled) {
    const roomId = toggle.dataset.roomId;
    updateIndustryRoom(roomId, (room) => {
      if (toggle.dataset.deviceKind === "fan-toggle") {
        const turningOn = !room.devices.fan.state || room.devices.fan.state === "OFF";
        setManualOffLock("industry", roomId, "fan", !turningOn);
        room.devices.fan.state = turningOn ? "ON" : "OFF";
        room.devices.fan.speed_percent = turningOn
          ? getStoredSetpoint("industry", roomId, "fan", recommendedFanStartupLevel(room))
          : 0;
        room.devices.fan.speed = fanBandFromPercent(room.devices.fan.speed_percent);
      } else if (toggle.dataset.deviceKind === "light-toggle") {
        const turningOn = !room.devices.light.state || room.devices.light.state === "OFF";
        setManualOffLock("industry", roomId, "light", !turningOn);
        room.devices.light.state = turningOn ? "ON" : "OFF";
        room.devices.light.brightness = turningOn
          ? getStoredSetpoint("industry", roomId, "light", explicitIndustryLightLevel(room))
          : 0;
      }
    });
    return;
  }
  const stepperButton = event.target.closest("[data-occupancy-step]");
  if (stepperButton) {
    const roomId = stepperButton.dataset.roomId;
    updateIndustryRoom(roomId, (room) => {
      room.sensors.occupancy_count = Math.max(
        0,
        Math.min(MAX_OCCUPANCY, Number(room.sensors.occupancy_count) + Number(stepperButton.dataset.occupancyStep))
      );
      applyIndustrySensorResponse(room, "occupancy_count");
    });
  }
});

document.getElementById("industryGrid").addEventListener("input", (event) => {
  const input = event.target;
  if (input.dataset.sensorKey) {
    updateIndustryRoom(input.dataset.roomId, (room) => {
      room.sensors[input.dataset.sensorKey] = Number(input.value);
      applyIndustrySensorResponse(room, input.dataset.sensorKey);
    });
    return;
  }
  if (input.dataset.deviceKind) {
    updateIndustryRoom(input.dataset.roomId, (room) => {
      if (input.dataset.deviceKind === "fan") {
        setManualOffLock("industry", input.dataset.roomId, "fan", false);
        room.devices.fan.state = "ON";
        room.devices.fan.speed_percent = Number(input.value);
        room.devices.fan.speed = fanBandFromPercent(room.devices.fan.speed_percent);
      } else {
        setManualOffLock("industry", input.dataset.roomId, "light", false);
        room.devices.light.state = "ON";
        room.devices.light.brightness = Number(input.value);
      }
    });
  }
});

const runDecisionButton = document.getElementById("runDecisionButton");
if (runDecisionButton) {
  runDecisionButton.addEventListener("click", async () => {
    try {
      const snapshot = await requestSnapshot("/api/decision/evaluate", {
        method: "POST",
      });
      if (snapshot) {
        renderSnapshot(snapshot);
      }
    } catch (error) {
      setNodeText("deviceMessage", error.message);
    }
  });
}

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
  document.getElementById("industryView").classList.toggle("active", tab.dataset.view === "industry");
  document.getElementById("dashboard2View").classList.toggle("active", tab.dataset.view === "dashboard-2");
});

document.getElementById("dashboardRangeTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-range]");
  if (!tab) {
    return;
  }
  homeDashboardState.range = tab.dataset.range;
  document.querySelectorAll("#dashboardRangeTabs .range-chip").forEach((node) => {
    node.classList.toggle("active", node === tab);
  });
  if (latestSnapshot?.dashboard) {
    renderDashboard(latestSnapshot.dashboard, homeDashboardState, {
      summaryId: "dashboardSummary",
      savingsId: "dashboardOptimizationSavings",
      scope: "home",
      comparisonId: "roomComparisonChart",
      trendChartId: "hourlyTrendChart",
      trendTitleId: "trendChartTitle",
      trendSubtitleId: "trendChartSubtitle",
      recommendationsId: "recommendationsPanel",
      inefficienciesId: "inefficiencyPanel",
    });
  }
});

document.getElementById("dashboardRoomSelect").addEventListener("change", (event) => {
  homeDashboardState.roomFilter = event.target.value;
  if (latestSnapshot?.dashboard) {
    renderDashboard(latestSnapshot.dashboard, homeDashboardState, {
      summaryId: "dashboardSummary",
      savingsId: "dashboardOptimizationSavings",
      scope: "home",
      comparisonId: "roomComparisonChart",
      trendChartId: "hourlyTrendChart",
      trendTitleId: "trendChartTitle",
      trendSubtitleId: "trendChartSubtitle",
      recommendationsId: "recommendationsPanel",
      inefficienciesId: "inefficiencyPanel",
    });
  }
});

document.getElementById("dashboardTrendSelect").addEventListener("change", (event) => {
  homeDashboardState.trendWindow = event.target.value;
  if (latestSnapshot?.dashboard) {
    renderDashboard(latestSnapshot.dashboard, homeDashboardState, {
      summaryId: "dashboardSummary",
      savingsId: "dashboardOptimizationSavings",
      scope: "home",
      comparisonId: "roomComparisonChart",
      trendChartId: "hourlyTrendChart",
      trendTitleId: "trendChartTitle",
      trendSubtitleId: "trendChartSubtitle",
      recommendationsId: "recommendationsPanel",
      inefficienciesId: "inefficiencyPanel",
    });
  }
});

document.getElementById("dashboardMetricFilters").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-metric-filter]");
  if (!tab) {
    return;
  }
  homeDashboardState.metricFilter = tab.dataset.metricFilter;
  document.querySelectorAll("#dashboardMetricFilters [data-metric-filter]").forEach((node) => {
    node.classList.toggle("active", node === tab);
  });
  if (latestSnapshot?.dashboard) {
    renderDashboard(latestSnapshot.dashboard, homeDashboardState, {
      summaryId: "dashboardSummary",
      savingsId: "dashboardOptimizationSavings",
      scope: "home",
      comparisonId: "roomComparisonChart",
      trendChartId: "hourlyTrendChart",
      trendTitleId: "trendChartTitle",
      trendSubtitleId: "trendChartSubtitle",
      recommendationsId: "recommendationsPanel",
      inefficienciesId: "inefficiencyPanel",
    });
  }
});

document.getElementById("industryDashboardRangeTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-range]");
  if (!tab) {
    return;
  }
  industryDashboardState.range = tab.dataset.range;
  document.querySelectorAll("#industryDashboardRangeTabs .range-chip").forEach((node) => {
    node.classList.toggle("active", node === tab);
  });
  if (latestIndustryState?.dashboard) {
    renderDashboard(latestIndustryState.dashboard, industryDashboardState, {
      summaryId: "industryDashboardSummary",
      savingsId: "industryDashboardOptimizationSavings",
      scope: "industry",
      comparisonId: "industryRoomComparisonChart",
      trendChartId: "industryHourlyTrendChart",
      trendTitleId: "industryTrendChartTitle",
      trendSubtitleId: "industryTrendChartSubtitle",
      recommendationsId: "industryRecommendationsPanel",
      inefficienciesId: "industryInefficiencyPanel",
    });
  }
});

document.getElementById("industryDashboardRoomSelect").addEventListener("change", (event) => {
  industryDashboardState.roomFilter = event.target.value;
  if (latestIndustryState?.dashboard) {
    renderDashboard(latestIndustryState.dashboard, industryDashboardState, {
      summaryId: "industryDashboardSummary",
      savingsId: "industryDashboardOptimizationSavings",
      scope: "industry",
      comparisonId: "industryRoomComparisonChart",
      trendChartId: "industryHourlyTrendChart",
      trendTitleId: "industryTrendChartTitle",
      trendSubtitleId: "industryTrendChartSubtitle",
      recommendationsId: "industryRecommendationsPanel",
      inefficienciesId: "industryInefficiencyPanel",
    });
  }
});

document.getElementById("industryDashboardTrendSelect").addEventListener("change", (event) => {
  industryDashboardState.trendWindow = event.target.value;
  if (latestIndustryState?.dashboard) {
    renderDashboard(latestIndustryState.dashboard, industryDashboardState, {
      summaryId: "industryDashboardSummary",
      savingsId: "industryDashboardOptimizationSavings",
      scope: "industry",
      comparisonId: "industryRoomComparisonChart",
      trendChartId: "industryHourlyTrendChart",
      trendTitleId: "industryTrendChartTitle",
      trendSubtitleId: "industryTrendChartSubtitle",
      recommendationsId: "industryRecommendationsPanel",
      inefficienciesId: "industryInefficiencyPanel",
    });
  }
});

document.getElementById("industryDashboardMetricFilters").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-metric-filter]");
  if (!tab) {
    return;
  }
  industryDashboardState.metricFilter = tab.dataset.metricFilter;
  document.querySelectorAll("#industryDashboardMetricFilters [data-metric-filter]").forEach((node) => {
    node.classList.toggle("active", node === tab);
  });
  if (latestIndustryState?.dashboard) {
    renderDashboard(latestIndustryState.dashboard, industryDashboardState, {
      summaryId: "industryDashboardSummary",
      savingsId: "industryDashboardOptimizationSavings",
      scope: "industry",
      comparisonId: "industryRoomComparisonChart",
      trendChartId: "industryHourlyTrendChart",
      trendTitleId: "industryTrendChartTitle",
      trendSubtitleId: "industryTrendChartSubtitle",
      recommendationsId: "industryRecommendationsPanel",
      inefficienciesId: "industryInefficiencyPanel",
    });
  }
});

refreshDashboard();
setInterval(advanceAutomation, 900);
setInterval(tickLiveTokenMeters, 120);
