import type { DocumentCatalog } from './documentCatalog.js';

export function boundDocumentCatalog(catalog: DocumentCatalog, maxChars: number): DocumentCatalog | undefined {
  const budget = Math.max(0, Math.min(6000, maxChars));
  if (JSON.stringify(catalog).length <= budget) return catalog;
  const bounded: DocumentCatalog = { ...catalog, producer_properties: [], source_parts: [], details_truncated: true,
    ...(catalog.presentation ? { presentation: { ...catalog.presentation, hidden_slide_indexes: [],
      notes_relationship_slide_indexes: [], nonempty_note_slide_indexes: [], unresolved_slide_indexes: [], sections: [] } } : {}) };
  if (JSON.stringify(bounded).length > budget) return undefined;
  const append = <T>(target: T[], values: T[]): void => {
    for (const value of values) {
      target.push(value);
      if (JSON.stringify(bounded).length > budget) { target.pop(); break; }
    }
  };
  if (bounded.presentation && catalog.presentation) {
    for (const key of ['hidden_slide_indexes', 'notes_relationship_slide_indexes', 'nonempty_note_slide_indexes', 'unresolved_slide_indexes'] as const) {
      append(bounded.presentation[key], catalog.presentation[key]);
    }
    append(bounded.presentation.sections, catalog.presentation.sections);
  }
  append(bounded.producer_properties, catalog.producer_properties);
  append(bounded.source_parts, catalog.source_parts);
  return bounded;
}
