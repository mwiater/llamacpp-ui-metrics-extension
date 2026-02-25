/**
 * @module injected
 * Page-context capture hook that wraps `window.fetch()` for `/v1/chat/completions`, parses SSE streams,
 * derives metrics, and emits normalized records back to the content script via `window.postMessage`.
 */

(function () {
  /** @internal */
  const originalFetch = window.fetch;
  /** @internal */
  const originalCreateObjectURL = (window.URL && window.URL.createObjectURL)
    ? window.URL.createObjectURL.bind(window.URL)
    : null;
  /** @internal */
  const DOCUMENT_EVENT_WINDOW_MS = 5 * 60 * 1000;
  /** @internal */
  const DOCUMENT_BLOB_SIGNAL_WINDOW_MS = 10 * 60 * 1000;
  /** @internal */
  const ATTACHMENT_EVENT_WINDOW_MS = 5 * 60 * 1000;
  /** @internal */
  const MAX_CAPTURED_TEXT_CHARS = 200000;

  // Debug flag controlled via postMessage (CSP-safe)
  /** @internal */
  let __debugEnabled = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "LLAMACPP_SET_DEBUG") {
      __debugEnabled = Boolean(msg.enabled);
      if (__debugEnabled) {
        console.log("[llama.cpp metrics][inject] Debug enabled", { reason: msg.reason || "unknown" });
      }
    }
  });

    /**
     * Debug Log.
     */
    function debugLog(traceId, ...args) {
    if (!__debugEnabled) return;
    if (traceId) {
      console.log("[llama.cpp metrics][inject]", `[trace ${traceId}]`, ...args);
    } else {
      console.log("[llama.cpp metrics][inject]", ...args);
    }
  }

    /**
     * Make Trace Id.
     */
    function makeTraceId() {
    // Simple, stable, unique-enough trace id for correlating across logs/layers
    // Example: t-1700000000000-k3f9zq
    const rand = Math.random().toString(36).slice(2, 8);
    return `t-${Date.now()}-${rand}`;
  }

    /**
     * Round Ms.
     */
    function roundMs(x) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    return Math.round(x * 1000) / 1000;
  }

    /**
     * Utf8 Bytes.
     */
    function utf8Bytes(s) {
    try {
      return new TextEncoder().encode(s).length;
    } catch {
      return s.length;
    }
  }

    /**
     * Safe Json Parse.
     */
    function safeJsonParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

    /**
     * Extract Text From Message Content.
     */
    function extractTextFromMessageContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    let out = "";
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        out += part.text;
      }
    }
    return out;
  }

    /**
     * Get Current User Prompt Text.
     */
    function getCurrentUserPromptText(bodyObj) {
    const messages = Array.isArray(bodyObj?.messages) ? bodyObj.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "user") continue;
      const text = extractTextFromMessageContent(m?.content);
      return typeof text === "string" && text.length ? text : "";
    }
    return null;
  }

    /**
     * Clip Captured Text.
     */
    function clipCapturedText(s, maxChars = MAX_CAPTURED_TEXT_CHARS) {
    if (typeof s !== "string") return null;
    if (!Number.isFinite(maxChars) || maxChars <= 0) return s;
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars);
  }

    /**
     * Stable Stringify.
     */
    function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      parts.push(`${JSON.stringify(k)}:${stableStringify(value[k])}`);
    }
    return `{${parts.join(",")}}`;
  }

    /**
     * Sha256 Hex.
     */
    async function sha256Hex(input) {
    try {
      if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
      const bytes = new TextEncoder().encode(String(input ?? ""));
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const arr = new Uint8Array(digest);
      return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }

    /**
     * Build Message Structure For Hash.
     */
    function buildMessageStructureForHash(messages) {
    const list = Array.isArray(messages) ? messages : [];
    return list.map((m) => {
      const role = m?.role || "unknown";
      const c = m?.content;

      if (typeof c === "string") {
        return {
          role,
          content_kind: "string",
          text_bytes: utf8Bytes(c)
        };
      }

      if (Array.isArray(c)) {
        const parts = c.map((part) => {
          if (!part || typeof part !== "object") return { type: "unknown" };
          if (part.type === "text" && typeof part.text === "string") {
            return { type: "text", text_bytes: utf8Bytes(part.text) };
          }
          if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
            const url = part.image_url.url;
            const m = url.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
              const mime = m[1] || null;
              const b64 = m[2] || "";
              const pad = (b64.endsWith("==") ? 2 : (b64.endsWith("=") ? 1 : 0));
              const decoded = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
              return { type: "image_url", mime, image_bytes: decoded, url_kind: "data" };
            }
            return { type: "image_url", mime: null, image_bytes: null, url_kind: "remote_or_blob" };
          }
          return { type: part.type || "unknown" };
        });
        return {
          role,
          content_kind: "parts",
          parts
        };
      }

      return {
        role,
        content_kind: "unknown"
      };
    });
  }

    /**
     * Build Prompt Identity.
     */
    async function buildPromptIdentity(bodyObj) {
    if (!bodyObj || typeof bodyObj !== "object") {
      return {
        hash_algorithm: "SHA-256",
        prompt_hash: null,
        message_structure_hash: null,
        version: "v1"
      };
    }

    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const promptMaterial = stableStringify(messages);
    const structureMaterial = stableStringify(buildMessageStructureForHash(messages));

    const [promptHash, structureHash] = await Promise.all([
      sha256Hex(promptMaterial),
      sha256Hex(structureMaterial)
    ]);

    return {
      hash_algorithm: "SHA-256",
      prompt_hash: promptHash,
      message_structure_hash: structureHash,
      version: "v1"
    };
  }

    /**
     * Emit Probe.
     */
    function emitProbe(eventName, payload = {}) {
    if (!__debugEnabled) return;
    window.postMessage({
      type: "LLAMACPP_PROBE",
      payload: {
        ts_ms: Date.now(),
        event: eventName,
        ...payload
      }
    }, "*");
  }

  /** @internal */
  const documentSignal = {
    totalEvents: 0,
    lastEventAtMs: null,
    lastSource: null,
    lastKind: null,
    lastFiles: [],
    lastBlobUrl: null,
    lastBlobMime: null,
    lastBlobBytes: null,
    kindCounts: { pdf: 0, text: 0, other: 0 },
    lastConsumedEventAtMs: 0
  };
  /** @internal */
  const attachmentSignal = {
    totalEvents: 0,
    lastEventAtMs: null,
    lastSource: null,
    lastFiles: [],
    kindCounts: { pdf: 0, text: 0, image: 0, audio: 0, other: 0 },
    lastConsumedEventAtMs: 0
  };
  /** @internal */
  const pendingDocument = {
    version: 0,
    lastEventAtMs: null,
    sources: new Set(),
    kinds: new Set(),
    files: [],
    blobMimes: new Set()
  };
  /** @internal */
  let lastConsumedPendingVersion = 0;
  /** @internal */
  const pendingAttachments = {
    version: 0,
    lastEventAtMs: null,
    sources: new Set(),
    files: []
  };
  /** @internal */
  let lastConsumedAttachmentVersion = 0;
  /** @internal */
  const blobUrlMeta = new Map();

  /** @internal */
  const TEXT_FILE_EXTENSIONS = new Set([
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "log"
  ]);
  /** @internal */
  const IMAGE_FILE_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"
  ]);
  /** @internal */
  const AUDIO_FILE_EXTENSIONS = new Set([
    "mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "weba", "aiff"
  ]);

    /**
     * Get File Ext.
     */
    function getFileExt(name) {
    const safeName = typeof name === "string" ? name.toLowerCase() : "";
    return safeName.includes(".") ? safeName.split(".").pop() : "";
  }

    /**
     * Classify Document Kind.
     */
    function classifyDocumentKind(mime, name) {
    const safeMime = typeof mime === "string" ? mime.toLowerCase() : "";
    const ext = getFileExt(name);

    if (safeMime === "application/pdf" || ext === "pdf") return "pdf";

    const isTextMime =
      safeMime.startsWith("text/") ||
      safeMime === "application/json" ||
      safeMime === "application/xml" ||
      safeMime === "application/x-yaml" ||
      safeMime === "application/yaml";

    if (isTextMime || TEXT_FILE_EXTENSIONS.has(ext)) return "text";

    return null;
  }

    /**
     * Classify Attachment Kind.
     */
    function classifyAttachmentKind(mime, name) {
    const safeMime = typeof mime === "string" ? mime.toLowerCase() : "";
    const ext = getFileExt(name);

    if (safeMime === "application/pdf" || ext === "pdf") return "pdf";
    if (safeMime.startsWith("image/") || IMAGE_FILE_EXTENSIONS.has(ext)) return "image";
    if (safeMime.startsWith("audio/") || AUDIO_FILE_EXTENSIONS.has(ext)) return "audio";

    const isTextMime =
      safeMime.startsWith("text/") ||
      safeMime === "application/json" ||
      safeMime === "application/xml" ||
      safeMime === "application/x-yaml" ||
      safeMime === "application/yaml";
    if (isTextMime || TEXT_FILE_EXTENSIONS.has(ext)) return "text";

    return "other";
  }

    /**
     * Detect Document File Info.
     */
    function detectDocumentFileInfo(file) {
    if (!file || typeof file !== "object") return null;
    const mime = typeof file.type === "string" ? file.type.toLowerCase() : "";
    const name = typeof file.name === "string" ? file.name : "";
    const kind = classifyDocumentKind(mime, name);
    if (!kind) return null;
    return { kind, mime, name };
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
     * Push Unique Limited.
     */
    function pushUniqueLimited(arr, values, limit = 12) {
    for (const v of values) {
      if (!v) continue;
      if (arr.includes(v)) continue;
      arr.push(v);
      if (arr.length >= limit) break;
    }
  }

    /**
     * Push Unique File Meta Limited.
     */
    function pushUniqueFileMetaLimited(arr, values, limit = 20) {
    for (const v of values) {
      if (!v || typeof v !== "object") continue;
      const key = `${v.name || ""}|${v.type || ""}|${typeof v.size === "number" ? v.size : ""}|${v.kind || ""}`;
      const exists = arr.some((x) => {
        const k = `${x.name || ""}|${x.type || ""}|${typeof x.size === "number" ? x.size : ""}|${x.kind || ""}`;
        return k === key;
      });
      if (exists) continue;
      arr.push(v);
      if (arr.length >= limit) break;
    }
  }

    /**
     * Update Pending Document.
     */
    function updatePendingDocument(kind, source, fileNames = [], blobMime = null) {
    pendingDocument.version += 1;
    pendingDocument.lastEventAtMs = Date.now();
    if (source) pendingDocument.sources.add(source);
    if (kind) pendingDocument.kinds.add(kind);
    if (blobMime) pendingDocument.blobMimes.add(blobMime);
    pushUniqueLimited(pendingDocument.files, fileNames, 12);
  }

    /**
     * Reset Pending Document.
     */
    function resetPendingDocument() {
    pendingDocument.version = 0;
    pendingDocument.lastEventAtMs = null;
    pendingDocument.sources.clear();
    pendingDocument.kinds.clear();
    pendingDocument.files = [];
    pendingDocument.blobMimes.clear();
  }

    /**
     * Update Pending Attachments.
     */
    function updatePendingAttachments(source, filesMeta = []) {
    pendingAttachments.version += 1;
    pendingAttachments.lastEventAtMs = Date.now();
    if (source) pendingAttachments.sources.add(source);
    pushUniqueFileMetaLimited(pendingAttachments.files, filesMeta, 20);
  }

    /**
     * Reset Pending Attachments.
     */
    function resetPendingAttachments() {
    pendingAttachments.version = 0;
    pendingAttachments.lastEventAtMs = null;
    pendingAttachments.sources.clear();
    pendingAttachments.files = [];
  }

    /**
     * Register Attachment Files Event.
     */
    function registerAttachmentFilesEvent(files, source, traceId = null) {
    if (!files || typeof files.length !== "number") return;

    const fileMetas = [];
    for (const f of files) {
      if (!f || typeof f !== "object") continue;
      const mime = typeof f.type === "string" ? f.type.toLowerCase() : "";
      const name = typeof f.name === "string" ? f.name : null;
      const size = typeof f.size === "number" ? f.size : null;
      fileMetas.push({
        name,
        type: mime || null,
        size,
        kind: classifyAttachmentKind(mime, name)
      });
    }
    if (!fileMetas.length) return;

    attachmentSignal.totalEvents += fileMetas.length;
    attachmentSignal.lastEventAtMs = Date.now();
    attachmentSignal.lastSource = source;
    attachmentSignal.lastFiles = fileMetas.slice(0, 8);
    for (const f of fileMetas) {
      const k = f.kind || "other";
      attachmentSignal.kindCounts[k] = (attachmentSignal.kindCounts[k] || 0) + 1;
    }
    updatePendingAttachments(source, fileMetas);

    debugLog(traceId, "Attachment file event detected", {
      source,
      file_count: fileMetas.length,
      files: fileMetas
    });
    emitProbe("attachment_file_event_detected", {
      source,
      file_count: fileMetas.length,
      files: fileMetas
    });
  }

    /**
     * Register Attachment Signal.
     */
    function registerAttachmentSignal(source, meta = {}, traceId = null) {
    if (!meta || typeof meta !== "object") return;

    const mime = typeof meta.mime === "string" ? meta.mime.toLowerCase() : "";
    const fileMeta = {
      name: typeof meta.name === "string" ? meta.name : null,
      type: mime || null,
      size: typeof meta.size_bytes === "number" ? meta.size_bytes : null,
      kind: classifyAttachmentKind(mime, null)
    };

    attachmentSignal.totalEvents += 1;
    attachmentSignal.lastEventAtMs = Date.now();
    attachmentSignal.lastSource = source;
    attachmentSignal.lastFiles = [fileMeta];
    const k = fileMeta.kind || "other";
    attachmentSignal.kindCounts[k] = (attachmentSignal.kindCounts[k] || 0) + 1;
    updatePendingAttachments(source, [fileMeta]);

    debugLog(traceId, "Attachment signal detected", { source, file: fileMeta });
    emitProbe("attachment_signal_detected", { source, file: fileMeta });
  }

    /**
     * Register Document File Event.
     */
    function registerDocumentFileEvent(files, source, traceId = null) {
    if (!files || typeof files.length !== "number") return;
    registerAttachmentFilesEvent(files, source, traceId);
    emitProbe("candidate_file_event_observed", {
      source,
      file_count: files.length,
      files: summarizeFiles(files)
    });
    debugLog(traceId, "Candidate file event observed", {
      source,
      file_count: files.length,
      files: summarizeFiles(files)
    });

    const matched = [];
    for (const f of files) {
      const info = detectDocumentFileInfo(f);
      if (info) matched.push({ file: f, info });
    }
    if (!matched.length) {
      emitProbe("candidate_file_event_not_document", { source });
      debugLog(traceId, "Candidate file event not matched as document", { source });
      return;
    }

    const kindCounts = { pdf: 0, text: 0, other: 0 };
    for (const m of matched) {
      kindCounts[m.info.kind] = (kindCounts[m.info.kind] || 0) + 1;
    }
    const dominantKind = (kindCounts.pdf >= kindCounts.text) ? "pdf" : "text";

    documentSignal.totalEvents += matched.length;
    documentSignal.lastEventAtMs = Date.now();
    documentSignal.lastSource = source;
    documentSignal.lastKind = dominantKind;
    documentSignal.kindCounts.pdf += kindCounts.pdf;
    documentSignal.kindCounts.text += kindCounts.text;
    documentSignal.lastFiles = matched
      .map((m) => (typeof m.file.name === "string" ? m.file.name : "unknown.file"))
      .slice(0, 5);
    updatePendingDocument(
      dominantKind,
      source,
      matched.map((m) => (typeof m.file.name === "string" ? m.file.name : null))
    );

    debugLog(traceId, "Document attach event detected", {
      source,
      matchedCount: matched.length,
      dominantKind,
      files: documentSignal.lastFiles
    });
    emitProbe("document_attach_event_detected", {
      source,
      matched_count: matched.length,
      dominant_kind: dominantKind,
      files: documentSignal.lastFiles
    });
  }

    /**
     * Register Document Signal.
     */
    function registerDocumentSignal(kind, source, meta = {}, traceId = null) {
    const normalizedKind = kind === "pdf" || kind === "text" ? kind : "other";

    documentSignal.totalEvents += 1;
    documentSignal.lastEventAtMs = Date.now();
    documentSignal.lastSource = source;
    documentSignal.lastKind = normalizedKind;
    documentSignal.kindCounts[normalizedKind] = (documentSignal.kindCounts[normalizedKind] || 0) + 1;

    if (meta && typeof meta === "object") {
      if (typeof meta.blob_url === "string") documentSignal.lastBlobUrl = meta.blob_url;
      if (typeof meta.mime === "string") documentSignal.lastBlobMime = meta.mime;
      if (typeof meta.size_bytes === "number") documentSignal.lastBlobBytes = meta.size_bytes;
    }
    updatePendingDocument(
      normalizedKind,
      source,
      [],
      typeof meta?.mime === "string" ? meta.mime : null
    );

    debugLog(traceId, "Document signal detected", { kind: normalizedKind, source, meta });
    emitProbe("document_signal_detected", { kind: normalizedKind, source, meta });
  }

    /**
     * Install Blob Hooks.
     */
    function installBlobHooks() {
    if (!originalCreateObjectURL || !window.URL) return;

    window.URL.createObjectURL = function (obj) {
      const createdUrl = originalCreateObjectURL(obj);

      try {
        const mime = typeof obj?.type === "string" ? obj.type.toLowerCase() : "";
        const size = typeof obj?.size === "number" ? obj.size : null;
        emitProbe("create_object_url_observed", {
          url: createdUrl,
          mime: mime || null,
          size_bytes: size
        });
        debugLog(null, "createObjectURL observed", {
          url: createdUrl,
          mime: mime || null,
          size_bytes: size
        });
        if (mime) {
          blobUrlMeta.set(createdUrl, { mime, size_bytes: size, created_at_ms: Date.now() });
        }
        if (mime || typeof size === "number") {
          registerAttachmentSignal("blob.create_object_url", {
            mime,
            size_bytes: size
          });
        }

        const kind = classifyDocumentKind(mime, "");
        if (kind) {
          registerDocumentSignal(kind, "blob.create_object_url", {
            blob_url: createdUrl,
            mime,
            size_bytes: size
          });
        } else {
          emitProbe("create_object_url_not_document", { url: createdUrl, mime: mime || null });
          debugLog(null, "createObjectURL not document", { url: createdUrl, mime: mime || null });
        }
      } catch {}

      return createdUrl;
    };
  }

    /**
     * Install Document Hooks.
     */
    function installDocumentHooks() {
    document.addEventListener("change", (event) => {
      const t = event && event.target;
      emitProbe("dom_change_observed", {
        target_tag: t?.tagName || null,
        input_type: t?.type || null
      });
      debugLog(null, "DOM change observed", {
        target_tag: t?.tagName || null,
        input_type: t?.type || null
      });
      if (!t || t.tagName !== "INPUT" || t.type !== "file") return;
      registerDocumentFileEvent(t.files, "input.change");
    }, true);

    document.addEventListener("drop", (event) => {
      const files = event?.dataTransfer?.files;
      emitProbe("dom_drop_observed", { file_count: files?.length ?? 0 });
      debugLog(null, "DOM drop observed", {
        file_count: files?.length ?? 0
      });
      registerDocumentFileEvent(files, "drag.drop");
    }, true);

    document.addEventListener("paste", (event) => {
      const files = event?.clipboardData?.files;
      emitProbe("dom_paste_observed", { file_count: files?.length ?? 0 });
      debugLog(null, "DOM paste observed", {
        file_count: files?.length ?? 0
      });
      registerDocumentFileEvent(files, "clipboard.paste");
    }, true);
  }

    /**
     * Get Document Meta For Request.
     */
    function getDocumentMetaForRequest() {
    const nowMs = Date.now();
    const lastAt = pendingDocument.lastEventAtMs || documentSignal.lastEventAtMs;
    const ageMs = typeof lastAt === "number" ? Math.max(0, nowMs - lastAt) : null;
    const withinWindow = typeof ageMs === "number" && ageMs <= DOCUMENT_EVENT_WINDOW_MS;
    const withinBlobWindow = typeof ageMs === "number" && ageMs <= DOCUMENT_BLOB_SIGNAL_WINDOW_MS;
    const hasUnconsumedPending = pendingDocument.version > 0 && pendingDocument.version > lastConsumedPendingVersion;
    const unconsumed = Boolean(hasUnconsumedPending || (typeof lastAt === "number" && lastAt > documentSignal.lastConsumedEventAtMs));
    const hasDocument = Boolean((withinWindow || withinBlobWindow) && unconsumed);

    const pendingKinds = Array.from(pendingDocument.kinds);
    const pendingSources = Array.from(pendingDocument.sources);
    const pendingFiles = [...pendingDocument.files];
    const pendingBlobMimes = Array.from(pendingDocument.blobMimes);

    if (hasDocument && typeof lastAt === "number") {
      documentSignal.lastConsumedEventAtMs = lastAt;
      lastConsumedPendingVersion = pendingDocument.version;
      resetPendingDocument();
    }

    return {
      hasDocument,
      document: {
        detected: hasDocument,
        kind: pendingKinds.length > 1 ? "mixed" : (pendingKinds.length === 1 ? pendingKinds[0] : documentSignal.lastKind),
        kinds_seen: pendingKinds,
        sources_seen: pendingSources,
        files_seen: pendingFiles,
        blob_mimes_seen: pendingBlobMimes,
        detector: "event_heuristic_v2",
        window_ms: DOCUMENT_EVENT_WINDOW_MS,
        last_event_at_ms: lastAt,
        last_event_age_ms: ageMs,
        last_event_source: documentSignal.lastSource,
        last_files: Array.isArray(documentSignal.lastFiles) ? [...documentSignal.lastFiles] : [],
        last_blob_url: documentSignal.lastBlobUrl,
        last_blob_mime: documentSignal.lastBlobMime,
        last_blob_bytes: documentSignal.lastBlobBytes,
        total_document_events_seen: documentSignal.totalEvents,
        total_pdf_events_seen: documentSignal.kindCounts.pdf,
        total_text_events_seen: documentSignal.kindCounts.text
      }
    };
  }

    /**
     * Get Attachment Meta For Request.
     */
    function getAttachmentMetaForRequest() {
    const nowMs = Date.now();
    const lastAt = pendingAttachments.lastEventAtMs || attachmentSignal.lastEventAtMs;
    const ageMs = typeof lastAt === "number" ? Math.max(0, nowMs - lastAt) : null;
    const withinWindow = typeof ageMs === "number" && ageMs <= ATTACHMENT_EVENT_WINDOW_MS;
    const hasUnconsumedPending =
      pendingAttachments.version > 0 && pendingAttachments.version > lastConsumedAttachmentVersion;
    const unconsumed = Boolean(
      hasUnconsumedPending || (typeof lastAt === "number" && lastAt > attachmentSignal.lastConsumedEventAtMs)
    );

    const pendingSources = Array.from(pendingAttachments.sources);
    const pendingFiles = pendingAttachments.files.map((f) => ({ ...f }));
    const hasFiles = Boolean(withinWindow && unconsumed && pendingFiles.length);
    const filesTotalBytes = pendingFiles.reduce((sum, f) => {
      return sum + (typeof f.size === "number" && Number.isFinite(f.size) ? f.size : 0);
    }, 0);
    const kindsSeen = Array.from(new Set(pendingFiles.map((f) => f.kind).filter(Boolean)));

    if (hasFiles && typeof lastAt === "number") {
      attachmentSignal.lastConsumedEventAtMs = lastAt;
      lastConsumedAttachmentVersion = pendingAttachments.version;
      resetPendingAttachments();
    }

    return {
      hasFiles,
      attachment: {
        detected: hasFiles,
        file_count: pendingFiles.length,
        file_bytes_total: filesTotalBytes,
        kinds_seen: kindsSeen,
        sources_seen: pendingSources,
        files: pendingFiles,
        detector: "event_heuristic_v1",
        window_ms: ATTACHMENT_EVENT_WINDOW_MS,
        last_event_at_ms: lastAt,
        last_event_age_ms: ageMs,
        last_event_source: attachmentSignal.lastSource,
        last_files: Array.isArray(attachmentSignal.lastFiles)
          ? attachmentSignal.lastFiles.map((f) => ({ ...f }))
          : [],
        total_attachment_events_seen: attachmentSignal.totalEvents,
        total_pdf_events_seen: attachmentSignal.kindCounts.pdf,
        total_text_events_seen: attachmentSignal.kindCounts.text,
        total_image_events_seen: attachmentSignal.kindCounts.image,
        total_audio_events_seen: attachmentSignal.kindCounts.audio,
        total_other_events_seen: attachmentSignal.kindCounts.other
      }
    };
  }

    /**
     * Is Chat Completions Url.
     */
    function isChatCompletionsUrl(url) {
    try {
      const u = typeof url === "string"
        ? new URL(url, location.href)
        : new URL(url.url, location.href);
      return u.pathname.endsWith("/v1/chat/completions");
    } catch {
      return false;
    }
  }

    /**
     * Estimate Messages Bytes And Counts.
     */
    function estimateMessagesBytesAndCounts(bodyObj) {
    const messages = Array.isArray(bodyObj?.messages) ? bodyObj.messages : [];
    let bytes = 0;
    const byRole = {};
    const byRoleBytes = {};
    let hasImages = false;
    let imagesBytes = 0;
    let imagePartsCount = 0;
    const imageMimeTypes = new Set();
    const imageBytesByPart = [];
    const imageMimesByPart = [];
    let lastUserIndex = -1;
    const perMessageTextBytes = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const role = m?.role || "unknown";
      byRole[role] = (byRole[role] || 0) + 1;
      if (role === "user") lastUserIndex = i;
      let messageTextBytes = 0;

      const c = m?.content;

      if (typeof c === "string") {
        const textBytes = utf8Bytes(c);
        bytes += textBytes;
        messageTextBytes += textBytes;
        byRoleBytes[role] = (byRoleBytes[role] || 0) + textBytes;
        perMessageTextBytes.push(messageTextBytes);
        continue;
      }

      if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== "object") continue;

          if (part.type === "text" && typeof part.text === "string") {
            const textBytes = utf8Bytes(part.text);
            bytes += textBytes;
            messageTextBytes += textBytes;
            byRoleBytes[role] = (byRoleBytes[role] || 0) + textBytes;
          }

          if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
            hasImages = true;
            imagePartsCount += 1;
            const url = part.image_url.url;
            let partMime = null;
            let partBytes = null;

            const m = url.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
              partMime = m[1];
              imageMimeTypes.add(partMime);
              const b64 = m[2] || "";
              const pad = (b64.endsWith("==") ? 2 : (b64.endsWith("=") ? 1 : 0));
              const decoded = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
              partBytes = decoded;
              imagesBytes += decoded;
            }
            imageBytesByPart.push(partBytes);
            imageMimesByPart.push(partMime);
          }
        }
      }

      perMessageTextBytes.push(messageTextBytes);
    }

    const currentUserTextBytes =
      (lastUserIndex >= 0 && lastUserIndex < perMessageTextBytes.length)
        ? perMessageTextBytes[lastUserIndex]
        : 0;
    const historyTextBytes = Math.max(0, bytes - currentUserTextBytes);

    return {
      messagesCount: messages.length,
      byRole,
      byRoleBytes,
      messagesBytes: bytes,
      currentUserTextBytes,
      historyTextBytes,
      hasImages,
      imagesBytes,
      imagePartsCount,
      imageBytesByPart,
      imageMimesByPart,
      imageMimeTypes: Array.from(imageMimeTypes)
    };
  }

    /**
     * Pick Params.
     */
    function pickParams(bodyObj) {
    const keys = [
      "temperature", "top_p", "top_k", "max_tokens", "seed",
      "presence_penalty", "frequency_penalty",
      "stream", "stream_options",
      "n", "stop"
    ];
    const params = {};
    for (const k of keys) {
      if (bodyObj && Object.prototype.hasOwnProperty.call(bodyObj, k)) {
        params[k] = bodyObj[k];
      }
    }
    return params;
  }

    /**
     * Pick Runtime Context.
     */
    function pickRuntimeContext(bodyObj) {
    if (!bodyObj || typeof bodyObj !== "object") return null;
    const keys = [
      "n_ctx",
      "n_batch",
      "n_ubatch",
      "n_threads",
      "n_threads_batch",
      "threads",
      "threads_batch",
      "n_gpu_layers",
      "gpu_layers",
      "main_gpu",
      "tensor_split",
      "rope_freq_base",
      "rope_freq_scale",
      "flash_attn",
      "cache_type_k",
      "cache_type_v",
      "numa",
      "seed"
    ];

    const out = {};
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(bodyObj, k)) out[k] = bodyObj[k];
    }

    return Object.keys(out).length ? out : null;
  }

    /**
     * Bytes Bucket.
     */
    function bytesBucket(x) {
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return "unknown";
    if (x === 0) return "0B";
    if (x <= 10 * 1024) return "1B-10KB";
    if (x <= 100 * 1024) return "10KB-100KB";
    if (x <= 500 * 1024) return "100KB-500KB";
    if (x <= 1024 * 1024) return "500KB-1MB";
    if (x <= 5 * 1024 * 1024) return "1MB-5MB";
    return ">5MB";
  }

    /**
     * Derive Input Mode.
     */
    function deriveInputMode({ textBytes = 0, hasFiles = false, hasImages = false }) {
    const hasText = typeof textBytes === "number" && textBytes > 0;
    if (hasText && hasFiles && hasImages) return "text+file+image";
    if (hasText && hasFiles) return "text+file";
    if (hasText && hasImages) return "text+image";
    if (hasFiles && hasImages) return "file+image";
    if (hasFiles) return "file_only";
    if (hasImages) return "image_only";
    if (hasText) return "text_only";
    return "empty_or_unknown";
  }

    /**
     * Derive Runtime Bucket.
     */
    function deriveRuntimeBucket(runtimeContext) {
    if (!runtimeContext || typeof runtimeContext !== "object") return "default_or_unknown";
    const gpuLayers = runtimeContext.n_gpu_layers ?? runtimeContext.gpu_layers ?? null;
    const threads = runtimeContext.n_threads ?? runtimeContext.threads ?? null;
    const hasCtx = Object.prototype.hasOwnProperty.call(runtimeContext, "n_ctx");

    if (typeof gpuLayers === "number" && gpuLayers > 0) return "gpu_offload";
    if (typeof threads === "number" && threads > 0 && hasCtx) return "cpu_tuned";
    if (typeof threads === "number" && threads > 0) return "cpu_threads_set";
    if (hasCtx) return "ctx_set";
    return "runtime_set_other";
  }

    /**
     * Derive Scenario Labels.
     */
    function deriveScenarioLabels({ msgInfo, attachmentMeta, runtimeContext }) {
    const textBytes = msgInfo?.currentUserTextBytes ?? msgInfo?.messagesBytes ?? null;
    const fileBytes = attachmentMeta?.attachment?.file_bytes_total ?? null;
    const imageBytes = msgInfo?.imagesBytes ?? null;
    const hasFiles = Boolean(attachmentMeta?.hasFiles);
    const hasImages = Boolean(msgInfo?.hasImages);
    const kinds = Array.isArray(attachmentMeta?.attachment?.kinds_seen)
      ? attachmentMeta.attachment.kinds_seen.filter(Boolean)
      : [];

    return {
      input_mode: deriveInputMode({ textBytes, hasFiles, hasImages }),
      current_user_text_size_bucket: bytesBucket(textBytes),
      file_size_bucket: bytesBucket(fileBytes),
      image_size_bucket: bytesBucket(imageBytes),
      file_kind_set: kinds.length ? [...kinds].sort().join("+") : "none",
      runtime_bucket: deriveRuntimeBucket(runtimeContext)
    };
  }

    /**
     * Categorize Finish Reason.
     */
    function categorizeFinishReason(finishReason) {
    if (finishReason === "stop") return "completed";
    if (finishReason === "length") return "truncated_length";
    if (finishReason === "content_filter") return "filtered";
    if (finishReason === "tool_calls") return "tool_calls";
    if (finishReason === null || typeof finishReason === "undefined") return "unknown";
    return "other";
  }

    /**
     * Parse Sse Clone And Emit Record.
     */
    async function parseSseCloneAndEmitRecord(traceId, response, requestMeta, timingContext = {}) {
    const clone = response.clone();
    const contentType = clone.headers.get("content-type") || "";
    const isSse = contentType.includes("text/event-stream");

    if (!isSse || !clone.body) return;

    debugLog(traceId, "SSE detected, beginning parse", { contentType });

    const reader = clone.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let completionId = null;
    let completionCreated = null;
    let completionModel = null;
    let systemFingerprint = null;

    let reasoningBoundary = null; // { predicted_n, predicted_ms }
    let stopChunk = null;
    let lastTimingsAtStop = null;
    let stopFinishReason = null;
    let lastTimedChunk = null;
    let sawDoneMarker = false;
    let firstStreamChunkAtMs = null;
    let stopChunkAtMs = null;
    let responseText = "";
    let reasoningText = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstStreamChunkAtMs === null) firstStreamChunkAtMs = Date.now();

        buffer += decoder.decode(value, { stream: true });

        let lineEnd;
        while ((lineEnd = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, lineEnd).trimEnd();
          buffer = buffer.slice(lineEnd + 1);

          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (!data) continue;

          if (data === "[DONE]") {
            sawDoneMarker = true;
            debugLog(traceId, "SSE DONE marker received");
            if (!stopChunk && lastTimedChunk) {
              stopChunk = lastTimedChunk;
              lastTimingsAtStop = lastTimedChunk.timings || null;
              stopFinishReason = (Array.isArray(lastTimedChunk.choices) ? lastTimedChunk.choices[0]?.finish_reason : null) ?? "done";
              stopChunkAtMs = Date.now();
              debugLog(traceId, "DONE marker used as completion boundary", { finish_reason: stopFinishReason });
              break;
            }
            continue;
          }

          const chunk = safeJsonParse(data);
          if (!chunk || chunk.object !== "chat.completion.chunk") continue;

          completionId = completionId || chunk.id || null;
          completionCreated = completionCreated || chunk.created || null;
          completionModel = completionModel || chunk.model || null;
          systemFingerprint = systemFingerprint || chunk.system_fingerprint || null;

          const choice0 = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
          const delta = choice0?.delta || {};
          const finishReason = choice0?.finish_reason ?? null;

          if (typeof delta.content === "string" && responseText.length < MAX_CAPTURED_TEXT_CHARS) {
            const remaining = MAX_CAPTURED_TEXT_CHARS - responseText.length;
            if (remaining > 0) responseText += delta.content.slice(0, remaining);
          }
          if (typeof delta.reasoning_content === "string" && reasoningText.length < MAX_CAPTURED_TEXT_CHARS) {
            const remaining = MAX_CAPTURED_TEXT_CHARS - reasoningText.length;
            if (remaining > 0) reasoningText += delta.reasoning_content.slice(0, remaining);
          }

          if (chunk.timings) {
            lastTimedChunk = chunk;
          }

          if (typeof delta.reasoning_content === "string" && chunk.timings) {
            reasoningBoundary = {
              predicted_n: chunk.timings.predicted_n,
              predicted_ms: chunk.timings.predicted_ms
            };
            debugLog(traceId, "Reasoning boundary updated", reasoningBoundary);
          }

          if (typeof finishReason === "string" && finishReason.length > 0) {
            stopChunk = chunk;
            lastTimingsAtStop = chunk.timings || null;
            stopFinishReason = finishReason;
            stopChunkAtMs = Date.now();
            debugLog(traceId, "Final chunk received", { finishReason, timings: lastTimingsAtStop });
            break;
          }
        }

        if (stopChunk) break;
      }
    } catch (e) {
      debugLog(traceId, "SSE parse error", e);
      return;
    } finally {
      try { reader.releaseLock(); } catch {}
    }

    if ((!stopChunk || !lastTimingsAtStop) && lastTimedChunk && sawDoneMarker) {
      stopChunk = lastTimedChunk;
      lastTimingsAtStop = lastTimedChunk.timings || null;
      stopFinishReason = (Array.isArray(lastTimedChunk.choices) ? lastTimedChunk.choices[0]?.finish_reason : null) ?? "done";
      stopChunkAtMs = Date.now();
    }

    if (!stopChunk || !lastTimingsAtStop) {
      debugLog(traceId, "No STOP chunk found; skipping record emit");
      return;
    }

    const totalPredN = lastTimingsAtStop.predicted_n ?? null;
    const totalPredMs = lastTimingsAtStop.predicted_ms ?? null;

    const rPredN = reasoningBoundary?.predicted_n ?? 0;
    const rPredMs = reasoningBoundary?.predicted_ms ?? 0;

    const cPredN = (typeof totalPredN === "number") ? Math.max(0, totalPredN - rPredN) : null;
    const cPredMs = (typeof totalPredMs === "number") ? Math.max(0, totalPredMs - rPredMs) : null;
    const finishReasonFinal = stopFinishReason ?? "stop";
    const outputTokensEstimate = (typeof totalPredN === "number" && Number.isFinite(totalPredN)) ? totalPredN : null;
    const outputCharsEstimate =
      (typeof outputTokensEstimate === "number" && Number.isFinite(outputTokensEstimate))
        ? Math.round(outputTokensEstimate * 4)
        : null;
    const requestStartMs = typeof timingContext.request_start_ms === "number" ? timingContext.request_start_ms : null;
    const responseHeadersMs = typeof timingContext.response_headers_ms === "number" ? timingContext.response_headers_ms : null;
    const stopMs = typeof stopChunkAtMs === "number" ? stopChunkAtMs : Date.now();

    const durRequestToHeaders =
      (requestStartMs !== null && responseHeadersMs !== null) ? Math.max(0, responseHeadersMs - requestStartMs) : null;
    const durRequestToFirstChunk =
      (requestStartMs !== null && firstStreamChunkAtMs !== null) ? Math.max(0, firstStreamChunkAtMs - requestStartMs) : null;
    const durHeadersToFirstChunk =
      (responseHeadersMs !== null && firstStreamChunkAtMs !== null) ? Math.max(0, firstStreamChunkAtMs - responseHeadersMs) : null;
    const durFirstChunkToStop =
      (firstStreamChunkAtMs !== null && stopMs !== null) ? Math.max(0, stopMs - firstStreamChunkAtMs) : null;
    const durHeadersToStop =
      (responseHeadersMs !== null && stopMs !== null) ? Math.max(0, stopMs - responseHeadersMs) : null;
    const durRequestToStop =
      (requestStartMs !== null && stopMs !== null) ? Math.max(0, stopMs - requestStartMs) : null;

    const record = {
      v: 1,
      trace_id: traceId, // NEW
      promptText: clipCapturedText(requestMeta?.promptText ?? null),
      responseText,
      ReasoningText: reasoningText.length ? reasoningText : null,
      captured_at_ms: Date.now(),
      ui_origin: location.origin,
      endpoint: "/v1/chat/completions",
      streamed: true,

      req: requestMeta,

      resp: {
        id: completionId,
        created: completionCreated,
        model: completionModel,
        fingerprint: systemFingerprint,
        choice_index: 0,
        finish_reason: finishReasonFinal,

        timings: {
          cache_n: lastTimingsAtStop.cache_n ?? null,
          prompt_n: lastTimingsAtStop.prompt_n ?? null,
          prompt_ms: roundMs(lastTimingsAtStop.prompt_ms ?? null),
          predicted_n: lastTimingsAtStop.predicted_n ?? null,
          predicted_ms: roundMs(lastTimingsAtStop.predicted_ms ?? null),
          prompt_tps: lastTimingsAtStop.prompt_per_second ?? null,
          predicted_tps: lastTimingsAtStop.predicted_per_second ?? null
        },

        phase_boundary: reasoningBoundary
          ? {
              reasoning_final_predicted_n: reasoningBoundary.predicted_n,
              reasoning_final_predicted_ms: roundMs(reasoningBoundary.predicted_ms)
            }
          : null,

        derived: {
          reasoning_n: reasoningBoundary ? rPredN : 0,
          reasoning_ms: reasoningBoundary ? roundMs(rPredMs) : 0,
          content_n: reasoningBoundary ? cPredN : (typeof totalPredN === "number" ? totalPredN : null),
          content_ms: reasoningBoundary
            ? roundMs(cPredMs)
            : (typeof totalPredMs === "number" ? roundMs(totalPredMs) : null)
        },

        client_timing: {
          request_start_ms: requestStartMs,
          response_headers_ms: responseHeadersMs,
          first_stream_chunk_ms: firstStreamChunkAtMs,
          stop_chunk_ms: stopMs,
          duration_request_to_headers_ms: durRequestToHeaders,
          duration_request_to_first_stream_chunk_ms: durRequestToFirstChunk,
          duration_headers_to_first_stream_chunk_ms: durHeadersToFirstChunk,
          duration_first_stream_chunk_to_stop_ms: durFirstChunkToStop,
          duration_headers_to_stop_ms: durHeadersToStop,
          duration_request_to_stop_ms: durRequestToStop
        },

        guardrails: {
          stop_reason_category: categorizeFinishReason(finishReasonFinal),
          output_length_estimate: {
            output_tokens_estimate: outputTokensEstimate,
            output_chars_estimate: outputCharsEstimate
          }
        }
      },

      err: null
    };

    debugLog(traceId, "Emitting final record", record);
    window.postMessage({ type: "LLAMACPP_METRICS_RECORD", record }, "*");
  }

  window.fetch = async function (input, init) {
    const url = (typeof input === "string") ? input : (input && input.url ? input.url : "");
    const shouldCapture = isChatCompletionsUrl(url);
    const isBlobUrlRequest = typeof url === "string" && url.startsWith("blob:");
    const method = (init && typeof init.method === "string" ? init.method : "GET").toUpperCase();

    if (typeof url === "string" && (url.includes("/v1/") || isBlobUrlRequest)) {
      emitProbe("fetch_observed", {
        method,
        url,
        should_capture: shouldCapture,
        is_blob_url: isBlobUrlRequest
      });
      debugLog(null, "Fetch observed", { method, url, should_capture: shouldCapture, is_blob_url: isBlobUrlRequest });
    }

    if (isBlobUrlRequest) {
      const meta = blobUrlMeta.get(url) || null;
      const mime = typeof meta?.mime === "string" ? meta.mime : "";
      if (meta) {
        registerAttachmentSignal("fetch.blob_url", {
          mime,
          size_bytes: typeof meta?.size_bytes === "number" ? meta.size_bytes : null
        });
      }
      const kind = classifyDocumentKind(mime, "");
      if (kind) {
        registerDocumentSignal(kind, "fetch.blob_url", {
          blob_url: url,
          mime,
          size_bytes: meta?.size_bytes ?? null
        });
      }
      emitProbe("blob_fetch_observed", { url, mime: mime || null, meta });
      debugLog(null, "Blob fetch observed", { url, meta });
    }

    // Create trace early (only if this request is relevant)
    const traceId = shouldCapture ? makeTraceId() : null;
    const requestStartMs = shouldCapture ? Date.now() : null;

    if (shouldCapture) debugLog(traceId, "Chat completion fetch detected", url);

    const response = await originalFetch.apply(this, arguments);
    const responseHeadersMs = shouldCapture ? Date.now() : null;

    if (!shouldCapture) return response;

    let bodyStr = null;
    let bodyObj = null;

    try {
      if (init && typeof init.body === "string") {
        bodyStr = init.body;
        bodyObj = safeJsonParse(bodyStr);
      }
    } catch {
      bodyStr = null;
      bodyObj = null;
    }

    const bodyBytes = bodyStr ? utf8Bytes(bodyStr) : null;
    let reqMeta = {
      model: bodyObj?.model ?? null,
      body_bytes: bodyBytes,
      messages_count: null,
      messages_bytes: null,
      images_bytes: null,
      has_images: null,
      has_files: false,
      files_count: 0,
      files_total_bytes: 0,
      files: [],
      attachment: null,
      has_document: false,
      document: null,
      params: bodyObj ? pickParams(bodyObj) : null,
      prompt_identity: {
        hash_algorithm: "SHA-256",
        prompt_hash: null,
        message_structure_hash: null,
        version: "v1"
      },
      runtime_context: bodyObj ? pickRuntimeContext(bodyObj) : null,
      input_composition: {},
      payload_signals: {},
      scenario_labels: {}
    };

    try {
      const msgInfo = bodyObj ? estimateMessagesBytesAndCounts(bodyObj) : {
        messagesCount: null,
        byRole: null,
        byRoleBytes: null,
        messagesBytes: null,
        currentUserTextBytes: null,
        historyTextBytes: null,
        hasImages: null,
        imagesBytes: null,
        imagePartsCount: null,
        imageBytesByPart: null,
        imageMimesByPart: null,
        imageMimeTypes: null
      };

      const docMeta = getDocumentMetaForRequest();
      const attachmentMeta = getAttachmentMetaForRequest();
      const promptIdentity = await buildPromptIdentity(bodyObj);

      reqMeta = {
        ...reqMeta,
        promptText: getCurrentUserPromptText(bodyObj),
        messages_count: msgInfo.messagesCount,
        messages_bytes: msgInfo.messagesBytes,
        images_bytes: msgInfo.imagesBytes,
        has_images: msgInfo.hasImages,
        has_files: attachmentMeta.hasFiles,
        files_count: attachmentMeta.attachment.file_count,
        files_total_bytes: attachmentMeta.attachment.file_bytes_total,
        files: attachmentMeta.attachment.files,
        attachment: attachmentMeta.attachment,
        has_document: docMeta.hasDocument,
        document: docMeta.document,
        prompt_identity: promptIdentity,
        input_composition: {
          text_bytes_total: msgInfo.messagesBytes,
          current_user_text_bytes: msgInfo.currentUserTextBytes,
          history_text_bytes: msgInfo.historyTextBytes,
          system_text_bytes: msgInfo.byRoleBytes?.system ?? null,
          assistant_text_bytes: msgInfo.byRoleBytes?.assistant ?? null,
          tool_text_bytes: msgInfo.byRoleBytes?.tool ?? null,
          messages_by_role_count: msgInfo.byRole || {},
          messages_by_role_text_bytes: msgInfo.byRoleBytes || {},
          image_parts_count: msgInfo.imagePartsCount,
          image_count: msgInfo.imagePartsCount,
          image_bytes_total: msgInfo.imagesBytes,
          image_mimes: msgInfo.imageMimeTypes || [],
          image_mimes_by_part: msgInfo.imageMimesByPart || [],
          image_bytes_by_part: msgInfo.imageBytesByPart || [],
          file_count: attachmentMeta.attachment.file_count,
          file_bytes_total: attachmentMeta.attachment.file_bytes_total
        },
        payload_signals: {
          current_user_text_bytes: msgInfo.currentUserTextBytes,
          file_bytes_total: attachmentMeta.attachment.file_bytes_total
        }
      };
      reqMeta.scenario_labels = deriveScenarioLabels({
        msgInfo,
        attachmentMeta,
        runtimeContext: reqMeta.runtime_context
      });
    } catch (e) {
      debugLog(traceId, "Request metadata build failed; using fallback", String(e?.message || e));
      emitProbe("request_meta_build_error", {
        trace_id: traceId,
        error: String(e?.message || e)
      });
    }

    debugLog(traceId, "Request metadata", reqMeta);

    // Parse in the background; do not block UI
    parseSseCloneAndEmitRecord(traceId, response, reqMeta, {
      request_start_ms: requestStartMs,
      response_headers_ms: responseHeadersMs
    });

    return response;
  };

  installDocumentHooks();
  installBlobHooks();
  window.postMessage({ type: "LLAMACPP_INJECT_READY" }, "*");
  emitProbe("inject_ready_posted");
  debugLog(null, "Injected ready signal posted");
  debugLog(null, "Document hooks installed");
  debugLog(null, "Blob hooks installed");
  debugLog(null, "Fetch hook installed");
})();
