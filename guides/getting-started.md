# Getting started

Install Google Surf, connect an MCP client, and choose a search provider.

[Back to README](../README.md) | [Tools](tools.md) | [Configuration](configuration.md) | [Operations](operations.md)

## Install

Requires Node 22.12.0+. CI tests Node 22 and 24 on Linux and Windows. Browser mode also requires Google Chrome or Chromium.

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

Optional Codex hooks are covered in [operations](operations.md#optional-codex-output-protection).

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

Restart Claude Code. All seven tools, including `project_memory_search` and `project_memory`, are available by default.

For other MCP clients, use the same JSON shape in their config file.

## Search providers

Browser search remains the default. [SearchApi](https://www.searchapi.io/?utm_source=github&utm_medium=sponsorship&utm_campaign=google_search_api&utm_content=HarimxChoi_google-surf-mcp) can be selected as the primary provider or used only when browser search fails.

| value | behavior |
|---|---|
| `browser` | Default. Uses system Chrome with a dedicated logged-out profile, keeps native search windows hidden, and does not require `SEARCH_API`. Multiple MCP sessions share one local browser broker. |
| `searchapi` | Uses SearchApi as the primary provider and does not initialize Chrome for that tool. |
| `fallback` | Tries the current browser tier once, then uses SearchApi on browser errors, CAPTCHA/rate limits, profile failure, or parser degradation. It does not wait for human CAPTCHA recovery. Successful and normal empty browser responses are not repeated. |

`SURF_SEARCH_PROVIDER` controls `search` and `search_parallel`. `SURF_SCHOLAR_PROVIDER` controls `scholar_search`. SearchApi modes require your own SearchApi account, key, and available credits.

`SURF_BROWSER_ENGINE=auto` selects native Chrome on a local desktop and the Playwright compatibility path in cloud or remote-debug mode. Native mode uses a normal hidden Chrome window, not headless Chrome. Set `native` or `playwright` to pin the engine.

```json
{
  "mcpServers": {
    "google-surf": {
      "command": "npx",
      "args": ["-y", "google-surf-mcp"],
      "env": {
        "SEARCH_API": "your-searchapi-key",
        "SURF_SEARCH_PROVIDER": "fallback",
        "SURF_SCHOLAR_PROVIDER": "searchapi"
      }
    }
  }
}
```

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

## Search

- API-key-free system Chrome search
- Dedicated logged-out profile that never reads or copies the user's Chrome profile
- Multi-strategy SERP parsing with geometric verification
- Sponsored block and knowledge panel removal
- CAPTCHA detection and environment-specific recovery
- Parser self-healing and context fallback
