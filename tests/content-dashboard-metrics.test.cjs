const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
