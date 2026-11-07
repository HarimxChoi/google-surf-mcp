import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { evidenceTerms } from './evidence.js';
import { usableEvidence } from './extractionQuality.js';
import { runtimeIdentity } from './runtimeIdentity.js';

export const RequirementSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  text: z.string().min(1).max(400),
  query_indices: z.array(z.number().int().min(0).max(11)).max(12).optional(),
});
export const RequirementsSchema = z.array(RequirementSchema).max(12).refine(rows => new Set(rows.map(r => r.id)).size === rows.length, 'requirement IDs must be unique').optional();
export type ResearchRequirement = z.infer<typeof RequirementSchema>;

export function requirementContract(groups: Record<string, unknown>[], requirements: ResearchRequirement[], requestId?: string): Record<string, unknown> {
  const references = new Map<string, string>();
  for (const group of groups) for (const row of (group.results ?? []) as Record<string, unknown>[]) {
    if (usableEvidence(row.extraction_quality) && (row.content || row.description)) references.set(`${row.url}\0${row.captured_hash ?? ''}`, String(row.content || row.description));
  }
  const candidates = groups.flatMap((group, query_index) => ((group.results ?? []) as Record<string, unknown>[]).map((row, result_index) => ({
    row, query_index, id: `q${query_index}:r${result_index}`,
    text: String(row.content || row.description || references.get(`${row.evidence_ref}\0${row.captured_hash ?? ''}`) || ''),
  })));
  const used = new Set<string>();
  const resolved = requirements.map(requirement => {
    const terms = evidenceTerms(requirement.text);
    const scoped = candidates.filter(c => !requirement.query_indices?.length || requirement.query_indices.includes(c.query_index));
    const matches = scoped.filter(c => usableEvidence(c.row.extraction_quality)).map(c => ({ ...c,
      overlap: terms.filter(t => evidenceTerms(`${c.row.title ?? ''} ${c.text}`).includes(t)).length,
    })).filter(c => c.overlap > 0).sort((a, b) => b.overlap - a.overlap).slice(0, 3);
    matches.forEach(c => used.add(c.id));
    const degraded = groups.some((g, i) => (!requirement.query_indices?.length || requirement.query_indices.includes(i))
      && (g.error || (Array.isArray(g.degraded_reasons) && g.degraded_reasons.length)));
    const read = matches.some(c => ['full_text', 'abstract', 'meta_abstract'].includes(String(c.row.extraction_quality)));
    return { id: requirement.id, status: degraded ? 'degraded' : read ? 'candidate_evidence' : matches.length ? 'needs_read' : 'missing',
      evidence_ids: matches.map(c => c.id), semantic_status: 'host_required' };
  });
  const next = resolved.map(r => {
    const candidate = candidates.find(c => r.evidence_ids.includes(c.id));
    return { requirement_id: r.id, kind: r.status === 'degraded' ? 'inspect_degradation' : candidate?.row.body_handle
      ? 'inspect_captured_passages' : candidate ? 'read_known_url' : 'search_missing_aspect',
      ...(candidate ? { evidence_id:candidate.id } : {}) };
  });
  const identity = runtimeIdentity();
  return { request_id: requestId ?? randomUUID(), build_id: identity.build_id, schema_hash: identity.schema_hash,
    requirements: resolved, unresolved: requirements.map(r => r.id), next_actions: next,
    evidence: candidates.filter(c => used.has(c.id)).map(c => ({ id:c.id, query_index:c.query_index, result_index:Number(c.id.split(':r')[1]) })),
    source_metadata: 'resolve_in_results', assessment: 'lexical_candidates_only', population: 'retrieved_candidates' };
}
