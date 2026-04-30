# google-surf-mcp

Google search MCP. No API key. Just works.

## What

Plug it into any MCP client and you get Google search as a tool. CAPTCHA solving isn't built in — but the server is designed so a transient block doesn't crash it, and the next call goes through.

One-time install needs a ~1s profile warm-up (see Install).

## Numbers

| | result |
|---|---|
| sequential | ~2s/query |
| parallel x4 | ~2s wall |
| parallel x10 | ~5s wall |

Measured on a workstation with a 1Gb/s connection. Numbers vary with hardware and network.

## Stack

- Playwright + persistent Chrome profile
- `playwright-extra` stealth
- Resource-blocked images / media / fonts for speed
- One-shot profile bootstrap before first run

## Install

Requires Node 18+ and Google Chrome (or Chromium) on the system.

```bash
npx google-surf-mcp   # actual MCP — register in client config
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

## Config

Example for Claude Code (`~/.claude.json`):

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

Or with a local clone:
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

- `search(query, limit?)` — single query, ~2s
- `search_parallel(queries[], limit?)` — pool of 4, max 10 queries per call

## Env vars

| var | default | notes |
|---|---|---|
| `CHROME_PATH` | auto-detected | absolute path to Chrome binary |
| `SURF_PROFILE_ROOT` | `~/.google-surf-mcp` | where the warm profile lives |
| `SURF_LOCALE` | `en-US` | browser locale |
| `SURF_TZ` | system tz | e.g. `America/New_York` |

## Troubleshooting

- CAPTCHA error → re-run `npm run bootstrap`
- "Chrome not found" → install Chrome or set `CHROME_PATH`
- Stale selectors → Google rotates classes; PRs welcome

## License

MIT
