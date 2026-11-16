<img src="./assets/icon256.png" width="128" align="right" alt="google-surf-mcp"/>

# google-surf-mcp

English | [Korean](./README.ko.md)

[![npm version](https://img.shields.io/npm/v/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![ci](https://github.com/HarimxChoi/google-surf-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/HarimxChoi/google-surf-mcp/actions/workflows/ci.yml)
[![MCP Toplist](https://mcptoplist.com/badge/io.github.HarimxChoi%2Fgoogle-surf-mcp.svg)](https://mcptoplist.com/server/io.github.HarimxChoi%2Fgoogle-surf-mcp)
[![google-surf-mcp MCP server](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp/badges/score.svg)](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp)

<p align="center">
  <a href="https://www.searchapi.io/?utm_source=github&utm_medium=sponsorship&utm_campaign=google_search_api&utm_content=HarimxChoi_google-surf-mcp"><img src="./assets/searchapi-banner.png" width="100%" alt="SearchApi Google Search API" /></a>
</p>
<p align="center">Sponsored by <a href="https://www.searchapi.io/?utm_source=github&utm_medium=sponsorship&utm_campaign=google_search_api&utm_content=HarimxChoi_google-surf-mcp">SearchApi</a></p>

[Install](#quick-start) · [Benchmarks](#benchmarks) · [Architecture](#architecture) · [Tools](#tools)

Google Surf MCP searches the web, papers, and codebases, then uses Auto Ontology to organize what you read into a local knowledge graph.
Start without an API key or a separate database server, and build a personal knowledge base from connected sources and project records.

## Benchmarks

### Web search vs Google AI Mode

Eight developer questions covered Python TaskGroup, SQLite WAL, Kubernetes probes, Fetch, Redis TTL, Docker Compose, PyTorch, and Rust. Examples included SQLite's concurrent-writer limitations and whether PyTorch's `inference_mode()` replaces `model.eval()`.

The answer model paired with Google Surf was **[DeepSeek V4.1 Flash (1017)](https://api-docs.deepseek.com/updates/)** (`deepseek-flash`, temperature 0, thinking disabled).

| Evaluation | Google Surf + DeepSeek | Google AI Mode |
| --- | ---: | ---: |
| Result | **22/24** | **24/24** |

Three required checkpoints per question; the numbers count fully met checkpoints, not whole-answer accuracy. Recorded on 2026-11-07, not a new evaluation of the current release.

### Auto Ontology comparison

<a href="./assets/auto-ontology-benchmark.png"><img src="./assets/auto-ontology-benchmark.png" width="720" alt="Auto Ontology benchmark: NVIDIA 113/120, Google Surf 116/120, using the same 120 questions and DeepSeek model." /></a>

Both systems built ontologies from 48 revision-pinned model-card and configuration files covering 16 open-weight model releases. Their retrieved evidence was passed to the same DeepSeek V4.1 Flash (1017) model (`deepseek-flash`), SQL-generation prompt, and database: **Google Surf 116/120, NVIDIA Auto Ontology 113/120**. This compares ontology-backed retrieval, not the products' default agents.

[Evaluation setup, live-ranking results, and resource measurements](./guides/benchmarks.md)

## Architecture

<a href="./assets/architecture-en.png"><img src="./assets/architecture-en.png" width="100%" alt="Google Surf architecture: live discovery, source reading, and local project retrieval converge on bounded source-backed evidence." /></a>

### Technology stack

| Layer | Technologies |
| --- | --- |
| Runtime and protocol | TypeScript, Node.js 22.13+, MCP SDK, Zod |
| Browser search | System Chrome, Playwright, shared browser broker and reusable tabs |
| Source reading | HTTP, isolated headless BrowserContext, Mozilla Readability, Turndown |
| Documents and OCR | LiteParse CPU OCR; optional Xberg for Office; OfficeParser fallback; hwp-convert; pdf-lib; Sharp |
| Local storage | SurrealDB with embedded RocksDB, durable catalog and payloads, rebuildable indexes |
| Retrieval and ranking | Exact match, BM25, Multilingual E5-small q8/ONNX, HNSW, graph retrieval, RRF, cached E5 reranking |
| Code indexing | Tree-sitter for Python, TypeScript, and C++ structure |
| Graph analysis | Graphology, PageRank, Louvain communities, provenance and lineage projections |
| Network controls | Undici, DNS/IP-pinned reads, SSRF checks, deny-by-default source-reader proxy |

OCR is configurable; Xberg does not add another OCR or embedding model. Live-only search uses BM25/RRF without loading E5. [Architecture details](./guides/auto-ontology.md) · [Lightweight configuration](./examples/lightweight-documents.env)

## Quick start

Requires Node.js 22.13+ and Chrome or Chromium for browser search. CI covers Node 22 and 24 on Linux and Windows.

Register the server in your MCP client:

```json
{
  "mcpServers": {
    "google-surf": {
      "command": "npx",
      "args": ["-y", "google-surf-mcp@latest"]
    }
  }
}
```

Restart the client. Auto Ontology is enabled by default; the local embedding model may be downloaded when you first index content.
For search and extraction without the database or embedding model, set `SURF_RESEARCH=false` in the server environment.

[Client setup, local installation, and SearchApi configuration](./guides/getting-started.md)

## Search

- Search through system Chrome without an API key
- Dedicated logged-out profile; your personal Chrome profile is never read or copied
- Multi-strategy SERP parsing with geometric verification
- Removal of sponsored results and knowledge panels
- CAPTCHA detection and environment-specific recovery
- Parser self-healing and context fallback

Browser search is the default. [SearchApi](https://www.searchapi.io/?utm_source=github&utm_medium=sponsorship&utm_campaign=google_search_api&utm_content=HarimxChoi_google-surf-mcp) is an optional primary provider or fallback; it requires your own account, key, and credits.

## Supported AI providers and gateways

- [OrcaRouter](https://www.orcarouter.ai/ref/ref_7fd137d6c7b30793af2f) (free models available)

[Optional LLM-assisted repair and OrcaRouter setup](./guides/configuration.md#orcarouter)

## Tools

Seven tools are available with Auto Ontology enabled:

| Tool | Use |
| --- | --- |
| `search` / `search_parallel` | Discover **new web sources** and read them in the same call with `extract_mode`. |
| `scholar_search` | Find paper-specific Google Scholar metadata. |
| `extract` | Read a web page, PDF, or repository from an **already-known URL**. |
| `project_memory_search` | **Local-only** search of indexed project knowledge; no live web search. |
| `project_memory` | Manage projects, save research records, index user-approved local folders, and export graphs. |
| `health` | Inspect search and local runtime status. |

Providing `project_id` to web search does not make it local-only. Use `project_memory_search` for stored knowledge.

[Tool parameters, limits, follow-up reads, and repeatable source collection](./guides/tools.md)

## Google Surf Auto Ontology

<a href="./assets/graph-pkm.png"><img src="./assets/graph-pkm.png" width="100%" alt="Integrated project knowledge graph" /></a>

Search and extraction results are saved automatically. Plans, experiments, failures, and decisions are linked when your agent records them through `project_memory`.

Search stored knowledge across selected projects with exact-match, keyword, semantic, and graph retrieval, RRF fusion, and a shared reranker.

Projects stay separate by default. Selected projects can link knowledge using matching DOIs, repository URLs, or explicitly registered aliases; original records are not merged or moved.

Create a standalone graph explorer for one project:

```text
project_memory(action="export", project_id="my-project", export_format="html", export_view="graph")
```

The HTML explorer includes PKM, lineage, and ontology views with PNG/JSON downloads. DOT and Neo4j exports are also available.
The feature was renamed from Research to Auto Ontology; existing `SURF_RESEARCH*` settings, `project_memory*` tools, CLI names, and storage paths still work.

[Ontology, lineage, code indexing, and export details](./guides/auto-ontology.md)

## Documentation

| Guide | Contents |
| --- | --- |
| [Getting started](./guides/getting-started.md) | Installation, clients, browser search, SearchApi setup |
| [Tools and workflows](./guides/tools.md) | Tool parameters, limits, evidence responses, source collection |
| [Auto Ontology](./guides/auto-ontology.md) | Storage, code structure, graph retrieval, lineage, exports |
| [Configuration](./guides/configuration.md) | Environment variables, resource settings, OrcaRouter |
| [Operations and security](./guides/operations.md) | CAPTCHA, cache cleanup, CLI, privacy, optional Codex hooks |
| [Benchmarks](./guides/benchmarks.md) | Measurements, conditions, and evaluation boundaries |

[Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) · [MIT License](./LICENSE)
