# Configuration

Environment variables, embedded resource budgets, and optional OrcaRouter repair setup.

[Back to README](../README.md) | [Getting started](getting-started.md) | [Tools](tools.md) | [Auto Ontology](auto-ontology.md) | [Operations](operations.md)

## Env vars

| var | default | notes |
|---|---|---|
| `SEARCH_API` | unset | SearchApi API key. Required only when either provider setting is `searchapi` or `fallback`. Sent as a bearer token and never placed in the request URL. |
| `SEARCHAPI_API_KEY` | unset | Alias for `SEARCH_API`. |
| `SURF_SEARCH_PROVIDER` | `browser` | Provider for `search` and `search_parallel`: `browser`, `searchapi`, or `fallback`. |
| `SURF_SCHOLAR_PROVIDER` | `browser` | Provider for `scholar_search`: `browser`, `searchapi`, or `fallback`. |
| `SURF_BROWSER_ENGINE` | `auto` | Browser engine: `auto`, `native`, or `playwright`. Native Chrome performs the request before read-only CDP attachment. |
| `CHROME_PATH` | auto-detected | absolute path to Chrome binary |
| `SURF_PROFILE_ROOT` | `~/.google-surf-mcp` | where the warm profile lives |
| `SURF_RESEARCH` | `true` | enables Auto Ontology: local project memory, capture, indexing, `project_memory_search`, and `project_memory`; set `false` for search and extraction only |
| `SURF_RETRIEVAL_MODE` | `hybrid` | Auto Ontology search route: `live` or `hybrid`; used only when `SURF_RESEARCH=true` |
| `SURF_RESEARCH_ROOT` | `<profile>/research` | embedded SurrealDB data directory |
| `SURF_RESEARCH_DB_ENDPOINT` | unset | optional remote SurrealDB endpoint; requires `wss`/`https`, except `ws`/`http` is allowed for localhost |
| `SURF_RESEARCH_DB_NAMESPACE` | `google_surf` | SurrealDB namespace used by the Auto Ontology catalog |
| `SURF_RESEARCH_DB_DATABASE` | `research` | SurrealDB database used by the Auto Ontology catalog |
| `SURF_RESEARCH_DB_TOKEN` | unset | bearer token for a remote Auto Ontology database; alternatively set `SURF_RESEARCH_DB_USERNAME` and `SURF_RESEARCH_DB_PASSWORD` |
| `SURF_RESEARCH_VECTOR_MODEL` | `Xenova/multilingual-e5-small` | local 384-dimensional model used by HNSW vector retrieval and final reranking. The default model revision is pinned; `off` disables the vector lane. |
| `SURF_RESEARCH_VECTOR_LOW_MEMORY` | `true` | disables the ONNX CPU memory arena and memory pattern; set `false` to trade higher peak memory for faster initial indexing |
| `SURF_RESEARCH_VECTOR_THREADS` | `4` | ONNX intra-op thread count, clamped to 1-16 |
| `SURF_RESEARCH_VECTOR_BATCH_SIZE` | `8` | inference microbatch size, clamped to 1-32; generated embeddings are checkpointed after each batch |
| `SURF_RESEARCH_VECTOR_BACKEND` | `hnsw` | vector representation: `hnsw`, content-deduplicated `compact`, or bounded `exhaustive` |
| `SURF_RESEARCH_REPO_AUTO` | `true` | automatically sparse-index at most one small, relevant GitHub repository per search call |
| `SURF_RESEARCH_REPO_AUTO_MAX_MB` | `20` | maximum searchable source-text size for automatic GitHub indexing; assets are excluded |
| `SURF_RESEARCH_REPO_AUTO_MAX_FILES` | `2000` | maximum searchable source file count for automatic GitHub indexing |
| `SURF_RESEARCH_BROKER_IDLE_MS` | `60000` | drain delay after the last meaningful work, even when clients remain connected; active requests and background jobs postpone drain |
| `SURF_RESEARCH_READ_CONCURRENCY` | `4` | maximum concurrent broker reads; identical in-flight reads share one operation |
| `SURF_RESEARCH_QUERY_TIMEOUT_MS` | `120000` | timeout per embedded SurrealDB query, clamped to 1-600 seconds; a timed-out retrieval lane is reported as partial while other lanes still return |
| `SURF_RESEARCH_GRAPH_CACHE_MAX_MB` | `64` | byte budget for in-process graph projections and analysis artifacts |
| `SURF_RESEARCH_WORKER_SOFT_MEMORY_MB` | `2048` | RSS threshold that requests an immediate idle drain after active work completes |
| `SURF_RERANK_TRIGGER_CHARS` | `1500` | shell-output interception threshold (inclusive); sensitive output is sanitized even below this threshold |
| `SURF_RERANK_MAX_CHARS` | adaptive: 1500–3000 | optional explicit shell-summary limit, including values above 3000; default is `min(3000, ceil(1500 + 750*log2(max(1,n))))` for distinct query-matching records/blocks, not repeated output volume |
| `GITHUB_TOKEN` | unset | optional GitHub token that raises API limits for repository inspection |
| `SURF_RESEARCH_CODE_WORKERS` | auto, max 4 | Tree-sitter worker count for initial code structure indexing |
| `SURF_LOCALE` | `en-US` | browser locale |
| `SURF_TZ` | system tz | e.g. `America/New_York` |
| `SURF_HEADLESS` | `true` | Controls Playwright extraction, compatibility, and recovery paths. Native search keeps a normal system Chrome window hidden and shows it only for CAPTCHA recovery. |
| `SURF_REMOTE_DEBUG` | `false` | set `true` on a headless server with remote DevTools. CAPTCHA path emits the DevTools port and throws instead of spawning a window; attach `chrome://inspect` from a local machine over SSH port-forward to solve. |
| `SURF_CAPTCHA_TIMEOUT_MS` | `180000` | lifetime of the background human-recovery window. MCP calls return immediately and do not wait for this timeout. |
| `SURF_IDLE_CLOSE_MS` | `30000` | idle ms before closing the sequential ctx and pool. `0` disables idle auto-close. Lower = faster cleanup, higher = warmer cache for spaced-out calls. |
| `SURF_ALLOW_PRIVATE` | `false` | set `true` to allow `extract` to fetch private/loopback addresses (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`, etc). Default blocks them as an SSRF guard. |
| `SURF_EXTRACT_MAX_CHARS` | `50000` | full extraction limit (200-50000); abstract defaults to 1500 and per-call `max_chars` overrides both |
| `SURF_EXTRACT_OCR` | `false` | OCR scanned/image PDFs via Tesseract (slower; off by default) |
| `SURF_CLOUD_MODE` | `false` | headless/serverless mode: TLS bypass + `--no-sandbox` + `--disable-dev-shm-usage` + worker pool disabled + fail-fast on CAPTCHA |
| `SURF_CASCADE_DISABLED` | `false` | pin a single stealth mode (chosen by `SURF_USE_STEALTH`) instead of the 3-tier auto-cascade |
| `SURF_USE_STEALTH` | `true` | initial stealth tier; only consulted when `SURF_CASCADE_DISABLED=true` |
| `SURF_HUMANLIKE_MODE` | `background` | `off` / `background` (fire-and-forget after returning results) / `inline` (await before returning, slower) |
| `SURF_RATE_LIMIT_PER_MIN` | `10` | internal cap on Google-facing requests per minute |
| `SURF_CACHE_TTL_SEARCH_MS` | `86400000` | search cache TTL (24h); `0` disables caching |
| `SURF_CACHE_MAX_ENTRIES` | `1000` | LRU cap per cache namespace |
| `SURF_CACHE_ROOT` | `<profile>/cache` | cache directory |
| `SURF_INSECURE_TLS` | `=SURF_CLOUD_MODE` | `--ignore-certificate-errors` (auto-on in cloud mode) |
| `SURF_NO_SANDBOX` | `=SURF_CLOUD_MODE` | `--no-sandbox` (auto-on in cloud mode) |
| `SURF_TELEMETRY` | `false` | set `true` to enable jsonl event logging (search outcomes, cache hits/misses, tool errors, parser staleness) under `{SURF_TELEMETRY_ROOT}`. Designed as the input feed for the self-healing pipeline. Off by default. |
| `SURF_TELEMETRY_ROOT` | `<profile>/telemetry` | directory for jsonl telemetry files. UTC-dated one file per day (`YYYY-MM-DD.jsonl`). |
| `SURF_SELF_HEALING` | `true` | per-strategy outcome tracking + persisted reordering. Healing must win by 3 outcomes before reorder kicks in, so single-call flapping is impossible. Set `false` to pin the default strategy order. |
| `SURF_SELF_HEALING_FILE` | `<profile>/.heal/strategy-order.json` | persistence path for healing state. Atomic tmp+rename writes; debounced 5s. |
| `SURF_LLM_HEAL` | `false` | opt-in for LLM-assisted selector repair in the workflow-only `repairWithLLM` helper. Off by default, so no third-party LLM request fires. |
| `SURF_LLM_PROVIDER` | `anthropic` | LLM repair provider: `anthropic` or `orcarouter`. |
| `SURF_LLM_MODEL` | provider default | model for LLM-assisted repair. Defaults to `claude-sonnet-4-6` for Anthropic and to the first text-chat model in the live OrcaRouter catalog (falling back to `orcarouter/auto`) for OrcaRouter. |
| `ANTHROPIC_API_KEY` | unset | Anthropic key used only when LLM repair is enabled with the Anthropic provider. |
| `ORCAROUTER_API_KEY` | unset | OrcaRouter key used only when LLM repair is enabled with the OrcaRouter provider. |
| `ORCA_KEY` | unset | Alias for `ORCAROUTER_API_KEY`. |
| `SURF_ORCAROUTER_CREDENTIAL_FILE` | `<profileRoot>/.orcarouter/credential.json` | Where the connect flow stores its key. Owner-only Windows ACL or POSIX mode 0600 is applied before writing; reused until revoked. |

### Embedded resource budget

Embedded storage defaults to a 512 MiB RocksDB block cache, a 128 MiB HNSW vector cache, two 32 MiB write buffers, and two background jobs instead of machine-scaled server defaults. Explicit `SURREAL_HNSW_CACHE_SIZE`, `SURREAL_ROCKSDB_BLOCK_CACHE_SIZE`, `SURREAL_ROCKSDB_WRITE_BUFFER_SIZE`, `SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER`, `SURREAL_ROCKSDB_THREAD_COUNT`, and `SURREAL_ROCKSDB_JOBS_COUNT` settings take precedence.

Background indexing runs one job at a time. Queued captures in the same project share a current indexing pass, and pending capture requests survive broker restarts. Inference calls share one queue, and each small embedding batch is saved before checking for drain. Document indexing does not load unrelated code bodies. Existing cached embeddings remain reusable; the smaller batch setting does not force a full reindex. These are component budgets, not a hard whole-process RSS cap. Native storage defaults apply when a broker opens its database, not to an already running broker.

### OrcaRouter

[OrcaRouter](https://www.orcarouter.ai) is an OpenAI-compatible AI gateway used here as the LLM-assisted repair provider. Two credential entry points are supported and either one is enough:

```bash
# 1. Paste an existing key
ORCAROUTER_API_KEY=sk-orca-...
# or, from the CLI (saved with owner-only permissions)
google-surf-mcp orcarouter login

# 2. Authorize an OrcaRouter account (OAuth 2.0 + PKCE, no client secret)
google-surf-mcp orcarouter connect          # loopback redirect
google-surf-mcp orcarouter connect --oob    # out-of-band code, for sessions without a loopback listener
```

Both end up as the same durable OrcaRouter API key and reach the same inference API; `google-surf-mcp orcarouter status` reports which one is active. Then:

```env
SURF_LLM_HEAL=true
SURF_LLM_PROVIDER=orcarouter
SURF_LLM_MODEL=orcarouter/auto
```

`SURF_LLM_MODEL` is optional. When it is unset the model comes from the live catalog at `GET https://api.orcarouter.ai/v1/models`, so the default tracks what your workspace can actually call. Inspect the catalog with `google-surf-mcp orcarouter models --capability chat|embedding|image|video|rerank`.

Authentication and inference use different origins, and both are configurable for self-hosted deployments:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORCA_BASE_URL` | unset | Shared base for a single-origin self-hosted deployment. |
| `ORCA_AUTH_BASE_URL` | `https://www.orcarouter.ai` | Authentication origin. An explicit value wins over `ORCA_BASE_URL`. |
| `ORCA_API_BASE_URL` | `https://api.orcarouter.ai` | Inference origin. An explicit value wins over `ORCA_BASE_URL`. |

The auth API lives at `/api/v1/auth` on the auth origin and the relay lives at `/v1` on the inference origin; the two are never derived from one another. Non-loopback origins must be HTTPS. If the gateway rejects a stored key with `401`, the exact credential generation is marked for reauthentication rather than retried or silently deleted — rerun `orcarouter connect` or set a fresh `ORCAROUTER_API_KEY`. Revoke keys at <https://www.orcarouter.ai/console/authorized-apps>.
