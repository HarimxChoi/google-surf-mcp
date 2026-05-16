<img src="./assets/icon256.png" width="128" align="right" alt="google-surf-mcp"/>

# google-surf-mcp

English | [한국어](./README.ko.md)

[![npm version](https://img.shields.io/npm/v/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![ci](https://github.com/HarimxChoi/google-surf-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/HarimxChoi/google-surf-mcp/actions/workflows/ci.yml)
[![google-surf-mcp MCP server](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp/badges/score.svg)](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp)

![demo](./assets/demo.gif)

> Demo only. Actual searches run **headless** by default (no visible browser). Set `SURF_HEADLESS=false` to make Chrome visible like in the clip above.

Google search MCP. No API key. Just works.

One MCP replaces three: search + URL fetcher + academic-paper extractor.

- ✅ Actually works (tested 6 free Google search MCPs, all failed)
- ✅ Search + URL + academic PDF extract in one MCP (replaces the search MCP + fetch MCP + academic-search MCP combo)
- ✅ Academic PDFs extracted inline: arxiv, biorxiv, Nature, OpenReview, NeurIPS, JMLR, PMLR, Springer, PubMed (via PMC)
- ✅ `search_extract` defaults to abstract mode (~1500 chars/result, token-cheap), `mode="full"` for whole bodies
- ✅ Sponsored ads + knowledge panels dropped (geometric verification, not just text matching)
- ✅ CAPTCHA recovery in 4 modes: OS notification (default) / `SURF_HEADLESS=false` / `SURF_REMOTE_DEBUG` / `SURF_CLOUD_MODE` (fail-fast)
- ✅ No API key, no proxies, no solver

5 tools: `search` / `search_parallel` / `extract` / `search_extract` / `health`

## What

Plug it into any MCP client and you get Google search as a tool.

No CAPTCHA solver. When CAPTCHA fires on any tool, a Chrome window opens for a human to solve. Each solve preserves the profile's reputation with Google.

First call auto-bootstraps the warm profile. Designed for local use. For headless / serverless environments set `SURF_CLOUD_MODE=true` (fail-fast on CAPTCHA, worker pool disabled).

## Numbers

| | result |
|---|---|
| sequential | ~1.5s/query (first call ~4s, includes setup) |
| parallel x4 | ~1.5s wall (first call ~9s, includes pool warm) |
| parallel x10 | ~4.5s wall |
| search_extract x5 (abstract, default) | ~3s wall |
| search_extract x5 (full) | ~5s wall (search + 5 parallel extracts) |

Measured on a workstation with a 1Gb/s connection.

## Stack

- Playwright + persistent Chrome profile
- `playwright-extra` stealth as a cascade fallback tier
- Multi-strategy SERP parser + geometric verification (drops sponsored / knowledge_panel / related)
- `unpdf` for PDF text extraction; Mozilla Readability + Turndown for HTML
- Resource-blocked images / media / fonts for speed
- Auto-bootstrap on first call; pool falls back to single-context after repeated warm failures

## Install

Requires Node 18+ and Google Chrome (or Chromium) on the system.

```bash
npx google-surf-mcp   # actual MCP - register in client config
```

First tool call auto-bootstraps the warm profile (you may see Chrome open briefly).

Or local clone:

```bash
git clone https://github.com/HarimxChoi/google-surf-mcp
cd google-surf-mcp
npm install
```

If auto-bootstrap fails (rare), run it manually:
```bash
npm run bootstrap
```

Override paths if needed:
```bash
CHROME_PATH=/path/to/chrome SURF_TZ=America/New_York npm run bootstrap
```

## Use with Claude Code

Paste this into your `~/.claude.json`:

```json
{
  "mcpServers": {
    "google-surf": {
      "command": "npx",
      "args": ["-y", "google-surf-mcp"]
    }
  }
}
```

Restart Claude Code. Done. `search`, `search_parallel`, `extract`, `search_extract`, `health` are now available.

For other MCP clients, use the same JSON shape in their config file.

Local clone variant:
```json
{
  "mcpServers": {
    "google-surf": {
      "command": "node",
      "args": ["/abs/path/to/google-surf-mcp/build/index.js"]
    }
  }
}
```

## Tools

- `search(query, limit?)` - single query, ~1.5s. Returns title / url / snippet. Sponsored ads + knowledge-panel dropped (response includes `dropped` count + `dropped_reasons`). Results cached 24h (`SURF_CACHE_TTL_SEARCH_MS=0` to bypass).
- `search_parallel(queries[], limit?)` - pool of 4, max 10 queries per call.
- `extract(url, max_chars?, mode?)` - fetch a URL, return article content.
  - `mode="full"` (default): whole body. HTML via Readability, PDFs via `unpdf`.
  - `mode="abstract"`: ~1500-char survey (PDF page 1 or HTML meta description). Triage relevance before paying for full text.
  - `mode="metadata"`: PDF page count only.
  - Response: `content`, `title`, `excerpt`, `length`, `is_pdf`, `page_count`, `extraction_quality`. Failures return `{ error }`, never throw.
- `search_extract(query, limit?, max_chars?, mode?)` - search + parallel extract in one call. Default `mode="abstract"` returns SERP enriched with ~1500-char summaries (cheap triage). Use `mode="full"` when you actually need the article texts (slower, more tokens).
- `health()` - server status: cascade mode, rate-limiter usage, cache size, config. Call it if searches start failing or returning empty.

## Env vars

| var | default | notes |
|---|---|---|
| `CHROME_PATH` | auto-detected | absolute path to Chrome binary |
| `SURF_PROFILE_ROOT` | `~/.google-surf-mcp` | where the warm profile lives |
| `SURF_LOCALE` | `en-US` | browser locale |
| `SURF_TZ` | system tz | e.g. `America/New_York` |
| `SURF_HEADLESS` | `true` | set `false` to run Chrome visibly (demos / debugging). When `false`, CAPTCHA recovery skips the OS notification (user is already watching). |
| `SURF_REMOTE_DEBUG` | `false` | set `true` on a headless server with remote DevTools. CAPTCHA path emits the DevTools port and throws instead of spawning a window; attach `chrome://inspect` from a local machine over SSH port-forward to solve. |
| `SURF_IDLE_CLOSE_MS` | `30000` | idle ms before closing the sequential ctx and pool. `0` disables idle auto-close. Lower = faster cleanup, higher = warmer cache for spaced-out calls. |
| `SURF_ALLOW_PRIVATE` | `false` | set `true` to allow `extract` to fetch private/loopback addresses (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`, etc). Default blocks them as an SSRF guard. |
| `SURF_CLOUD_MODE` | `false` | headless/serverless mode: TLS bypass + `--no-sandbox` + `--disable-dev-shm-usage` + worker pool disabled + fail-fast on CAPTCHA |
| `SURF_CASCADE_DISABLED` | `false` | pin a single stealth mode instead of the 3-tier cascade |
| `SURF_USE_STEALTH` | `true` | initial stealth tier — only consulted when `SURF_CASCADE_DISABLED=true` |
| `SURF_HUMANLIKE_MODE` | `off` | `off` / `background` / `inline` — opt-in humanlike browsing behavior |
| `SURF_RATE_LIMIT_PER_MIN` | `10` | internal cap on Google-facing requests per minute |
| `SURF_CACHE_TTL_SEARCH_MS` | `86400000` | search cache TTL (24h); `0` disables caching |
| `SURF_CACHE_MAX_ENTRIES` | `1000` | LRU cap per cache namespace |
| `SURF_CACHE_ROOT` | `<profile>/cache` | cache directory |
| `SURF_INSECURE_TLS` | `=SURF_CLOUD_MODE` | `--ignore-certificate-errors` (auto-on in cloud mode) |
| `SURF_NO_SANDBOX` | `=SURF_CLOUD_MODE` | `--no-sandbox` (auto-on in cloud mode) |

## Troubleshooting

- CAPTCHA in 4 modes (picked automatically from env):
  - default (local desktop): OS notification fires, headed Chrome opens, human solves, call retries
  - `SURF_HEADLESS=false`: headed Chrome opens, no notification (user is already watching)
  - `SURF_REMOTE_DEBUG=true`: DevTools port + instructions printed, attach `chrome://inspect` locally to solve
  - `SURF_CLOUD_MODE=true`: fail-fast with `CAPTCHA_REQUIRED` error
- "Chrome not found": install Chrome or set `CHROME_PATH`.
- Stale selectors: Google rotates classes. v0.4.5+ runs a multi-strategy parser and a daily self-healing workflow that opens draft PRs (human review required).
- SSRF: `extract` blocks `localhost`, private IPs, AWS metadata by default. Set `SURF_ALLOW_PRIVATE=true` to allow them.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
