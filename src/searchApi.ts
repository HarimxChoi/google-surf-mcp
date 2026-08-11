import type { ScholarResult } from './scholar.js';
import type { SearchResult } from './types.js';

const SEARCH_API_ENDPOINT = 'https://www.searchapi.io/api/v1/search';
const SEARCH_API_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, any>;

export interface SearchApiHandle {
  searchGoogle(query: string, limit: number, locale: string): Promise<SearchResult[]>;
  searchScholar(query: string, limit: number, locale: string): Promise<ScholarResult[]>;
}

export class SearchApiConfigError extends Error {
  constructor() {
    super('SEARCH_API is required when a SearchApi provider mode is enabled');
    this.name = 'SearchApiConfigError';
  }
}

export class SearchApiError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'SearchApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(body: JsonObject): string | undefined {
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error.message === 'string') return body.error.message;
  return text(body.message);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function localeParams(locale: string, includeCountry: boolean): Record<string, string> {
  const [language, country] = locale.replace('_', '-').split('-');
  return {
    ...(language ? { hl: language.toLowerCase() } : {}),
    ...(includeCountry && country ? { gl: country.toLowerCase() } : {}),
  };
}

export function mapSearchApiGoogleResults(body: JsonObject, limit: number): SearchResult[] {
  const rows = Array.isArray(body.organic_results) ? body.organic_results : [];
  return rows.flatMap((row: JsonObject) => {
    const title = text(row.title);
    const url = text(row.link);
    if (!title || !url) return [];
    return [{ title, url, description: text(row.snippet) ?? '' }];
  }).slice(0, limit);
}

export function mapSearchApiScholarResults(body: JsonObject, limit: number): ScholarResult[] {
  const rows = Array.isArray(body.organic_results) ? body.organic_results : [];
  return rows.flatMap((row: JsonObject, index: number) => {
    const title = text(row.title);
    if (!title) return [];

    const metadata = text(row.publication) ?? '';
    const segments = metadata.split(/\s+-\s+/).filter(Boolean);
    const authorNames = Array.isArray(row.authors)
      ? row.authors.map((author: JsonObject) => text(author.name)).filter(Boolean) as string[]
      : [];
    const authors = authorNames.length ? authorNames.join(', ') : segments[0];
    const yearMatch = metadata.match(/\b(?:19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : undefined;
    let publication = segments.length >= 3
      ? segments.slice(1, -1).join(' - ')
      : segments.length === 2 && !/^\d{4}$/.test(segments[1]) ? segments[1] : undefined;
    if (publication && year) {
      publication = publication.replace(new RegExp(`,?\\s*${year}\\s*$`), '').trim() || undefined;
    }

    const citedBy = row.inline_links?.cited_by;
    const versions = row.inline_links?.versions;
    const source = segments.length >= 3 ? segments.at(-1) : text(row.resource?.name);
    const url = text(row.link);
    const citedByUrl = text(citedBy?.link);
    const relatedUrl = text(row.inline_links?.related_articles_link);
    const versionsUrl = text(versions?.link);
    const fullTextUrl = text(row.resource?.link);
    const scholarId = text(row.data_cid);

    return [{
      rank: number(row.position) ?? index + 1,
      title,
      ...(url ? { url } : {}),
      ...(authors ? { authors } : {}),
      ...(publication ? { publication } : {}),
      ...(year ? { year } : {}),
      ...(source ? { source } : {}),
      snippet: text(row.snippet) ?? '',
      cited_by_count: number(citedBy?.total) ?? 0,
      ...(citedByUrl ? { cited_by_url: citedByUrl } : {}),
      ...(relatedUrl ? { related_articles_url: relatedUrl } : {}),
      ...(versions ? { versions_count: number(versions.total) ?? 0 } : {}),
      ...(versionsUrl ? { versions_url: versionsUrl } : {}),
      ...(fullTextUrl ? { full_text_url: fullTextUrl } : {}),
      ...(scholarId ? { scholar_id: scholarId } : {}),
      metadata,
    }];
  }).slice(0, limit);
}

export class SearchApiClient implements SearchApiHandle {
  constructor(
    private readonly apiKey?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async searchGoogle(query: string, limit: number, locale: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const pageCount = Math.ceil(limit / 10);
    for (let page = 1; page <= pageCount; page++) {
      const body = await this.request('google', {
        q: query,
        page: String(page),
        ...localeParams(locale, true),
      });
      results.push(...mapSearchApiGoogleResults(body, 10));
    }
    return results.slice(0, limit);
  }

  async searchScholar(query: string, limit: number, locale: string): Promise<ScholarResult[]> {
    const body = await this.request('google_scholar', {
      q: query,
      num: String(limit),
      ...localeParams(locale, false),
    });
    return mapSearchApiScholarResults(body, limit);
  }

  private async request(engine: string, params: Record<string, string>): Promise<JsonObject> {
    if (!this.apiKey) throw new SearchApiConfigError();
    const url = new URL(SEARCH_API_ENDPOINT);
    url.searchParams.set('engine', engine);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(SEARCH_API_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SearchApiError(`SearchApi request failed: ${message}`);
    }

    const body = await response.json().catch(() => ({})) as JsonObject;
    const status = text(body.search_metadata?.status);
    if (!response.ok || body.error || (status && status !== 'Success')) {
      const detail = errorMessage(body) ?? (response.statusText || 'unknown error');
      throw new SearchApiError(
        `SearchApi request failed (${response.status}): ${detail}`,
        response.status,
        retryAfterMs(response),
      );
    }
    return body;
  }
}
