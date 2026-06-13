# Changelog

## [Unreleased]

### Changed
- PDF extraction uses `@llamaindex/liteparse` (PDFium spatial parsing) instead of `unpdf`: ~2x faster, correct multi-column reading order, optional OCR.

### Added
- `SURF_EXTRACT_OCR` (default `false`) — Tesseract OCR for scanned/image PDFs.
- `SURF_EXTRACT_MAX_CHARS` (default `8000`) — configurable extract truncation (#9).

### Fixed
- EU consent overlay dismissed before the search box, with `focus` instead of `click` — fixes 100% search failure on fresh EU profiles (#10).
- Block detection broadened beyond `/sorry/` (consent URL + in-page reCAPTCHA via DOM).

## [0.6.5]

### Changed
- CAPTCHA recovery seeds the original query instead of `hello world`.
- Recovery forces humanlike inline mode: random per-char typing, Tab+Enter variability, then 1-3 result visits with dwell, scroll, goBack.
- Removed `SURF_CAPTCHA_GRACE_MS`. `SURF_CAPTCHA_TIMEOUT_MS` default 240s to 180s.

## [0.6.4]

### Fixed
- CAPTCHA recovery now keeps the headed Chrome window open for a grace period (default 120s, `SURF_CAPTCHA_GRACE_MS`) after landing on `/search?`, so a late CAPTCHA on the auto-search is solvable by the user. If a CAPTCHA appears during the grace window, the timer resets. Outer timeout raised to 240s (`SURF_CAPTCHA_TIMEOUT_MS`).
- CAPTCHA recovery launches Chrome with image/media/font requests un-blocked so reCAPTCHA image grids actually render in the visible window.
- Windows: zombie `chrome.exe` from a crashed prior session held the user-data-dir lock, causing `launchPersistentContext` to fail with "Target page, context or browser has been closed". `launch()` now calls `killZombieChromium()` (PowerShell scan by `--user-data-dir` match + `SIGKILL`) before `clearProfileLocks` on retry. `waitForLockReleased` covers the still-flushing case; this covers the fully-crashed case.

## [0.6.3]

### Fixed
- Fixed a `ProcessSingleton`/`SingletonLock` race on rapid Chrome relaunch — `launch()` now waits for the stale profile lock to clear before retrying once (#8).

## [0.6.2]

### Fixed
- Fixed an SSRF gap in `extract`: a server-side redirect landing on a private address (e.g. cloud metadata) is now blocked on the Playwright fallback path.
- Repair pipeline (dev/CI only): fixed a parser-strategy mismatch and removed a misleading no-op draft-PR step.

## [0.6.1]

### Fixed
- Fixed stale SERP parsing by waiting for the search URL to actually change before parsing results.
- Fixed CAPTCHA recovery seed/session inheritance so pool workers can inherit solved session state.
- Improved ProcessSingleton retry by waiting for Chrome profile locks to be released before relaunch.

## [0.6.0]

### Added

#### Runtime self-healing (src/strategyHealing.ts)
Per-strategy outcome tracking with persisted reordering. The healing layer learns which SERP parser strategy wins for the current Google layout and reorders the runtime trial sequence so the most reliable strategy is tried first.

- `StrategyHealing` class: `recordOutcome(id, 'win'|'loss'|'zero')`, `getOrderedStrategyIds(default)`, `getStats()`, `flush()`.
- Score formula: `wins * 10 - zeros`. Losses are ignored (losing to a better strategy is normal SERP drift, not breakage).
- Reorder only kicks in when the leader has at least 3 more wins than the runner-up; prevents single-call flapping.
- Recent-win recency breaks score ties so a strategy that worked yesterday outranks one that worked six months ago at equal score.
- Atomic disk writes via `tmp + rename`. Debounced (5s) so a burst of searches does not hammer the disk.
- Per-strategy stats are surfaced through `healthTool` so operators can see the current preference order without inspecting the file.
- Corrupt or missing state collapses to default order; healing must never break a search call.
- 17 unit tests covering disabled mode, load, ordering thresholds, win/loss/zero accounting, tie-breaks, disk safety.

#### New env vars
- `SURF_SELF_HEALING` (default `true`): master switch for runtime selector reordering (deterministic, no LLM, no network).
- `SURF_SELF_HEALING_FILE` (default `<profileRoot>/.heal/strategy-order.json`): override the persistence path.
- `SURF_LLM_HEAL` (default `false`): opt-in gate for the workflow-only `repairWithLLM` helper. Off by default — no third-party LLM request ever fires from this package without an explicit opt-in AND a user-supplied `ANTHROPIC_API_KEY`. The package never ships a maintainer key.

#### `pool` field in `healthTool` response
`getPoolHealth()` is now wired into the health response. Returns `{ warmFailures, fallback }` so operators can spot a pool that has flipped to single-context mode without digging through stderr.

#### `selfHealing` field in `healthTool` response
Reports `{ enabled, order, stats }` so the current strategy preference order is visible at runtime.

### Fixed

- **remote_debug idle close**: `recoverHuman` now calls `suspendIdleClose()` before throwing in `remote_debug` mode and resumes after. Previously the 30s idle timer scheduled by `trackSeq`/`trackPool` could close the Chromium whose DevTools port was just advertised, breaking the recovery if the user took longer than `SURF_IDLE_CLOSE_MS` to set up the SSH tunnel.
- **remote_debug guidance lost in MCP clients**: `CaptchaError` now carries an optional `userAction` field. The remote-debug branch in `recoverFromCaptcha` embeds the port-forward instructions in `userAction`, which `toErrorInfo` surfaces through `ErrorInfo.user_action`. MCP clients that drop server stderr (most of them) now see the actionable text in the structured error response.
- **seqBackedHandle missing timeout protection**: when the pool warms 3× and `acquirePool` switches to the single-context fallback, `runMany`/`searchOne`/`extractOne` are now wrapped with `withTimeout` matching the `poolBackedHandle` budgets (30s / 60s). Previously a hung sequential op had no upper bound.

### Fixed (cron / build)
- **`serp-repair-pipeline` workflow daily failure**: `scripts/repair/index.ts` lives outside `src/` so `npm run build` (tsconfig `rootDir: ./src`) never compiled it. Workflow then `node build/scripts/repair/index.js` → ENOENT → exit 1. Added `tsconfig.scripts.json` (rootDir=`.`, outDir=`./build-scripts`) and a `build repair scripts` step. Workflow now runs `node build-scripts/scripts/repair/index.js` and sets `SURF_LLM_HEAL=true` so the new opt-in gate does not turn the cron into a deterministic no-op.

### Tests
- 296 passing (was 261). New:
  - `StrategyHealing` unit tests (21) — disabled mode, load merge with concurrent recordOutcome race, ordering thresholds, win/loss/zero accounting, tie-breaks, persisted reorder, disk safety, dirty-flag preserved on flush failure.
  - `search.healing` integration tests (4) — `pickAndScoreResults` against real SERP fixtures: win/loss/zero on populated SERP, all-zero on empty SERP, 4-call → persisted → fresh-instance reorder, no-healing control.
  - `agent.health` tests (5) — `healthTool` surfaces `getPoolHealth()` snapshot (incl. fallback=true case) and `selfHealing` { enabled, order, stats } correctly, order updates after margin-crossing wins.
  - `heal.llm.gate` tests (4) — opt-in matrix: unset/false → mock, opted-in + no key → mock, no candidates → fallback selector.
  - CaptchaError userAction surface (1).

## [0.5.5]

### Added

#### Telemetry module (src/telemetry.ts)
Opt-in jsonl event logging designed as the input feed for the self-healing pipeline. Off by default; enabled via `SURF_TELEMETRY=true`.

- `Telemetry` class: `record(type, data)` (never throws), `query({type?, sinceDays?})`, `percentile(type, field, p)`, `movingAverage(type, field)`, `ewma(type, field, {alpha?})`, `size()`.
- Five event types: `search.outcome`, `parse.stale`, `cache.hit`, `cache.miss`, `tool.error`.
- UTC-dated jsonl files: `{telemetryRoot}/YYYY-MM-DD.jsonl`. Rotation derived from event timestamp.
- Rolling-window queries: `sinceDays: 1` means `now - 86_400_000`, not last calendar day.
- 4KB byte-guard per line stays within POSIX atomic-append bounds so the worker pool's concurrent writers don't interleave. Oversized lines are replaced with `{ _truncated: true, _originalType }`.
- Corrupted jsonl lines (partial write, etc.) are skipped during `query()` with a stderr warning; one bad record cannot poison the read.
- Aggregates return `null` when no valid numeric data exists, distinguishing "no data" from "value is zero" for downstream healing decisions.
- EWMA default `alpha=0.3`. Order-independent: events sorted oldest→newest before reduction.
- DI'd `now()` and `maxLineBytes` options for deterministic tests.

#### Telemetry wire-up (src/agent.ts)
- `Deps.tel: Telemetry` added; `initDeps` constructs it via `getTelemetry`.
- `searchTool` records `cache.hit` / `cache.miss` and `search.outcome` (with `resultsLen`, `droppedCount`, `elapsedMs`, `stealthMode`).
- `searchParallelTool` records one `search.outcome` per result.
- `searchExtractTool` records `search.outcome` for the SERP portion.
- `extractTool` records `tool.error` when `EXTRACT_FAILED` is returned without an exception.
- All `catch` paths funnel through a new `recordToolError(deps, tool, e)` helper that records `tool.error` and, when the error's `ErrorCode` resolves to `PARSER_STALE`, additionally records `parse.stale`. h3 count is extracted best-effort from the error message regex; a structured signal can replace it once `search.ts` adopts typed errors.

#### healthTool telemetry stats
`healthTool` response now includes `telemetry: { enabled, files, events }`. When disabled, returns zero counts without touching disk.

#### Env vars
- `SURF_TELEMETRY` (default `false`): master opt-in flag.
- `SURF_TELEMETRY_ROOT` (default `{profileRoot}/telemetry`): jsonl storage directory.

### Changed
- `src/config.ts` `Config` gains `telemetryEnabled` and `telemetryRoot` fields, following the existing `cacheRoot` pattern.

### Tests
- 284 passing (was 261). New: `Telemetry` (23) covering opt-in no-op, UTC rotation, circular-data resilience, byte-guard truncation, sinceDays rolling windows, corrupted-line skip, percentile / movingAverage / ewma on numeric fields (null on empty, ignore non-numeric), and `size()` accounting.

### Notes
- The self-healing trigger logic — consuming telemetry data to decide when to invoke `heal/synthesis` + `heal/llm` — is intentionally left out of this PR.

## [0.5.2]

### Fixed

- **Windows chrome exit 21 (single-instance forwarding)**: `detectChrome()` now prefers playwright's bundled chromium over the system Chrome install. The system Chrome shares Singleton IPC with the user's daily browser on Windows even with a unique `--user-data-dir`, forwarding launch args and exiting with `RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED` (21) before playwright can attach. Bundled chromium is a separate binary with no such conflict. Fallback order is unchanged for users without `playwright install`: `CHROME_PATH` env → bundled chromium → system Chrome paths.

## [0.5.1]

### Fixed

- **Windows pool worker EBUSY**: `cloneProfile` copied the live `main` profile, which NetworkService keeps SQLite-locked on Windows (`Default/Network/Cookies`, `Default/Safe Browsing Network/...`). Worker clones now read from a static `seed/` snapshot created once via `ensureSeed()` with a filter that skips chromium-locked basenames (SQLite DBs, LevelDB stores, caches, `*Network` subdirs). `bootstrap-auto` snapshots `seed/` right after the warm-up context closes. POSIX behavior unchanged.

## [0.5.0]

### Added

#### CAPTCHA recovery — 4 env-based modes
Single mode picked automatically from environment:
- `notify_spawn` (default): OS notification fires (osascript / powershell / notify-send), then headed Chrome opens. Works on macOS, Windows, Linux without `node-notifier`.
- `always_headed` (`SURF_HEADLESS=false`): headed Chrome opens, no notification (user is already watching).
- `remote_debug` (`SURF_REMOTE_DEBUG=true`): Chromium launches with `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`. CAPTCHA emits the active DevTools port (read from each profile's `DevToolsActivePort` file) and throws so the caller can attach `chrome://inspect` over an SSH tunnel. Loopback-only by default.
- `cloud_fail_fast` (`SURF_CLOUD_MODE=true`): throws `CAPTCHA_REQUIRED` immediately.

#### Pool fallback
`SearchPool.warm()` failure no longer hard-fails the server. After 3 consecutive warm failures (`POOL_FALLBACK_THRESHOLD`), `acquirePool` returns a sequential-context-backed handle that serves `runMany` / `searchOne` / `extractOne` from the single ctx instead of the worker pool. `getPoolHealth()` exposes `warmFailures` and `fallback`.

#### `withBackoff` utility (src/backoff.ts)
Minimal exponential backoff: `delay = initialMs * factor^attempt`. No jitter (full backoff with AWS jitter is planned for a follow-up). Options: `initialMs`, `maxAttempts`, `factor`, `isRetryable`, `onRetry`, `sleep` (test injection). 7 unit tests.

#### Version single-source-of-truth
- **src/version.ts**: exports `VERSION` and `PKG_NAME` from `package.json` via `createRequire`.
- **scripts/sync-versions.mjs**: `prebuild` hook syncs `package.json` version into `server.json` and `manifest.json` (including the `npx -y google-surf-mcp@<version>` arg).
- `src/agent.ts` `healthTool` no longer hardcodes the version string.

### Changed

#### English ad-marker regex
Tightened from `\b(sponsored|ads?)\b` to `\b(sponsored|advertisement)\b|(?:^|\s)ads?(?:\s*[·•‧▾\-—]|\s*$)`. `Sponsored` and `advertisement` match anywhere; standalone `Ad`/`Ads` matches only at start/end-of-field or before a typographic separator. Avoids false-positive sponsored classification for organic titles like "Google Ads API docs" or "Ads Manager", while still catching SERP labels like `Ad · brand.com` or just `Ad`.

#### `SURF_REMOTE_DEBUG` exposed in manifest
`manifest.json` `user_config` adds a `remote_debug` boolean and maps it to `SURF_REMOTE_DEBUG`, so manifest-based installs can enable the headless-server DevTools recovery flow.

#### CAPTCHA recovery context lifecycle
`recoverHuman` only releases pool + sequential ctx for `notify_spawn` and `always_headed` modes. `remote_debug` keeps the existing Chromium alive so the user can attach DevTools and solve in-place.

### Fixed

- **PDF resource leak**: `extractPdfTiered` now wraps text extraction in `try/finally` + `pdf.destroy()` so PDF.js workers and text-layer state are released even on parse error.

### Removed

- `scripts/check-no-korean.sh` + `.githooks/pre-commit` + `package.json` `lint:nokr` script. The hook fired on staged Korean text in `src/*.ts`; English-only source policy now enforced by review only.

### Tests
- 238 passing (was 223). New: `withBackoff` (7), `captchaModeFromConfig` (4), `recoverFromCaptcha` modes (4).

## [0.4.7]

### Added

#### Tiered PDF extraction (`unpdf`)
- **src/extract-pdf.ts**: `extractPdfTiered(buf, mode, maxChars)` returns `full_text`, `abstract` (PDF page 1 text content), or `metadata_only` (page count). Detects PDFs via `%PDF` magic bytes (`isPdfMagic`) or `Content-Type: application/pdf` (`isPdfContentType`).
- **src/extract-meta.ts**: HTML meta-tag helpers — `findCitationPdfUrl`, `findAbstractFromMeta` (citation_abstract → dc.description → description → og:description), `findTitle`, `domainPdfTransform` (openreview, biorxiv/medrxiv, nature), `findPmcUrlFromPubmed`.
- **src/extract.ts**: new `discoverViaFetch` runs before Playwright. PDF magic / Content-Type → tiered PDF extract; `mode='abstract'` HTML → meta description; otherwise tries `findCitationPdfUrl` + `domainPdfTransform` candidates; PubMed → PMC chain. Skips Playwright for academic PDFs entirely.
- Coverage: arxiv, biorxiv, Nature, OpenReview, NeurIPS, JMLR, PMLR, Springer, PubMed (via PMC).

#### Multi-strategy SERP wire-up
The `STRATEGIES` array, geometric verification, and score-based classification from v0.4.5 are now wired into the live search path (previously only used by the self-healing pipeline).
- **src/search.ts**: `pickAndScoreResults` iterates `STRATEGIES`, evaluates each with `parseResultsInBrowser` + `verifyResultsGeometricInBrowser`, computes `aggregateConfidence`, early-exits when ≥5 results & ≥0.7 confidence, picks best-scored otherwise. `DROP_CLASSIFICATIONS` set drops `sponsored | knowledge_panel | related`. Returns `{ results, dropped, dropped_reasons }`.
- **src/parse.ts**: `parseResultsInBrowser` now returns `blockIndices` so filtered results align with their verify entries when ads precede organics.
- Search responses now include `dropped` count + `dropped_reasons` array in meta. `extract` and `search_extract` responses include `is_pdf`, `page_count`, `extraction_quality`.

#### `extract` mode parameter
- `extract(url, max_chars?, mode?)`: `full` (default, whole article), `abstract` (~1500 chars triage), `metadata` (PDF page count).
- `search_extract(query, limit?, max_chars?, mode?)`: `abstract` is the new default (~1500 chars per result, ~80% fewer tokens than full), `full` for whole bodies. Default `max_chars` adjusts to mode (1500 for abstract, 8000 for full).

#### SSRF hardening (extract path)
- **`plainFetch`** (src/extract.ts): manual redirect handling with `MAX_REDIRECTS=5`, `MAX_FETCH_BYTES=25 * 1024 * 1024` cap (bounded reader), `AbortController` timeout. Each hop runs `checkUrlAsync` and throws `SsrfBlockedError` on private addresses or redirect-limit exhaustion.
- Playwright `page.route('**/*', ...)` now blocks navigation requests to private addresses with `route.abort('blockedbyclient')`, so HTML fallback also enforces SSRF.

#### Auto-bootstrap on first call
- **src/bootstrap-auto.ts**: idempotent `autoBootstrap({headless, log})` with single in-flight Promise, profile cleanup on failure, direct-invoke detection. `npm run bootstrap` no longer required for the npx-only install path.
- **src/index.ts**: `ensureProfileReady` triggers `autoBootstrap` on first tool call (cloud mode requires a pre-mounted profile).

### Changed
- `extract()` accepts `ExtractOptions` (`{maxChars, mode, navTimeoutMs, fence}`); legacy `(url, maxChars)` signature kept for back-compat.

### Tests
- 223 passing.

## [0.4.6]

### Fixed
- **CHROME_PATH checked lazily**: existence is validated at browser launch instead of at startup, so the server starts and answers `tools/list` even when `CHROME_PATH` is unset or points to a missing binary.
- **Cross-platform `prepare` script**: was Unix-only (`2>/dev/null || true`), which broke `npm install` on Windows.
- **Cache write retry**: `set()` retries on transient Windows rename errors (`EPERM`/`EBUSY`/`EACCES`) and treats a persistent failure as a cache miss instead of throwing.

### Changed
- README: npm version + downloads badges.

## [0.4.5]

### Added

#### Multi-strategy parsing + result pipeline
- **src/parse.ts**: STRATEGIES array (3 priority-ordered: data-ved-anchor, class-mjjyud, hveid-jscontroller). `parseResultsInBrowser({strategy, max})` returns ParseSignals. Backwards-compat shim `parseResults(max)` preserved. Trailing "Read more" / locale equivalents trimmed from snippets.
- **src/verify.ts**: geometric region rejection. `verifyResultsGeometricInBrowser` returns per-block rect + organic/ad/sidebar signals + confidence.
- **src/score.ts**: 8-locale ad detection, result classification, composite scoring, `filterOrganic`.
- **src/triage.ts**: fault classification (selector_broken / blocked / rate_limited / network_error) with multi-signal voting.
- These power the self-healing pipeline; wiring them into the live search path is planned for 0.5.

#### Self-healing pipeline
- **src/heal/validator.ts** — Triple Gate validator: Gate A (geometric: ≥5 results, organic ratio ≥60%, mean confidence ≥0.5), Gate B (XPath stability: stable attributes preferred over class-only), Gate C (LLM confirmation). All three required before a PR is generated. A 3-query empirical test runs on anchor queries — 3/3 → apply, 2/3 → caution flag, <2 → escalate.
- **src/heal/synthesis.ts** — deterministic selector synthesis from stable attributes (`[data-ved]` → `div[jscontroller]` → `div[data-hveid]` → longest class token).
- **src/heal/llm.ts** — LLM verifier (Anthropic SDK optional peer dep; mock fallback when no API key).
- **scripts/repair/** + **.github/workflows/repair-pipeline.yml** — daily cron: detection → synthesis → Triple Gate → 3-query empirical check → PR draft. Auto-merge never; human review required.

#### Foundation
- **src/config.ts**: centralized env validation; `parseTz` validates IANA tz with fallback (no launch-time throw on invalid `SURF_TZ`).
- **src/types.ts**: full type registry (ParserStrategy, ParseSignals, GeometricVerification, ResultScore, FaultType, ErrorCode, ErrorInfo, BehaviorParams).
- **src/response.ts**: `formatToolResponse` (text + structuredContent), `toErrorInfo` (9 ErrorCodes), `fenceUntrustedContent`.
- **src/navigate.ts**: `navigateHome` consolidates duplicate goto sites with exact-match URL check.

#### Data layer
- **src/cache.ts**: JSON+fs unified cache — namespace + per-entry TTL + atomic write + LRU eviction by mtime (`SURF_CACHE_MAX_ENTRIES`, default 1000). `search` results cached 24h by default (`SURF_CACHE_TTL_SEARCH_MS`); cache key is `query|locale|limit`.

#### Stealth cascade (src/cascade.ts)
The stealth plugin's evasion patterns are themselves a fingerprint. v0.4.5 makes bare playwright the default and the stealth plugin the fallback:

  Tier 1: stealth off  (bare playwright — borrows the real profile's reputation)
    ↓ 1 CAPTCHA
  Tier 2: stealth on   (playwright-extra + stealth plugin)
    ↓ 2 CAPTCHA
  Tier 3: human (local) or fail-fast (cloud)

State is process-level so the sequential ctx and pool share it. `SURF_CASCADE_DISABLED=true` pins a single mode.

#### Cloud mode (SURF_CLOUD_MODE=true)
Composite flag: auto-enables `insecureTls` (`--ignore-certificate-errors`) + `noSandbox` (`--no-sandbox`) + `--disable-dev-shm-usage`, disables the worker pool (`search_parallel` / `search_extract` return a structured error), and replaces tier-3 human recovery with fail-fast `CAPTCHA_REQUIRED`. Each underlying flag is independently overridable.

#### Internal rate limiter (src/limiter.ts)
Sliding 60s window caps Google-facing requests (`SURF_RATE_LIMIT_PER_MIN`, default 10). Overflow waits briefly in a FIFO queue, then returns `RATE_LIMITED` + `retry_after_ms` rather than blocking past an MCP call timeout.

#### Humanlike behavior (src/humanlike.ts, opt-in)
Multi-action behavior session (7 action types, 4 mouse styles). 2-layer randomization: per-call parameter ranges + per-action jitter. Mouse cadence and overshoot derive from generated params. Modes: off / background / inline.

#### health tool
New 5th tool: reports cascade state (mode, per-mode CAPTCHA counts, transitions), rate-limiter usage, cache size, config. Read-only.

#### Extract hardening
- DNS-resolve SSRF guard: `checkUrlAsync` resolves host then validates IP, blocking DNS rebinding (evil.com → 127.0.0.1).
- Optional untrusted-content fencing on extract bodies.

#### Anti-bot launch flags
`--fingerprinting-canvas-image-data-noise`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--force-webrtc-ip-handling-policy`.

### Changed
- **MCP SDK migration**: `setRequestHandler` → `McpServer` + `registerTool` + Zod schemas. All 5 tools declare `inputSchema` + `outputSchema`; responses include `structuredContent`. Tool descriptions rewritten with usage guidance.
- **First-call reliability**: the sequential context is pre-warmed in the background on server start; a failed launch clears a stale profile lock and retries once.
- Tool annotations (readOnlyHint / idempotentHint / openWorldHint) on all tools.
- All v0.4.x lifecycle code (sequential ctx, pool, idle timer, drain shutdown) preserved.

### Dependencies
- Added: `zod ^4` (tool schemas).

### Internal
- `no-korean` lint hook (`.githooks/pre-commit` + `scripts/check-no-korean.sh`): source comments must be English; localized regex data is tagged `i18n-data`.

### Migration
- Backwards compatible: existing tools (search / search_parallel / extract / search_extract) keep names and input/output shapes.
- New env vars are all opt-in; defaults match v0.4 behavior.

### Tests
- 180 passing.

## [0.4.1]

### Fixed
- **`withTimeout` race (B1)**: when timeout fired, the underlying long-running operation kept executing on the same `BrowserContext`/`Page`, racing the next request that landed during the gap. Added optional `cleanup` callback (typically `closeSequential` / `resetPool`) that fires on timeout so the underlying op cannot leak. Extracted to `src/timeout.ts` with unit tests.
- **CAPTCHA on pool path didn't release `PROFILE_MAIN` (B2)**: `search_parallel` and `search_extract` only called `resetPool` before recovery, while the sequential ctx might still hold `PROFILE_MAIN`. Headed Chrome launch in `recoverFromCaptcha` then collided on `SingletonLock`. Pool paths now also call `closeSequential`.
- **`recoverFromCaptcha` had no mutex (B3)**: two concurrent in-flight requests both hitting CAPTCHA spawned two headed Chrome processes against `PROFILE_MAIN`, colliding on `SingletonLock`. Added module-level Promise singleton so concurrent callers share a single recovery. Also swallows `ctx.close()` errors (user closing the recovery window manually).
- **Pool deadlock when all workers die + rebuilds fail (B4)**: previously, a fully-dead pool with unrebuildable workers would push acquires to the waiter queue forever (no resolve, no reject). Added `MAX_REBUILD_FAILURES=5` counter (resets on successful rebuild) that throws fast, and a 60s waiter timeout that rejects pending acquires instead of hanging indefinitely.
- **`onHome` URL detection false-positives (B5)**: `url.startsWith('https://www.google.com/')` matched `imghp`, `finance/...`, `preferences`, etc., which lack the search textarea — the subsequent `sb.click({timeout:6000})` then waited 6s before throwing. Now exact-matches `https://www.google.com/` (with or without trailing slash).

### Added
- Tests: `withTimeout` cleanup-on-timeout (5 cases), `recoverFromCaptcha` mutex (3 cases), pool deadlock prevention (3 cases). Total: 32 tests pass.

### Internal
- `withTimeout` extracted from `src/index.ts` to `src/timeout.ts` for testability.

## [0.4.0]

### Security
- **SSRF guard in `extract`**: blocks private/loopback/link-local addresses (`127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `localhost`, `0.x`, `::1`, `fc/fd/fe80::/*`). Set `SURF_ALLOW_PRIVATE=true` to allow. Env-only by design (per-call arg would let LLM bypass via prompt injection).

### Fixed
- **Sequential ctx idle close race**: in-progress close now blocks new launches via `ctxClosing` tracker. Previously caused profile-lock errors when a new request landed during close.
- **Pool ensure race**: `ensurePool` uses single-flight `poolPromise`. Previously `await closeSequential()` yielded mid-function, letting two callers both build a `SearchPool` (8 chrome processes, profile-lock collision).
- **Failed launch caching**: rejected `ctxPromise` no longer sticks forever. Next call retries instead of returning the cached rejection.
- **Pool waiters orphaned on close**: pending `acquire()` calls now reject with `pool closed` instead of hanging.
- **Pool warm partial failure leak**: if any worker fails to launch, the successfully-launched chrome processes are now closed before throwing (was leaking processes).
- **Dead worker handed to waiter**: `release()` now health-checks the worker and rebuilds before handoff (was handing a dead ctx to the next caller).
- **`acquire` after `close` hung forever**: pool now stays in `closing` state and rejects new acquires.
- **search.ts silent failures**: empty `try{}catch{}` removed. Wait errors with 0 results now throw with the actual reason. Parser-stale (h3 elements found but 0 results extracted) detected and thrown.
- **Redundant goto causing `ERR_ABORTED`**: `search()` skips `goto` when already on a usable google.com page. `launch()` already navigated there, second nav was racing in-flight subresources.
- **Inner timeouts exceeded outer**: 12+12+8=32s vs 30s outer caused outer to fire first with a generic message. Tightened to 5+4+4=13s plus click 6s, well within 30s.
- **`CHROME_PATH` silent fallback**: if env var is set but the file doesn't exist, throws explicit error instead of falling back to candidates.
- **CaptchaRecover false-positive**: also requires `!isBlocked(url)` so `/sorry/?continue=...search?...` doesn't count as a successful recovery.
- **Sponsored ads in results**: parser now filters `#tads`, `#tadsb`, `#bottomads`, `[data-text-ad]`, `[data-pcu]` and `[aria-label*="Sponsored"]`.
- **SIGINT/EOF killed in-flight ops**: shutdown now drains active ops up to 10s before closing ctx.
- **`SURF_IDLE_CLOSE_MS=0` was treated as default**: now correctly disables idle auto-close.

### Added
- `SURF_ALLOW_PRIVATE` env var (default `false`) for SSRF escape hatch on dev workflows.
- Parser returns `h3Count` so `search()` can detect stale selectors.
- Tests: SSRF guard (11 cases), pool close-rejects-waiters, pool acquire-after-close throws, parse h3Count + ad filter.

### Changed
- `VERSION` in `index.ts` is now read from `package.json` (was hardcoded).
- Handler errors log the full stack to stderr (visible in MCP client logs).
- `extract` handler returns `isError: true` when extraction fails with no content.
- `extract` handler no longer wraps in `withCaptchaFallback` (extract never throws `CaptchaError`).

### Removed
- Unused `ROOT` constant in `browser.ts`.
