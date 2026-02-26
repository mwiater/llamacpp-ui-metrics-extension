const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFunctions } = require('./function-loader.cjs');

const repo = 'C:\\Users\\matt\\projects\\llamacpp-ui-metrics-extension';

function makeRecord(overrides = {}) {
  const base = {
    captured_at_ms: 1000,
    ui_origin: 'https://ui.example.com',
    endpoint: '/v1/chat/completions',
    req: {
      model: 'model-a',
      messages_count: 2,
      has_document: false,
      has_images: false,
      has_files: false,
      payload_signals: {
        current_user_text_bytes: 120,
        file_bytes_total: 0,
      },
      prompt_identity: {
        prompt_hash: 'hash-a',
      },
      input_composition: {
        messages_by_role_count: { user: 1, assistant: 0, tool: 0 },
        image_count: 0,
        text_bytes_total: 120,
        file_bytes_total: 0,
      },
      scenario_labels: {
        input_mode: 'text_only',
        file_size_bucket: '0',
        file_kind_set: 'none',
        image_size_bucket: '0',
        current_user_text_size_bucket: '65-256',
        runtime_bucket: 'default_or_unknown',
      },
    },
    resp: {
      model: 'model-a',
      finish_reason: 'stop',
      timings: {
        prompt_n: 50,
        predicted_n: 100,
        prompt_ms: 200,
        predicted_ms: 1000,
        prompt_tps: 250,
        predicted_tps: 100,
        cache_n: 20,
      },
      derived: {
        reasoning_ms: 300,
        content_ms: 700,
        reasoning_n: 30,
        content_n: 70,
      },
      client_timing: {
        duration_request_to_first_stream_chunk_ms: 220,
        duration_request_to_headers_ms: 40,
        duration_headers_to_first_stream_chunk_ms: 180,
        duration_first_stream_chunk_to_stop_ms: 980,
        duration_request_to_stop_ms: 1200,
      },
      guardrails: {
        stop_reason_category: 'completed',
        output_length_estimate: {
          output_tokens_estimate: 100,
          output_chars_estimate: 400,
        },
      },
    },
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

test('background chain heuristics: getConversationSignals extracts values and shouldRotateChain rotates on key transitions', () => {
  const bg = loadFunctions(path.join(repo, 'background.js'), [
    'toPositiveInt',
    'getCountsFromRecord',
    'getConversationSignals',
    'looksLikeFirstTurn',
    'shouldRotateChain'
  ], {
    CHAIN_STATE_IDLE_RESET_MS: 30 * 60 * 1000,
    CHAIN_DUPLICATE_PROMPT_WINDOW_MS: 2 * 60 * 1000,
    URL,
  });

  const record = makeRecord();
  const signals = bg.getConversationSignals(record);
  assert.equal(signals.userCount, 1);
  assert.equal(signals.assistantCount, 0);
  assert.equal(signals.messagesCount, 2);
  assert.equal(signals.promptHash, 'hash-a');
  assert.equal(signals.uiOrigin, 'https://ui.example.com');

  const sender = { tab: { url: 'https://ui.example.com/chat' } };
  const ts = 1_000_000;

  assert.equal(bg.shouldRotateChain(null, signals, ts, sender), true, 'no state starts new chain');

  const stableState = {
    chain_id: 'c1',
    last_seen_ms: ts - 10_000,
    last_user_count: 1,
    last_messages_count: 2,
    last_prompt_hash: 'hash-a',
    ui_origin: 'https://ui.example.com',
  };
  assert.equal(bg.shouldRotateChain(stableState, signals, ts, sender), false, 'same turn progression should not rotate');

  const idleState = { ...stableState, last_seen_ms: ts - (31 * 60 * 1000) };
  assert.equal(bg.shouldRotateChain(idleState, signals, ts, sender), true, 'idle timeout rotates');

  const originChangeState = { ...stableState, ui_origin: 'https://other.example.com' };
  assert.equal(bg.shouldRotateChain(originChangeState, signals, ts, sender), true, 'origin change rotates');

  const lowerUserSignals = { ...signals, userCount: 1 };
  const prevHigherUserState = { ...stableState, last_user_count: 3 };
  assert.equal(bg.shouldRotateChain(prevHigherUserState, lowerUserSignals, ts, sender), true, 'decreasing user count rotates');

  const firstTurnNewPrompt = { ...signals, promptHash: 'hash-new' };
  assert.equal(bg.shouldRotateChain(stableState, firstTurnNewPrompt, ts, sender), true, 'first-turn new prompt rotates');

  const duplicateWindowState = { ...stableState, last_seen_ms: ts - 30_000, last_prompt_hash: 'hash-a' };
  assert.equal(bg.shouldRotateChain(duplicateWindowState, signals, ts, sender), false, 'near-duplicate prompt within window does not rotate');
});

test('background aggregations: buildDashboardStats and buildDashboardRecords summarize and sort synthetic records', () => {
  const bg = loadFunctions(path.join(repo, 'background.js'), [
    'toFiniteNumber',
    'safePct',
    'round2',
    'average',
    'buildDashboardStats',
    'buildDashboardRecords'
  ]);

  const r1 = makeRecord({ captured_at_ms: 1000, req: { model: 'model-a', has_document: true }, resp: { timings: { predicted_tps: 100, prompt_ms: 200, cache_n: 10 } } });
  const r2 = makeRecord({ captured_at_ms: 2000, req: { model: 'model-a', has_images: true }, resp: { timings: { predicted_tps: 120, prompt_ms: 250, cache_n: 20 } } });
  const r3 = makeRecord({ captured_at_ms: 1500, req: { model: 'model-b' }, resp: { model: 'model-b', timings: { predicted_tps: 80, prompt_ms: 300, cache_n: 5, predicted_n: 60, predicted_ms: 900, prompt_tps: 180 } } });

  const stats = bg.buildDashboardStats([null, { bad: true }, r1, r2, r3]);
  assert.equal(stats.summary.total_completions, 3);
  assert.equal(stats.summary.distinct_models, 2);
  assert.equal(stats.summary.last_completion_at_ms, 2000);
  assert.equal(stats.summary.document_attached_requests_pct, 33.33);
  assert.equal(stats.summary.image_attached_requests_pct, 33.33);
  assert.equal(stats.models[0].model, 'model-a');
  assert.equal(stats.models[0].completions, 2);
  assert.equal(stats.models[0].doc_request_pct, 50);
  assert.equal(stats.models[0].image_request_pct, 50);

  const compact = bg.buildDashboardRecords([r2, r1]);
  assert.equal(compact.length, 2);
  assert.equal(compact[0].captured_at_ms, 1000);
  assert.equal(compact[1].captured_at_ms, 2000);
  assert.equal(compact[0].model, 'model-a');
  assert.equal(compact[0].input_mode, 'text_only');
  assert.equal(compact[0].ttft_ms, 220);
  assert.equal(compact[0].prompt_ms, 200);
  assert.equal(compact[0].predicted_ms, 1000);
  assert.equal(compact[0].file_count, null);
  assert.equal(compact[0].file_kind_set, 'none');
  assert.equal(compact[0].file_size_bucket, '0');
  assert.equal(compact[0].document_detected, true);
});

test('background scenario comparisons: selects effective model and groups breakdowns', () => {
  const bg = loadFunctions(path.join(repo, 'background.js'), [
    'toFiniteNumber',
    'safePct',
    'round2',
    'average',
    'initScenarioBucket',
    'addScenarioRecord',
    'finalizeScenarioBuckets',
    'groupScenario',
    'buildScenarioComparisons'
  ]);

  const records = [
    makeRecord({
      captured_at_ms: 1000,
      req: {
        model: 'model-a',
        scenario_labels: {
          input_mode: 'text_only',
          file_size_bucket: '0',
          file_kind_set: 'none',
          image_size_bucket: '0',
          current_user_text_size_bucket: '65-256',
          runtime_bucket: 'default_or_unknown'
        },
        input_composition: { image_count: 0 },
        payload_signals: { current_user_text_bytes: 120, file_bytes_total: 0 },
        prompt_identity: { prompt_hash: 'same-hash' }
      },
      resp: {
        timings: { predicted_tps: 100, prompt_ms: 200, predicted_ms: 1000 },
        client_timing: { duration_request_to_stop_ms: 1200 },
        guardrails: { stop_reason_category: 'completed', output_length_estimate: { output_tokens_estimate: 100, output_chars_estimate: 400 } }
      }
    }),
    makeRecord({
      captured_at_ms: 1100,
      req: {
        model: 'model-a',
        has_files: true,
        payload_signals: { current_user_text_bytes: 80, file_bytes_total: 2048 },
        scenario_labels: {
          input_mode: 'text_plus_files',
          file_size_bucket: '1KB-10KB',
          file_kind_set: 'pdf',
          image_size_bucket: '0',
          current_user_text_size_bucket: '1-64',
          runtime_bucket: 'runtime_set_other'
        },
        input_composition: { image_count: 0 },
        prompt_identity: { prompt_hash: 'same-hash' }
      },
      resp: {
        timings: { predicted_tps: 90, prompt_ms: 220, predicted_ms: 1300 },
        client_timing: { duration_request_to_stop_ms: 1500 },
        guardrails: { stop_reason_category: 'completed', output_length_estimate: { output_tokens_estimate: 200, output_chars_estimate: 800 } }
      }
    }),
    makeRecord({
      captured_at_ms: 1200,
      req: {
        model: 'model-b',
        scenario_labels: {
          input_mode: 'images_only',
          file_size_bucket: '0',
          file_kind_set: 'none',
          image_size_bucket: '10KB-100KB',
          current_user_text_size_bucket: '0',
          runtime_bucket: 'default_or_unknown'
        },
        input_composition: { image_count: 2 },
        prompt_identity: { prompt_hash: 'hash-b' }
      },
      resp: {
        timings: { predicted_tps: 70, prompt_ms: 300, predicted_ms: 1400 },
        client_timing: { duration_request_to_stop_ms: 1700 },
        guardrails: { stop_reason_category: 'completed', output_length_estimate: { output_tokens_estimate: 600, output_chars_estimate: 2400 } }
      }
    })
  ];

  const scenario = bg.buildScenarioComparisons(records, null);
  assert.equal(scenario.selected_model, 'model-a');
  assert.equal(scenario.selected_model_record_count, 2);
  assert.equal(scenario.model_options.length, 2);
  assert.equal(scenario.model_options[0].model, 'model-a');

  const inputModes = scenario.breakdowns.input_mode.map((r) => r.label);
  assert.ok(inputModes.includes('text_only'));
  assert.ok(inputModes.includes('text_plus_files'));

  const stopReasons = scenario.breakdowns.stop_reason_category;
  assert.equal(stopReasons[0].label, 'completed');
  assert.equal(stopReasons[0].count, 2);

  const outputBuckets = scenario.breakdowns.output_length_bucket.map((r) => r.label);
  assert.ok(outputBuckets.includes('0-128'));
  assert.ok(outputBuckets.includes('129-512'));

  assert.ok(Array.isArray(scenario.comparisons.file_vs_text));
  assert.equal(scenario.comparisons.file_vs_text.length, 2);

  assert.equal(scenario.comparisons.prompt_hash_controls.length, 1, 'same prompt hash across different input modes should appear');
  assert.equal(scenario.comparisons.prompt_hash_controls[0].scenario_count, 2);

  const selectedB = bg.buildScenarioComparisons(records, 'model-b');
  assert.equal(selectedB.selected_model, 'model-b');
  assert.equal(selectedB.selected_model_record_count, 1);
  assert.equal(selectedB.breakdowns.image_count_bucket[0].label, '2');
});
