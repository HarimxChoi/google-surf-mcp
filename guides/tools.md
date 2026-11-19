# Tools

Tool arguments, evidence handling, and replayable research collection workflows.

[Back to README](../README.md) | [Getting started](getting-started.md) | [Auto Ontology](auto-ontology.md) | [Configuration](configuration.md)

## Tool reference

### Choose a route

| Need | Use | Avoid |
|---|---|---|
| Discover one new public topic and read it | `search` with `extract_mode` | Discovering URLs, then downloading every file in a shell |
| Discover several new public topics | `search_parallel`, 2-12 queries | Repeating one query for more extraction |
| Read an already known public URL | `extract`; use `query` and a valid `body_handle` for another passage | A new web search for the same body |
| Find indexed local documents, code or prior work | `project_memory_search`; use `query_variants` or grouped `queries` | `search`, shell loops, or whole-project dumps |
| Read one known stored record | `project_memory(action="get", query=...)` or bounded spans | Repeating broad retrieval |
| Return an exact source name or title | `project_memory(action="answer", answer={record_id, quote, selection})` | Paraphrasing the verified answer or dropping articles |
| Count or calculate across every matching stored fact | `project_memory(action="aggregate")` | Calculating from top-k hits |
| Inspect PDF/Office counts and document-wide properties | `extract(mode="metadata")` | Counting occurrences in an excerpt |

Live-only search uses lightweight BM25/RRF ranking without loading E5. Local project search automatically combines its enabled exact/BM25/vector/graph lanes with RRF and configured E5 reranking; agents do not need a separate ranking call. Restrict lanes only for a deliberate query, not as a default shortcut.

PDF/image OCR uses CPU LiteParse when configured. `SURF_EXTRACT_OCR=auto` targets PDF pages flagged as needing OCR and enables image text extraction; it does not interpret chart relationships or spatial meaning. Native Office uses optional Xberg without its OCR or model features, with OfficeParser as a fallback. No ColSmol model or experimental OOXML structure extractor is required. Check `extraction_quality`, `quality_reason`, and `meta.degraded_lanes` before treating a result as read evidence. A low-resource configuration example is in [lightweight-documents.env](../examples/lightweight-documents.env).

On a native-search CAPTCHA, stop submitting web requests. The existing browser keeps the first challenge tab in front for the user to solve; retry after the user confirms. It resumes the same profile and returns the window to the background only after a readable clear state. A closed or unreadable challenge is not proof of success. Separate incognito contexts do not share their challenge cookies, so launching a new context is not a recovery strategy.

- `search(query, limit?, extract_mode?, extract_limit?, response_content?, max_chars?)` - primary single-query tool for live discovery and reading. When new sources must be found and read, set `extract_mode` in this call instead of downloading PDFs, cloning repositories, or calling `extract` separately. Use `extract` only when the exact public URL is already known and no discovery is needed. With `project_id`, stored project knowledge is fused with live results, but the call never becomes local-only. `limit` is 1-20. Extraction defaults to `none`; `extract_limit` is 1-10 with default 5. `response_content` defaults to `summary` to bound one-call output.
- `scholar_search(query, limit?)` - Google Scholar metadata search, max 10 papers. Supports browser, SearchApi primary, and fallback modes.
- `search_parallel(queries[], limit?, extract_mode?, extract_limit?, response_content?, max_chars?)` - primary multi-query tool for broad live discovery and reading through a continuous four-tab queue. Set `extract_mode` in the same call when public web pages, PDFs, papers, or GitHub repositories must be read. Use local PDF tools only for local files or visual layout work, and clone repositories only for editing, building, testing, or full Git history. `limit` is 1-20 per query. The call-wide `extract_limit` defaults to 12 and allows up to 20 for abstract; full defaults to and allows 10. `response_content` defaults to `summary` to bound one-call output.
- Integrated search extraction reports `requested`, `applied`, `skipped`, `truncated`, and `total_chars`. `remaining_urls` can be passed to `extract` without repeating the search.
- Both live search tools accept up to 12 `requirements` (`id`, `text`, optional zero-based `query_indices`) and a `request_id`. The opt-in `meta.research_contract` links each requirement to candidate results, unresolved items, and bounded next actions. Lexical matches are not semantic verification: the host must decide whether the evidence answers the question. `health().runtime_identity` exposes the runtime `build_id` and actual tool-input `schema_hash` for reproducible traces.
- `extract(url, max_chars?, mode?, response_content?, query?, body_handle?, exclude_spans?, refresh?)` - secondary extraction tool for an exact public URL when no new discovery is required. If sources still need to be found, use `search` or `search_parallel` with `extract_mode` instead.
  - `mode="full"` (default): reads up to 1000000 characters for Auto Ontology capture. Auto Ontology stores deterministic 4000-character chunks; `response_content="full"` returns up to 50000 characters and `summary` returns a 1500-character evidence excerpt.
  - `mode="abstract"`: ~1500-char survey (PDF page 1 or HTML meta description). Document metadata is included and stored with the survey when Auto Ontology is enabled.
  - `mode="metadata"`: metadata without body text. Returns available title, authors, publication, dates, DOI, description, keywords, canonical URL, and PDF properties including page count.
  - PDF bodies retain the plain-text default. Optional `SURF_EXTRACT_PDF_FORMAT=markdown` reconstructs headings and tables, but complex merged cells can lose values or relationships; verify exact values against plain text or the page image. `content_format` identifies the representation. Abstract mode parses page 1 while `page_count` reports the full source count. Empty pages are `metadata_only`, including when the renderer produces empty formatting.
  - PNG, JPEG, WebP and TIFF URLs are read directly without browser navigation. Image metadata is available without OCR. Set `SURF_EXTRACT_OCR=true` and optionally `SURF_EXTRACT_OCR_LANGUAGE=eng+kor` to extract image text; the result identifies `extraction_method="ocr"`. This is text OCR, not interpretation of chart geometry or images without text. Unsupported formats and failed OCR return explicit quality reasons. Raster inputs are limited to 32 million aggregate pixels; split multipage images or reduce resolution when this limit is exceeded.
  - Binary document results include `extraction_provenance`: the original file SHA-256, parser and OCR policy. This differs from the derived-text `captured_hash`. The OCR policy does not claim that every page required OCR. Auto Ontology retains provenance with the active captured body; replacing that body without provenance clears the previous association.
  - DOCX/PPTX and HWP 5/HWPX are read from bytes in a serialized, temporary Node worker. `document_format` and `extraction_provenance.parser` identify the actual path. OfficeParser retains notes through its modern text renderer. HWP text boxes, charts, embedded objects and some headers/notes can be omitted; `quality_reason` reports this limitation. Image-only Office pages are not automatically interpreted as charts or OCRed.
  - For DOCX/PPTX source-wide properties or PPTX slide/notes counts, use `mode="metadata"`. `document_catalog` reads selected package XML without parsing the body or opening media, embedded objects, or external links. Producer properties, notes relationships and nonempty note-body counts are different metrics; a difference does not prove stale metadata. Slide indexes are one-based. Hidden-slide counts require `slide_parts_complete=true` for completeness; nonempty note counts are lower bounds unless `note_body_scope_complete=true`. Unknown placeholder roles remain unknown. DOCX producer page counts are not rendered page counts.
  - `document_catalog` is limited to 6,000 UTF-16 characters within the current response budget, including cached and summary responses. `details_truncated=true` means property or index lists were shortened; preserved count fields still refer to the parsed source, not to the shortened list. If even the count summary cannot fit, the catalog is omitted and `truncated=true`. Selected part hashes and the original byte hash identify the evidence; skipped payloads are not decompressed or validated in metadata mode.
  - Office metadata captures the same bounded 6,000-character catalog before response shaping, so a small first response does not require another download to read the already captured fields. The five-minute transient snapshot is bound to URL and mode, uses the existing 32-entry/16-MiB accounting limits, and includes metadata in its byte accounting. Use `refresh=true` for a new capture. This does not make omitted fields recoverable or add query-focused catalog parsing.
  - Native documents have a 25 MiB source limit, 64 MiB expanded-content limit, 4,096 ZIP-entry limit and a 30-second worker deadline. Local PDF/image workers have a 120-second deadline. Workers use a 256 MiB V8 heap and exit after two idle seconds; the heap limit is not an RSS/native-allocation limit. Node permission flags do not block network connections or provide an OS security sandbox, especially when native addons are enabled. The byte-only parser interface receives no URL, shell command or model API key.
  - GitHub repository roots and tree URLs read the README in metadata mode. Abstract and full use the same download gate and differ only in indexed source depth. Issues, pull requests, discussions and individual file pages are not replaced by repository README capture; they follow the source-page reader.
  - Response: content fields plus available document metadata. Failures return `{ error }`, never throw.
  - `query` selects relevant passages before the final response limit. `body_handle` reuses the same captured source in this MCP process for up to five minutes; `exclude_spans` skips previously returned passages. `refresh=true` reads a new snapshot and cannot be combined with a handle. Expired or mismatched handles fail explicitly, without silently opening a browser.
  - Summary `evidence_ranges` packs UTF-16 offsets as `[start, end]` pairs (inclusive start, exclusive end). Pass these back as `exclude_ranges`; detailed extraction retains object-form `evidence_spans` and accepts `exclude_spans` for compatibility. `captured_hash` hashes the captured clean text, not the original PDF binary. The transient cache has a 16 MiB conservative text-memory budget and does not open a database when `SURF_RESEARCH=false`. Prepared GitHub README snapshots use the same handle flow; project-local retrieval bodies are excluded from this public-source cache.
  - Full capture with Auto Ontology disabled defaults to 50,000 characters. `deep_read=true` explicitly permits up to 1,000,000 source characters for a full `search`, `search_parallel`, or `extract` read, without enabling a database. Returned `max_chars` and the bounded transient text-cache budget stay unchanged. If an old handle points to a clipped snapshot, capture the known URL with `deep_read=true, refresh=true` and no handle. This is another source read, not another Google search.
  - Source reading uses a separate reusable headless context without warming Google; PDF, abstract and metadata reads that finish over HTTP do not launch it. Its HTTP resources use DNS-validated, IP-pinned GET/HEAD requests; private/reserved addresses, credentials in URLs, WebSockets, service workers, and automatic downloads are blocked. A deny-only local proxy rejects unrouted browser traffic. Login-dependent or POST-only pages can remain unavailable. This policy applies to source reading, not Google's separate native search window.
  - `thin_text`, `navigation_only`, `blocked` and `consent_required` distinguish weak or inaccessible bodies from `full_text`. Thin factual text remains available; blocking/consent/navigation bodies are not activated as RAG evidence. `full_text` is a parsing status, not fact verification.

- `project_memory_search(query, query_variants?, project_id?, include_project_ids?, all_projects?, limit?, request_id?, response_deadline_ms?)` - searches stored local knowledge only. Up to 19 optional variants run inside one broker request with batched query embeddings, RRF fusion, evidence-seeded graph expansion, and one final rerank against `query`. The response contains only bounded query-focused summaries from the final ranking; stored bodies stay in the database. A caller-supplied `request_id` makes a long query observable and cooperatively cancellable through `project_memory`. If a deadline arrives after retrieval has produced candidates, the completed lanes return as an explicitly partial result instead of being discarded. It never opens a browser or calls Google or SearchApi.
  - `filters.assertion_context` matches the supplied fields exactly and searches only assertions through the graph lane. Use it when you know the condition, calculation method, source snapshot or event type. Omit it to discover alternatives or find original documents.
- `project_memory(action, ...)` - manages durable project knowledge when `SURF_RESEARCH=true`.
  - `action="search"`: compatibility alias for `project_memory_search`.
  - `action="project_update"`: updates an existing project name, purpose, constraints, or protected parents as a revision-checked profile revision.
  - `action="context"`: separates the durable project purpose, confirmed session intent, provisional recent query, current plan, scientific experiment state, and observed process liveness.
  - `action="get"`: returns exact typed or legacy records through bounded UTF-8 byte spans. Set `body_bytes=0` for metadata only and use `next_body_offset` for lossless paging.
  - `action="show"`: always returns a bounded summary with counts and active record IDs. `detail_level="full"` is accepted for compatibility but never dumps every record body. Use `project_memory_search` for relevant bodies or `target_id` for one assertion or entity.
  - `action="record"`: stores the submitted body and returns only its ID, revision, and status. Receipts distinguish the original application from an idempotent replay.
  - `record_type="ontology"` defines schema terms and optional domain/range/allowed units. `record_type="assertion"` stores separate subject/predicate/value facts with optional units and confirmed/suggested status. Untagged legacy definitions remain `legacy_unclassified`; they are not silently reclassified or discarded. Review attribution preserves actor and method; an unspecified host review does not imply human verification.
  - Assertion `evidence_refs=[{record_id, quote}]` verifies exact quotes from stored project sources and links them in the same transaction. Optional `revision` pins a catalog revision; `body_offset` selects a later 64KiB page. Existing `evidence_ids` remain supported. `context` preserves conditions, assumptions, calculation method, publication cutoff, source observation time, and media intervals in graph retrieval. A speaker label does not establish a person's identity.
  - `action="answer"` verifies `answer.quote` in a stored record and returns `answer.selection`, an exact substring, or the whole quote. Optional transforms are `trim`, `collapse_whitespace`, and `strip_punctuation`; use only requested operations. When stripping punctuation, dashes between letters become spaces so words do not merge. Submit the returned answer without rewriting it. This verifies source fidelity, not factual correctness.
  - `action="aggregate"`: reads every matching scoped assertion for `count`, `min`, `max`, `sum`, or `mean`, rather than aggregating top-k search hits. It reports population scope and a result hash, distinguishes empty data from numeric zero, checks units, and can compare an `expected_value`. This does not validate free-text reasoning.
  - Use `aggregate.context` to select a condition, method, or snapshot. Mixed contexts return `mixed_contexts` unless you set `allow_mixed_contexts: true`. A fixed `subjects` list requires exactly one matching observation per subject (`incomplete_cohort` otherwise). `require_complete_candidates: true` checks the stored coverage declarations; a window or unknown coverage returns `incomplete_candidates`. It does not verify that the original source actually covered the entire candidate set.
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

Opt-in `coherent` keeps adjacent sentences in short paragraphs together, pairs code-form terms with their definitions, and retains bounded neighboring table rows. It reserves the highest-scoring matching explanatory paragraph up to 500 characters within the same response budget. It can repeat previously seen context around an unseen condition and leave less room for other passages. No extra model is loaded. The default does not change. In all modes, soft-wrapped prose is segmented without breaking a sentence at a PDF line break; returned spans still reference the original captured text.

With a valid page map, `coherent` also pairs selected measurements with short, explicitly marked same-page notes. It keeps the original source ranges and response budget, skips duplicate/ambiguous markers and unbounded note tails on incomplete captured pages, and does not replace a requested table's selected rows just to add a note. Numeric suffixes use common measurement units, not arbitrary identifiers such as `DDR5`. This is a lexical context link, not visual or semantic verification. Cross-page or cross-chunk notes can still require a focused follow-up read.

JSON text responses are minified. Search summaries omit redundant capture/expiry timestamps and equal-length aliases; detailed extraction receipts remain available through `extract`. Identical excerpts from the same URL and captured hash are returned once; `evidence_ref` points to the earlier result. Shared table headers and code fences may repeat as context during follow-up reads. Token savings depend on the host's serialization and the model's tokenizer, not just character count.

PDF and OCR image evidence can include bounded `source_refs`: selected page numbers, OCR page numbers, and short table/figure caption candidates. `excerpt_pages` contains `[start, end, physical_page]` tuples in the returned excerpt's UTF-16 coordinates; inserted joins and unmapped gaps have no inferred page. Caption ranges instead use UTF-16 offsets in the captured text and are text matches, not verified visual interpretation. The full page map stays internal; excerpts and references share the existing response budget and references may be partial. Auto Ontology preserves these maps for newly captured or indexed documents and exact paged reads. A body-hash mismatch drops stale references; older records without a map remain searchable without page references.

When a PDF table is identified, follow up on the same URL/handle with `query="Table 3-4 GPIO45 voltage"` and `evidence_mode="coherent"`. A matching caption in a verified page map prioritizes bounded native row windows with their column header, including a continued table on the next page. The source text is not rewritten, and large tables can still require more bounded reads. Shared column headers can repeat around an unseen row. Generic questions do not force an inferred table choice. Page boundaries reset fallback Markdown table-header state; text-only margin heuristics do not erase numeric facts.

For an unambiguous single-domain `site:example.org` query, live results are checked against that host and its subdomains before extraction, including cached results. Out-of-scope rows are omitted and reported as `site_scope_mismatch`, without repeating the search. Complex OR, multiple-site, and path-scoped expressions are left to the provider rather than reinterpreted locally.

## Store and retrieve task knowledge

For large imports, partial save receipts, scoped sports/model retrieval, source whitelists and resumable jobs, see [the reliability checklist](reliability-checklist.md). `sync`/`rebuild` return a job by default; `job_status` is compact, `job_sources` pages IDs, and `readiness` distinguishes stored records from searchable documents/vector chunks. Use `project_update` for the parent profile and `track` for subareas.

Use `project_memory(action="record_knowledge", project_id=..., query=..., idempotency_key=..., knowledge=...)` when a host has source-backed facts ready for an ontology. `knowledge` contains up to 20 `ontology_terms` and 1-20 `assertions`, each with a stable `key`. Each assertion needs exact `evidence_refs` quotes from records already stored in the project; keep conditions, units, dates and media intervals in `context`.

One call validates quotes, persists the terms and assertions, and returns ranked graph-search results for the question and assertion subjects. Surf runs no extra language model or shell. Writes are atomic and idempotent per record, not for the entire bundle: inspect `knowledge.status`, `records`, `errors` and `retrieved_assertion_ids`. A partial result keeps committed records; retry them with unchanged keys and content while repairing failed entries. Exact quote verification confirms provenance, not that a factual claim is true. Continue source investigation when the retrieved facts do not settle the question.

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
