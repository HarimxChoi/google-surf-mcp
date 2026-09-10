import { describe, expect, it } from 'vitest';
import { evidenceRecords } from '../src/evidenceRecords.js';
import { formatRerankedOutput, rerankOutput } from '../src/outputRerank.js';
import { processOutputHook } from '../src/rerankOutput.js';

describe('compact evidence records', () => {
  it('keeps experiment identity, conditions, units and provenance with each result', () => {
    const result = rerankOutput('perplexity', [
      { experiment_id: 'a', source: '/runs/a.json', contract: { context: 512, split: 'validation', unit: 'PPL' }, result: { perplexity: 6.3 } },
      { experiment_id: 'b', source: '/runs/b.json', contract: { context: 2048, split: 'test', unit: 'PPL' }, result: { perplexity: 8.9 } },
    ], { max_chars: 2_000 });
    for (const block of result.results.filter(item => item.text.includes('perplexity'))) {
      const context = block.context_indices!.map(id => result.results.find(item => item.source_index === id)!.text).join('\n');
      const a = block.locator!.includes('/0/');
      expect(context).toContain(a ? '"context":512' : '"context":2048');
      expect(context).toContain(a ? '/runs/a.json' : '/runs/b.json');
      expect(context).not.toContain(a ? '/runs/b.json' : '/runs/a.json');
      expect(context).toContain('"unit":"PPL"');
    }
    expect(result.results.filter(item => item.text.includes('perplexity'))).toHaveLength(2);
  });

  it('never emits a record with missing context or a chopped numeric value at budget boundaries', () => {
    const raw = { experiment: 'run1', contract: { context: 2048, tokenizer: '/frozen/tokenizer' }, result: { perplexity: 10.123456789 } };
    for (const max_chars of [1, 100, 200, 350, 500, 1_000, 1_500, 3_000]) {
      const result = rerankOutput('perplexity', raw, { max_chars });
      expect(formatRerankedOutput(result).length).toBeLessThanOrEqual(max_chars);
      for (const block of result.results) {
        expect(() => JSON.parse(block.text)).not.toThrow();
        for (const dependency of block.context_indices!) expect(result.results.some(item => item.source_index === dependency)).toBe(true);
      }
      if (formatRerankedOutput(result).includes('perplexity')) expect(formatRerankedOutput(result)).toContain('10.123456789');
    }
  });

  it('retains contradictory runs and false/zero/null values without conflating repeated leaf names', () => {
    const raw = { runs: [
      { id: 'old', source: 'old.json', result: { accuracy: 0 }, verified: false },
      { id: 'new', source: 'new.json', result: { accuracy: null }, verified: true },
    ] };
    const displayed = formatRerankedOutput(rerankOutput('accuracy', raw));
    expect(displayed).toContain('input#/runs/0/result');
    expect(displayed).toContain('input#/runs/1/result');
    expect(displayed).toContain('"accuracy":0');
    expect(displayed).toContain('"accuracy":null');
    expect(displayed).toContain('"verified":false');
  });

  it('escapes JSON pointer keys and preserves Unicode identities', () => {
    const raw = { 'a/b~c': { experiment_id: '한국어-測定', result: 8.75 } };
    const displayed = formatRerankedOutput(rerankOutput('result', raw));
    expect(displayed).toContain('input#/a~1b~0c');
    expect(displayed).toContain('한국어-測定');
  });

  it('retains table headers, preceding measurement conditions and adjacent source links', () => {
    const raw = '# Results\n\nContext 2048, test split.\n\n| Model | PPL |\n|---|---:|\n| A | 8.75 |\n| B | 9.15 |\n\nSource: [results](results.json)\n\nThese are reused controls, not new measurements.';
    const result = rerankOutput('Model A', raw, { max_chars: 1_000 });
    const displayed = formatRerankedOutput(result);
    expect(displayed).toContain('| A | 8.75 |');
    expect(displayed).toContain('| Model | PPL |');
    expect(displayed).toContain('Context 2048, test split.');
    expect(displayed).toContain('[results](results.json)');
    expect(displayed).toContain('reused controls, not new measurements');
    expect(displayed).toContain('input:L');
  });

  it('preserves nested identities, sampling contracts and negative scope flags', () => {
    const result = rerankOutput('accuracy', { experiment: { id: 'nested' }, contract: { sampling: { seed: 17 } },
      result: { accuracy: 0.9 }, new_evaluation: false });
    const row = result.results.find(item => item.text.includes('accuracy'))!;
    const context = row.context_indices!.map(id => result.results.find(item => item.source_index === id)!.text).join('\n');
    expect(context).toContain('"id":"nested"');
    expect(context).toContain('"seed":17');
    expect(context).toContain('"new_evaluation":false');
  });

  it('does not detach a source or condition from its result when explicit max_blocks is too small', () => {
    const result = rerankOutput('accuracy', { experiment: 'bound', contract: { split: 'test' }, result: { accuracy: 0.9 } },
      { max_chars: 3_000, max_blocks: 1 });
    expect(result.results.some(item => item.text.includes('accuracy'))).toBe(false);
  });

  it('keeps code fences atomic and ignores their apparent table syntax', () => {
    const raw = '# Diagnostic\n\n```python\nvalue = "a|b"\n# Not a section\nprint(value)\n```\n\nResult: passed.';
    const records = evidenceRecords(raw)!;
    expect(records.filter(item => item.text.startsWith('```'))).toHaveLength(1);
    expect(records.find(item => item.text.startsWith('```'))!.text).toContain('print(value)\n```');
  });

  it('binds table rows without outer pipes to their column names', () => {
    const result = rerankOutput('accuracy', 'Model | Accuracy\n--- | ---:\nAlpha | 0.9\nBeta | 0.8');
    expect(result.meta.selection).toBe('evidence_records');
    const row = result.results.find(item => item.text === 'Alpha | 0.9')!;
    expect(row.context_indices!.some(id => result.results.find(item => item.source_index === id)!.text.includes('Model | Accuracy'))).toBe(true);
  });

  it('keeps JSONL experiment records separate with original line pointers', () => {
    const raw = '{"id":"one","conditions":{"seed":1},"result":{"ppl":8.9}}\n\n{"id":"two","conditions":{"seed":2},"result":{"ppl":9.1}}';
    const result = rerankOutput('ppl', raw);
    const rows = result.results.filter(item => item.text.includes('ppl'));
    expect(rows).toHaveLength(2);
    expect(rows.map(item => item.locator)).toEqual(expect.arrayContaining(['input:L1#/result', 'input:L3#/result']));
    for (const row of rows) {
      const context = row.context_indices!.map(id => result.results.find(item => item.source_index === id)!.text).join('\n');
      expect(context).toContain(row.locator!.startsWith('input:L1') ? '"seed":1' : '"seed":2');
    }
  });

  it('redacts escaped sensitive strings after JSON decoding', () => {
    const raw = '{"id":"x","detail":"API_KEY\\u003dprivate-example"}';
    const displayed = formatRerankedOutput(rerankOutput('detail', raw));
    expect(displayed).toContain('[REDACTED]');
    expect(displayed).not.toContain('private-example');
  });

  it('does not have an implicit eight-record cap and honors an explicit record limit', () => {
    const raw = Array.from({ length: 16 }, (_, id) => ({ evidence: id }));
    expect(rerankOutput('evidence', raw, { max_chars: 3_000 }).returned_blocks).toBe(16);
    expect(rerankOutput('evidence', raw, { max_chars: 3_000, max_blocks: 4 }).returned_blocks).toBe(4);
  });

  it('reports omissions when an indivisible value is too large and retains small relevant records', () => {
    const result = rerankOutput('result', { log_blob: 'x'.repeat(10_000), result: 0.9 }, { max_chars: 500 });
    expect(result.truncated).toBe(true);
    expect(formatRerankedOutput(result)).toContain('omitted=');
    expect(formatRerankedOutput(result)).toContain('"result":0.9');
  });

  it('does not mistake an experiment output field for a shell envelope', () => {
    const result = rerankOutput('accuracy', { experiment_id: 'original', output: 'long log '.repeat(400), result: { accuracy: 0.95 } },
      { max_chars: 1_000 });
    const displayed = formatRerankedOutput(result);
    expect(displayed).toContain('"experiment_id":"original"');
    expect(displayed).toContain('"accuracy":0.95');
    expect(rerankOutput('error', { output: 'error: failed', exit_code: 1 }).meta.selection).toBe('blocks');
  });

  it('keeps plain logs and malformed JSON on the fallback path', () => {
    expect(evidenceRecords('error: failed\ntraceback')).toBeUndefined();
    expect(evidenceRecords('{"broken":')).toBeUndefined();
    expect(rerankOutput('error', 'error: failed').meta.selection).toBe('blocks');
    expect(rerankOutput('result', { result: 8.75 }, { selection: 'blocks' }).meta.selection).toBe('blocks');
  });

  it('accounts for hook headers before packing records and keeps nonzero exit status', async () => {
    const response = await processOutputHook({ tool_name: 'Bash', tool_input: { command: 'result' },
      tool_response: { output: JSON.stringify({ experiment: 'x', contract: { seed: 0 }, result: 0.875 }), exit_code: 1 } },
    { trigger_chars: 1, max_chars: 400 });
    expect(String(response?.reason).length).toBeLessThanOrEqual(400);
    expect(String(response?.reason)).toContain('Exit code: 1');
    expect(String(response?.reason)).toContain('0.875');
  });
});
