# Contributing

Bug reports, documentation improvements, tests, and focused code changes are
welcome. First-time contributors are welcome too.

## Before You Start

Small fixes can be submitted directly as pull requests. This includes typos,
documentation corrections, and focused bug fixes with regression tests.

For new features or significant changes, open an issue to discuss the problem
and proposed approach before starting implementation. Examples include public
API changes, database schema changes, and broad refactoring.

Check existing issues and pull requests to avoid duplicating work.

## Development and Testing

Use Node.js 22, which matches CI, and npm. Fork the repository and create a
branch for your changes.

```sh
npm ci
npx playwright install chromium
npm run build
npm test
```

On Linux, Playwright may also need system dependencies. Use
`npx playwright install --with-deps chromium` when needed.

Run the tests relevant to your change. For changes to scripts, MCP behavior,
hooks, or persistent storage, run the corresponding checks:

```sh
npx tsc -p tsconfig.scripts.json --noEmit
npm run smoke:mcp
npm run smoke:hooks
npm run research:reopen-probe
```

Use temporary research roots and dedicated test browser profiles. Do not run
tests against your personal browser profile or production research database.

## Pull Requests

- Keep each PR focused on one problem. Avoid unrelated refactoring or formatting.
- Explain what changed, why it is needed, and any user-visible behavior changes.
- Link the relevant issue when one exists.
- Add or update tests for behavior changes and documentation for affected usage.
- Include the verification commands and results. If a check was not run, say why.
- Follow the existing code style and keep CI checks passing.
- Redact API keys, credentials, personal information, and private research data
  from examples, logs, and screenshots.

Maintainers may request changes. Be prepared to explain your implementation and
address review feedback.

## AI-Assisted Contributions

AI-assisted contributions are welcome and follow the same standards as other
contributions. Review every change, understand how it works, run relevant tests,
and verify that it follows the repository's existing style.

Do not submit bulk, unreviewed generated content. You are responsible for the
correctness of your submission and for having the right to contribute it.

## License

By submitting a contribution, you agree to license it under this repository's
[MIT License](LICENSE).
