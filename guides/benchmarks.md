# Benchmarks

Recorded search, retrieval, vector-backend, and broker checks with their original scope and qualifications. These results are not a universal performance guarantee.

[Back to README](../README.md) | [Tools](tools.md) | [Auto Ontology](auto-ontology.md) | [Operations](operations.md)

## Numbers

### NVIDIA Auto Ontology comparison

The recorded 2026-11-05 comparison used 48 revision-pinned model-card/configuration snapshots from 16 open-weight model releases, with 40 development questions and 120 held-out evaluation questions. The models in the corpus were the subject matter, not the answer generators.

| Context supplied to the shared SQL answerer | Correct / 120 |
|---|---:|
| Google Surf Auto Ontology | 116 |
| NVIDIA Auto Ontology | 113 |

Both contexts used the same `deepseek-flash` API identifier, temperature 0, thinking disabled, shared SQL-generation prompt, domain rules, schema, and read-only target database. The 120 questions covered 91 scalar results and 29 missing/unanswerable cases. Numeric results used a 1e-9 comparison tolerance; missing-value cases were scored separately from infrastructure failures. The API identifier is not an immutable model-weight snapshot.

The README's DeepSeek V4.1 Flash (1017) label follows the [official 2026-10-17 change log](https://api-docs.deepseek.com/updates/), which maps `deepseek-flash` to DeepSeek-V4.1-Flash-1017 before these November runs. The saved requests record the API alias, not an independently pinned model revision.

NVIDIA used official source revision `2a24f5d34ef6b6e168a7f22d308504d3ab36a198` with external provider/transport adapters. The primary embedding configurations differed: NVIDIA `nvidia/nemotron-3.5-embed-1b` (2048 dimensions), Surf `Xenova/multilingual-e5-small` q8 (384 dimensions). A separate matched-E5 NVIDIA run also scored 113/120. This is a shared SQL-evaluation track, not a comparison of default/native product agents or a general ontology-quality ranking.

The paired outcomes were 110 correct for both, 6 Surf-only, 3 NVIDIA-only, and 1 missed by both. The three-question gap does not establish general superiority. The corpus and question templates overlap by entity; this small task-specific evaluation is historical, not a score for every later source change. The adjacent graphic uses the saved generated ontology records; graph shape is not itself a quality metric.

Saved execution anchors: Surf service SHA-256 `320caf53340bed765e4879e01aef5988f9c6ae5de77714cd1ad4983d584283b4`, tools SHA-256 `a87896a7ebd380774fd22badfefdf7518f6237eb2b88b2a7782777482deab126`. These are local evaluation-source hashes, not a claimed public release commit. The graphic SHA-256 is `1c35263eac4f4e4f45988959d819e51f51b8be516ee5768d2ced0a1494a2aea7`. This page summarizes saved runs; it is not a complete reproduction bundle.

### Web answers vs Google AI Mode

| Recorded run | Questions | Required checkpoints | Surf + host fully met | AI Mode fully met |
|---|---:|---:|---:|---:|
| 2026-11-06 baseline | 12 | 36 | 18 | 35 |
| 2026-11-07 paired regression set | 8 | 24 | 22 | 24 |
| Later Host V2 replay of that set | 8 | 24 | 20 | 24 (saved answers) |

Each question had three required factual/conditional checkpoints. A partial or contradicted checkpoint was not counted as fully met. These totals do not mean every additional claim in an answer was correct. The eight questions were reused regressions, not a fresh hold-out sample; the twelve-question set combined eight regressions and four additions. Do not combine the sets into an improvement percentage.

Topics included Python TaskGroup, SQLite WAL, Kubernetes probes, Fetch, Redis TTL, Compose readiness, PyTorch inference/eval, and Rust poisoning. The Surf host was `deepseek-flash`, temperature 0, non-thinking, with private/project memory off. Outer limits were 180 seconds, at most 3 Surf searches, 6 source reads and 3 host calls, with a 1,200-character Korean answer and up to 6 cited sources. AI Mode used one fresh visible request; its internal model, compute, search count, cache and personalization were not observable. Equal outer task limits do not imply equal internal compute.

The paired run used runtime build SHA-256 `f69310d2886dada395a3d2bfffe4846e2567c68ee4e320e01476f7bab53fe944`; Host V2 used `f539cf3e7d6e0945378708295faeec521f075ab35c734a2ef698d1462e071495`. V2 changed post-hoc prompts and source forwarding and reused the earlier AI answers. Later four-question document diagnostics are a different population, and the new same-eight-question comparison remained incomplete. None of these is a new current-release score.

### Search speed

| | result |
|---|---|
| search | 4.0-5.1s/query |
| scholar_search | 3.8-5.6s/query |

Measured across three uncached queries per provider on a workstation with a 1Gb/s connection. Network and Google response time vary.

### Live web search reranker check

| 32 held-out queries | nDCG@5 | MRR | Precision@5 |
|---|---:|---:|---:|
| Provider order | 0.8949 | 0.8203 | 0.6375 |
| BM25 + RRF | **0.8971** | **0.8203** | **0.6500** |

Legacy README claim: web search responses with BM25+RRF reduce large retrieval payloads by up to *75%*. This is not a universal token or billing savings guarantee and is distinct from measured token-input reductions. Host serialization, tokenizer, evidence mode, and coverage affect the result; see [evidence handling](tools.md#multi-part-research-and-evidence-gaps).

## Auto Ontology retrieval check

The 60-query regression fixture compares the lexical baseline with the complete local RAG path. To separate retrieval changes from HNSW approximation, the check pins one embedding thread and uses exhaustive vector scoring. The table reports the median of three fresh-process runs:

| 60 controlled queries | Recall@10 | nDCG@10 | MRR@10 |
|---|---:|---:|---:|
| Lexical baseline | 0.3333 | 0.3333 | 0.3333 |
| Exact + BM25 + Vector + Graph RRF | **0.9833** | **0.8194** | **0.7668** |
| + shared reranker | **0.9833** | **0.8194** | **0.7668** |

All retrieved targets passed exact provenance readback. The conservative reranker preserved the fused order on this fixture; this check does not claim production search quality or a reranker gain.

`npm run research:vector-backends -- --rows 5000` compares physical representations with deterministic test vectors. The sample below excludes E5 model loading and should be rerun on the target machine:

| Backend | Input rows | Stored vectors | Insert | Query p95 | Recall |
|---|---:|---:|---:|---:|---:|
| HNSW | 5,000 | 5,000 | 1292.1 ms | 10.77 ms | 1.000 |
| Compact | 5,000 | 1,250 | 357.1 ms | 3.96 ms | 1.000 |
| Exhaustive | 5,000 | 5,000 | 1197.1 ms | 289.79 ms | 1.000 |

The default remains HNSW for full-chunk semantic coverage. Compact indexes one representative chunk per source; it used less memory and matched aggregate recall in this short-record fixture, but can miss rare details near the tail of long sources.

## Broker and durability check

| Latest 100-query local soak | Result |
|---|---:|
| Browser broker launches | 0 |
| Active database owner restarts | 0 |
| Query RSS delta | +10.9 MiB |
| Peak observed Auto Ontology worker RSS | 375.5 MiB |
| Idle drain and transparent reopen | Passed |
| No-op sync / one-file incremental sync | Passed / Passed |

`npm run research:reopen-probe` also verifies byte-exact body paging, a paginated 225-reference artifact manifest, and a pending rebuild that resumes after process restart and becomes searchable. The soak runs with the vector model disabled to isolate broker, database, and query lifecycle memory; vector backends are measured separately above.
