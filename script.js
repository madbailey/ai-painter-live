const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const VALID_TOOLS = ['pencil', 'brush', 'rectangle', 'circle', 'fill', 'spray', 'eraser'];
const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_MAX_RUN_SECONDS = 120;
const MIN_MAX_RUN_SECONDS = 15;
const MAX_MAX_RUN_SECONDS = 1800;
const RESPONSE_CREATE_MIN_TOKENS = 2500;
const RESPONSE_CREATE_RETRY_BUFFER_MS = 200;
const MAX_RATE_LIMIT_RECOVERIES = 8;
const MAX_EMPTY_RESPONSES = 3;
const SCREENSHOT_MAX_SIDE = 512;
const SCREENSHOT_OUTPUT_TYPE = 'image/jpeg';
const SCREENSHOT_JPEG_QUALITY = 0.74;
const MAX_AUTOSAVE_SCREENSHOTS = 80;
const UNDO_MAX_SNAPSHOTS = 20;

const AVAILABLE_MODELS = ['gpt-5.2', 'gpt-5-mini', 'gpt-5-nano'];

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const ui = {
  tabRunMode: document.getElementById('tabRunMode'),
  tabEvalMode: document.getElementById('tabEvalMode'),
  panelModeTabs: Array.from(document.querySelectorAll('[data-panel-tab]')),
  panelModeSections: Array.from(document.querySelectorAll('[data-panel-mode]')),
  aiPrompt: document.getElementById('aiPrompt'),
  modelSelect: document.getElementById('modelSelect'),
  modelCustom: document.getElementById('modelCustom'),
  maxRunSeconds: document.getElementById('maxRunSeconds'),
  allowClearTool: document.getElementById('allowClearTool'),
  gridForScreenshots: document.getElementById('gridForScreenshots'),
  startAiButton: document.getElementById('startAi'),
  stopAiButton: document.getElementById('stopAi'),
  runTimer: document.getElementById('runTimer'),
  aiStatus: document.getElementById('aiStatus'),
  assistantText: document.getElementById('assistantText'),
  downloadLog: document.getElementById('downloadLog'),
  autosaveStatus: document.getElementById('autosaveStatus'),
  evalPrompts: document.getElementById('evalPrompts'),
  evalModelCheckboxes: document.getElementById('evalModelCheckboxes'),
  evalModelsCustom: document.getElementById('evalModelsCustom'),
  evalMaxRunSeconds: document.getElementById('evalMaxRunSeconds'),
  evalGridModes: document.getElementById('evalGridModes'),
  evalAllowClearModes: document.getElementById('evalAllowClearModes'),
  evalRepeats: document.getElementById('evalRepeats'),
  evalPauseMs: document.getElementById('evalPauseMs'),
  evalModelBatchPauseMs: document.getElementById('evalModelBatchPauseMs'),
  evalTag: document.getElementById('evalTag'),
  evalClearCanvasEachRun: document.getElementById('evalClearCanvasEachRun'),
  startEvalMatrix: document.getElementById('startEvalMatrix'),
  stopEvalMatrix: document.getElementById('stopEvalMatrix'),
  downloadEvalCsv: document.getElementById('downloadEvalCsv'),
  evalStatus: document.getElementById('evalStatus'),
  resultsGallery: document.getElementById('resultsGallery'),
  resultCardOverlay: document.getElementById('resultCardOverlay'),
  overlayClose: document.getElementById('overlayClose'),
  overlayImage: document.getElementById('overlayImage'),
  overlayMeta: document.getElementById('overlayMeta')
};

const state = {
  mode: 'human',
  panelMode: 'run',
  drawing: {
    isDrawing: false,
    currentTool: 'pencil',
    color: '#000000',
    lineWidth: 5,
    startX: 0,
    startY: 0
  },
  aiRun: null,
  lastRunLog: null,
  pendingRunOverrides: null,
  insideEvalMatrix: false,
  evalRunner: {
    active: false,
    stopRequested: false,
    queue: [],
    results: [],
    startedAt: null,
    config: null,
    runByRunId: new Map(),
    current: null
  }
};

canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
ctx.strokeStyle = state.drawing.color;
ctx.lineWidth = state.drawing.lineWidth;
ctx.lineCap = 'round';

bindUiEvents();
updatePanelModeUi();
updateRunTimer('--');
setAiStatus('idle');
setAutosaveStatus('Autosave: waiting for next run.');
if (ui.evalPrompts && !ui.evalPrompts.value.trim()) {
  ui.evalPrompts.value = ui.aiPrompt.value.trim();
}
setEvalStatus('idle.');
updateEvalUi();

function bindUiEvents() {
  if (ui.tabRunMode) {
    ui.tabRunMode.addEventListener('click', () => setPanelMode('run'));
  }
  if (ui.tabEvalMode) {
    ui.tabEvalMode.addEventListener('click', () => setPanelMode('eval'));
  }

  // Model dropdown: show/hide custom input
  if (ui.modelSelect) {
    ui.modelSelect.addEventListener('change', () => {
      if (ui.modelCustom) {
        ui.modelCustom.style.display = ui.modelSelect.value === '__custom__' ? '' : 'none';
      }
    });
  }

  ui.startAiButton.addEventListener('click', startAiRun);
  ui.stopAiButton.addEventListener('click', () => {
    if (state.aiRun?.active) {
      stopAiRun('Stopped by user.', { manual: true });
    }
  });

  ui.downloadLog.addEventListener('click', downloadLastRunLog);
  ui.startEvalMatrix.addEventListener('click', startEvalMatrix);
  ui.stopEvalMatrix.addEventListener('click', stopEvalMatrix);
  ui.downloadEvalCsv.addEventListener('click', downloadEvalCsv);

  // Gallery overlay close
  if (ui.overlayClose) {
    ui.overlayClose.addEventListener('click', closeResultOverlay);
  }
  if (ui.resultCardOverlay) {
    ui.resultCardOverlay.addEventListener('click', (e) => {
      if (e.target === ui.resultCardOverlay) closeResultOverlay();
    });
  }
}

function getSelectedModel() {
  if (!ui.modelSelect) return DEFAULT_MODEL;
  if (ui.modelSelect.value === '__custom__') {
    return String(ui.modelCustom?.value || '').trim() || DEFAULT_MODEL;
  }
  return ui.modelSelect.value || DEFAULT_MODEL;
}

function setModelUi(model) {
  if (!ui.modelSelect) return;
  const isPreset = AVAILABLE_MODELS.includes(model);
  if (isPreset) {
    ui.modelSelect.value = model;
    if (ui.modelCustom) ui.modelCustom.style.display = 'none';
  } else {
    ui.modelSelect.value = '__custom__';
    if (ui.modelCustom) {
      ui.modelCustom.value = model;
      ui.modelCustom.style.display = '';
    }
  }
}

function setPanelMode(mode) {
  const normalized = mode === 'eval' ? 'eval' : 'run';
  if (state.panelMode === normalized) return;
  state.panelMode = normalized;
  updatePanelModeUi();
}

function updatePanelModeUi() {
  for (const tab of ui.panelModeTabs) {
    const mode = tab.getAttribute('data-panel-tab');
    const active = mode === state.panelMode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  for (const section of ui.panelModeSections) {
    const sectionMode = section.getAttribute('data-panel-mode');
    const show = sectionMode === state.panelMode;
    section.classList.toggle('is-hidden', !show);
  }
}

function setTool(tool) {
  if (!VALID_TOOLS.includes(tool)) return;
  state.drawing.currentTool = tool;
}

function setColor(color) {
  const normalized = normalizeColor(color);
  state.drawing.color = normalized;
  ctx.strokeStyle = normalized;
}

function setLineWidth(width) {
  const normalized = clamp(Math.round(Number(width) || state.drawing.lineWidth), 1, 50);
  state.drawing.lineWidth = normalized;
  ctx.lineWidth = normalized;
}

function pushUndoSnapshot(run) {
  if (!run) return;
  run.undoStack.push(ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
  if (run.undoStack.length > UNDO_MAX_SNAPSHOTS) {
    run.undoStack.shift();
  }
}

function popAndRestoreUndo(run) {
  if (!run || run.undoStack.length === 0) return false;
  const snapshot = run.undoStack.pop();
  ctx.putImageData(snapshot, 0, 0);
  return true;
}

function restoreToLastScreenshot(run) {
  if (!run || !run.lastScreenshotImageData) return false;
  ctx.putImageData(run.lastScreenshotImageData, 0, 0);
  run.undoStack = [];
  return true;
}

function isCanvasWhite() {
  const imageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 400) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) {
      return false;
    }
  }
  return true;
}

function executeDrawAction(rawAction, options = {}) {
  const source = options.source || 'unknown';
  const skipLog = Boolean(options.skipLog);

  const action = {
    tool: VALID_TOOLS.includes(rawAction.tool) ? rawAction.tool : state.drawing.currentTool,
    color: normalizeColor(rawAction.color || state.drawing.color),
    lineWidth: clamp(Math.round(Number(rawAction.lineWidth) || state.drawing.lineWidth), 1, 50),
    startX: clamp(Math.round(Number(rawAction.startX) || 0), 0, CANVAS_WIDTH),
    startY: clamp(Math.round(Number(rawAction.startY) || 0), 0, CANVAS_HEIGHT),
    x: clamp(Math.round(Number(rawAction.x) || 0), 0, CANVAS_WIDTH),
    y: clamp(Math.round(Number(rawAction.y) || 0), 0, CANVAS_HEIGHT),
    seed: Number.isFinite(Number(rawAction.seed)) ? Number(rawAction.seed) >>> 0 : null
  };

  if (action.tool === 'spray' && action.seed === null) {
    action.seed = deterministicSeedFromAction(action);
  }

  setTool(action.tool);
  setColor(action.color);
  setLineWidth(action.lineWidth);

  const actionColor = action.tool === 'eraser' ? '#FFFFFF' : action.color;

  switch (action.tool) {
    case 'pencil':
    case 'brush': {
      ctx.beginPath();
      ctx.strokeStyle = actionColor;
      ctx.lineWidth = action.lineWidth;
      ctx.lineCap = 'round';
      ctx.moveTo(action.startX, action.startY);
      ctx.lineTo(action.x, action.y);
      ctx.stroke();
      break;
    }
    case 'rectangle': {
      ctx.beginPath();
      ctx.strokeStyle = actionColor;
      ctx.lineWidth = action.lineWidth;
      ctx.rect(action.startX, action.startY, action.x - action.startX, action.y - action.startY);
      ctx.stroke();
      break;
    }
    case 'circle': {
      const radius = Math.sqrt((action.x - action.startX) ** 2 + (action.y - action.startY) ** 2);
      ctx.beginPath();
      ctx.strokeStyle = actionColor;
      ctx.lineWidth = action.lineWidth;
      ctx.arc(action.startX, action.startY, radius, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'fill': {
      floodFill(action.startX, action.startY, action.color);
      break;
    }
    case 'spray': {
      sprayPaint(action.x, action.y, action.lineWidth * 2, action.lineWidth * 5, actionColor, action.seed);
      break;
    }
    case 'eraser': {
      ctx.beginPath();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = action.lineWidth;
      ctx.lineCap = 'round';
      ctx.moveTo(action.startX, action.startY);
      ctx.lineTo(action.x, action.y);
      ctx.stroke();
      break;
    }
    default:
      break;
  }

  if (source === 'ai' && state.aiRun?.active && !skipLog) {
    appendRunAction('draw_action', action);
    appendRunEvent('tool_effect', { kind: 'draw_action', action });
    state.aiRun.lastVisualChangeAtMs = Date.now() - state.aiRun.startedAt;
  }

  return action;
}

function clearCanvas(options = {}) {
  const source = options.source || 'unknown';
  const skipLog = Boolean(options.skipLog);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (source === 'ai' && state.aiRun?.active && !skipLog) {
    appendRunAction('clear_canvas', {});
    appendRunEvent('tool_effect', { kind: 'clear_canvas' });
    state.aiRun.lastVisualChangeAtMs = Date.now() - state.aiRun.startedAt;
  }
}

function fillRectangleAction(rawInput, options = {}) {
  const source = options.source || 'unknown';
  const skipLog = Boolean(options.skipLog);

  const color = normalizeColor(rawInput.color || state.drawing.color);
  const x1 = clamp(Math.round(Number(rawInput.x1) || 0), 0, CANVAS_WIDTH);
  const y1 = clamp(Math.round(Number(rawInput.y1) || 0), 0, CANVAS_HEIGHT);
  const x2 = clamp(Math.round(Number(rawInput.x2) || 0), 0, CANVAS_WIDTH);
  const y2 = clamp(Math.round(Number(rawInput.y2) || 0), 0, CANVAS_HEIGHT);

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(1, Math.abs(x2 - x1));
  const height = Math.max(1, Math.abs(y2 - y1));

  ctx.fillStyle = color;
  ctx.fillRect(left, top, width, height);

  const action = {
    color,
    x1: left,
    y1: top,
    x2: left + width,
    y2: top + height
  };

  if (source === 'ai' && state.aiRun?.active && !skipLog) {
    appendRunAction('fill_rectangle', action);
    appendRunEvent('tool_effect', { kind: 'fill_rectangle', action });
    state.aiRun.lastVisualChangeAtMs = Date.now() - state.aiRun.startedAt;
  }

  return action;
}

function sprayPaint(x, y, radius, density, color, seed) {
  const random = mulberry32(seed >>> 0);
  ctx.fillStyle = color;

  for (let i = 0; i < density; i += 1) {
    const angle = random() * Math.PI * 2;
    const radial = random() * radius;
    const dotX = x + radial * Math.cos(angle);
    const dotY = y + radial * Math.sin(angle);

    ctx.beginPath();
    ctx.arc(dotX, dotY, 1, 0, Math.PI * 2);
    ctx.fill();
  }
}

function floodFill(startX, startY, fillColor) {
  const imageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const data = imageData.data;

  const startIndex = (startY * CANVAS_WIDTH + startX) * 4;
  const startR = data[startIndex];
  const startG = data[startIndex + 1];
  const startB = data[startIndex + 2];
  const startA = data[startIndex + 3];

  const fillRgb = hexToRgb(fillColor);
  if (!fillRgb) return;

  if (colorsMatch(startR, startG, startB, startA, fillRgb.r, fillRgb.g, fillRgb.b, 255)) {
    return;
  }

  const tolerance = 18;
  const stack = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) continue;

    const idx = (y * CANVAS_WIDTH + x) * 4;
    if (!colorsMatchWithTolerance(
      data[idx], data[idx + 1], data[idx + 2], data[idx + 3],
      startR, startG, startB, startA,
      tolerance
    )) {
      continue;
    }

    data[idx] = fillRgb.r;
    data[idx + 1] = fillRgb.g;
    data[idx + 2] = fillRgb.b;
    data[idx + 3] = 255;

    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }

  ctx.putImageData(imageData, 0, 0);
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const parsed = Number.parseInt(clean, 16);
  return {
    r: (parsed >> 16) & 255,
    g: (parsed >> 8) & 255,
    b: parsed & 255
  };
}

function colorsMatch(r1, g1, b1, a1, r2, g2, b2, a2) {
  return r1 === r2 && g1 === g2 && b1 === b2 && a1 === a2;
}

function colorsMatchWithTolerance(r1, g1, b1, a1, r2, g2, b2, a2, tolerance) {
  return Math.abs(r1 - r2) <= tolerance
    && Math.abs(g1 - g2) <= tolerance
    && Math.abs(b1 - b2) <= tolerance
    && Math.abs(a1 - a2) <= tolerance;
}

async function startAiRun() {
  if (state.aiRun?.active) return;
  if (!state.insideEvalMatrix) {
    setPanelMode('run');
  }

  const overrides = state.pendingRunOverrides && typeof state.pendingRunOverrides === 'object'
    ? state.pendingRunOverrides
    : null;
  state.pendingRunOverrides = null;

  const promptSource = overrides?.prompt ?? ui.aiPrompt.value;
  const prompt = String(promptSource || '').trim();
  if (!prompt) {
    setAiStatus('enter a prompt before starting.');
    return;
  }

  const modelSource = overrides?.model ?? getSelectedModel();
  const model = String(modelSource || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const maxRunSeconds = clamp(
    Math.round(Number(overrides?.maxRunSeconds ?? ui.maxRunSeconds.value) || DEFAULT_MAX_RUN_SECONDS),
    MIN_MAX_RUN_SECONDS,
    MAX_MAX_RUN_SECONDS
  );
  const allowClearTool = typeof overrides?.allowClearTool === 'boolean'
    ? overrides.allowClearTool
    : ui.allowClearTool.checked;
  const gridForScreenshots = typeof overrides?.gridForScreenshots === 'boolean'
    ? overrides.gridForScreenshots
    : ui.gridForScreenshots.checked;
  const evalMeta = sanitizeEvalMeta(overrides?.evalMeta);

  ui.aiPrompt.value = prompt;
  setModelUi(model);
  ui.maxRunSeconds.value = String(maxRunSeconds);
  ui.allowClearTool.checked = allowClearTool;
  ui.gridForScreenshots.checked = gridForScreenshots;

  const runId = createRunId();
  const startedAt = Date.now();

  state.aiRun = {
    id: runId,
    active: true,
    stopping: false,
    prompt,
    model,
    allowClearTool,
    gridForScreenshots,
    evalMeta,
    startedAt,
    maxRunSeconds,
    deadline: startedAt + (maxRunSeconds * 1000),
    ws: null,
    handledCallIds: new Set(),
    pendingToolCalls: new Map(),
    toolQueue: Promise.resolve(),
    responseStateById: new Map(),
    callToResponseId: new Map(),
    inflightResponseId: null,
    pendingResponseCreate: false,
    pendingResponseReason: null,
    responseRetryHandle: null,
    backoffUntilMs: 0,
    rateLimits: {},
    rateLimitHits: 0,
    emptyResponseCount: 0,
    latestResponseId: null,
    pendingInputItems: [],
    responseCreateCount: 0,
    lastSocketCloseDetail: null,
    screenshotCount: 0,
    screenshotArtifacts: [],
    reflectionCount: 0,
    lastVisualChangeAtMs: -1,
    lastScreenshotAtMs: -1,
    lastReflectAtMs: -1,
    lastReflectWantsMoreWork: false,
    pendingReflectAfterScreenshot: false,
    transcript: '',
    log: {
      version: 1,
      runId,
      prompt,
      model,
      startedAt: new Date(startedAt).toISOString(),
      maxRunSeconds,
      settings: {
        allowClearTool,
        gridForScreenshots,
        eval: evalMeta
      },
      events: [],
      actions: [],
      finalReason: null,
      finishedByAgent: false,
      finishSummary: null,
      endedAt: null
    },
    runTimeoutHandle: null,
    countdownHandle: null,
    undoStack: [],
    lastScreenshotImageData: null
  };

  setControlMode('ai');
  ui.startAiButton.disabled = true;
  ui.stopAiButton.disabled = false;
  ui.stopAiButton.textContent = 'Stop';
  ui.downloadLog.disabled = true;
  ui.assistantText.textContent = '';
  setAutosaveStatus(`Autosave: pending for run ${runId}.`);

  appendRunEvent('run_started', {
    prompt,
    model,
    maxRunSeconds,
    allowClearTool,
    gridForScreenshots,
    eval: evalMeta
  });

  setAiStatus('connecting to local responses websocket proxy...');

  connectResponsesSocket(state.aiRun);

  state.aiRun.runTimeoutHandle = setTimeout(() => {
    stopAiRun(`Stopped: reached ${maxRunSeconds}s limit.`, { timedOut: true });
  }, maxRunSeconds * 1000);

  state.aiRun.countdownHandle = setInterval(() => {
    if (!state.aiRun || state.aiRun.id !== runId || !state.aiRun.active) return;
    const msLeft = Math.max(0, state.aiRun.deadline - Date.now());
    updateRunTimer(msToClock(msLeft));
  }, 250);
}

function connectResponsesSocket(run) {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${window.location.host}/ws/responses`;
  const ws = new WebSocket(url);
  run.ws = ws;

  ws.onopen = () => {
    if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) {
      ws.close(1000, 'run no longer active');
      return;
    }

    setAiStatus('connected. running agent loop...');
    updateRunTimer(msToClock(Math.max(0, run.deadline - Date.now())));

    const canvasIsBlank = isCanvasWhite();
    const canvasStateNote = canvasIsBlank
      ? 'The canvas is currently blank (white).'
      : 'The canvas already has content on it. A screenshot is attached so you can see what exists.';

    const initialContent = [
      {
        type: 'input_text',
        text: `Paint this on the ${CANVAS_WIDTH}x${CANVAS_HEIGHT} canvas: "${run.prompt}". ${canvasStateNote} Use tools only and call finish when done.`
      }
    ];

    if (!canvasIsBlank) {
      const existingImageDataUrl = captureCanvasDataUrl(false, {
        maxSide: SCREENSHOT_MAX_SIDE,
        outputType: SCREENSHOT_OUTPUT_TYPE,
        quality: SCREENSHOT_JPEG_QUALITY
      });
      initialContent.push({
        type: 'input_image',
        image_url: existingImageDataUrl
      });
      run.lastScreenshotImageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    enqueueInputItems(run, [
      {
        role: 'user',
        content: initialContent
      }
    ]);

    queueResponseCreate(run, 'initial_run_start');
  };

  ws.onmessage = (messageEvent) => {
    if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) {
      return;
    }

    let event;
    try {
      event = JSON.parse(messageEvent.data);
    } catch (error) {
      appendRunEvent('parse_error', { message: error.message, rawLength: String(messageEvent.data).length });
      return;
    }

    appendRunEvent('ws_recv', sanitizeForLog(event));
    handleRealtimeEvent(run, event);
  };

  ws.onerror = () => {
    if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
    run.lastSocketCloseDetail = 'Responses websocket error from browser socket.';
    setAiStatus('responses websocket error.');
  };

  ws.onclose = (closeEvent) => {
    if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
    if (run.stopping) return;
    const code = Number(closeEvent?.code);
    const reason = typeof closeEvent?.reason === 'string' ? closeEvent.reason : '';
    const closeSummary = Number.isFinite(code)
      ? `Responses websocket closed (code ${code}${reason ? `: ${reason}` : ''}).`
      : 'Responses websocket closed unexpectedly.';
    stopAiRun(run.lastSocketCloseDetail || closeSummary, { socketClosed: true });
  };
}

function handleRealtimeEvent(run, event) {
  if (event.type === 'proxy.connected') {
    return;
  }

  if (event.type === 'proxy.upstream_error') {
    const message = event.message || event.error?.message || 'Unknown upstream proxy error.';
    run.lastSocketCloseDetail = `Upstream proxy error: ${message}`;
    setAiStatus(run.lastSocketCloseDetail);
    appendRunEvent('proxy_error', sanitizeForLog(event));
    return;
  }

  if (event.type === 'proxy.upstream_closed') {
    const code = Number(event.code);
    const reason = typeof event.reason === 'string' ? event.reason : '';
    const detail = Number.isFinite(code)
      ? `OpenAI upstream closed (code ${code}${reason ? `: ${reason}` : ''}).`
      : `OpenAI upstream closed${reason ? `: ${reason}` : '.'}`;
    run.lastSocketCloseDetail = detail;
    setAiStatus(detail);
    appendRunEvent('proxy_upstream_closed', sanitizeForLog(event));
    return;
  }

  if (event.type === 'rate_limits.updated') {
    if (Array.isArray(event.rate_limits)) {
      for (const limit of event.rate_limits) {
        if (!limit?.name) continue;
        run.rateLimits[limit.name] = {
          limit: Number(limit.limit),
          remaining: Number(limit.remaining),
          resetSeconds: Number(limit.reset_seconds)
        };
      }
    }
    maybeSendQueuedResponseCreate(run);
    return;
  }

  if (event.type === 'error') {
    const errorCode = event.error?.code || '';
    const message = event.error?.message || 'Unknown responses websocket error.';
    run.lastSocketCloseDetail = `Responses error: ${message}`;
    if (errorCode === 'rate_limit_exceeded') {
      appendRunEvent('realtime_error', sanitizeForLog(event.error || event));
      handleRateLimitFailure(run, message);
      return;
    }
    setAiStatus(`error: ${message}`);
    appendRunEvent('realtime_error', sanitizeForLog(event.error || event));
    return;
  }

  if (event.type === 'response.created') {
    const responseId = event.response?.id;
    if (responseId) {
      run.inflightResponseId = responseId;
      getOrCreateResponseState(run, responseId);
    }
    return;
  }

  if (event.type === 'response.output_text.delta') {
    run.transcript += event.delta || '';
    ui.assistantText.textContent = run.transcript;
    return;
  }

  if (event.type === 'response.output_text.done') {
    if (typeof event.text === 'string') {
      run.transcript += event.text;
      ui.assistantText.textContent = run.transcript;
    }
    return;
  }

  if (event.type === 'response.output_item.added') {
    const item = event.item;
    if (item?.type === 'function_call' && item.call_id) {
      const responseId = event.response_id || run.inflightResponseId || 'unknown';
      const responseState = getOrCreateResponseState(run, responseId);
      responseState.hadFunctionCall = true;
      responseState.pendingCallIds.add(item.call_id);
      run.callToResponseId.set(item.call_id, responseId);
      run.pendingToolCalls.set(item.call_id, {
        name: item.name || null,
        arguments: typeof item.arguments === 'string' ? item.arguments : ''
      });
    }
    return;
  }

  if (event.type === 'response.function_call_arguments.delta') {
    const callId = event.call_id;
    if (!callId) return;
    const pending = run.pendingToolCalls.get(callId) || { name: null, arguments: '' };
    pending.arguments += event.delta || '';
    run.pendingToolCalls.set(callId, pending);
    return;
  }

  if (event.type === 'response.function_call_arguments.done') {
    const callId = event.call_id || createFallbackCallId(event.name, event.arguments);
    const pending = run.pendingToolCalls.get(callId) || {};
    const name = event.name || pending.name;
    const args = typeof event.arguments === 'string' ? event.arguments : (pending.arguments || '{}');
    const responseId = event.response_id || run.callToResponseId.get(callId) || run.inflightResponseId || 'unknown';
    scheduleToolCall(run, {
      callId,
      name,
      arguments: args,
      responseId
    });
    return;
  }

  if (event.type === 'response.output_item.done') {
    const item = event.item;
    if (item?.type === 'function_call') {
      const responseId = event.response_id || run.callToResponseId.get(item.call_id) || run.inflightResponseId || 'unknown';
      scheduleToolCall(run, {
        callId: item.call_id || createFallbackCallId(item.name, item.arguments),
        name: item.name,
        arguments: item.arguments || '{}',
        responseId
      });
    }
    return;
  }

  if (event.type === 'response.done') {
    const response = event.response || {};
    const responseId = response.id || run.inflightResponseId || 'unknown';
    const responseState = getOrCreateResponseState(run, responseId);
    responseState.done = true;

    if (run.inflightResponseId === responseId || run.inflightResponseId === 'pending') {
      run.inflightResponseId = null;
    }

    if (response.status === 'failed') {
      const error = response.status_details?.error || {};
      appendRunEvent('response_failed', {
        responseId,
        error: sanitizeForLog(error)
      });
      const message = error.message || 'Responses API response failed.';
      if (error.code === 'rate_limit_exceeded' || error.type === 'tokens') {
        handleRateLimitFailure(run, message);
        return;
      }
      stopAiRun(`Response failed: ${message}`, { responseFailed: true });
      return;
    }

    run.latestResponseId = responseId || run.latestResponseId;
    run.rateLimitHits = 0;
    run.backoffUntilMs = 0;

    const outputs = Array.isArray(response.output) ? response.output : [];
    let scheduledFunctionCalls = false;
    for (const outputItem of outputs) {
      if (outputItem?.type === 'function_call') {
        const callId = outputItem.call_id || createFallbackCallId(outputItem.name, outputItem.arguments);
        const outputResponseId = run.callToResponseId.get(callId) || responseId;
        scheduledFunctionCalls = true;
        scheduleToolCall(run, {
          callId,
          name: outputItem.name,
          arguments: outputItem.arguments || '{}',
          responseId: outputResponseId
        });
      }
    }

    if (!scheduledFunctionCalls && responseState.pendingCallIds.size === 0) {
      run.emptyResponseCount += 1;
      if (run.emptyResponseCount >= MAX_EMPTY_RESPONSES) {
        stopAiRun('Stopped: model returned no tool calls repeatedly.', { emptyResponses: true });
        return;
      }
      setAiStatus('no tool call returned; requesting another step...');
      queueResponseCreate(run, 'empty_response');
      return;
    }

    run.emptyResponseCount = 0;
    maybeQueueFollowupFromResponse(run, responseId, 'response_done');
    return;
  }

  if (event.type === 'response.completed' || event.type === 'response.failed') {
    const normalized = {
      type: 'response.done',
      response: event.response || {
        id: event.response_id || null,
        status: event.type === 'response.failed' ? 'failed' : 'completed',
        output: []
      }
    };

    if (event.type === 'response.failed' && normalized.response.status !== 'failed') {
      normalized.response.status = 'failed';
    }

    handleRealtimeEvent(run, normalized);
  }
}

function scheduleToolCall(run, call) {
  if (!call.name) return;
  const callKey = call.callId || createFallbackCallId(call.name, call.arguments);
  if (run.handledCallIds.has(callKey)) return;

  const responseId = call.responseId || run.callToResponseId.get(callKey) || run.inflightResponseId || 'unknown';
  const responseState = getOrCreateResponseState(run, responseId);
  responseState.hadFunctionCall = true;
  responseState.pendingCallIds.add(callKey);
  run.callToResponseId.set(callKey, responseId);

  run.toolQueue = run.toolQueue
    .then(() => processToolCall(run, {
      callId: callKey,
      name: call.name,
      arguments: call.arguments,
      responseId
    }))
    .catch((error) => {
      appendRunEvent('tool_queue_error', { message: error.message });
    });
}

async function processToolCall(run, call) {
  if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
  if (run.handledCallIds.has(call.callId)) return;
  run.handledCallIds.add(call.callId);
  run.pendingToolCalls.delete(call.callId);

  let args;
  try {
    args = parseJsonSafe(call.arguments, {});
  } catch (error) {
    args = {};
  }

  appendRunEvent('tool_call', {
    callId: call.callId,
    name: call.name,
    arguments: args
  });

  setAiStatus(`tool: ${call.name}`);

  let shouldStopAfterTool = false;
  try {
    if (call.name === 'finish' && run.lastVisualChangeAtMs >= 0 && run.lastScreenshotAtMs < run.lastVisualChangeAtMs) {
      const blockedOutput = {
        ok: false,
        blocked: true,
        reason: 'finish_requires_final_screenshot',
        message: 'Call take_screenshot after your latest drawing edits, review it, then call finish.'
      };

      enqueueInputItems(run, [
        {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(blockedOutput)
        }
      ]);

      appendRunEvent('tool_result', {
        callId: call.callId,
        name: call.name,
        result: sanitizeForLog(blockedOutput),
        attachedImage: false
      });

      setAiStatus('finish blocked: final screenshot required.');
      return;
    }

    if (call.name === 'finish' && run.pendingReflectAfterScreenshot) {
      const blockedOutput = {
        ok: false,
        blocked: true,
        reason: 'finish_requires_reflect_after_screenshot',
        message: 'Call reflect after reviewing your latest screenshot, then call finish.'
      };

      enqueueInputItems(run, [
        {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(blockedOutput)
        }
      ]);

      appendRunEvent('tool_result', {
        callId: call.callId,
        name: call.name,
        result: sanitizeForLog(blockedOutput),
        attachedImage: false
      });

      setAiStatus('finish blocked: reflection required after screenshot.');
      return;
    }

    if (call.name === 'finish' && run.lastReflectWantsMoreWork) {
      const blockedOutput = {
        ok: false,
        blocked: true,
        reason: 'finish_blocked_low_confidence',
        message: 'Your last reflection had confidence below 90% and listed next actions. Execute those improvements, then take_screenshot and reflect again.'
      };

      enqueueInputItems(run, [
        {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify(blockedOutput)
        }
      ]);

      appendRunEvent('tool_result', {
        callId: call.callId,
        name: call.name,
        result: sanitizeForLog(blockedOutput),
        attachedImage: false
      });

      setAiStatus('finish blocked: low confidence — more work needed.');
      return;
    }

    const result = await executeAgentTool(call.name, args);

    const inputItems = [
      {
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(result.output)
      }
    ];

    if (result.imageDataUrl) {
      run.screenshotCount += 1;
      if (call.name === 'take_screenshot') {
        run.lastScreenshotAtMs = Date.now() - run.startedAt;
        run.pendingReflectAfterScreenshot = true;
        run.screenshotArtifacts.push({
          atMs: run.lastScreenshotAtMs,
          includeGrid: Boolean(result.output?.includeGrid),
          width: Number(result.output?.width) || null,
          height: Number(result.output?.height) || null,
          imageDataUrl: result.imageDataUrl
        });
      }

      const screenshotContent = [
        {
          type: 'input_text',
          text: result.imageNote || 'Requested canvas screenshot attached.'
        }
      ];

      if (call.name === 'take_screenshot') {
        screenshotContent.push({
          type: 'input_text',
          text: 'Now call reflect with a short critique: what works, one issue to fix, and your next concrete edits.'
        });
      }

      screenshotContent.push({
        type: 'input_image',
        image_url: result.imageDataUrl
      });

      inputItems.push({
        role: 'user',
        content: screenshotContent
      });
    }

    enqueueInputItems(run, inputItems);

    appendRunEvent('tool_result', {
      callId: call.callId,
      name: call.name,
      result: sanitizeForLog(result.output),
      attachedImage: Boolean(result.imageDataUrl)
    });

    if (call.name === 'finish') {
      shouldStopAfterTool = true;
      stopAiRun('Agent called finish.', {
        finishedByAgent: true,
        finishSummary: String(args.summary || '').trim() || null
      });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendRunEvent('tool_execution_error', {
      callId: call.callId,
      name: call.name,
      message
    });
    enqueueInputItems(run, [
      {
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify({
          ok: false,
          error: message
        })
      }
    ]);
  } finally {
    if (!shouldStopAfterTool && state.aiRun && state.aiRun.id === run.id && state.aiRun.active) {
      markResponseCallDone(run, call.responseId, call.callId);
      maybeQueueFollowupFromResponse(run, call.responseId, 'tool_call_completed');
    }
  }
}

function getOrCreateResponseState(run, responseId) {
  const key = responseId || 'unknown';
  let responseState = run.responseStateById.get(key);
  if (!responseState) {
    responseState = {
      pendingCallIds: new Set(),
      done: false,
      hadFunctionCall: false,
      followupQueued: false
    };
    run.responseStateById.set(key, responseState);
  }
  return responseState;
}

function markResponseCallDone(run, responseId, callId) {
  if (!responseId) return;
  const responseState = run.responseStateById.get(responseId);
  if (!responseState) return;
  responseState.pendingCallIds.delete(callId);
}

function maybeQueueFollowupFromResponse(run, responseId, reason) {
  if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
  const responseState = run.responseStateById.get(responseId);
  if (!responseState) return;
  if (!responseState.done) return;
  if (responseState.pendingCallIds.size > 0) return;
  if (responseState.followupQueued) return;

  responseState.followupQueued = true;
  queueResponseCreate(run, reason);

  // Keep bookkeeping bounded once responses are fully resolved.
  if (run.responseStateById.size > 30) {
    for (const [id, stateEntry] of run.responseStateById.entries()) {
      if (stateEntry.done && stateEntry.pendingCallIds.size === 0) {
        run.responseStateById.delete(id);
      }
      if (run.responseStateById.size <= 18) break;
    }
  }
}

function handleRateLimitFailure(run, message) {
  run.inflightResponseId = null;
  run.rateLimitHits += 1;
  if (run.rateLimitHits > MAX_RATE_LIMIT_RECOVERIES) {
    stopAiRun('Stopped: repeated rate-limit failures.', { rateLimited: true });
    return;
  }

  const retryFromMessage = parseRetryAfterSeconds(message);
  const retryFromLimit = Number(run.rateLimits.tokens?.resetSeconds);
  const retrySeconds = Math.max(
    Number.isFinite(retryFromMessage) ? retryFromMessage : 0,
    Number.isFinite(retryFromLimit) ? retryFromLimit : 0,
    1
  );

  run.backoffUntilMs = Date.now() + Math.ceil(retrySeconds * 1000) + RESPONSE_CREATE_RETRY_BUFFER_MS;
  setAiStatus(`rate limited; retrying in ${retrySeconds.toFixed(1)}s...`);
  queueResponseCreate(run, 'rate_limit_recovery');
}

function enqueueInputItems(run, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  run.pendingInputItems.push(...items);
  appendRunEvent('input_items_enqueued', {
    count: items.length,
    items: sanitizeForLog(items)
  });
}

function queueResponseCreate(run, reason) {
  if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
  run.pendingResponseCreate = true;
  if (reason) {
    run.pendingResponseReason = reason;
  }
  maybeSendQueuedResponseCreate(run);
}

function maybeSendQueuedResponseCreate(run) {
  if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
  if (!run.pendingResponseCreate) return;
  if (run.inflightResponseId) return;
  if (!run.ws || run.ws.readyState !== WebSocket.OPEN) return;

  const now = Date.now();
  if (run.backoffUntilMs > now) {
    scheduleResponseCreateRetry(run, run.backoffUntilMs - now, 'rate_limit_backoff');
    return;
  }

  const tokenLimit = run.rateLimits.tokens;
  if (tokenLimit && Number.isFinite(tokenLimit.remaining) && tokenLimit.remaining < RESPONSE_CREATE_MIN_TOKENS) {
    const waitSeconds = Math.max(0.5, Number(tokenLimit.resetSeconds) || 1);
    const waitMs = Math.ceil(waitSeconds * 1000) + RESPONSE_CREATE_RETRY_BUFFER_MS;
    setAiStatus(`waiting for token budget reset (${waitSeconds.toFixed(1)}s)...`);
    scheduleResponseCreateRetry(run, waitMs, 'token_budget_guard');
    return;
  }

  run.pendingResponseCreate = false;
  const reason = run.pendingResponseReason || 'continue';
  run.pendingResponseReason = null;
  run.inflightResponseId = 'pending';
  const inputItems = [...run.pendingInputItems];
  run.pendingInputItems = [];

  const responsePayload = {
    model: run.model,
    store: false,
    tools: getRealtimeTools(),
    tool_choice: 'auto'
  };

  if (run.responseCreateCount === 0) {
    responsePayload.instructions = buildRealtimeInstructions(run.prompt);
  }

  if (run.latestResponseId) {
    responsePayload.previous_response_id = run.latestResponseId;
  }

  if (inputItems.length > 0) {
    responsePayload.input = inputItems;
  }

  if (run.responseCreateCount > 0 && !run.latestResponseId) {
    stopAiRun('Stopped: missing previous_response_id for continuation.', { protocolError: true });
    return;
  }

  run.responseCreateCount += 1;

  appendRunEvent('response_create_requested', {
    reason,
    previousResponseId: responsePayload.previous_response_id || null,
    hasInput: inputItems.length > 0,
    inputCount: inputItems.length
  });
  setAiStatus('requesting next model step...');
  sendRealtime(run, {
    type: 'response.create',
    ...responsePayload
  });
}

function scheduleResponseCreateRetry(run, delayMs, reason) {
  if (!state.aiRun || state.aiRun.id !== run.id || !state.aiRun.active) return;
  const normalizedDelay = clamp(Math.round(delayMs), 100, 30000);
  clearTimeout(run.responseRetryHandle);
  run.responseRetryHandle = setTimeout(() => {
    run.responseRetryHandle = null;
    maybeSendQueuedResponseCreate(run);
  }, normalizedDelay);

  appendRunEvent('response_retry_scheduled', {
    reason,
    delayMs: normalizedDelay
  });
}

function parseRetryAfterSeconds(message) {
  const raw = String(message || '');
  const match = raw.match(/try again in\s+([0-9]*\.?[0-9]+)s/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function normalizedToCanvasCoordinate(rawValue, maxValue) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric >= 0 && numeric <= 1) {
    return clamp(Math.round(numeric * maxValue), 0, maxValue);
  }
  return clamp(Math.round(numeric), 0, maxValue);
}

function normalizedToCanvasX(rawValue) {
  return normalizedToCanvasCoordinate(rawValue, CANVAS_WIDTH);
}

function normalizedToCanvasY(rawValue) {
  return normalizedToCanvasCoordinate(rawValue, CANVAS_HEIGHT);
}

async function executeAgentTool(name, args) {
  const safeArgs = args && typeof args === 'object' ? args : {};

  switch (name) {
    case 'stroke_line': {
      const tool = ['pencil', 'brush', 'eraser'].includes(safeArgs.tool) ? safeArgs.tool : null;
      if (!tool) {
        return {
          output: {
            ok: false,
            error: 'Invalid stroke_line tool. Use pencil, brush, or eraser.'
          }
        };
      }

      pushUndoSnapshot(state.aiRun);
      const action = executeDrawAction({
        tool,
        color: safeArgs.color || state.drawing.color,
        lineWidth: safeArgs.lineWidth || state.drawing.lineWidth,
        startX: normalizedToCanvasX(safeArgs.startX),
        startY: normalizedToCanvasY(safeArgs.startY),
        x: normalizedToCanvasX(safeArgs.endX),
        y: normalizedToCanvasY(safeArgs.endY)
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'stroke_polyline': {
      const points = safeArgs.points;
      if (!Array.isArray(points) || points.length < 2) {
        return {
          output: {
            ok: false,
            error: 'stroke_polyline requires an array of at least 2 points.'
          }
        };
      }

      const tool = ['pencil', 'brush', 'eraser'].includes(safeArgs.tool) ? safeArgs.tool : 'pencil';
      const color = safeArgs.color || state.drawing.color;
      const lineWidth = clamp(Math.round(Number(safeArgs.lineWidth) || state.drawing.lineWidth), 1, 50);
      const normalizedColor = normalizeColor(color);

      pushUndoSnapshot(state.aiRun);

      const pixelPoints = points.map(p => ({
        x: normalizedToCanvasX(p.x),
        y: normalizedToCanvasY(p.y)
      }));

      ctx.beginPath();
      ctx.strokeStyle = tool === 'eraser' ? '#FFFFFF' : normalizedColor;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
      for (let i = 1; i < pixelPoints.length; i++) {
        ctx.lineTo(pixelPoints[i].x, pixelPoints[i].y);
      }
      ctx.stroke();

      const action = { tool, color: normalizedColor, lineWidth, points: pixelPoints, pointCount: pixelPoints.length };

      if (state.aiRun?.active) {
        appendRunAction('stroke_polyline', action);
        appendRunEvent('tool_effect', { kind: 'stroke_polyline', action });
        state.aiRun.lastVisualChangeAtMs = Date.now() - state.aiRun.startedAt;
      }

      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'stroke_rectangle': {
      pushUndoSnapshot(state.aiRun);
      const action = executeDrawAction({
        tool: 'rectangle',
        color: safeArgs.color || state.drawing.color,
        lineWidth: safeArgs.lineWidth || state.drawing.lineWidth,
        startX: normalizedToCanvasX(safeArgs.x1),
        startY: normalizedToCanvasY(safeArgs.y1),
        x: normalizedToCanvasX(safeArgs.x2),
        y: normalizedToCanvasY(safeArgs.y2)
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'stroke_circle': {
      pushUndoSnapshot(state.aiRun);
      const action = executeDrawAction({
        tool: 'circle',
        color: safeArgs.color || state.drawing.color,
        lineWidth: safeArgs.lineWidth || state.drawing.lineWidth,
        startX: normalizedToCanvasX(safeArgs.centerX),
        startY: normalizedToCanvasY(safeArgs.centerY),
        x: normalizedToCanvasX(safeArgs.edgeX),
        y: normalizedToCanvasY(safeArgs.edgeY)
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'spray_cluster': {
      pushUndoSnapshot(state.aiRun);
      const pointX = normalizedToCanvasX(safeArgs.x);
      const pointY = normalizedToCanvasY(safeArgs.y);
      const action = executeDrawAction({
        tool: 'spray',
        color: safeArgs.color || state.drawing.color,
        lineWidth: safeArgs.lineWidth || state.drawing.lineWidth,
        startX: pointX,
        startY: pointY,
        x: pointX,
        y: pointY,
        seed: safeArgs.seed
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'flood_fill': {
      pushUndoSnapshot(state.aiRun);
      const pointX = normalizedToCanvasX(safeArgs.x);
      const pointY = normalizedToCanvasY(safeArgs.y);
      const action = executeDrawAction({
        tool: 'fill',
        color: safeArgs.color || state.drawing.color,
        lineWidth: 1,
        startX: pointX,
        startY: pointY,
        x: pointX,
        y: pointY
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'set_tool': {
      const tool = VALID_TOOLS.includes(safeArgs.tool) ? safeArgs.tool : null;
      if (!tool) return { output: { ok: false, error: 'Invalid tool.' } };
      setTool(tool);
      return { output: { ok: true } };
    }

    case 'set_color': {
      const color = normalizeColor(safeArgs.color);
      setColor(color);
      return { output: { ok: true } };
    }

    case 'set_line_width': {
      const width = clamp(Math.round(Number(safeArgs.lineWidth) || 1), 1, 50);
      setLineWidth(width);
      return { output: { ok: true } };
    }

    case 'draw_action': {
      pushUndoSnapshot(state.aiRun);
      const action = executeDrawAction({
        tool: safeArgs.tool || state.drawing.currentTool,
        color: safeArgs.color || state.drawing.color,
        lineWidth: safeArgs.lineWidth || state.drawing.lineWidth,
        startX: normalizedToCanvasX(safeArgs.startX),
        startY: normalizedToCanvasY(safeArgs.startY),
        x: normalizedToCanvasX(safeArgs.x),
        y: normalizedToCanvasY(safeArgs.y),
        seed: safeArgs.seed
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'fill_rectangle': {
      pushUndoSnapshot(state.aiRun);
      const action = fillRectangleAction({
        color: safeArgs.color || state.drawing.color,
        x1: normalizedToCanvasX(safeArgs.x1),
        y1: normalizedToCanvasY(safeArgs.y1),
        x2: normalizedToCanvasX(safeArgs.x2),
        y2: normalizedToCanvasY(safeArgs.y2)
      }, { source: 'ai' });
      return {
        output: {
          ok: true,
          action
        }
      };
    }

    case 'clear_canvas': {
      const clearAllowed = state.aiRun ? state.aiRun.allowClearTool : ui.allowClearTool.checked;
      if (!clearAllowed) {
        return {
          output: {
            ok: false,
            blocked: true,
            message: 'clear_canvas is disabled by default. continue by editing the existing image.'
          }
        };
      }

      pushUndoSnapshot(state.aiRun);
      clearCanvas({ source: 'ai' });
      return { output: { ok: true } };
    }

    case 'take_screenshot': {
      const includeGrid = typeof safeArgs.includeGrid === 'boolean'
        ? safeArgs.includeGrid
        : (state.aiRun ? state.aiRun.gridForScreenshots : ui.gridForScreenshots.checked);
      const imageDataUrl = captureCanvasDataUrl(includeGrid, {
        maxSide: SCREENSHOT_MAX_SIDE,
        outputType: SCREENSHOT_OUTPUT_TYPE,
        quality: SCREENSHOT_JPEG_QUALITY
      });
      const dimensions = getScaledCanvasDimensions(SCREENSHOT_MAX_SIDE);

      if (state.aiRun) {
        state.aiRun.lastScreenshotImageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        appendRunAction('take_screenshot', {});
      }

      return {
        output: {
          ok: true,
          width: dimensions.width,
          height: dimensions.height,
          includeGrid,
          imageAttached: true
        },
        imageDataUrl,
        imageNote: includeGrid
          ? `Screenshot attached with coordinate grid overlay (${dimensions.width}x${dimensions.height}).`
          : `Screenshot attached (${dimensions.width}x${dimensions.height}).`
      };
    }

    case 'reflect': {
      const allowedPhases = ['explore', 'block_in', 'structure', 'refine', 'final_review'];
      const phase = allowedPhases.includes(String(safeArgs.phase))
        ? String(safeArgs.phase)
        : 'refine';
      const whatWorks = String(safeArgs.whatWorks || '').trim().slice(0, 280);
      const issueToFix = String(safeArgs.issueToFix || '').trim().slice(0, 280);
      const nextActions = Array.isArray(safeArgs.nextActions)
        ? safeArgs.nextActions
          .map((entry) => String(entry || '').trim().slice(0, 180))
          .filter(Boolean)
          .slice(0, 6)
        : [];
      const rawConfidence = Number(safeArgs.confidence);
      const confidence = Number.isFinite(rawConfidence) ? clamp(rawConfidence, 0, 1) : null;

      const reflection = {
        phase,
        whatWorks,
        issueToFix,
        nextActions,
        confidence
      };

      if (!whatWorks || !issueToFix || nextActions.length === 0) {
        return {
          output: {
            ok: false,
            error: 'reflect requires non-empty whatWorks, issueToFix, and nextActions.'
          }
        };
      }

      if (state.aiRun) {
        state.aiRun.lastReflectAtMs = Date.now() - state.aiRun.startedAt;
        state.aiRun.pendingReflectAfterScreenshot = false;
        state.aiRun.reflectionCount += 1;
        appendRunAction('reflect', reflection);
        appendRunEvent('tool_effect', { kind: 'reflect', reflection });
      }

      const lowConfidence = confidence !== null && confidence < 0.9;
      const hasNextActions = nextActions.length > 0;
      const shouldContinue = lowConfidence && hasNextActions;

      if (state.aiRun) {
        state.aiRun.lastReflectWantsMoreWork = shouldContinue;
      }

      return {
        output: {
          ok: true,
          reflectionCount: state.aiRun ? state.aiRun.reflectionCount : null,
          shouldContinue,
          message: shouldContinue
            ? `Confidence ${(confidence * 100).toFixed(0)}% is below 90%. Execute your nextActions before finishing.`
            : 'Reflection recorded. You may finish if satisfied.'
        }
      };
    }

    case 'undo': {
      const restored = popAndRestoreUndo(state.aiRun);
      if (restored) {
        appendRunAction('undo', {});
        appendRunEvent('tool_effect', { kind: 'undo' });
        if (state.aiRun) {
          state.aiRun.lastVisualChangeAtMs = Date.now() - state.aiRun.startedAt;
        }
      }
      return {
        output: {
          ok: restored,
          message: restored ? 'Reverted to previous canvas state.' : 'Nothing to undo.',
          undoStackSize: state.aiRun ? state.aiRun.undoStack.length : 0
        }
      };
    }

    case 'undo_to_screenshot': {
      const restored = restoreToLastScreenshot(state.aiRun);
      if (restored) {
        appendRunAction('undo_to_screenshot', {});
        appendRunEvent('tool_effect', { kind: 'undo_to_screenshot' });
        if (state.aiRun) {
          state.aiRun.lastVisualChangeAtMs = Date.now() - state.aiRun.startedAt;
        }
      }
      return {
        output: {
          ok: restored,
          message: restored ? 'Canvas restored to last screenshot state. Undo stack cleared.' : 'No screenshot checkpoint available.'
        }
      };
    }

    case 'finish': {
      return {
        output: {
          ok: true,
          summary: String(safeArgs.summary || '')
        }
      };
    }

    default:
      return {
        output: {
          ok: false,
          error: `Unknown tool: ${name}`
        }
      };
  }
}

function stopAiRun(reason, options = {}) {
  const run = state.aiRun;
  if (!run || !run.active) {
    setControlMode('human');
    return;
  }

  if (run.stopping) return;
  run.stopping = true;

  clearTimeout(run.runTimeoutHandle);
  clearInterval(run.countdownHandle);
  clearTimeout(run.responseRetryHandle);

  appendRunEvent('run_stopping', {
    reason,
    manual: Boolean(options.manual),
    timedOut: Boolean(options.timedOut),
    finishedByAgent: Boolean(options.finishedByAgent)
  });

  if (run.ws && run.ws.readyState === WebSocket.OPEN) {
    try {
      run.ws.close(1000, 'run stopped');
    } catch (error) {
      appendRunEvent('socket_close_error', { message: error.message });
    }
  }

  run.active = false;
  run.log.finalReason = reason;
  run.log.finishedByAgent = Boolean(options.finishedByAgent);
  run.log.finishSummary = options.finishSummary || null;
  run.log.endedAt = new Date().toISOString();
  run.log.storage = {
    autosaved: false,
    pending: true,
    attemptedAt: new Date().toISOString()
  };

  state.lastRunLog = run.log;

  // Capture result card for gallery (single runs and eval runs)
  const capturedImageDataUrl = captureCanvasDataUrl(false, {
    maxSide: Math.max(CANVAS_WIDTH, CANVAS_HEIGHT),
    outputType: 'image/png',
    quality: 0.92
  });
  const resultForCard = summarizeEvalRun(
    { prompt: run.prompt, model: run.model, maxRunSeconds: run.maxRunSeconds, gridForScreenshots: run.gridForScreenshots, allowClearTool: run.allowClearTool, comboIndex: 0, repeat: 1 },
    run.log
  );
  addResultCard(resultForCard, capturedImageDataUrl);

  state.aiRun = null;

  updateRunTimer('--');
  setAiStatus(reason);

  ui.startAiButton.disabled = false;
  ui.stopAiButton.disabled = true;
  ui.stopAiButton.textContent = 'Stop';

  const hasActions = Array.isArray(state.lastRunLog.actions) && state.lastRunLog.actions.length > 0;
  ui.downloadLog.disabled = !hasActions;

  setControlMode('human');

  const runId = run.id;
  const logRef = state.lastRunLog;
  setAutosaveStatus(`Autosave: saving artifacts for run ${runId}...`);
  void autosaveCompletedRun(run)
    .then((saveResult) => {
      if (!logRef) return;
      logRef.storage = {
        autosaved: true,
        pending: false,
        attemptedAt: logRef.storage?.attemptedAt || null,
        savedAt: saveResult.storage?.savedAt || new Date().toISOString(),
        logFile: saveResult.storage?.logFile || null,
        finalImageFile: saveResult.storage?.finalImageFile || null,
        screenshotFiles: saveResult.storage?.screenshotFiles || [],
        indexFile: saveResult.storage?.indexFile || null,
        warnings: Array.isArray(saveResult.storage?.warnings) ? saveResult.storage.warnings : []
      };

      appendDetachedRunEvent(logRef, 'run_autosave_completed', sanitizeForLog(logRef.storage));

      const shortLogPath = saveResult.storage?.logFile || '(unknown path)';
      setAutosaveStatus(`Autosave: saved ${shortLogPath}`);

      if (!state.aiRun || state.aiRun.id === runId) {
        setAiStatus(`${reason} Artifacts saved to ${shortLogPath}.`);
      }
    })
    .catch((error) => {
      if (!logRef) return;
      logRef.storage = {
        autosaved: false,
        pending: false,
        attemptedAt: logRef.storage?.attemptedAt || null,
        error: error.message || String(error)
      };
      appendDetachedRunEvent(logRef, 'run_autosave_failed', { message: error.message || String(error) });

      const errorMessage = error.message || String(error);
      setAutosaveStatus(`Autosave: failed (${errorMessage}).`);
      if (!state.aiRun || state.aiRun.id === runId) {
        setAiStatus(`${reason} Autosave failed: ${errorMessage}`);
      }
    });
}

async function autosaveCompletedRun(run) {
  if (!run?.log) {
    throw new Error('No run log available to autosave.');
  }

  const finalImageDataUrl = captureCanvasDataUrl(false, {
    maxSide: Math.max(CANVAS_WIDTH, CANVAS_HEIGHT),
    outputType: 'image/png',
    quality: 0.92
  });

  const screenshotArtifacts = Array.isArray(run.screenshotArtifacts)
    ? run.screenshotArtifacts.slice(0, MAX_AUTOSAVE_SCREENSHOTS)
    : [];

  const droppedScreenshots = (Array.isArray(run.screenshotArtifacts) ? run.screenshotArtifacts.length : 0) - screenshotArtifacts.length;
  if (droppedScreenshots > 0) {
    appendDetachedRunEvent(run.log, 'run_autosave_screenshot_limit', {
      kept: screenshotArtifacts.length,
      dropped: droppedScreenshots
    });
  }

  const response = await fetch('/api/runs/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      log: run.log,
      finalImageDataUrl,
      screenshots: screenshotArtifacts
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || `Autosave request failed (${response.status}).`);
  }

  return payload;
}

function sendRealtime(run, event) {
  if (!run?.ws || run.ws.readyState !== WebSocket.OPEN) return;
  run.ws.send(JSON.stringify(event));
  appendRunEvent('ws_send', sanitizeForLog(event));
}

function buildRealtimeInstructions(prompt) {
  return [
    `You are a painter. Your commission: "${prompt}".`,
    '',
    'COORDINATE SYSTEM:',
    `  Runtime canvas is ${CANVAS_WIDTH}x${CANVAS_HEIGHT} pixels.`,
    '  All tool coordinates MUST be normalized in [0.0, 1.0].',
    '  (0,0) is top-left. (1,1) is bottom-right. (0.5,0.5) is center.',
    '',
    'PAINTING WORKFLOW:',
    '  1. Start with background blocks using fill_rectangle.',
    '  2. Build major forms with stroke_line, stroke_polyline, stroke_rectangle, stroke_circle.',
    '  3. Add atmosphere and texture with spray_cluster and flood_fill.',
    '  4. Take screenshots regularly, then call reflect to critique and plan next edits.',
    '  5. If reflect shows confidence below 90%, you MUST execute your nextActions, then screenshot + reflect again.',
    '  6. Repeat the paint→screenshot→reflect loop until confidence reaches 90%+, then call finish.',
    '',
    'TOOLS:',
    '  fill_rectangle(color,x1,y1,x2,y2) -> solid rectangle fill.',
    '  stroke_line(tool,color,lineWidth,startX,startY,endX,endY) -> tool: pencil, brush, eraser.',
    '  stroke_polyline(color,lineWidth,points[{x,y}],tool?) -> connected path through 2-64 normalized points. Use for curves and organic shapes.',
    '  stroke_rectangle(color,lineWidth,x1,y1,x2,y2) -> outlined rectangle.',
    '  stroke_circle(color,lineWidth,centerX,centerY,edgeX,edgeY) -> outlined circle.',
    '  spray_cluster(color,lineWidth,x,y,seed?) -> clustered spray texture.',
    '  flood_fill(color,x,y) -> flood fill from point.',
    '  reflect(phase,whatWorks,issueToFix,nextActions,confidence?) -> short planning/critique checkpoint.',
    '  undo -> revert last operation.',
    '  undo_to_screenshot -> revert to last screenshot checkpoint.',
    '',
    'STYLE GUIDANCE:',
    '  Be bold: large confident shapes read better than tiny precise ones.',
    '  Trust your instincts. Imperfection is expressive.',
    '  Layer colors: paint over earlier layers to build depth and richness.',
    '  Use color temperature: warm foregrounds, cool backgrounds for depth.',
    '',
    'TECHNICAL REQUIREMENTS:',
    '  Use tool calls only. Do not return plain text answers.',
    '  Keep coordinates normalized in [0,1].',
    '  Batch multiple tool calls per response when useful.',
    '  Take a screenshot every 12-20 drawing operations.',
    '  After each screenshot, call reflect. If confidence < 90%, execute your nextActions before finishing.',
    '  clear_canvas is destructive and may be blocked.',
    '  When complete, call finish with a concise summary of what you painted.'
  ].join('\n');
}

function getRealtimeTools() {
  const normalizedCoord = {
    type: 'number',
    minimum: 0,
    maximum: 1
  };

  return [
    {
      type: 'function',
      name: 'stroke_line',
      description: 'Draw one line segment using pencil, brush, or eraser with normalized coordinates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: {
            type: 'string',
            enum: ['pencil', 'brush', 'eraser']
          },
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          lineWidth: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          },
          startX: normalizedCoord,
          startY: normalizedCoord,
          endX: normalizedCoord,
          endY: normalizedCoord
        },
        required: ['tool', 'color', 'lineWidth', 'startX', 'startY', 'endX', 'endY']
      }
    },
    {
      type: 'function',
      name: 'stroke_polyline',
      description: 'Draw a connected path through multiple normalized points. Great for curves, organic shapes, and flowing lines.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          lineWidth: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          },
          points: {
            type: 'array',
            minItems: 2,
            maxItems: 64,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 }
              },
              required: ['x', 'y']
            }
          },
          tool: {
            type: 'string',
            enum: ['pencil', 'brush', 'eraser'],
            default: 'pencil'
          }
        },
        required: ['color', 'lineWidth', 'points']
      }
    },
    {
      type: 'function',
      name: 'stroke_rectangle',
      description: 'Draw an outlined rectangle between two normalized corner points.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          lineWidth: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          },
          x1: normalizedCoord,
          y1: normalizedCoord,
          x2: normalizedCoord,
          y2: normalizedCoord
        },
        required: ['color', 'lineWidth', 'x1', 'y1', 'x2', 'y2']
      }
    },
    {
      type: 'function',
      name: 'stroke_circle',
      description: 'Draw an outlined circle from normalized center and edge points.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          lineWidth: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          },
          centerX: normalizedCoord,
          centerY: normalizedCoord,
          edgeX: normalizedCoord,
          edgeY: normalizedCoord
        },
        required: ['color', 'lineWidth', 'centerX', 'centerY', 'edgeX', 'edgeY']
      }
    },
    {
      type: 'function',
      name: 'spray_cluster',
      description: 'Spray a textured cluster at a normalized point.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          lineWidth: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          },
          x: normalizedCoord,
          y: normalizedCoord,
          seed: {
            type: 'integer',
            minimum: 0,
            maximum: 4294967295
          }
        },
        required: ['color', 'lineWidth', 'x', 'y']
      }
    },
    {
      type: 'function',
      name: 'flood_fill',
      description: 'Flood fill a connected region from a normalized point.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          x: normalizedCoord,
          y: normalizedCoord
        },
        required: ['color', 'x', 'y']
      }
    },
    {
      type: 'function',
      name: 'fill_rectangle',
      description: 'Fill a rectangle with solid color between two normalized corners.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          x1: normalizedCoord,
          y1: normalizedCoord,
          x2: normalizedCoord,
          y2: normalizedCoord
        },
        required: ['color', 'x1', 'y1', 'x2', 'y2']
      }
    },
    {
      type: 'function',
      name: 'clear_canvas',
      description: 'Clear canvas to white. Destructive; may be blocked.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: {
            type: 'string'
          }
        }
      }
    },
    {
      type: 'function',
      name: 'take_screenshot',
      description: 'Screenshot the canvas. Also sets the undo_to_screenshot checkpoint.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeGrid: {
            type: 'boolean'
          }
        }
      }
    },
    {
      type: 'function',
      name: 'reflect',
      description: 'Record a brief critique and next-step plan after reviewing a screenshot.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          phase: {
            type: 'string',
            enum: ['explore', 'block_in', 'structure', 'refine', 'final_review']
          },
          whatWorks: {
            type: 'string',
            maxLength: 280
          },
          issueToFix: {
            type: 'string',
            maxLength: 280
          },
          nextActions: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'string',
              maxLength: 180
            }
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1
          }
        },
        required: ['phase', 'whatWorks', 'issueToFix', 'nextActions']
      }
    },
    {
      type: 'function',
      name: 'undo',
      description: 'Undo the last drawing operation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {}
      }
    },
    {
      type: 'function',
      name: 'undo_to_screenshot',
      description: 'Revert canvas to last screenshot checkpoint. Clears undo stack.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {}
      }
    },
    {
      type: 'function',
      name: 'finish',
      description: 'Mark the run complete.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: {
            type: 'string'
          }
        },
        required: ['summary']
      }
    }
  ];
}

function captureCanvasDataUrl(includeGrid, options = {}) {
  const maxSide = clamp(
    Math.round(Number(options.maxSide) || Math.max(CANVAS_WIDTH, CANVAS_HEIGHT)),
    128,
    Math.max(CANVAS_WIDTH, CANVAS_HEIGHT)
  );
  const outputType = options.outputType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const quality = clamp(Number(options.quality) || 0.82, 0.3, 1);

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = CANVAS_WIDTH;
  baseCanvas.height = CANVAS_HEIGHT;
  const baseCtx = baseCanvas.getContext('2d');
  baseCtx.drawImage(canvas, 0, 0);
  if (includeGrid) {
    drawGridOverlay(baseCtx, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  const sourceMaxSide = Math.max(CANVAS_WIDTH, CANVAS_HEIGHT);
  const scale = Math.min(1, maxSide / sourceMaxSide);
  if (scale >= 0.999) {
    return outputType === 'image/jpeg'
      ? baseCanvas.toDataURL(outputType, quality)
      : baseCanvas.toDataURL(outputType);
  }

  const outWidth = Math.max(1, Math.round(CANVAS_WIDTH * scale));
  const outHeight = Math.max(1, Math.round(CANVAS_HEIGHT * scale));
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outWidth;
  outCanvas.height = outHeight;
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(baseCanvas, 0, 0, outWidth, outHeight);

  return outputType === 'image/jpeg'
    ? outCanvas.toDataURL(outputType, quality)
    : outCanvas.toDataURL(outputType);
}

function getScaledCanvasDimensions(maxSide) {
  const sourceMaxSide = Math.max(CANVAS_WIDTH, CANVAS_HEIGHT);
  const scale = Math.min(1, Number(maxSide) / sourceMaxSide);
  return {
    width: Math.max(1, Math.round(CANVAS_WIDTH * scale)),
    height: Math.max(1, Math.round(CANVAS_HEIGHT * scale))
  };
}

function drawGridOverlay(targetCtx, width, height) {
  const gridSize = 50;
  targetCtx.save();

  targetCtx.strokeStyle = 'rgba(130, 130, 130, 0.25)';
  targetCtx.lineWidth = 0.5;

  for (let x = 0; x <= width; x += gridSize) {
    targetCtx.beginPath();
    targetCtx.moveTo(x, 0);
    targetCtx.lineTo(x, height);
    targetCtx.stroke();

    if (x > 0) {
      targetCtx.fillStyle = 'rgba(30, 30, 150, 0.65)';
      targetCtx.font = '9px monospace';
      targetCtx.fillText(String(x), x + 2, 11);
    }
  }

  for (let y = 0; y <= height; y += gridSize) {
    targetCtx.beginPath();
    targetCtx.moveTo(0, y);
    targetCtx.lineTo(width, y);
    targetCtx.stroke();

    if (y > 0) {
      targetCtx.fillStyle = 'rgba(30, 30, 150, 0.65)';
      targetCtx.font = '9px monospace';
      targetCtx.fillText(String(y), 2, y - 2);
    }
  }

  targetCtx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  targetCtx.fillRect(width - 262, height - 26, 258, 20);
  targetCtx.fillStyle = '#ffffff';
  targetCtx.font = '11px monospace';
  targetCtx.fillText('Coordinate grid overlay for AI screenshot', width - 258, height - 11);

  targetCtx.restore();
}

function appendRunEvent(kind, payload) {
  if (!state.aiRun?.active || !state.aiRun.log) return;
  state.aiRun.log.events.push({
    atMs: Date.now() - state.aiRun.startedAt,
    kind,
    payload
  });
}

function appendRunAction(kind, payload) {
  if (!state.aiRun?.active || !state.aiRun.log) return;
  state.aiRun.log.actions.push({
    atMs: Date.now() - state.aiRun.startedAt,
    kind,
    payload
  });
}

function appendDetachedRunEvent(log, kind, payload) {
  if (!log || !Array.isArray(log.events)) return;
  const startedAtMs = Number(new Date(log.startedAt));
  const atMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null;
  log.events.push({
    atMs,
    kind,
    payload
  });
}

function setAutosaveStatus(message) {
  if (!ui.autosaveStatus) return;
  ui.autosaveStatus.textContent = message;
}

function sanitizeForLog(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return `<image-data-uri length=${value.length} hash=${quickHash(value)}>`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry));
  }

  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = sanitizeForLog(nestedValue);
    }
    return output;
  }

  return value;
}

function downloadLastRunLog() {
  if (!state.lastRunLog) return;
  const data = JSON.stringify(state.lastRunLog, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const baseName = buildRunArtifactBaseName(state.lastRunLog);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${baseName}.json`;
  link.click();

  URL.revokeObjectURL(url);
}

// ── Results Gallery ──

function addResultCard(result, imageDataUrl) {
  if (!ui.resultsGallery) return;

  const card = document.createElement('div');
  card.className = 'result-card';

  const img = document.createElement('img');
  img.src = imageDataUrl;
  img.alt = `Result: ${result.prompt || ''}`.slice(0, 120);
  card.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'result-meta';

  const modelDiv = document.createElement('div');
  modelDiv.className = 'result-model';
  modelDiv.textContent = result.model || 'unknown';
  meta.appendChild(modelDiv);

  const promptDiv = document.createElement('div');
  promptDiv.textContent = truncateTextForStatus(result.prompt || '', 60);
  meta.appendChild(promptDiv);

  const statsDiv = document.createElement('div');
  const durationText = result.durationSec !== null ? `${Math.round(result.durationSec)}s` : '--';
  statsDiv.textContent = `${durationText} | ${result.actionCount || 0} actions`;
  meta.appendChild(statsDiv);

  const statusSpan = document.createElement('span');
  statusSpan.className = 'result-status ' + (result.finishedByAgent ? 'success' : 'failure');
  statusSpan.textContent = result.finishedByAgent ? 'Finished' : 'Stopped';
  meta.appendChild(statusSpan);

  card.appendChild(meta);

  card.addEventListener('click', () => {
    openResultOverlay(result, imageDataUrl);
  });

  ui.resultsGallery.appendChild(card);
}

function clearResultsGallery() {
  if (!ui.resultsGallery) return;
  ui.resultsGallery.innerHTML = '';
}

function openResultOverlay(result, imageDataUrl) {
  if (!ui.resultCardOverlay) return;

  ui.overlayImage.src = imageDataUrl;
  ui.overlayMeta.innerHTML = '';

  const fields = [
    ['Model', result.model],
    ['Prompt', result.prompt],
    ['Duration', result.durationSec !== null ? `${result.durationSec.toFixed(1)}s` : '--'],
    ['Actions', result.actionCount],
    ['Screenshots', result.screenshotActions],
    ['Reflections', result.reflectActions],
    ['Finished by agent', result.finishedByAgent ? 'Yes' : 'No'],
    ['Final reason', result.finalReason],
    ['Run ID', result.runId],
    ['Log file', result.logFile || '--']
  ];

  for (const [label, value] of fields) {
    const div = document.createElement('div');
    div.innerHTML = `<strong>${label}:</strong> ${escapeHtml(String(value ?? ''))}`;
    ui.overlayMeta.appendChild(div);
  }

  ui.resultCardOverlay.style.display = '';
}

function closeResultOverlay() {
  if (!ui.resultCardOverlay) return;
  ui.resultCardOverlay.style.display = 'none';
  ui.overlayImage.src = '';
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Eval Matrix ──

async function startEvalMatrix() {
  if (state.evalRunner.active) return;
  if (state.aiRun?.active) {
    setEvalStatus('Eval: wait for the current run to finish.');
    return;
  }
  setPanelMode('eval');

  let config;
  try {
    config = collectEvalMatrixConfigFromUi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setEvalStatus(`Eval: invalid configuration - ${message}`);
    return;
  }

  const queue = buildEvalQueue(config);
  if (queue.length === 0) {
    setEvalStatus('Eval: no combinations to run.');
    return;
  }

  state.evalRunner.active = true;
  state.evalRunner.stopRequested = false;
  state.evalRunner.queue = queue;
  state.evalRunner.results = [];
  state.evalRunner.startedAt = Date.now();
  state.evalRunner.config = config;
  state.evalRunner.runByRunId = new Map();
  state.evalRunner.current = null;
  state.insideEvalMatrix = true;
  updateEvalUi();

  clearResultsGallery();

  const tagNote = config.tag ? ` tag=${config.tag}` : '';
  setEvalStatus(
    `Eval: queued ${queue.length} run(s) across ${config.models.length} model batch(es).${tagNote}`
  );
  setAiStatus(`eval matrix running (${queue.length} runs)...`);
  let failedMessage = null;

  try {
    for (let i = 0; i < queue.length; i += 1) {
      if (state.evalRunner.stopRequested) break;

      const item = queue[i];
      state.evalRunner.current = {
        index: i + 1,
        total: queue.length,
        item
      };

      setEvalStatus([
        `Eval: running ${i + 1}/${queue.length}`,
        `batch=${item.modelBatchIndex || '?'} / ${item.modelBatchCount || config.models.length} model=${item.model} max=${item.maxRunSeconds}s`,
        `grid=${item.gridForScreenshots} clear=${item.allowClearTool}`,
        `prompt=${truncateTextForStatus(item.prompt, 100)}`
      ].join('\n'));

      if (config.clearCanvasEachRun) {
        clearCanvas({ source: 'eval', skipLog: true });
      }

      state.pendingRunOverrides = {
        prompt: item.prompt,
        model: item.model,
        maxRunSeconds: item.maxRunSeconds,
        allowClearTool: item.allowClearTool,
        gridForScreenshots: item.gridForScreenshots,
        evalMeta: {
          tag: config.tag || null,
          matrixId: config.matrixId,
          row: i + 1,
          totalRows: queue.length,
          comboIndex: item.comboIndex,
          repeat: item.repeat,
          comboKey: item.comboKey,
          promptIndex: item.promptIndex,
          modelBatchIndex: item.modelBatchIndex,
          modelBatchCount: item.modelBatchCount
        }
      };

      await startAiRun();
      const runId = state.aiRun?.id;
      if (!runId) {
        throw new Error(`Run ${i + 1} failed to start.`);
      }

      const runLog = await waitForRunLogAndAutosave(
        runId,
        Math.max((item.maxRunSeconds + 120) * 1000, 45_000)
      );
      const result = summarizeEvalRun(item, runLog);
      state.evalRunner.results.push(result);
      state.evalRunner.runByRunId.set(result.runId, result);
      updateEvalUi();

      const successes = state.evalRunner.results.filter((entry) => entry.finishedByAgent).length;
      setEvalStatus([
        `Eval: completed ${state.evalRunner.results.length}/${queue.length}`,
        `successes=${successes}`,
        `lastReason=${result.finalReason || '(none)'}`
      ].join('\n'));

      if (state.evalRunner.stopRequested) break;
      if (config.pauseMs > 0 && i < queue.length - 1) {
        let waitedMs = 0;
        while (waitedMs < config.pauseMs && !state.evalRunner.stopRequested) {
          const stepMs = Math.min(250, config.pauseMs - waitedMs);
          await sleep(stepMs);
          waitedMs += stepMs;
        }
      }

      const nextItem = i < queue.length - 1 ? queue[i + 1] : null;
      const modelChanged = Boolean(nextItem && nextItem.model !== item.model);
      if (modelChanged && config.modelBatchPauseMs > 0 && !state.evalRunner.stopRequested) {
        setEvalStatus([
          `Eval: completed model batch ${item.modelBatchIndex || '?'} / ${item.modelBatchCount || config.models.length}`,
          `Pausing ${config.modelBatchPauseMs}ms before next model (${nextItem.model})...`
        ].join('\n'));

        let waitedMs = 0;
        while (waitedMs < config.modelBatchPauseMs && !state.evalRunner.stopRequested) {
          const stepMs = Math.min(250, config.modelBatchPauseMs - waitedMs);
          await sleep(stepMs);
          waitedMs += stepMs;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failedMessage = message;
    setEvalStatus(`Eval: aborted - ${message}`);
  } finally {
    const total = state.evalRunner.results.length;
    const successes = state.evalRunner.results.filter((entry) => entry.finishedByAgent).length;
    const elapsedSeconds = state.evalRunner.startedAt
      ? Math.round((Date.now() - state.evalRunner.startedAt) / 1000)
      : 0;
    const wasStopped = state.evalRunner.stopRequested;

    state.evalRunner.active = false;
    state.evalRunner.stopRequested = false;
    state.evalRunner.current = null;
    state.insideEvalMatrix = false;
    updateEvalUi();

    if (failedMessage) {
      setEvalStatus(`Eval: failed. runs=${total}, successes=${successes}, error=${failedMessage}`);
      setAiStatus(`eval matrix failed (${successes}/${total} successes).`);
      return;
    }

    setEvalStatus(`Eval: ${wasStopped ? 'stopped' : 'complete'}. runs=${total}, successes=${successes}, elapsed=${elapsedSeconds}s.`);
    setAiStatus(`eval matrix ${wasStopped ? 'stopped' : 'complete'} (${successes}/${total} successes).`);
  }
}

function stopEvalMatrix() {
  if (!state.evalRunner.active) return;
  state.evalRunner.stopRequested = true;
  setEvalStatus('Eval: stop requested. Waiting for current run to finish.');
  if (state.aiRun?.active) {
    stopAiRun('Stopped by eval matrix.', { manual: true });
  }
}

function collectEvalMatrixConfigFromUi() {
  const prompts = parseLineList(ui.evalPrompts.value);
  if (prompts.length === 0) {
    const fallbackPrompt = String(ui.aiPrompt.value || '').trim();
    if (fallbackPrompt) {
      prompts.push(fallbackPrompt);
    }
  }
  if (prompts.length === 0) {
    throw new Error('Add at least one prompt.');
  }

  // Collect models from checkboxes + custom input
  const models = [];
  if (ui.evalModelCheckboxes) {
    const checkboxes = ui.evalModelCheckboxes.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (cb.checked) models.push(cb.value);
    }
  }
  if (ui.evalModelsCustom) {
    const customModels = parseCsvStringList(ui.evalModelsCustom.value);
    for (const m of customModels) {
      if (!models.includes(m)) models.push(m);
    }
  }
  if (models.length === 0) {
    throw new Error('Select at least one model.');
  }

  const maxRunSecondsValues = parseCsvNumberList(
    ui.evalMaxRunSeconds.value,
    (value) => clamp(Math.round(value), MIN_MAX_RUN_SECONDS, MAX_MAX_RUN_SECONDS),
    'max run seconds'
  );
  if (maxRunSecondsValues.length === 0) {
    throw new Error('Add at least one max run seconds value.');
  }

  const gridModes = parseCsvBooleanList(ui.evalGridModes.value, 'grid modes');
  if (gridModes.length === 0) {
    throw new Error('Add at least one grid mode.');
  }

  const allowClearModes = parseCsvBooleanList(ui.evalAllowClearModes.value, 'clear modes');
  if (allowClearModes.length === 0) {
    throw new Error('Add at least one clear mode.');
  }

  const repeats = clamp(Math.round(Number(ui.evalRepeats.value) || 1), 1, 20);
  ui.evalRepeats.value = String(repeats);

  const pauseMs = clamp(Math.round(Number(ui.evalPauseMs.value) || 0), 0, 60_000);
  ui.evalPauseMs.value = String(pauseMs);

  const modelBatchPauseMs = clamp(Math.round(Number(ui.evalModelBatchPauseMs.value) || 0), 0, 300_000);
  ui.evalModelBatchPauseMs.value = String(modelBatchPauseMs);

  const tagInput = String(ui.evalTag.value || '').trim();
  const tag = tagInput ? sanitizeFilenameSegment(tagInput, '') : '';
  if (tagInput && !tag) {
    throw new Error('Eval tag contains only invalid characters.');
  }

  return {
    prompts,
    models,
    maxRunSecondsValues,
    gridModes,
    allowClearModes,
    repeats,
    pauseMs,
    modelBatchPauseMs,
    clearCanvasEachRun: Boolean(ui.evalClearCanvasEachRun.checked),
    tag,
    matrixId: `eval-${formatTimestampForFilename(new Date())}-${Math.floor(Math.random() * 10_000)}`
  };
}

function buildEvalQueue(config) {
  const queue = [];
  let comboIndex = 0;

  for (let modelIndex = 0; modelIndex < config.models.length; modelIndex += 1) {
    const model = config.models[modelIndex];
    for (let promptIndex = 0; promptIndex < config.prompts.length; promptIndex += 1) {
      const prompt = config.prompts[promptIndex];
      for (const maxRunSeconds of config.maxRunSecondsValues) {
        for (const gridForScreenshots of config.gridModes) {
          for (const allowClearTool of config.allowClearModes) {
            comboIndex += 1;
            const comboKey = [
              `model=${model}`,
              `max=${maxRunSeconds}`,
              `grid=${gridForScreenshots}`,
              `clear=${allowClearTool}`,
              `prompt=${quickHash(prompt)}`
            ].join('|');

            for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
              queue.push({
                comboIndex,
                repeat,
                comboKey,
                modelBatchIndex: modelIndex + 1,
                modelBatchCount: config.models.length,
                promptIndex: promptIndex + 1,
                prompt,
                model,
                maxRunSeconds,
                gridForScreenshots,
                allowClearTool
              });
            }
          }
        }
      }
    }
  }

  return queue;
}

async function waitForRunLogAndAutosave(runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = state.lastRunLog;
    if (log && log.runId === runId && log.endedAt) {
      const pending = Boolean(log.storage?.pending);
      if (!pending) {
        return cloneJson(log);
      }
    }
    await sleep(220);
  }

  throw new Error(`Timed out waiting for run ${runId} autosave.`);
}

function summarizeEvalRun(item, runLog) {
  const events = Array.isArray(runLog?.events) ? runLog.events : [];
  const actions = Array.isArray(runLog?.actions) ? runLog.actions : [];
  const settings = runLog?.settings && typeof runLog.settings === 'object'
    ? runLog.settings
    : {};
  const evalMeta = settings.eval && typeof settings.eval === 'object'
    ? settings.eval
    : {};

  const toolCallCounts = {};
  const blockedReasons = [];
  for (const event of events) {
    if (event?.kind === 'tool_call') {
      const name = String(event.payload?.name || '');
      if (!name) continue;
      toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;
    }
    if (event?.kind === 'tool_result' && event.payload?.result?.blocked) {
      blockedReasons.push(String(event.payload.result.reason || 'blocked'));
    }
  }

  const startedMs = Date.parse(String(runLog?.startedAt || ''));
  const endedMs = Date.parse(String(runLog?.endedAt || ''));
  const durationSec = Number.isFinite(startedMs) && Number.isFinite(endedMs)
    ? Math.max(0, (endedMs - startedMs) / 1000)
    : null;

  return {
    evalTag: String(evalMeta.tag || ''),
    matrixId: String(evalMeta.matrixId || ''),
    row: Number.isFinite(Number(evalMeta.row)) ? Number(evalMeta.row) : null,
    comboIndex: Number.isFinite(Number(evalMeta.comboIndex)) ? Number(evalMeta.comboIndex) : item.comboIndex,
    repeat: Number.isFinite(Number(evalMeta.repeat)) ? Number(evalMeta.repeat) : item.repeat,
    modelBatchIndex: Number.isFinite(Number(evalMeta.modelBatchIndex)) ? Number(evalMeta.modelBatchIndex) : item.modelBatchIndex,
    modelBatchCount: Number.isFinite(Number(evalMeta.modelBatchCount)) ? Number(evalMeta.modelBatchCount) : item.modelBatchCount,
    runId: String(runLog?.runId || ''),
    model: String(runLog?.model || item.model),
    prompt: String(runLog?.prompt || item.prompt),
    maxRunSeconds: clamp(
      Math.round(Number(runLog?.maxRunSeconds ?? item.maxRunSeconds) || item.maxRunSeconds),
      MIN_MAX_RUN_SECONDS,
      MAX_MAX_RUN_SECONDS
    ),
    gridForScreenshots: typeof settings.gridForScreenshots === 'boolean'
      ? settings.gridForScreenshots
      : item.gridForScreenshots,
    allowClearTool: typeof settings.allowClearTool === 'boolean'
      ? settings.allowClearTool
      : item.allowClearTool,
    startedAt: String(runLog?.startedAt || ''),
    endedAt: String(runLog?.endedAt || ''),
    durationSec,
    finishedByAgent: Boolean(runLog?.finishedByAgent),
    finalReason: String(runLog?.finalReason || ''),
    actionCount: actions.length,
    eventCount: events.length,
    screenshotActions: actions.filter((entry) => entry?.kind === 'take_screenshot').length,
    reflectActions: actions.filter((entry) => entry?.kind === 'reflect').length,
    undoActions: actions.filter((entry) => entry?.kind === 'undo' || entry?.kind === 'undo_to_screenshot').length,
    toolCallsTotal: Object.values(toolCallCounts).reduce((sum, count) => sum + count, 0),
    strokeLineCalls: toolCallCounts.stroke_line || 0,
    strokePolylineCalls: toolCallCounts.stroke_polyline || 0,
    fillRectangleCalls: toolCallCounts.fill_rectangle || 0,
    sprayClusterCalls: toolCallCounts.spray_cluster || 0,
    floodFillCalls: toolCallCounts.flood_fill || 0,
    takeScreenshotCalls: toolCallCounts.take_screenshot || 0,
    reflectCalls: toolCallCounts.reflect || 0,
    finishCalls: toolCallCounts.finish || 0,
    blockedCount: blockedReasons.length,
    blockedReasons: blockedReasons.join('|'),
    autosaved: Boolean(runLog?.storage?.autosaved),
    logFile: String(runLog?.storage?.logFile || ''),
    finalImageFile: String(runLog?.storage?.finalImageFile || ''),
    storageError: String(runLog?.storage?.error || '')
  };
}

function updateEvalUi() {
  const evalActive = state.evalRunner.active;
  const busy = Boolean(state.aiRun?.active);
  const disableInputs = evalActive || busy;
  const lockTabs = evalActive || busy;

  if (evalActive && state.panelMode !== 'eval') {
    state.panelMode = 'eval';
    updatePanelModeUi();
  } else if (busy && !state.insideEvalMatrix && state.panelMode !== 'run') {
    state.panelMode = 'run';
    updatePanelModeUi();
  }

  for (const tab of ui.panelModeTabs) {
    tab.disabled = lockTabs;
  }

  const evalInputs = [
    ui.evalMaxRunSeconds,
    ui.evalGridModes,
    ui.evalAllowClearModes,
    ui.evalRepeats,
    ui.evalPauseMs,
    ui.evalModelBatchPauseMs,
    ui.evalTag,
    ui.evalClearCanvasEachRun,
    ui.evalModelsCustom
  ];
  for (const input of evalInputs) {
    if (input) input.disabled = disableInputs;
  }

  // Disable eval prompts textarea
  if (ui.evalPrompts) ui.evalPrompts.disabled = disableInputs;

  // Disable model checkboxes
  if (ui.evalModelCheckboxes) {
    const checkboxes = ui.evalModelCheckboxes.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      cb.disabled = disableInputs;
    }
  }

  ui.startEvalMatrix.disabled = evalActive || busy;
  ui.stopEvalMatrix.disabled = !evalActive;
  ui.downloadEvalCsv.disabled = evalActive || state.evalRunner.results.length === 0;

  if (evalActive) {
    ui.startAiButton.disabled = true;
    ui.downloadLog.disabled = true;
  }
}

function setEvalStatus(message) {
  if (!ui.evalStatus) return;
  ui.evalStatus.textContent = `Eval: ${String(message || '').replace(/^Eval:\s*/i, '')}`;
}

function parseLineList(rawValue) {
  return String(rawValue || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCsvStringList(rawValue) {
  const entries = String(rawValue || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return uniquePrimitiveList(entries);
}

function parseCsvNumberList(rawValue, mapper, label) {
  const tokens = String(rawValue || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const values = [];
  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid ${label} value "${token}".`);
    }
    values.push(mapper(parsed));
  }
  return uniquePrimitiveList(values);
}

function parseCsvBooleanList(rawValue, label) {
  const tokens = String(rawValue || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const values = [];
  for (const token of tokens) {
    const parsed = parseBooleanToken(token);
    if (parsed === null) {
      throw new Error(`Invalid ${label} value "${token}" (use true/false).`);
    }
    values.push(parsed);
  }

  return uniquePrimitiveList(values);
}

function parseBooleanToken(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', 'f', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function uniquePrimitiveList(values) {
  return Array.from(new Set(values));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncateTextForStatus(text, maxLen) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(1, maxLen - 3))}...`;
}

function downloadEvalCsv() {
  if (state.evalRunner.results.length === 0) {
    setEvalStatus('Eval: no results available yet.');
    return;
  }

  const headers = [
    'evalTag',
    'matrixId',
    'row',
    'comboIndex',
    'repeat',
    'modelBatchIndex',
    'modelBatchCount',
    'runId',
    'model',
    'maxRunSeconds',
    'gridForScreenshots',
    'allowClearTool',
    'finishedByAgent',
    'finalReason',
    'durationSec',
    'actionCount',
    'eventCount',
    'screenshotActions',
    'reflectActions',
    'undoActions',
    'toolCallsTotal',
    'strokeLineCalls',
    'strokePolylineCalls',
    'fillRectangleCalls',
    'sprayClusterCalls',
    'floodFillCalls',
    'takeScreenshotCalls',
    'reflectCalls',
    'finishCalls',
    'blockedCount',
    'blockedReasons',
    'autosaved',
    'storageError',
    'logFile',
    'finalImageFile',
    'prompt'
  ];

  const lines = [headers.join(',')];
  for (const result of state.evalRunner.results) {
    const row = headers.map((header) => toCsvCell(result[header]));
    lines.push(row.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const tagPart = sanitizeFilenameSegment(state.evalRunner.config?.tag || 'eval-matrix', 'eval-matrix');
  const stampPart = formatTimestampForFilename(new Date());

  const link = document.createElement('a');
  link.href = url;
  link.download = `${tagPart}_${stampPart}.csv`;
  link.click();

  URL.revokeObjectURL(url);
}

function toCsvCell(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function sanitizeEvalMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object') return null;

  const tag = String(rawMeta.tag || '').trim().slice(0, 80);
  const matrixId = String(rawMeta.matrixId || '').trim().slice(0, 96);
  const row = Number(rawMeta.row);
  const totalRows = Number(rawMeta.totalRows);
  const comboIndex = Number(rawMeta.comboIndex);
  const repeat = Number(rawMeta.repeat);
  const comboKey = String(rawMeta.comboKey || '').trim().slice(0, 280);
  const promptIndex = Number(rawMeta.promptIndex);
  const modelBatchIndex = Number(rawMeta.modelBatchIndex);
  const modelBatchCount = Number(rawMeta.modelBatchCount);

  const out = {};
  if (tag) out.tag = tag;
  if (matrixId) out.matrixId = matrixId;
  if (Number.isFinite(row)) out.row = Math.max(1, Math.round(row));
  if (Number.isFinite(totalRows)) out.totalRows = Math.max(1, Math.round(totalRows));
  if (Number.isFinite(comboIndex)) out.comboIndex = Math.max(1, Math.round(comboIndex));
  if (Number.isFinite(repeat)) out.repeat = Math.max(1, Math.round(repeat));
  if (comboKey) out.comboKey = comboKey;
  if (Number.isFinite(promptIndex)) out.promptIndex = Math.max(1, Math.round(promptIndex));
  if (Number.isFinite(modelBatchIndex)) out.modelBatchIndex = Math.max(1, Math.round(modelBatchIndex));
  if (Number.isFinite(modelBatchCount)) out.modelBatchCount = Math.max(1, Math.round(modelBatchCount));

  return Object.keys(out).length > 0 ? out : null;
}

function setControlMode(mode) {
  state.mode = mode;

  // Disable/enable eval inputs during runs
  ui.aiPrompt.disabled = mode !== 'human';
  if (ui.modelSelect) ui.modelSelect.disabled = mode !== 'human';
  if (ui.modelCustom) ui.modelCustom.disabled = mode !== 'human';
  ui.maxRunSeconds.disabled = mode !== 'human';
  ui.allowClearTool.disabled = mode !== 'human';
  ui.gridForScreenshots.disabled = mode !== 'human';

  updateEvalUi();
}

function setAiStatus(message) {
  ui.aiStatus.textContent = `Status: ${message}`;
}

function updateRunTimer(value) {
  ui.runTimer.textContent = `Timer: ${value}`;
}

function normalizeColor(value) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return raw.toUpperCase();
  }
  return '#000000';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function msToClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseJsonSafe(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function deterministicSeedFromAction(action) {
  const key = `${action.tool}|${action.color}|${action.lineWidth}|${action.startX}|${action.startY}|${action.x}|${action.y}`;
  return quickHashToInt(key);
}

function quickHashToInt(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function quickHash(input) {
  return quickHashToInt(input).toString(16).padStart(8, '0');
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function createFallbackCallId(name, args) {
  return `${name || 'unknown'}:${quickHash(String(args || ''))}`;
}

function buildRunArtifactBaseName(runLog) {
  const modelPart = sanitizeFilenameSegment(runLog?.model || DEFAULT_MODEL, 'model');
  const timestamp = formatTimestampForFilename(runLog?.endedAt || runLog?.startedAt || new Date());
  return `${modelPart}_${timestamp}`;
}

function sanitizeFilenameSegment(value, fallback) {
  const clean = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return clean || fallback;
}

function formatTimestampForFilename(dateLike) {
  const date = new Date(dateLike);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safe.getFullYear();
  const month = String(safe.getMonth() + 1).padStart(2, '0');
  const day = String(safe.getDate()).padStart(2, '0');
  const hour = String(safe.getHours()).padStart(2, '0');
  const minute = String(safe.getMinutes()).padStart(2, '0');
  const second = String(safe.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function createRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}
