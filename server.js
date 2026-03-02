const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_RESPONSES_MODEL = process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.2';
const LOGS_DIR = path.join(__dirname, 'logs');
const IMAGES_DIR = path.join(LOGS_DIR, 'images');
const RUN_INDEX_PATH = path.join(LOGS_DIR, 'run_index.jsonl');
const MAX_INDEX_ROWS = 200;
const MAX_SCREENSHOTS_TO_SAVE = 80;

app.use(cors());
app.use(express.json({ limit: '35mb' }));
app.use(express.static(path.join(__dirname, '.')));

function toPosixRelative(absolutePath) {
  return path.relative(__dirname, absolutePath).replace(/\\/g, '/');
}

function sanitizeFilenameSegment(rawValue, fallback) {
  const clean = String(rawValue || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

  return clean || fallback;
}

function formatTimestampForFilename(dateLike) {
  const date = new Date(dateLike);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const y = safeDate.getFullYear();
  const m = String(safeDate.getMonth() + 1).padStart(2, '0');
  const d = String(safeDate.getDate()).padStart(2, '0');
  const hh = String(safeDate.getHours()).padStart(2, '0');
  const mm = String(safeDate.getMinutes()).padStart(2, '0');
  const ss = String(safeDate.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

async function fileExists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function allocateArtifactBaseName(model, timestamp) {
  const modelPart = sanitizeFilenameSegment(model, 'model');
  const stampPart = sanitizeFilenameSegment(timestamp, formatTimestampForFilename(new Date()));
  const baseCore = `${modelPart}_${stampPart}`;

  let suffix = 0;
  while (true) {
    const baseName = suffix > 0 ? `${baseCore}_${suffix}` : baseCore;
    const logPath = path.join(LOGS_DIR, `${baseName}.json`);
    if (!(await fileExists(logPath))) {
      return baseName;
    }
    suffix += 1;
  }
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) {
    throw new Error('Invalid image data URL.');
  }

  return {
    mimeType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64')
  };
}

function imageExtForMimeType(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'bin';
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'responses-websocket-proxy',
    defaultModel: DEFAULT_RESPONSES_MODEL,
    hasApiKey: Boolean(OPENAI_API_KEY)
  });
});

app.get('/api/runs/index', async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(String(req.query.limit || ''), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_INDEX_ROWS, requestedLimit))
      : MAX_INDEX_ROWS;

    let raw = '';
    try {
      raw = await fs.readFile(RUN_INDEX_PATH, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        res.json({ ok: true, rows: [] });
        return;
      }
      throw error;
    }

    const rows = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);

    res.json({ ok: true, rows });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || 'Failed to read run index.'
    });
  }
});

app.post('/api/runs/save', async (req, res) => {
  const { log, finalImageDataUrl, screenshots } = req.body || {};
  if (!log || typeof log !== 'object') {
    res.status(400).json({ ok: false, message: 'Missing `log` object.' });
    return;
  }

  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.mkdir(IMAGES_DIR, { recursive: true });

    const model = String(log.model || DEFAULT_RESPONSES_MODEL || 'model');
    const timestamp = formatTimestampForFilename(log.endedAt || log.startedAt || new Date());
    const baseName = await allocateArtifactBaseName(model, timestamp);
    const savedAt = new Date().toISOString();
    const warnings = [];

    let finalImageFile = null;
    if (typeof finalImageDataUrl === 'string' && finalImageDataUrl.startsWith('data:image/')) {
      try {
        const parsed = parseImageDataUrl(finalImageDataUrl);
        const ext = imageExtForMimeType(parsed.mimeType);
        const finalPath = path.join(IMAGES_DIR, `${baseName}_final.${ext}`);
        await fs.writeFile(finalPath, parsed.buffer);
        finalImageFile = toPosixRelative(finalPath);
      } catch (error) {
        warnings.push(`Final image save failed: ${error.message}`);
      }
    }

    const screenshotItems = Array.isArray(screenshots) ? screenshots : [];
    const screenshotLimit = screenshotItems.slice(0, MAX_SCREENSHOTS_TO_SAVE);
    if (screenshotItems.length > screenshotLimit.length) {
      warnings.push(`Saved ${screenshotLimit.length}/${screenshotItems.length} screenshots due to save limit.`);
    }

    const screenshotFiles = [];
    for (let i = 0; i < screenshotLimit.length; i += 1) {
      const shot = screenshotLimit[i];
      if (!shot || typeof shot.imageDataUrl !== 'string') continue;

      try {
        const parsed = parseImageDataUrl(shot.imageDataUrl);
        const ext = imageExtForMimeType(parsed.mimeType);
        const index = String(i + 1).padStart(3, '0');
        const imagePath = path.join(IMAGES_DIR, `${baseName}_shot_${index}.${ext}`);
        await fs.writeFile(imagePath, parsed.buffer);

        screenshotFiles.push({
          atMs: Number.isFinite(Number(shot.atMs)) ? Number(shot.atMs) : null,
          includeGrid: Boolean(shot.includeGrid),
          width: Number.isFinite(Number(shot.width)) ? Number(shot.width) : null,
          height: Number.isFinite(Number(shot.height)) ? Number(shot.height) : null,
          file: toPosixRelative(imagePath)
        });
      } catch (error) {
        warnings.push(`Screenshot ${i + 1} save failed: ${error.message}`);
      }
    }

    const storage = {
      autosaved: true,
      savedAt,
      baseName,
      logFile: toPosixRelative(path.join(LOGS_DIR, `${baseName}.json`)),
      finalImageFile,
      screenshotFiles,
      indexFile: toPosixRelative(RUN_INDEX_PATH),
      warnings
    };

    const logToPersist = {
      ...log,
      storage
    };

    const logPath = path.join(LOGS_DIR, `${baseName}.json`);
    await fs.writeFile(logPath, JSON.stringify(logToPersist, null, 2), 'utf8');

    const settings = log.settings && typeof log.settings === 'object'
      ? log.settings
      : {};
    const evalMeta = settings.eval && typeof settings.eval === 'object'
      ? settings.eval
      : {};

    const indexRow = {
      savedAt,
      runId: log.runId || null,
      model,
      prompt: typeof log.prompt === 'string' ? log.prompt : null,
      maxRunSeconds: Number.isFinite(Number(log.maxRunSeconds)) ? Number(log.maxRunSeconds) : null,
      allowClearTool: typeof settings.allowClearTool === 'boolean' ? settings.allowClearTool : null,
      gridForScreenshots: typeof settings.gridForScreenshots === 'boolean' ? settings.gridForScreenshots : null,
      evalTag: typeof evalMeta.tag === 'string' ? evalMeta.tag : null,
      evalMatrixId: typeof evalMeta.matrixId === 'string' ? evalMeta.matrixId : null,
      evalRow: Number.isFinite(Number(evalMeta.row)) ? Number(evalMeta.row) : null,
      evalComboIndex: Number.isFinite(Number(evalMeta.comboIndex)) ? Number(evalMeta.comboIndex) : null,
      evalRepeat: Number.isFinite(Number(evalMeta.repeat)) ? Number(evalMeta.repeat) : null,
      startedAt: log.startedAt || null,
      endedAt: log.endedAt || null,
      finalReason: log.finalReason || null,
      finishedByAgent: Boolean(log.finishedByAgent),
      eventCount: Array.isArray(log.events) ? log.events.length : 0,
      actionCount: Array.isArray(log.actions) ? log.actions.length : 0,
      screenshotCount: screenshotFiles.length,
      hasFinalImage: Boolean(finalImageFile),
      logFile: storage.logFile,
      finalImageFile
    };

    await fs.appendFile(RUN_INDEX_PATH, `${JSON.stringify(indexRow)}\n`, 'utf8');

    res.json({
      ok: true,
      storage
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message || 'Failed to save run artifacts.'
    });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);

const browserWss = new WebSocketServer({
  server,
  path: '/ws/responses'
});

browserWss.on('connection', (browserSocket) => {
  if (!OPENAI_API_KEY) {
    browserSocket.send(JSON.stringify({
      type: 'proxy.upstream_error',
      message: 'Server is missing OPENAI_API_KEY.',
      error: {
        code: 'proxy_missing_api_key'
      }
    }));
    setTimeout(() => {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.close(1011, 'missing api key');
      }
    }, 50);
    return;
  }

  const upstreamSocket = new WebSocket('wss://api.openai.com/v1/responses', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    }
  });

  let upstreamOpen = false;
  const queuedClientMessages = [];

  function flushQueuedClientMessages() {
    while (queuedClientMessages.length > 0 && upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(queuedClientMessages.shift());
    }
  }

  function closeBrowserWithProxyError(message) {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify({
        type: 'proxy.upstream_error',
        message,
        error: {
          code: 'proxy_upstream_error'
        }
      }));
      setTimeout(() => {
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.close(1011, 'upstream error');
        }
      }, 50);
    }
  }

  upstreamSocket.on('open', () => {
    upstreamOpen = true;
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify({
        type: 'proxy.connected'
      }));
    }
    flushQueuedClientMessages();
  });

  upstreamSocket.on('message', (data) => {
    if (browserSocket.readyState !== WebSocket.OPEN) return;
    browserSocket.send(data.toString());
  });

  upstreamSocket.on('error', (error) => {
    closeBrowserWithProxyError(`OpenAI upstream WebSocket error: ${error.message || 'unknown error'}`);
  });

  upstreamSocket.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : String(reasonBuffer || '');
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify({
        type: 'proxy.upstream_closed',
        code,
        reason
      }));
      setTimeout(() => {
        if (browserSocket.readyState === WebSocket.OPEN) {
          browserSocket.close(1000, 'upstream closed');
        }
      }, 50);
    }
  });

  browserSocket.on('message', (data) => {
    const text = data.toString();

    if (!upstreamOpen || upstreamSocket.readyState === WebSocket.CONNECTING) {
      queuedClientMessages.push(text);
      return;
    }

    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(text);
    }
  });

  browserSocket.on('close', () => {
    if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
      upstreamSocket.close(1000, 'browser disconnected');
    }
  });

  browserSocket.on('error', () => {
    if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
      upstreamSocket.close(1000, 'browser socket error');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Responses WS proxy path: ws://localhost:${PORT}/ws/responses`);
  console.log(`Default model: ${DEFAULT_RESPONSES_MODEL}`);
});
