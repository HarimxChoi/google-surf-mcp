# google-surf-mcp

MCP server for Google search. No API key. Playwright with a warm Chrome profile.

## Why

Free Google search MCPs out there mostly don't work in 2026 — Google blocks them in seconds. After ~30 failed attempts I found two things matter:

1. Remove `--enable-automation` from Chrome's launch args. Playwright sets it by default. Stealth plugins don't touch it. Google checks it first.
2. Use a warm persistent profile. Cold profiles get CAPTCHA'd. A profile that ran one real search in visible mode never gets blocked again in headless.

With those two: ~2s per query, parallel works, no keys, no proxies.

## Numbers

| | result |
|---|---|
| sequential, warm | ~2s/query |
| parallel x4 | ~9s wall |
| parallel x10 | ~16s wall |
| cold profile | CAPTCHA every time |
| `--enable-automation` left on | CAPTCHA every time |

## Install

Requires Node 18+ and Google Chrome (or Chromium) on the system.

```bash
npx google-surf-mcp --help   # nothing yet, just to pull the package
npx google-surf-mcp           # actual MCP — register in client config
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

## Claude Code config

`~/.claude.json`:

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
- `search_parallel(queries[], limit?)` — pool of 4, max 8 queries per call

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
