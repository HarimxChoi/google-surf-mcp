// uses browser globals only (page.evaluate + jsdom tests)
export interface ParsedResult {
  title: string;
  url: string;
  description: string;
}

export interface ParseOutput {
  results: ParsedResult[];
  h3Count: number;
}

export function parseResults(max: number): ParseOutput {
  const SKIP_HOSTS = new Set([
    'www.google.com',
    'accounts.google.com',
    'webcache.googleusercontent.com',
    'translate.google.com',
  ]);
  const seen = new Set<string>();
  const results: ParsedResult[] = [];
  const h3Count = document.querySelectorAll('h3').length;
  const blocks = document.querySelectorAll(
    'div.g, div[data-snc], div[data-hveid], div[jscontroller], div.MjjYud, div.tF2Cxc',
  );
  for (const el of Array.from(blocks)) {
    // skip sponsored / ads (top, bottom, inline)
    if (
      el.matches('[data-text-ad], [data-pcu]') ||
      el.closest('#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i]')
    ) continue;
    const t = el.querySelector('h3');
    const a = el.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
    if (!t || !a) continue;
    const url = a.href;
    if (seen.has(url)) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (SKIP_HOSTS.has(host)) continue;
    seen.add(url);
    const sn =
      el.querySelector('[data-sncf="1"]') ||
      el.querySelector('.VwiC3b') ||
      el.querySelector('div[style*="-webkit-line-clamp"]');
    results.push({
      title: (t.textContent || '').trim(),
      url,
      description: (sn?.textContent || '').trim().slice(0, 600),
    });
    if (results.length >= max) break;
  }
  return { results, h3Count };
}
