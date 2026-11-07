import { formatToolResponse, type CallToolResult } from './response.js';
import { evidenceTerms } from './evidence.js';
import { usableEvidence } from './extractionQuality.js';
import { requirementContract, type ResearchRequirement } from './researchRequirements.js';

export function attachSearchEvidence(result: CallToolResult, goal?: string, parallel = false, requirements?: ResearchRequirement[], requestId?: string): CallToolResult {
  const data = result.structuredContent;
  if (result.isError || !data || !Array.isArray(data.results)) return result;
  const meta = data.meta as Record<string, unknown> | undefined;
  const groups = parallel ? data.results as Record<string, unknown>[] : [{
    results: data.results, degraded_reasons: meta?.degraded_reasons,
  }];
  const references = new Map<string, string>();
  for (const group of groups) for (const row of (group.results ?? []) as Record<string, unknown>[]) {
    if (row.description && usableEvidence(row.extraction_quality)) references.set(`${row.url}\0${row.captured_hash ?? ''}`, String(row.description));
  }
  const questions = groups.map((group, query_index) => {
    const rows = Array.isArray(group.results) ? group.results as Record<string, unknown>[] : [];
    const degraded = Boolean(group.error) || (Array.isArray(group.degraded_reasons) && group.degraded_reasons.length > 0);
    const extracted = rows.filter((row) => ['full_text', 'abstract', 'meta_abstract'].includes(String(row.extraction_quality))).length;
    const extractionFailed = rows.filter((row) => Boolean(row.extract_error)).length;
    const terms = evidenceTerms(String(group.query ?? goal ?? data.query ?? ''));
    const visible = evidenceTerms(rows.filter((row) => usableEvidence(row.extraction_quality))
      .map((row) => `${row.description || references.get(`${row.evidence_ref}\0${row.captured_hash ?? ''}`) || ''} ${row.content ?? ''}`).join(' '));
    const qualityIssues = [...new Set(rows.filter((row) => row.quality_reason || !usableEvidence(row.extraction_quality))
      .map((row) => String(row.extraction_quality)))];
    return {
      query_index,
      status: degraded ? 'degraded' : rows.length ? 'sources_found' : 'empty',
      source_count: new Set(rows.map((row) => row.url)).size,
      extracted_count: extracted,
      lexical_matches: terms.filter((term) => visible.includes(term)).length,
      lexical_terms: terms.length,
      ...(qualityIssues.length ? { quality_issues: qualityIssues } : {}),
      ...(extractionFailed ? { extraction_failed_count: extractionFailed } : {}),
      next_step: degraded || rows.some((row) => ['blocked', 'consent_required'].includes(String(row.extraction_quality)))
        ? 'resolve_sources' : !rows.length ? 'reformulate_query'
        : extracted || qualityIssues.length ? 'inspect_evidence' : extractionFailed ? 'retry_read' : 'read_sources',
    };
  });
  return formatToolResponse({
    ...data,
    meta: { ...meta, ...(requirements?.length ? { research_contract: requirementContract(groups, requirements, requestId) } : {}), evidence: {
      ...(goal ? { goal } : {}),
      answerability: 'not_assessed',
      semantic_assessment: 'host_required',
      questions,
    } },
  });
}
