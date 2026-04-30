# google-surf-mcp

MCP server for Google search. No API key. Uses Playwright with a warm Chrome profile.

## Why

Most "free Google search MCPs" out there don't actually work in 2026 — Google blocks them in seconds. After ~30 failed attempts I found two things matter:

1. **Remove `--enable-automation` from Chrome's launch args.** Playwright sets this by default. Stealth plugins don't touch it. Google checks it first.
2. **Use a warm persistent profile.** Cold profiles get CAPTCHA'd on every search. A profile that ran one real search in visible mode never gets blocked again (in headless).

That's it. With those two, you get ~2s per query, parallel works, no API keys, no proxies.

## Numbers

| | result |
|---|---|
| sequential, warm | ~2s/query |
| parallel x4 | ~9s wall for 4 |
| parallel x10 | ~16s wall for 10 |
| cold profile | CAPTCHA every time |
| `--enable-automation` left on | CAPTCHA every time |

## Install

```bash
git clone <repo>
cd google-surf-mcp
npm install
npm run bootstrap
```

`bootstrap` opens a visible Chrome window. Do one Google search in it. Close. Done — profile is warm.

If your Chrome lives somewhere other than `C:\Program Files\Google\Chrome\Application\chrome.exe`, set `CHROME_PATH`:

```bash
CHROME_PATH=/usr/bin/google-chrome npm run bootstrap
```

## Use with Claude Code

Add to `~/.claude.json`:

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
- `search_parallel(queries[], limit?)` — pool of 4, max 8 queries

## When it breaks

- CAPTCHA → re-run `npm run bootstrap`
- Chrome path wrong → set `CHROME_PATH`
- Selectors stale → file a PR, Google rotates `div.g` etc periodically

## Tested on

Windows 11, Node 24, Chrome 130. Should work on macOS/Linux with `CHROME_PATH` set.

## License

MIT
