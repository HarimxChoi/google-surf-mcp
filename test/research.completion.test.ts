import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { projectMemoryTool } from '../src/research/tools.js';
import { embeddingContract, embeddingIndexKey, validateEmbeddingBatch, type EmbeddingProvider } from '../src/research/dense.js';
import { summarizeAssertionAggregate } from '../src/research/aggregate.js';
import type { ResearchStore } from '../src/research/store.js';

describe('complete scoped research contracts', () => {
  let root: string, service: ResearchService;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'surf-completion-'));
    service = new ResearchService({ enabled:true, root, endpoint:'mem://', vectorModel:'' });
    await service.createProject('Primary','primary'); await service.createProject('Other','other');
  });
  afterEach(async () => { await service.close(); rmSync(root,{ recursive:true, force:true }); });

  it('counts the full population, not a retrieval limit, and keeps project scope', async () => {
    for (let i=0;i<25;i++) await service.recordAssertion({ project_id:'primary', subject:`model-${i}`, predicate:'context', value:i, unit:'tokens', status:'confirmed', source:'explicit' });
    await service.recordAssertion({ project_id:'other', subject:'private', predicate:'context', value:999, unit:'tokens', status:'confirmed', source:'explicit' });
    const result = await projectMemoryTool({ action:'aggregate', project_id:'primary', aggregate:{ operation:'count', predicate:'context' }, expected_value:20 }, service);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.aggregate).toMatchObject({ value:25, expected_matches:false, top_k_used:false, population:{ project_ids:['primary'], complete:true } });
    expect((await service.aggregateAssertions(['primary'],{ operation:'max', predicate:'context' })).value).toBe(24);
    expect((await service.aggregateAssertions(['primary','other'],{ operation:'max', predicate:'context' })).value).toBe(999);
  });

  it('distinguishes empty, zero, mixed units and explicit unit conversion', async () => {
    expect((await service.aggregateAssertions(['primary'],{ operation:'count' })).value).toBe(0);
    expect(await service.aggregateAssertions(['primary'],{ operation:'max' })).toMatchObject({ status:'empty', value:null });
    for (const [subject,value,unit] of [['a',1,'GB'],['b',1,'GiB']] as const) await service.recordAssertion({ project_id:'primary', subject, predicate:'memory', value, unit, status:'confirmed', source:'explicit' });
    expect(await service.aggregateAssertions(['primary'],{ operation:'sum', predicate:'memory' })).toMatchObject({ status:'unit_mismatch', value:null });
    expect(await service.aggregateAssertions(['primary'],{ operation:'sum', predicate:'memory', unit:'B' })).toMatchObject({ status:'complete', value:2073741824, unit:'B' });
    await service.recordAssertion({ project_id:'primary', subject:'zero', predicate:'zero', value:0, status:'confirmed', source:'explicit' });
    expect(await service.aggregateAssertions(['primary'],{ operation:'mean', predicate:'zero' })).toMatchObject({ status:'complete', value:0 });
  });

  it('separates schema terms, instance facts, and host review provenance', async () => {
    const evidence=await service.recordEvidence({ project_id:'primary', source_type:'manual', source_id:'review', quote:'A release is a versioned model.' });
    const term=await service.recordOntologyTerm({ project_id:'primary', kind:'entity_type', name:'ModelRelease', definition:'A versioned model release.', review_status:'reviewed', evidence_ids:[evidence.evidence_id], review:{ actor:'test-reviewer', method:'rule' }, allowed_units:['tokens'] });
    const fact=await projectMemoryTool({ action:'record', record_type:'assertion', project_id:'primary', subject:'ModelRelease', predicate:'context', value:32768, unit:'tokens', assertion_status:'confirmed', evidence_ids:[evidence.evidence_id] },service);
    expect(fact.structuredContent?.record).toMatchObject({ knowledge_layer:'instance' });
    const context=await service.researchSearchContext('primary',['ModelRelease']);
    expect(context?.ontology_terms?.[0]).toMatchObject({ knowledge_layer:'schema', review:{ actor:'test-reviewer', method:'rule' } });
    expect(context?.assertions?.[0]).toMatchObject({ knowledge_layer:'instance', value:32768, unit:'tokens' });
    expect((await service.getOntologyTerm(term.term_id))?.allowed_units).toEqual(['tokens']);
    const legacy = vi.spyOn((service as unknown as { store: ResearchStore }).store, 'findOntologyTerms')
      .mockResolvedValue([{ ...term, knowledge_layer: undefined }]);
    expect((await service.researchSearchContext('primary',['ModelRelease']))?.ontology_terms?.[0]?.knowledge_layer).toBe('legacy_unclassified');
    legacy.mockRestore();
  });

  it('aggregates corrected values without destroying the old assertion', async () => {
    const old=await service.recordAssertion({ project_id:'primary', subject:'model', predicate:'context', value:16, unit:'tokens', status:'confirmed', source:'explicit' });
    await new Promise(r=>setTimeout(r,5)); const asOf=new Date().toISOString(); await new Promise(r=>setTimeout(r,5));
    await service.correctAssertion({ project_id:'primary', target_assertion_id:old.assertion_id, replacement:32, reason:'Source revision' });
    expect(await service.aggregateAssertions(['primary'],{ operation:'max', predicate:'context' })).toMatchObject({ value:32, unit:'tokens' });
    expect(await service.aggregateAssertions(['primary'],{ operation:'max', predicate:'context', recorded_as_of:asOf })).toMatchObject({ value:16 });
    expect((await service.getAssertion('primary',old.assertion_id))?.status).toBe('superseded');
  });
});

describe('embedding and scalar boundaries',()=>{
  const provider=(dimension:number,revision='a'):EmbeddingProvider=>({ enabled:()=>true, modelId:()=> 'same-model', dimensions:()=>dimension,
    fingerprint:()=>({ revision, normalization:'l2', quantization:'q8' }), embedQuery:async()=>[], embedPassages:async()=>[] });
  it('separates revisions and rejects unsupported dimensions explicitly',()=>{
    expect(embeddingContract(provider(384,'a')).fingerprint).not.toBe(embeddingContract(provider(384,'b')).fingerprint);
    expect(embeddingContract(provider(2048)).compatible).toBe(false);
    expect(()=>embeddingIndexKey(provider(2048))).toThrow('configuration mismatch');
    expect(()=>validateEmbeddingBatch([[NaN,...Array(383).fill(0)]],1)).toThrow('finite');
    expect(()=>validateEmbeddingBatch([Array(2048).fill(0)],1)).toThrow('384');
  });
  it('does not invent zero for missing or nonnumeric whole-population values',()=>{
    expect(summarizeAssertionAggregate({ operation:'sum' },0,[])).toMatchObject({ status:'empty', value:null });
    expect(summarizeAssertionAggregate({ operation:'mean' },2,[{ numeric_count:1,sum:2,min:2,max:2 }])).toMatchObject({ status:'non_numeric_values', value:null });
  });
});
