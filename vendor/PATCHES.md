# Local Runtime Patch

The vendored Transformers.js 4.2.0 runtime receives a six-replacement patch for
pinned tokenizer discovery. Pipeline preflight and tokenizer metadata discovery
must forward `revision`, `cache_dir`, and `local_files_only`; otherwise a
revision-only offline cache can produce a pipeline with a null tokenizer.

The patch changes option propagation, not model weights, pooling, normalization,
or inference precision. It does not enable remote fallback.

- Original SHA-256: `1dc55b57189c1e800d6a83e001d1a7fd999145b117805a686e16f327eb0eb177`
- Patched SHA-256: `be9d5de42e2084c843d589d76e83e77a7e603cbbbdb5308d3c7affffea168b17`
- Reproduction: `node scripts/patch-transformers-revision.mjs`
- Regression test: `test/transformers.revision.test.ts`

The patch script is idempotent for this runtime and rejects unreviewed runtime
updates. Existing embedding fingerprints change so derived vectors can be
rebuilt without deleting source records. Startup build identity includes the
vendored runtime bytes.
