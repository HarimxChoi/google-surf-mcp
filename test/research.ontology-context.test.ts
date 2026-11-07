import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';

describe('grounded ontology research context', () => {
  let root: string;
  let service: ResearchService;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'surf-ontology-context-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Primary', 'primary');
    await service.createProject('Other', 'other');
  });
  afterEach(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('archives blocking and consent bodies without activating them as RAG evidence', async () => {
    const receipt = await service.capture({ tool: 'search', project_id: 'primary', payload: { query: 'quality', results: [
      { title: 'Blocked', url: 'https://example.org/blocked', content: 'blockedonlytoken', extraction_quality: 'blocked' },
      { title: 'Consent', url: 'https://example.org/consent', content: 'consentonlytoken', extraction_quality: 'consent_required' },
      { title: 'Short fact', url: 'https://example.org/fact', content: 'TTL returns -1 without expiry.', extraction_quality: 'thin_text' },
    ] } });
    expect(receipt).toMatchObject({ stored: 3, rag_active: 1, rag_inactive: 2 });
    const found = await service.searchFamilies('primary', 'blockedonlytoken consentonlytoken', 10);
    expect([...found.bm25, ...found.exact].some(row => row.content?.includes('blockedonlytoken') || row.content?.includes('consentonlytoken'))).toBe(false);
  });

  it('returns scoped definitions and aliases with evidence and revision identity', async () => {
    const evidence = await service.recordEvidence({ project_id: 'primary', source_type: 'manual', source_id: 'review', quote: 'Only non-cancelled reservations count.' });
    const draft = await service.recordOntologyTerm({ project_id: 'primary', kind: 'entity_type', name: 'Reservation', aliases: ['booking'], definition: 'A tentative booking.' });
    expect(draft.review_status).toBe('draft');
    const reviewed = await service.recordOntologyTerm({ project_id: 'primary', kind: 'entity_type', name: 'Reservation', aliases: ['booking'], definition: 'A non-cancelled booking.', evidence_ids: [evidence.evidence_id], review_status: 'reviewed', supersedes_term_id: draft.term_id });
    await service.recordOntologyTerm({ project_id: 'other', kind: 'entity_type', name: 'Reservation', aliases: ['booking'], definition: 'Private unrelated meaning.' });
    const context = await service.researchSearchContext('primary', ['compare booking constraints']);
    expect(context?.ontology_terms).toEqual([expect.objectContaining({ term_id: reviewed.term_id, version: 2, review_status: 'reviewed', definition: 'A non-cancelled booking.', evidence_ids: [evidence.evidence_id] })]);
    expect(JSON.stringify(context)).not.toContain('Private unrelated');
    expect((await service.getOntologyTerm(draft.term_id))?.status).toBe('superseded');
    await expect(service.recordOntologyTerm({ project_id: 'primary', kind: 'entity_type', name: 'Reservation', version: 2, definition: 'Overwrite' })).rejects.toThrow('revision already exists');
  });

  it('does not certify guesses or attach another project evidence', async () => {
    await expect(service.recordOntologyTerm({ project_id: 'primary', kind: 'relation', name: 'depends_on', definition: 'Needs evidence.', review_status: 'reviewed' })).rejects.toThrow('require definition and project evidence_ids');
    const evidence = await service.recordEvidence({ project_id: 'other', source_type: 'manual', source_id: 'foreign-review' });
    await expect(service.recordOntologyTerm({ project_id: 'primary', kind: 'relation', name: 'depends_on', definition: 'Foreign evidence.', evidence_ids: [evidence.evidence_id] })).rejects.toThrow('must belong to the project');
    expect(await service.researchSearchContext('primary', ['unrelatednonexistentterm'])).toBeUndefined();
  });

  it('marks bounded definitions and keeps their full record available', async () => {
    const definition = 'Meaning and applicability. '.repeat(40);
    const term = await service.recordOntologyTerm({ project_id: 'primary', kind: 'entity_type', name: 'Reservation', definition });
    const context = await service.researchSearchContext('primary', ['reservation']);
    expect(context?.ontology_terms?.[0]?.definition).toHaveLength(400);
    expect(context?.ontology_terms?.[0]?.definition_truncated).toBe(true);
    expect((await service.getOntologyTerm(term.term_id))?.definition).toBe(definition.trim());
  });
});
