# Changelog

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
