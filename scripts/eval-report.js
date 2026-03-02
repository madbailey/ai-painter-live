#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RUN_INDEX_PATH = path.join(ROOT_DIR, 'logs', 'run_index.jsonl');

const DEFAULT_GROUP_BY = [
  'model',
  'maxRunSeconds',
  'gridForScreenshots',
  'allowClearTool'
];

const VALID_GROUP_FIELDS = new Set([
  'model',
  'maxRunSeconds',
  'gridForScreenshots',
  'allowClearTool',
  'evalTag',
  'prompt',
  'finalReason'
]);

function parseArgs(argv) {
  const options = {
    tag: null,
    groupBy: [...DEFAULT_GROUP_BY],
    limit: null,
    csvPath: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag') {
      options.tag = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === '--group-by') {
      const raw = String(argv[i + 1] || '');
      i += 1;
      const fields = raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (fields.length === 0) {
        throw new Error('`--group-by` requires at least one field.');
      }
      for (const field of fields) {
        if (!VALID_GROUP_FIELDS.has(field)) {
          throw new Error(`Unsupported group-by field: ${field}`);
        }
      }
      options.groupBy = fields;
      continue;
    }

    if (arg === '--limit') {
      const parsed = Number.parseInt(String(argv[i + 1] || ''), 10);
      i += 1;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('`--limit` must be a positive integer.');
      }
      options.limit = parsed;
      continue;
    }

    if (arg === '--csv') {
      options.csvPath = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log('Usage: node scripts/eval-report.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --tag <value>               Filter to a specific evalTag');
  console.log('  --group-by <a,b,c>          Group fields (default: model,maxRunSeconds,gridForScreenshots,allowClearTool)');
  console.log('  --limit <n>                 Only use the most recent n rows from run_index.jsonl');
  console.log('  --csv <path>                Write grouped output CSV');
  console.log('  --help                      Show this help');
}

async function readRunIndexRows() {
  let raw = '';
  try {
    raw = await fs.readFile(RUN_INDEX_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function toDurationSec(startedAt, endedAt) {
  const startMs = Date.parse(String(startedAt || ''));
  const endMs = Date.parse(String(endedAt || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, (endMs - startMs) / 1000);
}

function toGroupValue(row, field) {
  const value = row[field];
  if (value === null || value === undefined || value === '') return '(null)';
  return String(value);
}

function summarizeByGroup(rows, groupBy) {
  const map = new Map();

  for (const row of rows) {
    const groupValues = {};
    for (const field of groupBy) {
      groupValues[field] = toGroupValue(row, field);
    }

    const key = groupBy.map((field) => groupValues[field]).join('|');
    if (!map.has(key)) {
      map.set(key, {
        groupValues,
        runs: 0,
        finishedByAgent: 0,
        upstreamClosed: 0,
        durationSum: 0,
        durationCount: 0,
        actionSum: 0,
        actionCount: 0,
        screenshotSum: 0,
        screenshotCount: 0
      });
    }

    const agg = map.get(key);
    agg.runs += 1;
    if (row.finishedByAgent) agg.finishedByAgent += 1;
    if (/upstream closed/i.test(String(row.finalReason || ''))) agg.upstreamClosed += 1;

    const durationSec = toDurationSec(row.startedAt, row.endedAt);
    if (durationSec !== null) {
      agg.durationSum += durationSec;
      agg.durationCount += 1;
    }

    const actionCount = Number(row.actionCount);
    if (Number.isFinite(actionCount)) {
      agg.actionSum += actionCount;
      agg.actionCount += 1;
    }

    const screenshotCount = Number(row.screenshotCount);
    if (Number.isFinite(screenshotCount)) {
      agg.screenshotSum += screenshotCount;
      agg.screenshotCount += 1;
    }
  }

  return Array.from(map.values())
    .map((agg) => ({
      ...agg.groupValues,
      runs: agg.runs,
      finishRate: agg.runs > 0 ? agg.finishedByAgent / agg.runs : 0,
      upstreamCloseRate: agg.runs > 0 ? agg.upstreamClosed / agg.runs : 0,
      avgDurationSec: agg.durationCount > 0 ? agg.durationSum / agg.durationCount : null,
      avgActions: agg.actionCount > 0 ? agg.actionSum / agg.actionCount : null,
      avgScreenshots: agg.screenshotCount > 0 ? agg.screenshotSum / agg.screenshotCount : null
    }))
    .sort((a, b) => {
      if (b.runs !== a.runs) return b.runs - a.runs;
      if (b.finishRate !== a.finishRate) return b.finishRate - a.finishRate;
      return String(a.model || '').localeCompare(String(b.model || ''));
    });
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNum(value, decimals = 1) {
  if (value === null || value === undefined) return 'n/a';
  return Number(value).toFixed(decimals);
}

function buildTableLines(rows, groupBy) {
  const headers = [
    ...groupBy,
    'runs',
    'finishRate',
    'upstreamCloseRate',
    'avgDurationSec',
    'avgActions',
    'avgScreenshots'
  ];

  const body = rows.map((row) => [
    ...groupBy.map((field) => String(row[field])),
    String(row.runs),
    formatPct(row.finishRate),
    formatPct(row.upstreamCloseRate),
    formatNum(row.avgDurationSec, 1),
    formatNum(row.avgActions, 1),
    formatNum(row.avgScreenshots, 2)
  ]);

  const widths = headers.map((header, index) => {
    const maxBody = body.reduce((max, line) => Math.max(max, (line[index] || '').length), 0);
    return Math.max(header.length, maxBody);
  });

  const lines = [];
  lines.push(headers.map((header, i) => header.padEnd(widths[i])).join('  '));
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const line of body) {
    lines.push(line.map((value, i) => value.padEnd(widths[i])).join('  '));
  }
  return lines;
}

function toCsvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function writeCsv(rows, groupBy, csvPath) {
  const headers = [
    ...groupBy,
    'runs',
    'finishRate',
    'upstreamCloseRate',
    'avgDurationSec',
    'avgActions',
    'avgScreenshots'
  ];
  const lines = [headers.join(',')];

  for (const row of rows) {
    const values = [
      ...groupBy.map((field) => row[field]),
      row.runs,
      row.finishRate,
      row.upstreamCloseRate,
      row.avgDurationSec,
      row.avgActions,
      row.avgScreenshots
    ];
    lines.push(values.map(toCsvCell).join(','));
  }

  const absolutePath = path.isAbsolute(csvPath)
    ? csvPath
    : path.join(ROOT_DIR, csvPath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${lines.join('\n')}\n`, 'utf8');
  return absolutePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let rows = await readRunIndexRows();
  if (options.limit) {
    rows = rows.slice(-options.limit);
  }
  if (options.tag) {
    rows = rows.filter((row) => String(row.evalTag || '') === options.tag);
  }

  if (rows.length === 0) {
    console.log('No run index rows matched the filter.');
    return;
  }

  const grouped = summarizeByGroup(rows, options.groupBy);
  if (grouped.length === 0) {
    console.log('No grouped rows produced from the current filter.');
    return;
  }

  const lines = buildTableLines(grouped, options.groupBy);
  console.log(`Rows analyzed: ${rows.length}`);
  console.log(`Groups: ${grouped.length}`);
  console.log(lines.join('\n'));

  if (options.csvPath) {
    const outputPath = await writeCsv(grouped, options.groupBy, options.csvPath);
    console.log(`\nWrote CSV: ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
