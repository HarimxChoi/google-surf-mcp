# Benchmarks

Recorded search, retrieval, vector-backend, and broker checks with their original scope and qualifications. These results are not a universal performance guarantee.

[Back to README](../README.md) | [Tools](tools.md) | [Auto Ontology](auto-ontology.md) | [Operations](operations.md)

## Numbers

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
