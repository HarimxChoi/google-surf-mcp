# Evidence-Bounded Host Workflow

This is an optional host policy, not a hidden planner inside Google Surf. The host controls its own model, query budget, reading budget, and answer length.

1. Split a compound question into complementary queries and explicit requirements. Preserve versions, units, and exclusions. Quote signed literals such as `"-1"` so they are not confused with search operators.
2. Discover and read in the same `search` or `search_parallel` call. Treat requirement matches as candidates, not verified answers.
3. Inspect each missing aspect. Reuse a captured source with `body_handle`, a focused query, and excluded ranges when the needed material is already there. If the relevant source is missing, use a complementary discovery query. Reading one known source does not prohibit discovering a different missing source when the explicit budget permits both.
4. Compare claims before answering. Prefer the applicable official specification over conflicting secondary summaries. If the supplied evidence cannot resolve a conflict, withhold that aspect. A quotation is a claim, not certification that it is correct.
5. Preserve conditions, signs, units, source revisions, and API return types. Do not convert a default behavior into an unconditional guarantee or substitute a configuration value for an absent measurement.
6. Return a compact answer with source URLs and explicit unresolved aspects. Keep the original question and evidence unchanged when comparing a new policy; record added sources as a separate experiment.

This policy does not guarantee answer accuracy. The host must still inspect evidence, and a completed tool call can contain partial or blocked sources.
