// A local OrcaRouter configuration surface.
//
// `google-surf-mcp orcarouter ui` serves this on 127.0.0.1 and opens it. It is
// the browser-facing half of the provider: it shows the two authentication
// entry points and the capability-filtered model selectors.
//
// The API key never reaches the browser. Catalog discovery runs on this
// server-side process and only minimal model metadata is sent to the page —
// the same key boundary the rest of this project uses.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  loadStoredCredential,
  looksLikeOrcaKey,
  redactKey,
  resolveCredential,
  saveApiKeyCredential,
  clearStoredCredential,
  needsReauth,
} from './credentials.js';
import { resolveEndpoints } from './endpoints.js';
import {
  defaultChatModel,
  discoverModels,
  filterByCapability,
  type OrcaCapability,
  type OrcaCatalog,
} from './models.js';

const MAX_BODY_BYTES = 64 * 1024;
const CATALOG_TTL_MS = 60_000;

export interface UiServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  /** Catalog snapshot for tests, refreshed on the same cache the UI uses. */
  catalog: (capability: OrcaCapability, inputModality?: string) => Promise<OrcaCatalog>;
}

/** Server-side catalog cache: one fetch per capability serves every selector. */
function createCatalogCache() {
  const cached = new Map<string, { at: number; catalog: OrcaCatalog }>();
  return {
    async get(
      apiKey: string | undefined,
      capability: OrcaCapability,
      now: () => number,
    ): Promise<OrcaCatalog> {
      const hit = cached.get(capability);
      if (hit && now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
      const catalog = await discoverModels({ endpoints: resolveEndpoints(), apiKey, capability });
      cached.set(capability, { at: now(), catalog });
      return catalog;
    },
    invalidate(): void {
      cached.clear();
    },
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

/**
 * Minimal model metadata for the page. Ids and capability facts only — never
 * the key, and never the raw upstream payload.
 */
function toWireModels(catalog: OrcaCatalog, capability: OrcaCapability, inputModality?: string) {
  return filterByCapability(catalog.models, capability, { inputModality }).map((model) => ({
    id: model.id,
    reasoning: model.metadata.reasoning,
    reasoningEfforts: model.metadata.reasoningEfforts,
    inputModalities: model.metadata.inputModalities,
    contextLength: model.metadata.contextLength ?? null,
  }));
}

export interface UiServerOptions {
  /** Overridable so tests can pin the catalog origin to a local fake. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const cache = createCatalogCache();

  async function catalogFor(apiKey: string | undefined, capability: OrcaCapability): Promise<OrcaCatalog> {
    return cache.get(apiKey, capability, now);
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(CONFIG_PAGE);
        return;
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        const credential = await resolveCredential(env);
        sendJson(res, 200, {
          configured: credential !== null,
          source: credential?.source ?? null,
          scope: credential?.scope ?? null,
          // Only the display form ever crosses into the browser: a one-way
          // fingerprint with no key material in it.
          keyMasked: credential ? redactKey(credential.key) : null,
          generation: credential?.generation ?? null,
          needsReauth: credential ? needsReauth(credential, env) : false,
          stored: loadStoredCredential(env) !== null,
          origins: {
            auth: resolveEndpoints(env).authBase,
            api: resolveEndpoints(env).apiBase,
          },
        });
        return;
      }

      if (url.pathname === '/api/models' && req.method === 'GET') {
        const capability = (url.searchParams.get('capability') ?? 'chat') as OrcaCapability;
        const inputModality = url.searchParams.get('input_modality') ?? undefined;
        const credential = await resolveCredential(env);
        // Ask for the catalog slice that matches the entry point: a
        // chat-filtered catalog contains no embedding or image models.
        const catalog = await catalogFor(credential?.key, capability);
        const models = toWireModels(catalog, capability, inputModality);
        sendJson(res, 200, {
          capability,
          inputModality: inputModality ?? 'text',
          // The page renders the degraded state from these two flags.
          source: catalog.source,
          degraded: catalog.degraded,
          reason: catalog.reason ?? null,
          fetchedAt: catalog.fetchedAt,
          defaultModel: capability === 'chat' && !inputModality ? defaultChatModel(catalog) : null,
          count: models.length,
          models,
        });
        return;
      }

      if (url.pathname === '/api/key' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key) {
          sendJson(res, 400, { error: 'no key supplied' });
          return;
        }
        saveApiKeyCredential(key, 'api', env);
        cache.invalidate();
        sendJson(res, 200, {
          saved: true,
          // A format check is not a validity check: no non-billing validation
          // request exists, so validity stays unknown until the first request.
          formatLooksValid: looksLikeOrcaKey(key),
          keyMasked: redactKey(key),
        });
        return;
      }

      if (url.pathname === '/api/key' && req.method === 'DELETE') {
        clearStoredCredential(env);
        cache.invalidate();
        sendJson(res, 200, { cleared: true });
        return;
      }

      if (url.pathname === '/favicon.ico') {
        // The page uses no favicon; answer explicitly so the console stays clean.
        res.writeHead(204).end();
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      sendJson(res, 500, { error: message });
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    catalog: (capability, inputModality) => catalogFor(
      (env.ORCAROUTER_API_KEY ?? env.ORCA_KEY)?.trim(),
      capability,
    )
      .then((catalog) => ({
        ...catalog,
        models: filterByCapability(catalog.models, capability, { inputModality }),
      })),
  };
}

/**
 * The configuration page. It is a plain document with no build step, matching
 * how the rest of this project ships its local viewer.
 */
const CONFIG_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OrcaRouter provider</title>
<style>
:root{--bg:#0f1115;--surface:#171a21;--surface2:#1e222b;--text:#e8eaed;--muted:#9aa0a6;
--line:#2c313c;--accent:#12b5a5;--danger:#e05c5c;--ok:#3fbf7f}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--surface:#fff;--surface2:#f0f2f5;
--text:#1f2328;--muted:#5f6672;--line:#d6dae0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 28px;font-size:13px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 4px}.card p.hint{color:var(--muted);font-size:12px;margin:0 0 14px}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=password],input[type=text],select{height:36px;padding:0 10px;border:1px solid var(--line);
border-radius:6px;background:var(--bg);color:var(--text);font:inherit;min-width:0}
input[type=password],input[type=text]{flex:1 1 320px}
button{height:36px;padding:0 14px;border-radius:6px;border:1px solid var(--line);
background:var(--surface2);color:var(--text);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#03201d;font-weight:600}
button:disabled{opacity:.5;cursor:not-allowed}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);
border:1px solid var(--line);border-radius:999px;padding:2px 10px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--danger)}
.selector{position:relative}
.trigger{width:100%;height:38px;display:flex;align-items:center;justify-content:space-between;
gap:10px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);
color:var(--text);cursor:pointer;font:inherit;text-align:left}
.trigger .caret{color:var(--muted)}
.listbox{position:absolute;z-index:20;top:calc(100% + 6px);right:0;width:360px;max-height:280px;
overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px;
box-shadow:0 12px 32px rgba(0,0,0,.35);padding:4px}
.listbox[hidden]{display:none}
.opt{padding:8px 10px;border-radius:6px;cursor:pointer;display:flex;gap:8px;align-items:baseline}
.opt:hover,.opt[aria-selected=true]{background:var(--surface2)}
.opt .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.opt .meta{color:var(--muted);font-size:11px;margin-left:auto;white-space:nowrap}
.state{font-size:12px;color:var(--muted);margin-top:10px}
.state.error{color:var(--danger)}
.notice{border:1px solid var(--line);border-left:3px solid var(--danger);border-radius:6px;
padding:10px 12px;font-size:12.5px;margin-top:12px;background:var(--surface2)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <h1>OrcaRouter</h1>
  <p class="sub">OpenAI-compatible gateway &middot; <span id="origins"></span></p>

  <div class="card" id="auth-card">
    <h2>Authentication</h2>
    <p class="hint">Either entry point is enough. Both produce the same durable OrcaRouter API key.</p>

    <div class="row" style="margin-bottom:10px">
      <span class="pill"><span class="dot" id="status-dot"></span><span id="status-text">loading</span></span>
      <span id="status-key"></span>
    </div>

    <div id="reauth-notice" class="notice" hidden></div>

    <label for="api-key">API key</label>
    <div class="row">
      <input id="api-key" type="password" name="orcarouter-api-key" autocomplete="off"
             spellcheck="false" placeholder="sk-orca-..." aria-label="OrcaRouter API key">
      <button id="save-key" class="primary" type="button">Save key</button>
      <button id="clear-key" type="button">Clear</button>
    </div>
    <div class="state" id="key-state">Paste an existing sk-orca-&hellip; key, or authorize an account below.</div>

    <div class="row" style="margin-top:18px">
      <button id="connect" class="primary" type="button">Connect with OrcaRouter</button>
      <code>google-surf-mcp orcarouter connect</code>
    </div>
    <div class="state" id="connect-state">OAuth 2.0 + PKCE in your browser. No client secret is used.</div>
  </div>

  <div class="card">
    <h2>Text model</h2>
    <p class="hint">From the live catalog, filtered to models that declare a chat endpoint.</p>
    <div class="selector" id="text-selector">
      <button class="trigger" id="text-trigger" type="button" aria-haspopup="listbox"
              aria-expanded="false" aria-label="Text model">
        <span id="text-value">Select a model</span><span class="caret">&#9662;</span>
      </button>
      <div class="listbox" id="text-listbox" role="listbox" aria-label="Text models" hidden></div>
    </div>
    <div class="state" id="text-state"></div>
  </div>

  <div class="card">
    <h2>Multimodal model</h2>
    <p class="hint">Adding an image narrows the list to chat models that declare image input.</p>
    <div class="row" style="margin-bottom:12px">
      <button id="add-image" type="button">Add image attachment</button>
      <button id="remove-image" type="button">Remove image</button>
      <span class="pill" id="attachment-pill">no attachment</span>
    </div>
    <div class="selector" id="mm-selector">
      <button class="trigger" id="mm-trigger" type="button" aria-haspopup="listbox"
              aria-expanded="false" aria-label="Multimodal model">
        <span id="mm-value">Select a model</span><span class="caret">&#9662;</span>
      </button>
      <div class="listbox" id="mm-listbox" role="listbox" aria-label="Multimodal models" hidden></div>
    </div>
    <div class="state" id="mm-state"></div>
  </div>
</div>

<script>
(function(){
  "use strict";
  var state = { attachment: null, text: null, mm: null };

  function el(id){ return document.getElementById(id); }

  function meta(model){
    var parts = [];
    if (model.reasoning) parts.push("reasoning:" + ((model.reasoningEfforts||[]).join("/") || "yes"));
    if (model.inputModalities && model.inputModalities.length) parts.push("in:" + model.inputModalities.join(","));
    if (model.contextLength) parts.push("ctx:" + model.contextLength);
    return parts.join(" ");
  }

  function renderOptions(listbox, models, current, onPick){
    listbox.textContent = "";
    models.forEach(function(model){
      var opt = document.createElement("div");
      opt.className = "opt";
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(model.id === current));
      opt.dataset.modelId = model.id;
      var id = document.createElement("span");
      id.className = "id";
      id.textContent = model.id;
      var m = document.createElement("span");
      m.className = "meta";
      m.textContent = meta(model);
      opt.appendChild(id); opt.appendChild(m);
      opt.addEventListener("click", function(){ onPick(model.id); });
      listbox.appendChild(opt);
    });
  }

  function closeAll(){
    [["text-trigger","text-listbox"],["mm-trigger","mm-listbox"]].forEach(function(pair){
      el(pair[0]).setAttribute("aria-expanded","false");
      el(pair[1]).hidden = true;
    });
  }

  // Capability-specific discovery. The server holds the key; the page never does.
  function loadModels(capability, modality, listbox, stateEl, current, onPick, onSelected){
    onSelected = onSelected || function(){};
    stateEl.className = "state";
    stateEl.textContent = "Loading " + capability + " catalog" + (modality ? " (" + modality + " input)" : "") + "…";
    var qs = "?capability=" + encodeURIComponent(capability);
    if (modality) qs += "&input_modality=" + encodeURIComponent(modality);
    fetch("/api/models" + qs).then(function(r){ return r.json(); }).then(function(data){
      if (data.degraded){
        stateEl.className = "state error";
        stateEl.textContent = "Live catalog unavailable (" + (data.reason || "error") +
          "). Showing the verified fallback list — refresh to retry.";
      } else {
        stateEl.className = "state";
        stateEl.textContent = data.count + " model(s) from " + data.source + " catalog · " + data.fetchedAt;
      }
      renderOptions(listbox, data.models, current(), onPick);
      onSelected(data);
    }).catch(function(error){
      stateEl.className = "state error";
      stateEl.textContent = "Model discovery failed: " + error.message;
      renderOptions(listbox, [], current(), onPick);
      onSelected({ models: [] });
    });
  }

  function bindSelector(triggerId, listboxId, capability, modalityOf){
    var trigger = el(triggerId), listbox = el(listboxId);
    trigger.addEventListener("click", function(){
      var open = trigger.getAttribute("aria-expanded") === "true";
      closeAll();
      if (open) return;
      trigger.setAttribute("aria-expanded", "true");
      listbox.hidden = false;
    });
  }

  document.addEventListener("click", function(event){
    if (!event.target.closest(".selector")) closeAll();
  });

  function refreshText(){
    loadModels("chat", null, el("text-listbox"), el("text-state"),
      function(){ return state.text; },
      function(id){ state.text = id; el("text-value").textContent = id; closeAll(); });
  }

  function refreshMultimodal(){
    var modality = state.attachment;
    loadModels("chat", modality, el("mm-listbox"), el("mm-state"),
      function(){ return state.mm; },
      function(id){ state.mm = id; el("mm-value").textContent = id; closeAll(); },
      function(data){
        // A selected model that is no longer compatible is cleared, never kept.
        if (state.mm && !data.models.some(function(m){ return m.id === state.mm; })){
          state.mm = null;
          el("mm-value").textContent = "Select a model";
        }
      });
  }

  function refreshStatus(){
    fetch("/api/status").then(function(r){ return r.json(); }).then(function(data){
      el("origins").textContent = "auth " + data.origins.auth + " · api " + data.origins.api;
      var dot = el("status-dot");
      var configured = data.configured && !data.needsReauth;
      dot.className = "dot " + (configured ? "ok" : (data.configured ? "warn" : ""));
      el("status-text").textContent = !data.configured ? "no credential"
        : (data.needsReauth ? "needs reauthentication" : data.source + " credential active");
      el("status-key").textContent = data.keyMasked ? "key " + data.keyMasked : "";
      var notice = el("reauth-notice");
      if (data.needsReauth){
        notice.hidden = false;
        notice.textContent = "This credential was rejected by the gateway. Reauthorize with " +
          "Connect with OrcaRouter, or paste a fresh key. The stored key is kept until you replace it.";
      } else { notice.hidden = true; }
      // Saving a new key is always available; clearing only when something is stored.
      el("clear-key").disabled = !data.stored;
      refreshText();
      refreshMultimodal();
    }).catch(function(){
      el("status-text").textContent = "status unavailable";
    });
  }

  el("save-key").addEventListener("click", function(){
    var input = el("api-key");
    var value = input.value.trim();
    if (!value){
      el("key-state").className = "state error";
      el("key-state").textContent = "Enter a key first.";
      return;
    }
    fetch("/api/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: value })
    }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
      .then(function(result){
        // The page never keeps the key: clear the field as soon as it is stored.
        input.value = "";
        if (!result.ok){
          el("key-state").className = "state error";
          el("key-state").textContent = "Could not save the key: " + (result.data.error || "unknown error");
          return;
        }
        el("key-state").className = "state";
        el("key-state").textContent = "Saved " + result.data.keyMasked +
          (result.data.formatLooksValid ? "" : " — note: this does not look like an sk-orca- key.") +
          " Validity is confirmed by the first real request.";
        refreshStatus();
      }).catch(function(error){
        el("key-state").className = "state error";
        el("key-state").textContent = "Could not save the key: " + error.message;
      });
  });

  el("clear-key").addEventListener("click", function(){
    fetch("/api/key", { method: "DELETE" }).then(function(){
      el("key-state").className = "state";
      el("key-state").textContent = "Stored credential cleared.";
      refreshStatus();
    });
  });

  el("connect").addEventListener("click", function(){
    // The browser cannot run the loopback flow; it hands off to the local CLI,
    // which owns the listener and the verifier.
    el("connect-state").className = "state";
    el("connect-state").textContent =
      "Run " + String.fromCharCode(96) + "google-surf-mcp orcarouter connect" +
      String.fromCharCode(96) + " in this machine's terminal to open the consent screen.";
  });

  el("add-image").addEventListener("click", function(){
    state.attachment = "image";
    el("attachment-pill").textContent = "image attached";
    refreshMultimodal();
  });

  el("remove-image").addEventListener("click", function(){
    state.attachment = null;
    el("attachment-pill").textContent = "no attachment";
    refreshMultimodal();
  });

  bindSelector("text-trigger", "text-listbox");
  bindSelector("mm-trigger", "mm-listbox");
  refreshStatus();
})();
</script>
</body>
</html>`;
