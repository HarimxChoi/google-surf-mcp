import { describe, expect, it } from 'vitest';
import { attachSearchEvidence } from '../src/searchEvidence.js';
import { formatToolResponse } from '../src/response.js';
import { RequirementsSchema } from '../src/researchRequirements.js';
import { canonicalJson, runtimeIdentity, trackSchema } from '../src/runtimeIdentity.js';
import { z } from 'zod';

describe('host requirement evidence contract', () => {
  it('maps scoped lexical candidates without asserting completion', () => {
    const response = attachSearchEvidence(formatToolResponse({ results: [
      { query: 'writer', results: [{ title: 'SQLite writer', url: 'https://example.org/a', description: 'Only one writer at a time.', extraction_quality: 'full_text', body_handle: 'h', evidence_ranges: [[0,30]], captured_hash: 'hash' }] },
      { query: 'replica', results: [] },
    ] }), 'storage limits', true, [{ id: 'writer', text: 'writer concurrency', query_indices: [0] }, { id: 'replica', text: 'replica limits', query_indices: [1] }], 'request-1');
    const contract = (response.structuredContent?.meta as any).research_contract;
    expect(contract).toMatchObject({ request_id: 'request-1', unresolved: ['writer', 'replica'], assessment: 'lexical_candidates_only', population: 'retrieved_candidates',
      requirements: [{ id: 'writer', status: 'candidate_evidence', evidence_ids: ['q0:r0'], semantic_status: 'host_required' }, { id: 'replica', status: 'missing', evidence_ids: [] }],
      next_actions: [{ kind: 'inspect_captured_passages', evidence_id:'q0:r0' }, { kind: 'search_missing_aspect' }],
      evidence: [{ id: 'q0:r0', query_index:0, result_index:0 }] });
    expect(contract.build_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not use blocked content or treat snippets as read originals', () => {
    const response = attachSearchEvidence(formatToolResponse({ results: [
      { query: 'policy', results: [{ title: 'policy', url: 'https://example.org', description: 'policy', extraction_quality: 'blocked' }], degraded_reasons: ['blocked'] },
      { query: 'limit', results: [{ title: 'limit', url: 'https://example.org/limit', description: 'limit is finite' }] },
    ] }), undefined, true, [{ id: 'policy', text: 'policy', query_indices: [0] }, { id: 'limit', text: 'limit', query_indices: [1] }]);
    expect((response.structuredContent?.meta as any).research_contract.requirements).toMatchObject([
      { status: 'degraded', evidence_ids: [] }, { status: 'needs_read' },
    ]);
  });

  it('is opt-in and validates duplicate IDs and boundary sizes', () => {
    const result = attachSearchEvidence(formatToolResponse({ results: [] }));
    expect((result.structuredContent?.meta as any).research_contract).toBeUndefined();
    expect(RequirementsSchema.parse([])).toEqual([]);
    expect(() => RequirementsSchema.parse([{ id: 'a', text: 'a' }, { id: 'a', text: 'b' }])).toThrow('unique');
    expect(() => RequirementsSchema.parse(Array.from({ length:13 }, (_, i) => ({ id:String(i), text:'x' })))).toThrow();
  });

  it('hashes canonical actual input schemas and changes when a limit changes', () => {
    expect(canonicalJson({ b:2, a:1 })).toBe(canonicalJson({ a:1, b:2 }));
    trackSchema('identity-test', { limit: z.number().max(10) });
    const first = runtimeIdentity();
    trackSchema('identity-test', { limit: z.number().max(20) });
    expect(runtimeIdentity().build_id).toBe(first.build_id);
    expect(runtimeIdentity().schema_hash).not.toBe(first.schema_hash);
  });
  it('keeps twelve requirement mappings below 8 KiB without repeating source bodies or URLs',()=>{
    const groups=Array.from({length:12},(_,i)=>({ query:'token', results:Array.from({length:3},(_,j)=>({ title:'token',description:'token',url:`https://example.org/${'x'.repeat(1900)}${j}`,extraction_quality:'full_text' })) }));
    const result=attachSearchEvidence(formatToolResponse({ results:groups }),undefined,true,Array.from({length:12},(_,i)=>({id:`${i}`.padEnd(64,'x'),text:'token',query_indices:[i]})));
    const contract=(result.structuredContent?.meta as any).research_contract;
    expect(Buffer.byteLength(JSON.stringify(contract))).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(contract)).not.toContain('https://');
  });
});
