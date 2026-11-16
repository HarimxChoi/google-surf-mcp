import { cleanCapturedText, evidenceTerms, selectEvidence, type EvidenceMode, type EvidenceSelection, type EvidenceSpan } from './evidence.js';
import { readDocumentSourceMap, type DocumentSourceMap } from './documentSourceMap.js';

const isTableCaption = (label: string): boolean => /^\s*(?:#{1,6}\s*)?(?:table|표)\s*[A-Z\d][\w.\-]*[.:]\s+\S/i.test(label) && !/\.{3,}/.test(label);

function mergeRanges(ranges: EvidenceSpan[]): EvidenceSpan[] {
  const output: EvidenceSpan[] = [];
  for (const range of ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = output.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else output.push({ ...range });
  }
  return output;
}

export function documentContextSpans(value: unknown, content: string, maxChars: number): EvidenceSpan[][] {
  const map = readDocumentSourceMap(value, content);
  if (!map || maxChars < 80) return [];
  const output: EvidenceSpan[][] = [], seen = new Set<string>();
  const limit = Math.min(500, Math.floor(maxChars));
  const add = (start: number, end: number, headerEnd: number): void => {
    const key = `${start}:${end}`;
    if (seen.has(key) || end <= start) return;
    seen.add(key);
    if (headerEnd >= end) return;
    if (end - start + 2 <= limit) { output.push([{ start, end: headerEnd }, { start: headerEnd, end }]); return; }
    const header = { start, end: headerEnd };
    if (headerEnd - start >= limit / 2) return;
    let from = headerEnd, to = headerEnd;
    for (const line of content.slice(headerEnd, end).matchAll(/[^\n]*(?:\n|$)/g)) {
      if (!line[0]) continue;
      const next = headerEnd + line.index! + line[0].length;
      if (header.end - header.start + next - from + 2 > limit) {
        if (to > from) output.push([header, { start: from, end: to }]);
        from = to;
      }
      to = next;
      if (header.end - header.start + to - from + 2 > limit) from = to;
    }
    if (to > from) output.push([header, { start: from, end: to }]);
  };
  for (const page of map.pages) {
    const text = content.slice(page.start, page.end);
    for (const caption of map.captions.filter(span => span.page === page.page)) {
      const label = content.slice(caption.start, caption.end);
      if (!isTableCaption(label)) continue;
      const after = content.slice(caption.end, page.end);
      const bodyStart = caption.end + (after.match(/^\s*/)?.[0].length ?? 0);
      const blank = content.slice(bodyStart, page.end).search(/\r?\n[ \t]*\r?\n/);
      const end = blank < 0 ? page.end : bodyStart + blank;
      const firstLine = content.indexOf('\n', bodyStart);
      add(caption.start, end, firstLine >= bodyStart && firstLine < end ? firstLine : end);
    }
    // Continued native tables can have a column header but no repeated caption.
    for (const block of text.matchAll(/[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/g)) {
      const lines = block[0].split(/\r?\n/);
      if (lines.length < 3 || !/\S[ \t]{2,}\S/.test(lines[0])
        || lines.filter(line => /\S[ \t]{2,}\S/.test(line)).length < 3
        || /\.{3,}|\|\s*[ivx\d]+\s*$/i.test(lines[0])) continue;
      const start = page.start + block.index!;
      add(start, start + block[0].length, start + lines[0].length);
    }
  }
  return output;
}

function selectDocumentEvidenceBase(content: string, query: string, maxChars: number,
  excluded: EvidenceSpan[] = [], mode: EvidenceMode = 'balanced', sourceMap?: unknown): EvidenceSelection {
  const text = cleanCapturedText(content);
  const map = readDocumentSourceMap(sourceMap, text);
  const boundaries = map?.pages.map(page => page.start) ?? [];
  const requested = new Set([...query.matchAll(/\btable\s+([a-z]?\d[\w.\-]*)|표\s*([a-z]?\d[\w.\-]*)/gi)]
    .map(match => (match[1] ?? match[2]).replace(/[.:-]+$/, '').toLowerCase()));
  if (mode !== 'coherent' || !requested.size) return selectEvidence(text, query, maxChars, excluded, mode, boundaries);
  const context = documentContextSpans(sourceMap, text, maxChars);
  const captions = (map?.captions.filter(span => isTableCaption(text.slice(span.start, span.end))) ?? [])
    .sort((a, b) => a.start - b.start);
  const matches = (caption: EvidenceSpan): boolean => {
    const label = text.slice(caption.start, caption.end);
    const id = label.match(/(?:table|표)\s*([A-Z\d][\w.\-]*)[.:]/i)?.[1]?.replace(/[.:-]+$/, '').toLowerCase();
    return !!id && requested.has(id);
  };
  const terms = evidenceTerms(query);
  const candidates = context.filter(spans => !spans.slice(1).some(span => excluded.some(skip => span.start < skip.end && skip.start < span.end)))
    .filter(spans => {
      const start = spans[0].start, page = map?.pages.find(item => start >= item.start && start < item.end);
      const next = captions.findIndex(item => item.start > start);
      const caption = next < 0 ? captions.at(-1) : captions[next - 1];
      return page && caption && matches(caption) && page.page >= caption.page && page.page - caption.page <= 1;
    }).map(spans => ({ spans, words: new Set(evidenceTerms(spans.map(span => text.slice(span.start, span.end)).join('\n\n'))) }));
  if (!candidates.length || !terms.length) return selectEvidence(text, query, maxChars, excluded, mode, boundaries);
  const frequencies = new Map(terms.map(term => [term, candidates.filter(row => row.words.has(term)).length]));
  const ranked = candidates.map(row => ({ ...row, score: terms.reduce((sum, term) => sum + (row.words.has(term)
    ? Math.log(1 + (candidates.length - frequencies.get(term)! + .5) / (frequencies.get(term)! + .5)) : 0), 0) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.spans[0].start - b.spans[0].start);
  let ranges: EvidenceSpan[] = [], accepted = 0;
  const render = (spans: EvidenceSpan[]): string => spans.map(span => text.slice(span.start, span.end)).join('\n\n');
  for (const row of ranked) {
    const next = mergeRanges([...ranges, ...row.spans]);
    if (render(next).length > maxChars || next.every((span, index) => span.start === ranges[index]?.start && span.end === ranges[index]?.end)) continue;
    ranges = next;
    if (++accepted === 2) break;
  }
  if (!ranges.length) return selectEvidence(text, query, maxChars, excluded, mode, boundaries);
  const remaining = Math.max(0, maxChars - render(ranges).length - 2);
  const extra = selectEvidence(text, query, remaining, [...excluded, ...ranges], mode, boundaries);
  const spans = mergeRanges([...ranges, ...extra.spans]);
  const body = render(spans);
  return { ...extra, text: body, spans, truncated: body.length < text.length };
}

const SUPERSCRIPTS = ['\u2070', '\u00b9', '\u00b2', '\u00b3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];
const MEASUREMENT_NOTE = /\d(?:[\d.,\[\]\s+-]|to){0,30}(?:\u00b0[CF]|%|[kMGT]?Hz|[kMGT]?W|[kMGT]?V|[munp\u00b5]?A|[kMGT]?B|[KMGT]iB|[mnu\u00b5]?s|[kcmnu\u00b5]?m|kg|g|J|K|C|[kMGT]?Pa|eV|mol|L|bits?)(\d{1,3})(?![\p{L}\p{N}])/gu;

function noteMarkers(text: string): Set<string> {
  const ids = new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map(match => match[1]));
  for (const match of text.matchAll(/(?<![\u2070\u00b9\u00b2\u00b3\u2074-\u2079])[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]{1,3}(?![\u2070\u00b9\u00b2\u00b3\u2074-\u2079])/g)) {
    ids.add([...match[0]].map(value => SUPERSCRIPTS.indexOf(value)).join(''));
  }
  // Bare trailing digits in identifiers such as DDR5 are not measurement-note markers.
  for (const match of text.matchAll(MEASUREMENT_NOTE)) ids.add(match[1]);
  for (const match of text.matchAll(/(?<=\S)[*\u2020\u2021](?![\p{L}\p{N}])(?![ \t]*[\d+*/=])/gu)) ids.add(match[0]);
  return ids;
}

function referencedNotes(text: string, map: DocumentSourceMap, selected: EvidenceSpan[], query: string,
  excluded: EvidenceSpan[]): Array<{ spans: EvidenceSpan[]; score: number }> {
  const terms = new Set(evidenceTerms(query));
  const candidates: Array<{ spans: EvidenceSpan[]; score: number }> = [];
  for (const page of map.pages) {
    const anchors = selected.flatMap(span => {
      const start = Math.max(page.start, span.start), end = Math.min(page.end, span.end);
      if (end <= start) return [];
      const body = text.slice(start, end), markers = noteMarkers(body);
      const score = evidenceTerms(body).filter(term => terms.has(term)).length;
      return markers.size && score ? [{ start, end, markers, score }] : [];
    });
    if (!anchors.length) continue;
    const pageText = text.slice(page.start, page.end);
    const definitions = [...pageText.matchAll(/^[ \t]*(?:\[(\d{1,3})\]|(\d{1,3})[.)]|(\d{1,3})(?=[ \t]{2,})|([*\u2020\u2021]))[ \t]+(?=\S)/gm)];
    const counts = new Map<string, number>();
    for (const item of definitions) {
      const key = item[1] ?? item[2] ?? item[3] ?? item[4];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [index, match] of definitions.entries()) {
      const id = match[1] ?? match[2] ?? match[3], symbol = match[4];
      const key = id ?? symbol;
      if (counts.get(key) !== 1 || !anchors.some(anchor => anchor.markers.has(key))) continue;
      const start = page.start + match.index!, bodyStart = start + match[0].length;
      const next = definitions[index + 1];
      const limit = next ? page.start + next.index! : page.end;
      const blank = text.slice(bodyStart, limit).search(/\r?\n[ \t]*\r?\n/);
      const end = blank < 0 ? limit : bodyStart + blank;
      if (end - bodyStart < 8 || end - start > 500
        || (!map.complete && page.end === text.length && index === definitions.length - 1 && blank < 0)
        || excluded.some(span => span.start < end && start < span.end)) continue;
      for (const anchor of anchors) {
        if (anchor.end > start || !anchor.markers.has(key)) continue;
        candidates.push({ spans: [{ start: anchor.start, end: anchor.end }, { start, end }], score: anchor.score });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.spans[0].start - b.spans[0].start);
}

export function selectDocumentEvidence(content: string, query: string, maxChars: number,
  excluded: EvidenceSpan[] = [], mode: EvidenceMode = 'balanced', sourceMap?: unknown): EvidenceSelection {
  const selected = selectDocumentEvidenceBase(content, query, maxChars, excluded, mode, sourceMap);
  if (mode !== 'coherent' || !query || !selected.spans.length) return selected;
  const text = cleanCapturedText(content), map = readDocumentSourceMap(sourceMap, text);
  if (!map) return selected;
  const candidates = referencedNotes(text, map, selected.spans, query, excluded);
  if (!candidates.length) return selected;
  const render = (spans: EvidenceSpan[]): string => spans.map(span => text.slice(span.start, span.end)).join('\n\n');
  // Preserve a requested table's selected rows before adding lexical note context.
  let spans: EvidenceSpan[] = /\btable\s+[a-z]?\d|표\s*[a-z]?\d/i.test(query) ? selected.spans : [];
  let added = false;
  for (const candidate of candidates) {
    const next = mergeRanges([...spans, ...candidate.spans]);
    if (render(next).length > maxChars) continue;
    spans = next; added = true;
  }
  if (!added) return selected;
  const terms = new Set(evidenceTerms(query));
  const extras = selected.spans.map(span => ({ span, score: evidenceTerms(text.slice(span.start, span.end))
    .filter(term => terms.has(term)).length })).sort((a, b) => b.score - a.score || a.span.start - b.span.start);
  for (const { span } of extras) {
    const next = mergeRanges([...spans, span]);
    if (render(next).length <= maxChars) spans = next;
  }
  const body = render(spans);
  return { ...selected, text: body, spans, truncated: body.length < text.length };
}
