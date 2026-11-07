# Tools

Tool arguments, evidence handling, and replayable research collection workflows.

[Back to README](../README.md) | [Getting started](getting-started.md) | [Auto Ontology](auto-ontology.md) | [Configuration](configuration.md)

## Tool reference

- `search(query, limit?, extract_mode?, extract_limit?, response_content?, max_chars?)` - primary single-query tool for live discovery and reading. When new sources must be found and read, set `extract_mode` in this call instead of downloading PDFs, cloning repositories, or calling `extract` separately. Use `extract` only when the exact public URL is already known and no discovery is needed. With `project_id`, stored project knowledge is fused with live results, but the call never becomes local-only. `limit` is 1-20. Extraction defaults to `none`; `extract_limit` is 1-10 with default 5. `response_content` defaults to `summary` to bound one-call output.
- `scholar_search(query, limit?)` - Google Scholar metadata search, max 10 papers. Supports browser, SearchApi primary, and fallback modes.
- `search_parallel(queries[], limit?, extract_mode?, extract_limit?, response_content?, max_chars?)` - primary multi-query tool for broad live discovery and reading through a continuous four-tab queue. Set `extract_mode` in the same call when public web pages, PDFs, papers, or GitHub repositories must be read. Use local PDF tools only for local files or visual layout work, and clone repositories only for editing, building, testing, or full Git history. `limit` is 1-20 per query. The call-wide `extract_limit` defaults to 12 and allows up to 20 for abstract; full defaults to and allows 10. `response_content` defaults to `summary` to bound one-call output.
- Integrated search extraction reports `requested`, `applied`, `skipped`, `truncated`, and `total_chars`. `remaining_urls` can be passed to `extract` without repeating the search.
- Both live search tools accept up to 12 `requirements` (`id`, `text`, optional zero-based `query_indices`) and a `request_id`. The opt-in `meta.research_contract` links each requirement to candidate results, unresolved items, and bounded next actions. Lexical matches are not semantic verification: the host must decide whether the evidence answers the question. `health().runtime_identity` exposes the runtime `build_id` and actual tool-input `schema_hash` for reproducible traces.
- `extract(url, max_chars?, mode?, response_content?, query?, body_handle?, exclude_spans?, refresh?)` - secondary extraction tool for an exact public URL when no new discovery is required. If sources still need to be found, use `search` or `search_parallel` with `extract_mode` instead.
  - `mode="full"` (default): reads up to 1000000 characters for Auto Ontology capture. Auto Ontology stores deterministic 4000-character chunks; `response_content="full"` returns up to 50000 characters and `summary` returns a 1500-character evidence excerpt.
  - `mode="abstract"`: ~1500-char survey (PDF page 1 or HTML meta description). Document metadata is included and stored with the survey when Auto Ontology is enabled.
  - `mode="metadata"`: metadata without body text. Returns available title, authors, publication, dates, DOI, description, keywords, canonical URL, and PDF properties including page count.
  - GitHub repository URLs read the README in metadata mode. Abstract and full use the same download gate and differ only in indexed source depth.
  - Response: content fields plus available document metadata. Failures return `{ error }`, never throw.
  - `query` selects relevant passages before the final response limit. `body_handle` reuses the same captured source in this MCP process for up to five minutes; `exclude_spans` skips previously returned passages. `refresh=true` reads a new snapshot and cannot be combined with a handle. Expired or mismatched handles fail explicitly, without silently opening a browser.
  - Summary `evidence_ranges` packs UTF-16 offsets as `[start, end]` pairs (inclusive start, exclusive end). Pass these back as `exclude_ranges`; detailed extraction retains object-form `evidence_spans` and accepts `exclude_spans` for compatibility. `captured_hash` hashes the captured clean text, not the original PDF binary. The transient cache has a 16 MiB conservative text-memory budget and does not open a database when `SURF_RESEARCH=false`. Prepared GitHub README snapshots use the same handle flow; project-local retrieval bodies are excluded from this public-source cache.
  - Full capture with Auto Ontology disabled is bounded to 50,000 characters. Source reading uses a separate reusable headless context without warming Google; PDF, abstract and metadata reads that finish over HTTP do not launch it. Its HTTP resources use DNS-validated, IP-pinned GET/HEAD requests; private/reserved addresses, credentials in URLs, WebSockets, service workers, and automatic downloads are blocked. A deny-only local proxy rejects unrouted browser traffic. Login-dependent or POST-only pages can remain unavailable. This policy applies to source reading, not Google's separate native search window.
  - `thin_text`, `navigation_only`, `blocked` and `consent_required` distinguish weak or inaccessible bodies from `full_text`. Thin factual text remains available; blocking/consent/navigation bodies are not activated as RAG evidence. `full_text` is a parsing status, not fact verification.

- `project_memory_search(query, query_variants?, project_id?, include_project_ids?, all_projects?, limit?, request_id?, response_deadline_ms?)` - searches stored local knowledge only. Up to 19 optional variants run inside one broker request with batched query embeddings, RRF fusion, evidence-seeded graph expansion, and one final rerank against `query`. The response contains only bounded query-focused summaries from the final ranking; stored bodies stay in the database. A caller-supplied `request_id` makes a long query observable and cooperatively cancellable through `project_memory`. If a deadline arrives after retrieval has produced candidates, the completed lanes return as an explicitly partial result instead of being discarded. It never opens a browser or calls Google or SearchApi.
- `project_memory(action, ...)` - manages durable project knowledge when `SURF_RESEARCH=true`.
  - `action="search"`: compatibility alias for `project_memory_search`.
  - `action="project_update"`: updates an existing project name, purpose, constraints, or protected parents as a revision-checked profile revision.
  - `action="context"`: separates the durable project purpose, confirmed session intent, provisional recent query, current plan, scientific experiment state, and observed process liveness.
  - `action="get"`: returns exact typed or legacy records through bounded UTF-8 byte spans. Set `body_bytes=0` for metadata only and use `next_body_offset` for lossless paging.
  - `action="show"`: always returns a bounded summary with counts and active record IDs. `detail_level="full"` is accepted for compatibility but never dumps every record body. Use `project_memory_search` for relevant bodies or `target_id` for one assertion or entity.
  - `action="record"`: stores the submitted body and returns only its ID, revision, and status. Receipts distinguish the original application from an idempotent replay.
  - `record_type="ontology"` defines schema terms and optional domain/range/allowed units. `record_type="assertion"` stores separate subject/predicate/value facts with optional units and confirmed/suggested status. Untagged legacy definitions remain `legacy_unclassified`; they are not silently reclassified or discarded. Review attribution preserves actor and method; an unspecified host review does not imply human verification.
  - `action="aggregate"`: reads every matching scoped assertion for `count`, `min`, `max`, `sum`, or `mean`, rather than aggregating top-k search hits. It reports population scope and a result hash, distinguishes empty data from numeric zero, checks units, and can compare an `expected_value`. This does not validate free-text reasoning.
  - `action="query_status"` / `action="query_cancel"`: inspects or cooperatively stops a local retrieval identified before execution by `request_id`.
  - `action="export"`: writes a standalone interactive HTML explorer, Graphviz DOT, D3 node-link JSON, or a Neo4j import bundle under `<research-root>/exports`.
- `health()` - server status, including the local Auto Ontology runtime.

Embedding indexes are keyed by model, revision, dimensions, normalization, quantization, and runtime fingerprint. The current vector index supports 384 dimensions; incompatible dimensions or invalid vectors degrade that lane explicitly while lexical and graph retrieval remain available. A changed fingerprint requires rebuilding the derived vector index, not deleting source records. The vendored runtime forwards the pinned revision through tokenizer discovery, including revision-only offline caches; see [the local runtime patch](../vendor/PATCHES.md).

`SURF_ALLOW_PRIVATE=true` is an explicit local-test override for private-address reads. Do not enable it when processing untrusted public content.

| Need | Tool |
|---|---|
| Search only previously stored research and project memory | `project_memory_search` |
| Find new information on the web | `search` |
| Compare new web results with stored project knowledge | `search` with `project_id` |
| Run several new web queries | `search_parallel` |

## Multi-part research and evidence gaps

For a compound question, let the host agent split it into complementary subquestions and call `search_parallel` with the original `research_goal` and those `queries`. Keep product names, versions, exclusions, and comparison criteria in the relevant queries. This uses the host's existing reasoning; Surf does not add a paid planning model or silently generate extra queries.

Quote signed literals such as `"-1"` and `"-2"` so Google does not interpret them as exclusion operators. Follow-up reads and new discovery address different gaps: reuse a known source when it can answer the missing aspect, but use a complementary query when the required source is absent. Keep the total query/read budget explicit; do not mark unresolved requirements complete just because another source was read.

Inspect returned passages, then use `extract(query=..., body_handle=..., exclude_spans=...)` for unresolved aspects of an already-read source before searching again. `meta.evidence.questions` reports availability, lexical overlap, and body-quality issues, **not proof of answerability**. `meta.research_degraded` exposes unavailable memory stages; `memory_storage=not_confirmed` means no successful storage receipt was obtained. A degraded redirect is not an evidence gap and does not trigger another identical search with a larger limit. Google-only delayed redirects honor the advertised wait within a bounded deadline; CAPTCHA and login pages are not solved automatically.

Ranked responses select query-focused source passages before one final output budget. Exact hashes, signed values, table headers and code remain linked to captured-text spans. Full captured bodies remain separate from the compact response; source reading and storage depth are not the amount sent to the model.

`search`, `search_parallel`, and `extract` accept `evidence_mode`. The default `balanced` preserves the existing passage density. Opt-in `compact` selects up to five less-redundant, byte-efficient passages; it can omit details, so use a focused `query` and follow up through the same `body_handle`. It does not change capture depth or load another model, and it is not an exact LLM-token limit.

Opt-in `coherent` keeps adjacent sentences in short paragraphs together, pairs code-form terms with their definitions, and reserves the first matching explanatory paragraph up to 500 characters within the same response budget. It can repeat previously seen context around an unseen condition and leave less room for other passages. Longer paragraphs, code, and tables retain the existing handling; no extra model is loaded. The default does not change.

JSON text responses are minified. Search summaries omit redundant capture/expiry timestamps and equal-length aliases; detailed extraction receipts remain available through `extract`. Identical excerpts from the same URL and captured hash are returned once; `evidence_ref` points to the earlier result. Shared table headers and code fences may repeat as context during follow-up reads. Token savings depend on the host's serialization and the model's tokenizer, not just character count.

For an unambiguous single-domain `site:example.org` query, live results are checked against that host and its subdomains before extraction, including cached results. Out-of-scope rows are omitted and reported as `site_scope_mismatch`, without repeating the search. Complex OR, multiple-site, and path-scoped expressions are left to the provider rather than reinterpreted locally.

## Replayable research collection

The collection runner also accepts `search_parallel` discovery and `extract` follow-up jobs in one MCP connection. See [the source-followup workflow](../examples/research-followup-workflow.example.json). Known URLs remain replayable across restarts; transient handles do not.

[The optional host policy](../examples/research-host-policy.md) covers requirement gaps, source reuse, primary-source conflicts, and bounded answers. It does not enable an extra model or change host settings automatically.

`google-surf-collect` runs a versioned JSON specification through one persistent MCP session. A specification can mix live `search` jobs with local-only `project_memory_search` jobs. Live jobs can extract bodies in the same call, while local jobs reuse indexed project knowledge without opening Google.

```bash
npx google-surf-collect examples/research-collection.example.json
```

From a source checkout:

```bash
npm run build
npm run research:collect -- examples/research-collection.example.json
```

A project workflow can also record durable sessions and plans, rebuild approved code roots, search the resulting local knowledge, and export its graph:

```bash
npm run research:collect -- examples/project-memory-workflow.example.json
```

`project_memory` collection jobs allow `record`, `rebuild`, and `export`. Destructive `forget` operations are not accepted by the collection schema. Project-level `project_id` is inherited by every job unless an all-project export is requested.

The output is append-only JSONL. Its manifest records the normalized specification hash, package version, Git commit, Node runtime, platform, project setup, and server health. Every search, record, rebuild, and export result records the stable job id, exact tool arguments, attempt, timestamps, elapsed time, response, and error state. Successful jobs are skipped on resume; failed jobs are retried. A changed specification requires a new output file. Set `project_name` with `project_id` when the runner should create a missing project; existing projects are reused.

Set `retrieval_mode` to `live` when prior project RAG state must not affect live result ranking. Results are still captured under `project_id`. Use `hybrid` when the collection intentionally ranks new web evidence together with stored project knowledge. API keys and environment variable values are never written to the collection log.

This makes the collection procedure and returned snapshot replayable and auditable. Live web results can still change with time, locale, network route, and upstream ranking.
