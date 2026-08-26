const ABSTRACT_SOURCES: ReadonlyArray<{ id: string; attr: 'name' | 'property'; value: string }> = [
  { id: 'citation_abstract',  attr: 'name',     value: 'citation_abstract' },
  { id: 'dc.description',     attr: 'name',     value: 'dc.description' },
  { id: 'description',        attr: 'name',     value: 'description' },
  { id: 'og:description',     attr: 'property', value: 'og:description' },
];

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_TAG_RE = /<meta\s+([^>]+?)\s*\/?>/gi;
const CONTENT_ATTR_RE = /\bcontent\s*=\s*["']([^"']*)["']/i;
const CANONICAL_RE = /<link\s+([^>]*\brel\s*=\s*["'][^"']*\bcanonical\b[^"']*["'][^>]*)>/i;
const HREF_ATTR_RE = /\bhref\s*=\s*["']([^"']*)["']/i;

export interface DocumentMetadata {
  title?: string;
  authors?: string;
  publication?: string;
  published_at?: string;
  year?: number;
  doi?: string;
  description?: string;
  keywords?: string[];
  canonical_url?: string;
  language?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  created_at?: string;
  modified_at?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMetaContent(html: string, attr: string, value: string): string | null {
  const target = new RegExp(`\\b${escapeRegex(attr)}\\s*=\\s*["']${escapeRegex(value)}["']`, 'i');
  META_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_TAG_RE.exec(html)) !== null) {
    const attrs = m[1];
    if (!target.test(attrs)) continue;
    const cm = attrs.match(CONTENT_ATTR_RE);
    if (cm) return cm[1];
  }
  return null;
}

function findMetaContents(html: string, attr: string, value: string): string[] {
  const target = new RegExp(`\\b${escapeRegex(attr)}\\s*=\\s*["']${escapeRegex(value)}["']`, 'i');
  const values: string[] = [];
  META_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = META_TAG_RE.exec(html)) !== null) {
    if (!target.test(match[1])) continue;
    const content = match[1].match(CONTENT_ATTR_RE)?.[1];
    if (content?.trim()) values.push(decodeEntities(content.trim()));
  }
  return values;
}

function firstMeta(html: string, candidates: Array<[string, string]>): string | undefined {
  for (const [attr, value] of candidates) {
    const content = findMetaContent(html, attr, value);
    if (content?.trim()) return decodeEntities(content.trim());
  }
  return undefined;
}

function normalizeDoi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const doi = value.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : undefined;
}

function metadataYear(value: string | undefined): number | undefined {
  const year = value?.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1];
  return year ? Number(year) : undefined;
}

function canonicalUrl(html: string, baseUrl: string): string | undefined {
  const href = html.match(CANONICAL_RE)?.[1].match(HREF_ATTR_RE)?.[1];
  if (!href) return undefined;
  try { return new URL(decodeEntities(href), baseUrl).href; } catch { return undefined; }
}

export function findCitationPdfUrl(html: string, baseUrl: string): string | null {
  const v = findMetaContent(html, 'name', 'citation_pdf_url');
  if (!v) return null;
  try { return new URL(v, baseUrl).href; } catch { return null; }
}

export function findAbstractFromMeta(
  html: string,
  minLength = 80,
): { source: string; content: string } | null {
  for (const s of ABSTRACT_SOURCES) {
    const v = findMetaContent(html, s.attr, s.value);
    if (v && v.trim().length >= minLength) {
      return { source: s.id, content: v };
    }
  }
  return null;
}

export function findTitle(html: string): string | undefined {
  const ct = findMetaContent(html, 'name', 'citation_title');
  if (ct) return decodeEntities(ct);
  const og = findMetaContent(html, 'property', 'og:title');
  if (og) return decodeEntities(og);
  const t = html.match(TITLE_RE);
  return t ? decodeEntities(t[1].trim()) : undefined;
}

export function findDocumentMetadata(html: string, baseUrl: string): DocumentMetadata {
  const citationAuthors = findMetaContents(html, 'name', 'citation_author');
  const fallbackAuthor = firstMeta(html, [
    ['name', 'dc.creator'],
    ['name', 'author'],
  ]);
  const authors = [...new Set(citationAuthors.length ? citationAuthors : fallbackAuthor ? [fallbackAuthor] : [])];
  const publication = firstMeta(html, [
    ['name', 'citation_journal_title'],
    ['name', 'citation_conference_title'],
    ['property', 'og:site_name'],
  ]);
  const publishedAt = firstMeta(html, [
    ['name', 'citation_publication_date'],
    ['name', 'citation_date'],
    ['property', 'article:published_time'],
    ['name', 'dc.date'],
  ]);
  const rawDoi = firstMeta(html, [
    ['name', 'citation_doi'],
    ['name', 'dc.identifier'],
  ]);
  const keywordValues = [
    ...findMetaContents(html, 'name', 'citation_keywords'),
    ...findMetaContents(html, 'name', 'keywords'),
    ...findMetaContents(html, 'property', 'article:tag'),
  ];
  const keywords = [...new Set(keywordValues.flatMap((value) => value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)))];
  const description = findAbstractFromMeta(html, 1)?.content.trim();
  const modifiedAt = firstMeta(html, [['property', 'article:modified_time']]);
  const language = firstMeta(html, [
    ['name', 'citation_language'],
    ['property', 'og:locale'],
  ]);
  const title = findTitle(html);
  const year = metadataYear(publishedAt);
  const doi = normalizeDoi(rawDoi);
  const canonical = canonicalUrl(html, baseUrl);
  return {
    ...(title ? { title } : {}),
    ...(authors.length ? { authors: authors.join(', ') } : {}),
    ...(publication ? { publication } : {}),
    ...(publishedAt ? { published_at: publishedAt } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(description ? { description: decodeEntities(description) } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(canonical ? { canonical_url: canonical } : {}),
    ...(language ? { language } : {}),
    ...(modifiedAt ? { modified_at: modifiedAt } : {}),
  };
}

export function domainPdfTransform(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (host === 'openreview.net' && (path === '/forum' || path === '/forum/')) {
    const id = u.searchParams.get('id');
    if (id) return `https://openreview.net/pdf?id=${encodeURIComponent(id)}`;
  }

  if ((host.endsWith('biorxiv.org') || host.endsWith('medrxiv.org'))
      && path.startsWith('/content/') && !path.endsWith('.pdf')) {
    return `${u.origin}${path.replace(/\/$/, '')}.full.pdf`;
  }

  if ((host === 'www.nature.com' || host === 'nature.com')
      && path.startsWith('/articles/') && !path.endsWith('.pdf')) {
    return `${u.origin}${path.replace(/\/$/, '')}.pdf`;
  }

  return null;
}

export function findPmcUrlFromPubmed(html: string): string | null {
  const m = html.match(/\/articles\/PMC(\d+)/);
  if (!m) return null;
  return `https://pmc.ncbi.nlm.nih.gov/articles/PMC${m[1]}/`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
