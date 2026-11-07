import { createHash, randomUUID } from 'node:crypto';

export interface EvidenceSpan { start: number; end: number }
export type EvidenceRange = [number, number];
export type EvidenceMode = 'balanced' | 'compact' | 'coherent';
export interface EvidenceSelection {
  text: string;
  spans: EvidenceSpan[];
  captured_hash: string;
  captured_length: number;
  truncated: boolean;
}

const STOP = new Set('a an the and or for of to in is are be as on with this that it from by how what when which does do can'.split(' '));
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
export function evidenceTerms(value: string): string[] {
  const latin = value.toLowerCase().match(/[a-z0-9_./-]+|[\p{Script=Hangul}]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  return [...new Set(latin.flatMap((word) => [word, ...word.split(/[_.\/-]/)])
    .filter((word) => !STOP.has(word) && /[\p{L}\p{N}]/u.test(word)))];
}

export function cleanCapturedText(value: string): string {
  const match = value.match(/^\s*--- BEGIN UNTRUSTED CONTENT ---\r?\n([\s\S]*)\r?\n--- END UNTRUSTED CONTENT ---\s*$/);
  return match ? match[1] : value;
}

interface Passage { spans: EvidenceSpan[]; primary: EvidenceSpan[]; text: string; terms: Set<string>; index: number; score: number }

function passages(text: string, maxChars: number, mode: EvidenceMode, excluded: EvidenceSpan[]): Passage[] {
  const output: Passage[] = [];
  const add = (spans: EvidenceSpan[], primary = spans) => {
    const body = spans.map((span) => text.slice(span.start, span.end)).join('\n');
    if (body.trim()) output.push({ spans, primary, text: body, terms: new Set(evidenceTerms(body)), index: output.length, score: 0 });
  };
  const addCode = (spans: EvidenceSpan[], closed: boolean) => {
    const primary = spans.slice(1, closed ? -1 : undefined);
    if (mode !== 'compact' || spans.reduce((n, s) => n + s.end - s.start + 1, 0) <= maxChars) return add(spans, primary);
    const opening = spans[0], closing = closed ? spans.at(-1) : undefined;
    let chunk: EvidenceSpan[] = [], length = 0;
    const flush = () => { if (chunk.length) add([opening, ...chunk, ...(closing ? [closing] : [])], chunk); chunk = []; length = 0; };
    for (const span of primary) {
      if (length + span.end - span.start > Math.min(450, Math.max(80, maxChars - 30))) flush();
      chunk.push(span); length += span.end - span.start + 1;
    }
    flush();
  };
  const lines = [...text.matchAll(/[^\n]+(?:\n|$)/g)];
  let code: EvidenceSpan[] | undefined;
  let tableHeader: EvidenceSpan | undefined;
  let lineIndex = -1;
  for (const line of lines) {
    lineIndex++;
    const start = line.index!, end = start + line[0].trimEnd().length;
    if (/^\s*```/.test(line[0])) {
      if (code) { code.push({ start, end }); addCode(code, true); code = undefined; }
      else code = [{ start, end }];
      continue;
    }
    if (code) { code.push({ start, end }); continue; }
    if (/^\s*(?:[-*]\s*)?\[?(?:report an issue|edit this page|edit on github|view markdown|copy markdown|privacy policy|cookie settings|copyright)\b/i.test(line[0])) continue;
    if (/^\s*\|/.test(line[0])) {
      if (/^\s*\|?[\s:|-]+\|\s*$/.test(line[0])) continue;
      if (!tableHeader) { tableHeader = { start, end }; add([tableHeader]); }
      else add([tableHeader, { start, end }], [{ start, end }]);
      continue;
    }
    tableHeader = undefined;
    if (mode === 'coherent' && /^\s*`[^`]+`\s*$/.test(line[0])) {
      const next = lines[lineIndex + 1];
      if (next && !/^\s*(?:[#|`]|[-*+]\s|\d+[.)]\s)/.test(next[0])) {
        const definition = { start: next.index!, end: next.index! + next[0].trimEnd().length };
        if (definition.end - start <= Math.min(500, maxChars)) {
          add([{ start, end }, definition], [definition]);
          continue;
        }
      }
    }
    if (mode === 'coherent' && end - start <= Math.max(80, Math.min(500, maxChars))) {
      const primary = [...SENTENCES.segment(line[0].trimEnd())].map(segment => ({
        start: start + segment.index, end: start + segment.index + segment.segment.length,
      })).filter(span => !excluded.some(skip => span.start < skip.end && skip.start < span.end));
      if (primary.length) add([{ start, end }], primary);
      continue;
    }
    for (const segment of SENTENCES.segment(line[0].trimEnd())) {
      let cursor = start + segment.index;
      const limit = cursor + segment.segment.length;
      const target = Math.max(80, Math.min(500, maxChars));
      while (cursor < limit) {
        let next = Math.min(limit, cursor + target);
        if (next < limit) {
          const boundary = text.lastIndexOf(' ', next);
          if (boundary > cursor) next = boundary;
          else {
            const after = text.indexOf(' ', next);
            next = after >= 0 && after < limit ? after : limit;
          }
        }
        add([{ start: cursor, end: next }]);
        cursor = next;
        while (cursor < limit && /\s/.test(text[cursor])) cursor++;
      }
    }
  }
  if (code) addCode(code, false);
  return output;
}

function mergeSpans(spans: EvidenceSpan[]): EvidenceSpan[] {
  const sorted = spans.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: EvidenceSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function selectEvidence(
  value: string,
  query: string,
  maxChars: number,
  excluded: EvidenceSpan[] = [],
  mode: EvidenceMode = 'balanced',
): EvidenceSelection {
  const text = cleanCapturedText(value);
  const hash = createHash('sha256').update(text).digest('hex');
  const budget = Math.max(0, Math.floor(maxChars));
  const terms = evidenceTerms(query);
  const candidates = passages(text, budget, mode, excluded).filter((passage) => !passage.primary.some((span) =>
    excluded.some((skip) => span.start < skip.end && skip.start < span.end)));
  const average = candidates.reduce((n, p) => n + p.terms.size, 0) / Math.max(candidates.length, 1);
  const frequencies = new Map(terms.map((term) => [term, candidates.filter((p) => p.terms.has(term)).length]));
  for (const p of candidates) {
    for (const term of terms) {
      if (!p.terms.has(term)) continue;
      const df = frequencies.get(term)!;
      const idf = Math.log(1 + (candidates.length - df + .5) / (df + .5));
      p.score += idf * 2.2 / (1 + 1.2 * (.25 + .75 * p.terms.size / Math.max(1, average)));
      if (/^-?\d|[_./]|^[a-f0-9]{16,}$/i.test(term)) p.score += 2;
    }
    if (p.score && /\b(?:not|unless|except|only|instead|however|false|never)\b|-\d\b/i.test(p.text)) p.score += .5;
  }
  const selected: Passage[] = [];
  const covered = new Set<string>();
  let spans: EvidenceSpan[] = [], content = '';
  if (mode === 'coherent') {
    const anchor = candidates.findIndex(p => p.spans.length === 1 && p.score > 0
      && p.text.length >= 80 && p.text.length <= Math.min(500, budget)
      && !/^\s*(?:[#|]|[-*+]\s|\d+[.)]\s|```)/.test(p.text)
      && [...SENTENCES.segment(p.text)].length > 1);
    if (anchor >= 0) {
      const [paragraph] = candidates.splice(anchor, 1);
      selected.push(paragraph); spans = paragraph.spans; content = paragraph.text;
      for (const term of paragraph.terms) covered.add(term);
    }
  }
  while (candidates.length && selected.length < (mode === 'compact' ? 5 : 12)) {
    const scores = new Map(candidates.map(p => {
      const relevance = p.score + terms.filter((t) => p.terms.has(t) && !covered.has(t)).length * .7;
      if (mode !== 'compact') return [p, relevance] as const;
      const similarity = Math.max(0, ...selected.map((s) => {
        const intersection = [...p.terms].filter(t => s.terms.has(t)).length;
        return intersection / Math.max(1, p.terms.size + s.terms.size - intersection);
      }));
      return [p, relevance * (1 - .6 * similarity) / Math.sqrt(Math.max(40, Buffer.byteLength(p.text)))] as const;
    }));
    candidates.sort((a, b) => scores.get(b)! - scores.get(a)! || a.index - b.index);
    const p = candidates.shift()!;
    if (mode === 'compact' && selected.some(s => s.text === p.text)) continue;
    const nextSpans = mergeSpans([...spans, ...p.spans]);
    const next = nextSpans.map((span) => text.slice(span.start, span.end)).join('\n\n');
    if (next.length > budget) continue;
    if (selected.length && terms.length && !p.score) continue;
    selected.push(p); spans = nextSpans; content = next;
    for (const term of p.terms) covered.add(term);
  }
  return { text: content, spans, captured_hash: hash, captured_length: text.length, truncated: content.length < text.length };
}

interface CachedBody { value: Record<string, unknown>; url: string; mode: string; bytes: number; expires: number }
export class EvidenceBodyCache {
  private readonly entries = new Map<string, CachedBody>();
  private bytes = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly ttlMs = 5 * 60_000, private readonly now = Date.now) {}
  private prune(): void {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
  }
  private remove(id: string): void {
    this.bytes -= this.entries.get(id)?.bytes ?? 0;
    this.entries.delete(id);
  }
  put(url: string, value: Record<string, unknown>, mode: string): string | undefined {
    this.prune();
    if (typeof value.content !== 'string' || !value.content) return undefined;
    const size = Math.max(Buffer.byteLength(value.content, 'utf8'), value.content.length * 2);
    if (size > this.maxBytes) return undefined;
    while (this.entries.size && (this.bytes + size > this.maxBytes || this.entries.size >= 32)) this.remove(this.entries.keys().next().value!);
    const id = `transient:${randomUUID()}`;
    this.entries.set(id, { value: { ...value }, url, mode, bytes: size, expires: this.now() + this.ttlMs });
    this.bytes += size;
    return id;
  }
  get(url: string, mode: string, id?: string): Record<string, unknown> | undefined {
    this.prune();
    const matches = (entry: CachedBody) => entry.url === url || entry.value.url === url;
    const key = id ?? [...this.entries].reverse().find(([, x]) => matches(x) && x.mode === mode)?.[0];
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry || !matches(entry) || entry.mode !== mode) return undefined;
    return { ...entry.value, body_handle: key, body_expires_at: new Date(entry.expires).toISOString() };
  }
  stats(): { entries: number; bytes: number; max_bytes: number; ttl_ms: number } {
    this.prune();
    return { entries: this.entries.size, bytes: this.bytes, max_bytes: this.maxBytes, ttl_ms: this.ttlMs };
  }
}

const bodyCaches = new WeakMap<object, EvidenceBodyCache>();
export function evidenceBodiesFor(owner: object): EvidenceBodyCache {
  let cache = bodyCaches.get(owner);
  if (!cache) { cache = new EvidenceBodyCache(); bodyCaches.set(owner, cache); }
  return cache;
}
