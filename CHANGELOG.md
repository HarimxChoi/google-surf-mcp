# Changelog

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
