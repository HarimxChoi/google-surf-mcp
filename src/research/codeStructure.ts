import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import Parser from 'tree-sitter';
import CPP from 'tree-sitter-cpp';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';
import type { CodeRelationRecord, CodeSymbolRecord } from './contracts.js';

export interface CodeSourceInput {
  project_id: string;
  source_entry_id: string;
  path: string;
  text: string;
  root?: string;
  tracked?: boolean;
}

export function selectCodeSources(
  inputs: CodeSourceInput[],
  maxBytes = 8 * 1024 * 1024,
): { selected: CodeSourceInput[]; deferred: number } {
  const vendor = /(^|\/)(?:vendor|vendors|third_party|third-party|external|node_modules|llama[^/]*src)(\/|$)/i;
  const ranked = [...inputs].sort((a, b) => {
    const score = (input: CodeSourceInput): number => (
      input.tracked || input.root === 'repo' ? 0 : vendor.test(input.path.replace(/\\/g, '/')) ? 2 : 1
    );
    return score(a) - score(b) || a.path.localeCompare(b.path)
      || a.source_entry_id.localeCompare(b.source_entry_id);
  });
  const selected: CodeSourceInput[] = [];
  let bytes = 0;
  for (const input of ranked) {
    const size = Buffer.byteLength(input.text, 'utf8');
    if (selected.length && bytes + size > maxBytes) continue;
    selected.push(input);
    bytes += size;
  }
  return { selected, deferred: inputs.length - selected.length };
}

function id(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function language(path: string): { name: string; grammar: unknown } | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === '.py') return { name: 'python', grammar: Python };
  if (['.c', '.cc', '.cpp', '.cu', '.cuh', '.h', '.hpp'].includes(extension)) {
    return { name: 'cpp', grammar: CPP };
  }
  if (extension === '.ts' || extension === '.mts') {
    return { name: 'typescript', grammar: TypeScript.typescript };
  }
  if (extension === '.tsx') return { name: 'tsx', grammar: TypeScript.tsx };
  return undefined;
}

function descendant(node: Parser.SyntaxNode, types: Set<string>): Parser.SyntaxNode | undefined {
  if (types.has(node.type)) return node;
  for (const child of node.namedChildren) {
    const found = descendant(child, types);
    if (found) return found;
  }
  return undefined;
}

function symbolKind(node: Parser.SyntaxNode): CodeSymbolRecord['kind'] | undefined {
  if (['function_definition', 'function_declaration'].includes(node.type)) return 'function';
  if (['method_definition', 'method_declaration'].includes(node.type)) return 'method';
  if (['class_definition', 'class_declaration'].includes(node.type)) return 'class';
  if (node.type === 'interface_declaration') return 'interface';
  if (node.type === 'struct_specifier') return 'struct';
  return undefined;
}

function symbolName(node: Parser.SyntaxNode): string | undefined {
  const named = node.childForFieldName('name');
  if (named?.text) return named.text;
  const declarator = node.childForFieldName('declarator');
  return declarator
    ? descendant(declarator, new Set(['identifier', 'field_identifier']))?.text
    : undefined;
}

function relationTarget(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'call') return node.childForFieldName('function')?.text;
  if (node.type === 'call_expression') return node.childForFieldName('function')?.text;
  if (node.type === 'import_from_statement') return node.childForFieldName('module_name')?.text;
  if (node.type === 'import_statement') {
    return node.namedChildren.map((child) => child.text).join(', ');
  }
  if (node.type === 'preproc_include') return node.childForFieldName('path')?.text;
  if (node.type === 'import_declaration') return node.childForFieldName('source')?.text;
  return undefined;
}

function relationKind(node: Parser.SyntaxNode): CodeRelationRecord['kind'] | undefined {
  if (['call', 'call_expression'].includes(node.type)) return 'calls';
  if (['import_from_statement', 'import_statement', 'preproc_include', 'import_declaration']
    .includes(node.type)) return 'imports';
  return undefined;
}

const structureQueries = new Map<string, Parser.Query>();

function structureQuery(name: string, grammar: unknown): Parser.Query {
  const existing = structureQueries.get(name);
  if (existing) return existing;
  const types = name === 'python'
    ? [
      ['function_definition', 'symbol'], ['class_definition', 'symbol'],
      ['call', 'relation'], ['import_from_statement', 'relation'],
      ['import_statement', 'relation'],
    ]
    : name === 'cpp'
      ? [
        ['function_definition', 'symbol'], ['struct_specifier', 'symbol'],
        ['call_expression', 'relation'], ['preproc_include', 'relation'],
      ]
      : [
        ['function_declaration', 'symbol'], ['method_definition', 'symbol'],
        ['class_declaration', 'symbol'], ['interface_declaration', 'symbol'],
        ['call_expression', 'relation'], ['import_statement', 'relation'],
      ];
  const query = new Parser.Query(
    grammar,
    types.map(([type, capture]) => `(${type}) @${capture}`).join('\n'),
  );
  structureQueries.set(name, query);
  return query;
}

export function extractCodeStructure(inputs: CodeSourceInput[]): {
  symbols: CodeSymbolRecord[];
  relations: CodeRelationRecord[];
} {
  const symbols: CodeSymbolRecord[] = [];
  const pending: Array<Omit<CodeRelationRecord, 'relation_id' | 'target_symbol_id'> & {
    relation_id?: string;
  }> = [];
  for (const input of inputs) {
    const selected = language(input.path);
    if (!selected) continue;
    const parser = new Parser();
    let tree: Parser.Tree;
    try {
      parser.setLanguage(selected.grammar);
      tree = parser.parse(input.text, undefined, {
        bufferSize: Math.max(32 * 1024, Buffer.byteLength(input.text, 'utf8') + 1),
      });
    } catch (error) {
      throw new Error(`code parse failed: ${input.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const captures = structureQuery(selected.name, selected.grammar).captures(tree.rootNode);
    const owners = new Map<number, string>();
    for (const capture of captures.filter((row) => row.name === 'symbol')) {
      const node = capture.node;
      const kind = symbolKind(node);
      if (kind) {
        const name = symbolName(node);
        if (name) {
          const symbolId = id(`${input.project_id}\0${input.source_entry_id}\0${kind}\0${name}\0${node.startIndex}\0${node.endIndex}`);
          symbols.push({
            symbol_id: symbolId,
            project_id: input.project_id,
            source_entry_id: input.source_entry_id,
            language: selected.name,
            kind,
            name,
            start_line: node.startPosition.row + 1,
            start_column: node.startPosition.column + 1,
            end_line: node.endPosition.row + 1,
            end_column: node.endPosition.column + 1,
          });
          owners.set(node.id, symbolId);
        }
      }
    }
    for (const capture of captures.filter((row) => row.name === 'relation')) {
      const node = capture.node;
      const relation = relationKind(node);
      const target = relation ? relationTarget(node)?.replace(/^['"]|['"]$/g, '').slice(0, 500) : undefined;
      if (relation && target) {
        let parent = node.parent;
        let owner: string | undefined;
        while (parent && !owner) {
          owner = owners.get(parent.id);
          parent = parent.parent;
        }
        pending.push({
          project_id: input.project_id,
          source_entry_id: input.source_entry_id,
          ...(owner ? { source_symbol_id: owner } : {}),
          target_name: target,
          kind: relation,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          confidence: relation === 'imports' ? 1 : 0.9,
        });
      }
    }
  }
  const names = new Map<string, CodeSymbolRecord[]>();
  for (const symbol of symbols) {
    const rows = names.get(symbol.name) ?? [];
    rows.push(symbol);
    names.set(symbol.name, rows);
  }
  const relations = pending.map((relation) => {
    const exact = names.get(relation.target_name);
    const relationId = id(`${relation.project_id}\0${relation.source_entry_id}\0${relation.source_symbol_id ?? ''}\0${relation.kind}\0${relation.target_name}\0${relation.line}\0${relation.column}`);
    return {
      ...relation,
      relation_id: relationId,
      ...(exact?.length === 1 ? { target_symbol_id: exact[0].symbol_id } : {}),
    };
  });
  return {
    symbols: [...new Map(symbols.map((symbol) => [symbol.symbol_id, symbol])).values()],
    relations: [...new Map(relations.map((relation) => [relation.relation_id, relation])).values()],
  };
}

function linkCodeRelations(
  symbols: CodeSymbolRecord[],
  relations: CodeRelationRecord[],
): CodeRelationRecord[] {
  const names = new Map<string, CodeSymbolRecord[]>();
  for (const symbol of symbols) {
    const rows = names.get(symbol.name) ?? [];
    rows.push(symbol);
    names.set(symbol.name, rows);
  }
  return relations.flatMap((relation) => {
    if (relation.target_symbol_id) return [relation];
    const exact = names.get(relation.target_name);
    if (exact?.length === 1) return [{ ...relation, target_symbol_id: exact[0].symbol_id }];
    return relation.kind === 'imports' ? [relation] : [];
  });
}

function collapseCodeRelations(relations: CodeRelationRecord[]): CodeRelationRecord[] {
  return [...new Map(relations.map((relation) => [
    `${relation.source_entry_id}\0${relation.source_symbol_id ?? ''}\0${relation.kind}\0${relation.target_symbol_id ?? relation.target_name}`,
    relation,
  ])).values()];
}

interface CodeStructureResult {
  symbols: CodeSymbolRecord[];
  relations: CodeRelationRecord[];
}

async function runWorkerBatch(worker: Worker, inputs: CodeSourceInput[]): Promise<CodeStructureResult> {
  return await new Promise((resolve, reject) => {
    const message = (value: { result?: CodeStructureResult; error?: string }): void => {
      worker.off('error', failure);
      if (value.error) reject(new Error(value.error));
      else if (value.result) resolve(value.result);
      else reject(new Error('code sidecar returned no result'));
    };
    const failure = (error: Error): void => {
      worker.off('message', message);
      reject(error);
    };
    worker.once('message', message);
    worker.once('error', failure);
    worker.postMessage(inputs);
  });
}

async function* inputBatches(inputs: CodeSourceInput[]): AsyncGenerator<CodeSourceInput[]> {
  let current: CodeSourceInput[] = [];
  let size = 0;
  for (const input of inputs) {
    const nextSize = Buffer.byteLength(input.text, 'utf8');
    if (current.length && size + nextSize > 8 * 1024 * 1024) {
      yield current;
      current = [];
      size = 0;
    }
    current.push(input);
    size += nextSize;
  }
  if (current.length) yield current;
}

export async function runCodeStructureBatchStream(
  batches: AsyncIterable<CodeSourceInput[]>,
): Promise<CodeStructureResult> {
  const symbols: CodeSymbolRecord[] = [];
  const relations: CodeRelationRecord[] = [];
  if (process.env.VITEST || import.meta.url.endsWith('/src/research/codeStructure.js')) {
    for await (const batch of batches) {
      const result = extractCodeStructure(batch);
      symbols.push(...result.symbols);
      relations.push(...result.relations.map((relation) => ({
        ...relation,
        target_symbol_id: undefined,
      })));
    }
  } else {
    const iterator = batches[Symbol.asyncIterator]();
    let nextBatch = Promise.resolve();
    const take = async (): Promise<IteratorResult<CodeSourceInput[]>> => {
      const result = nextBatch.then(async () => await iterator.next());
      nextBatch = result.then(() => undefined, () => undefined);
      return await result;
    };
    const configured = Number(process.env.SURF_RESEARCH_CODE_WORKERS);
    const workerCount = Number.isInteger(configured) && configured > 0
      ? Math.min(configured, 4)
      : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
      const batch = await take();
      if (batch.done) return;
        const worker = new Worker(
          new URL('./codeWorker.js', import.meta.url),
          { execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')) },
        );
        try {
          const result = await runWorkerBatch(worker, batch.value);
          symbols.push(...result.symbols);
          relations.push(...result.relations.map((relation) => ({
            ...relation,
            target_symbol_id: undefined,
          })));
        } finally {
          await worker.terminate();
        }
      }
    }));
  }
  const uniqueSymbols = [...new Map(symbols.map((symbol) => [symbol.symbol_id, symbol])).values()];
  const uniqueRelations = [...new Map(relations.map((relation) => [relation.relation_id, relation])).values()];
  return {
    symbols: uniqueSymbols,
    relations: collapseCodeRelations(linkCodeRelations(uniqueSymbols, uniqueRelations)),
  };
}

export async function runCodeStructureSidecar(inputs: CodeSourceInput[]): Promise<CodeStructureResult> {
  return await runCodeStructureBatchStream(inputBatches(inputs));
}
