import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EvidenceBodyCache, cleanCapturedText, evidenceTerms, selectEvidence } from '../src/evidence.js';
import { classifyExtractedText, usableEvidence } from '../src/extractionQuality.js';
import { shapeExtractionResponse } from '../src/agent.js';
import { formatToolResponse } from '../src/response.js';

describe('query-focused source passages', () => {
  it('optionally preserves adjacent conditions as a short coherent paragraph', () => {
    const paragraph = 'Set key to hold the string value. If key already holds a value, it is overwritten. Any previous time to live associated with the key is discarded on successful SET operation.';
    const source = `${paragraph}\n\nKEEPTTL retains the expiry.\n\nOnly set the key if it already exists.`;
    const result = selectEvidence(source, 'SET key KEEPTTL', 400, [], 'coherent');
    expect(result.text).toContain(paragraph);
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(result.spans.map(s => source.slice(s.start, s.end)).join('\n\n')).toBe(result.text);
    expect(result.captured_hash).toBe(selectEvidence(source, 'SET key KEEPTTL', 400).captured_hash);
    expect(selectEvidence(source, 'SET key KEEPTTL', 400)).toEqual(selectEvidence(source, 'SET key KEEPTTL', 400, [], 'balanced'));
  });
  it('repeats coherent context only when an unseen sentence remains', () => {
    const first = 'Set key to hold the string value.';
    const paragraph = `${first} The old expiry is discarded. KEEPTTL retains it.`;
    expect(selectEvidence(paragraph, 'SET key', 250, [{ start:0, end:first.length }], 'coherent').text).toBe(paragraph);
    expect(selectEvidence(paragraph, 'SET key', 250, [{ start:0, end:paragraph.length }], 'coherent').text).toBe('');
  });
  it('keeps a code-form term attached to its definition, including follow-up reads', () => {
    const source = '`KEEPLEASE`\n\nPreserve the existing lease during an update.\n\nOther reference information.';
    const selected = selectEvidence(source, 'KEEPLEASE', 200, [{ start:0, end:11 }], 'coherent');
    expect(selected.text).toContain('`KEEPLEASE`');
    expect(selected.text).toContain('Preserve the existing lease during an update.');
    expect(selected.text.length).toBeLessThanOrEqual(200);
    expect(selected.spans.map(s => source.slice(s.start, s.end)).join('\n\n')).toBe(selected.text);
  });
  it('finds conditions beyond a large prefix without cutting signed values', () => {
    const source = 'Generic documentation introduction.\n'.repeat(1500)
      + 'TTL returns -1 when a key has no expiry.\nTTL returns -2 when the key does not exist.\nSET KEEPTTL preserves the expiry.';
    const out = selectEvidence(source, 'Redis TTL -1 -2 SET KEEPTTL', 420);
    expect(out.text).toContain('-1');
    expect(out.text).toContain('-2');
    expect(out.text).toContain('KEEPTTL');
    expect(out.spans.some((span) => span.start > 40_000)).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(420);
    expect(out.spans.map((span) => source.slice(span.start, span.end)).join('\n\n')).toBe(out.text);
    expect(out.captured_hash).toBe(createHash('sha256').update(source).digest('hex'));
  });
  it('keeps table headers and two exact hashes', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64);
    const source = `Model hash comparison\n| Model | SHA256 |\n| --- | --- |\n| first | ${a} |\n| second | ${b} |`;
    const out = selectEvidence(source, 'Model hash comparison first second SHA256', 400);
    expect(out.text).toContain('| Model | SHA256 |');
    expect(out.text).toContain(a);
    expect(out.text).toContain(b);
  });
  it('keeps code as a structured block', () => {
    const code = '```python\ndef gain(value):\n    return value - 1\n```';
    const out = selectEvidence(`Gain formula\n${code}`, 'gain value formula', 200);
    expect(out.text).toContain(code);
  });
  it('can return different passages from the same immutable snapshot', () => {
    const source = 'Alpha constraint has one writer.\nBeta constraint requires the same host.\nGamma constraint preserves expiry.';
    const first = selectEvidence(source, 'constraint Alpha', 48);
    const second = selectEvidence(source, 'constraint Beta', 60, first.spans);
    expect(first.text).toContain('Alpha');
    expect(second.text).toContain('Beta');
    expect(second.spans.every((a) => first.spans.every((b) => a.end <= b.start || b.end <= a.start))).toBe(true);
    expect(second.captured_hash).toBe(first.captured_hash);
  });
  it('handles empty input, zero budgets and fenced text', () => {
    expect(selectEvidence('', 'test', 200).text).toBe('');
    expect(selectEvidence('word', 'word', 0).text).toBe('');
    expect(cleanCapturedText('\n--- BEGIN UNTRUSTED CONTENT ---\nTTL -1\n--- END UNTRUSTED CONTENT ---\n')).toBe('TTL -1');
    expect(evidenceTerms('TTL이 -1 -2 H×F')).toEqual(expect.arrayContaining(['ttl', '-1', '-2', 'h', 'f']));
  });

  it('offers compact selection without changing balanced defaults', () => {
    const source = Array.from({ length: 12 }, (_, n) => `Constraint number ${n} requires a distinct source condition for evaluation.`).join('\n');
    const balanced = selectEvidence(source, 'constraint source condition', 1200);
    const compact = selectEvidence(source, 'constraint source condition', 1200, [], 'compact');
    expect(compact.text.length).toBeLessThan(balanced.text.length);
    expect(compact.spans.map(s => source.slice(s.start, s.end)).join('\n\n')).toBe(compact.text);
    expect(compact.captured_hash).toBe(balanced.captured_hash);
    expect(selectEvidence(source, 'constraint source condition', 1200, [], 'balanced')).toEqual(balanced);
  });

  it('preserves signed values and exact identifiers in compact mode', () => {
    const hash = 'f'.repeat(64);
    const source = `TTL returns -1 if a key has no expiry.\nTTL returns -2 if it does not exist.\nArtifact SHA256 is ${hash}.`;
    const out = selectEvidence(source, 'TTL -1 -2 SHA256 artifact', 350, [], 'compact');
    expect(out.text).toContain('-1'); expect(out.text).toContain('-2'); expect(out.text).toContain(hash);
  });

  it('can read another table row while retaining its header context', () => {
    const source = '| Model | Limit |\n| --- | --- |\n| Alpha | 16 |\n| Beta | 32 |';
    const first = selectEvidence(source, 'Alpha', 45);
    const next = selectEvidence(source, 'Beta', 45, first.spans);
    expect(next.text).toContain('| Model | Limit |');
    expect(next.text).toContain('Beta'); expect(next.text).not.toContain('Alpha');
  });

  it('locates complete lines inside long code without splitting identifiers', () => {
    const source = '```python\n' + Array.from({ length: 100 }, (_, n) => `value_${n} = ${n}`).join('\n')
      + '\nrare_constraint = -42\n```';
    const selected = selectEvidence(source, 'rare_constraint -42', 250, [], 'compact');
    expect(selected.text).toContain('rare_constraint = -42');
    expect(selected.text).toContain('```python');
    expect(selected.spans.map(s => source.slice(s.start, s.end)).join('\n\n')).toBe(selected.text);
  });
  it('shares one bounded final gate between single and parallel response formats', () => {
    const content = 'Unrelated navigation.\n'.repeat(1000) + 'The critical_value is 42 and does not change.';
    const row = { title: 'Reference', url: 'https://example.com', description: 'Overview', content };
    const single = shapeExtractionResponse(formatToolResponse({ query: 'critical_value', results: [row] }), { response_content: 'full' }, 'summary');
    const result = (single.structuredContent!.results as Array<Record<string, unknown>>)[0];
    expect(result.content).toContain('critical_value');
    expect(result.captured_length).toBe(content.length);
    const parallel = shapeExtractionResponse(formatToolResponse({ results: [{ query: 'critical_value', results: [row] }] }), { response_content: 'summary' }, 'summary');
    const summary = ((parallel.structuredContent!.results as Array<{ results: Array<Record<string, unknown>> }>)[0].results)[0];
    expect(summary.description).toContain('critical_value');
    expect(summary.content).toBeUndefined();
    expect(summary.excerpt).toBeUndefined();
    expect(String(summary.description).length).toBeLessThanOrEqual(1500);
  });
});

describe('bounded transient source snapshots', () => {
  it('expires without timers and never returns a different URL or mode', () => {
    let now = 0;
    const cache = new EvidenceBodyCache(100, 1000, () => now);
    const id = cache.put('https://one.test', { content: 'first' }, 'full')!;
    expect(cache.get('https://one.test', 'full', id)?.content).toBe('first');
    expect(cache.get('https://two.test', 'full', id)).toBeUndefined();
    expect(cache.get('https://one.test', 'abstract', id)).toBeUndefined();
    now = 1000;
    expect(cache.get('https://one.test', 'full', id)).toBeUndefined();
    expect(cache.stats().bytes).toBe(0);
  });
  it('evicts under a byte budget and distinguishes refreshed snapshots', () => {
    const cache = new EvidenceBodyCache(20);
    const old = cache.put('https://one.test', { content: '12345678' }, 'full')!;
    const fresh = cache.put('https://one.test', { content: 'abcdefgh' }, 'full')!;
    expect(fresh).not.toBe(old);
    expect(cache.get('https://one.test', 'full', old)).toBeUndefined();
    expect(cache.stats().bytes).toBeLessThanOrEqual(20);
    expect(cache.put('https://large.test', { content: 'x'.repeat(30) }, 'full')).toBeUndefined();
  });
});

describe('extraction quality states', () => {
  it('separates blocking screens from legitimate articles discussing CAPTCHA', () => {
    expect(classifyExtractedText('Just a moment...', 'Cloudflare checking your browser')).toMatchObject({ extraction_quality: 'blocked' });
    expect(classifyExtractedText('CAPTCHA research', 'This article discusses CAPTCHA and human verification. '.repeat(20))).toMatchObject({ extraction_quality: 'full_text' });
    expect(classifyExtractedText('Before you continue', 'Accept all or reject all consent choices')).toMatchObject({ extraction_quality: 'consent_required' });
  });
  it('keeps short factual text available while flagging thin and navigation bodies', () => {
    expect(classifyExtractedText('Value', 'TTL is -1.').extraction_quality).toBe('thin_text');
    expect(usableEvidence('thin_text')).toBe(true);
    expect(classifyExtractedText('Index', 'Home Documentation Support '.repeat(8), .95).extraction_quality).toBe('navigation_only');
    expect(usableEvidence('blocked')).toBe(false);
    expect(usableEvidence('consent_required')).toBe(false);
  });
});
