type OutputBlock = {
  index: number;
  text: string;
};

export interface RankedOutputBlock {
  rank: number;
  source_index: number;
  text: string;
}

export interface RerankedOutput {
  query: string;
  results: RankedOutputBlock[];
  total_chars: number;
  returned_chars: number;
  total_blocks: number;
  returned_blocks: number;
  truncated: boolean;
  meta: {
    retrieval_lanes: ['source_order', 'exact', 'bm25'];
    fusion: 'rrf';
    stored: false;
  };
}

const RRF_K = 20;
const BLOCK_CHARS = 3_000;
const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_MAX_BLOCKS = 8;
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
  for (const line of text.split(/\r?\n/)) {
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

function responseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.output === 'string') return record.output;
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
  const documents = blocks.map((block) => terms(block.text));
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0)
    / Math.max(documents.length, 1);
  const documentFrequency = new Map(selectedTerms.map((term) => [
    term,
    documents.filter((document) => document.includes(term)).length,
  ]));
  return documents.map((document) => {
    const frequencies = new Map<string, number>();
    for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of selectedTerms) {
      const frequency = frequencies.get(term) ?? 0;
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
  options: { max_chars?: number; max_blocks?: number } = {},
): RerankedOutput {
  const text = responseText(value);
  const blocks = outputBlocks(sanitizeOutputText(text));
  const exactRank = ranks(exactScores(query, blocks));
  const bm25Rank = ranks(bm25Scores(query, blocks));
  const ordered = blocks.map((block, index) => ({
    block,
    score: 0.35 / (RRF_K + index + 1)
      + (exactRank.has(index) ? 1 / (RRF_K + exactRank.get(index)!) : 0)
      + (bm25Rank.has(index) ? 1 / (RRF_K + bm25Rank.get(index)!) : 0),
  })).sort((a, b) => b.score - a.score || a.block.index - b.block.index);
  const maxChars = Math.min(Math.max(options.max_chars ?? DEFAULT_MAX_CHARS, 500), 12_000);
  const maxBlocks = Math.min(Math.max(options.max_blocks ?? DEFAULT_MAX_BLOCKS, 1), 20);
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
    meta: { retrieval_lanes: ['source_order', 'exact', 'bm25'], fusion: 'rrf', stored: false },
  };
}

export function formatRerankedOutput(result: RerankedOutput): string {
  const header = `Google Surf stateless reranker selected ${result.returned_blocks}/${result.total_blocks} blocks (${result.returned_chars}/${result.total_chars} chars) using source-order + exact + BM25 RRF. Nothing was stored.`;
  return [header, ...result.results.map((row) => `\n[${row.rank} | source ${row.source_index + 1}]\n${row.text}`)].join('\n');
}
