import { formatToolResponse, type CallToolResult } from './response.js';

function siteDomain(query: string): string | undefined {
  const tokens = query.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
  if (tokens.some(token => /^(?:OR|NOT|\|)$/i.test(token) || /[()]/.test(token))) return;
  const sites = tokens.filter(token => /^site:/i.test(token));
  if (sites.length !== 1) return;
  const match = sites[0].slice(5).match(/^(?:https?:\/\/)?([^/?#:\s]+)\/?$/i);
  if (!match || !/^[\p{L}\p{N}.-]+$/u.test(match[1])) return;
  try { return new URL(`https://${match[1]}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { return; }
}

export function enforceSearchSiteScope(response: CallToolResult): CallToolResult {
  if (response.isError || !response.structuredContent) return response;
  const scopes: Array<{ domain: string; removed: number; recovered_references?: number }> = [];
  const visit = (value: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(value.results)) return value;
    if (typeof value.query !== 'string') return { ...value, results: value.results.map(visit) };
    const domain = siteDomain(value.query);
    if (!domain) return value;
    const matchesDomain = (value: string) => {
      try {
        const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && (host === domain || host.endsWith(`.${domain}`));
      } catch { return false; }
    };
    const results = value.results.filter((row: { url?: string }) => matchesDomain(row.url ?? ''));
    const removed = value.results.length - results.length;
    if (!removed) return value;
    let recovered = 0;
    if (!results.length && !/(?:^|\s)-site:/i.test(value.query)) {
      const seen = new Set<string>();
      for (const row of value.results as Array<Record<string, unknown>>) {
        const references = [...(typeof row.canonical_url === 'string' ? [row.canonical_url] : []),
          ...Array.from(String(row.description ?? '').matchAll(/https?:\/\/[^\s<>"\]\)]+/g),match=>match[0])];
        for (const reference of references) {
          if (!reference || reference.length > 2000) continue;
          const url = reference.replace(/[.,;!?]+$/, '');
          if (!matchesDomain(url) || seen.has(url)) continue;
          seen.add(url); recovered++;
          results.push({ title: `Referenced source: ${new URL(url).pathname}`, url, description:'', discovery:'serp_reference', discovered_from:row.url });
          if (results.length >= Math.min(4,value.results.length)) break;
        }
        if (results.length >= Math.min(4,value.results.length)) break;
      }
    }
    const scope = { domain, removed, ...(recovered ? { recovered_references:recovered } : {}) };
    scopes.push(scope);
    return { ...value, results, site_scope: scope,
      degraded_reasons: [...new Set([...(Array.isArray(value.degraded_reasons) ? value.degraded_reasons : []), 'site_scope_mismatch'])] };
  };
  const data = visit(response.structuredContent);
  if (!scopes.length) return response;
  const meta = data.meta as Record<string, unknown> | undefined;
  return formatToolResponse({ ...data, meta: { ...meta, site_scope: scopes,
    degraded_reasons: [...new Set([...(Array.isArray(meta?.degraded_reasons) ? meta.degraded_reasons : []), 'site_scope_mismatch'])] } });
}
