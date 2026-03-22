/**
 * @module content
 * Content-script orchestrator that gates capture by allowlisted host, injects the page hook,
 * forwards records to the background worker, and renders the in-page dashboard UI.
 */


/** @internal */
const PROBE_PREFIX = "[llama.cpp metrics][probe][content]";
/** @internal */
const ALLOWED_DOMAINS_KEY = "allowed_domains";
/** @internal */
const DASHBOARD_THEME_KEY = "dashboard_theme";

/** @internal */
let __probeDebugEnabled = false;
/** @internal */
let __captureStarted = false;
/** @internal */
let __dashboardRefreshTimer = null;
/** @internal */
const __dashboardState = {
  mounted: false,
  overlayOpen: false,
  scope: "session",
  selectedModel: null,
  selectedInputMode: "all",
  selectedModels: new Set(),
  theme: "light",
  lastStats: null,
  elements: null
};

/**
 * Has Valid Extension Context.
 */
function hasValidExtensionContext() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * Safe Storage Get.
 */
async function safeStorageGet(keys) {
  if (!hasValidExtensionContext()) return {};
  try {
    return await chrome.storage.local.get(keys);
  } catch {
    return {};
  }
}

/**
 * Safe Send Message.
 */
function safeSendMessage(payload) {
  if (!hasValidExtensionContext()) return Promise.resolve(null);
  try {
    return chrome.runtime.sendMessage(payload).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Sleep.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load Image From Data Url.
 */
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load captured frame"));
    img.src = dataUrl;
  });
}

/**
 * Normalize Domain Pattern.
 */
function normalizeDomainPattern(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  try {
    if (s.includes("://")) {
      const u = new URL(s);
      s = u.host;
    }
  } catch {}

  s = s.split("/")[0].split("?")[0].split("#")[0];
  if (!s) return null;

  if (s.startsWith("*.")) {
    const tail = s.slice(2);
    if (!tail || tail.includes("*")) return null;
    return `*.${tail}`;
  }

  if (s.includes("*")) return null;
  return s;
}

/**
 * Host Matches Pattern.
 */
function hostMatchesPattern(pattern) {
  const p = normalizeDomainPattern(pattern);
  if (!p) return false;

  const hostname = location.hostname.toLowerCase();
  const host = location.host.toLowerCase();

  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }

  if (p.includes(":")) return host === p;
  return hostname === p;
}

/**
 * Get Allowed Domains.
 */
async function getAllowedDomains() {
  const { [ALLOWED_DOMAINS_KEY]: allowed_domains } = await safeStorageGet([ALLOWED_DOMAINS_KEY]);
  const list = Array.isArray(allowed_domains) ? allowed_domains : [];
  return list.map(normalizeDomainPattern).filter(Boolean);
}

/**
 * Is Current Host Allowed.
 */
async function isCurrentHostAllowed() {
  const list = await getAllowedDomains();
  if (!list.length) return false;
  return list.some((p) => hostMatchesPattern(p));
}

/**
 * Debug Log.
 */
async function debugLog(...args) {
  try {
    const { debug_enabled } = await safeStorageGet(["debug_enabled"]);
    if (!debug_enabled) return;
    console.log("[llama.cpp metrics][content]", ...args);
  } catch {}
}

/**
 * Probe Log.
 */
function probeLog(eventName, payload = {}) {
  if (!__probeDebugEnabled) return;

  const framePath = (() => {
    try {
      return window.top === window ? "top" : "iframe";
    } catch {
      return "unknown";
    }
  })();

  const data = {
    ts_ms: Date.now(),
    href: location.href,
    frame: framePath,
    event: eventName,
    ...payload
  };

  console.log(PROBE_PREFIX, data);
  safeSendMessage({ type: "probe", payload: data });
}

/**
 * Send Debug Flag To Page.
 */
function sendDebugFlagToPage(debugEnabled, reason = "unknown") {
  window.postMessage(
    { type: "LLAMACPP_SET_DEBUG", enabled: Boolean(debugEnabled), reason },
    "*"
  );
}

/**
 * Sync Debug To Page.
 */
async function syncDebugToPage(reason = "sync") {
  const { debug_enabled } = await safeStorageGet(["debug_enabled"]);
  sendDebugFlagToPage(Boolean(debug_enabled), reason);
  await debugLog("Debug flag synced to page", { enabled: Boolean(debug_enabled), reason });
}

/**
 * Inject Injected Script.
 */
function injectInjectedScript() {
  const src = chrome.runtime.getURL("injected.js");
  const el = document.createElement("script");
  el.src = src;
  el.type = "text/javascript";
  el.async = false;
  (document.head || document.documentElement).appendChild(el);
  el.onload = () => {
    probeLog("inject_script_loaded", { src });
    syncDebugToPage("inject.onload");
    el.remove();
  };
  el.onerror = () => {
    probeLog("inject_script_error", { src });
  };
}

/**
 * Summarize Files.
 */
function summarizeFiles(files) {
  if (!files || typeof files.length !== "number") return [];
  const out = [];
  for (const f of files) {
    if (!f) continue;
    out.push({
      name: typeof f.name === "string" ? f.name : null,
      type: typeof f.type === "string" ? f.type : null,
      size: typeof f.size === "number" ? f.size : null
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Install Content Probe Listeners.
 */
function installContentProbeListeners() {
  const common = (event, name, payload = {}) => {
    const target = event?.target;
    const targetInfo = {
      target_tag: target?.tagName || null,
      target_id: target?.id || null,
      target_class: target?.className || null
    };
    probeLog(name, { ...targetInfo, ...payload });
  };

  document.addEventListener("dragenter", (event) => {
    const items = event?.dataTransfer?.items;
    common(event, "dom_dragenter", { item_count: items?.length ?? 0 });
  }, true);

  document.addEventListener("drop", (event) => {
    const files = event?.dataTransfer?.files;
    common(event, "dom_drop", {
      file_count: files?.length ?? 0,
      files: summarizeFiles(files)
    });
  }, true);

  document.addEventListener("paste", (event) => {
    const files = event?.clipboardData?.files;
    common(event, "dom_paste", {
      file_count: files?.length ?? 0,
      files: summarizeFiles(files)
    });
  }, true);

  document.addEventListener("change", (event) => {
    const t = event?.target;
    const files = t?.files;
    common(event, "dom_change", {
      input_type: t?.type || null,
      file_count: files?.length ?? 0,
      files: summarizeFiles(files)
    });
  }, true);
}

/**
 * Is Top Frame.
 */
function isTopFrame() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/**
 * Escape Html.
 */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Format Number.
 */
function formatNumber(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

/**
 * Format Int.
 */
function formatInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString();
}

/**
 * Format Pct.
 */
function formatPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const clamped = Math.max(0, Math.min(100, value));
  return `${formatNumber(clamped, 1)}%`;
}

/**
 * To Finite Number.
 */
function toFiniteNumber(value) {
  return (typeof value === "number" && Number.isFinite(value)) ? value : null;
}

/**
 * Std Dev.
 */
function stdDev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const variance = values.reduce((s, x) => s + ((x - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Avg Of.
 */
function avgOf(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const nums = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (!nums.length) return null;
  return nums.reduce((s, x) => s + x, 0) / nums.length;
}

/**
 * Parse Params Billions.
 */
function parseParamsBillions(modelName) {
  const m = String(modelName || "").match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Unique Values.
 */
function uniqueValues(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

/**
 * Convert Ms To Sec.
 */
function convertMsToSec(ms) {
  return (typeof ms === "number" && Number.isFinite(ms)) ? (ms / 1000) : null;
}


/**
 * Shorten Model Name.
 */
function shortenModelName(name, max = 22) {
  const s = String(name || "unknown");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}...`;
}

/**
 * Quantile.
 */
function quantile(values, q) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

/**
 * Median.
 */
function median(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Sync Input Mode Selector.
 */
function syncInputModeSelector(records) {
  const el = __dashboardState.elements?.inputMode;
  if (!el) return;
  const modes = ["all", ...uniqueValues(records.map((r) => r?.input_mode || "unknown")).sort()];
  const previous = __dashboardState.selectedInputMode || "all";
  const key = modes.join("|");
  const labelForMode = (m) => {
    if (m === "all") return "Input Mode Filter (All)";
    return `Input Mode: ${m}`;
  };
  if (el.getAttribute("data-key") !== key) {
    el.innerHTML = modes.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(labelForMode(m))}</option>`).join("");
    el.setAttribute("data-key", key);
  }
  const valid = modes.includes(previous) ? previous : "all";
  __dashboardState.selectedInputMode = valid;
  el.value = valid;
}

/**
 * Update Model Filter Label.
 */
function updateModelFilterLabel() {
  const els = __dashboardState.elements;
  if (!els?.modelFilterToggle) return;
  const allCount = Array.from(els.modelToggles?.querySelectorAll('input[type="checkbox"][data-model]') || []).length;
  const selectedCount = __dashboardState.selectedModels.size;
  const suffix = (allCount > 0 && selectedCount === allCount) ? "All" : `${selectedCount}/${allCount}`;
  els.modelFilterToggle.textContent = `Model Filters (${suffix})`;
}

/**
 * Set Model Filter Open.
 */
function setModelFilterOpen(open) {
  const els = __dashboardState.elements;
  if (!els?.modelFilterPanel || !els?.modelFilterToggle) return;
  const next = Boolean(open);
  els.modelFilterPanel.hidden = !next;
  els.modelFilterToggle.setAttribute("aria-expanded", next ? "true" : "false");
}

/**
 * Sync Model Toggles.
 */
function syncModelToggles(models) {
  const wrap = __dashboardState.elements?.modelToggles;
  if (!wrap) return;
  const names = models.map((m) => m.model || "unknown");
  if (__dashboardState.selectedModels.size === 0) {
    __dashboardState.selectedModels = new Set(names);
  } else {
    const next = new Set();
    for (const n of names) {
      if (__dashboardState.selectedModels.has(n)) next.add(n);
    }
    if (!next.size) for (const n of names) next.add(n);
    __dashboardState.selectedModels = next;
  }

  const html = names.map((name) => {
    const checked = __dashboardState.selectedModels.has(name) ? "checked" : "";
    return `<label class="llm-toggle"><input type="checkbox" data-model="${escapeHtml(name)}" ${checked} /> <span>${escapeHtml(name)}</span></label>`;
  }).join("");
  wrap.innerHTML = html || `<div class="llm-empty">No models yet.</div>`;
  updateModelFilterLabel();
}

/**
 * Ig Safe Num.
 */
function igSafeNum(n, fallback = 0) {
  return (typeof n === "number" && Number.isFinite(n)) ? n : fallback;
}

/** @internal */
const PERF_TEMPLATE_COLORS = [
  "#b86828", "#387050", "#903838", "#385898", "#704888", "#388088", "#286070",
  "#287888", "#387258", "#806828", "#804068", "#883838", "#505080", "#6a4080"
];

/**
 * Perf Color By Index.
 */
function perfColorByIndex(i) {
  return PERF_TEMPLATE_COLORS[i % PERF_TEMPLATE_COLORS.length];
}

/**
 * Perf Build Model Rows.
 */
function perfBuildModelRows(records) {
  const by = new Map();
  for (const r of records || []) {
    const model = r?.model || "unknown";
    if (!by.has(model)) by.set(model, []);
    by.get(model).push(r);
  }
  const baseRows = Array.from(by.entries()).map(([model, arr], idx) => {
    const ttftVals = arr.map((r) => toFiniteNumber(r.ttft_ms)).filter((x) => x !== null);
    const tpsVals = arr.map((r) => toFiniteNumber(r.predicted_tps)).filter((x) => x !== null);
    const promptTpsVals = arr.map((r) => toFiniteNumber(r.prompt_tps)).filter((x) => x !== null);
    const totalDurationVals = arr.map((r) => toFiniteNumber(r.request_to_stop_ms)).filter((x) => x !== null);
    const requestToHeadersVals = arr.map((r) => toFiniteNumber(r.request_to_headers_ms)).filter((x) => x !== null);
    const headersToFirstVals = arr.map((r) => toFiniteNumber(r.headers_to_first_stream_chunk_ms)).filter((x) => x !== null);
    const firstToStopVals = arr.map((r) => toFiniteNumber(r.first_stream_chunk_to_stop_ms)).filter((x) => x !== null);
    const reasoningMsVals = arr.map((r) => toFiniteNumber(r.reasoning_ms)).filter((x) => x !== null);
    const reasoningNVals = arr.map((r) => toFiniteNumber(r.reasoning_n)).filter((x) => x !== null);
    const predictedNVals = arr.map((r) => toFiniteNumber(r.predicted_n)).filter((x) => x !== null);
    const reasoningShares = arr.map((r) => {
      const rn = igSafeNum(r.reasoning_n, 0);
      const cn = igSafeNum(r.content_n, 0) || igSafeNum(r.predicted_n, 0);
      const d = rn + cn;
      return d > 0 ? (rn / d) * 100 : null;
    }).filter((x) => typeof x === "number");
    const isVision = arr.some((r) => r.has_images) || /vision|vl/i.test(model);
    const avgReasoningOverhead = (() => {
      const pairs = arr.map((r) => {
        const ms = toFiniteNumber(r.reasoning_ms);
        const n = toFiniteNumber(r.reasoning_n) ?? toFiniteNumber(r.predicted_n);
        if (ms === null || n === null || n <= 0) return null;
        return ms / n;
      }).filter((x) => x !== null);
      return median(pairs);
    })();
    const params = parseParamsBillions(model);
    return {
      model,
      short: shortenModelName(model.replace(/-Q\d.*$/i, ""), 18),
      count: arr.length,
      family: deriveModelFamily(model),
      modality: deriveModelModality(model, arr, isVision),
      quantization: deriveQuantizationLabel(model),
      ttft: median(ttftVals),
      ttftAvg: avgOf(ttftVals),
      ttftMin: ttftVals.length ? Math.min(...ttftVals) : null,
      ttftMax: ttftVals.length ? Math.max(...ttftVals) : null,
      ttftQ1: quantile(ttftVals, 0.25),
      ttftQ3: quantile(ttftVals, 0.75),
      ttftStd: stdDev(ttftVals),
      tps: median(tpsVals),
      promptTps: median(promptTpsVals),
      totalDuration: median(totalDurationVals),
      requestToHeaders: median(requestToHeadersVals),
      headersToFirst: median(headersToFirstVals),
      firstToStop: median(firstToStopVals),
      reasoningMs: median(reasoningMsVals),
      reasoningN: median(reasoningNVals),
      predictedN: median(predictedNVals),
      reasoningPct: reasoningShares.length ? avgOf(reasoningShares) : 0,
      reasoningOverhead: avgReasoningOverhead,
      params,
      vision: isVision,
      color: perfColorByIndex(idx)
    };
  });
  const regression = fitExpectedTpsByParams(baseRows);
  const ttftRange = getMetricRange(baseRows, (m) => m.ttft);
  const totalDurationRange = getMetricRange(baseRows, (m) => m.totalDuration);
  const tpsPerBRange = getMetricRange(baseRows, (m) => (m.params && m.tps) ? (m.tps / m.params) : null);
  const ttftPerBRange = getMetricRange(baseRows, (m) => (m.params && m.ttft) ? (m.ttft / m.params) : null);
  const reasoningRange = getMetricRange(baseRows, (m) => m.reasoningOverhead);
  const stabilityRange = getMetricRange(baseRows, (m) => m.ttftStd);
  const promptTpsRange = getMetricRange(baseRows, (m) => m.promptTps);
  const outputTpsRange = getMetricRange(baseRows, (m) => m.tps);

  const rows = baseRows.map((m) => {
    const expectedTps = (m.params && typeof m.tps === "number") ? regression.predict(m.params) : null;
    const tpsPerB = (m.params && typeof m.tps === "number") ? (m.tps / m.params) : null;
    const ttftPerB = (m.params && typeof m.ttft === "number") ? (m.ttft / m.params) : null;
    return {
      ...m,
      regression_method: regression.method,
      expectedTps,
      speedEfficiencyRatio: (typeof expectedTps === "number" && expectedTps > 0 && typeof m.tps === "number") ? (m.tps / expectedTps) : null,
      tpsPerB,
      ttftPerB,
      promptThroughputScore: normalizeMetricValue(m.promptTps, promptTpsRange.min, promptTpsRange.max, false),
      outputThroughputScore: normalizeMetricValue(m.tps, outputTpsRange.min, outputTpsRange.max, false),
      responsivenessScore: normalizeMetricValue(m.ttft, ttftRange.min, ttftRange.max, true),
      totalSpeedScore: normalizeMetricValue(m.totalDuration, totalDurationRange.min, totalDurationRange.max, true),
      sizeEfficiencyScore: normalizeMetricValue(tpsPerB, tpsPerBRange.min, tpsPerBRange.max, false),
      sizeNormalizedResponsivenessScore: normalizeMetricValue(ttftPerB, ttftPerBRange.min, ttftPerBRange.max, true),
      reasoningEfficiencyScore: normalizeMetricValue(m.reasoningOverhead, reasoningRange.min, reasoningRange.max, true),
      stabilityScore: normalizeMetricValue(m.ttftStd, stabilityRange.min, stabilityRange.max, true)
    };
  });

  return rows.sort((a, b) => (a.model || "").localeCompare(b.model || ""));
}

/**
 * Derive Model Family.
 */
function deriveModelFamily(modelName) {
  const s = String(modelName || "").trim();
  if (!s) return "Unknown";
  const m = s.match(/^([A-Za-z][A-Za-z0-9.]*)/);
  return m ? m[1] : s.split(/[\s/_-]+/)[0] || "Unknown";
}

/**
 * Derive Quantization Label.
 */
function deriveQuantizationLabel(modelName) {
  const m = String(modelName || "").match(/\b(Q\d(?:[_A-Z0-9]+)?|IQ\d(?:[_A-Z0-9]+)?)\b/i);
  return m ? m[1] : null;
}

/**
 * Derive Model Modality.
 */
function deriveModelModality(modelName, records, isVision) {
  if (!isVision) return "text-only";
  const hasImages = Array.isArray(records) && records.some((r) => r?.has_images === true);
  const looksMulti = /vision|vl|llava|multimodal/i.test(String(modelName || ""));
  if (hasImages && looksMulti) return "multimodal";
  return "vision-capable";
}

/**
 * Get Metric Range.
 */
function getMetricRange(items, getter) {
  const vals = (items || []).map(getter).filter((x) => typeof x === "number" && Number.isFinite(x));
  if (!vals.length) return { min: null, max: null };
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/**
 * Normalize Metric Value.
 */
function normalizeMetricValue(value, min, max, inverse = false) {
  if (![value, min, max].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  if (max <= min) return 100;
  const raw = (value - min) / (max - min);
  const pct = inverse ? (1 - raw) : raw;
  return Math.max(0, Math.min(100, pct * 100));
}

/**
 * Fit Expected TPS By Params.
 */
function fitExpectedTpsByParams(models) {
  const points = (models || [])
    .map((m) => ({ x: toFiniteNumber(m?.params), y: toFiniteNumber(m?.tps) }))
    .filter((p) => p.x !== null && p.x > 0 && p.y !== null && p.y > 0);

  if (points.length < 2) {
    const fallback = avgOf(points.map((p) => p.y)) || null;
    return {
      method: "mean",
      predict(x) {
        return (typeof x === "number" && x > 0 && typeof fallback === "number") ? fallback : null;
      }
    };
  }

  const makeLinearFit = (transformX, transformY, invertY, method) => {
    const transformed = points.map((p) => ({ x: transformX(p.x), y: transformY(p.y), rawX: p.x, rawY: p.y }));
    const meanX = avgOf(transformed.map((p) => p.x));
    const meanY = avgOf(transformed.map((p) => p.y));
    const numerator = transformed.reduce((sum, p) => sum + ((p.x - meanX) * (p.y - meanY)), 0);
    const denominator = transformed.reduce((sum, p) => sum + ((p.x - meanX) ** 2), 0);
    const slope = denominator === 0 ? 0 : (numerator / denominator);
    const intercept = meanY - slope * meanX;
    const errors = transformed.map((p) => {
      const predictedRaw = invertY(intercept + slope * p.x);
      return Math.abs(predictedRaw - p.rawY) / Math.max(1, p.rawY);
    });
    return {
      method,
      error: avgOf(errors) ?? Number.POSITIVE_INFINITY,
      predict(x) {
        if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return null;
        return invertY(intercept + slope * transformX(x));
      }
    };
  };

  const linear = makeLinearFit((x) => x, (y) => y, (y) => y, "linear");
  const logLinear = makeLinearFit((x) => Math.log(x), (y) => Math.log(y), (y) => Math.exp(y), "log");
  return (logLinear.error <= linear.error) ? logLinear : linear;
}

/**
 * Perf Speed Bar Row.
 */
function perfSpeedBarRow(label, value, unit, pct, color, valueClass = "val", badge = "") {
  const safePct = Math.max(0, Math.min(100, igSafeNum(pct, 0)));
  const shown = typeof value === "number" ? `${formatNumber(value, unit === "ms" ? 0 : 1)}${unit}` : "-";
  return `
    <div class="speed-bar-container">
      <div class="speed-bar-label">
        <span><span class="color-dot" style="background:${color}"></span>${badge}${escapeHtml(label)}</span>
        <span class="${valueClass}">${shown}</span>
      </div>
      <div class="speed-bar"><div class="speed-bar-fill" style="width:${formatNumber(safePct, 1)}%;background:${color}">${shown}</div></div>
    </div>
  `;
}

/**
 * Check Whether Compact Dashboard Record Used Attached Documents.
 */
function perfIsDocumentAttachedRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.document_detected === true || record.has_files === true) return true;
  if (igSafeNum(record.file_count, 0) > 0) return true;
  const fileBytes = toFiniteNumber(record.file_bytes_total);
  if (typeof fileBytes === "number" && fileBytes > 0) return true;
  const mode = String(record.input_mode || "");
  return mode.includes("file");
}

/**
 * Perf Build Document Ingestion Rows.
 */
function perfBuildDocumentIngestionRows(records) {
  const DOC_MIN_SAMPLES = 3;
  const byModel = new Map();
  for (const r of records || []) {
    const model = r?.model || "unknown";
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push(r);
  }

  const rows = [];
  let colorIdx = 0;
  for (const [model, arr] of Array.from(byModel.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const textRows = arr.filter((r) => (r?.input_mode || "unknown") === "text_only");
    const fileRows = arr.filter((r) => perfIsDocumentAttachedRecord(r));

    const textTtftVals = textRows.map((r) => toFiniteNumber(r?.ttft_ms)).filter((x) => x !== null);
    const textMsPerTokenVals = textRows.map((r) => {
      const predMs = toFiniteNumber(r?.predicted_ms);
      const predN = toFiniteNumber(r?.predicted_n);
      if (predMs === null || predN === null || predN <= 0) return null;
      return predMs / predN;
    }).filter((x) => x !== null);
    const textTtftBaseline = median(textTtftVals);
    const textMsPerTokenBaseline = median(textMsPerTokenVals);

    const textByPromptHash = new Map();
    for (const tr of textRows) {
      const hash = tr?.prompt_hash || null;
      const ttft = toFiniteNumber(tr?.ttft_ms);
      if (!hash || ttft === null) continue;
      if (!textByPromptHash.has(hash)) textByPromptHash.set(hash, []);
      textByPromptHash.get(hash).push(ttft);
    }

    const docMsPerMbVals = [];
    const ttftDeltaVals = [];
    const fileMsPerTokenVals = [];
    const fileBytesVals = [];
    let fileTtftCount = 0;
    let baselineExactCount = 0;
    let baselineModelCount = 0;

    for (const fr of fileRows) {
      const fileBytes = toFiniteNumber(fr?.file_bytes_total);
      const promptMs = toFiniteNumber(fr?.prompt_ms);
      const ttft = toFiniteNumber(fr?.ttft_ms);
      const predMs = toFiniteNumber(fr?.predicted_ms);
      const predN = toFiniteNumber(fr?.predicted_n);
      if (fileBytes !== null && fileBytes > 0) fileBytesVals.push(fileBytes);
      if (promptMs !== null && fileBytes !== null && fileBytes > 0) {
        docMsPerMbVals.push(promptMs / (fileBytes / 1_000_000));
      }
      if (predMs !== null && predN !== null && predN > 0) {
        fileMsPerTokenVals.push(predMs / predN);
      }
      if (ttft !== null) {
        fileTtftCount += 1;
        const hash = fr?.prompt_hash || null;
        const exact = hash && textByPromptHash.has(hash) ? median(textByPromptHash.get(hash)) : null;
        const baseline = (typeof exact === "number") ? exact : textTtftBaseline;
        if (typeof baseline === "number") {
          ttftDeltaVals.push(ttft - baseline);
          if (typeof exact === "number") baselineExactCount += 1;
          else baselineModelCount += 1;
        }
      }
    }

    rows.push({
      model,
      short: shortenModelName(model.replace(/-Q\d.*$/i, ""), 18),
      color: perfColorByIndex(colorIdx++),
      file_run_count: fileRows.length,
      file_bytes_median_mb: (() => {
        const v = median(fileBytesVals);
        return typeof v === "number" ? (v / 1_000_000) : null;
      })(),
      doc_ms_per_mb: median(docMsPerMbVals),
      ingestion_pair_count: docMsPerMbVals.length,
      ttft_delta_ms: median(ttftDeltaVals),
      ttft_delta_count: ttftDeltaVals.length,
      file_ttft_count: fileTtftCount,
      text_ttft_count: textTtftVals.length,
      baseline_exact_count: baselineExactCount,
      baseline_model_count: baselineModelCount,
      ms_per_output_token_file: median(fileMsPerTokenVals),
      file_output_speed_count: fileMsPerTokenVals.length,
      ms_per_output_token_text: textMsPerTokenBaseline,
      text_output_speed_count: textMsPerTokenVals.length,
      output_efficiency_delta_pct: (() => {
        const f = median(fileMsPerTokenVals);
        const t = textMsPerTokenBaseline;
        if (typeof f !== "number" || typeof t !== "number" || t <= 0) return null;
        return ((f - t) / t) * 100;
      })(),
      file_kind_set: uniqueValues(fileRows.map((r) => r?.file_kind_set || "none")).join(", "),
      file_size_bucket_set: uniqueValues(fileRows.map((r) => r?.file_size_bucket || "unknown")).join(", "),
      text_run_count: textRows.length,
      min_required_samples: DOC_MIN_SAMPLES
    });
  }

  return rows;
}

/**
 * Perf Doc Tone Class.
 */
function perfDocToneClass(index, total) {
  const n = Math.max(1, total | 0);
  if (n <= 2) return index === 0 ? "good" : "warn";
  const p = index / Math.max(1, n - 1);
  if (p <= 0.33) return "good";
  if (p <= 0.66) return "mid";
  return "warn";
}

/**
 * Perf Render Document Ingestion Card.
 */
function perfRenderDocumentIngestionCard(records) {
  const rows = perfBuildDocumentIngestionRows(records);
  const DOC_MIN_SAMPLES = 3;
  const needRunMsg = (count, kind) => {
    const n = Math.max(0, count | 0);
    return `run ${formatInt(n)} more ${kind} prompt${n === 1 ? "" : "s"}`;
  };
  const guidanceMsg = (parts) => parts.length ? `Need more data: ${parts.join(" and ")}.` : "";
  if (!rows.length) {
    return `
      <div class="card-panel full-width">
        <h3 class="dark-header">DOCUMENT INGESTION EFFICIENCY INDEX</h3>
        <div class="sub-label">Compares file-ingestion cost, startup delay inflation, and post-ingestion output efficiency for document-attached runs.</div>
        <div class="llm-empty">No document-attached runs detected for the current filters.</div>
      </div>
    `;
  }

  const ingestionRows = [...rows].sort((a, b) => {
    const av = typeof a.doc_ms_per_mb === "number" ? a.doc_ms_per_mb : Number.POSITIVE_INFINITY;
    const bv = typeof b.doc_ms_per_mb === "number" ? b.doc_ms_per_mb : Number.POSITIVE_INFINITY;
    return av - bv || (a.short || "").localeCompare(b.short || "");
  });
  const ingestionValidRows = ingestionRows.filter((r) => typeof r.doc_ms_per_mb === "number");
  const ingestionMax = Math.max(...ingestionValidRows.map((r) => r.doc_ms_per_mb || 0), 1);
  const ttftRows = [...rows].sort((a, b) => {
    const av = typeof a.ttft_delta_ms === "number" ? a.ttft_delta_ms : Number.POSITIVE_INFINITY;
    const bv = typeof b.ttft_delta_ms === "number" ? b.ttft_delta_ms : Number.POSITIVE_INFINITY;
    return av - bv || (a.short || "").localeCompare(b.short || "");
  });
  const ttftValidRows = ttftRows.filter((r) => typeof r.ttft_delta_ms === "number");
  const ttftAbsMax = Math.max(...ttftValidRows.map((r) => Math.abs(r.ttft_delta_ms || 0)), 1);
  const outputRows = [...rows].sort((a, b) => {
    const av = typeof a.ms_per_output_token_file === "number" ? a.ms_per_output_token_file : Number.POSITIVE_INFINITY;
    const bv = typeof b.ms_per_output_token_file === "number" ? b.ms_per_output_token_file : Number.POSITIVE_INFINITY;
    return av - bv || (a.short || "").localeCompare(b.short || "");
  });
  const outputValidRows = outputRows.filter((r) => typeof r.ms_per_output_token_file === "number" || typeof r.ms_per_output_token_text === "number");
  const outputMax = Math.max(...outputValidRows.flatMap((r) => [r.ms_per_output_token_file || 0, r.ms_per_output_token_text || 0]), 1);

  const ingestionHtml = ingestionRows.length
    ? ingestionRows.map((r, i) => {
      const valid = typeof r.doc_ms_per_mb === "number" && r.ingestion_pair_count >= DOC_MIN_SAMPLES;
      const cls = valid ? perfDocToneClass(i, ingestionRows.length) : "disabled";
      const pct = valid ? ((r.doc_ms_per_mb || 0) / ingestionMax) * 100 : 0;
      const medal = valid && i < 3 ? ["🥇 ", "🥈 ", "🥉 "][i] : "";
      const needDocs = Math.max(0, DOC_MIN_SAMPLES - igSafeNum(r.ingestion_pair_count, 0));
      const guidance = valid
        ? `${formatInt(r.file_run_count)} runs - median file ${formatNumber(r.file_bytes_median_mb, 2)} MB`
        : guidanceMsg([needRunMsg(needDocs, "document-attached")]);
      return `
        <div class="doc-metric-row ${valid ? "" : "is-disabled"}">
          <div class="doc-row-head">
            <span class="doc-name"><span class="color-dot" style="background:${r.color}"></span>${medal}${escapeHtml(r.short)}</span>
            <span class="doc-value">${valid ? `${formatNumber(r.doc_ms_per_mb, 0)} ms/MB` : "-"}</span>
          </div>
          <div class="doc-track ${valid ? "" : "disabled"}"><div class="doc-fill ${cls}" style="width:${formatNumber(pct, 1)}%"></div></div>
          <div class="doc-meta">${guidance}</div>
        </div>
      `;
    }).join("")
    : `<div class="llm-empty">No valid prompt/file size timing pairs.</div>`;

  const ttftHtml = ttftRows.length
    ? ttftRows.map((r) => {
      const valid = typeof r.ttft_delta_ms === "number" && r.ttft_delta_count >= DOC_MIN_SAMPLES;
      const delta = r.ttft_delta_ms || 0;
      const magPct = valid ? (Math.abs(delta) / ttftAbsMax) * 50 : 0;
      const left = delta < 0 ? (50 - magPct) : 50;
      const cls = valid ? (delta < 0 ? "good" : (delta > 0 ? "warn" : "mid")) : "disabled";
      const baselineLabel = r.baseline_exact_count > 0
        ? (r.baseline_model_count > 0 ? `mixed baseline (${r.baseline_exact_count} exact)` : "prompt-hash baseline")
        : "model baseline";
      const guidanceParts = [];
      const needText = Math.max(0, DOC_MIN_SAMPLES - igSafeNum(r.text_ttft_count, 0));
      const needFile = Math.max(0, DOC_MIN_SAMPLES - igSafeNum(r.file_ttft_count, 0));
      if (needText > 0) guidanceParts.push(needRunMsg(needText, "text-only"));
      if (needFile > 0) guidanceParts.push(needRunMsg(needFile, "document-attached"));
      const guidance = valid ? `${baselineLabel} - ${formatInt(r.ttft_delta_count)} comparable runs` : guidanceMsg(guidanceParts);
      return `
        <div class="doc-metric-row ${valid ? "" : "is-disabled"}">
          <div class="doc-row-head">
            <span class="doc-name"><span class="color-dot" style="background:${r.color}"></span>${escapeHtml(r.short)}</span>
            <span class="doc-value ${valid ? (delta < 0 ? "val-green" : delta > 0 ? "val-warn" : "val") : ""}">${valid ? `${delta >= 0 ? "+" : ""}${formatNumber(delta, 0)} ms` : "-"}</span>
          </div>
          <div class="doc-delta-track ${valid ? "" : "disabled"}">
            <div class="doc-delta-zero"></div>
            <div class="doc-delta-fill ${cls}" style="left:${formatNumber(left, 1)}%;width:${formatNumber(magPct, 1)}%"></div>
          </div>
          <div class="doc-meta">${guidance}</div>
        </div>
      `;
    }).join("")
    : `<div class="llm-empty">No text-only baseline available for TTFT delta.</div>`;

  const outputHtml = outputRows.length
    ? outputRows.map((r) => {
      const valid = typeof r.ms_per_output_token_file === "number" && typeof r.ms_per_output_token_text === "number" && r.file_output_speed_count >= DOC_MIN_SAMPLES && r.text_output_speed_count >= DOC_MIN_SAMPLES;
      const f = r.ms_per_output_token_file;
      const t = r.ms_per_output_token_text;
      const filePct = valid && typeof f === "number" ? (f / outputMax) * 100 : 0;
      const textPct = valid && typeof t === "number" ? (t / outputMax) * 100 : 0;
      const deltaPct = r.output_efficiency_delta_pct;
      const guidanceParts = [];
      const needText = Math.max(0, DOC_MIN_SAMPLES - igSafeNum(r.text_output_speed_count, 0));
      const needFile = Math.max(0, DOC_MIN_SAMPLES - igSafeNum(r.file_output_speed_count, 0));
      if (needText > 0) guidanceParts.push(needRunMsg(needText, "text-only"));
      if (needFile > 0) guidanceParts.push(needRunMsg(needFile, "document-attached"));
      const guidance = valid
        ? `${deltaPct >= 0 ? "+" : ""}${formatNumber(deltaPct, 1)}% vs text baseline`
        : guidanceMsg(guidanceParts);
      return `
        <div class="doc-metric-row ${valid ? "" : "is-disabled"}">
          <div class="doc-row-head">
            <span class="doc-name"><span class="color-dot" style="background:${r.color}"></span>${escapeHtml(r.short)}</span>
            <span class="doc-value">${valid && typeof f === "number" ? `${formatNumber(f, 2)} ms/tok` : "-"}</span>
          </div>
          <div class="doc-dual-bars">
            <div class="doc-dual-line">
              <span class="doc-dual-label">Text</span>
              <div class="doc-track ${valid ? "" : "disabled"}"><div class="doc-fill ${valid ? "neutral" : "disabled"}" style="width:${formatNumber(textPct, 1)}%"></div></div>
              <span class="doc-dual-value">${valid && typeof t === "number" ? formatNumber(t, 2) : "-"}</span>
            </div>
            <div class="doc-dual-line">
              <span class="doc-dual-label">File</span>
              <div class="doc-track ${valid ? "" : "disabled"}"><div class="doc-fill ${valid ? "blue" : "disabled"}" style="width:${formatNumber(filePct, 1)}%"></div></div>
              <span class="doc-dual-value">${valid && typeof f === "number" ? formatNumber(f, 2) : "-"}</span>
            </div>
          </div>
          <div class="doc-meta">${guidance}</div>
        </div>
      `;
    }).join("")
    : `<div class="llm-empty">No output timing data available for document runs.</div>`;

  const bestIngestion = ingestionValidRows[0] || null;
  const bestTtft = [...ttftValidRows].sort((a, b) => (a.ttft_delta_ms || 0) - (b.ttft_delta_ms || 0))[0] || null;
  const stableOutput = [...outputValidRows]
    .filter((r) => typeof r.output_efficiency_delta_pct === "number")
    .sort((a, b) => Math.abs(a.output_efficiency_delta_pct) - Math.abs(b.output_efficiency_delta_pct))[0] || null;

  return `
    <div class="card-panel full-width" data-panel="document-ingestion-efficiency">
      <h3 class="dark-header">DOCUMENT INGESTION EFFICIENCY INDEX</h3>
      <div class="sub-label">Isolates document workflows by comparing ingestion cost per MB, TTFT inflation versus text-only baselines, and post-ingestion output efficiency. Lower values are generally better.</div>
      <div class="doc-ingestion-grid">
        <div class="doc-subpanel">
          <div class="doc-subpanel-title">A. Ingestion Cost per MB</div>
          <div class="doc-subpanel-sub">Prompt processing cost normalized by file size (ms/MB)</div>
          <div>${ingestionHtml}</div>
        </div>
        <div class="doc-subpanel">
          <div class="doc-subpanel-title">B. TTFT Inflation (Delta)</div>
          <div class="doc-subpanel-sub">Document TTFT minus text-only baseline TTFT (ms)</div>
          <div>${ttftHtml}</div>
        </div>
        <div class="doc-subpanel">
          <div class="doc-subpanel-title">C. Output Efficiency After Ingestion</div>
          <div class="doc-subpanel-sub">Compare ms/output-token for text-only vs text+file (lower is better)</div>
          <div>${outputHtml}</div>
        </div>
      </div>
      <div class="takeaway"><strong>DOC TAKEAWAY:</strong> ${bestIngestion ? `${escapeHtml(bestIngestion.short)} leads ingestion at ${formatNumber(bestIngestion.doc_ms_per_mb, 0)} ms/MB.` : "Need more file runs."} ${bestTtft ? `Best startup delta: ${escapeHtml(bestTtft.short)} (${bestTtft.ttft_delta_ms >= 0 ? "+" : ""}${formatNumber(bestTtft.ttft_delta_ms, 0)} ms).` : ""} ${stableOutput ? `Most stable output speed vs text baseline: ${escapeHtml(stableOutput.short)} (${stableOutput.output_efficiency_delta_pct >= 0 ? "+" : ""}${formatNumber(stableOutput.output_efficiency_delta_pct, 1)}%).` : ""}</div>
    </div>
  `;
}

/**
 * Perf Render Scatter Svg.
 */
function perfRenderScatterSvg(textModels, dims = {}) {
  if (!textModels.length) return `<div class="llm-empty">No models with parseable size and speed data.</div>`;
  const W = Math.max(420, Math.round(igSafeNum(dims.W, 620)));
  const H = Math.max(260, Math.round(igSafeNum(dims.H, 260)));
  const pad = { l: 56, r: 24, t: 24, b: 46 };
  const sizeModels = textModels.filter((m) => typeof m.params === "number" && typeof m.tps === "number");
  if (!sizeModels.length) return `<div class="llm-empty">No models with parseable parameter counts found.</div>`;
  const xVals = sizeModels.map((m) => m.params).filter((x) => typeof x === "number");
  const tpsVals = textModels.map((m) => m.tps).filter((x) => typeof x === "number");
  const ttftVals = sizeModels.map((m) => m.ttft).filter((x) => typeof x === "number");
  const minX = Math.max(0, (Math.min(...xVals) || 0) * 0.9);
  const maxX = Math.max(...xVals) * 1.08;
  const minY = 0;
  const maxY = Math.max(10, Math.ceil((Math.max(...tpsVals) || 10) / 10) * 10);
  const xp = (v) => pad.l + ((v - minX) / Math.max(1, maxX - minX)) * (W - pad.l - pad.r);
  const yp = (v) => H - pad.b - ((v - minY) / Math.max(1, maxY - minY)) * (H - pad.t - pad.b);
  const bubbleRange = getMetricRange(sizeModels, (m) => m.ttft);
  const radiusFor = (ttft) => {
    const score = normalizeMetricValue(ttft, bubbleRange.min, bubbleRange.max, false);
    return 7 + ((score ?? 35) / 100) * 15;
  };
  const qx = quantile(xVals, 0.35) ?? (minX + (maxX - minX) * 0.35);
  const qy = quantile(tpsVals, 0.65) ?? (minY + (maxY - minY) * 0.65);
  const trendline = (() => {
    const trendPoints = sizeModels
      .map((m) => ({ x: m.params, y: m.expectedTps }))
      .filter((p) => typeof p.x === "number" && typeof p.y === "number")
      .sort((a, b) => a.x - b.x);
    if (trendPoints.length < 2) return "";
    const d = trendPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${xp(p.x).toFixed(1)} ${yp(p.y).toFixed(1)}`).join(" ");
    return `<path d="${d}" class="scatter-trendline"></path>`;
  })();
  const grid = Array.from({ length: 5 }, (_, i) => {
    const y = pad.t + i * ((H - pad.t - pad.b) / 4);
    const val = maxY - i * (maxY / 4);
    return `<g><line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" class="scatter-grid"/><text x="${pad.l - 5}" y="${y + 4}" class="scatter-tick" text-anchor="end">${Math.round(val)}</text></g>`;
  }).join("");
  const ticksX = Array.from({ length: 5 }, (_, i) => {
    const xVal = minX + i * ((maxX - minX) / 4);
    const x = xp(xVal);
    return `<g><line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}" class="scatter-grid"/><text x="${x}" y="${H - pad.b + 16}" class="scatter-tick" text-anchor="middle">${formatNumber(xVal, 1)}B</text></g>`;
  }).join("");
  const zoneX2 = xp(qx);
  const zoneY = yp(qy);
  const frontierZone = `
    <rect x="${pad.l}" y="${zoneY}" width="${Math.max(0, zoneX2 - pad.l)}" height="${Math.max(0, H - pad.b - zoneY)}" class="scatter-frontier-zone"></rect>
    <text x="${pad.l + 8}" y="${Math.max(pad.t + 14, zoneY + 16)}" class="scatter-frontier-label">Punching-above-weight zone</text>
  `;
  const points = sizeModels.map((m) => {
    if (typeof m.params !== "number" || typeof m.tps !== "number") return "";
    const x = xp(m.params);
    const y = yp(m.tps);
    const r = radiusFor(m.ttft);
    let anchor = m.params < (minX + maxX) / 2 ? "start" : "end";
    if (x < pad.l + 70) anchor = "start";
    if (x > (W - pad.r - 70)) anchor = "end";
    const dx = anchor === "start" ? r + 4 : -(r + 4);
    const labelY = Math.max(pad.t + 12, y - (r + 4));
    const title = [
      m.model,
      `${m.family} · ${m.modality}`,
      `Size: ${formatNumber(m.params, 1)}B`,
      `Predicted TPS: ${formatNumber(m.tps, 1)}`,
      `TTFT: ${formatNumber(m.ttft, 0)} ms`,
      `TPS / 1B: ${typeof m.tpsPerB === "number" ? formatNumber(m.tpsPerB, 2) : "-"}`,
      `Speed efficiency: ${typeof m.speedEfficiencyRatio === "number" ? formatNumber(m.speedEfficiencyRatio, 2) : "-"}`,
      `Prompt TPS: ${typeof m.promptTps === "number" ? formatNumber(m.promptTps, 1) : "-"}`
    ].join(" | ");
    return `
      <circle cx="${x}" cy="${y}" r="${formatNumber(r, 1)}" fill="${m.color}" class="scatter-dot scatter-bubble">
        <title>${escapeHtml(title)}</title>
      </circle>
      <circle cx="${x}" cy="${y}" r="3.8" fill="${m.color}" class="scatter-dot"></circle>
      <text x="${x + dx}" y="${labelY}" class="scatter-label" text-anchor="${anchor}">${escapeHtml(shortenModelName(m.short, 14))}</text>
    `;
  }).join("");
  return `
    <svg viewBox="0 0 ${W} ${H}" class="perf-scatter-svg" preserveAspectRatio="none">
      ${grid}
      ${ticksX}
      ${frontierZone}
      ${trendline}
      <line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" class="scatter-axis"/>
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}" class="scatter-axis"/>
      <text x="${W / 2}" y="${H - 3}" class="scatter-axis-label" text-anchor="middle">Parameter Count (B) →</text>
      <text x="12" y="${H / 2}" class="scatter-axis-label" text-anchor="middle" transform="rotate(-90 12 ${H / 2})">TPS ↑</text>
      ${points}
    </svg>
  `;
}

/**
 * Rerender Perf Frontier Scatter.
 */
function rerenderPerfFrontierScatter(root, records) {
  if (!root) return;
  const chartWrap = root.querySelector('.perf-dashboard .card-panel[data-panel="size-speed-responsiveness"] .frontier-chart');
  if (!(chartWrap instanceof HTMLElement)) return;
  const models = perfBuildModelRows(records).filter((m) => typeof m.params === "number" && typeof m.tps === "number");
  if (!models.length) return;
  const W = Math.max(420, Math.floor(chartWrap.clientWidth || 620));
  const H = Math.max(260, Math.floor(chartWrap.clientHeight || 260));
  chartWrap.innerHTML = perfRenderScatterSvg(models, { W, H });
}

/**
 * Adjust Perf Frontier Chart Height.
 */
function adjustPerfFrontierChartHeight(root = __dashboardState.elements?.root) {
  if (!root) return;
  const card = root.querySelector('.perf-dashboard .card-panel[data-panel="size-speed-responsiveness"]');
  if (!(card instanceof HTMLElement)) return;
  const grid = card.querySelector(".frontier-grid");
  const chartWrap = card.querySelector(".frontier-chart");
  if (!(grid instanceof HTMLElement) || !(chartWrap instanceof HTMLElement)) return;

  const title = card.querySelector("h3");
  const subtitle = card.querySelector(".sub-label");
  const cardStyle = getComputedStyle(card);
  const padTop = parseFloat(cardStyle.paddingTop) || 0;
  const padBottom = parseFloat(cardStyle.paddingBottom) || 0;
  const gridGap = parseFloat(getComputedStyle(grid).gap) || 12;

  const occupied =
    (title instanceof HTMLElement ? title.offsetHeight : 0) +
    (subtitle instanceof HTMLElement ? subtitle.offsetHeight : 0) +
    10 + // title bottom margin in design
    8;   // subtitle bottom spacing

  const available = Math.floor(card.clientHeight - padTop - padBottom - occupied);
  const nextHeight = Math.max(260, available);

  chartWrap.style.height = `${nextHeight}px`;

  // Keep legend column visually aligned when the card is stretched by the grid row.
  grid.style.alignItems = "stretch";
}

/**
 * Perf Hero Card.
 */
function perfHeroCard(card) {
  return `
    <div class="best-class-card">
      <div class="best-class-section">${escapeHtml(card.title)}</div>
      <div class="best-class-model">${escapeHtml(card.model || "-")}</div>
      <div class="best-class-metric">${escapeHtml(card.metric || "-")}</div>
      <div class="best-class-note">${escapeHtml(card.support || "")}</div>
      <div class="best-class-subtext">${escapeHtml(card.subtext || "")}</div>
    </div>
  `;
}

/**
 * Perf Render Bullet Rows.
 */
function perfRenderBulletRows(models) {
  const rows = models.filter((m) => typeof m.tps === "number" && typeof m.expectedTps === "number" && typeof m.speedEfficiencyRatio === "number");
  if (!rows.length) return `<div class="llm-empty">Need at least two models with parseable parameter counts to estimate expected speed.</div>`;
  const maxTps = Math.max(...rows.map((m) => Math.max(m.tps || 0, m.expectedTps || 0)), 1);
  return rows
    .sort((a, b) => (b.speedEfficiencyRatio || 0) - (a.speedEfficiencyRatio || 0))
    .map((m) => {
      const actualPct = ((m.tps || 0) / maxTps) * 100;
      const expectedPct = ((m.expectedTps || 0) / maxTps) * 100;
      const ratioTone = (m.speedEfficiencyRatio || 0) >= 1 ? "val-green" : "val-warn";
      const interpretation = (m.speedEfficiencyRatio || 0) >= 1.1
        ? "Delivers more output speed than its size trend would predict."
        : (m.speedEfficiencyRatio || 0) >= 0.95
          ? "Performs close to the speed expected for its parameter count."
          : "Runs slower than the size trend would suggest.";
      return `
        <div class="bullet-row" title="${escapeHtml(`${m.model} | Actual TPS ${formatNumber(m.tps, 1)} | Expected TPS ${formatNumber(m.expectedTps, 1)} | Speed efficiency ${formatNumber(m.speedEfficiencyRatio, 2)} | TPS/1B ${typeof m.tpsPerB === "number" ? formatNumber(m.tpsPerB, 2) : "-"}`)}">
          <div class="bullet-head">
            <span class="bullet-name"><span class="color-dot" style="background:${m.color}"></span>${escapeHtml(m.short)}</span>
            <span class="bullet-meta ${ratioTone}">${formatNumber(m.speedEfficiencyRatio, 2)}x expected</span>
          </div>
          <div class="bullet-track">
            <div class="bullet-band"></div>
            <div class="bullet-bar" style="width:${formatNumber(actualPct, 1)}%;background:${m.color}"></div>
            <div class="bullet-marker" style="left:${formatNumber(expectedPct, 1)}%"></div>
          </div>
          <div class="bullet-foot">
            <span>${formatNumber(m.params, 1)}B</span>
            <span>Actual ${formatNumber(m.tps, 1)} TPS</span>
            <span>Expected ${formatNumber(m.expectedTps, 1)} TPS</span>
          </div>
          <div class="bullet-interpret">${escapeHtml(interpretation)}</div>
        </div>
      `;
    }).join("");
}

/**
 * Perf Render Dumbbell Rows.
 */
function perfRenderDumbbellRows(models) {
  const rows = models.filter((m) => typeof m.responsivenessScore === "number" && typeof m.outputThroughputScore === "number");
  if (!rows.length) return `<div class="llm-empty">Need TTFT and TPS data to compare startup and sustained speed.</div>`;
  return rows
    .map((m) => ({
      ...m,
      balanceGap: Math.abs((m.outputThroughputScore || 0) - (m.responsivenessScore || 0)),
      balanceComposite: ((m.outputThroughputScore || 0) + (m.responsivenessScore || 0)) / 2
    }))
    .sort((a, b) => (b.balanceComposite - a.balanceComposite) || (a.balanceGap - b.balanceGap))
    .map((m) => {
      const start = m.responsivenessScore || 0;
      const end = m.outputThroughputScore || 0;
      const left = Math.min(start, end);
      const width = Math.max(2, Math.abs(end - start));
      return `
        <div class="dumbbell-row" title="${escapeHtml(`${m.model} | TTFT ${formatNumber(m.ttft, 0)} ms | Predicted TPS ${formatNumber(m.tps, 1)} | Balance gap ${formatNumber(m.balanceGap, 1)} | Total duration ${typeof m.totalDuration === "number" ? formatNumber(m.totalDuration, 0) : "-"}`)}">
          <div class="dumbbell-name"><span class="color-dot" style="background:${m.color}"></span>${escapeHtml(m.short)}</div>
          <div class="dumbbell-track">
            <div class="dumbbell-line" style="left:${formatNumber(left, 1)}%;width:${formatNumber(width, 1)}%"></div>
            <div class="dumbbell-point start" style="left:${formatNumber(start, 1)}%;background:${m.color}"></div>
            <div class="dumbbell-point end" style="left:${formatNumber(end, 1)}%;background:${m.color}"></div>
          </div>
          <div class="dumbbell-values">
            <span>${formatNumber(start, 0)}</span>
            <span>${formatNumber(end, 0)}</span>
          </div>
        </div>
      `;
    }).join("");
}

/**
 * Perf Render Waterfall.
 */
function perfRenderWaterfall(models) {
  const target = models.find((m) => typeof m.requestToHeaders === "number" && typeof m.headersToFirst === "number" && typeof m.firstToStop === "number") || null;
  if (!target) return `<div class="llm-empty">Need client lifecycle timing data to render latency anatomy.</div>`;
  const stages = [
    { key: "requestToHeaders", label: "Request → Headers", value: target.requestToHeaders, tone: "var(--accent-secondary)" },
    { key: "headersToFirst", label: "Headers → First chunk", value: target.headersToFirst, tone: "var(--accent-primary)" },
    { key: "firstToStop", label: "First chunk → Stop", value: target.firstToStop, tone: "var(--accent-positive)" }
  ];
  const total = stages.reduce((sum, s) => sum + (s.value || 0), 0);
  let offset = 0;
  const stageHtml = stages.map((s) => {
    const startPct = total > 0 ? (offset / total) * 100 : 0;
    const widthPct = total > 0 ? ((s.value || 0) / total) * 100 : 0;
    offset += s.value || 0;
    return `
      <div class="waterfall-stage" title="${escapeHtml(`${target.model} | ${s.label}: ${formatNumber(s.value, 0)} ms`)}">
        <div class="waterfall-label">${escapeHtml(s.label)}</div>
        <div class="waterfall-track">
          <div class="waterfall-bar" style="left:${formatNumber(startPct, 1)}%;width:${formatNumber(widthPct, 1)}%;background:${s.tone}"></div>
        </div>
        <div class="waterfall-value">${formatNumber(s.value, 0)} ms</div>
      </div>
    `;
  }).join("");
  const reasonHtml = (typeof target.reasoningMs === "number" || typeof target.totalDuration === "number") ? `
    <div class="takeaway"><strong>Selected Model:</strong> ${escapeHtml(target.short)}. Median successful-response total time is ${typeof target.totalDuration === "number" ? `${formatNumber(target.totalDuration, 0)} ms` : "-"}${typeof target.reasoningMs === "number" ? `, with ${formatNumber(target.reasoningMs, 0)} ms attributed to reasoning.` : "."}</div>
  ` : "";
  return `
    <div class="waterfall-summary">Showing median successful-response stages for <b>${escapeHtml(target.short)}</b>.</div>
    <div class="waterfall-shell">${stageHtml}</div>
    ${reasonHtml}
  `;
}

/**
 * Perf Render Radar.
 */
function perfRenderRadar(models) {
  const selected = models
    .filter((m) => typeof m.promptThroughputScore === "number" || typeof m.outputThroughputScore === "number")
    .sort((a, b) => (b.speedEfficiencyRatio || 0) - (a.speedEfficiencyRatio || 0))
    .slice(0, 4);
  if (selected.length < 2) {
    return `<div class="llm-empty">Select at least two models with timing data to render the radar profile.</div>`;
  }
  const axes = [
    ["Prompt Throughput", "promptThroughputScore"],
    ["Output Throughput", "outputThroughputScore"],
    ["Responsiveness", "responsivenessScore"],
    ["Total Speed", "totalSpeedScore"],
    ["Size Efficiency", "sizeEfficiencyScore"],
    ["Speed Efficiency", "speedEfficiencyRatio"],
    ["Reasoning Efficiency", "reasoningEfficiencyScore"],
    ["Stability", "stabilityScore"]
  ];
  const speedRatioRange = getMetricRange(selected, (m) => m.speedEfficiencyRatio);
  const valuesFor = (model) => axes.map(([_, key]) => {
    if (key === "speedEfficiencyRatio") {
      return normalizeMetricValue(model.speedEfficiencyRatio, speedRatioRange.min, speedRatioRange.max, false) ?? 50;
    }
    return model[key] ?? 50;
  });
  const W = 520;
  const H = 360;
  const cx = W / 2;
  const cy = H / 2 + 10;
  const radius = 118;
  const pointFor = (angle, value) => {
    const r = (Math.max(0, Math.min(100, value)) / 100) * radius;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };
  const ringHtml = [25, 50, 75, 100].map((level) => {
    const pts = axes.map((_, i) => {
      const angle = (-Math.PI / 2) + (i * Math.PI * 2 / axes.length);
      return pointFor(angle, level).join(",");
    }).join(" ");
    return `<polygon points="${pts}" class="radar-ring"></polygon>`;
  }).join("");
  const axisHtml = axes.map(([label], i) => {
    const angle = (-Math.PI / 2) + (i * Math.PI * 2 / axes.length);
    const [x, y] = pointFor(angle, 100);
    const [lx, ly] = pointFor(angle, 116);
    return `
      <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="radar-axis"></line>
      <text x="${lx}" y="${ly}" class="radar-label" text-anchor="middle">${escapeHtml(label)}</text>
    `;
  }).join("");
  const cards = selected.map((m) => {
    const vals = valuesFor(m);
    const points = vals.map((v, i) => {
      const angle = (-Math.PI / 2) + (i * Math.PI * 2 / axes.length);
      return pointFor(angle, v).join(",");
    }).join(" ");
    const raw = `TTFT ${formatNumber(m.ttft, 0)} ms | TPS ${formatNumber(m.tps, 1)} | TPS/1B ${typeof m.tpsPerB === "number" ? formatNumber(m.tpsPerB, 2) : "-"} | Speed efficiency ${typeof m.speedEfficiencyRatio === "number" ? formatNumber(m.speedEfficiencyRatio, 2) : "-"}`;
    const interpret = (() => {
      const responsiveness = m.responsivenessScore ?? 0;
      const throughput = m.outputThroughputScore ?? 0;
      const stability = m.stabilityScore ?? 0;
      if (responsiveness >= 65 && throughput >= 65) return "Balanced profile with both quick startup and strong sustained speed.";
      if (responsiveness > throughput) return "Leans toward responsiveness, with a faster startup than long-run throughput.";
      if (throughput > responsiveness) return "Leans toward sustained generation speed more than instant responsiveness.";
      if (stability >= 65) return "More defined by consistency than standout peak speed.";
      return "Mixed profile without a single dominant speed characteristic.";
    })();
    return `
      <div class="radar-card">
        <div class="radar-card-head">
          <div class="radar-card-title"><span class="color-dot" style="background:${m.color}"></span>${escapeHtml(m.short)}</div>
          <div class="radar-card-meta">${escapeHtml(m.modality)}</div>
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="radar-svg" preserveAspectRatio="xMidYMid meet">
          ${ringHtml}
          ${axisHtml}
          <polygon points="${points}" fill="${m.color}" class="radar-shape">
            <title>${escapeHtml(`${m.model} | ${raw}`)}</title>
          </polygon>
        </svg>
        <div class="radar-stats">
          <div><span>TTFT</span><b>${typeof m.ttft === "number" ? `${formatNumber(m.ttft, 0)} ms` : "-"}</b></div>
          <div><span>TPS</span><b>${typeof m.tps === "number" ? formatNumber(m.tps, 1) : "-"}</b></div>
          <div><span>TPS / 1B</span><b>${typeof m.tpsPerB === "number" ? formatNumber(m.tpsPerB, 2) : "-"}</b></div>
          <div><span>Speed Eff.</span><b>${typeof m.speedEfficiencyRatio === "number" ? `${formatNumber(m.speedEfficiencyRatio, 2)}x` : "-"}</b></div>
        </div>
        <div class="radar-interpret">${escapeHtml(interpret)}</div>
      </div>
    `;
  }).join("");
  return `
    <div class="radar-wrap radar-grid">
      ${cards}
    </div>
    <div class="sub-label radar-note">Each radar uses normalized scores across the current filtered successful-response dataset. Higher is better on every axis.</div>
  `;
}

/**
 * Perf Render Box Plot.
 */
function perfRenderBoxPlot(models) {
  const eligible = models.filter((m) => typeof m.ttftQ1 === "number" && typeof m.ttftQ3 === "number" && typeof m.ttftMin === "number" && typeof m.ttftMax === "number");
  if (!eligible.length) return "";
  const max = Math.max(...eligible.map((m) => m.ttftMax || 0), 1);
  return eligible
    .sort((a, b) => (a.ttftStd || 0) - (b.ttftStd || 0))
    .slice(0, 8)
    .map((m) => {
      const minPct = ((m.ttftMin || 0) / max) * 100;
      const maxPct = ((m.ttftMax || 0) / max) * 100;
      const q1Pct = ((m.ttftQ1 || 0) / max) * 100;
      const q3Pct = ((m.ttftQ3 || 0) / max) * 100;
      const medPct = ((m.ttft || 0) / max) * 100;
      return `
        <div class="box-row" title="${escapeHtml(`${m.model} | TTFT min ${formatNumber(m.ttftMin, 0)} ms | q1 ${formatNumber(m.ttftQ1, 0)} | median ${formatNumber(m.ttft, 0)} | q3 ${formatNumber(m.ttftQ3, 0)} | max ${formatNumber(m.ttftMax, 0)}`)}">
          <div class="box-name"><span class="color-dot" style="background:${m.color}"></span>${escapeHtml(m.short)}</div>
          <div class="box-track">
            <div class="box-whisker" style="left:${formatNumber(minPct, 1)}%;width:${formatNumber(Math.max(1, maxPct - minPct), 1)}%"></div>
            <div class="box-rect" style="left:${formatNumber(q1Pct, 1)}%;width:${formatNumber(Math.max(1, q3Pct - q1Pct), 1)}%;background:${m.color}"></div>
            <div class="box-median" style="left:${formatNumber(medPct, 1)}%"></div>
          </div>
          <div class="box-value">±${formatNumber(m.ttftStd, 0)}ms</div>
        </div>
      `;
    }).join("");
}

/**
 * Perf Render Dashboard Template.
 */
function perfRenderDashboardTemplate(records, summary, theme) {
  const models = perfBuildModelRows(records);
  if (!models.length) return `<div class="llm-empty">No data available for the infographic dashboard.</div>`;

  const textModels = models.filter((m) => m.modality === "text-only" && typeof m.ttft === "number");
  const sizedModels = models.filter((m) => typeof m.params === "number" && typeof m.tps === "number");
  const visionModels = models.filter((m) => m.modality !== "text-only" && typeof m.ttft === "number").sort((a, b) => (a.ttft || 0) - (b.ttft || 0));

  const ttftSorted = [...models].filter((m) => typeof m.ttft === "number").sort((a, b) => a.ttft - b.ttft).slice(0, 8);
  const ttftMax = Math.max(...ttftSorted.map((m) => m.ttft || 0), 1);
  const ttftBars = ttftSorted.map((m, i) => perfSpeedBarRow(m.short, m.ttft, "ms", 100 - (((m.ttft || 0) / ttftMax) * 100), m.color, "val", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("");

  const tpsSorted = [...models].filter((m) => typeof m.tps === "number").sort((a, b) => (b.tps || 0) - (a.tps || 0));
  const tpsMax = Math.max(...tpsSorted.map((m) => m.tps || 0), 1);
  const tpsBars = tpsSorted.slice(0, 10).map((m, i) => perfSpeedBarRow(m.short, m.tps, "", ((m.tps || 0) / tpsMax) * 100, m.color, "val-blue", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("");

  const effSorted = [...sizedModels].filter((m) => typeof m.tpsPerB === "number").sort((a, b) => (b.tpsPerB || 0) - (a.tpsPerB || 0));
  const effMax = Math.max(...effSorted.map((m) => m.tpsPerB || 0), 1);
  const effBars = effSorted.slice(0, 8).map((m, i) => perfSpeedBarRow(`${m.short} (${formatNumber(m.params, 1)}B)`, m.tpsPerB, "", ((m.tpsPerB || 0) / effMax) * 100, m.color, "val-blue", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("");

  const responseNormSorted = [...sizedModels].filter((m) => typeof m.sizeNormalizedResponsivenessScore === "number")
    .sort((a, b) => (b.sizeNormalizedResponsivenessScore || 0) - (a.sizeNormalizedResponsivenessScore || 0));
  const bulletRows = perfRenderBulletRows(sizedModels);
  const dumbbellRows = perfRenderDumbbellRows(models);
  const waterfall = perfRenderWaterfall(models);
  const radar = perfRenderRadar(models);
  const consistencyPlot = perfRenderBoxPlot(models);
  const scatterLegend = uniqueValues(sizedModels.map((m) => m.family)).map((family) => {
    const sample = sizedModels.find((m) => m.family === family);
    return `<div class="legend-item"><div class="legend-dot" style="background:${sample?.color || "#999"}"></div>${escapeHtml(family)}</div>`;
  }).join("");
  const scatterSvg = perfRenderScatterSvg(sizedModels);
  const docRows = perfBuildDocumentIngestionRows(records);
  const docIngestionCard = perfRenderDocumentIngestionCard(records);

  const topTps = tpsSorted[0] || null;
  const bestTtft = ttftSorted[0] || null;
  const bestEff = effSorted[0] || null;
  const bestSpeedRatio = [...sizedModels].filter((m) => typeof m.speedEfficiencyRatio === "number")
    .sort((a, b) => (b.speedEfficiencyRatio || 0) - (a.speedEfficiencyRatio || 0))[0] || null;
  const heroCards = [
    {
      title: "Fastest First Response",
      model: bestTtft?.model || "-",
      metric: typeof bestTtft?.ttft === "number" ? `${formatNumber(bestTtft.ttft, 0)}ms` : "-",
      support: bestTtft?.short || "",
      subtext: "Lowest successful-response TTFT in the current comparison set."
    },
    {
      title: "Highest Output Speed",
      model: topTps?.model || "-",
      metric: typeof topTps?.tps === "number" ? `${formatNumber(topTps.tps, 1)} TPS` : "-",
      support: topTps?.short || "",
      subtext: "Fastest sustained generation speed among successful completed runs."
    },
    {
      title: "Best TPS per 1B Parameters",
      model: bestEff?.model || "-",
      metric: typeof bestEff?.tpsPerB === "number" ? `${formatNumber(bestEff.tpsPerB, 2)} TPS / 1B` : "-",
      support: bestEff?.short || "",
      subtext: "Highest size-normalized output speed across successful responses."
    },
    {
      title: "Best Speed Efficiency Ratio",
      model: bestSpeedRatio?.model || "-",
      metric: typeof bestSpeedRatio?.speedEfficiencyRatio === "number" ? `${formatNumber(bestSpeedRatio.speedEfficiencyRatio, 2)}x` : "-",
      support: bestSpeedRatio?.short || "",
      subtext: "Highest output speed relative to the expected size trendline."
    }
  ];
  const bestInClassRow = `
    <div class="best-class-row full-width">
      ${heroCards.map(perfHeroCard).join("")}
    </div>
  `;
  const headerSummaryMeta = `
    <div class="header-meta-grid">
      <div class="header-meta-item"><span>Completions</span><b>${formatInt(summary?.total_completions)}</b></div>
      <div class="header-meta-item"><span>Models</span><b>${formatInt(summary?.distinct_models)}</b></div>
      <div class="header-meta-item"><span>Avg Gen</span><b>${formatNumber(summary?.avg_predicted_tps, 1)} t/s</b></div>
      <div class="header-meta-item"><span>Avg TTFT</span><b>${formatNumber(convertMsToSec(summary?.avg_ttft_ms), 2)} s</b></div>
      <div class="header-meta-item"><span>Doc Req</span><b>${formatPct(summary?.document_attached_requests_pct)}</b></div>
      <div class="header-meta-item"><span>Image Req</span><b>${formatPct(summary?.image_attached_requests_pct)}</b></div>
    </div>
  `;

  return `
    <div class="container-fluid perf-dashboard" data-theme="${theme === "dark" ? "dark" : "light"}">
      <div class="infographic-wrapper">
        <div class="stars"></div>
        <div class="content">
          <div class="header-section">
            <div class="header-mascot">🦙</div>
            <div class="header-text">
              <h1>LLM PERFORMANCE<br>DASHBOARD</h1>
              <p>All metrics shown here are based on successful completed responses. Filters above apply to every section.</p>
            </div>
            <div class="header-meta">
              ${headerSummaryMeta}
            </div>
          </div>
          <div class="section-divider"></div>
          <div class="main-grid">
            ${bestInClassRow}
            <div class="card-panel tone-orange" data-panel="ttft">
              <h3 class="orange-header">THE RACE TO FIRST RESPONSE</h3>
              <div class="sub-label">The first token is the first moment a model feels alive. Lower times here usually produce the strongest perception of responsiveness.</div>
              <div>${ttftBars}</div>
              <div class="takeaway"><strong>TAKEAWAY:</strong> The fastest successful responses arrive in roughly ${ttftSorted[0]?.ttft ? `${formatNumber(ttftSorted[0].ttft, 0)} ms` : "-"}.</div>
            </div>

            <div class="card-panel tone-blue" data-panel="tps">
              <h3 class="blue-header">TOKENS PER SECOND</h3>
              <div class="sub-label">Once generation begins, sustained output speed shapes how fast the answer continues to arrive.</div>
              <div>${tpsBars}</div>
              <div class="takeaway"><strong>WINNER:</strong> ${topTps ? `${escapeHtml(topTps.short)} leads at ${formatNumber(topTps.tps, 1)} TPS.` : "No TPS data."}</div>
            </div>

            <div class="card-panel full-width tone-dark" data-panel="size-speed-responsiveness">
              <h3 class="dark-header">SIZE, SPEED, AND RESPONSIVENESS</h3>
              <div class="sub-label">A three-dimensional view of practical model performance. This chart compares model size, output speed, and response latency to show which models punch above their weight.</div>
              <div class="frontier-grid">
                <div class="chart-container frontier-chart">${scatterSvg}</div>
                <div>
                  <div class="legend-title">MODEL FAMILY LEGEND</div>
                  <div>${scatterLegend}</div>
                  <div class="takeaway"><strong>NOTE:</strong> Larger bubbles indicate worse TTFT. The trendline estimates expected TPS from model size using the current filtered comparison set.</div>
                </div>
              </div>
            </div>

            <div class="card-panel full-width tone-blue" data-panel="punching-above-weight">
              <h3 class="blue-header">PUNCHING ABOVE ITS WEIGHT</h3>
              <div class="sub-label">This view compares actual output speed to the speed predicted by model size. It highlights which models are faster or slower than their parameter count would suggest.</div>
              <div class="sub-label">Expected speed is estimated from the current comparison set using a parameter-size trendline.</div>
              <div class="bullet-list">${bulletRows}</div>
            </div>

            <div class="card-panel tone-orange" data-panel="quick-off-the-line">
              <h3 class="orange-header">QUICK OFF THE LINE OR BUILT FOR THE LONG RUN?</h3>
              <div class="sub-label">This chart compares response startup speed and sustained generation speed to show which models start quickly, which models sustain throughput, and which balance both.</div>
              <div class="dumbbell-scale"><span>Startup score</span><span>Balanced</span><span>Throughput score</span></div>
              <div class="dumbbell-list">${dumbbellRows}</div>
            </div>

            <div class="card-panel tone-dark" data-panel="latency-anatomy">
              <h3 class="dark-header">LATENCY ANATOMY</h3>
              <div class="sub-label">A breakdown of where successful-response time is spent, from request start to first token and through the completion of streamed output.</div>
              <div class="sub-label">This section uses the first currently selected model with complete lifecycle timing coverage.</div>
              ${waterfall}
            </div>

            <div class="card-panel tone-blue" data-panel="size-efficiency">
              <h3 class="blue-header">BEST TPS PER 1B PARAMETERS</h3>
              <div class="sub-label">This chart normalizes output speed by parameter count. Higher values indicate more generation speed per billion parameters, not a universal quality winner.</div>
              <div>${effBars || `<div class="llm-empty">No parseable parameter sizes found.</div>`}</div>
              <div class="takeaway"><strong>TAKEAWAY:</strong> ${bestEff ? `${escapeHtml(bestEff.short)} leads size-normalized generation efficiency at ${formatNumber(bestEff.tpsPerB, 2)} TPS / 1B.` : "No parseable parameter sizes found."}</div>
            </div>

            <div class="card-panel full-width tone-orange" data-panel="model-personality">
              <h3 class="orange-header">MODEL PERSONALITY PROFILE</h3>
              <div class="sub-label">A profile view of each model across speed, responsiveness, efficiency, and stability. Use this to compare whether a model is balanced or specialized.</div>
              ${radar}
            </div>

            ${docIngestionCard}

            <div class="card-panel tone-blue" data-panel="vision-tax">
              <h3 class="blue-header">VISION PERFORMANCE</h3>
              <div class="sub-label">Vision-capable models should be judged on their own terms. Image handling adds latency and should be compared separately from text-only runs.</div>
              <div>${visionModels.length ? visionModels.slice(0, 6).map((m, i) => perfSpeedBarRow(`${m.short} (${m.modality})`, m.ttft, "ms", 100 - (((m.ttft || 0) / Math.max(...visionModels.map((x) => x.ttft || 0), 1)) * 100), m.color, "val", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("") : `<div class="llm-empty">Capture image prompts to populate this panel.</div>`}</div>
              <div class="takeaway"><strong>NOTE:</strong> ${visionModels[0] ? `${escapeHtml(visionModels[0].short)} currently has the fastest successful-response vision TTFT at ${formatNumber(visionModels[0].ttft, 0)} ms.` : "Vision runs have not been captured in this filtered view."}</div>
            </div>

            <div class="card-panel full-width tone-dark" data-panel="latency-stability">
              <h3 class="dark-header">CONSISTENCY UNDER LOAD</h3>
              <div class="sub-label">Average speed is only part of the story. This view shows how predictably each model performs across successful runs.</div>
              <div class="sub-label">Box ranges show TTFT spread from lower quartile to upper quartile; smaller boxes and whiskers indicate tighter behavior.</div>
              <div class="box-list">${consistencyPlot || `<div class="llm-empty">Need repeated TTFT samples to render the distribution view.</div>`}</div>
            </div>
          </div>
          <div class="footer-section">
            <p>Data from captured extension traces · session filtered by current dashboard controls · ${new Date().toLocaleDateString()}</p>
            <div class="llama-row">🦙🦙🦙🦙🦙</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render Dashboard.
 */
function renderDashboard(stats) {
  const elements = __dashboardState.elements;
  if (!elements) return;

  __dashboardState.lastStats = stats;
  const baseRecords = Array.isArray(stats?.records_compact) ? stats.records_compact : [];
  const models = Array.isArray(stats?.models) ? stats.models : [];
  syncInputModeSelector(baseRecords);
  syncModelToggles(models);

  const mode = __dashboardState.selectedInputMode || "all";
  const filteredByMode = mode === "all" ? baseRecords : baseRecords.filter((r) => (r?.input_mode || "unknown") === mode);
  const selectedModels = new Set(Array.from(__dashboardState.selectedModels));
  const filtered = filteredByMode.filter((r) => selectedModels.has(r.model));

  const filteredSummary = (() => {
    const total = filtered.length;
    const distinctModels = uniqueValues(filtered.map((r) => r?.model)).length;
    const predTpsVals = filtered.map((r) => toFiniteNumber(r?.predicted_tps)).filter((x) => x !== null);
    const ttftVals = filtered.map((r) => toFiniteNumber(r?.ttft_ms)).filter((x) => x !== null);
    const docCount = filtered.filter((r) => perfIsDocumentAttachedRecord(r)).length;
    const imageCount = filtered.filter((r) => r?.has_images === true).length;
    return {
      total_completions: total,
      distinct_models: distinctModels,
      avg_predicted_tps: avgOf(predTpsVals),
      avg_ttft_ms: avgOf(ttftVals),
      document_attached_requests_pct: total > 0 ? (docCount / total) * 100 : 0,
      image_attached_requests_pct: total > 0 ? (imageCount / total) * 100 : 0
    };
  })();

  elements.summary.innerHTML = `
    <div class="llm-chip">Completions: <b>${formatInt(filteredSummary.total_completions)}</b></div>
    <div class="llm-chip">Models: <b>${formatInt(filteredSummary.distinct_models)}</b></div>
    <div class="llm-chip">Avg Gen: <b>${formatNumber(filteredSummary.avg_predicted_tps, 2)} t/s</b></div>
    <div class="llm-chip">Avg TTFT: <b>${formatNumber(convertMsToSec(filteredSummary.avg_ttft_ms), 2)} s</b></div>
    <div class="llm-chip">Doc Req: <b>${formatPct(filteredSummary.document_attached_requests_pct)}</b></div>
    <div class="llm-chip">Image Req: <b>${formatPct(filteredSummary.image_attached_requests_pct)}</b></div>
  `;
  elements.summary.style.display = "none";
  const titleEl = elements.root.querySelector(".llm-title");
  if (titleEl) titleEl.textContent = "Llama.cpp UI: Metrics Dashboard";
  elements.bestCards.innerHTML = perfRenderDashboardTemplate(filtered, filteredSummary, __dashboardState.theme);

  requestAnimationFrame(() => {
    adjustPerfFrontierChartHeight(elements.root);
    rerenderPerfFrontierScatter(elements.root, filtered);
  });
}

/**
 * Set Dashboard Status.
 */
function setDashboardStatus(text) {
  const el = __dashboardState.elements?.status;
  if (!el) return;
  const msg = String(text || "");
  el.textContent = msg;
  const isError = /\b(fail|failed|error)\b/i.test(msg);
  const isSuccess = /\b(exported|success|saved|complete|completed)\b/i.test(msg) && !isError;
  el.classList.toggle("llm-status-error", isError);
  el.classList.toggle("llm-status-success", isSuccess);
}

/**
 * Fetch Dashboard Stats.
 */
async function fetchDashboardStats() {
  return chrome.runtime.sendMessage({
    type: "get_dashboard_stats",
    scope: __dashboardState.scope,
    selected_model: __dashboardState.selectedModel
  });
}

/**
 * Refresh Dashboard.
 */
async function refreshDashboard(reason = "manual") {
  if (!__dashboardState.mounted) return;
  setDashboardStatus(`Loading metrics (${reason})...`);
  try {
    const res = await fetchDashboardStats();
    if (!res?.ok) {
      setDashboardStatus(`Failed to load metrics: ${res?.error || "unknown error"}`);
      return;
    }
    renderDashboard(res);
    setDashboardStatus("");
  } catch (e) {
    setDashboardStatus(`Failed to load metrics: ${e?.message || e}`);
  }
}

/**
 * Export Dashboard Png.
 */
async function exportDashboardPng() {
  const elements = __dashboardState.elements;
  if (!elements?.root) return;

  const scrollEl = elements.root.querySelector(".llm-body");
  if (!(scrollEl instanceof HTMLElement)) {
    setDashboardStatus("Export failed: dashboard container not found.");
    return;
  }

  const previousTop = scrollEl.scrollTop;
  const previousBehavior = scrollEl.style.scrollBehavior;

  try {
    scrollEl.style.scrollBehavior = "auto";
    scrollEl.scrollTop = 0;
    await sleep(80);

    const rect = scrollEl.getBoundingClientRect();
    const totalHeight = Math.max(scrollEl.scrollHeight, scrollEl.clientHeight);
    const viewportHeight = Math.max(1, scrollEl.clientHeight);

    if (rect.width <= 0 || rect.height <= 0 || totalHeight <= 0) {
      setDashboardStatus("Export failed: invalid dashboard dimensions.");
      return;
    }

    const tops = [];
    for (let t = 0; t < totalHeight; t += viewportHeight) {
      tops.push(Math.min(t, Math.max(0, totalHeight - viewportHeight)));
    }
    const uniqueTops = Array.from(new Set(tops));

    let outCanvas = null;
    let outCtx = null;
    let scaleX = 1;
    let scaleY = 1;
    let srcX = 0;
    let srcY = 0;
    let srcW = 0;
    let srcH = 0;

    for (let i = 0; i < uniqueTops.length; i++) {
      const top = uniqueTops[i];
      scrollEl.scrollTop = top;
      setDashboardStatus(`Exporting PNG... ${i + 1}/${uniqueTops.length}`);
      await sleep(120);

      const cap = await safeSendMessage({ type: "capture_visible_png" });
      if (!cap?.ok || !cap?.data_url) {
        throw new Error(cap?.error || "capture_failed");
      }
      const frame = await loadImageFromDataUrl(cap.data_url);

      if (!outCanvas) {
        scaleX = frame.width / Math.max(1, window.innerWidth);
        scaleY = frame.height / Math.max(1, window.innerHeight);
        srcX = Math.max(0, Math.round(rect.left * scaleX));
        srcY = Math.max(0, Math.round(rect.top * scaleY));
        srcW = Math.max(1, Math.round(rect.width * scaleX));
        srcH = Math.max(1, Math.round(rect.height * scaleY));

        outCanvas = document.createElement("canvas");
        outCanvas.width = srcW;
        outCanvas.height = Math.max(1, Math.round(totalHeight * scaleY));
        outCtx = outCanvas.getContext("2d");
        if (!outCtx) throw new Error("canvas_ctx_failed");
      }

      const destY = Math.max(0, Math.round(top * scaleY));
      const drawH = Math.max(1, Math.min(srcH, outCanvas.height - destY));
      outCtx.drawImage(frame, srcX, srcY, srcW, drawH, 0, destY, srcW, drawH);
    }

    if (!outCanvas) throw new Error("no_frames_captured");
    const dataUrl = outCanvas.toDataURL("image/png");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `llamacpp-dashboard_${stamp}.png`;
    const dl = await safeSendMessage({ type: "download_data_url", data_url: dataUrl, filename });
    if (!dl?.ok) {
      throw new Error(dl?.error || "download_failed");
    }
    setDashboardStatus(`Exported PNG: ${filename}`);
  } catch (e) {
    const message = String(e?.message || e || "");
    const isCapturePermissionError =
      message.includes("<all_urls>") ||
      message.includes("activeTab") ||
      message.includes("captureVisibleTab");
    if (isCapturePermissionError) {
      setDashboardStatus(
        "Export failed: Chrome blocked screen capture for this tab. Fix: grant the extension site access (or activeTab permission), then reload the page and reopen the dashboard before exporting PNG again."
      );
    } else {
      setDashboardStatus(`Export failed: ${message}`);
    }
  } finally {
    scrollEl.scrollTop = previousTop;
    scrollEl.style.scrollBehavior = previousBehavior;
  }
}

/**
 * Schedule Dashboard Refresh.
 */
function scheduleDashboardRefresh(reason = "update") {
  if (!__dashboardState.mounted || !__dashboardState.overlayOpen) return;
  if (__dashboardRefreshTimer) clearTimeout(__dashboardRefreshTimer);
  __dashboardRefreshTimer = setTimeout(() => {
    refreshDashboard(reason);
  }, 350);
}

/**
 * Apply Dashboard Theme.
 */
function applyDashboardTheme(theme) {
  const elements = __dashboardState.elements;
  if (!elements) return;
  const nextTheme = theme === "dark" ? "dark" : "light";
  __dashboardState.theme = nextTheme;
  elements.overlay.setAttribute("data-theme", nextTheme);
  const perfDash = elements.root.querySelector(".perf-dashboard");
  if (perfDash) perfDash.setAttribute("data-theme", nextTheme);
  if (elements.themeToggle) {
    elements.themeToggle.textContent = nextTheme === "dark" ? "Light" : "Dark";
  }
}


/**
 * Save Dashboard Theme.
 */
async function saveDashboardTheme(theme) {
  try {
    await chrome.storage.local.set({ [DASHBOARD_THEME_KEY]: theme === "dark" ? "dark" : "light" });
  } catch {}
}

/**
 * Open Dashboard Overlay.
 */
function openDashboardOverlay() {
  const elements = __dashboardState.elements;
  if (!elements) return;
  __dashboardState.overlayOpen = true;
  elements.overlay.classList.add("open");
  elements.tab.classList.add("hidden");
  refreshDashboard("open");
}

/**
 * Minimize Dashboard Overlay.
 */
function minimizeDashboardOverlay() {
  const elements = __dashboardState.elements;
  if (!elements) return;
  __dashboardState.overlayOpen = false;
  elements.overlay.classList.remove("open");
  elements.tab.classList.remove("hidden");
}

/**
 * Mount Dashboard Ui.
 */
function mountDashboardUi() {
  if (!isTopFrame()) return;
  if (__dashboardState.mounted) return;

  const host = document.createElement("div");
  host.id = "llamacpp-metrics-overlay-root";
  const root = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Open+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400&family=Unbounded:wght@400;500;700&display=swap');
      :host {
        all: initial;
        --llm-ink: #1f2b2a;
        --llm-muted: #4d5f5d;
        --llm-bg: #f4f7f5;
        --llm-card: #ffffff;
        --llm-accent: #1f7a64;
        --llm-accent-2: #0f4f8a;
        --llm-border: #cbdad6;
        --llm-shadow: 0 10px 26px rgba(24, 39, 35, 0.18);
        --llm-series-1: #1e88e5;
        --llm-series-2: #ef6c00;
        --llm-series-3: #43a047;
        --llm-series-4: #7e57c2;
        --llm-series-5: #d81b60;
        --llm-series-6: #00897b;
      }
      .llm-overlay[data-theme="dark"] {
        --llm-ink: #dbe8e5;
        --llm-muted: #9cb2ae;
        --llm-bg: #081615;
        --llm-card: #0d2321;
        --llm-accent: #4fd1aa;
        --llm-accent-2: #69a3ff;
        --llm-border: #1f3e3a;
        --llm-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
        --llm-series-1: #6aa9ff;
        --llm-series-2: #ffb266;
        --llm-series-3: #6ed58a;
        --llm-series-4: #b49cff;
        --llm-series-5: #ff7dab;
        --llm-series-6: #54d3c2;
      }
      .llm-tab {
        position: fixed;
        right: 16px;
        bottom: 0px;
        z-index: 2147483647;
        font: 700 12px/1.2 "Segoe UI", Tahoma, sans-serif;
        border: 1px solid var(--llm-border);
        border-radius: 14px 14px 0 0;
        padding: 9px 16px;
        background: #f2ebe0;
        color: var(--llm-ink);
        cursor: pointer;
      }
      .llm-tab.hidden { display: none; }
      .llm-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        opacity: 0;
        pointer-events: none;
        transition: opacity 140ms ease;
      }
      .llm-overlay.open { opacity: 1; pointer-events: auto; }
      .llm-backdrop { position: absolute; inset: 0; background: rgba(6, 12, 10, 0.5); }
      .llm-panel {
        position: absolute;
        inset: 0;
        background: var(--llm-bg);
        color: var(--llm-ink);
        transform: translateY(100%);
        transition: transform 170ms ease;
        display: flex;
        flex-direction: column;
        font: 13px/1.45 "Segoe UI", Tahoma, sans-serif;
      }
      .llm-overlay.open .llm-panel { transform: translateY(0); }
      .llm-header {
        position: sticky; top: 0; z-index: 3;
        display: flex; justify-content: space-between; align-items: center; gap: 10px;
        padding: 5px 7px;
        border-bottom: 1px solid var(--llm-border);
        background: color-mix(in srgb, var(--llm-bg) 90%, transparent);
        backdrop-filter: blur(6px);
      }
      .llm-title { font-size: 15px; font-weight: 800; letter-spacing: 0.01em; }
      .llm-header-actions { display: flex; gap: 8px; }
      .llm-btn {
        border: 1px solid var(--llm-border);
        background: var(--llm-card);
        color: var(--llm-ink);
        border-radius: 9px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .llm-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px; display: grid; gap: 12px; }
      .llm-summary { display: flex; gap: 8px; flex-wrap: wrap; }
      .llm-chip {
        background: var(--llm-card);
        border: 1px solid var(--llm-border);
        border-radius: 999px;
        padding: 6px 10px;
        color: var(--llm-muted);
      }
      .llm-chip b { color: var(--llm-ink); font-weight: 700; }
      .llm-controls {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: 10px;
        align-items: start;
      }
      .llm-select {
        border: 1px solid var(--llm-border);
        background: var(--llm-card);
        color: var(--llm-ink);
        border-radius: 10px;
        padding: 7px 8px;
      }
      .llm-toggle-wrap {
        border: 1px solid var(--llm-border);
        background: var(--llm-card);
        border-radius: 12px;
        padding: 8px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 6px 10px;
      }
      .llm-toggle { display: flex; align-items: center; gap: 7px; color: var(--llm-muted); font-size: 12px; }
      .llm-model-filter { position: relative; }
      .llm-model-filter-btn {
        width: 100%;
        text-align: left;
        cursor: pointer;
      }
      .llm-model-filter-panel {
        margin-top: 6px;
        border: 1px solid var(--llm-border);
        border-radius: 12px;
        background: var(--llm-card);
        box-shadow: var(--llm-shadow);
        padding: 8px;
        max-height: 220px;
        overflow: auto;
      }
      .llm-toggle-wrap-compact {
        border: 0;
        background: transparent;
        border-radius: 0;
        padding: 0;
        grid-template-columns: 1fr;
      }
      .llm-status { color: var(--llm-muted); font-size: 11px; }
      .llm-status.llm-status-error {
        color: #ffffff;
        background: var(--llm-series-5);
        border: 1px solid color-mix(in srgb, var(--llm-series-5) 70%, #000);
        border-radius: 8px;
        padding: 6px 8px;
      }
      .llm-status.llm-status-success {
        color: #ffffff;
        background: var(--llm-series-3);
        border: 1px solid color-mix(in srgb, var(--llm-series-3) 70%, #000);
        border-radius: 8px;
        padding: 6px 8px;
      }
      .llm-empty { color: var(--llm-muted); font-size: 12px; }
      .ig-wrap { display: grid; gap: 14px; }
      .ig-card {
        border: 1px solid var(--llm-border);
        border-radius: 16px;
        overflow: hidden;
        box-shadow: var(--llm-shadow);
        background: var(--llm-card);
      }
      .ig-kicker {
        font: 600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #ff5a2a;
        margin-bottom: 8px;
      }
      .ig-kicker.blue { color: #1a3a5c; }
      .ig-kicker.green { color: #4dff91; }
      .ig-kicker.amber { color: #e8a020; }
      .ig-kicker.soil { color: #c8691e; }
      .ig-dark {
        background: #08080d;
        border-color: #1a1a2e;
        color: #fff;
        padding: 20px;
      }
      .ig-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .ig-head h3 { margin: 0; font-size: 28px; line-height: 1; color: #fff; }
      .ig-head h3 span { color: #ff3c00; }
      .ig-head p { margin: 6px 0 0; color: #8a8a95; font-size: 12px; max-width: 520px; }
      .ig-ghost-stat { text-align: right; min-width: 84px; }
      .ig-ghost-stat .num { font-size: 56px; line-height: 0.9; color: #ff3c00; opacity: 0.18; font-weight: 800; }
      .ig-ghost-stat .txt { font-size: 9px; color: #525260; text-transform: uppercase; letter-spacing: .12em; }
      .ig-list { display: grid; gap: 6px; }
      .ig-card-row {
        display: grid;
        grid-template-columns: 180px 1fr 64px;
        gap: 10px;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .ig-card-row:last-child { border-bottom: 0; }
      .ig-row-model strong { display: block; font-size: 12px; color: inherit; }
      .ig-row-model span { font-size: 10px; color: #8b8b97; }
      .ig-bar-track { height: 18px; background: rgba(255,255,255,0.04); display: flex; overflow: hidden; border-radius: 6px; }
      .ig-seg { height: 100%; }
      .ig-net { background: #1a1a1a; }
      .ig-reason { background: linear-gradient(90deg, #1a0800, #ff3c00); }
      .ig-content { background: linear-gradient(90deg, #003d1a, #00d97e); }
      .ig-row-total { font-weight: 700; text-align: right; color: #d7d7df; }
      .ig-legend { margin-top: 12px; display: flex; gap: 16px; flex-wrap: wrap; color: #8f8f9a; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
      .ig-legend .ig-dot { display: inline-block; width: 16px; height: 6px; margin-right: 6px; border-radius: 2px; vertical-align: middle; }

      .ig-paper { background: #f5f2eb; color: #1a1a1a; padding: 20px; border-color: #ddd4c6; }
      .ig2-header { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: start; margin-bottom: 14px; }
      .ig2-title { margin: 0; font-size: 28px; line-height: 1.05; }
      .ig2-title em { color: #1a3a5c; }
      .ig2-header p { margin: 8px 0 0; color: #5a5a5a; font-size: 12px; max-width: 460px; }
      .ig2-headline { border-left: 3px solid #1a3a5c; padding-left: 10px; text-align: right; }
      .ig2-headline .n { font-size: 34px; line-height: 1; color: #1a3a5c; font-weight: 800; }
      .ig2-headline .t { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: .12em; max-width: 170px; }
      .ig2-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
      .ig2-cell { position: relative; background: #fff; border: 1px solid #e9e2d7; padding: 12px; border-left: 4px solid #ddd; border-radius: 10px; }
      .ig2-cell.high { background: #f6fff8; border-left-color: #2e7d32; }
      .ig2-cell.mid { border-left-color: #f57f17; }
      .ig2-cell.low { background: #fff8f6; border-left-color: #c62828; }
      .ig2-badge { position: absolute; top: 10px; right: 10px; width: 34px; height: 34px; border-radius: 50%; display:flex; align-items:center; justify-content:center; font-size: 10px; font-weight: 700; }
      .ig2-badge.high { background:#e8f5e9; color:#2e7d32; }
      .ig2-badge.mid { background:#fff8e1; color:#f57f17; }
      .ig2-badge.low { background:#fce4ec; color:#c62828; }
      .ig2-model strong { display:block; font-size:12px; color:#1a1a1a; margin-right:42px; }
      .ig2-model span { font-size:10px; color:#8a8a8a; }
      .ig2-labelrow { display:flex; justify-content:space-between; gap:8px; font-size:10px; color:#666; margin-top:8px; }
      .ig2-meter { height: 6px; background:#eee; border-radius: 999px; overflow:hidden; }
      .ig2-meter-fill { height:100%; }
      .ig2-meter-fill.think { background:#1a3a5c; }
      .ig2-meter-fill.out { background:#c8a96e; }
      .ig2-stats { display:grid; grid-template-columns: repeat(3,1fr); gap:6px; margin-top:10px; }
      .ig2-stats div { text-align:center; }
      .ig2-stats b { display:block; font-size:12px; color:#1a1a1a; }
      .ig2-stats span { font-size:9px; color:#8a8a8a; text-transform:uppercase; letter-spacing:.08em; }

      .ig-forest {
        background:
          radial-gradient(ellipse at 20% 50%, rgba(0,180,80,0.04) 0%, transparent 60%),
          radial-gradient(ellipse at 80% 20%, rgba(0,120,60,0.06) 0%, transparent 50%),
          #0e1a0e;
        border-color: #1a3a1a;
        color: #e8f5e8;
        padding: 20px;
      }
      .ig3-header { display:flex; justify-content:space-between; gap:12px; align-items:end; margin-bottom:12px; }
      .ig3-title { margin:0; font-size:28px; line-height:1; color:#e8f5e8; }
      .ig3-title span { color:#4dff91; }
      .ig3-tag { max-width:280px; font-size:10px; color:#3d6b3d; text-transform:uppercase; letter-spacing:.12em; text-align:right; }
      .ig3-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; margin-bottom:12px; }
      .ig3-summary > div { border:1px solid #1a3a1a; background:#0a140a; border-radius:10px; padding:10px; }
      .ig3-summary b { display:block; font-size:22px; color:#4dff91; line-height:1; }
      .ig3-summary span { font-size:9px; color:#3d6b3d; text-transform:uppercase; letter-spacing:.1em; }
      .ig3-list { display:grid; gap:12px; }
      .ig3-chain-meta { display:flex; justify-content:space-between; gap:8px; color:#3d6b3d; font-size:9px; letter-spacing:.08em; margin-bottom:6px; }
      .ig3-track { position:relative; height:70px; }
      .ig3-line { position:absolute; left:0; right:0; top:34px; height:1px; background:linear-gradient(90deg,#1a3a1a,#3d8b3d,#1a3a1a); }
      .ig3-dot-wrap { position:absolute; top:0; transform:translateX(-50%); }
      .ig3-dot { position:absolute; top:18px; left:50%; transform:translateX(-50%); border:2px solid; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:8px; font-weight:700; }
      .ig3-dot.runaway { border-color:#ff3c00 !important; box-shadow:0 0 0 1px rgba(255,60,0,0.3); }
      .ig3-dot.dead { opacity:0.45; }
      .ig3-dot-top { position:absolute; top:0; left:50%; transform:translateX(-50%); font-size:9px; font-weight:700; white-space:nowrap; }
      .ig3-dot-bottom { position:absolute; top:56px; left:50%; transform:translateX(-50%); font-size:8px; color:#3d6b3d; white-space:nowrap; }

      .ig-construct { background:#f5e6c8; border-color:#dbc39b; }
      .ig4-layout { display:grid; grid-template-columns:260px 1fr; }
      .ig4-side { background:#1a0f00; color:#f5e6c8; padding:16px; position:relative; }
      .ig4-side::after { content:""; position:absolute; right:0; top:0; bottom:0; width:4px; background:#e8a020; }
      .ig4-side h3 { margin:0; font-size:34px; line-height:.95; letter-spacing:.02em; }
      .ig4-side h3 span { display:block; color:#e8a020; }
      .ig4-side p { margin:8px 0 0; color:#8f7a54; font-size:11px; }
      .ig4-formula { margin-top:12px; border:1px solid #2a1f00; background:#0f0800; color:#e8a020; border-radius:8px; padding:8px; font-size:10px; }
      .ig4-main { padding:14px; }
      .ig4-headerline { display:flex; justify-content:space-between; gap:10px; font-size:10px; text-transform:uppercase; letter-spacing:.12em; color:#5a4a33; border-bottom:2px solid #0f0f0f; padding-bottom:6px; margin-bottom:8px; }
      .ig4-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
      .ig4-card { background:#fff; border:1px solid #eadcc5; border-left:4px solid #ccc; border-radius:10px; padding:10px; position:relative; min-height:120px; }
      .ig4-card.rank-1 { background:#fffbf0; border-left-color:#e8a020; }
      .ig4-card.rank-2 { border-left-color:#b8800a; }
      .ig4-card.rank-3 { border-left-color:#8a5f00; }
      .ig4-rank { position:absolute; top:8px; right:10px; color:#e8e0d0; font-weight:800; font-size:18px; }
      .ig4-model strong { display:block; font-size:12px; color:#111; margin-right:34px; }
      .ig4-model span { font-size:10px; color:#888; }
      .ig4-score { margin-top:6px; font-size:28px; line-height:1; font-weight:800; color:#111; }
      .ig4-score small { font-size:10px; color:#666; margin-left:4px; }
      .ig4-track { margin-top:8px; height:6px; background:#eee; border-radius:999px; overflow:hidden; }
      .ig4-fill { height:100%; background:#e8a020; }
      .ig4-meta { margin-top:8px; display:grid; grid-template-columns:repeat(3,1fr); gap:4px; font-size:9px; color:#666; }

      .ig-earth {
        background:
          radial-gradient(circle at 20% 60%, rgba(200,105,30,0.06), transparent 55%),
          radial-gradient(circle at 80% 20%, rgba(107,139,85,0.08), transparent 45%),
          #1c1a14;
        border-color:#2e2618;
        color:#e8dfc8;
        padding:20px;
      }
      .ig5-header { display:grid; grid-template-columns:1fr auto; gap:14px; align-items:start; margin-bottom:10px; }
      .ig5-title { margin:0; font-size:34px; line-height:.95; color:#e8dfc8; }
      .ig5-title span { color:#c8691e; }
      .ig5-header p { margin:8px 0 0; font-size:11px; color:#8b7355; max-width:560px; }
      .ig5-finding { width:240px; background:#c8691e; color:#fff; border-radius:10px; padding:10px 12px; }
      .ig5-finding .k { font-size:9px; text-transform:uppercase; letter-spacing:.12em; opacity:.75; }
      .ig5-finding .v { margin-top:4px; font-size:11px; line-height:1.35; font-weight:700; }
      .ig5-chart-wrap { border:1px solid #2a2218; border-radius:10px; background:rgba(0,0,0,0.08); padding:8px; }
      .ig5-svg { width:100%; height:auto; display:block; }
      .ig5-legend { display:flex; flex-wrap:wrap; gap:8px 12px; margin-top:10px; }
      .ig5-legend-item { display:flex; align-items:center; gap:6px; font-size:10px; color:#b09d7b; text-transform:uppercase; letter-spacing:.08em; }
      .ig5-legend-item i { width:16px; height:3px; display:inline-block; border-radius:2px; }

      /* Template-based performance infographic dashboard (full width, bootstrap-like container-fluid) */
      .perf-dashboard {
        width: 100%;
        padding: 0;
        --accent-primary:   #c07830;
        --accent-secondary: #3a64a8;
        --accent-positive:  #3a7850;
        --accent-warn:      #a85040;
        --accent-gold:      #a88030;
        --perf-font-display: "Unbounded", Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
        --perf-font-head: "Open Sans", "Segoe UI", sans-serif;
        --perf-font-body: "Barlow Condensed", "Roboto Condensed", "Segoe UI", sans-serif;
        --perf-font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-family: var(--perf-font-body);
      }
      .perf-dashboard[data-theme="dark"] {
        --bg-page:        #0e1420;
        --bg-wrap:        #0e1420;
        --bg-card:        #141c2e;
        --bg-bar-track:   rgba(255,255,255,0.06);
        --bg-inset:       rgba(0,0,0,0.22);
        --border-color:   rgba(255,255,255,0.07);
        --border-accent:  rgba(255,255,255,0.13);
        --text-primary:   #ccd4e4;
        --text-secondary: #7a8aa4;
        --text-muted:     #3e4e68;
        --header-bg:      #0a1020;
        --header-border:  #c07830;
        --h3-bg-orange:   rgba(160,100,30,0.22);
        --h3-bg-blue:     rgba(40,70,130,0.28);
        --h3-bg-dark:     rgba(255,255,255,0.04);
        --canvas-grid:    rgba(255,255,255,0.055);
        --canvas-text:    rgba(180,195,220,0.45);
        --takeaway-bg:    rgba(10,18,38,0.85);
        --takeaway-border:#c07830;
        --sweet-fill:     rgba(60,130,80,0.06);
        --sweet-text:     rgba(80,150,100,0.5);
        --dot-stroke:     rgba(255,255,255,0.55);
        --pt-label:       rgba(210,222,240,0.8);
        --stars-opacity:  1;
      }
      .perf-dashboard[data-theme="light"] {
        --bg-page:        #ddd5c0;
        --bg-wrap:        #e8dfc8;
        --bg-card:        #f2ebe0;
        --bg-bar-track:   rgba(0,0,0,0.07);
        --bg-inset:       rgba(0,0,0,0.04);
        --border-color:   rgba(0,0,0,0.09);
        --border-accent:  rgba(0,0,0,0.16);
        --text-primary:   #1c2840;
        --text-secondary: #3a4e6a;
        --text-muted:     #8898b0;
        --header-bg:      #1a2b54;
        --header-border:  #c07830;
        --h3-bg-orange:   rgba(160,90,20,0.12);
        --h3-bg-blue:     rgba(30,60,120,0.10);
        --h3-bg-dark:     rgba(20,35,65,0.07);
        --canvas-grid:    rgba(0,0,0,0.07);
        --canvas-text:    rgba(25,45,85,0.45);
        --takeaway-bg:    rgba(235,225,208,0.95);
        --takeaway-border:#c07830;
        --sweet-fill:     rgba(40,110,60,0.05);
        --sweet-text:     rgba(30,100,55,0.45);
        --dot-stroke:     rgba(255,255,255,0.85);
        --pt-label:       rgba(18,40,80,0.8);
        --stars-opacity:  0;
      }
      .perf-dashboard .infographic-wrapper {
        width: 100%;
        max-width: none;
        margin: 0;
        background: var(--bg-wrap);
        position: relative;
        overflow: hidden;
        border-radius: 14px;
        border: 1px solid var(--border-color);
        box-shadow: var(--llm-shadow);
      }
      .perf-dashboard .stars {
        position: absolute; inset: 0; opacity: var(--stars-opacity); pointer-events: none; z-index: 0;
        background-image:
          radial-gradient(1px 1px at  8%  4%, rgba(255,255,255,0.35) 0%, transparent 100%),
          radial-gradient(1px 1px at 28% 11%, rgba(255,255,255,0.22) 0%, transparent 100%),
          radial-gradient(1px 1px at 57%  7%, rgba(255,255,255,0.30) 0%, transparent 100%),
          radial-gradient(1px 1px at 81%  9%, rgba(255,255,255,0.35) 0%, transparent 100%),
          radial-gradient(1px 1px at 43% 19%, rgba(255,255,255,0.18) 0%, transparent 100%),
          radial-gradient(1px 1px at 71% 23%, rgba(255,255,255,0.25) 0%, transparent 100%),
          radial-gradient(1px 1px at 17% 32%, rgba(255,255,255,0.22) 0%, transparent 100%);
      }
      .perf-dashboard .content { position: relative; z-index: 1; }
      .perf-dashboard .header-section {
        background: var(--header-bg);
        padding: 17px 22px 13px;
        border-bottom: 3px solid var(--header-border);
        display: flex; align-items: center; gap: 16px;
      }
      .perf-dashboard .header-mascot { font-size: 54px; line-height: 1; }
      .perf-dashboard .header-text h1 {
        font-family: var(--perf-font-display);
        font-size: 2.35rem;
        font-weight: 400;
        line-height: 1.02;
        letter-spacing: 1px;
        color: #e2d8c8;
      }
      .perf-dashboard[data-theme="light"] .header-text h1 { color: #efe2cf; }
      .perf-dashboard .header-text p {
        font-family: var(--perf-font-body);
        font-size: .92rem; color: rgba(200,192,178,0.78); margin-top: 4px; font-style: italic;
      }
      .perf-dashboard .header-meta {
        margin-left: auto; text-align: right; color: rgba(180,192,210,0.75); font-size: .85rem; line-height: 1.6;
        font-family: var(--perf-font-mono);
      }
      .perf-dashboard .header-meta-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(120px, auto));
        gap: 6px 12px;
        align-items: start;
      }
      .perf-dashboard .header-meta-item {
        display: grid;
        gap: 1px;
        justify-items: end;
      }
      .perf-dashboard .header-meta-item span {
        font-size: .85rem;
        text-transform: uppercase;
        letter-spacing: .07em;
        color: rgba(180,192,210,0.75);
      }
      .perf-dashboard .header-meta-item b {
        font-size: .85rem;
        font-weight: 600;
        color: #ffffff;
        white-space: nowrap;
      }
      .perf-dashboard .section-divider { height: 2px; background: linear-gradient(90deg, transparent, rgba(192,120,48,0.4), transparent); }
      .perf-dashboard .main-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        padding: 10px;
        align-items: stretch;
      }
      .perf-dashboard .main-grid > * {
        min-width: 0;
        flex: 1 1 calc(50% - 5px);
      }
      .perf-dashboard .full-width { flex-basis: 100% !important; width: 100%; }
      .perf-dashboard .main-grid > .best-class-row { flex-basis: 100%; width: 100%; }
      .perf-dashboard .main-grid > .card-panel[data-panel="size-speed-responsiveness"] { flex-basis: 100%; width: 100%; }
      .perf-dashboard .main-grid > .card-panel[data-panel="punching-above-weight"] { flex-basis: 100%; width: 100%; }
      .perf-dashboard .main-grid > .card-panel[data-panel="latency-stability"] { flex-basis: 100%; width: 100%; }
      .perf-dashboard .main-grid > .card-panel[data-panel="model-personality"] { flex-basis: 100%; width: 100%; }
      .perf-dashboard .main-grid > .best-class-row { order: 10; }
      .perf-dashboard .main-grid > .card-panel[data-panel="ttft"] { order: 20; }
      .perf-dashboard .main-grid > .card-panel[data-panel="tps"] { order: 30; }
      .perf-dashboard .main-grid > .card-panel[data-panel="size-speed-responsiveness"] { order: 40; }
      .perf-dashboard .main-grid > .card-panel[data-panel="punching-above-weight"] { order: 50; }
      .perf-dashboard .main-grid > .card-panel[data-panel="quick-off-the-line"] { order: 60; }
      .perf-dashboard .main-grid > .card-panel[data-panel="latency-anatomy"] { order: 70; }
      .perf-dashboard .main-grid > .card-panel[data-panel="size-efficiency"] { order: 80; }
      .perf-dashboard .main-grid > .card-panel[data-panel="model-personality"] { order: 90; }
      .perf-dashboard .main-grid > .card-panel[data-panel="document-ingestion-efficiency"] { order: 100; }
      .perf-dashboard .main-grid > .card-panel[data-panel="vision-tax"] { order: 110; }
      .perf-dashboard .main-grid > .card-panel[data-panel="latency-stability"] { order: 120; }
      .perf-dashboard .best-class-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
      }
      .perf-dashboard .best-class-card {
        background: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 9px 10px;
        box-shadow: inset 0 0 0 1px rgba(192,120,48,0.06);
      }
      .perf-dashboard .best-class-kicker {
        font-size: 1rem;
        font-weight: 600;
        color: var(--accent-primary);
        text-transform: uppercase;
        letter-spacing: .06em;
        margin-bottom: 5px;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .best-class-model {
        font-size: .9rem;
        font-weight: 800;
        color: var(--text-primary);
        line-height: 1.2;
        white-space: normal;
        overflow-wrap: anywhere;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .best-class-metric {
        margin-top: 2px;
        font-size: .9rem;
        font-weight: 700;
        color: var(--accent-secondary);
        font-family: var(--perf-font-mono);
      }
      .perf-dashboard .best-class-note {
        margin-top: 4px;
        font-size: .9rem;
        color: var(--text-secondary);
        line-height: 1.25;
        min-height: 1.1em;
        font-family: var(--perf-font-body);
      }
      .perf-dashboard .best-class-subtext {
        margin-top: 5px;
        font-size: .72rem;
        color: var(--text-muted);
        line-height: 1.35;
        font-family: var(--perf-font-body);
      }
      .perf-dashboard .best-class-section {
        margin-top: 5px;
        margin-bottom: 5px;
        font-size: 1rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: .05em;
        line-height: 1.2;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .card-panel {
        background: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px;
        color: var(--text-primary);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
      }
      .perf-dashboard .card-panel.tone-orange {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 14%, transparent);
        background: linear-gradient(180deg, color-mix(in srgb, var(--accent-primary) 6%, var(--bg-card)), var(--bg-card) 22%);
      }
      .perf-dashboard .card-panel.tone-blue {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-secondary) 16%, transparent);
        background: linear-gradient(180deg, color-mix(in srgb, var(--accent-secondary) 7%, var(--bg-card)), var(--bg-card) 22%);
      }
      .perf-dashboard .card-panel.tone-dark {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 8%, transparent);
        background: linear-gradient(180deg, color-mix(in srgb, var(--header-bg) 22%, var(--bg-card)), var(--bg-card) 24%);
      }
      .perf-dashboard .card-panel h3 {
        font-size: .82rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 1px;
        padding: 5px 9px;
        margin-bottom: 10px;
        border-radius: 4px;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .orange-header { background: color-mix(in srgb, var(--h3-bg-orange) 72%, transparent); color: var(--accent-primary); border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent); border-left: 4px solid var(--accent-primary); }
      .perf-dashboard .blue-header { background: color-mix(in srgb, var(--h3-bg-blue) 78%, transparent); color: var(--accent-secondary); border: 1px solid color-mix(in srgb, var(--accent-secondary) 28%, transparent); border-left: 4px solid var(--accent-secondary); }
      .perf-dashboard .dark-header { background: color-mix(in srgb, var(--h3-bg-dark) 92%, transparent); color: var(--text-primary); border: 1px solid color-mix(in srgb, var(--text-primary) 12%, var(--border-color)); border-left: 4px solid var(--accent-primary); }
      .perf-dashboard .sub-label { font-size: .74rem; color: var(--text-muted); margin-bottom: 8px; font-family: var(--perf-font-body); }
      .perf-dashboard .speed-bar-container { margin: 4px 0; }
      .perf-dashboard .speed-bar-label { font-size: .78rem; color: var(--text-secondary); display: flex; justify-content: space-between; gap: 8px; margin-bottom: 2px; font-family: var(--perf-font-body); }
      .perf-dashboard .speed-bar-label > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .perf-dashboard .val, .perf-dashboard .val-blue, .perf-dashboard .val-green, .perf-dashboard .val-warn { font-weight: 700; }
      .perf-dashboard .val, .perf-dashboard .val-blue, .perf-dashboard .val-green, .perf-dashboard .val-warn,
      .perf-dashboard .speed-bar-fill,
      .perf-dashboard .vision-pct, .perf-dashboard .big-num,
      .perf-dashboard .consistency-value,
      .perf-dashboard .best-class-metric {
        font-family: var(--perf-font-mono);
      }
      .perf-dashboard .val { color: var(--accent-primary); }
      .perf-dashboard .val-blue { color: var(--accent-secondary); }
      .perf-dashboard .val-green { color: var(--accent-positive); }
      .perf-dashboard .val-warn { color: var(--accent-warn); }
      .perf-dashboard .speed-bar { height: 17px; border-radius: 3px; background: var(--bg-bar-track); overflow: hidden; }
      .perf-dashboard .speed-bar-fill {
        height: 100%; border-radius: 3px; display: flex; align-items: center; padding-left: 5px;
        font-size: .63rem; font-weight: 700; color: rgba(255,255,255,.9); opacity: .85;
        white-space: nowrap; overflow: hidden;
      }
      .perf-dashboard .color-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; opacity:.8; flex-shrink:0; }
      .perf-dashboard .takeaway {
        background: var(--takeaway-bg);
        border: 1px solid var(--border-color);
        border-left: 3px solid var(--takeaway-border);
        border-radius: 5px;
        padding: 7px 11px;
        margin-top: 9px;
        font-size: .73rem;
        color: var(--text-secondary);
        font-family: var(--perf-font-body);
      }
      .perf-dashboard .takeaway strong { color: var(--accent-primary); letter-spacing: .4px; font-family: var(--perf-font-head); }
      .perf-dashboard .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
      .perf-dashboard .vision-box, .perf-dashboard .stat-highlight {
        text-align: center; padding: 9px 7px; background: var(--bg-inset); border-radius: 5px; border: 1px solid var(--border-color);
      }
      .perf-dashboard .vision-pct, .perf-dashboard .big-num {
        font-size: 1.45rem; line-height: 1.05; letter-spacing: .5px; color: var(--accent-primary); font-weight: 800;
      }
      .perf-dashboard .vision-name, .perf-dashboard .stat-lbl { font-size: .66rem; color: var(--text-muted); margin-top: 2px; line-height: 1.25; font-family: var(--perf-font-body); }
      .perf-dashboard .vision-delta { font-size: .62rem; color: var(--accent-warn); margin-top: 2px; font-family: var(--perf-font-body); }
      .perf-dashboard .consistency-row { display:flex; align-items:center; gap:6px; margin:3px 0; }
      .perf-dashboard .consistency-name { width: 150px; flex-shrink:0; font-size:.72rem; color:var(--text-secondary); display:flex; align-items:center; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family: var(--perf-font-body); }
      .perf-dashboard .consistency-bar-bg { flex:1; height:13px; background:var(--bg-bar-track); border-radius:3px; overflow:hidden; }
      .perf-dashboard .consistency-bar-fill { height:100%; border-radius:3px; opacity:.78; }
      .perf-dashboard .consistency-value { width:54px; text-align:right; font-size:.66rem; font-weight:700; }
      .perf-dashboard .chart-container { background: var(--bg-inset); border-radius: 5px; overflow: hidden; border:1px solid var(--border-color); }
      .perf-dashboard .frontier-grid { display:grid; grid-template-columns: 2fr 1fr; gap: 12px; }
      .perf-dashboard .frontier-chart { height: 220px; }
      .perf-dashboard .perf-scatter-svg { width: 100%; height: 100%; display: block; }
      .perf-dashboard .scatter-grid { stroke: var(--canvas-grid); stroke-width: 1; }
      .perf-dashboard .scatter-axis { stroke: var(--canvas-text); stroke-width: 1.2; }
      .perf-dashboard .scatter-frontier-zone {
        fill: color-mix(in srgb, var(--accent-positive) 10%, transparent);
        stroke: color-mix(in srgb, var(--accent-positive) 30%, transparent);
        stroke-width: 1;
        stroke-dasharray: 4 4;
      }
      .perf-dashboard .scatter-frontier-label {
        fill: color-mix(in srgb, var(--accent-positive) 70%, var(--text-secondary));
        font-size: 11px;
        font-family: var(--perf-font-head);
        font-weight: 700;
        letter-spacing: .02em;
      }
      .perf-dashboard .scatter-tick { fill: var(--canvas-text); font-size: 11px; font-family: var(--perf-font-mono); font-weight: 500; }
      .perf-dashboard .scatter-axis-label { fill: var(--canvas-text); font-size: 12px; font-family: var(--perf-font-head); font-weight: 600; }
      .perf-dashboard .scatter-dot { stroke: var(--dot-stroke); stroke-width: .8; }
      .perf-dashboard .scatter-bubble { opacity: .22; }
      .perf-dashboard .scatter-trendline {
        fill: none;
        stroke: color-mix(in srgb, var(--accent-primary) 76%, var(--text-primary));
        stroke-width: 1.6;
        stroke-dasharray: 5 4;
      }
      .perf-dashboard .scatter-label { fill: var(--pt-label); font-size: 11px; font-weight: 700; font-family: var(--perf-font-body); }
      .perf-dashboard .legend-title { font-size:.82rem; font-weight:800; color:var(--accent-primary); margin-bottom:6px; letter-spacing:.6px; font-family: var(--perf-font-head); }
      .perf-dashboard .legend-item { display:flex; align-items:center; gap:6px; font-size:.74rem; color:var(--text-secondary); margin:2px 0; line-height:1.3; font-family: var(--perf-font-body); }
      .perf-dashboard .legend-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; opacity:.85; }
      .perf-dashboard .radar-wrap { display:grid; gap: 14px; }
      .perf-dashboard .radar-grid { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: stretch; }
      .perf-dashboard .radar-card {
        background: var(--bg-inset);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        padding: 10px;
      }
      .perf-dashboard .radar-card-head {
        display:flex;
        justify-content:space-between;
        gap: 10px;
        align-items:center;
        margin-bottom: 8px;
      }
      .perf-dashboard .radar-card-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-primary);
        font-size: .8rem;
        font-weight: 700;
      }
      .perf-dashboard .radar-card-meta {
        color: var(--text-muted);
        font-size: .66rem;
        text-transform: uppercase;
        letter-spacing: .06em;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .radar-svg { width: 100%; height: auto; display: block; }
      .perf-dashboard .radar-ring { fill: rgba(255,255,255,0.02); stroke: var(--canvas-grid); stroke-width: 1; }
      .perf-dashboard .radar-axis { stroke: var(--canvas-grid); stroke-width: 1; }
      .perf-dashboard .radar-label { fill: var(--text-secondary); font-size: 10px; font-family: var(--perf-font-head); }
      .perf-dashboard .radar-shape { fill-opacity: .18; stroke: rgba(255,255,255,.8); stroke-width: 1.2; }
      .perf-dashboard .radar-note { margin-top: 8px; }
      .perf-dashboard .radar-stats {
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px 10px;
        margin-top: 8px;
      }
      .perf-dashboard .radar-stats span {
        display:block;
        color: var(--text-muted);
        font-size: .6rem;
        text-transform: uppercase;
        letter-spacing: .06em;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .radar-stats b {
        display:block;
        color: var(--text-primary);
        font-size: .72rem;
        font-family: var(--perf-font-mono);
      }
      .perf-dashboard .bullet-interpret,
      .perf-dashboard .radar-interpret {
        margin-top: 6px;
        color: var(--text-muted);
        font-size: .69rem;
        line-height: 1.35;
      }
      .perf-dashboard .bullet-list, .perf-dashboard .dumbbell-list, .perf-dashboard .box-list { display: grid; gap: 10px; }
      .perf-dashboard .bullet-row, .perf-dashboard .dumbbell-row, .perf-dashboard .box-row {
        background: var(--bg-inset);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 9px 10px;
      }
      .perf-dashboard .bullet-head, .perf-dashboard .bullet-foot { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      .perf-dashboard .bullet-name, .perf-dashboard .box-name, .perf-dashboard .dumbbell-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
        font-size: .74rem;
      }
      .perf-dashboard .bullet-meta, .perf-dashboard .bullet-foot, .perf-dashboard .box-value, .perf-dashboard .waterfall-value {
        font-family: var(--perf-font-mono);
        font-size: .68rem;
      }
      .perf-dashboard .bullet-track, .perf-dashboard .box-track, .perf-dashboard .waterfall-track {
        position: relative;
        height: 16px;
        border-radius: 999px;
        background: var(--bg-bar-track);
        border: 1px solid var(--border-color);
        overflow: hidden;
        margin: 7px 0 5px;
      }
      .perf-dashboard .bullet-band {
        position:absolute;
        inset: 0;
        background: linear-gradient(90deg, rgba(255,255,255,0.02), rgba(255,255,255,0.08), rgba(255,255,255,0.02));
      }
      .perf-dashboard .bullet-bar {
        position:absolute;
        left:0;
        top:1px;
        bottom:1px;
        border-radius: 999px;
        opacity: .9;
      }
      .perf-dashboard .bullet-marker, .perf-dashboard .box-median {
        position:absolute;
        top:-1px;
        bottom:-1px;
        width: 2px;
        background: var(--accent-primary);
      }
      .perf-dashboard .bullet-foot { color: var(--text-muted); }
      .perf-dashboard .dumbbell-scale, .perf-dashboard .waterfall-summary {
        display:flex;
        justify-content:space-between;
        gap: 8px;
        color: var(--text-muted);
        font-size: .68rem;
        margin-bottom: 6px;
      }
      .perf-dashboard .dumbbell-row {
        display:grid;
        grid-template-columns: 150px 1fr 72px;
        gap: 10px;
        align-items: center;
      }
      .perf-dashboard .dumbbell-track {
        position: relative;
        height: 22px;
      }
      .perf-dashboard .dumbbell-line {
        position:absolute;
        top: 10px;
        height: 2px;
        background: color-mix(in srgb, var(--accent-secondary) 40%, var(--accent-primary));
      }
      .perf-dashboard .dumbbell-point {
        position:absolute;
        top: 4px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        transform: translateX(-50%);
        border: 2px solid rgba(255,255,255,.75);
      }
      .perf-dashboard .dumbbell-point.end {
        width: 12px;
        height: 12px;
        top: 5px;
        border-color: rgba(0,0,0,.18);
      }
      .perf-dashboard .dumbbell-values {
        display:flex;
        justify-content:space-between;
        gap: 6px;
        font-family: var(--perf-font-mono);
        font-size: .68rem;
        color: var(--text-secondary);
      }
      .perf-dashboard .waterfall-shell { display:grid; gap: 8px; }
      .perf-dashboard .waterfall-stage {
        display:grid;
        grid-template-columns: 160px 1fr 76px;
        gap: 10px;
        align-items:center;
      }
      .perf-dashboard .waterfall-label { font-size: .74rem; color: var(--text-secondary); }
      .perf-dashboard .waterfall-bar {
        position:absolute;
        top:1px;
        bottom:1px;
        border-radius: 999px;
        opacity: .92;
      }
      .perf-dashboard .box-track { height: 18px; }
      .perf-dashboard .box-whisker {
        position:absolute;
        top: 8px;
        height: 2px;
        background: var(--text-muted);
      }
      .perf-dashboard .box-rect {
        position:absolute;
        top: 3px;
        bottom: 3px;
        border-radius: 4px;
        opacity: .8;
      }
      .perf-dashboard .doc-ingestion-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .perf-dashboard .doc-subpanel {
        background: var(--bg-inset);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 9px;
      }
      .perf-dashboard .doc-subpanel-title {
        color: var(--accent-primary);
        font-size: .76rem;
        font-weight: 800;
        letter-spacing: .05em;
        text-transform: uppercase;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .doc-subpanel-sub {
        color: var(--text-muted);
        font-size: .66rem;
        line-height: 1.25;
        margin: 4px 0 7px;
        font-family: var(--perf-font-body);
      }
      .perf-dashboard .doc-metric-row { margin: 5px 0 8px; }
      .perf-dashboard .doc-row-head {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap: 8px;
        font-size: .72rem;
        margin-bottom: 3px;
      }
      .perf-dashboard .doc-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
        font-family: var(--perf-font-body);
      }
      .perf-dashboard .doc-value {
        flex-shrink: 0;
        color: var(--text-primary);
        font-weight: 700;
        font-size: .68rem;
        font-family: var(--perf-font-mono);
      }
      .perf-dashboard .doc-track {
        height: 10px;
        border-radius: 999px;
        background: var(--bg-bar-track);
        overflow: hidden;
        border: 1px solid var(--border-color);
      }
      .perf-dashboard .doc-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--accent-primary);
        opacity: .9;
      }
      .perf-dashboard .doc-fill.good { background: var(--accent-positive); }
      .perf-dashboard .doc-fill.mid { background: var(--accent-gold); }
      .perf-dashboard .doc-fill.warn { background: var(--accent-warn); }
      .perf-dashboard .doc-fill.blue { background: var(--accent-secondary); }
      .perf-dashboard .doc-fill.neutral { background: color-mix(in srgb, var(--text-secondary) 65%, transparent); }
      .perf-dashboard .doc-fill.disabled {
        background: color-mix(in srgb, var(--text-muted) 45%, transparent);
        opacity: .45;
      }
      .perf-dashboard .doc-meta {
        margin-top: 3px;
        color: var(--text-muted);
        font-size: .62rem;
        line-height: 1.2;
        font-family: var(--perf-font-body);
      }
      .perf-dashboard .doc-track.disabled {
        border-style: dashed;
        opacity: .75;
      }
      .perf-dashboard .doc-metric-row.is-disabled .doc-name,
      .perf-dashboard .doc-metric-row.is-disabled .doc-value,
      .perf-dashboard .doc-metric-row.is-disabled .doc-dual-value {
        color: var(--text-muted);
      }
      .perf-dashboard .doc-delta-track {
        position: relative;
        height: 12px;
        border-radius: 4px;
        background: var(--bg-bar-track);
        border: 1px solid var(--border-color);
        overflow: hidden;
      }
      .perf-dashboard .doc-delta-zero {
        position:absolute;
        left:50%;
        top:0;
        bottom:0;
        width:1px;
        background: var(--border-accent);
      }
      .perf-dashboard .doc-delta-fill {
        position:absolute;
        top:1px;
        bottom:1px;
        border-radius: 3px;
        opacity: .92;
        background: var(--accent-gold);
      }
      .perf-dashboard .doc-delta-fill.good { background: var(--accent-positive); }
      .perf-dashboard .doc-delta-fill.mid { background: var(--accent-gold); }
      .perf-dashboard .doc-delta-fill.warn { background: var(--accent-warn); }
      .perf-dashboard .doc-delta-fill.disabled {
        background: color-mix(in srgb, var(--text-muted) 40%, transparent);
        opacity: .5;
      }
      .perf-dashboard .doc-delta-track.disabled { opacity: .75; border-style: dashed; }
      .perf-dashboard .doc-dual-bars { display:grid; gap: 3px; }
      .perf-dashboard .doc-dual-line {
        display:grid;
        grid-template-columns: 28px 1fr 44px;
        gap: 6px;
        align-items: center;
      }
      .perf-dashboard .doc-dual-label {
        font-size: .62rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: .04em;
        font-family: var(--perf-font-head);
      }
      .perf-dashboard .doc-dual-value {
        text-align: right;
        font-size: .62rem;
        color: var(--text-secondary);
        font-family: var(--perf-font-mono);
      }
      .perf-dashboard .stability-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .perf-dashboard .stab-title { font-size:.78rem; font-weight:700; margin-bottom:6px; letter-spacing:.4px; font-family: var(--perf-font-head); }
      .perf-dashboard .stab-title.good { color: var(--accent-positive); }
      .perf-dashboard .stab-title.bad { color: var(--accent-warn); }
      .perf-dashboard .footer-section {
        background: var(--header-bg);
        padding: 13px 16px;
        border-top: 2px solid var(--header-border);
        text-align: center;
      }
      .perf-dashboard .footer-section p { font-size: .72rem; color: rgba(190,200,215,0.45); font-family: var(--perf-font-body); }
      .perf-dashboard .llama-row { font-size: 1.2rem; margin-top: 5px; letter-spacing: 4px; }
      @media (max-width: 900px) {
        .llm-controls { grid-template-columns: 1fr; }
        .ig4-layout { grid-template-columns: 1fr; }
        .ig4-grid { grid-template-columns: 1fr; }
        .ig2-grid { grid-template-columns: 1fr; }
        .ig3-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .ig5-header { grid-template-columns: 1fr; }
        .ig5-finding { width: auto; }
        .perf-dashboard .main-grid > * { flex-basis: 100%; }
        .perf-dashboard .best-class-row { grid-template-columns: 1fr; }
        .perf-dashboard .frontier-grid { grid-template-columns: 1fr; }
        .perf-dashboard .radar-grid { grid-template-columns: 1fr; }
        .perf-dashboard .doc-ingestion-grid { grid-template-columns: 1fr; }
        .perf-dashboard .stability-grid { grid-template-columns: 1fr; }
        .perf-dashboard .dumbbell-row,
        .perf-dashboard .waterfall-stage,
        .perf-dashboard .box-row { grid-template-columns: 1fr; }
      }
      @media (max-width: 720px) {
        .ig-card-row { grid-template-columns: 1fr; }
        .ig-row-total { text-align: left; }
        .ig-head { flex-direction: column; }
        .ig3-header { flex-direction: column; align-items: start; }
        .ig3-tag { text-align: left; max-width: none; }
        .perf-dashboard .header-section { flex-wrap: wrap; align-items: flex-start; }
        .perf-dashboard .header-meta { margin-left: 0; text-align: left; width: 100%; }
        .perf-dashboard .header-meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .perf-dashboard .header-meta-item { justify-items: start; }
        .perf-dashboard .two-col-grid { grid-template-columns: 1fr; }
        .perf-dashboard .consistency-name { width: 120px; }
      }
    </style>
    <button class="llm-tab" id="llm-tab">^ Aggregate UI Metrics</button>
    <div class="llm-overlay" id="llm-overlay">
      <div class="llm-backdrop" id="llm-backdrop"></div>
      <div class="llm-panel">
        <div class="llm-header">
          <div class="llm-title">Metrics Dashboard</div>
          <div class="llm-header-actions">
            <button class="llm-btn" id="llm-theme">Dark</button>
            <button class="llm-btn" id="llm-export-jsonl">Export JSONL</button>
            <button class="llm-btn" id="llm-export-png">Export PNG</button>
            <button class="llm-btn" id="llm-refresh">Refresh</button>
            <button class="llm-btn" id="llm-minimize"><span style="font-size: 1em;">\u2716</span>&nbsp; Close</button>
          </div>
        </div>
        <div class="llm-body">
          <div class="llm-status" id="llm-status"></div>
          <div class="llm-summary" id="llm-summary"></div>
          <div class="llm-controls">
            <select id="llm-input-mode" class="llm-select"></select>
            <div class="llm-model-filter">
              <button id="llm-model-filter-toggle" class="llm-select llm-model-filter-btn" type="button" aria-expanded="false">Model Filters (All)</button>
              <div id="llm-model-filter-panel" class="llm-model-filter-panel" hidden>
                <div id="llm-model-toggles" class="llm-toggle-wrap llm-toggle-wrap-compact"></div>
              </div>
            </div>
          </div>
          <div id="llm-best-cards"></div>
        </div>
      </div>
    </div>
  `;

  const tab = root.getElementById("llm-tab");
  const overlay = root.getElementById("llm-overlay");
  const backdrop = root.getElementById("llm-backdrop");
  const minimize = root.getElementById("llm-minimize");
  const refresh = root.getElementById("llm-refresh");
  const exportJsonl = root.getElementById("llm-export-jsonl");
  const exportPng = root.getElementById("llm-export-png");
  const themeToggle = root.getElementById("llm-theme");
  const inputMode = root.getElementById("llm-input-mode");
  const modelFilterToggle = root.getElementById("llm-model-filter-toggle");
  const modelFilterPanel = root.getElementById("llm-model-filter-panel");
  const modelToggles = root.getElementById("llm-model-toggles");

  __dashboardState.mounted = true;
  __dashboardState.elements = {
    root,
    host,
    tab,
    overlay,
    backdrop,
    minimize,
    refresh,
    exportJsonl,
    exportPng,
    themeToggle,
    status: root.getElementById("llm-status"),
    summary: root.getElementById("llm-summary"),
    bestCards: root.getElementById("llm-best-cards"),
    inputMode,
    modelFilterToggle,
    modelFilterPanel,
    modelToggles
  };

  tab.addEventListener("click", openDashboardOverlay);
  backdrop.addEventListener("click", minimizeDashboardOverlay);
  minimize.addEventListener("click", minimizeDashboardOverlay);
  refresh.addEventListener("click", () => refreshDashboard("refresh_button"));
  exportJsonl.addEventListener("click", async () => {
    setDashboardStatus("Exporting JSONL...");
    const res = await safeSendMessage({ type: "export_active" });
    if (!res?.ok) {
      setDashboardStatus(`Export failed: ${res?.error || "unknown error"}`);
      return;
    }
    setDashboardStatus("Exported JSONL (check downloads).");
  });
  exportPng.addEventListener("click", () => {
    exportDashboardPng().catch(() => {});
  });
  inputMode.addEventListener("change", () => {
    __dashboardState.selectedInputMode = inputMode.value || "all";
    if (__dashboardState.lastStats) renderDashboard(__dashboardState.lastStats);
  });
  modelFilterToggle.addEventListener("click", () => {
    const isOpen = !modelFilterPanel.hidden;
    setModelFilterOpen(!isOpen);
  });
  modelToggles.addEventListener("change", (event) => {
    const t = event.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "checkbox") return;
    const model = t.getAttribute("data-model");
    if (!model) return;
    if (t.checked) __dashboardState.selectedModels.add(model);
    else __dashboardState.selectedModels.delete(model);
    if (!__dashboardState.selectedModels.size) __dashboardState.selectedModels.add(model);
    updateModelFilterLabel();
    if (__dashboardState.lastStats) renderDashboard(__dashboardState.lastStats);
  });
  themeToggle.addEventListener("click", async () => {
    const next = __dashboardState.theme === "dark" ? "light" : "dark";
    applyDashboardTheme(next);
    await saveDashboardTheme(next);
  });

  applyDashboardTheme("light");

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && __dashboardState.overlayOpen) {
      minimizeDashboardOverlay();
    }
  }, true);
  window.addEventListener("resize", () => {
    if (!__dashboardState.overlayOpen) return;
    adjustPerfFrontierChartHeight(root);
    const stats = __dashboardState.lastStats;
    const baseRecords = Array.isArray(stats?.records_compact) ? stats.records_compact : [];
    const mode = __dashboardState.selectedInputMode || "all";
    const filteredByMode = mode === "all" ? baseRecords : baseRecords.filter((r) => (r?.input_mode || "unknown") === mode);
    const selectedModels = new Set(Array.from(__dashboardState.selectedModels));
    const filtered = filteredByMode.filter((r) => selectedModels.has(r.model));
    rerenderPerfFrontierScatter(root, filtered);
  });
}

/**
 * Install Bridge Listeners.
 */
function installBridgeListeners() {
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "LLAMACPP_PROBE") {
      probeLog("injected_probe", msg.payload || {});
      return;
    }

    if (msg.type === "LLAMACPP_INJECT_READY") {
      probeLog("inject_ready_message");
      await debugLog("Injected script ready signal received");
      await syncDebugToPage("inject.ready");
      return;
    }

    if (msg.type === "LLAMACPP_METRICS_RECORD") {
      const traceId = msg.record?.trace_id || "no-trace";
      await debugLog(`Forwarding record [trace ${traceId}]`, msg.record);
      try {
        const res = await safeSendMessage({
          type: "record",
          record: msg.record
        });
        if (res?.ok) {
          await debugLog(`Record stored [trace ${traceId}]`, {
            session_id: res.session_id || null,
            key: res.key || null,
            chain_id: res.chain_id || null,
            turn_number: Number.isFinite(res.turn_number) ? res.turn_number : null
          });
          probeLog("record_store_ok", {
            trace_id: traceId,
            session_id: res.session_id || null,
            key: res.key || null,
            chain_id: res.chain_id || null,
            turn_number: Number.isFinite(res.turn_number) ? res.turn_number : null
          });
        } else {
          await debugLog(`Record store failed [trace ${traceId}]`, { response: res || null });
          probeLog("record_store_failed", {
            trace_id: traceId,
            error: res?.error || "no_response_or_not_ok"
          });
        }
      } catch (e) {
        await debugLog(`Failed to forward record [trace ${traceId}]`, String(e?.message || e));
        probeLog("record_forward_error", {
          trace_id: traceId,
          error: String(e?.message || e)
        });
      }
      scheduleDashboardRefresh("new_record");
    }
  });
}

/**
 * Start Capture.
 */
function startCapture() {
  if (__captureStarted) return;
  __captureStarted = true;

  probeLog("content_start", { host: location.host });
  mountDashboardUi();
  injectInjectedScript();
  installContentProbeListeners();
  installBridgeListeners();
  probeLog("content_capture_started", { host: location.host });

  syncDebugToPage("content.startup");
}

/**
 * Maybe Start Capture.
 */
async function maybeStartCapture(reason) {
  if (__captureStarted) return;
  if (await isCurrentHostAllowed()) {
    startCapture();
    await debugLog("Capture enabled on host", { host: location.host, reason });
  } else {
    await debugLog("Host not allowlisted; capture idle", { host: location.host, reason });
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.debug_enabled) {
    __probeDebugEnabled = Boolean(changes.debug_enabled.newValue);
    if (__captureStarted) {
      probeLog("debug_storage_changed", { enabled: __probeDebugEnabled });
      sendDebugFlagToPage(__probeDebugEnabled, "storage.onChanged");
    }
  }

  if (changes[ALLOWED_DOMAINS_KEY]) {
    maybeStartCapture("allowed_domains_changed");
  }
});

(async () => {
  const { debug_enabled } = await chrome.storage.local.get(["debug_enabled"]);
  __probeDebugEnabled = Boolean(debug_enabled);
  await maybeStartCapture("startup");
})();

