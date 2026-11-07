# Operations

Optional Codex hooks, storage and security boundaries, local operations, and troubleshooting.

[Back to README](../README.md) | [Getting started](getting-started.md) | [Configuration](configuration.md) | [Auto Ontology](auto-ontology.md) | [Benchmarks](benchmarks.md)

## Optional Codex output protection

Google Surf can install an opt-in [Codex hook](https://developers.openai.com/codex/hooks) that ranks oversized Bash output before it reaches the model. The host still executes the command; the hook only applies stateless source-order, exact, and BM25 ranking with RRF. It opens neither the Google Surf database nor a browser and does not store command output.

```bash
npx -y google-surf-mcp@latest hooks install --host codex
```

Restart Codex, then open `/hooks` to review and trust the definitions. Shell output is reranked from 1,500 characters, with a default 1,500-character display budget that expands up to 3,000 for distinct query-matching evidence records or blocks. An explicit override may exceed 3,000; there is no cumulative per-turn output limit. Two identical or near-duplicate searches and explicit foreground polling loops are blocked. Existing `write_stdin` polls for an already-running unified command remain controlled by the Codex runtime, not this hook.

JSON/JSONL summaries use compact records with input-relative JSON pointers, ancestor identity/condition references and original result values. Markdown table rows retain headers and adjacent context, including source lines. Selected records and their required context must fit together; the renderer reports omissions instead of slicing records. Plain logs retain block reranking. Selection is deterministic and lexical, without a model, database or extra subprocess. Context extraction uses structural/field-name heuristics, not semantic understanding; unselected fields remain in the original input. These excerpts do not replace experiment logs or SSOT history. Input-relative pointers are not persistent retrieval handles. Existing installed hook bundles require an update to use changed code.

Output replacement uses Codex's non-rejecting `continue: false` response, not a blocking tool decision. The command's exit code remains visible in the summary; truncating a successful result does not turn it into a tool-call failure or interrupt later calls in the same code-mode script.

```bash
npx -y google-surf-mcp@latest hooks status --host codex
npx -y google-surf-mcp@latest hooks update --host codex
npx -y google-surf-mcp@latest hooks uninstall --host codex
```

## Storage scope and security

Auto Ontology is enabled by default. `search`, `search_parallel`, `scholar_search`, and `extract` results are captured automatically. Session intent, plans, experiments, and decisions are stored only when the MCP host sends them through `project_memory`; versioning, ontology mapping, and lineage linking then run automatically. Retrieval mode is server configuration, not a per-call argument.

Image retrieval, image embeddings, and visual reranking are not part of Auto Ontology. OCR is used only to recover searchable text from scanned PDF pages.

Credential and private-key files are excluded from body indexing. HTML exports omit source IDs, local paths, node bodies, plan text, and evidence quotes. The viewer initiates no network requests and opens stripped public HTTP or HTTPS source links only after user action.

Project and assertion deletion require a count preview and confirmation token. They create reversible tombstones and preserve evidence and correction history. Fact correction takes only `target_id`, `replacement`, and `reason`; the prior assertion remains as bitemporal history. Plan revisions are append-only. Experiments are bound to the active revision and must be finished explicitly as `success`, `failed`, or `inconclusive`. Logs are not used to infer an outcome. Receipts list stored categories only:

```text
Project: Graph memory | Session: temporal graph research | Stored: paper 1 (Graphiti), repo 1 (getzep), search summaries 3 | Status: ready
```

Set `SURF_RESEARCH=false` to keep the database and sidecar closed and omit `project_memory_search` and `project_memory`. Obsidian and Notion sync are not included and will remain project-level opt-in when added.

## Local operations CLI

These commands use the same authenticated Auto Ontology broker as MCP sessions. They do not open another embedded database owner or browser:

```powershell
npx google-surf-mcp doctor --json
npx google-surf-mcp daemon start --background --no-window
npx google-surf-mcp memory get --project PROJECT --record RECORD --json
npx google-surf-mcp memory sync --project PROJECT --manifest changes.json --json
npx google-surf-mcp memory current --project PROJECT --json
npx google-surf-mcp job wait --project PROJECT --id JOB --after-revision 0 --json
npx google-surf-mcp job cancel --project PROJECT --id JOB --reason "operator request" --json
npx google-surf-mcp daemon drain --json
```

`doctor` is passive: it reports process identity, versions, capabilities, queue counters, memory counters, cache bytes, current lifecycle state, foreground/background ownership, checkpoint-drain state, and the exact blockers preventing worker recycling without opening the database, vector model, or graph. The broker drains after meaningful work is idle even if an MCP client remains connected; active requests and commits postpone the drain, while rebuildable background jobs checkpoint at safe stage boundaries under memory pressure. The next request reconnects transparently.

Diagnostics also report whether the embedding model is loaded, its cached-vector count, active inference and completed batches, plus configured embedded-storage cache budgets. `npm run research:memory-soak -- 100` records cold, database-open, indexed, query and reopened stages, including the final query. Set `SURF_SOAK_VECTOR_MODEL=Xenova/multilingual-e5-small` to include the real pinned model and `SURF_SOAK_UNIQUE_QUERIES=true` to exercise new query inference rather than identical-query cache hits. The default run isolates storage and broker overhead with vectors disabled. RSS is measured, not attributed exactly to individual native allocators.

## Troubleshooting

- Native search keeps the current session open and shows Chrome when a CAPTCHA appears. Solve it in that window and retry; the next call verifies the page, restores the hidden window guard, and continues with the same session. SearchApi fallback remains available through `SURF_SEARCH_PROVIDER=fallback` and `SURF_SCHOLAR_PROVIDER=fallback`.
- Playwright CAPTCHA recovery has 4 modes (picked automatically from env):
  - default (local desktop): OS notification fires, headed Chrome opens, and the call returns; solve it and retry
  - `SURF_HEADLESS=false`: headed Chrome opens without a notification; solve it and retry
  - `SURF_REMOTE_DEBUG=true`: DevTools port + instructions printed, attach `chrome://inspect` locally to solve
  - `SURF_CLOUD_MODE=true`: fail-fast with `CAPTCHA_REQUIRED` error
- **Headed Chrome opens to a plain search box instead of CAPTCHA**: just type any query in the box and press Enter. Subsequent calls work.
- "Chrome not found": install Chrome or set `CHROME_PATH`.
- Stale selectors: runtime per-strategy reorder (`SURF_SELF_HEALING`, deterministic) plus a manually dispatched repair workflow (`SURF_LLM_HEAL` optional, human review required, never auto-merged).
- Playwright searches feel slower than expected: check `health().pool.fallback`. `true` means the worker pool is using a single context. Native search uses one authenticated local browser broker across MCP sessions. The broker keeps one hidden Chrome process with up to four reusable tabs for `search`, `search_parallel`, and `scholar_search`. Query starts are staggered. A CAPTCHA shows and preserves that session for user recovery, then the window guard is restored on the next call. A browser crash starts a new session on the next call.
- SSRF: `extract` blocks `localhost`, private IPs, AWS metadata by default. Set `SURF_ALLOW_PRIVATE=true` to allow them.
- Cache cleanup: `npm run cache:clear` removes search/extract and downloaded vector-model caches. It does not remove the Auto Ontology DB.
- The local Auto Ontology DB is not application-encrypted. Use OS account permissions and disk encryption such as BitLocker or FileVault when the machine or backups need at-rest protection.
