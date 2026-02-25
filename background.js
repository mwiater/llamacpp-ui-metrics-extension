/**
 * @module background
 * MV3 service worker for persistence, exports, dashboard aggregation, and conversation-chain assignment.
 * Receives captured records from content scripts, stores them in IndexedDB, and serves popup/dashboard actions.
 */


/** @internal */
const DB_NAME = "llamacpp_metrics_db";
/** @internal */
const DB_VERSION = 1;

/** @internal */
const STORE_SESSIONS = "sessions";
/** @internal */
const STORE_RECORDS = "records";
/** @internal */
const CHAIN_STATE_IDLE_RESET_MS = 30 * 60 * 1000;
/** @internal */
const CHAIN_DUPLICATE_PROMPT_WINDOW_MS = 2 * 60 * 1000;

/**
 * Debug Log.
 */
async function debugLog(...args) {
  const { debug_enabled } = await chrome.storage.local.get(["debug_enabled"]);
  if (!debug_enabled) return;
  console.log("[llama.cpp metrics][bg]", ...args);
}

/**
 * Open Db.
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const s = db.createObjectStore(STORE_SESSIONS, { keyPath: "session_id" });
        s.createIndex("created_at_ms", "created_at_ms", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const r = db.createObjectStore(STORE_RECORDS, { keyPath: "key" });
        r.createIndex("session_id", "session_id", { unique: false });
        r.createIndex("captured_at_ms", "captured_at_ms", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Random Suffix.
 */
function randomSuffix(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Make Session Id.
 */
function makeSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset(); // minutes
  const sign = tz >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tz) / 60));
  const mm = pad(Math.abs(tz) % 60);
  const iso = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}${sign}${hh}${mm}`;
  return `${iso}-${randomSuffix(6)}`;
}

/**
 * Make Chain Id.
 */
function makeChainId() {
  return `c-${Date.now()}-${randomSuffix(8)}`;
}

/**
 * To Positive Int.
 */
function toPositiveInt(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  const n = Math.floor(x);
  return n > 0 ? n : null;
}

/**
 * Get Counts From Record.
 */
function getCountsFromRecord(record) {
  const counts = record?.req?.input_composition?.messages_by_role_count;
  return (counts && typeof counts === "object") ? counts : {};
}

/**
 * Get Conversation Signals.
 */
function getConversationSignals(record) {
  const counts = getCountsFromRecord(record);
  const userCount = toPositiveInt(counts.user);
  const assistantCount = toPositiveInt(counts.assistant) || 0;
  const toolCount = toPositiveInt(counts.tool) || 0;
  const messagesCount = toPositiveInt(record?.req?.messages_count);
  const promptHash = typeof record?.req?.prompt_identity?.prompt_hash === "string"
    ? record.req.prompt_identity.prompt_hash
    : null;

  return {
    userCount,
    assistantCount,
    toolCount,
    messagesCount,
    promptHash,
    uiOrigin: typeof record?.ui_origin === "string" ? record.ui_origin : null,
    endpoint: typeof record?.endpoint === "string" ? record.endpoint : null
  };
}

/**
 * Looks Like First Turn.
 */
function looksLikeFirstTurn(signals) {
  if (signals.userCount !== 1) return false;
  if (signals.assistantCount > 0 || signals.toolCount > 0) return false;
  if (signals.messagesCount === null) return true;
  return signals.messagesCount <= 4;
}

/**
 * Chain State Key For Tab.
 */
function chainStateKeyForTab(tabId) {
  return `tab_chain_state_${tabId}`;
}

/**
 * Get Tab Chain State.
 */
async function getTabChainState(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = chainStateKeyForTab(tabId);
  const result = await chrome.storage.local.get([key]);
  return result?.[key] || null;
}

/**
 * Set Tab Chain State.
 */
async function setTabChainState(tabId, state) {
  if (!Number.isInteger(tabId)) return;
  const key = chainStateKeyForTab(tabId);
  await chrome.storage.local.set({ [key]: state });
}

/**
 * Clear Tab Chain State.
 */
async function clearTabChainState(tabId) {
  if (!Number.isInteger(tabId)) return;
  const key = chainStateKeyForTab(tabId);
  await chrome.storage.local.remove([key]);
}

/**
 * Should Rotate Chain.
 */
function shouldRotateChain(state, signals, ts, sender) {
  if (!state || typeof state !== "object") return true;

  const lastSeenMs = typeof state.last_seen_ms === "number" ? state.last_seen_ms : null;
  if (lastSeenMs !== null && ts - lastSeenMs > CHAIN_STATE_IDLE_RESET_MS) {
    return true;
  }

  const senderOrigin = (() => {
    try {
      return sender?.tab?.url ? new URL(sender.tab.url).origin : null;
    } catch {
      return null;
    }
  })();

  const prevOrigin = typeof state.ui_origin === "string" ? state.ui_origin : null;
  const currOrigin = signals.uiOrigin || senderOrigin;
  if (prevOrigin && currOrigin && prevOrigin !== currOrigin) {
    return true;
  }

  const prevUserCount = toPositiveInt(state.last_user_count);
  if (
    signals.userCount !== null &&
    prevUserCount !== null &&
    signals.userCount < prevUserCount
  ) {
    return true;
  }

  if (looksLikeFirstTurn(signals)) {
    const samePrompt = Boolean(
      signals.promptHash &&
      typeof state.last_prompt_hash === "string" &&
      signals.promptHash === state.last_prompt_hash
    );
    const nearDuplicate = samePrompt && lastSeenMs !== null && (ts - lastSeenMs) <= CHAIN_DUPLICATE_PROMPT_WINDOW_MS;
    if (!nearDuplicate) return true;
  }

  return false;
}

/**
 * Assign Chain Metadata.
 */
async function assignChainMetadata(record, sender) {
  const ts = (typeof record?.captured_at_ms === "number" && Number.isFinite(record.captured_at_ms))
    ? record.captured_at_ms
    : Date.now();
  const signals = getConversationSignals(record);
  const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;

  let chainId = null;
  let turnNumber = 1;
  let state = tabId !== null ? await getTabChainState(tabId) : null;

  if (!shouldRotateChain(state, signals, ts, sender)) {
    chainId = typeof state?.chain_id === "string" ? state.chain_id : null;
    turnNumber = Math.max(1, (toPositiveInt(state?.turn_number) || 0) + 1);
  }

  if (!chainId) {
    chainId = makeChainId();
    turnNumber = 1;
  }

  record.chain_id = chainId;
  record.turn_number = turnNumber;

  if (tabId !== null) {
    await setTabChainState(tabId, {
      chain_id: chainId,
      turn_number: turnNumber,
      last_seen_ms: ts,
      last_user_count: signals.userCount,
      last_messages_count: signals.messagesCount,
      last_prompt_hash: signals.promptHash,
      ui_origin: signals.uiOrigin || null,
      endpoint: signals.endpoint || null
    });
  }

  return { chain_id: chainId, turn_number: turnNumber };
}

/**
 * Get Active Session Id.
 */
async function getActiveSessionId() {
  const { active_session_id } = await chrome.storage.local.get(["active_session_id"]);
  if (active_session_id) return active_session_id;

  const sid = makeSessionId();
  await setActiveSession(sid);
  return sid;
}

/**
 * Set Active Session.
 */
async function setActiveSession(sessionId) {
  await chrome.storage.local.set({ active_session_id: sessionId });

  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS], "readwrite");
  const store = tx.objectStore(STORE_SESSIONS);

  const existing = await new Promise((resolve) => {
    const r = store.get(sessionId);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  });

  if (!existing) {
    store.put({
      session_id: sessionId,
      created_at_ms: Date.now(),
      name: null
    });
  }

  await new Promise((resolve) => (tx.oncomplete = resolve));
  db.close();

  await debugLog("Active session set", sessionId);
}

/**
 * Add Record.
 */
async function addRecord(record, sender = null) {
  const sid = await getActiveSessionId();
  record.session_id = sid;

  const traceId = record?.trace_id || "no-trace";
  const completionId = record?.resp?.id || "noid";
  const ts = record.captured_at_ms || Date.now();
  record.captured_at_ms = ts;
  let chainMeta = { chain_id: null, turn_number: null };
  try {
    chainMeta = await assignChainMetadata(record, sender);
  } catch (e) {
    await debugLog("Chain metadata assignment failed; continuing without chain fields", {
      trace_id: traceId,
      error: String(e?.message || e)
    });
  }

  // Use trace_id in the key to avoid collisions and aid debugging
  const key = `${sid}::${ts}::${traceId}::${completionId}`;

  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS], "readwrite");
  tx.objectStore(STORE_RECORDS).put({ key, session_id: sid, captured_at_ms: ts, record });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IDB transaction aborted"));
  });
  db.close();

  await debugLog("Record added", {
    key,
    session_id: sid,
    trace_id: traceId,
    completion_id: completionId,
    chain_id: chainMeta.chain_id || null,
    turn_number: chainMeta.turn_number ?? null
  });

  return { session_id: sid, key, ...chainMeta };
}

/**
 * Count Records For Session.
 */
async function countRecordsForSession(sessionId) {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS], "readonly");
  const idx = tx.objectStore(STORE_RECORDS).index("session_id");

  const count = await new Promise((resolve) => {
    const req = idx.count(IDBKeyRange.only(sessionId));
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(0);
  });

  db.close();
  return count;
}

/**
 * Utf8 Bytes.
 */
function utf8Bytes(s) {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return String(s || "").length;
  }
}

/**
 * Estimate Session Size Bytes.
 */
async function estimateSessionSizeBytes(sessionId) {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS], "readonly");
  const idx = tx.objectStore(STORE_RECORDS).index("session_id");

  const total = await new Promise((resolve) => {
    let bytes = 0;
    const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(bytes);
      bytes += utf8Bytes(JSON.stringify(cursor.value || {}));
      cursor.continue();
    };
    cursorReq.onerror = () => resolve(bytes);
  });

  db.close();
  return total;
}

/**
 * To Finite Number.
 */
function toFiniteNumber(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return x;
}

/**
 * Safe Pct.
 */
function safePct(numerator, denominator) {
  if (typeof denominator !== "number" || denominator <= 0) return 0;
  const raw = (numerator / denominator) * 100;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Round2.
 */
function round2(x) {
  const n = toFiniteNumber(x);
  if (n === null) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Average.
 */
function average(sum, count) {
  if (!count) return null;
  return sum / count;
}

/**
 * Get Records For Session.
 */
async function getRecordsForSession(activeSessionId) {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS], "readonly");
  const store = tx.objectStore(STORE_RECORDS);

  const records = await new Promise((resolve) => {
    const out = [];

    const pushCursorValue = (cursorReq) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return resolve(out);
        out.push(cursor.value?.record || null);
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(out);
    };

    const idx = store.index("session_id");
    pushCursorValue(idx.openCursor(IDBKeyRange.only(activeSessionId)));
  });

  db.close();
  return records.filter(Boolean);
}

/**
 * Build Dashboard Stats.
 */
function buildDashboardStats(records) {
  const cleanRecords = records.filter((r) => r && r.resp && r.req);
  const totalCompletions = cleanRecords.length;

  const summaryAcc = {
    predictedTpsSum: 0,
    predictedTpsCount: 0,
    ttftMsSum: 0,
    ttftMsCount: 0,
    cacheNSum: 0,
    cacheNCount: 0,
    docCount: 0,
    imageCount: 0,
    lastCompletionAtMs: null
  };

  const perModel = new Map();

  for (const r of cleanRecords) {
    const model = r?.req?.model || r?.resp?.model || "unknown";
    const timings = r?.resp?.timings || {};
    const derived = r?.resp?.derived || {};
    const capturedAt = toFiniteNumber(r?.captured_at_ms);

    if (capturedAt !== null) {
      if (summaryAcc.lastCompletionAtMs === null || capturedAt > summaryAcc.lastCompletionAtMs) {
        summaryAcc.lastCompletionAtMs = capturedAt;
      }
    }

    const predictedTps = toFiniteNumber(timings.predicted_tps);
    if (predictedTps !== null) {
      summaryAcc.predictedTpsSum += predictedTps;
      summaryAcc.predictedTpsCount += 1;
    }

    const ttftMs = toFiniteNumber(timings.prompt_ms);
    if (ttftMs !== null) {
      summaryAcc.ttftMsSum += ttftMs;
      summaryAcc.ttftMsCount += 1;
    }

    const cacheN = toFiniteNumber(timings.cache_n);
    if (cacheN !== null) {
      summaryAcc.cacheNSum += cacheN;
      summaryAcc.cacheNCount += 1;
    }

    if (r?.req?.has_document === true) summaryAcc.docCount += 1;
    if (r?.req?.has_images === true) summaryAcc.imageCount += 1;

    if (!perModel.has(model)) {
      perModel.set(model, {
        model,
        completions: 0,
        promptNsum: 0,
        promptNcount: 0,
        predictedNsum: 0,
        predictedNcount: 0,
        promptMsSum: 0,
        promptMsCount: 0,
        predictedMsSum: 0,
        predictedMsCount: 0,
        promptTpsSum: 0,
        promptTpsCount: 0,
        predictedTpsSum: 0,
        predictedTpsCount: 0,
        reasoningMsSum: 0,
        reasoningMsCount: 0,
        contentMsSum: 0,
        contentMsCount: 0,
        cacheNSum: 0,
        cacheNCount: 0,
        docCount: 0,
        imageCount: 0,
        lastSeenAtMs: null
      });
    }

    const m = perModel.get(model);
    m.completions += 1;

    const promptN = toFiniteNumber(timings.prompt_n);
    if (promptN !== null) {
      m.promptNsum += promptN;
      m.promptNcount += 1;
    }

    const predictedN = toFiniteNumber(timings.predicted_n);
    if (predictedN !== null) {
      m.predictedNsum += predictedN;
      m.predictedNcount += 1;
    }

    if (ttftMs !== null) {
      m.promptMsSum += ttftMs;
      m.promptMsCount += 1;
    }

    const predictedMs = toFiniteNumber(timings.predicted_ms);
    if (predictedMs !== null) {
      m.predictedMsSum += predictedMs;
      m.predictedMsCount += 1;
    }

    const promptTps = toFiniteNumber(timings.prompt_tps);
    if (promptTps !== null) {
      m.promptTpsSum += promptTps;
      m.promptTpsCount += 1;
    }

    if (predictedTps !== null) {
      m.predictedTpsSum += predictedTps;
      m.predictedTpsCount += 1;
    }

    const reasoningMs = toFiniteNumber(derived.reasoning_ms);
    if (reasoningMs !== null) {
      m.reasoningMsSum += reasoningMs;
      m.reasoningMsCount += 1;
    }

    const contentMs = toFiniteNumber(derived.content_ms);
    if (contentMs !== null) {
      m.contentMsSum += contentMs;
      m.contentMsCount += 1;
    }

    if (cacheN !== null) {
      m.cacheNSum += cacheN;
      m.cacheNCount += 1;
    }

    if (r?.req?.has_document === true) m.docCount += 1;
    if (r?.req?.has_images === true) m.imageCount += 1;

    if (capturedAt !== null) {
      if (m.lastSeenAtMs === null || capturedAt > m.lastSeenAtMs) m.lastSeenAtMs = capturedAt;
    }
  }

  const models = Array.from(perModel.values())
    .map((m) => ({
      model: m.model,
      completions: m.completions,
      avg_prompt_n: round2(average(m.promptNsum, m.promptNcount)),
      avg_predicted_n: round2(average(m.predictedNsum, m.predictedNcount)),
      avg_ttft_ms: round2(average(m.promptMsSum, m.promptMsCount)),
      avg_predicted_ms: round2(average(m.predictedMsSum, m.predictedMsCount)),
      avg_prompt_tps: round2(average(m.promptTpsSum, m.promptTpsCount)),
      avg_predicted_tps: round2(average(m.predictedTpsSum, m.predictedTpsCount)),
      avg_reasoning_ms: round2(average(m.reasoningMsSum, m.reasoningMsCount)),
      avg_content_ms: round2(average(m.contentMsSum, m.contentMsCount)),
      avg_cache_n: round2(average(m.cacheNSum, m.cacheNCount)),
      doc_request_pct: round2(safePct(m.docCount, m.completions)),
      image_request_pct: round2(safePct(m.imageCount, m.completions)),
      last_seen_at_ms: m.lastSeenAtMs
    }))
    .sort((a, b) => b.completions - a.completions || (b.avg_predicted_tps || 0) - (a.avg_predicted_tps || 0));

  return {
    summary: {
      total_completions: totalCompletions,
      distinct_models: models.length,
      avg_predicted_tps: round2(average(summaryAcc.predictedTpsSum, summaryAcc.predictedTpsCount)),
      avg_ttft_ms: round2(average(summaryAcc.ttftMsSum, summaryAcc.ttftMsCount)),
      avg_cache_n: round2(average(summaryAcc.cacheNSum, summaryAcc.cacheNCount)),
      last_completion_at_ms: summaryAcc.lastCompletionAtMs,
      document_attached_requests_pct: round2(safePct(summaryAcc.docCount, totalCompletions)),
      image_attached_requests_pct: round2(safePct(summaryAcc.imageCount, totalCompletions))
    },
    models
  };
}

/**
 * Build Dashboard Records.
 */
function buildDashboardRecords(records) {
  const out = [];
  for (const r of records) {
    if (!r || !r.req || !r.resp) continue;
    out.push({
      captured_at_ms: toFiniteNumber(r?.captured_at_ms),
      chain_id: typeof r?.chain_id === "string" ? r.chain_id : null,
      turn_number: toFiniteNumber(r?.turn_number),
      model: r?.req?.model || r?.resp?.model || "unknown",
      input_mode: r?.req?.scenario_labels?.input_mode || "unknown",
      has_images: r?.req?.has_images === true,
      has_files: r?.req?.has_files === true,
      finish_reason: r?.resp?.finish_reason || null,
      prompt_n: toFiniteNumber(r?.resp?.timings?.prompt_n),
      predicted_n: toFiniteNumber(r?.resp?.timings?.predicted_n),
      prompt_tps: toFiniteNumber(r?.resp?.timings?.prompt_tps),
      predicted_tps: toFiniteNumber(r?.resp?.timings?.predicted_tps),
      cache_n: toFiniteNumber(r?.resp?.timings?.cache_n),
      ttft_ms: toFiniteNumber(r?.resp?.client_timing?.duration_request_to_first_stream_chunk_ms) ?? toFiniteNumber(r?.resp?.timings?.prompt_ms),
      request_to_headers_ms: toFiniteNumber(r?.resp?.client_timing?.duration_request_to_headers_ms),
      headers_to_first_stream_chunk_ms: toFiniteNumber(r?.resp?.client_timing?.duration_headers_to_first_stream_chunk_ms),
      first_stream_chunk_to_stop_ms: toFiniteNumber(r?.resp?.client_timing?.duration_first_stream_chunk_to_stop_ms),
      request_to_stop_ms: toFiniteNumber(r?.resp?.client_timing?.duration_request_to_stop_ms),
      reasoning_ms: toFiniteNumber(r?.resp?.derived?.reasoning_ms),
      content_ms: toFiniteNumber(r?.resp?.derived?.content_ms),
      reasoning_n: toFiniteNumber(r?.resp?.derived?.reasoning_n),
      content_n: toFiniteNumber(r?.resp?.derived?.content_n),
      text_bytes_total: toFiniteNumber(r?.req?.input_composition?.text_bytes_total),
      file_bytes_total: toFiniteNumber(r?.req?.input_composition?.file_bytes_total),
      output_tokens_estimate: toFiniteNumber(r?.resp?.guardrails?.output_length_estimate?.output_tokens_estimate),
      output_chars_estimate: toFiniteNumber(r?.resp?.guardrails?.output_length_estimate?.output_chars_estimate),
      prompt_hash: r?.req?.prompt_identity?.prompt_hash || null
    });
  }

  out.sort((a, b) => (a.captured_at_ms || 0) - (b.captured_at_ms || 0));
  return out;
}

/**
 * Init Scenario Bucket.
 */
function initScenarioBucket(label) {
  return {
    label,
    count: 0,
    predictedTpsSum: 0,
    predictedTpsCount: 0,
    ttftMsSum: 0,
    ttftMsCount: 0,
    predictedMsSum: 0,
    predictedMsCount: 0,
    requestToStopMsSum: 0,
    requestToStopMsCount: 0,
    reasoningMsSum: 0,
    reasoningMsCount: 0,
    contentMsSum: 0,
    contentMsCount: 0,
    outputTokensSum: 0,
    outputTokensCount: 0,
    outputCharsSum: 0,
    outputCharsCount: 0,
    fileBytesSum: 0,
    fileBytesCount: 0,
    userTextBytesSum: 0,
    userTextBytesCount: 0
  };
}

/**
 * Add Scenario Record.
 */
function addScenarioRecord(acc, r) {
  acc.count += 1;
  const timings = r?.resp?.timings || {};
  const derived = r?.resp?.derived || {};
  const ct = r?.resp?.client_timing || {};
  const guard = r?.resp?.guardrails?.output_length_estimate || {};
  const payload = r?.req?.payload_signals || {};

  const predTps = toFiniteNumber(timings.predicted_tps);
  if (predTps !== null) {
    acc.predictedTpsSum += predTps;
    acc.predictedTpsCount += 1;
  }

  const ttftMs = toFiniteNumber(timings.prompt_ms);
  if (ttftMs !== null) {
    acc.ttftMsSum += ttftMs;
    acc.ttftMsCount += 1;
  }

  const predMs = toFiniteNumber(timings.predicted_ms);
  if (predMs !== null) {
    acc.predictedMsSum += predMs;
    acc.predictedMsCount += 1;
  }

  const reqStop = toFiniteNumber(ct.duration_request_to_stop_ms);
  if (reqStop !== null) {
    acc.requestToStopMsSum += reqStop;
    acc.requestToStopMsCount += 1;
  }

  const reasonMs = toFiniteNumber(derived.reasoning_ms);
  if (reasonMs !== null) {
    acc.reasoningMsSum += reasonMs;
    acc.reasoningMsCount += 1;
  }

  const contentMs = toFiniteNumber(derived.content_ms);
  if (contentMs !== null) {
    acc.contentMsSum += contentMs;
    acc.contentMsCount += 1;
  }

  const outTok = toFiniteNumber(guard.output_tokens_estimate);
  if (outTok !== null) {
    acc.outputTokensSum += outTok;
    acc.outputTokensCount += 1;
  }

  const outChars = toFiniteNumber(guard.output_chars_estimate);
  if (outChars !== null) {
    acc.outputCharsSum += outChars;
    acc.outputCharsCount += 1;
  }

  const fileBytes = toFiniteNumber(payload.file_bytes_total);
  if (fileBytes !== null) {
    acc.fileBytesSum += fileBytes;
    acc.fileBytesCount += 1;
  }

  const userBytes = toFiniteNumber(payload.current_user_text_bytes);
  if (userBytes !== null) {
    acc.userTextBytesSum += userBytes;
    acc.userTextBytesCount += 1;
  }
}

/**
 * Finalize Scenario Buckets.
 */
function finalizeScenarioBuckets(map, sortByCount = true) {
  const rows = Array.from(map.values()).map((x) => ({
    label: x.label,
    count: x.count,
    avg_predicted_tps: round2(average(x.predictedTpsSum, x.predictedTpsCount)),
    avg_ttft_ms: round2(average(x.ttftMsSum, x.ttftMsCount)),
    avg_predicted_ms: round2(average(x.predictedMsSum, x.predictedMsCount)),
    avg_request_to_stop_ms: round2(average(x.requestToStopMsSum, x.requestToStopMsCount)),
    avg_reasoning_ms: round2(average(x.reasoningMsSum, x.reasoningMsCount)),
    avg_content_ms: round2(average(x.contentMsSum, x.contentMsCount)),
    avg_output_tokens: round2(average(x.outputTokensSum, x.outputTokensCount)),
    avg_output_chars: round2(average(x.outputCharsSum, x.outputCharsCount)),
    avg_file_bytes: round2(average(x.fileBytesSum, x.fileBytesCount)),
    avg_user_text_bytes: round2(average(x.userTextBytesSum, x.userTextBytesCount))
  }));

  return rows.sort((a, b) => {
    if (sortByCount) return (b.count - a.count) || ((b.avg_predicted_tps || 0) - (a.avg_predicted_tps || 0));
    return (a.label || "").localeCompare(b.label || "");
  });
}

/**
 * Group Scenario.
 */
function groupScenario(records, keyFn, sortByCount = true) {
  const m = new Map();
  for (const r of records) {
    const key = keyFn(r) || "unknown";
    if (!m.has(key)) m.set(key, initScenarioBucket(key));
    addScenarioRecord(m.get(key), r);
  }
  return finalizeScenarioBuckets(m, sortByCount);
}

/**
 * Build Scenario Comparisons.
 */
function buildScenarioComparisons(records, selectedModel) {
  const clean = records.filter((r) => r && r.req && r.resp);
  const modelCounts = new Map();
  for (const r of clean) {
    const model = r?.req?.model || r?.resp?.model || "unknown";
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
  }

  const modelOptions = Array.from(modelCounts.entries())
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  const effectiveModel = selectedModel && modelCounts.has(selectedModel)
    ? selectedModel
    : (modelOptions[0]?.model || null);

  const modelRecords = effectiveModel
    ? clean.filter((r) => (r?.req?.model || r?.resp?.model || "unknown") === effectiveModel)
    : [];

  const inputMode = groupScenario(modelRecords, (r) => r?.req?.scenario_labels?.input_mode || "unknown");
  const fileSize = groupScenario(modelRecords, (r) => r?.req?.scenario_labels?.file_size_bucket || "unknown", false);
  const fileKind = groupScenario(modelRecords, (r) => r?.req?.scenario_labels?.file_kind_set || "none");
  const imageSize = groupScenario(modelRecords, (r) => r?.req?.scenario_labels?.image_size_bucket || "unknown", false);
  const imageCount = groupScenario(modelRecords, (r) => {
    const n = toFiniteNumber(r?.req?.input_composition?.image_count);
    if (n === null) return "unknown";
    if (n <= 0) return "0";
    if (n === 1) return "1";
    if (n === 2) return "2";
    if (n <= 4) return "3-4";
    return "5+";
  }, false);
  const userTextSize = groupScenario(modelRecords, (r) => r?.req?.scenario_labels?.current_user_text_size_bucket || "unknown", false);
  const runtimeBucket = groupScenario(modelRecords, (r) => r?.req?.scenario_labels?.runtime_bucket || "default_or_unknown");
  const stopReason = groupScenario(modelRecords, (r) => r?.resp?.guardrails?.stop_reason_category || "unknown");

  const outputNorm = groupScenario(modelRecords, (r) => {
    const n = toFiniteNumber(r?.resp?.guardrails?.output_length_estimate?.output_tokens_estimate);
    if (n === null) return "unknown";
    if (n <= 128) return "0-128";
    if (n <= 512) return "129-512";
    if (n <= 1024) return "513-1024";
    return "1025+";
  }, false).map((x) => {
    const msPer1k = (typeof x.avg_predicted_ms === "number" && typeof x.avg_output_tokens === "number" && x.avg_output_tokens > 0)
      ? (x.avg_predicted_ms / x.avg_output_tokens) * 1000
      : null;
    return { ...x, avg_ms_per_1k_output_tokens: round2(msPer1k) };
  });

  const fileVsText = modelRecords
    .map((r) => ({
      captured_at_ms: r?.captured_at_ms || null,
      input_mode: r?.req?.scenario_labels?.input_mode || "unknown",
      file_kind_set: r?.req?.scenario_labels?.file_kind_set || "none",
      file_bytes_total: toFiniteNumber(r?.req?.payload_signals?.file_bytes_total),
      current_user_text_bytes: toFiniteNumber(r?.req?.payload_signals?.current_user_text_bytes),
      predicted_tps: toFiniteNumber(r?.resp?.timings?.predicted_tps),
      predicted_ms: toFiniteNumber(r?.resp?.timings?.predicted_ms),
      request_to_stop_ms: toFiniteNumber(r?.resp?.client_timing?.duration_request_to_stop_ms)
    }))
    .filter((x) => x.file_bytes_total !== null || x.current_user_text_bytes !== null)
    .sort((a, b) => (b.file_bytes_total || 0) - (a.file_bytes_total || 0))
    .slice(0, 50);

  const promptHashMap = new Map();
  for (const r of modelRecords) {
    const hash = r?.req?.prompt_identity?.prompt_hash || null;
    if (!hash) continue;
    const mode = r?.req?.scenario_labels?.input_mode || "unknown";
    if (!promptHashMap.has(hash)) {
      promptHashMap.set(hash, {
        hash,
        count: 0,
        inputModes: new Set(),
        predTpsSum: 0,
        predTpsCount: 0
      });
    }
    const h = promptHashMap.get(hash);
    h.count += 1;
    h.inputModes.add(mode);
    const tps = toFiniteNumber(r?.resp?.timings?.predicted_tps);
    if (tps !== null) {
      h.predTpsSum += tps;
      h.predTpsCount += 1;
    }
  }
  const promptHashControls = Array.from(promptHashMap.values())
    .filter((x) => x.inputModes.size > 1)
    .map((x) => ({
      prompt_hash_prefix: x.hash.slice(0, 12),
      requests: x.count,
      scenario_count: x.inputModes.size,
      scenarios: Array.from(x.inputModes).sort().join(", "),
      avg_predicted_tps: round2(average(x.predTpsSum, x.predTpsCount))
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 30);

  return {
    selected_model: effectiveModel,
    model_options: modelOptions,
    selected_model_record_count: modelRecords.length,
    breakdowns: {
      input_mode: inputMode,
      file_size_bucket: fileSize,
      file_kind_set: fileKind,
      image_size_bucket: imageSize,
      image_count_bucket: imageCount,
      current_user_text_size_bucket: userTextSize,
      runtime_bucket: runtimeBucket,
      stop_reason_category: stopReason,
      output_length_bucket: outputNorm
    },
    comparisons: {
      file_vs_text: fileVsText,
      prompt_hash_controls: promptHashControls
    }
  };
}

/**
 * Export Session Jsonl.
 */
async function exportSessionJsonl(sessionId) {
  await debugLog("Export requested", sessionId);

  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS], "readonly");
  const idx = tx.objectStore(STORE_RECORDS).index("session_id");

  const records = await new Promise((resolve) => {
    const out = [];
    const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
    cursorReq.onerror = () => resolve(out);
  });

  db.close();

  records.sort((a, b) => (a.captured_at_ms || 0) - (b.captured_at_ms || 0));

  const lines = records.map((x) => JSON.stringify(x.record));
  const jsonl = lines.join("\n") + (lines.length ? "\n" : "");

  // MV3 service worker-safe download: data URL (no createObjectURL)
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonl);
  const filename = `llamacpp-metrics_${sessionId}.jsonl`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
  });

  await debugLog("Export initiated", { filename, lines: lines.length, bytes: jsonl.length });
}

/**
 * Clear All.
 */
async function clearAll() {
  await debugLog("Clearing all data");

  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });

  await chrome.storage.local.remove(["active_session_id"]);
  await debugLog("All data cleared");
}

/**
 * Import Jsonl Records.
 */
async function importJsonlRecords(records) {
  const input = Array.isArray(records) ? records : [];
  if (!input.length) {
    throw new Error("No records provided");
  }

  // Basic validation before overwrite.
  for (let i = 0; i < input.length; i++) {
    const r = input[i];
    if (!r || typeof r !== "object" || !r.req || !r.resp) {
      throw new Error(`Invalid record at index ${i}`);
    }
  }

  await debugLog("Import requested", { count: input.length });
  await clearAll();

  const inferredSession = input[0]?.session_id || makeSessionId();
  await setActiveSession(inferredSession);

  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS], "readwrite");
  const store = tx.objectStore(STORE_RECORDS);

  for (let i = 0; i < input.length; i++) {
    const src = input[i];
    const rec = { ...src };
    rec.session_id = inferredSession;
    const ts = Number.isFinite(rec.captured_at_ms) ? rec.captured_at_ms : Date.now();
    rec.captured_at_ms = ts;
    const traceId = rec?.trace_id || `import-${i}`;
    const completionId = rec?.resp?.id || `noid-${i}`;
    const key = `${inferredSession}::${ts}::${traceId}::${completionId}::${i}`;
    store.put({ key, session_id: inferredSession, captured_at_ms: ts, record: rec });
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Import transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("Import transaction aborted"));
  });
  db.close();

  await debugLog("Import complete", { session_id: inferredSession, count: input.length });
  return { session_id: inferredSession, imported: input.length };
}

/**
 * Capture Visible Png.
 */
async function captureVisiblePng(windowId = null) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

/**
 * Download Data Url.
 */
async function downloadDataUrl(dataUrl, filename) {
  await chrome.downloads.download({
    url: dataUrl,
    filename: filename || `llamacpp-dashboard_${Date.now()}.png`,
    saveAs: true
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabChainState(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "probe") {
        await debugLog("[probe][bg]", {
          fromTab: sender?.tab?.id ?? null,
          frameId: sender?.frameId ?? null,
          payload: msg.payload || null
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "record") {
        const traceId = msg.record?.trace_id || "no-trace";
        await debugLog(`Received record message [trace ${traceId}]`, { fromTab: sender?.tab?.id ?? null });
        const stored = await addRecord(msg.record, sender);
        await debugLog(`Record persisted [trace ${traceId}]`, stored);
        sendResponse({ ok: true, trace_id: traceId, ...stored });
        return;
      }

      if (msg.type === "get_status") {
        const sid = await getActiveSessionId();
        const count = await countRecordsForSession(sid);
        const sizeBytes = await estimateSessionSizeBytes(sid);
        sendResponse({
          ok: true,
          session_start: sid,
          record_count: count,
          session_size_bytes: sizeBytes
        });
        return;
      }

      if (msg.type === "export_active") {
        const sid = await getActiveSessionId();
        await exportSessionJsonl(sid);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "clear_all") {
        await clearAll();
        const sid = makeSessionId();
        await setActiveSession(sid);
        sendResponse({ ok: true, session_start: sid });
        return;
      }

      if (msg.type === "get_dashboard_stats") {
        const activeSid = await getActiveSessionId();
        const records = await getRecordsForSession(activeSid);
        const stats = buildDashboardStats(records);
        const scenario = buildScenarioComparisons(records, msg.selected_model || null);
        const recordsCompact = buildDashboardRecords(records);
        sendResponse({
          ok: true,
          scope: "session",
          active_session_id: activeSid,
          summary: stats.summary,
          models: stats.models,
          scenario,
          records_compact: recordsCompact
        });
        return;
      }

      if (msg.type === "import_jsonl_records") {
        const result = await importJsonlRecords(msg.records);
        sendResponse({ ok: true, ...result });
        return;
      }

      if (msg.type === "capture_visible_png") {
        const windowId = sender?.tab?.windowId ?? null;
        const data_url = await captureVisiblePng(windowId);
        sendResponse({ ok: true, data_url });
        return;
      }

      if (msg.type === "download_data_url") {
        const dataUrl = msg?.data_url || null;
        if (!dataUrl) {
          sendResponse({ ok: false, error: "missing_data_url" });
          return;
        }
        await downloadDataUrl(dataUrl, msg?.filename || null);
        sendResponse({ ok: true });
        return;
      }
    } catch (e) {
      await debugLog("Error handling message", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
