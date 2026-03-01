const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const VALID_TOOLS = ['pencil', 'brush', 'rectangle', 'circle', 'fill', 'spray', 'eraser'];
const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_TEMPERATURE = 1.0;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
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

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const ui = {
  modeBadge: document.getElementById('modeBadge'),
  toolButtons: Array.from(document.querySelectorAll('.tool')),
  colorPicker: document.getElementById('colorPicker'),
  lineWidth: document.getElementById('lineWidth'),
  clearButton: document.getElementById('clear'),
  saveButton: document.getElementById('save'),
  aiPrompt: document.getElementById('aiPrompt'),
  modelInput: document.getElementById('modelInput'),
  temperatureInput: document.getElementById('temperatureInput'),
  temperatureValue: document.getElementById('temperatureValue'),
  maxRunSeconds: document.getElementById('maxRunSeconds'),
  allowClearTool: document.getElementById('allowClearTool'),
  gridForScreenshots: document.getElementById('gridForScreenshots'),
  startAiButton: document.getElementById('startAi'),
  stopAiButton: document.getElementById('stopAi'),
  runTimer: document.getElementById('runTimer'),
  aiStatus: document.getElementById('aiStatus'),
  assistantText: document.getElementById('assistantText'),
  downloadLog: document.getElementById('downloadLog'),
  replayRun: document.getElementById('replayRun'),
  autosaveStatus: document.getElementById('autosaveStatus')
};

const state = {
  mode: 'human',
  drawing: {
    isDrawing: false,
    currentTool: 'pencil',
    color: '#000000',
    lineWidth: 5,
    startX: 0,
    startY: 0
  },
  aiRun: null,
  replay: {
    active: false,
    timers: []
  },
  lastRunLog: null
};

canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
ctx.strokeStyle = state.drawing.color;
ctx.lineWidth = state.drawing.lineWidth;
ctx.lineCap = 'round';

bindUiEvents();
updateModeUi();
updateRunTimer('--');
updateTemperatureLabel(DEFAULT_TEMPERATURE);
setAiStatus('idle');
setAutosaveStatus('Autosave: waiting for next run.');

function bindUiEvents() {
  ui.toolButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (state.mode !== 'human') return;
      setTool(button.id);
    });
  });

  ui.colorPicker.addEventListener('input', (event) => {
    if (state.mode !== 'human') return;
    setColor(event.target.value);
  });

  ui.lineWidth.addEventListener('input', (event) => {
    if (state.mode !== 'human') return;
    setLineWidth(Number(event.target.value));
  });

  ui.temperatureInput.addEventListener('input', (event) => {
    const temperature = clamp(
      Number(event.target.value),
      MIN_TEMPERATURE,
      MAX_TEMPERATURE
    );
    updateTemperatureLabel(temperature);
  });

  ui.clearButton.addEventListener('click', () => {
    if (state.mode !== 'human') return;
    clearCanvas({ source: 'human' });
  });

  ui.saveButton.addEventListener('click', saveCanvasPng);

  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseleave', stopDrawing);

  canvas.addEventListener('touchstart', (event) => {
    event.preventDefault();
    startDrawing(event.touches[0]);
  }, { passive: false });

  canvas.addEventListener('touchmove', (event) => {
    event.preventDefault();
    draw(event.touches[0]);
  }, { passive: false });

  canvas.addEventListener('touchend', (event) => {
    event.preventDefault();
    stopDrawing();
  }, { passive: false });

  ui.startAiButton.addEventListener('click', startAiRun);
  ui.stopAiButton.addEventListener('click', () => {
    if (state.aiRun?.active) {
      stopAiRun('Stopped by user.', { manual: true });
      return;
    }

    if (state.replay.active) {
      stopReplay('Replay stopped by user.');
    }
  });

  ui.downloadLog.addEventListener('click', downloadLastRunLog);
  ui.replayRun.addEventListener('click', replayLastRun);
}

function getPositionFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp(Math.round(event.clientX - rect.left), 0, CANVAS_WIDTH),
    y: clamp(Math.round(event.clientY - rect.top), 0, CANVAS_HEIGHT)
  };
}

function startDrawing(event) {
  if (state.mode !== 'human' || state.replay.active) return;
  const { x, y } = getPositionFromEvent(event);
  state.drawing.isDrawing = true;
  state.drawing.startX = x;
  state.drawing.startY = y;

  if (state.drawing.currentTool === 'fill') {
    executeDrawAction({
      tool: 'fill',
      color: state.drawing.color,
      lineWidth: state.drawing.lineWidth,
      startX: x,
      startY: y,
      x,
      y
    }, { source: 'human' });
    state.drawing.isDrawing = false;
    return;
  }

  if (state.drawing.currentTool === 'pencil' || state.drawing.currentTool === 'brush' || state.drawing.currentTool === 'eraser') {
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
}

function draw(event) {
  if (!state.drawing.isDrawing || state.mode !== 'human' || state.replay.active) return;

  const { x, y } = getPositionFromEvent(event);
  const action = {
    tool: state.drawing.currentTool,
    color: state.drawing.color,
    lineWidth: state.drawing.lineWidth,
    startX: state.drawing.startX,
    startY: state.drawing.startY,
    x,
    y
  };

  if (state.drawing.currentTool === 'fill') return;
  executeDrawAction(action, { source: 'human' });

  if (state.drawing.currentTool !== 'spray') {
    state.drawing.startX = x;
    state.drawing.startY = y;
  }
}

function stopDrawing() {
  state.drawing.isDrawing = false;
}

function setTool(tool) {
  if (!VALID_TOOLS.includes(tool)) return;
  state.drawing.currentTool = tool;
  ui.toolButtons.forEach((button) => button.classList.toggle('active', button.id === tool));
}

function setColor(color) {
  const normalized = normalizeColor(color);
  state.drawing.color = normalized;
  ui.colorPicker.value = normalized;
  ctx.strokeStyle = normalized;
}

function setLineWidth(width) {
  const normalized = clamp(Math.round(Number(width) || state.drawing.lineWidth), 1, 50);
  state.drawing.lineWidth = normalized;
  ui.lineWidth.value = String(normalized);
  ctx.lineWidth = normalized;
}

function saveCanvasPng() {
  const link = document.createElement('a');
  link.download = `ai-painter-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
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

  if (source === 'replay' && !skipLog) {
    appendRunEvent('replay_effect', { kind: 'draw_action', action });
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
  if (state.aiRun?.active || state.replay.active) return;

  const prompt = ui.aiPrompt.value.trim();
  if (!prompt) {
    setAiStatus('enter a prompt before starting.');
    return;
  }

  const model = (ui.modelInput.value || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const temperature = normalizeTemperature(ui.temperatureInput.value);
  ui.temperatureInput.value = temperature.toFixed(1);
  updateTemperatureLabel(temperature);
  const maxRunSeconds = clamp(
    Math.round(Number(ui.maxRunSeconds.value) || DEFAULT_MAX_RUN_SECONDS),
    MIN_MAX_RUN_SECONDS,
    MAX_MAX_RUN_SECONDS
  );
  ui.maxRunSeconds.value = String(maxRunSeconds);

  const runId = createRunId();
  const startedAt = Date.now();

  state.aiRun = {
    id: runId,
    active: true,
    stopping: false,
    prompt,
    model,
    temperature,
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
    lastVisualChangeAtMs: -1,
    lastScreenshotAtMs: -1,
    transcript: '',
    log: {
      version: 1,
      runId,
      prompt,
      model,
      temperature,
      startedAt: new Date(startedAt).toISOString(),
      maxRunSeconds,
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
  ui.replayRun.disabled = true;
  ui.assistantText.textContent = '';
  setAutosaveStatus(`Autosave: pending for run ${runId}.`);

  appendRunEvent('run_started', {
    prompt,
    model,
    temperature,
    maxRunSeconds
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
        run.screenshotArtifacts.push({
          atMs: run.lastScreenshotAtMs,
          includeGrid: Boolean(result.output?.includeGrid),
          width: Number(result.output?.width) || null,
          height: Number(result.output?.height) || null,
          imageDataUrl: result.imageDataUrl
        });
      }
      inputItems.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: result.imageNote || 'Requested canvas screenshot attached.'
          },
          {
            type: 'input_image',
            image_url: result.imageDataUrl
          }
        ]
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
    temperature: run.temperature,
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

async function executeAgentTool(name, args) {
  switch (name) {
    case 'set_tool': {
      const tool = VALID_TOOLS.includes(args.tool) ? args.tool : null;
      if (!tool) return { output: { ok: false, error: 'Invalid tool.' } };
      setTool(tool);
      return { output: { ok: true } };
    }

    case 'set_color': {
      const color = normalizeColor(args.color);
      setColor(color);
      return { output: { ok: true } };
    }

    case 'set_line_width': {
      const width = clamp(Math.round(Number(args.lineWidth) || 1), 1, 50);
      setLineWidth(width);
      return { output: { ok: true } };
    }

    case 'draw_action': {
      pushUndoSnapshot(state.aiRun);
      executeDrawAction({
        tool: args.tool || state.drawing.currentTool,
        color: args.color || state.drawing.color,
        lineWidth: args.lineWidth || state.drawing.lineWidth,
        startX: args.startX,
        startY: args.startY,
        x: args.x,
        y: args.y,
        seed: args.seed
      }, { source: 'ai' });
      return { output: { ok: true } };
    }

    case 'fill_rectangle': {
      pushUndoSnapshot(state.aiRun);
      fillRectangleAction({
        color: args.color || state.drawing.color,
        x1: args.x1,
        y1: args.y1,
        x2: args.x2,
        y2: args.y2
      }, { source: 'ai' });
      return { output: { ok: true } };
    }

    case 'clear_canvas': {
      if (!ui.allowClearTool.checked) {
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
      const includeGrid = typeof args.includeGrid === 'boolean'
        ? args.includeGrid
        : ui.gridForScreenshots.checked;
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
          summary: String(args.summary || '')
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
    if (!state.replay.active) {
      setControlMode('human');
    }
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
  state.aiRun = null;

  updateRunTimer('--');
  setAiStatus(reason);

  ui.startAiButton.disabled = false;
  ui.stopAiButton.disabled = true;
  ui.stopAiButton.textContent = 'Stop';

  const hasActions = Array.isArray(state.lastRunLog.actions) && state.lastRunLog.actions.length > 0;
  ui.downloadLog.disabled = !hasActions;
  ui.replayRun.disabled = !hasActions;

  if (!state.replay.active) {
    setControlMode('human');
  }

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
    'CANVAS COORDINATES:',
    `  Canvas is ${CANVAS_WIDTH}x${CANVAS_HEIGHT} pixels. Origin (0,0) is top-left.`,
    `  X increases rightward (0–${CANVAS_WIDTH}). Y increases downward (0–${CANVAS_HEIGHT}).`,
    `  Center: (${CANVAS_WIDTH / 2}, ${CANVAS_HEIGHT / 2}). Top-third: y < ${Math.round(CANVAS_HEIGHT / 3)}. Bottom-third: y > ${Math.round(CANVAS_HEIGHT * 2 / 3)}.`,
    '',
    'PAINTING PROCESS:',
    '  1. Start with background — use fill_rectangle to block in large color areas (sky, ground, water).',
    '  2. Add mid-ground shapes and forms with brush or spray.',
    '  3. Layer foreground elements and details last.',
    '  4. Take a screenshot periodically to check your work. Fix issues with undo or paint over.',
    '  5. After your final changes, take_screenshot, review, then call finish.',
    '',
    'TOOL TECHNIQUES:',
    '  fill_rectangle — ideal for blocking in backgrounds, sky bands, ground planes, and large flat areas.',
    '  brush/pencil — draw lines and strokes. startX,startY is the stroke start; x,y is the stroke end.',
    '  spray — soft gradients and texture. Creates a dot cluster around (x,y). Great for clouds, fog, atmosphere.',
    '  circle — outline circle centered at (startX,startY) with radius = distance to (x,y).',
    '  rectangle — outline rect from (startX,startY) to (x,y).',
    '  fill — flood fill from (startX,startY). Fills connected same-color region.',
    '  eraser — white stroke from (startX,startY) to (x,y).',
    '  undo — revert the last drawing operation if something looks wrong.',
    '  undo_to_screenshot — roll back everything to how the canvas looked at your last screenshot.',
    '',
    'CREATIVE PHILOSOPHY:',
    '  Be bold — large confident shapes read better than tiny precise ones.',
    '  Trust your instincts. Imperfection is expressive.',
    '  Layer colors: paint over earlier layers to build depth and richness.',
    '  Use color temperature — warm foregrounds, cool backgrounds for depth.',
    '',
    'TECHNICAL REQUIREMENTS:',
    '  Use tool calls only — no text responses.',
    '  Prefer draw_action with explicit tool/color/lineWidth over separate set_* calls.',
    '  Batch multiple draw actions per response when possible.',
    '  Take a screenshot every 15–25 drawing actions to verify composition.',
    '  clear_canvas is destructive — erases everything. It may be blocked.',
    '  When complete, call finish with a concise summary of what you painted.'
  ].join('\n');
}

function getRealtimeTools() {
  return [
    {
      type: 'function',
      name: 'set_tool',
      description: 'Set the current tool.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: {
            type: 'string',
            enum: VALID_TOOLS
          }
        },
        required: ['tool']
      }
    },
    {
      type: 'function',
      name: 'set_color',
      description: 'Set active color.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          }
        },
        required: ['color']
      }
    },
    {
      type: 'function',
      name: 'set_line_width',
      description: 'Set line width.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lineWidth: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          }
        },
        required: ['lineWidth']
      }
    },
    {
      type: 'function',
      name: 'draw_action',
      description: 'Draw one stroke or shape. See instructions for tool-specific coordinate meanings.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: {
            type: 'string',
            enum: VALID_TOOLS
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
          startX: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_WIDTH
          },
          startY: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_HEIGHT
          },
          x: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_WIDTH
          },
          y: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_HEIGHT
          },
          seed: {
            type: 'integer',
            minimum: 0,
            maximum: 4294967295
          }
        },
        required: ['tool', 'color', 'lineWidth', 'startX', 'startY', 'x', 'y']
      }
    },
    {
      type: 'function',
      name: 'fill_rectangle',
      description: 'Fill a rectangle with solid color. Corners at (x1,y1) and (x2,y2).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          color: {
            type: 'string',
            pattern: '^#[0-9A-Fa-f]{6}$'
          },
          x1: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_WIDTH
          },
          y1: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_HEIGHT
          },
          x2: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_WIDTH
          },
          y2: {
            type: 'integer',
            minimum: 0,
            maximum: CANVAS_HEIGHT
          }
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

let replayUndoStack = [];
let replayLastScreenshotImageData = null;

function replayLastRun() {
  if (state.aiRun?.active || state.replay.active) return;
  if (!state.lastRunLog || !Array.isArray(state.lastRunLog.actions) || state.lastRunLog.actions.length === 0) {
    setAiStatus('No run actions available for replay.');
    return;
  }

  state.replay.active = true;
  setControlMode('ai');
  ui.startAiButton.disabled = true;
  ui.stopAiButton.disabled = false;
  ui.stopAiButton.textContent = 'Stop Replay';

  setAiStatus(`Replaying run ${state.lastRunLog.runId}...`);
  ui.assistantText.textContent = 'Replaying deterministic tool actions from the last run.';

  clearCanvas({ source: 'replay', skipLog: true });

  const actions = [...state.lastRunLog.actions].sort((a, b) => a.atMs - b.atMs);
  let lastAtMs = 0;

  for (const actionEntry of actions) {
    lastAtMs = Math.max(lastAtMs, actionEntry.atMs);
    const timer = setTimeout(() => {
      applyReplayAction(actionEntry);
    }, actionEntry.atMs);
    state.replay.timers.push(timer);
  }

  const completeTimer = setTimeout(() => {
    stopReplay('Replay complete.');
  }, lastAtMs + 350);
  state.replay.timers.push(completeTimer);
}

function applyReplayAction(actionEntry) {
  if (!state.replay.active) return;

  switch (actionEntry.kind) {
    case 'draw_action':
      replayUndoStack.push(ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
      if (replayUndoStack.length > UNDO_MAX_SNAPSHOTS) replayUndoStack.shift();
      executeDrawAction(actionEntry.payload, { source: 'replay', skipLog: true });
      break;
    case 'fill_rectangle':
      replayUndoStack.push(ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
      if (replayUndoStack.length > UNDO_MAX_SNAPSHOTS) replayUndoStack.shift();
      fillRectangleAction(actionEntry.payload, { source: 'replay', skipLog: true });
      break;
    case 'clear_canvas':
      replayUndoStack.push(ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
      if (replayUndoStack.length > UNDO_MAX_SNAPSHOTS) replayUndoStack.shift();
      clearCanvas({ source: 'replay', skipLog: true });
      break;
    case 'undo': {
      if (replayUndoStack.length > 0) {
        const snapshot = replayUndoStack.pop();
        ctx.putImageData(snapshot, 0, 0);
      }
      break;
    }
    case 'undo_to_screenshot': {
      if (replayLastScreenshotImageData) {
        ctx.putImageData(replayLastScreenshotImageData, 0, 0);
        replayUndoStack = [];
      }
      break;
    }
    case 'take_screenshot':
      replayLastScreenshotImageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      break;
    default:
      break;
  }
}

function stopReplay(message) {
  if (!state.replay.active) return;

  for (const timer of state.replay.timers) {
    clearTimeout(timer);
  }
  state.replay.timers = [];
  state.replay.active = false;
  replayUndoStack = [];
  replayLastScreenshotImageData = null;

  ui.stopAiButton.textContent = 'Stop';
  ui.stopAiButton.disabled = true;
  ui.startAiButton.disabled = false;

  setControlMode('human');
  setAiStatus(message);
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

function setControlMode(mode) {
  state.mode = mode;
  updateModeUi();

  const lockTools = mode !== 'human' || state.replay.active;
  for (const button of ui.toolButtons) button.disabled = lockTools;
  ui.colorPicker.disabled = lockTools;
  ui.lineWidth.disabled = lockTools;
  ui.clearButton.disabled = lockTools;

  ui.aiPrompt.disabled = mode !== 'human';
  ui.modelInput.disabled = mode !== 'human';
  ui.temperatureInput.disabled = mode !== 'human';
  ui.maxRunSeconds.disabled = mode !== 'human';
  ui.allowClearTool.disabled = mode !== 'human';
  ui.gridForScreenshots.disabled = mode !== 'human';

  canvas.classList.toggle('locked', lockTools);
}

function updateModeUi() {
  if (state.mode === 'ai') {
    ui.modeBadge.textContent = 'Mode: AI Control';
    ui.modeBadge.classList.remove('mode-human');
    ui.modeBadge.classList.add('mode-ai');
    return;
  }

  ui.modeBadge.textContent = 'Mode: Human';
  ui.modeBadge.classList.remove('mode-ai');
  ui.modeBadge.classList.add('mode-human');
}

function setAiStatus(message) {
  ui.aiStatus.textContent = `Status: ${message}`;
}

function updateRunTimer(value) {
  ui.runTimer.textContent = `Timer: ${value}`;
}

function updateTemperatureLabel(value) {
  if (!ui.temperatureValue) return;
  const normalized = normalizeTemperature(value);
  ui.temperatureValue.textContent = normalized.toFixed(1);
}

function normalizeColor(value) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return raw.toUpperCase();
  }
  return '#000000';
}

function normalizeTemperature(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TEMPERATURE;
  const rounded = Math.round(parsed * 10) / 10;
  return clamp(rounded, MIN_TEMPERATURE, MAX_TEMPERATURE);
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
