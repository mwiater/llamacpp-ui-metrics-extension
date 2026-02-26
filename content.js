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
  const rows = Array.from(by.entries()).map(([model, arr], idx) => {
    const ttftVals = arr.map((r) => toFiniteNumber(r.ttft_ms)).filter((x) => x !== null);
    const tpsVals = arr.map((r) => toFiniteNumber(r.predicted_tps)).filter((x) => x !== null);
    const promptTpsVals = arr.map((r) => toFiniteNumber(r.prompt_tps)).filter((x) => x !== null);
    const reasoningShares = arr.map((r) => {
      const rn = igSafeNum(r.reasoning_n, 0);
      const cn = igSafeNum(r.content_n, 0) || igSafeNum(r.predicted_n, 0);
      const d = rn + cn;
      return d > 0 ? (rn / d) * 100 : null;
    }).filter((x) => typeof x === "number");
    const isVision = arr.some((r) => r.has_images) || /vision|vl/i.test(model);
    return {
      model,
      short: shortenModelName(model.replace(/-Q\d.*$/i, ""), 18),
      count: arr.length,
      ttft: median(ttftVals),
      ttftAvg: avgOf(ttftVals),
      ttftStd: stdDev(ttftVals),
      tps: median(tpsVals),
      promptTps: median(promptTpsVals),
      reasoningPct: reasoningShares.length ? avgOf(reasoningShares) : 0,
      params: parseParamsBillions(model),
      vision: isVision,
      color: perfColorByIndex(idx)
    };
  });
  return rows.sort((a, b) => (a.model || "").localeCompare(b.model || ""));
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
 * Perf Build Document Ingestion Rows.
 */
function perfBuildDocumentIngestionRows(records) {
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
    const fileRows = arr.filter((r) => {
      const mode = String(r?.input_mode || "");
      const legacyFallback = (r?.document_detected === null || typeof r?.document_detected === "undefined") && r?.has_files === true;
      return mode.includes("file") && (r?.document_detected === true || legacyFallback);
    });
    if (!fileRows.length) continue;

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
      ttft_delta_ms: median(ttftDeltaVals),
      ttft_delta_count: ttftDeltaVals.length,
      baseline_exact_count: baselineExactCount,
      baseline_model_count: baselineModelCount,
      ms_per_output_token_file: median(fileMsPerTokenVals),
      ms_per_output_token_text: textMsPerTokenBaseline,
      output_efficiency_delta_pct: (() => {
        const f = median(fileMsPerTokenVals);
        const t = textMsPerTokenBaseline;
        if (typeof f !== "number" || typeof t !== "number" || t <= 0) return null;
        return ((f - t) / t) * 100;
      })(),
      file_kind_set: uniqueValues(fileRows.map((r) => r?.file_kind_set || "none")).join(", "),
      file_size_bucket_set: uniqueValues(fileRows.map((r) => r?.file_size_bucket || "unknown")).join(", ")
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
  if (!rows.length) {
    return `
      <div class="card-panel full-width">
        <h3 class="dark-header">DOCUMENT INGESTION EFFICIENCY INDEX</h3>
        <div class="sub-label">Compares file-ingestion cost, startup delay inflation, and post-ingestion output efficiency for document-attached runs.</div>
        <div class="llm-empty">No document-attached runs detected for the current filters.</div>
      </div>
    `;
  }

  const ingestionRows = [...rows]
    .filter((r) => typeof r.doc_ms_per_mb === "number")
    .sort((a, b) => a.doc_ms_per_mb - b.doc_ms_per_mb);
  const ingestionMax = Math.max(...ingestionRows.map((r) => r.doc_ms_per_mb || 0), 1);
  const ttftRows = [...rows]
    .filter((r) => typeof r.ttft_delta_ms === "number")
    .sort((a, b) => a.ttft_delta_ms - b.ttft_delta_ms);
  const ttftAbsMax = Math.max(...ttftRows.map((r) => Math.abs(r.ttft_delta_ms || 0)), 1);
  const outputRows = [...rows]
    .filter((r) => typeof r.ms_per_output_token_file === "number" || typeof r.ms_per_output_token_text === "number")
    .sort((a, b) => (a.ms_per_output_token_file ?? Infinity) - (b.ms_per_output_token_file ?? Infinity));
  const outputMax = Math.max(...outputRows.flatMap((r) => [r.ms_per_output_token_file || 0, r.ms_per_output_token_text || 0]), 1);

  const ingestionHtml = ingestionRows.length
    ? ingestionRows.map((r, i) => {
      const cls = perfDocToneClass(i, ingestionRows.length);
      const pct = ((r.doc_ms_per_mb || 0) / ingestionMax) * 100;
      const medal = i < 3 ? ["🥇 ", "🥈 ", "🥉 "][i] : "";
      return `
        <div class="doc-metric-row">
          <div class="doc-row-head">
            <span class="doc-name"><span class="color-dot" style="background:${r.color}"></span>${medal}${escapeHtml(r.short)}</span>
            <span class="doc-value">${formatNumber(r.doc_ms_per_mb, 0)} ms/MB</span>
          </div>
          <div class="doc-track"><div class="doc-fill ${cls}" style="width:${formatNumber(pct, 1)}%"></div></div>
          <div class="doc-meta">${formatInt(r.file_run_count)} runs · median file ${formatNumber(r.file_bytes_median_mb, 2)} MB</div>
        </div>
      `;
    }).join("")
    : `<div class="llm-empty">No valid prompt/file size timing pairs.</div>`;

  const ttftHtml = ttftRows.length
    ? ttftRows.map((r) => {
      const delta = r.ttft_delta_ms || 0;
      const magPct = (Math.abs(delta) / ttftAbsMax) * 50;
      const left = delta < 0 ? (50 - magPct) : 50;
      const cls = delta < 0 ? "good" : (delta > 0 ? "warn" : "mid");
      const baselineLabel = r.baseline_exact_count > 0
        ? (r.baseline_model_count > 0 ? `mixed baseline (${r.baseline_exact_count} exact)` : "prompt-hash baseline")
        : "model baseline";
      return `
        <div class="doc-metric-row">
          <div class="doc-row-head">
            <span class="doc-name"><span class="color-dot" style="background:${r.color}"></span>${escapeHtml(r.short)}</span>
            <span class="doc-value ${delta < 0 ? "val-green" : delta > 0 ? "val-warn" : "val"}">${delta >= 0 ? "+" : ""}${formatNumber(delta, 0)} ms</span>
          </div>
          <div class="doc-delta-track">
            <div class="doc-delta-zero"></div>
            <div class="doc-delta-fill ${cls}" style="left:${formatNumber(left, 1)}%;width:${formatNumber(magPct, 1)}%"></div>
          </div>
          <div class="doc-meta">${baselineLabel} · ${formatInt(r.ttft_delta_count)} comparable runs</div>
        </div>
      `;
    }).join("")
    : `<div class="llm-empty">No text-only baseline available for TTFT delta.</div>`;

  const outputHtml = outputRows.length
    ? outputRows.map((r) => {
      const f = r.ms_per_output_token_file;
      const t = r.ms_per_output_token_text;
      const filePct = typeof f === "number" ? (f / outputMax) * 100 : 0;
      const textPct = typeof t === "number" ? (t / outputMax) * 100 : 0;
      const deltaPct = r.output_efficiency_delta_pct;
      return `
        <div class="doc-metric-row">
          <div class="doc-row-head">
            <span class="doc-name"><span class="color-dot" style="background:${r.color}"></span>${escapeHtml(r.short)}</span>
            <span class="doc-value">${typeof f === "number" ? `${formatNumber(f, 2)} ms/tok` : "-"}</span>
          </div>
          <div class="doc-dual-bars">
            <div class="doc-dual-line">
              <span class="doc-dual-label">Text</span>
              <div class="doc-track"><div class="doc-fill neutral" style="width:${formatNumber(textPct, 1)}%"></div></div>
              <span class="doc-dual-value">${typeof t === "number" ? formatNumber(t, 2) : "-"}</span>
            </div>
            <div class="doc-dual-line">
              <span class="doc-dual-label">File</span>
              <div class="doc-track"><div class="doc-fill blue" style="width:${formatNumber(filePct, 1)}%"></div></div>
              <span class="doc-dual-value">${typeof f === "number" ? formatNumber(f, 2) : "-"}</span>
            </div>
          </div>
          <div class="doc-meta">${typeof deltaPct === "number" ? `${deltaPct >= 0 ? "+" : ""}${formatNumber(deltaPct, 1)}% vs text baseline` : "No text-only output-speed baseline"}</div>
        </div>
      `;
    }).join("")
    : `<div class="llm-empty">No output timing data available for document runs.</div>`;

  const bestIngestion = ingestionRows[0] || null;
  const bestTtft = [...ttftRows].sort((a, b) => (a.ttft_delta_ms || 0) - (b.ttft_delta_ms || 0))[0] || null;
  const stableOutput = [...outputRows]
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
  if (!textModels.length) return `<div class="llm-empty">No text-only models available.</div>`;
  const W = Math.max(420, Math.round(igSafeNum(dims.W, 620)));
  const H = Math.max(220, Math.round(igSafeNum(dims.H, 220)));
  const pad = { l: 52, r: 22, t: 26, b: 40 };
  const ttftVals = textModels.map((m) => m.ttft).filter((x) => typeof x === "number");
  const tpsVals = textModels.map((m) => m.tps).filter((x) => typeof x === "number");
  const minX = Math.max(0, (Math.min(...ttftVals) || 0) - 5);
  const maxX = (Math.max(...ttftVals) || 100) + 10;
  const minY = 0;
  const maxY = Math.max(10, Math.ceil((Math.max(...tpsVals) || 10) / 10) * 10);
  const xp = (v) => pad.l + ((v - minX) / Math.max(1, maxX - minX)) * (W - pad.l - pad.r);
  const yp = (v) => H - pad.b - ((v - minY) / Math.max(1, maxY - minY)) * (H - pad.t - pad.b);
  const qx = quantile(ttftVals, 0.35) ?? (minX + (maxX - minX) * 0.35);
  const qy = quantile(tpsVals, 0.65) ?? (minY + (maxY - minY) * 0.65);

  const paretoSet = new Set(
    textModels
      .filter((a) => typeof a.ttft === "number" && typeof a.tps === "number")
      .filter((a) => {
        return !textModels.some((b) => {
          if (a === b) return false;
          if (typeof b.ttft !== "number" || typeof b.tps !== "number") return false;
          const noWorse = b.ttft <= a.ttft && b.tps >= a.tps;
          const strictlyBetter = b.ttft < a.ttft || b.tps > a.tps;
          return noWorse && strictlyBetter;
        });
      })
      .map((m) => m.model)
  );

  const grid = Array.from({ length: 5 }, (_, i) => {
    const y = pad.t + i * ((H - pad.t - pad.b) / 4);
    const val = maxY - i * (maxY / 4);
    return `<g><line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" class="scatter-grid"/><text x="${pad.l - 5}" y="${y + 4}" class="scatter-tick" text-anchor="end">${Math.round(val)}</text></g>`;
  }).join("");
  const ticksX = Array.from({ length: 5 }, (_, i) => {
    const xVal = minX + i * ((maxX - minX) / 4);
    const x = xp(xVal);
    return `<g><line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}" class="scatter-grid"/><text x="${x}" y="${H - pad.b + 16}" class="scatter-tick" text-anchor="middle">${Math.round(xVal)}ms</text></g>`;
  }).join("");
  const zoneX2 = xp(qx);
  const zoneY = yp(qy);
  const frontierZone = `
    <rect x="${pad.l}" y="${zoneY}" width="${Math.max(0, zoneX2 - pad.l)}" height="${Math.max(0, H - pad.b - zoneY)}" class="scatter-frontier-zone"></rect>
    <text x="${pad.l + 8}" y="${Math.max(pad.t + 14, zoneY + 16)}" class="scatter-frontier-label">Frontier candidates</text>
  `;
  const points = textModels.map((m) => {
    if (typeof m.ttft !== "number" || typeof m.tps !== "number") return "";
    const x = xp(m.ttft);
    const y = yp(m.tps);
    const isPareto = paretoSet.has(m.model);
    let anchor = m.ttft < (minX + maxX) / 2 ? "start" : "end";
    if (x < pad.l + 70) anchor = "start";
    if (x > (W - pad.r - 70)) anchor = "end";
    const dx = anchor === "start" ? 8 : -8;
    const labelY = Math.max(pad.t + 12, y - 10);
    const tagX = anchor === "start" ? (x + dx) : (x + dx - 2);
    const tagAnchor = anchor;
    return `
      ${isPareto ? `<circle cx="${x}" cy="${y}" r="8.5" fill="none" class="scatter-pareto-ring"></circle>` : ""}
      <circle cx="${x}" cy="${y}" r="4.6" fill="${m.color}" class="scatter-dot"></circle>
      <text x="${x + dx}" y="${labelY}" class="scatter-label" text-anchor="${anchor}">${escapeHtml(shortenModelName(m.short, 14))}</text>
      ${isPareto ? `<text x="${tagX}" y="${Math.max(pad.t + 10, labelY - 12)}" class="scatter-pareto-tag" text-anchor="${tagAnchor}">Pareto</text>` : ""}
    `;
  }).join("");
  return `
    <svg viewBox="0 0 ${W} ${H}" class="perf-scatter-svg" preserveAspectRatio="none">
      ${grid}
      ${ticksX}
      ${frontierZone}
      <line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" class="scatter-axis"/>
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}" class="scatter-axis"/>
      <text x="${W / 2}" y="${H - 3}" class="scatter-axis-label" text-anchor="middle">TTFT (ms) →</text>
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
  const chartWrap = root.querySelector('.perf-dashboard .card-panel[data-panel="efficiency-frontier"] .frontier-chart');
  if (!(chartWrap instanceof HTMLElement)) return;
  const models = perfBuildModelRows(records).filter((m) => !m.vision && typeof m.ttft === "number");
  if (!models.length) return;
  const W = Math.max(420, Math.floor(chartWrap.clientWidth || 620));
  const H = Math.max(220, Math.floor(chartWrap.clientHeight || 220));
  chartWrap.innerHTML = perfRenderScatterSvg(models, { W, H });
}

/**
 * Adjust Perf Frontier Chart Height.
 */
function adjustPerfFrontierChartHeight(root = __dashboardState.elements?.root) {
  if (!root) return;
  const card = root.querySelector('.perf-dashboard .card-panel[data-panel="efficiency-frontier"]');
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
 * Perf Render Dashboard Template.
 */
function perfRenderDashboardTemplate(records, summary, theme) {
  const models = perfBuildModelRows(records);
  if (!models.length) return `<div class="llm-empty">No data available for the infographic dashboard.</div>`;

  const textModels = models.filter((m) => !m.vision && typeof m.ttft === "number");
  const visionModels = models.filter((m) => m.vision && typeof m.ttft === "number").sort((a, b) => (b.ttft || 0) - (a.ttft || 0));

  const ttftSorted = [...textModels].filter((m) => typeof m.ttft === "number").sort((a, b) => a.ttft - b.ttft).slice(0, 8);
  const ttftMax = Math.max(...ttftSorted.map((m) => m.ttft || 0), 1) + 10;
  const ttftBars = ttftSorted.map((m, i) => perfSpeedBarRow(m.short, m.ttft, "ms", ((m.ttft || 0) / ttftMax) * 100, m.color, "val", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("");

  const reasoningRows = models.filter((m) => (m.reasoningPct || 0) > 0).sort((a, b) => (b.reasoningPct || 0) - (a.reasoningPct || 0)).slice(0, 8);
  const reasoningBars = reasoningRows.length
    ? reasoningRows.map((m) => perfSpeedBarRow(m.short, m.reasoningPct, "%", m.reasoningPct, m.color, "val")).join("")
    : `<div class="llm-empty">No reasoning-phase records detected.</div>`;

  const tpsSorted = [...models].filter((m) => typeof m.tps === "number").sort((a, b) => (b.tps || 0) - (a.tps || 0));
  const tpsMax = Math.max(...tpsSorted.map((m) => m.tps || 0), 1);
  const tpsBars = tpsSorted.slice(0, 10).map((m, i) => perfSpeedBarRow(m.short, m.tps, "", ((m.tps || 0) / tpsMax) * 100, m.color, "val-blue", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("");

  const effSorted = [...textModels]
    .map((m) => ({ ...m, eff: (m.params && m.tps) ? (m.tps / m.params) : null }))
    .filter((m) => typeof m.eff === "number")
    .sort((a, b) => b.eff - a.eff);
  const effMax = Math.max(...effSorted.map((m) => m.eff || 0), 1);
  const effBars = effSorted.slice(0, 8).map((m, i) => perfSpeedBarRow(`${m.short} (${formatNumber(m.params, 0)}B)`, m.eff, "", ((m.eff || 0) / effMax) * 100, m.color, "val-blue", i < 3 ? ["🥇 ","🥈 ","🥉 "][i] : "")).join("");

  const speedRank = tpsSorted.slice(0, 7).map((m, i) => `
    <div class="consistency-row">
      <div class="consistency-name"><span class="color-dot" style="background:${m.color}"></span>${i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : ""}${escapeHtml(m.short)}</div>
      <div class="consistency-bar-bg"><div class="consistency-bar-fill" style="width:${formatNumber(((m.tps || 0) / tpsMax) * 100, 1)}%;background:${m.color}"></div></div>
      <div class="consistency-value" style="color:${m.color}">${formatNumber(m.tps, 1)}</div>
    </div>
  `).join("");

  const stableSorted = [...models].filter((m) => typeof m.ttftStd === "number").sort((a, b) => (a.ttftStd || 0) - (b.ttftStd || 0));
  const good = stableSorted.slice(0, 4);
  const bad = stableSorted.slice(-4).reverse();
  const stdMax = Math.max(...stableSorted.map((m) => m.ttftStd || 0), 1);
  const stabilityRows = (list, cls, medalize = false) => list.map((m, i) => `
    <div class="consistency-row">
      <div class="consistency-name"><span class="color-dot" style="background:${m.color}"></span>${medalize ? (i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : "") : ""}${escapeHtml(m.short)}</div>
      <div class="consistency-bar-bg"><div class="consistency-bar-fill" style="width:${formatNumber(((m.ttftStd || 0) / stdMax) * 100, 1)}%;background:${m.color}"></div></div>
      <div class="consistency-value ${cls}">±${formatNumber(m.ttftStd, 0)}ms</div>
    </div>
  `).join("");

  const avgTextTtft = avgOf(textModels.map((m) => m.ttftAvg).filter((x) => typeof x === "number"));
  const visionTop2 = visionModels.slice(0, 2);
  const visionTaxBoxes = visionTop2.map((m) => {
    const delta = (typeof m.ttftAvg === "number" && typeof avgTextTtft === "number") ? (m.ttftAvg - avgTextTtft) : null;
    return `
      <div class="vision-box">
        <div class="vision-pct">${typeof m.ttftAvg === "number" ? `${formatNumber(m.ttftAvg, 0)}ms` : "-"}</div>
        <div class="vision-name">${escapeHtml(shortenModelName(m.short, 18))}</div>
        <div class="vision-delta">${typeof delta === "number" ? `${delta >= 0 ? "+" : ""}${formatNumber(delta, 0)}ms vs text avg` : ""}</div>
      </div>
    `;
  }).join("");
  const visionCompareModels = [
    ...ttftSorted.slice(0, 2),
    ...visionTop2.sort((a, b) => (a.ttftAvg || 0) - (b.ttftAvg || 0))
  ].filter((v, i, a) => a.findIndex((x) => x.model === v.model) === i);
  const visionCompareMax = Math.max(...visionCompareModels.map((m) => m.ttftAvg || m.ttft || 0), 1);
  const visionCompareBars = visionCompareModels.map((m) =>
    perfSpeedBarRow(`${m.short}${m.vision ? " (vision)" : " (text)"}`, m.ttftAvg || m.ttft, "ms", (((m.ttftAvg || m.ttft || 0)) / visionCompareMax) * 100, m.color, "val")
  ).join("");

  const scatterLegend = textModels.map((m) => `<div class="legend-item"><div class="legend-dot" style="background:${m.color}"></div>${escapeHtml(m.short)}</div>`).join("");
  const scatterSvg = perfRenderScatterSvg(textModels);
  const docRows = perfBuildDocumentIngestionRows(records);
  const docIngestionCard = perfRenderDocumentIngestionCard(records);

  const topTps = tpsSorted[0];
  const lowTps = tpsSorted[tpsSorted.length - 1];
  const reasoningWinner = reasoningRows[0];
  const bestTtft = ttftSorted[0] || null;
  const bestEff = effSorted[0] || null;
  const bestStable = stableSorted[0] || null;
  const bestDocIngestion = [...docRows]
    .filter((r) => typeof r.doc_ms_per_mb === "number")
    .sort((a, b) => (a.doc_ms_per_mb || 0) - (b.doc_ms_per_mb || 0))[0] || null;
  const bestInClassCards = [
    {
      section: "THE RACE TO FIRST RESPONSE",
      model: bestTtft?.model || "-",
      metric: typeof bestTtft?.ttft === "number" ? `${formatNumber(bestTtft.ttft, 0)}ms` : "-",
      note: "Lowest TTFT model"
    },
    {
      section: "TOKENS PER SECOND",
      model: topTps?.model || "-",
      metric: typeof topTps?.tps === "number" ? `${formatNumber(topTps.tps, 1)} TPS` : "-",
      note: "Highest TPS model"
    },
    {
      section: "BIGGER ISN'T ALWAYS BETTER",
      model: bestEff?.model || "-",
      metric: typeof bestEff?.eff === "number" ? `${formatNumber(bestEff.eff, 2)} TPS/B` : "-",
      note: "Best TPS-per-parameter"
    },
    {
      section: "OVERALL SPEED COMPARISON",
      model: topTps?.model || "-",
      metric: typeof topTps?.tps === "number" ? `${formatNumber(topTps.tps, 1)} TPS` : "-",
      note: "Highest TPS model"
    },
    {
      section: "LATENCY STABILITY — MOST CONSISTENT",
      model: bestStable?.model || "-",
      metric: typeof bestStable?.ttftStd === "number" ? `±${formatNumber(bestStable.ttftStd, 0)}ms` : "-",
      note: "Lowest TTFT-std model"
    },
    {
      section: "DOCUMENT INGESTION",
      model: bestDocIngestion?.model || "-",
      metric: typeof bestDocIngestion?.doc_ms_per_mb === "number" ? `${formatNumber(bestDocIngestion.doc_ms_per_mb, 0)} ms/MB` : "-",
      note: "Lowest ingestion cost per MB"
    }
  ];
  const bestInClassRow = `
    <div class="best-class-row full-width">
      ${bestInClassCards.map((c) => `
        <div class="best-class-card">
          <div class="best-class-section">${escapeHtml(c.section)}</div>
          <div class="best-class-kicker">🥇 Best in Class</div>
          <div class="best-class-model">${escapeHtml(c.model)}</div>
          <div class="best-class-metric">${escapeHtml(c.metric)}</div>
          <div class="best-class-note">${escapeHtml(c.note)}</div>
        </div>
      `).join("")}
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
              <h1>COMPARING LLM<br>PERFORMANCE</h1>
              <p>Live extension metrics dashboard. Filters above apply to all panels.</p>
            </div>
            <div class="header-meta">
              ${headerSummaryMeta}
            </div>
          </div>
          <div class="section-divider"></div>
          <div class="main-grid">
            ${bestInClassRow}
            <div class="card-panel" data-panel="ttft">
              <h3 class="orange-header">THE RACE TO FIRST RESPONSE</h3>
              <div class="sub-label">Shows time-to-first-token (TTFT) in milliseconds for text models, so compare bar lengths to identify the fastest interactive responders and spot latency outliers.</div>
              <div>${ttftBars}</div>
              <div class="takeaway"><strong>TAKEAWAY:</strong> Fastest text models cluster near ${ttftSorted[0]?.ttft ? `${formatNumber(ttftSorted[0].ttft, 0)}ms` : "-"} TTFT.</div>
            </div>

            <div class="card-panel" data-panel="vision-tax">
              <h3 class="blue-header">THE VISION TAX</h3>
              <div class="sub-label">Compares startup latency for image-enabled requests against text-only behavior, so look for how much vision inputs increase TTFT and whether that penalty remains consistently high.</div>
              <div class="two-col-grid" style="margin-bottom:10px;">${visionTaxBoxes || `<div class="llm-empty">No vision/image runs found.</div>`}</div>
              <div class="sub-label">This mini comparison gives representative text and vision TTFT values, so read it as a direct illustration of the practical latency cost of multimodal prompts.</div>
              <div>${visionCompareBars || `<div class="llm-empty">Not enough mixed text/vision data.</div>`}</div>
              <div class="takeaway"><strong>${typeof avgTextTtft === "number" ? "VISION COST:" : "NOTE:"}</strong> ${typeof avgTextTtft === "number" ? `Text-only average TTFT is ${formatNumber(avgTextTtft, 0)}ms.` : "Capture image prompts to populate this panel."}</div>
            </div>

            ${docIngestionCard}

            <div class="card-panel" data-panel="reasoning-share">
              <h3 class="orange-header">HOW MUCH DOES IT THINK?</h3>
              <div class="sub-label">Shows the estimated share of generated tokens consumed by internal reasoning phases, so higher bars indicate models spending more output budget thinking before visible answers.</div>
              <div>${reasoningBars}</div>
              <div class="takeaway"><strong>TAKEAWAY:</strong> ${reasoningWinner ? `${escapeHtml(reasoningWinner.short)} leads reasoning share at ${formatNumber(reasoningWinner.reasoningPct, 1)}%.` : "No reasoning models detected in current filter."}</div>
            </div>

            <div class="card-panel" data-panel="tps">
              <h3 class="blue-header">TOKENS PER SECOND</h3>
              <div class="sub-label">Ranks generation throughput in tokens per second (TPS), so compare the leaders for raw speed and note how sharply performance drops across the remaining models.</div>
              <div>${tpsBars}</div>
              <div class="takeaway"><strong>WINNER:</strong> ${topTps ? `${escapeHtml(topTps.short)} leads at ${formatNumber(topTps.tps, 1)} TPS.` : "No TPS data."}</div>
            </div>

            <div class="card-panel" data-panel="efficiency-frontier">
              <h3 class="dark-header">SPEED vs RESPONSIVENESS — The Efficiency Frontier</h3>
              <div class="sub-label">Plots throughput (TPS) against responsiveness (TTFT) for text-only models, so look toward the top-left and the Pareto-annotated frontier for the best tradeoff candidates.</div>
              <div class="frontier-grid">
                <div class="chart-container frontier-chart">${scatterSvg}</div>
                <div>
                  <div class="legend-title">MODEL LEGEND</div>
                  <div>${scatterLegend}</div>
                </div>
              </div>
            </div>

            <div class="card-panel" data-panel="size-efficiency">
              <h3 class="blue-header">BIGGER ISN'T ALWAYS BETTER</h3>
              <div class="sub-label">Normalizes throughput by parameter count (TPS per B params) to show size efficiency, so higher bars reveal models delivering more speed per unit of model size.</div>
              <div>${effBars || `<div class="llm-empty">No parseable parameter sizes found.</div>`}</div>
              <div class="takeaway"><strong>TAKEAWAY:</strong> Small and mid-size models often dominate per-parameter efficiency.</div>
            </div>

            <div class="card-panel" data-panel="overall-speed">
              <h3 class="orange-header">OVERALL SPEED COMPARISON</h3>
              <div class="sub-label">Provides a compact all-model TPS ranking, so use it to confirm speed winners quickly and compare the spread between the fastest and slowest performers.</div>
              <div class="two-col-grid" style="margin-bottom:9px;">
                <div class="stat-highlight">
                  <div class="big-num">${topTps ? formatNumber(topTps.tps, 1) : "-"}</div>
                  <div class="stat-lbl">Peak TPS<br>${topTps ? escapeHtml(shortenModelName(topTps.short, 16)) : "-"}</div>
                </div>
                <div class="stat-highlight">
                  <div class="big-num">${lowTps ? formatNumber(lowTps.tps, 1) : "-"}</div>
                  <div class="stat-lbl">Lowest TPS<br>${lowTps ? escapeHtml(shortenModelName(lowTps.short, 16)) : "-"}</div>
                </div>
              </div>
              <div>${speedRank}</div>
            </div>

            <div class="card-panel full-width" data-panel="latency-stability">
              <h3 class="dark-header">LATENCY STABILITY — Consistency Under Load</h3>
              <div class="sub-label">Shows TTFT variability as standard deviation in milliseconds, so lower values indicate more predictable response starts while higher values signal unstable latency behavior.</div>
              <div class="stability-grid">
                <div>
                  <div class="stab-title good">Most Consistent ✓</div>
                  <div>${stabilityRows(good, "val-green", true)}</div>
                </div>
                <div>
                  <div class="stab-title bad">Most Variable ⚠</div>
                  <div>${stabilityRows(bad, "val-warn", false)}</div>
                </div>
              </div>
              <div class="takeaway"><strong>CONSISTENCY:</strong> Use this panel to separate fast models from predictable models.</div>
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
    const docCount = filtered.filter((r) => (r?.input_mode || "").includes("file")).length;
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
      .perf-dashboard .main-grid > .card-panel[data-panel="efficiency-frontier"] { flex-basis: 100%; width: 100%; }
      .perf-dashboard .main-grid > .best-class-row { order: 10; }
      .perf-dashboard .main-grid > .card-panel[data-panel="ttft"] { order: 20; }
      .perf-dashboard .main-grid > .card-panel[data-panel="tps"] { order: 30; }
      .perf-dashboard .main-grid > .card-panel[data-panel="document-ingestion-efficiency"] { order: 40; }
      .perf-dashboard .main-grid > .card-panel[data-panel="vision-tax"] { order: 50; }
      .perf-dashboard .main-grid > .card-panel[data-panel="overall-speed"] { order: 60; }
      .perf-dashboard .main-grid > .card-panel[data-panel="efficiency-frontier"] { order: 70; }
      .perf-dashboard .main-grid > .card-panel[data-panel="size-efficiency"] { order: 80; }
      .perf-dashboard .main-grid > .card-panel[data-panel="reasoning-share"] { order: 90; }
      .perf-dashboard .main-grid > .card-panel[data-panel="latency-stability"] { order: 100; }
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
        min-height: 1.6em;
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
      .perf-dashboard .orange-header { background: var(--h3-bg-orange); color: var(--accent-primary); border-left: 3px solid var(--accent-primary); }
      .perf-dashboard .blue-header { background: var(--h3-bg-blue); color: var(--accent-secondary); border-left: 3px solid var(--accent-secondary); }
      .perf-dashboard .dark-header { background: var(--h3-bg-dark); color: var(--text-primary); border: 1px solid var(--border-color); border-left: 3px solid var(--accent-primary); }
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
      .perf-dashboard .scatter-pareto-ring {
        stroke: color-mix(in srgb, var(--accent-primary) 78%, #fff 8%);
        stroke-width: 1.6;
        stroke-dasharray: 2 2;
        opacity: .9;
      }
      .perf-dashboard .scatter-pareto-tag {
        fill: color-mix(in srgb, var(--accent-primary) 80%, var(--text-primary));
        font-size: 9px;
        font-family: var(--perf-font-head);
        font-weight: 700;
        letter-spacing: .02em;
      }
      .perf-dashboard .scatter-label { fill: var(--pt-label); font-size: 11px; font-weight: 700; font-family: var(--perf-font-body); }
      .perf-dashboard .legend-title { font-size:.82rem; font-weight:800; color:var(--accent-primary); margin-bottom:6px; letter-spacing:.6px; font-family: var(--perf-font-head); }
      .perf-dashboard .legend-item { display:flex; align-items:center; gap:6px; font-size:.74rem; color:var(--text-secondary); margin:2px 0; line-height:1.3; font-family: var(--perf-font-body); }
      .perf-dashboard .legend-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; opacity:.85; }
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
      .perf-dashboard .doc-meta {
        margin-top: 3px;
        color: var(--text-muted);
        font-size: .62rem;
        line-height: 1.2;
        font-family: var(--perf-font-body);
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
        .perf-dashboard .doc-ingestion-grid { grid-template-columns: 1fr; }
        .perf-dashboard .stability-grid { grid-template-columns: 1fr; }
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

