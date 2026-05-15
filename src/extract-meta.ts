const ABSTRACT_SOURCES: ReadonlyArray<{ id: string; attr: 'name' | 'property'; value: string }> = [
  { id: 'citation_abstract',  attr: 'name',     value: 'citation_abstract' },
  { id: 'dc.description',     attr: 'name',     value: 'dc.description' },
  { id: 'description',        attr: 'name',     value: 'description' },
  { id: 'og:description',     attr: 'property', value: 'og:description' },
];

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_TAG_RE = /<meta\s+([^>]+?)\s*\/?>/gi;
const CONTENT_ATTR_RE = /\bcontent\s*=\s*["']([^"']*)["']/i;

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
