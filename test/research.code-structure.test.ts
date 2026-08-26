import { describe, expect, it } from 'vitest';
import {
  extractCodeStructure, runCodeStructureBatchStream, selectCodeSources,
  type CodeSourceInput,
} from '../src/research/codeStructure.js';

describe('code structure sidecar', () => {
  it('extracts Python, CUDA, and TypeScript symbols with exact ranges', () => {
    const result = extractCodeStructure([
      {
        project_id: 'code-test',
        source_entry_id: 'python',
        path: 'quant.py',
        text: 'import torch\n\ndef quantize(x):\n    return torch.round(x)\n',
      },
      {
        project_id: 'code-test',
        source_entry_id: 'cuda',
        path: 'kernel.cu',
        text: '#include <cuda.h>\nint kernel(int x) { return x; }\n',
      },
      {
        project_id: 'code-test',
        source_entry_id: 'typescript',
        path: 'runner.ts',
        text: 'export function run() { return quantize(1); }\n',
      },
    ]);

    expect(result.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['quantize', 'kernel', 'run']),
    );
    expect(result.symbols.every((symbol) => symbol.start_line >= 1)).toBe(true);
    expect(result.relations.map((relation) => relation.kind)).toEqual(
      expect.arrayContaining(['imports', 'calls']),
    );
    expect(result.relations.find((relation) => relation.target_name === 'quantize'))
      .toHaveProperty('target_symbol_id');
  });

  it('prioritizes project source before vendored source under a byte budget', () => {
    const selected = selectCodeSources([
      {
        project_id: 'code-test', source_entry_id: 'vendor', path: 'third_party/lib.cpp',
        text: 'vendor', root: 'artifacts',
      },
      {
        project_id: 'code-test', source_entry_id: 'repo', path: 'src/main.py',
        text: 'project', root: 'repo',
      },
    ], 8);

    expect(selected.selected.map((row) => row.source_entry_id)).toEqual(['repo']);
    expect(selected.deferred).toBe(1);
  });

  it('keeps relation linking independent of worker batch boundaries', async () => {
    const inputs: CodeSourceInput[] = [
      {
        project_id: 'code-test', source_entry_id: 'a', path: 'a.py',
        text: 'def shared():\n    return 1\n\ndef run():\n    return shared()\n',
      },
      {
        project_id: 'code-test', source_entry_id: 'b', path: 'b.py',
        text: 'def shared():\n    return 2\n',
      },
    ];
    async function* stream(split: boolean): AsyncGenerator<CodeSourceInput[]> {
      if (split) {
        yield [inputs[0]];
        yield [inputs[1]];
      } else {
        yield inputs;
      }
    }

    const whole = await runCodeStructureBatchStream(stream(false));
    const split = await runCodeStructureBatchStream(stream(true));

    expect(split).toEqual(whole);
    expect(split.relations.find((row) => row.target_name === 'shared')).toBeUndefined();
  });
});
