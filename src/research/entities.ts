import { createHash } from 'node:crypto';
import type { EntityLinkCandidate, EntityRecord } from './contracts.js';

export function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/[^\p{L}\p{N}./:+_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function entityId(projectId: string, kind: string, normalizedName: string): string {
  return createHash('sha256').update(`${projectId}\0${kind}\0${normalizedName}`)
    .digest('hex').slice(0, 24);
}

export function aliasId(projectId: string, entity: string, normalizedAlias: string): string {
  return createHash('sha256').update(`${projectId}\0${entity}\0${normalizedAlias}`)
    .digest('hex').slice(0, 24);
}

function tokens(value: string): Set<string> {
  return new Set(normalizeEntityName(value).split(/[\s/._:+-]+/).filter((token) => token.length > 1));
}

export function entitySimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function rankEntityCandidates(
  name: string,
  entities: EntityRecord[],
  aliasEntityIds: Set<string>,
  limit = 5,
): EntityLinkCandidate[] {
  const normalized = normalizeEntityName(name);
  return entities
    .filter((entity) => entity.status !== 'merged')
    .map((entity) => ({
      entity,
      match: entity.normalized_name === normalized
        ? 'exact' as const
        : aliasEntityIds.has(entity.entity_id)
          ? 'alias' as const
          : 'candidate' as const,
      score: entity.normalized_name === normalized || aliasEntityIds.has(entity.entity_id)
        ? 1
        : entitySimilarity(name, entity.canonical_name),
    }))
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score
      || a.entity.canonical_name.localeCompare(b.entity.canonical_name))
    .slice(0, limit);
}
