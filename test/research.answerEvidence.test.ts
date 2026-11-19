import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanAssertionContext, renderLiteralAnswer } from '../src/research/answerEvidence.js';
import { ResearchService } from '../src/research/service.js';
import { projectMemoryTool } from '../src/research/tools.js';

describe('source-backed answers', () => {
  let root: string;
  let service: ResearchService;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'surf-answer-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Answers', 'answers');
  });
  afterEach(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  async function document(body: string, assetId = 'source') {
    return await service.writeCatalogRecord({ project_id: 'answers', kind: 'document', operation: 'create',
      asset_id: assetId, idempotency_key: `create-${assetId}`, body, fields: { title: assetId } });
  }

  it('stores vocabulary and grounded facts then retrieves them in one public request', async () => {
    await document('Cedar native context is 8192 tokens; extended context is 32768 tokens.');
    const input = { action: 'record_knowledge' as const, project_id: 'answers', query: 'What is Cedar native context?',
      idempotency_key: 'cedar-bundle', knowledge: {
        ontology_terms: [{ key: 'native', kind: 'relation' as const, name: 'native_context', definition: 'Context with extension disabled.' }],
        assertions: [{ key: 'cedar-native', subject: 'Cedar', predicate: 'native_context', value: 8192, unit: 'tokens',
          context: { conditions: ['extension disabled'] }, evidence_refs: [{ record_id: 'source', quote: 'Cedar native context is 8192 tokens' }] }],
      } };
    const first = await projectMemoryTool(input, service);
    const second = await projectMemoryTool(input, service);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent?.knowledge?.status).toBe('ready');
    const fact = first.structuredContent?.knowledge?.records.find((row: { record_type: string }) => row.record_type === 'assertion');
    expect(first.structuredContent?.knowledge?.retrieved_assertion_ids).toContain(fact.record_id);
    expect(first.structuredContent?.results.some((row: { document_id: string; description: string }) =>
      row.document_id === fact.record_id && row.description.includes('8192') && row.description.includes('extension disabled'))).toBe(true);
    expect(second.structuredContent?.knowledge?.records).toEqual(first.structuredContent?.knowledge?.records);
    expect((await service.getProject('answers')).assertion_count).toBe(1);
    expect(await service['store'].listEvidence('answers')).toHaveLength(1);
  });

  it('reports partial bundle writes and resumes failed entries without duplicating committed facts', async () => {
    await document('Native context: 8192. Extended context: 32768.');
    const input = { project_id: 'answers', query: 'context', idempotency_key: 'partial-bundle', knowledge: {
      assertions: [
        { key: 'native', subject: 'Cedar', predicate: 'native_context', value: 8192,
          evidence_refs: [{ record_id: 'source', quote: 'Native context: 8192.' }] },
        { key: 'extended', subject: 'Cedar', predicate: 'extended_context', value: 32768,
          evidence_refs: [{ record_id: 'source', quote: 'Not present in source' }] },
      ],
    } };
    const partial = await service.recordKnowledge(input);
    expect(partial.status).toBe('partial');
    expect(partial.errors).toMatchObject([{ key: 'extended', record_type: 'assertion' }]);
    input.knowledge.assertions[1].evidence_refs[0].quote = 'Extended context: 32768.';
    const retried = await service.recordKnowledge(input);
    expect(retried.status).toBe('ready');
    expect(retried.records.find(record => record.key === 'native')?.record_id).toBe(partial.records[0].record_id);
    expect((await service.getProject('answers')).assertion_count).toBe(2);
    expect(await service['store'].listEvidence('answers')).toHaveLength(2);
    input.knowledge.assertions[0].value = 4096;
    const conflict = await service.recordKnowledge(input);
    expect(conflict.errors[0].message).toContain('idempotency key conflict');
  });

  it('rejects duplicate knowledge entry keys before any records are written', async () => {
    const fact = { key: 'same', subject: 'Cedar', predicate: 'count', value: 1,
      evidence_refs: [{ record_id: 'missing', quote: 'one' }] };
    await expect(service.recordKnowledge({ project_id: 'answers', query: 'count', idempotency_key: 'duplicate',
      knowledge: { assertions: [fact, { ...fact, value: 2 }] } })).rejects.toThrow('entry keys must be unique');
    expect((await service.getProject('answers')).assertion_count).toBe(0);
  });

  it('routes idempotent assertions and ontology terms to their own record kinds', async () => {
    await document('Cedar native context is 8192 tokens.');
    const termInput = { action: 'record' as const, record_type: 'ontology' as const, project_id: 'answers',
      ontology_kind: 'relation' as const, name: 'native_context', definition: 'Context without extension.', idempotency_key: 'native-term' };
    const term = await projectMemoryTool(termInput, service);
    const termAgain = await projectMemoryTool(termInput, service);
    expect(term.isError).not.toBe(true);
    expect(term.structuredContent?.record?.record_type).toBe('ontology');
    expect(termAgain.structuredContent?.record?.record_id).toBe(term.structuredContent?.record?.record_id);
    const input = { action: 'record' as const, record_type: 'assertion' as const, project_id: 'answers',
      subject: 'CEDAR_ROUTING_7359', predicate: 'native_context', value: 8192, idempotency_key: 'cedar-native',
      evidence_refs: [{ record_id: 'source', quote: 'Cedar native context is 8192 tokens.' }] };
    const first = await projectMemoryTool(input, service);
    const second = await projectMemoryTool(input, service);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent?.record?.record_type).toBe('assertion');
    expect(second.structuredContent?.record?.record_id).toBe(first.structuredContent?.record?.record_id);
    expect((await service.getProject('answers')).assertion_count).toBe(1);
    expect(await service['store'].listEvidence('answers')).toHaveLength(1);
    const found = await service.searchBatch('answers', 'CEDAR_ROUTING_7359', [], 10);
    expect(found.results.some(row => row.content.includes('8192'))).toBe(true);
    const changed = await projectMemoryTool({ ...input, value: 16384 }, service);
    expect(changed.isError).toBe(true);
    expect(changed.structuredContent?.error?.message).toContain('idempotency key conflict');
    const changedTerm = await projectMemoryTool({ ...termInput, name: 'extended_context' }, service);
    expect(changedTerm.isError).toBe(true);
    expect(changedTerm.structuredContent?.error?.message).toContain('idempotency key conflict');
  });

  it('rejects mixed catalog and assertion fields instead of storing a different record kind', async () => {
    const result = await projectMemoryTool({ action: 'record', record_type: 'assertion', project_id: 'answers',
      subject: 'synthetic', predicate: 'count', value: 7, asset_kind: 'document', operation: 'create', idempotency_key: 'mixed' }, service);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.message).toContain('record_type cannot be combined');
    expect((await service.getProject('answers')).assertion_count).toBe(0);
  });

  it('coalesces concurrent fact retries without duplicate evidence', async () => {
    await document('The measured count is seven.');
    const input = { project_id: 'answers', subject: 'counter', predicate: 'count', value: 7, source: 'explicit' as const,
      idempotency_key: 'concurrent-count', evidence_refs: [{ record_id: 'source', quote: 'The measured count is seven.' }] };
    const [a, b] = await Promise.all([service.recordAssertion(input), service.recordAssertion(input)]);
    expect(a.assertion_id).toBe(b.assertion_id);
    expect(await service['store'].listEvidence('answers')).toHaveLength(1);
    expect((await service.getProject('answers')).assertion_count).toBe(1);
  });

  it('links source quotes and facts atomically without caller-generated evidence IDs', async () => {
    await document('The official title is The Orchard of the Twenty-Second Century.');
    const result = await projectMemoryTool({ action: 'record', record_type: 'assertion', project_id: 'answers',
      subject: 'book', predicate: 'title', value: 'The Orchard of the Twenty-Second Century',
      evidence_refs: [{ record_id: 'source', quote: 'The Orchard of the Twenty-Second Century' }] }, service);
    expect(result.isError).not.toBe(true);
    const ids = result.structuredContent?.record?.evidence_ids as string[];
    expect(ids).toHaveLength(1);
    expect(await service['store'].getEvidence(ids[0])).toMatchObject({ source_type: 'catalog', source_id: 'source',
      source_revision: 1, quote: 'The Orchard of the Twenty-Second Century' });
    const projection = await service.exportGraphProjection(['answers']);
    expect(projection.edges.some(edge => edge.type === 'DERIVED_FROM')).toBe(true);
  });

  it('does not leave evidence or assertions behind when any quote fails validation', async () => {
    await document('Native context: 8192. Extended context: 32768.');
    await expect(service.recordAssertion({ project_id: 'answers', subject: 'model', predicate: 'context', value: 8192,
      source: 'explicit', evidence_refs: [{ record_id: 'source', quote: 'Native context: 8192' },
        { record_id: 'source', quote: 'fabricated value' }] })).rejects.toThrow('quote not found');
    expect(await service['store'].listEvidence('answers')).toHaveLength(0);
    expect((await service.getProject('answers')).assertion_count).toBe(0);
  });

  it('rejects sources owned only by another project', async () => {
    await document('Project-specific source.');
    await service.createProject('Other', 'other');
    await expect(service.recordAssertion({ project_id: 'other', subject: 'model', predicate: 'title', value: 'source',
      source: 'explicit', evidence_refs: [{ record_id: 'source', quote: 'Project-specific source.' }] }))
      .rejects.toThrow('record not found in project');
  });

  it('preserves articles and applies only requested punctuation removal', async () => {
    const quote = 'The Orchard of the Twenty-Second Century';
    await document(quote);
    const response = await projectMemoryTool({ action: 'answer', project_id: 'answers',
      answer: { record_id: 'source', quote, transforms: ['strip_punctuation'] } }, service);
    expect(response.structuredContent?.answer).toBe('The Orchard of the Twenty Second Century');
    expect(response.structuredContent?.verification).toMatchObject({ status: 'exact_source_quote', factual_correctness: 'not_checked' });
    expect(response.structuredContent?.source.quote_hash).toBe(createHash('sha256').update(quote).digest('hex'));
    expect(renderLiteralAnswer(quote)).toBe(quote);
    expect(renderLiteralAnswer('A Non\u2011Stop \u2014 Part Two', ['strip_punctuation', 'collapse_whitespace'])).toBe('A Non Stop Part Two');
    expect(renderLiteralAnswer("The Author's Tale", ['strip_punctuation'])).toBe('The Authors Tale');
    expect(() => renderLiteralAnswer(quote, ['remove_articles' as never])).toThrow('unsupported literal transform');
  });

  it('keeps UTF-8 byte offsets and quotes on later pages', async () => {
    const prefix = '\uD55C'.repeat(24_000);
    const quote = '  The Exact Name  ';
    await document(prefix + quote);
    await expect(service.resolveLiteralAnswer('answers', { record_id: 'source', quote })).rejects.toThrow('body_offset');
    const answer = await service.resolveLiteralAnswer('answers', { record_id: 'source', quote,
      body_offset: Buffer.byteLength(prefix) });
    expect(answer.answer).toBe(quote);
    expect(answer.source.body_span).toEqual({ start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + quote) });
  });

  it('separates an answer from the source sentence without rewriting either', async () => {
    await document('Official English title: A Journey Through the Night.');
    const answer = await service.resolveLiteralAnswer('answers', { record_id: 'source',
      quote: 'Official English title: A Journey Through the Night.', selection: 'A Journey Through the Night' });
    expect(answer.answer).toBe('A Journey Through the Night');
    expect(answer.source.body_span).toEqual({ start: 24, end: 51 });
    await expect(service.resolveLiteralAnswer('answers', { record_id: 'source',
      quote: 'Official English title: A Journey Through the Night.', selection: 'Journey Through Night' }))
      .rejects.toThrow('exact substring');
  });

  it('pins catalog revisions instead of silently quoting an updated source', async () => {
    await document('Previous title');
    await service.writeCatalogRecord({ project_id: 'answers', kind: 'document', operation: 'patch', asset_id: 'source',
      expected_revision: 1, idempotency_key: 'source-v2', body: 'New title' });
    await expect(service.resolveLiteralAnswer('answers', { record_id: 'source', quote: 'Previous title' }))
      .rejects.toThrow('quote not found');
    expect((await service.resolveLiteralAnswer('answers', { record_id: 'source', quote: 'Previous title', revision: 1 }))
      .source.revision).toBe(1);
  });

  it('keeps conditions, method, separate dates and media provenance searchable through correction', async () => {
    const context = { conditions: ['island != Cedar OR bill_length > 43'], assumptions: ['ideal gas approximation'],
      method: 'PV=nRT', publication_before: '2020-01-01T00:00:00Z', source_observed_at: '2026-11-18T00:00:00Z',
      media: { start_seconds: 12, end_seconds: 18, speaker_label: 'speaker_0' } };
    const fact = await service.recordAssertion({ project_id: 'answers', subject: 'SYNTHETIC_CONDITION_9385',
      predicate: 'measurement', value: 5, source: 'explicit', context });
    const correction = await service.correctAssertion({ project_id: 'answers', target_assertion_id: fact.assertion_id,
      replacement: 6, reason: 'New observation' });
    expect(correction.assertion.context).toEqual(cleanAssertionContext(context));
    const graph = await service.exportGraphProjection(['answers']);
    const node = graph.nodes.find(node => node.source_id === correction.assertion.assertion_id);
    expect(node?.text).toContain('ideal gas approximation');
    expect(node?.text).toContain('publication_before');
    expect(node?.text).toContain('speaker_0');
  });

  it('rejects empty quotes, invalid media intervals and date-only context', async () => {
    await document('Source');
    await expect(service.resolveLiteralAnswer('answers', { record_id: 'source', quote: '' })).rejects.toThrow('nonempty');
    await expect(service.resolveLiteralAnswer('answers', { record_id: 'source', quote: 'Source', body_offset: -1 }))
      .rejects.toThrow('nonnegative');
    expect(() => cleanAssertionContext({ media: { start_seconds: 9, end_seconds: 2 } })).toThrow('start_seconds');
    expect(() => cleanAssertionContext({ publication_before: '2020-01-01' })).toThrow('full ISO datetime');
    expect(() => cleanAssertionContext({ conditions: [''] })).toThrow('nonempty');
    expect(() => cleanAssertionContext({ candidate_scope: { universe: 'test', coverage: 'complete', limit_per_source: 3 } })).toThrow('requires window');
  });

  it('retrieves the requested event type ahead of a literal but inapplicable match at limit one', async () => {
    const common = { project_id: 'answers', predicate: 'prediction', source: 'explicit' as const };
    await service.recordAssertion({ ...common, subject: 'ALPHA_413', value: 4, context: {
      event_kind: 'recognition of capability', media: { start_seconds: 10, end_seconds: 25, speaker_label: 'speaker A', speaker_attribution: 'unverified' } } });
    const wanted = await service.recordAssertion({ ...common, subject: 'ALPHA_413', value: 10, context: {
      event_kind: 'device emergence', media: { start_seconds: 40, end_seconds: 51, speaker_label: 'speaker B', speaker_attribution: 'unverified' } } });
    expect((await service.getAssertion('answers', wanted.assertion_id)).context?.media?.speaker_attribution).toBe('unverified');
    const result = await service.searchBatch('answers', 'ALPHA_413', [], 1, [], undefined,
      { assertion_context: { event_kind: 'device emergence' } });
    expect(result.completed_lanes).toEqual(['graph']);
    expect(result.results.map(hit => hit.document_id)).toEqual([wanted.assertion_id]);
    const media = { speaker_attribution: 'unverified', end_seconds: 51, speaker_label: 'speaker B', start_seconds: 40 } as const;
    const filtered = await service.searchBatch('answers', 'ALPHA_413', [], 1, [], undefined, { assertion_context: { media } });
    expect(filtered.results.map(hit => hit.document_id)).toEqual([wanted.assertion_id]);
    await expect(service.search('answers', 'ALPHA_413', 1, [], undefined,
      { assertion_context: { event_kind: 'device emergence' }, retrieval_lanes: ['bm25'] })).rejects.toThrow('requires the graph');
  });
});
