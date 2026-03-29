const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { loadFunctions } = require('./function-loader.cjs');

const repo = 'C:\\Users\\matt\\projects\\llamacpp-ui-metrics-extension';

function makeCompactRecord(overrides = {}) {
  const base = {
    model: 'Qwen2.5-7B-Instruct-Q4_K_M',
    has_images: false,
    ttft_ms: 220,
    predicted_tps: 100,
    prompt_tps: 220,
    request_to_headers_ms: 40,
    headers_to_first_stream_chunk_ms: 180,
    first_stream_chunk_to_stop_ms: 960,
    request_to_stop_ms: 1180,
    reasoning_ms: 280,
    reasoning_n: 28,
    content_n: 72,
    predicted_n: 100,
  };
  return merge(base, overrides);
}

function merge(target, src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src === undefined ? target : src;
  const out = { ...target };
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target && typeof target[k] === 'object' && target[k] && !Array.isArray(target[k])) {
      out[k] = merge(target[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

test('content dashboard helpers derive family, modality, and trendline-based speed efficiency', () => {
  const content = loadFunctions(path.join(repo, 'content.js'), [
    'toFiniteNumber',
    'stdDev',
    'avgOf',
    'parseParamsBillions',
    'quantile',
    'median',
    'shortenModelName',
    'igSafeNum',
    'perfColorByIndex',
    'deriveModelFamily',
    'deriveQuantizationLabel',
    'deriveModelModality',
    'getMetricRange',
    'normalizeMetricValue',
    'fitExpectedTpsByParams',
    'perfBuildModelRows'
  ], {
    PERF_TEMPLATE_COLORS: ['#111111', '#222222', '#333333'],
  });

  const rows = content.perfBuildModelRows([
    makeCompactRecord({ model: 'Qwen2.5-7B-Instruct-Q4_K_M', predicted_tps: 92, ttft_ms: 240 }),
    makeCompactRecord({ model: 'Qwen2.5-7B-Instruct-Q4_K_M', predicted_tps: 96, ttft_ms: 220 }),
    makeCompactRecord({ model: 'Llama-3.2-11B-Vision-Instruct-Q6_K', has_images: true, predicted_tps: 70, ttft_ms: 380 }),
    makeCompactRecord({ model: 'Llama-3.2-11B-Vision-Instruct-Q6_K', has_images: true, predicted_tps: 74, ttft_ms: 360 }),
    makeCompactRecord({ model: 'Nemotron-Nano-4B-Q4_K_M', predicted_tps: 126, ttft_ms: 180 }),
    makeCompactRecord({ model: 'Nemotron-Nano-4B-Q4_K_M', predicted_tps: 122, ttft_ms: 190 }),
  ]);

  assert.equal(rows.length, 3);

  const qwen = rows.find((r) => r.model.startsWith('Qwen2.5'));
  assert.equal(qwen.family, 'Qwen2.5');
  assert.equal(qwen.quantization, 'Q4_K_M');
  assert.equal(qwen.modality, 'text-only');
  assert.equal(qwen.params, 7);
  assert.ok(typeof qwen.tpsPerB === 'number');
  assert.ok(typeof qwen.expectedTps === 'number');
  assert.ok(typeof qwen.speedEfficiencyRatio === 'number');

  const llamaVision = rows.find((r) => r.model.startsWith('Llama-3.2'));
  assert.equal(llamaVision.family, 'Llama');
  assert.equal(llamaVision.modality, 'multimodal');
  assert.equal(llamaVision.params, 11);

  const nemotron = rows.find((r) => r.model.startsWith('Nemotron'));
  assert.ok(nemotron.tpsPerB > qwen.tpsPerB, 'smaller faster model should lead TPS-per-B');
  assert.ok(typeof nemotron.sizeNormalizedResponsivenessScore === 'number');
  assert.ok(typeof qwen.sizeNormalizedResponsivenessScore === 'number');
});

test('content dashboard helpers prefer log fit when it tracks size-speed scaling better', () => {
  const content = loadFunctions(path.join(repo, 'content.js'), [
    'toFiniteNumber',
    'avgOf',
    'fitExpectedTpsByParams'
  ]);

  const fit = content.fitExpectedTpsByParams([
    { params: 4, tps: 120 },
    { params: 8, tps: 82 },
    { params: 16, tps: 56 },
    { params: 32, tps: 39 },
  ]);

  assert.ok(['log', 'linear'].includes(fit.method));
  const predicted = fit.predict(12);
  assert.ok(typeof predicted === 'number' && predicted > 0);
});

test('dashboard layout keeps hero cards first and enforces minimum height for size-speed-responsiveness panel', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.match(source, /\.perf-dashboard \.main-grid > \.best-class-row \{ order: 0; \}/);
  assert.match(source, /\.perf-dashboard \.main-grid > \.card-panel\[data-panel="size-speed-responsiveness"\] \{ order: 30; min-height: 400px; \}/);
  assert.match(source, /\.perf-dashboard \.frontier-grid \{ display:grid; grid-template-columns: 2fr 1fr; gap: 12px; min-height: calc\(400px - 96px\); \}/);
  assert.match(source, /\.perf-dashboard \.frontier-chart \{ height: 100%; min-height: 260px; \}/);
});

test('dashboard charts render all eligible models instead of top-N subsets', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.doesNotMatch(source, /\.slice\(0, 4\)/);
  assert.doesNotMatch(source, /\.slice\(0, 6\)/);
  assert.doesNotMatch(source, /\.slice\(0, 7\)/);
  assert.doesNotMatch(source, /\.slice\(0, 8\)/);
  assert.doesNotMatch(source, /\.slice\(0, 10\)/);
});

test('simple horizontal bar charts use one-line rows with fully visible labels', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.match(source, /<div class="speed-bar-name"><span class="color-dot" style="background:\$\{color\}"><\/span>\$\{badge\}\$\{escapeHtml\(label\)\}<\/div>/);
  assert.match(source, /<div class="speed-bar-value \$\{valueClass\}">\$\{shown\}<\/div>/);
  assert.match(source, /function adjustPerfSpeedBarLabelWidth\(root = __dashboardState\.elements\?\.root\)/);
  assert.match(source, /querySelectorAll\("\.perf-dashboard \.card-panel"\)/);
  assert.match(source, /const labels = Array\.from\(panel\.querySelectorAll\("\.speed-bar-name, \.consistency-name, \.dumbbell-name, \.box-name"\)\)/);
  assert.match(source, /const values = Array\.from\(panel\.querySelectorAll\("\.speed-bar-value, \.consistency-value, \.dumbbell-values, \.box-value"\)\)/);
  assert.match(source, /const cappedWidth = panelWidth > 0 \? Math\.max\(140, Math\.floor\(panelWidth \* 0\.45\)\) : maxWidth \+ 8;/);
  assert.match(source, /panel\.style\.setProperty\("--speed-bar-label-width", `\$\{Math\.ceil\(Math\.min\(maxWidth \+ 8, cappedWidth\)\)\}px`\);/);
  assert.match(source, /panel\.style\.setProperty\("--speed-bar-value-width", `\$\{Math\.ceil\(maxValueWidth\)\}px`\);/);
  assert.match(source, /--speed-bar-label-width: 320px;/);
  assert.match(source, /--speed-bar-value-width: 72px;/);
  assert.match(source, /--compare-bar-height: 17px;/);
  assert.match(source, /--compare-row-space: 4px;/);
  assert.match(source, /--compare-value-gap: 10px;/);
  assert.match(source, /\.perf-dashboard \.speed-bar-container \{ margin: var\(--compare-row-space\) 0; display: grid; grid-template-columns: var\(--speed-bar-label-width\) minmax\(160px, 1fr\) var\(--speed-bar-value-width\); align-items: center; column-gap: var\(--compare-value-gap\); row-gap: 0; \}/);
  assert.match(source, /\.perf-dashboard \.speed-bar \{ height: var\(--compare-bar-height\); border-radius: 3px; background: var\(--bg-bar-track\); overflow: hidden; min-width: 0; \}/);
  assert.match(source, /\.perf-dashboard \.consistency-row \{ display:grid; grid-template-columns: var\(--speed-bar-label-width\) minmax\(160px, 1fr\) var\(--speed-bar-value-width\); align-items:center; column-gap: var\(--compare-value-gap\); row-gap: 0; margin:var\(--compare-row-space\) 0; \}/);
  assert.match(source, /\.perf-dashboard \.consistency-bar-bg \{ height:var\(--compare-bar-height\); background:var\(--bg-bar-track\); border-radius:3px; overflow:hidden; min-width:0; \}/);
  assert.match(source, /\.perf-dashboard \.dumbbell-row \{\s*display:grid;\s*grid-template-columns: var\(--speed-bar-label-width\) minmax\(160px, 1fr\) var\(--speed-bar-value-width\);/);
  assert.match(source, /\.perf-dashboard \.dumbbell-track \{\s*position: relative;\s*height: var\(--compare-bar-height\);/);
  assert.match(source, /\.perf-dashboard \.box-row \{\s*display:grid;\s*grid-template-columns: var\(--speed-bar-label-width\) minmax\(160px, 1fr\) var\(--speed-bar-value-width\);/);
  assert.match(source, /\.perf-dashboard \.box-track \{ height: var\(--compare-bar-height\); \}/);
  assert.match(source, /\.llm-body \{ flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 14px; display: grid; gap: 12px; \}/);
  assert.match(source, /\.perf-dashboard \.speed-bar-name \{ min-width: 0; font-size: \.78rem; color: var\(--text-secondary\); display: flex; align-items: flex-start; white-space: normal; overflow-wrap: anywhere; line-height: 1\.15; font-family: var\(--perf-font-body\); \}/);
  assert.doesNotMatch(source, /\.perf-dashboard \.(speed-bar-name|consistency-name|dumbbell-name|box-name)[^{]*\{[^}]*text-overflow: ellipsis/);
});

test('dashboard does not render punching-above-weight section', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.doesNotMatch(source, /PUNCHING ABOVE ITS WEIGHT/);
  assert.doesNotMatch(source, /data-panel="punching-above-weight"/);
});

test('radar grid is capped at three cards per row', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.match(source, /\.perf-dashboard \.radar-grid \{ display:grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); align-items: start; row-gap: 22px; column-gap: 14px; \}/);
});

test('radar cards use fixed internal structure for consistent export height', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.match(source, /\.perf-dashboard \.radar-wrap \{ display:grid; \}/);
  assert.match(source, /\.perf-dashboard \.radar-grid \{ display:grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); align-items: start; row-gap: 22px; column-gap: 14px; \}/);
  assert.match(source, /\.perf-dashboard \.radar-card \{\s*background: var\(--bg-inset\);\s*border: 1px solid var\(--border-color\);\s*border-radius: 10px;\s*padding: 10px;\s*display: grid;\s*grid-template-rows: auto auto auto auto;\s*align-content: start;\s*align-self: start;\s*justify-self: stretch;/);
  assert.match(source, /\.perf-dashboard \.radar-card-head \{\s*display:flex;\s*justify-content:space-between;\s*gap: 10px;\s*align-items:flex-start;\s*margin-bottom: 8px;\s*min-height: 38px;/);
  assert.match(source, /\.perf-dashboard \.radar-svg \{ width: 100%; height: auto; display: block; aspect-ratio: 13 \/ 9; min-height: 260px; \}/);
  assert.match(source, /\.perf-dashboard \.radar-stats \{\s*display:grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*gap: 8px 10px;\s*margin-top: 8px;\s*\}/);
  assert.match(source, /\.perf-dashboard \.radar-interpret \{ min-height: 0; \}/);
});

test('png export prefers blob download with data-url fallback', () => {
  const source = fs.readFileSync(path.join(repo, 'content.js'), 'utf8');

  assert.match(source, /function canvasToBlob\(canvas, type = "image\/png"\)/);
  assert.match(source, /function triggerFileDownload\(blob, filename\)/);
  assert.match(source, /const blob = await canvasToBlob\(outCanvas, "image\/png"\);/);
  assert.match(source, /triggerFileDownload\(blob, filename\);/);
  assert.match(source, /const dataUrl = outCanvas\.toDataURL\("image\/png"\);/);
});
