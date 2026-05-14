# google-surf-mcp

✨Anti-Bot Search MCP: No API Key✨

English | [한국어](./README.ko.md)
[![npm downloads](https://img.shields.io/npm/dm/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![google-surf-mcp MCP server](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp/badges/score.svg)](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp)
[![npm version](https://img.shields.io/npm/v/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)

![demo](./assets/demo.gif)

> Demo only. Actual searches run **headless** by default (no visible browser). Set `SURF_HEADLESS=false` to make Chrome visible like in the clip above.

Google search MCP. No API key. Just works.

- ✅ Actually works (tested 6 free Google search MCPs, all failed)
- ✅ Search + URL extract in one MCP (replaces the usual search MCP + fetch MCP combo)
- ✅ 5 tools: `search` / `search_parallel` / `extract` / `search_extract` / `health`
- ✅ No API key, no proxies, no solver
- ✅ Auto CAPTCHA recovery (Chrome opens, human solves once, call retries)
- ✅ SSRF guard on `extract` (blocks `localhost`, private IPs, AWS metadata by default)

## What

Plug it into any MCP client and you get Google search as a tool.

No CAPTCHA solver. When CAPTCHA fires on any tool, a Chrome window opens for a human to solve. Each solve preserves the profile's reputation with Google. Built for sustainable, ethical use.

One-time install needs a ~1s profile warm-up (see Install).

Designed for local use. For headless / serverless environments set `SURF_CLOUD_MODE=true` (fail-fast on CAPTCHA, worker pool disabled).

## Numbers

| | result |
|---|---|
| sequential | ~1.5s/query (first call ~4s, includes setup) |
| parallel x4 | ~1.5s wall (first call ~9s, includes pool warm) |
| parallel x10 | ~4.5s wall |
| search_extract x5 | ~5s wall (search + 5 parallel extracts) |

Measured on a workstation with a 1Gb/s connection.

## Stack

- Playwright + persistent Chrome profile
- `playwright-extra` stealth as a cascade fallback tier
- Resource-blocked images / media / fonts for speed
- One-shot profile bootstrap before first run
- Mozilla Readability + Turndown for article extraction

## Install

Requires Node 18+ and Google Chrome (or Chromium) on the system.

```bash
npx google-surf-mcp   # actual MCP - register in client config
```

Or local clone:

```bash
git clone https://github.com/HarimxChoi/google-surf-mcp
cd google-surf-mcp
npm install
npm run bootstrap
```

`bootstrap` opens a Chrome window. Run one Google search in it. Close. Profile is now warm.

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

- `search(query, limit?)` - single query, ~1.5s. Returns title / url / snippet. Sponsored ads filtered out. Results cached 24h (`SURF_CACHE_TTL_SEARCH_MS=0` to bypass).
- `search_parallel(queries[], limit?)` - pool of 4, max 10 queries per call.
- `extract(url, max_chars?)` - fetch a URL, return article markdown (Readability with text fallback). Failures return `{ error }`, never throw.
- `search_extract(query, limit?, max_chars?)` - search + parallel extract in one call. Returns SERP results enriched with full article content. Per-page failures are isolated.
- `health()` - server status: cascade mode, rate-limiter usage, cache size, config. Call it if searches start failing or returning empty.

`search_extract` is the killer one: SERP + full article content in a single call. Replaces the usual "search MCP + URL fetcher MCP" combo most agents stitch together.

## Env vars

| var | default | notes |
|---|---|---|
| `CHROME_PATH` | auto-detected | absolute path to Chrome binary |
| `SURF_PROFILE_ROOT` | `~/.google-surf-mcp` | where the warm profile lives |
| `SURF_LOCALE` | `en-US` | browser locale |
| `SURF_TZ` | system tz | e.g. `America/New_York` |
| `SURF_HEADLESS` | `true` | set `false` to run Chrome visibly (demos / debugging). CAPTCHA auto-recovery always runs visible regardless. |
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

- CAPTCHA: a visible Chrome window opens automatically (all tools). Solve it once, do one search inside, the call retries and continues. To fail-fast instead (no human available), set `SURF_CLOUD_MODE=true`.
- "Chrome not found": install Chrome or set `CHROME_PATH`.
- Stale selectors: Google rotates classes. PRs welcome.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
