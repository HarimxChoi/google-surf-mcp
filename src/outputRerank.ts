import { adaptiveOutputBudget } from './responseBudget.js';
import { evidenceRecords, renderEvidence } from './evidenceRecords.js';

type OutputBlock = {
  index: number;
  text: string;
};

export interface RankedOutputBlock {
  rank: number;
  source_index: number;
  text: string;
  locator?: string;
  context_indices?: number[];
}

export interface RerankedOutput {
  query: string;
  results: RankedOutputBlock[];
  total_chars: number;
  returned_chars: number;
  total_blocks: number;
  returned_blocks: number;
  truncated: boolean;
  rendered?: string;
  meta: {
    retrieval_lanes: ['source_order', 'exact', 'bm25'];
    fusion: 'rrf';
    stored: false;
    response_budget_chars: number;
    response_budget_policy: 'adaptive_evidence_breadth' | 'caller';
    selection: 'evidence_records' | 'blocks';
  };
}

const RRF_K = 20;
const BLOCK_CHARS = 3_000;
const QUERY_STOPWORDS = new Set([
  'batchmode', 'cat', 'command', 'connecttimeout', 'content', 'convertfrom-json',
  'find', 'format', 'get-childitem', 'get-content', 'head', 'json', 'literalpath',
  'maxdepth', 'name', 'noheader', 'nounits', 'output', 'printf', 'root', 'select-object',
  'sed', 'sort', 'ssh', 'strictHostKeyChecking'.toLowerCase(), 'tail', 'type', 'workspace',
]);

function terms(value: unknown): string[] {
  return String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? [];
}

function queryTerms(query: string): string[] {
  return [...new Set(terms(query)
    .map((term) => term.replace(/^[-./:]+|[-./:]+$/g, ''))
    .filter((term) => term.length >= 3 && !QUERY_STOPWORDS.has(term)))];
}

function splitLong(value: string): string[] {
  const output: string[] = [];
  for (let start = 0; start < value.length; start += BLOCK_CHARS) {
    output.push(value.slice(start, start + BLOCK_CHARS));
  }
  return output;
}

function compactRepeatedLines(text: string): string {
  const output: string[] = [];
  let repeatedLine: string | undefined;
  let repeatedCount = 0;
  let pendingBlank = false;

  const flush = () => {
    if (repeatedLine === undefined) return;
    output.push(repeatedLine);
    if (repeatedCount > 1) output.push(`[previous line repeated ${repeatedCount - 1} more times]`);
    if (pendingBlank) output.push('');
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      pendingBlank = true;
      continue;
    }
    if (line === repeatedLine) {
      repeatedCount += 1;
      continue;
    }
    flush();
    repeatedLine = line;
    repeatedCount = 1;
    pendingBlank = false;
  }
  flush();
  return output.join('\n').trim();
}

function jsonBlocks(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const label = `${prefix}[${index}]`;
      const serialized = JSON.stringify(item);
      return serialized.length <= BLOCK_CHARS
        ? [`${label}: ${serialized}`]
        : jsonBlocks(item, label);
    });
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [`${prefix} {}`.trim()];
    return entries.flatMap(([key, child]) => {
      const label = prefix ? `${prefix}.${key}` : key;
      const serialized = JSON.stringify(child);
      if (serialized.length <= BLOCK_CHARS) return [`${label}: ${serialized}`];
      if (Array.isArray(child) || (child && typeof child === 'object')) return jsonBlocks(child, label);
      return splitLong(`${label}: ${serialized}`);
    });
  }
  return [`${prefix}: ${JSON.stringify(value)}`.trim()];
}

function plainBlocks(text: string): string[] {
  const output: string[] = [];
  let current = '';
  for (const line of compactRepeatedLines(text).split(/\r?\n/)) {
    const boundary = !line.trim() || /^\s*(?:={3,}|-{3,}|#{1,6}\s)/.test(line);
    if ((boundary && current.trim()) || current.length + line.length + 1 > BLOCK_CHARS) {
      output.push(...splitLong(current.trim()));
      current = '';
    }
    if (line.trim()) current += `${current ? '\n' : ''}${line}`;
  }
  if (current.trim()) output.push(...splitLong(current.trim()));
  return output;
}

export function responseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const envelopeKeys = new Set(['output', 'exit_code', 'session_id', 'chunk_id', 'wall_time_seconds', 'original_token_count']);
    // An experiment may itself have an output field; only unwrap known shell envelopes.
    if (typeof record.output === 'string' && Object.keys(record).every(key => envelopeKeys.has(key))) return record.output;
  }
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

export function outputBlocks(value: unknown): OutputBlock[] {
  const text = responseText(value);
  let blocks: string[];
  try {
    blocks = jsonBlocks(JSON.parse(text));
  } catch {
    blocks = plainBlocks(text);
  }
  const seen = new Set<string>();
  return blocks.flatMap((block) => {
    const cleaned = block.trim();
    if (!cleaned || seen.has(cleaned)) return [];
    seen.add(cleaned);
    return [{ index: seen.size - 1, text: cleaned }];
  });
}

function exactScores(query: string, blocks: OutputBlock[]): number[] {
  const selectedTerms = queryTerms(query);
  const phrase = query.trim().toLocaleLowerCase();
  return blocks.map((block) => {
    const text = block.text.toLocaleLowerCase();
    const matched = selectedTerms.filter((term) => text.includes(term)).length;
    return matched + (phrase.length >= 4 && text.includes(phrase) ? selectedTerms.length + 1 : 0);
  });
}

function bm25Scores(query: string, blocks: OutputBlock[]): number[] {
  const selectedTerms = queryTerms(query);
  if (!selectedTerms.length || !blocks.length) return blocks.map(() => 0);
  const vocabulary = new Set(selectedTerms);
  const documentFrequency = new Map(selectedTerms.map((term) => [term, 0]));
  const documents = blocks.map((block) => {
    const tokens = terms(block.text);
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      if (vocabulary.has(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const term of frequencies.keys()) documentFrequency.set(term, documentFrequency.get(term)! + 1);
    return { length: tokens.length, frequencies };
  });
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0)
    / Math.max(documents.length, 1);
  return documents.map((document) => {
    let score = 0;
    for (const term of selectedTerms) {
      const frequency = document.frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const normalization = frequency + 1.2 * (
        1 - 0.75 + 0.75 * document.length / Math.max(averageLength, 1)
      );
      score += idf * frequency * 2.2 / normalization;
    }
    return score;
  });
}

function ranks(scores: number[]): Map<number, number> {
  return new Map(scores
    .map((score, index) => ({ score, index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry, index) => [entry.index, index + 1]));
}

export function sanitizeOutputText(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED TOKEN]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1[REDACTED]')
    .replace(/\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s,;]+)/gi, '$1=[REDACTED]');
}

export function rerankOutput(
  query: string,
  value: unknown,
  options: { max_chars?: number; max_blocks?: number; selection?: 'records' | 'blocks'; output_prefix?: string } = {},
): RerankedOutput {
  const text = responseText(value);
  const safe = sanitizeOutputText(text);
  const records = options.selection === 'blocks' ? undefined : evidenceRecords(safe, sanitizeOutputText);
  const blocks = records ? records.map(record => ({ index: record.index,
    text: `${record.locator}\n${record.text}\n${record.dependencies.map(id => records[id].text)
      .filter(context => /^\s*\|.+\n\|[-:|]+/.test(context)).join('\n')}` })) : outputBlocks(safe);
  const exactRank = ranks(exactScores(query, blocks));
  const bm25Rank = ranks(bm25Scores(query, blocks));
  const ordered = blocks.map((block, index) => ({
    block,
    score: 0.35 / (RRF_K + index + 1)
      + (exactRank.has(index) ? 1 / (RRF_K + exactRank.get(index)!) : 0)
      + (bm25Rank.has(index) ? 1 / (RRF_K + bm25Rank.get(index)!) : 0),
  })).sort((a, b) => b.score - a.score || a.block.index - b.block.index);
  const explicitBudget = Number.isFinite(options.max_chars) && options.max_chars! > 0;
  const evidenceBlocks = new Set([...exactRank.keys(), ...bm25Rank.keys()]).size;
  const maxChars = explicitBudget ? Math.floor(options.max_chars!) : adaptiveOutputBudget(evidenceBlocks);
  const maxBlocks = Number.isFinite(options.max_blocks) && options.max_blocks! > 0
    ? Math.floor(options.max_blocks!) : Number.MAX_SAFE_INTEGER;
  if (records) {
    let selected = new Set<number>();
    let rendered = renderEvidence(records, selected, options.output_prefix);
    const prioritized = [...ordered].sort((a, b) => {
      const matched = (entry: typeof a) => Number(exactRank.has(entry.block.index) || bm25Rank.has(entry.block.index));
      const value = (entry: typeof a) => entry.score / Math.sqrt(128 + records[entry.block.index].text.length);
      return matched(b) - matched(a) || value(b) - value(a) || a.block.index - b.block.index;
    });
    for (const entry of prioritized) {
      if (selected.has(entry.block.index)) continue;
      const next = new Set(selected);
      const include = (id: number) => {
        if (next.has(id)) return;
        next.add(id);
        records[id].dependencies.forEach(include);
      };
      include(entry.block.index);
      if (next.size > maxBlocks) continue;
      const candidate = renderEvidence(records, next, options.output_prefix);
      if (candidate.length <= maxChars) { selected = next; rendered = candidate; }
    }
    return {
      query,
      results: ordered.filter(entry => selected.has(entry.block.index)).map((entry, index) => {
        const id = entry.block.index;
        return { rank: index + 1, source_index: id, text: records[id].text,
          locator: records[id].locator, context_indices: records[id].dependencies };
      }),
      total_chars: text.length, returned_chars: [...selected].reduce((sum, id) => sum + records[id].text.length, 0),
      total_blocks: records.length, returned_blocks: selected.size, truncated: selected.size < records.length,
      rendered: rendered.slice(0, maxChars),
      meta: { retrieval_lanes: ['source_order', 'exact', 'bm25'], fusion: 'rrf', stored: false,
        response_budget_chars: maxChars, response_budget_policy: explicitBudget ? 'caller' : 'adaptive_evidence_breadth',
        selection: 'evidence_records' },
    };
  }
  const selected: RankedOutputBlock[] = [];
  let returnedChars = 0;
  for (const entry of ordered) {
    if (selected.length >= maxBlocks || returnedChars >= maxChars) break;
    const remaining = maxChars - returnedChars;
    const valueText = entry.block.text.slice(0, remaining);
    if (!valueText) break;
    selected.push({ rank: selected.length + 1, source_index: entry.block.index, text: valueText });
    returnedChars += valueText.length;
  }
  return {
    query,
    results: selected,
    total_chars: text.length,
    returned_chars: returnedChars,
    total_blocks: blocks.length,
    returned_blocks: selected.length,
    truncated: returnedChars < text.length || selected.length < blocks.length,
    meta: {
      retrieval_lanes: ['source_order', 'exact', 'bm25'], fusion: 'rrf', stored: false,
      response_budget_chars: maxChars,
      response_budget_policy: explicitBudget ? 'caller' : 'adaptive_evidence_breadth',
      selection: 'blocks',
    },
  };
}

export function formatRerankedOutput(result: RerankedOutput): string {
  if (result.rendered !== undefined) return result.rendered;
  const header = `Google Surf stateless reranker selected ${result.returned_blocks}/${result.total_blocks} blocks (${result.returned_chars}/${result.total_chars} chars) using source-order + exact + BM25 RRF. Nothing was stored.`;
  return [header, ...result.results.map((row) => `\n[${row.rank} | source ${row.source_index + 1}]\n${row.text}`)].join('\n');
}
