import type { ResearchSearchFilters } from './contracts.js';

export function hasScope(filters?: ResearchSearchFilters): boolean {
  return Boolean(filters && [filters.namespaces, filters.sports, filters.folders, filters.model_ids].some(values => values?.length));
}

export function matchesScope(filters: ResearchSearchFilters | undefined, text: string,
  fields: Record<string, unknown> = {}): boolean {
  if (!hasScope(filters)) return true;
  const normalized = text.replace(/\\/g, '/').toLowerCase();
  const token = (value: string) => normalized.split(/[^\p{L}\p{N}_.-]+/u).includes(value.toLowerCase());
  const exact = (field: string, values: string[] | undefined, fallback: (value: string) => boolean) => !values?.length
    || values.some(value => fields[field] !== undefined && fields[field] !== null
      ? String(fields[field]).toLowerCase() === value.toLowerCase() : fallback(value));
  return exact('sport', filters?.sports, token)
    && (!filters?.namespaces?.length || filters.namespaces.some(value => {
      const namespace = String(fields.namespace ?? '').toLowerCase(), wanted = value.toLowerCase();
      return namespace ? namespace === wanted || namespace.startsWith(`${wanted}:`)
        : normalized.includes(`${wanted}:`) || normalized.includes(`${wanted}/`);
    }))
    && exact('model_id', filters?.model_ids, token)
    && (!filters?.folders?.length || filters.folders.some(value => {
      const path = String(fields.folder ?? fields.path ?? normalized).replace(/\\/g, '/').toLowerCase();
      const folder = value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      return path === folder || path.startsWith(`${folder}/`) || path.includes(`/${folder}/`);
    }));
}
