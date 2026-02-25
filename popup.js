/**
 * @module popup
 * Chrome action popup controller for session status, domain allowlist, export permissions,
 * debug toggles, JSONL import, and reset actions.
 */

/** @internal */
const ALLOWED_DOMAINS_KEY = "allowed_domains";
/** @internal */
let __activeTabPermissionContext = null;

/**
 * Send.
 */
async function send(msg) {
  return await chrome.runtime.sendMessage(msg);
}

/**
 * Format Bytes.
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

/**
 * Set Status.
 */
function setStatus(text) {
  const el = document.getElementById("status");
  el.textContent = text || "";
}

/**
 * Set Permissions Panel State.
 */
function setPermissionsPanelState(state, siteText, detailText) {
  const panel = document.querySelector(".permissions-panel");
  const siteEl = document.getElementById("permSite");
  const stateEl = document.getElementById("permState");
  const btn = document.getElementById("grantSiteAccessBtn");
  if (panel) panel.setAttribute("data-state", state || "");
  if (siteEl) siteEl.textContent = siteText || "";
  if (stateEl) stateEl.textContent = detailText || "";
  if (btn) {
    const ctx = __activeTabPermissionContext;
    const canRequest = ctx?.requestable === true;
    btn.disabled = !canRequest;
    if (canRequest) {
      btn.textContent = "Grant access to this site";
    } else if (ctx?.originPattern) {
      btn.textContent = "Access already granted";
    } else {
      btn.textContent = "Grant access unavailable";
    }
  }
}

/**
 * Get Origin Permission Pattern.
 */
function getOriginPermissionPattern(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

/**
 * Get Active Tab.
 */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

/**
 * Refresh Export Permission Status.
 */
async function refreshExportPermissionStatus() {
  try {
    const tab = await getActiveTab();
    if (!tab?.url) {
      __activeTabPermissionContext = null;
      setPermissionsPanelState("warn", "Active site: unavailable", "Open a normal http/https tab to check export permissions.");
      return;
    }

    const originPattern = getOriginPermissionPattern(tab.url);
    if (!originPattern) {
      __activeTabPermissionContext = null;
      setPermissionsPanelState(
        "blocked",
        `Active site: ${tab.url}`,
        "This page does not support site access requests (for example chrome://, extension pages, or local browser pages)."
      );
      return;
    }

    const hasOriginAccess = await chrome.permissions.contains({ origins: [originPattern] });
    __activeTabPermissionContext = {
      tabId: tab.id,
      url: tab.url,
      originPattern,
      requestable: !hasOriginAccess
    };

    if (hasOriginAccess) {
      setPermissionsPanelState(
        "ok",
        `Active site: ${originPattern}`,
        "Export permission looks available for this site."
      );
    } else {
      setPermissionsPanelState(
        "warn",
        `Active site: ${originPattern}`,
        "Export PNG may fail until this site is granted extension access."
      );
    }
  } catch (e) {
    __activeTabPermissionContext = null;
    setPermissionsPanelState("blocked", "Active site: check failed", `Could not check permission status: ${e?.message || e}`);
  }
}

/**
 * Request Active Site Access.
 */
async function requestActiveSiteAccess() {
  const ctx = __activeTabPermissionContext;
  if (!ctx?.originPattern) {
    setStatus("No requestable active site detected.");
    return;
  }
  try {
    setStatus("Requesting site access...");
    const granted = await chrome.permissions.request({ origins: [ctx.originPattern] });
    if (!granted) {
      setStatus("Site access was not granted.");
    } else {
      setStatus("Site access granted. Reload the page, reopen the dashboard, then export PNG.");
    }
  } catch (e) {
    setStatus("Permission request failed: " + (e?.message || String(e)));
  } finally {
    await refreshExportPermissionStatus();
  }
}

/**
 * Get Debug.
 */
async function getDebug() {
  const { debug_enabled } = await chrome.storage.local.get(["debug_enabled"]);
  return Boolean(debug_enabled);
}

/**
 * Set Debug.
 */
async function setDebug(val) {
  await chrome.storage.local.set({ debug_enabled: Boolean(val) });
}

/**
 * Normalize Domain Pattern.
 */
function normalizeDomainPattern(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Allow full URL input.
  try {
    if (s.includes("://")) {
      const u = new URL(s);
      s = u.host;
    }
  } catch {}

  // Strip any path/query/fragment if user typed them.
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
 * Get Allowed Domains.
 */
async function getAllowedDomains() {
  const { [ALLOWED_DOMAINS_KEY]: allowed_domains } = await chrome.storage.local.get([ALLOWED_DOMAINS_KEY]);
  const list = Array.isArray(allowed_domains) ? allowed_domains : [];
  return list
    .map((x) => normalizeDomainPattern(x))
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i)
    .sort();
}

/**
 * Set Allowed Domains.
 */
async function setAllowedDomains(list) {
  const cleaned = Array.isArray(list) ? list : [];
  await chrome.storage.local.set({ [ALLOWED_DOMAINS_KEY]: cleaned });
}

/**
 * Render Domains.
 */
function renderDomains(list) {
  const container = document.getElementById("domainList");
  container.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "domain-empty";
    empty.textContent = "No domains configured. Add one to enable capture.";
    container.appendChild(empty);
    return;
  }

  for (const d of list) {
    const row = document.createElement("div");
    row.className = "domain-item";

    const label = document.createElement("code");
    label.textContent = d;

    const btn = document.createElement("button");
    btn.className = "mini danger";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      const current = await getAllowedDomains();
      const next = current.filter((x) => x !== d);
      await setAllowedDomains(next);
      renderDomains(next);
      setStatus("Domain removed. Refresh target tabs.");
    });

    row.appendChild(label);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

/**
 * Refresh Domains.
 */
async function refreshDomains() {
  const list = await getAllowedDomains();
  renderDomains(list);
}

/**
 * Add Domain From Input.
 */
async function addDomainFromInput() {
  const input = document.getElementById("domainInput");
  const normalized = normalizeDomainPattern(input.value);
  if (!normalized) {
    setStatus("Invalid domain. Use example.com or *.example.com");
    return;
  }

  const current = await getAllowedDomains();
  if (current.includes(normalized)) {
    setStatus("Domain already added.");
    return;
  }

  const next = [...current, normalized].sort();
  await setAllowedDomains(next);
  renderDomains(next);
  input.value = "";
  setStatus("Domain added. Refresh target tabs.");
}

/**
 * Refresh.
 */
async function refresh() {
  setStatus("Refreshing...");
  const res = await send({ type: "get_status" });
  if (!res?.ok) {
    setStatus("Error: " + (res?.error || "unknown"));
    return;
  }
  document.getElementById("sessionStart").textContent = res.session_start || "-";
  document.getElementById("sessionRecords").textContent = String(res.record_count ?? 0);
  document.getElementById("sessionSize").textContent = formatBytes(res.session_size_bytes);
  setStatus("");
}

/**
 * Pick Jsonl File.
 */
async function pickJsonlFile() {
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".jsonl,.txt,application/json";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

/**
 * Parse Jsonl Text.
 */
function parseJsonlText(text) {
  const lines = String(text || "").split(/\r?\n/).filter((x) => x.trim().length > 0);
  if (!lines.length) {
    throw new Error("The selected file is empty.");
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON at line ${lineNo}.`);
    }
    if (!obj || typeof obj !== "object" || !obj.req || !obj.resp) {
      throw new Error(`Invalid record schema at line ${lineNo} (missing req/resp).`);
    }
    out.push(obj);
  }
  return out;
}

document.getElementById("importBtn").addEventListener("click", async () => {
  const ok = confirm("Import JSONL will overwrite all metrics currently stored in this browser. Continue?");
  if (!ok) return;
  try {
    const file = await pickJsonlFile();
    if (!file) return;
    setStatus("Validating JSONL...");
    const text = await file.text();
    const records = parseJsonlText(text);
    setStatus(`Importing ${records.length} records...`);
    const res = await send({ type: "import_jsonl_records", records });
    if (!res?.ok) {
      setStatus("Error: " + (res?.error || "import failed"));
      return;
    }
    await refresh();
    setStatus(`Import complete: ${records.length} records loaded.`);
  } catch (e) {
    setStatus("Error: " + (e?.message || String(e)));
  }
});

document.getElementById("clearAllBtn").addEventListener("click", async () => {
  if (!confirm("Clear ALL data? This deletes all captured records.")) return;
  setStatus("Clearing all...");
  const res = await send({ type: "clear_all" });
  if (!res?.ok) return setStatus("Error: " + (res?.error || "unknown"));
  await refresh();
});

document.getElementById("grantSiteAccessBtn").addEventListener("click", async () => {
  await requestActiveSiteAccess();
});

document.getElementById("addDomainBtn").addEventListener("click", addDomainFromInput);
document.getElementById("domainInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addDomainFromInput();
  }
});

/** @internal */
const debugToggle = document.getElementById("debugToggle");

(async () => {
  debugToggle.checked = await getDebug();
})();

debugToggle.addEventListener("change", async () => {
  await setDebug(debugToggle.checked);
  setStatus(debugToggle.checked ? "Debug logging enabled" : "Debug logging disabled");
  setTimeout(() => setStatus(""), 1200);
});

refresh();
refreshDomains();
refreshExportPermissionStatus();
