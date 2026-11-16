import { createHash } from 'node:crypto';

export interface DocumentPageSpan { page: number; start: number; end: number; ocr?: true }
export interface DocumentCaptionSpan { page: number; start: number; end: number }
export interface DocumentSourceMap {
  version: 1;
  unit: 'utf16';
  source_sha256: string;
  content_hash: string;
  content_length: number;
  complete: boolean;
  pages: DocumentPageSpan[];
  captions: DocumentCaptionSpan[];
}
export interface DocumentSourceRefs {
  pages: number[];
  ocr_pages?: number[];
  excerpt_pages?: Array<[number, number, number]>;
  captions?: Array<{ page: number; label: string; range: [number, number] }>;
  truncated?: true;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const MAX_PAGES = 4096;
const MAX_CAPTIONS = 8192;

export function buildDocumentSourceMap(content: string, pages: Array<{ page: number; text: string; ocr?: boolean }>,
  sourceSha256: string, complete = true): DocumentSourceMap {
  const spans: DocumentPageSpan[] = [], captions: DocumentCaptionSpan[] = [];
  let cursor = 0;
  for (const page of pages) {
    if (!page.text.trim()) continue;
    if (spans.length >= MAX_PAGES) { complete = false; break; }
    let pageText = page.text;
    const needle = pageText.slice(0, Math.min(80, pageText.length));
    let start = content.indexOf(needle, cursor);
    if (start < 0) {
      const remaining = content.slice(cursor).trimStart();
      if (remaining && pageText.trimStart().startsWith(remaining)) {
        start = content.length - remaining.length; pageText = pageText.trimStart();
      }
    }
    if (start < 0 || !pageText.startsWith(content.slice(start, Math.min(content.length, start + pageText.length)))) {
      complete = false; continue;
    }
    const end = Math.min(content.length, start + pageText.length);
    if (end - start < pageText.length) complete = false;
    spans.push({ page: page.page, start, end, ...(page.ocr ? { ocr: true as const } : {}) });
    for (const match of content.slice(start, end).matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?(?:table|figure|fig\.|표|그림)[ \t]*[A-Z\d][\w.\-]*(?:[ \t]*[|:.\u2013\u2014]|[ \t]+)[^\n]{1,240}/gim)) {
      if (captions.length >= MAX_CAPTIONS) { complete = false; break; }
      captions.push({ page: page.page, start: start + match.index!, end: start + match.index! + match[0].length });
    }
    cursor = end;
  }
  return { version: 1, unit: 'utf16', source_sha256: sourceSha256, content_hash: hash(content),
    content_length: content.length, complete, pages: spans, captions };
}

export function readDocumentSourceMap(value: unknown, content?: string): DocumentSourceMap | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as DocumentSourceMap;
  if (row.version !== 1 || row.unit !== 'utf16' || !/^[a-f0-9]{64}$/.test(row.source_sha256)
    || !/^[a-f0-9]{64}$/.test(row.content_hash) || !Number.isSafeInteger(row.content_length) || row.content_length < 0
    || typeof row.complete !== 'boolean' || !Array.isArray(row.pages) || row.pages.length > MAX_PAGES
    || !Array.isArray(row.captions) || row.captions.length > MAX_CAPTIONS) return undefined;
  const valid = (span: DocumentPageSpan): boolean => !!span && typeof span === 'object'
    && Number.isSafeInteger(span.page) && span.page > 0
    && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
    && span.start >= 0 && span.end > span.start && span.end <= row.content_length;
  if (!row.pages.every((span, index) => valid(span) && (span.ocr === undefined || span.ocr === true)
    && (!index || span.start >= row.pages[index - 1].end))
    || !row.captions.every(span => valid(span) && row.pages.some(page => page.page === span.page
      && span.start >= page.start && span.end <= page.end))) return undefined;
  if (content !== undefined && (content.length !== row.content_length || hash(content) !== row.content_hash)) return undefined;
  return { version: 1, unit: 'utf16', source_sha256: row.source_sha256, content_hash: row.content_hash,
    content_length: row.content_length, complete: row.complete,
    pages: row.pages.map(span => ({ page: span.page, start: span.start, end: span.end, ...(span.ocr ? { ocr: true } : {}) })),
    captions: row.captions.map(span => ({ page: span.page, start: span.start, end: span.end })) };
}

export function remapDocumentSourceMap(value: unknown, source: string, target: string,
  sourceOffset: number, targetOffset: number): DocumentSourceMap | undefined {
  const map = readDocumentSourceMap(value, source);
  if (!map) return undefined;
  const end = sourceOffset + target.length - targetOffset;
  if (sourceOffset < 0 || targetOffset < 0 || targetOffset > target.length
    || source.slice(sourceOffset, end) !== target.slice(targetOffset)) return undefined;
  const shift = targetOffset - sourceOffset;
  const pages = map.pages.flatMap(page => {
    const start = Math.max(sourceOffset, page.start), limit = Math.min(end, page.end);
    return limit > start ? [{ ...page, start: start + shift, end: limit + shift }] : [];
  });
  const captions = map.captions.filter(span => span.start >= sourceOffset && span.end <= end)
    .map(span => ({ ...span, start: span.start + shift, end: span.end + shift }));
  return { ...map, content_hash: hash(target), content_length: target.length, pages, captions,
    complete: map.complete && end >= source.length };
}

export function sliceDocumentSourceMaps(value: unknown, content: string,
  ranges: Array<{ start: number; end: number }>): Array<DocumentSourceMap | undefined> {
  const map = readDocumentSourceMap(value, content);
  return ranges.map(({ start, end }) => {
    if (!map || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > content.length) return undefined;
    const pages = map.pages.flatMap(page => {
      const from = Math.max(start, page.start), to = Math.min(end, page.end);
      return to > from ? [{ ...page, start: from - start, end: to - start }] : [];
    });
    if (!pages.length) return undefined;
    const text = content.slice(start, end);
    return { ...map, content_hash: hash(text), content_length: text.length, pages,
      captions: map.captions.filter(span => span.start >= start && span.end <= end)
        .map(span => ({ ...span, start: span.start - start, end: span.end - start })),
      complete: map.complete && start === 0 && end === content.length };
  });
}

export function documentSourceRefs(value: unknown, content: string, ranges: Array<{ start: number; end: number }>,
  maxChars = 600): DocumentSourceRefs | undefined {
  const map = readDocumentSourceMap(value, content);
  if (!map || !ranges.length) return undefined;
  if (ranges.some(range => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start || range.end > content.length)) return undefined;
  const overlaps = (span: { start: number; end: number }): boolean => ranges.some(range => span.start < range.end && range.start < span.end);
  const pages = map.pages.filter(overlaps);
  if (!pages.length) return undefined;
  const result: DocumentSourceRefs = { pages: [] };
  const budget = Math.max(24, Math.min(1200, maxChars));
  for (const page of pages) {
    const next = { ...result, pages: [...result.pages, page.page],
      ...(page.ocr ? { ocr_pages: [...result.ocr_pages ?? [], page.page] } : {}) };
    if (JSON.stringify(next).length > budget - 20) { result.truncated = true; break; }
    Object.assign(result, next);
  }
  let excerptOffset = 0;
  for (const range of ranges) {
    for (const page of pages) {
      const start = Math.max(range.start, page.start), end = Math.min(range.end, page.end);
      if (end <= start || !result.pages.includes(page.page)) continue;
      const next = { ...result, excerpt_pages: [...result.excerpt_pages ?? [],
        [excerptOffset + start - range.start, excerptOffset + end - range.start, page.page] as [number, number, number]] };
      if (JSON.stringify(next).length > budget - 20) { result.truncated = true; break; }
      Object.assign(result, next);
    }
    excerptOffset += range.end - range.start + 2;
  }
  const captions = map.captions.filter(span => result.pages.includes(span.page))
    .sort((a, b) => Number(overlaps(b)) - Number(overlaps(a)) || a.start - b.start);
  for (const span of captions) {
    const label = content.slice(span.start, span.end).trim().slice(0, 100);
    const next = { ...result, captions: [...result.captions ?? [], { page: span.page, label,
      range: [span.start, span.end] as [number, number] }] };
    if (JSON.stringify(next).length > budget - 20) { result.truncated = true; break; }
    Object.assign(result, next);
  }
  return result.pages.length ? result : undefined;
}
