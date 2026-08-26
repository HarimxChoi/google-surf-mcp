import { createHash } from 'node:crypto';
import type {
  GraphAnalysis, GraphEdgeRecord, GraphNodeRecord, GraphProjection,
} from './contracts.js';

type View = 'graph' | 'lineage' | 'ontology';

interface ViewerNode {
  id: string;
  label: string;
  kind: GraphNodeRecord['kind'];
  project_id: string;
  shared: boolean;
  url?: string;
  pagerank: number;
  community: number;
  degree: number;
  x: number;
  y: number;
  size: number;
}

interface ViewerEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

interface ViewerGraph {
  view: View;
  lane_labels: string[];
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  source_node_count: number;
  source_edge_count: number;
  omitted_node_count: number;
  omitted_edge_count: number;
}

export interface InteractiveVisualizationExport {
  content: string;
  node_count: number;
  edge_count: number;
}

const VIEW_KINDS: Record<Exclude<View, 'graph'>, Set<GraphNodeRecord['kind']>> = {
  lineage: new Set([
    'project', 'root', 'directory', 'source', 'document', 'snapshot', 'symbol',
    'evidence', 'assertion', 'session', 'intent', 'plan', 'experiment', 'decision',
  ]),
  ontology: new Set([
    'project', 'root', 'directory', 'source', 'document', 'snapshot', 'symbol',
    'evidence', 'assertion', 'session', 'intent', 'plan', 'experiment', 'decision',
    'ontology', 'schema', 'entity', 'identity',
  ]),
};

const ONTOLOGY_EDGE_TYPES = new Set([
  'USES_ONTOLOGY', 'ALIGNS_TO_SCHEMA', 'SUPERSEDES_TERM',
  'INSTANCE_OF', 'USES_RELATION', 'IDENTITY_LINK',
]);

const VIEW_LIMIT: Record<View, number> = { graph: 240, lineage: 180, ontology: 160 };

const KIND_PRIORITY: Record<View, Partial<Record<GraphNodeRecord['kind'], number>>> = {
  graph: {
    project: 100, decision: 98, plan: 96, experiment: 94, intent: 92,
    assertion: 90, evidence: 88, ontology: 86, schema: 84, identity: 82,
    entity: 80, document: 76, symbol: 68, source: 62, snapshot: 58,
    session: 56, root: 52, directory: 30,
  },
  lineage: {
    project: 100, decision: 98, experiment: 96, plan: 94, intent: 92,
    assertion: 90, evidence: 88, document: 82, snapshot: 78, symbol: 74,
    source: 70, session: 66, root: 58, directory: 40,
  },
  ontology: {
    schema: 100, ontology: 98, identity: 96, project: 94, entity: 82,
    decision: 80, experiment: 78, plan: 76, assertion: 74, evidence: 72,
    symbol: 70, source: 68, document: 66, session: 64, intent: 62,
    snapshot: 60, directory: 50, root: 48,
  },
};

const KIND_CAP: Record<View, Partial<Record<GraphNodeRecord['kind'], number>>> = {
  graph: {
    project: 20, decision: 30, plan: 24, experiment: 40, intent: 20,
    assertion: 36, evidence: 36, ontology: 20, schema: 20, identity: 20,
    entity: 64, document: 32, symbol: 80, source: 42, snapshot: 20,
    session: 16, root: 12, directory: 24,
  },
  lineage: {
    project: 12, decision: 30, experiment: 36, plan: 24, intent: 20,
    assertion: 36, evidence: 36, document: 26, snapshot: 20, symbol: 36,
    source: 34, session: 18, root: 12, directory: 18,
  },
  ontology: {
    schema: 40, ontology: 40, identity: 24, project: 20, entity: 12,
    decision: 6, experiment: 8, plan: 6, assertion: 8, evidence: 8,
    symbol: 12, source: 10, document: 8, session: 4, intent: 4,
    snapshot: 4, directory: 6, root: 2,
  },
};

const LINEAGE_LANE: Partial<Record<GraphNodeRecord['kind'], number>> = {
  project: 0,
  snapshot: 1, session: 1,
  root: 2, directory: 2, intent: 2,
  source: 3, document: 3, plan: 3,
  symbol: 4, evidence: 4, experiment: 4,
  assertion: 5, decision: 5,
};

const LINEAGE_LABELS = [
  'Project', 'Snapshot / session', 'Source tree / intent',
  'Files / plans', 'Code + evidence / experiments', 'Assertions / decisions',
];

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectAliases(projection: GraphProjection): Map<string, string> {
  const projectNodes = new Map(projection.nodes
    .filter((node) => node.kind === 'project')
    .map((node) => [node.project_id, node.label]));
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const projectId of [...projection.project_ids].sort()) {
    const source = projectNodes.get(projectId) ?? projectId;
    let alias = source
      .replace(/bau[\s_-]*browser[\s_-]*/gi, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!alias) alias = 'Project';
    const base = alias;
    let index = 2;
    while (used.has(alias.toLowerCase())) alias = `${base} ${index++}`;
    used.add(alias.toLowerCase());
    aliases.set(projectId, alias);
  }
  return aliases;
}

function sanitizeDisplayText(value: string, aliases: Map<string, string>): string {
  let result = value;
  const replacements = [...aliases].flatMap(([projectId, alias]) => {
    const values = [[projectId, alias]] as Array<[string, string]>;
    return values;
  }).sort((left, right) => right[0].length - left[0].length);
  for (const [source, alias] of replacements) {
    result = result.replace(new RegExp(escapedPattern(source), 'gi'), alias);
  }
  return result
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+/gi, '[local]')
    .replace(/\/(?:Users|home)\/[^/\s]+/gi, '[local]')
    .replace(/\b(?:harimxchoi|harim[\s._-]*choi|choi[\s._-]*harim)\b/gi, '')
    .replace(/bau[\s_-]*browser[\s_-]*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._:/-]+|[\s._:/-]+$/g, '')
    .trim();
}

function publicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

function degreeMap(edges: GraphEdgeRecord[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function compareNodes(
  view: View,
  analysis: GraphAnalysis,
  degree: Map<string, number>,
): (left: GraphNodeRecord, right: GraphNodeRecord) => number {
  return (left, right) => (
    (KIND_PRIORITY[view][right.kind] ?? 0) - (KIND_PRIORITY[view][left.kind] ?? 0)
    || (analysis.pagerank?.[right.node_id] ?? 0) - (analysis.pagerank?.[left.node_id] ?? 0)
    || (degree.get(right.node_id) ?? 0) - (degree.get(left.node_id) ?? 0)
    || left.node_id.localeCompare(right.node_id)
  );
}

function selectNodes(
  view: View,
  nodes: GraphNodeRecord[],
  edges: GraphEdgeRecord[],
  analysis: GraphAnalysis,
): GraphNodeRecord[] {
  const limit = VIEW_LIMIT[view];
  const degree = degreeMap(edges);
  const compare = compareNodes(view, analysis, degree);
  const sorted = [...nodes].sort(compare);
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  const selected = new Map<string, GraphNodeRecord>();
  const kindCounts = new Map<GraphNodeRecord['kind'], number>();
  const add = (node: GraphNodeRecord): boolean => {
    if (selected.has(node.node_id) || selected.size >= limit) return false;
    const count = kindCounts.get(node.kind) ?? 0;
    const cap = KIND_CAP[view][node.kind] ?? limit;
    if (count >= cap) return false;
    selected.set(node.node_id, node);
    kindCounts.set(node.kind, count + 1);
    return true;
  };

  for (const node of sorted) {
    if (['project', 'plan', 'intent', 'decision', 'ontology', 'schema', 'identity'].includes(node.kind)) {
      add(node);
    }
  }
  if (view === 'graph') {
    const communities = new Map<number, GraphNodeRecord[]>();
    for (const node of sorted) {
      const community = analysis.community?.[node.node_id] ?? -1;
      const bucket = communities.get(community) ?? [];
      bucket.push(node);
      communities.set(community, bucket);
    }
    const buckets = [...communities.values()].sort((left, right) => {
      const leftRank = left.slice(0, 8)
        .reduce((sum, node) => sum + (analysis.pagerank?.[node.node_id] ?? 0), 0);
      const rightRank = right.slice(0, 8)
        .reduce((sum, node) => sum + (analysis.pagerank?.[node.node_id] ?? 0), 0);
      return rightRank - leftRank || compare(left[0], right[0]);
    });
    for (const bucket of buckets.slice(0, 12)) add(bucket[0]);
  }
  if (view === 'lineage') {
    const lineageTypes = [
      'HAS_SOURCE_SNAPSHOT', 'SUPERSEDES_SNAPSHOT', 'CONTAINS_ENTRY', 'DEFINES',
      'DERIVED_FROM', 'SUPPORTED_BY', 'HAS_SESSION', 'HAS_INTENT', 'HAS_PLAN',
      'USES_PLAN', 'BASED_ON', 'PART_OF_EXPERIMENT', 'HAS_DECISION',
      'DECIDES_PLAN', 'DECIDES_EXPERIMENT',
    ];
    for (const type of lineageTypes) {
      let added = 0;
      const candidates = edges.filter((edge) => edge.type === type).sort((left, right) => (
        right.weight - left.weight || left.edge_id.localeCompare(right.edge_id)
      ));
      for (const edge of candidates) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) continue;
        const addedSource = add(source);
        const addedTarget = add(target);
        const changed = addedSource || addedTarget;
        if (changed && ++added >= 8) break;
      }
    }
  }

  const adjacency = new Map<string, Array<{ node: GraphNodeRecord; weight: number }>>();
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const sourceNeighbors = adjacency.get(source.node_id) ?? [];
    sourceNeighbors.push({ node: target, weight: edge.weight });
    adjacency.set(source.node_id, sourceNeighbors);
    const targetNeighbors = adjacency.get(target.node_id) ?? [];
    targetNeighbors.push({ node: source, weight: edge.weight });
    adjacency.set(target.node_id, targetNeighbors);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => (
      right.weight - left.weight || compare(left.node, right.node)
    ));
  }

  if (view === 'ontology') {
    for (const node of sorted) {
      if ((adjacency.get(node.node_id)?.length ?? 0) > 0) add(node);
    }
    return [...selected.values()];
  }

  const queue = [...selected.keys()];
  const offsets = new Map<string, number>();
  while (queue.length && selected.size < limit) {
    const nodeId = queue.shift()!;
    const neighbors = adjacency.get(nodeId) ?? [];
    let offset = offsets.get(nodeId) ?? 0;
    while (offset < neighbors.length) {
      const candidate = neighbors[offset++].node;
      if (!add(candidate)) continue;
      offsets.set(nodeId, offset);
      queue.push(nodeId, candidate.node_id);
      break;
    }
  }
  return [...selected.values()];
}

function stableFraction(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function graphPositions(
  nodes: GraphNodeRecord[],
  analysis: GraphAnalysis,
): Map<string, { x: number; y: number }> {
  const groups = new Map<number, GraphNodeRecord[]>();
  for (const node of nodes) {
    const community = analysis.community?.[node.node_id] ?? -1;
    const bucket = groups.get(community) ?? [];
    bucket.push(node);
    groups.set(community, bucket);
  }
  const ranked = [...groups].sort((left, right) => {
    const leftRank = left[1].reduce((sum, node) => sum + (analysis.pagerank?.[node.node_id] ?? 0), 0);
    const rightRank = right[1].reduce((sum, node) => sum + (analysis.pagerank?.[node.node_id] ?? 0), 0);
    return rightRank - leftRank || left[0] - right[0];
  });
  const positions = new Map<string, { x: number; y: number }>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let groupIndex = 0; groupIndex < ranked.length; groupIndex++) {
    const [, members] = ranked[groupIndex];
    const radius = ranked.length <= 1 ? 0 : 0.35 * Math.sqrt((groupIndex + 0.5) / ranked.length);
    const angle = groupIndex * golden;
    const centerX = 0.5 + Math.cos(angle) * radius;
    const centerY = 0.5 + Math.sin(angle) * radius;
    members.sort((left, right) => (
      (analysis.pagerank?.[right.node_id] ?? 0) - (analysis.pagerank?.[left.node_id] ?? 0)
      || left.node_id.localeCompare(right.node_id)
    ));
    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const memberRadius = memberIndex === 0 ? 0 : 0.018 * Math.sqrt(memberIndex);
      const memberAngle = memberIndex * golden
        + stableFraction(members[memberIndex].node_id) * Math.PI * 2;
      positions.set(members[memberIndex].node_id, {
        x: centerX + Math.cos(memberAngle) * memberRadius,
        y: centerY + Math.sin(memberAngle) * memberRadius,
      });
    }
  }
  for (const node of nodes.filter((candidate) => candidate.kind === 'project')) {
    positions.set(node.node_id, {
      x: 0.5 + (stableFraction(node.node_id) - 0.5) * 0.04,
      y: 0.5 + (stableFraction(`${node.node_id}:y`) - 0.5) * 0.04,
    });
  }
  return positions;
}

function lanePositions(
  view: Exclude<View, 'graph'>,
  nodes: GraphNodeRecord[],
  analysis: GraphAnalysis,
): { positions: Map<string, { x: number; y: number }>; labels: string[] } {
  const hasIdentity = nodes.some((node) => node.kind === 'identity');
  const labels = view === 'lineage'
    ? LINEAGE_LABELS
    : hasIdentity
      ? ['Project', 'Types / relations', 'Shared schema', 'Verified identity', 'Typed instances']
      : ['Project', 'Types / relations', 'Shared schema', 'Typed instances'];
  const lane = (node: GraphNodeRecord): number => {
    if (view === 'lineage') return LINEAGE_LANE[node.kind] ?? 0;
    if (node.kind === 'project') return 0;
    if (node.kind === 'ontology') return 1;
    if (node.kind === 'schema') return 2;
    if (node.kind === 'identity') return 3;
    return hasIdentity ? 4 : 3;
  };
  const memoryKinds = new Set<GraphNodeRecord['kind']>([
    'session', 'intent', 'plan', 'experiment', 'decision',
  ]);
  const groups = new Map<string, GraphNodeRecord[]>();
  for (const node of nodes) {
    const track = view === 'lineage'
      ? node.kind === 'project' ? 'project' : memoryKinds.has(node.kind) ? 'memory' : 'data'
      : 'ontology';
    const key = `${lane(node)}:${track}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(node);
    groups.set(key, bucket);
  }
  const maxLane = labels.length - 1;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [key, members] of groups) {
    const [laneValue, track] = key.split(':');
    const laneIndex = Number(laneValue);
    members.sort((left, right) => (
      left.project_id.localeCompare(right.project_id)
      || (view === 'ontology' ? left.kind.localeCompare(right.kind) : 0)
      || (analysis.pagerank?.[right.node_id] ?? 0) - (analysis.pagerank?.[left.node_id] ?? 0)
      || left.node_id.localeCompare(right.node_id)
    ));
    const [top, bottom] = view !== 'lineage' ? [0.08, 0.92]
      : track === 'memory' ? [0.68, 0.92]
        : track === 'data' ? [0.08, 0.56]
          : [0.28, 0.72];
    for (let index = 0; index < members.length; index++) {
      const projectY = track === 'project'
        ? (() => {
          const projectId = members[index].project_id;
          const projectNodes = nodes.filter((node) => node.project_id === projectId);
          const memoryCount = projectNodes.filter((node) => memoryKinds.has(node.kind)).length;
          const dataCount = projectNodes.length - memoryCount - 1;
          if (!memoryCount) return 0.3;
          if (!dataCount) return 0.8;
          return (dataCount * 0.3 + memoryCount * 0.8) / (dataCount + memoryCount);
        })()
        : undefined;
      positions.set(members[index].node_id, {
        x: 0.08 + (0.84 * laneIndex) / Math.max(1, maxLane),
        y: projectY ?? (members.length === 1 ? (top + bottom) / 2
          : top + ((bottom - top) * index) / (members.length - 1)),
      });
    }
  }
  return { positions, labels };
}

function basename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}

function viewerLabels(
  nodes: GraphNodeRecord[],
  edges: GraphEdgeRecord[],
  aliases: Map<string, string>,
): Map<string, string> {
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  const definedBy = new Map<string, GraphNodeRecord>();
  for (const edge of edges) {
    if (edge.type !== 'DEFINES') continue;
    const source = nodeById.get(edge.source);
    if (source) definedBy.set(edge.target, source);
  }
  const labels = new Map<string, string>();
  for (const node of nodes) {
    const project = aliases.get(node.project_id) ?? 'Shared';
    const raw = node.kind === 'project' ? project
      : node.kind === 'ontology' ? `${node.label} · type / relation`
        : node.kind === 'schema' ? `${node.label} · shared schema`
          : node.label;
    labels.set(node.node_id, sanitizeDisplayText(raw, aliases) || node.kind);
  }
  const sequenceKinds = new Set<GraphNodeRecord['kind']>(['snapshot', 'session']);
  for (const kind of sequenceKinds) {
    const byProject = new Map<string, GraphNodeRecord[]>();
    for (const node of nodes.filter((candidate) => candidate.kind === kind)) {
      const bucket = byProject.get(node.project_id) ?? [];
      bucket.push(node);
      byProject.set(node.project_id, bucket);
    }
    for (const [projectId, members] of byProject) {
      members.sort((left, right) => left.node_id.localeCompare(right.node_id));
      const project = aliases.get(projectId) ?? 'Project';
      members.forEach((node, index) => labels.set(
        node.node_id,
        `${project} ${kind === 'snapshot' ? 'snapshot' : 'research session'} ${String(index + 1).padStart(2, '0')}`,
      ));
    }
  }
  const duplicateGroups = new Map<string, GraphNodeRecord[]>();
  for (const node of nodes) {
    const key = labels.get(node.node_id)!.toLowerCase();
    const bucket = duplicateGroups.get(key) ?? [];
    bucket.push(node);
    duplicateGroups.set(key, bucket);
  }
  for (const members of duplicateGroups.values()) {
    if (members.length < 2) continue;
    members.sort((left, right) => left.node_id.localeCompare(right.node_id));
    const used = new Set<string>();
    members.forEach((node, index) => {
      const base = labels.get(node.node_id)!;
      const definition = definedBy.get(node.node_id);
      const sourceContext = definition
        ? basename(sanitizeDisplayText(definition.label, aliases))
        : node.kind === 'directory' || node.kind === 'root'
          ? basename(sanitizeDisplayText(node.source_id ?? '', aliases))
          : aliases.get(node.project_id) ?? '';
      let label = sourceContext && sourceContext.toLowerCase() !== base.toLowerCase()
        ? `${base} · ${sourceContext}`
        : `${base} ${String(index + 1).padStart(2, '0')}`;
      let suffix = 2;
      while (used.has(label.toLowerCase())) label = `${base} ${suffix++}`;
      used.add(label.toLowerCase());
      labels.set(node.node_id, label);
    });
  }
  return labels;
}

function buildViewerGraph(
  projection: GraphProjection,
  analysis: GraphAnalysis,
  view: View,
  aliases: Map<string, string>,
): ViewerGraph {
  const allowed = view === 'graph' ? undefined : VIEW_KINDS[view];
  let sourceNodes = allowed
    ? projection.nodes.filter((node) => allowed.has(node.kind))
    : projection.nodes;
  const sourceIds = new Set(sourceNodes.map((node) => node.node_id));
  let sourceEdges = projection.edges.filter((edge) => (
    sourceIds.has(edge.source) && sourceIds.has(edge.target)
  ));
  if (view === 'ontology') {
    sourceEdges = sourceEdges.filter((edge) => ONTOLOGY_EDGE_TYPES.has(edge.type));
    const connected = new Set(sourceEdges.flatMap((edge) => [edge.source, edge.target]));
    sourceNodes = sourceNodes.filter((node) => connected.has(node.node_id));
  }
  const selectedNodes = selectNodes(view, sourceNodes, sourceEdges, analysis);
  const selectedIds = new Set(selectedNodes.map((node) => node.node_id));
  const degree = degreeMap(sourceEdges);
  const compare = compareNodes(view, analysis, degree);
  const nodeById = new Map(sourceNodes.map((node) => [node.node_id, node]));
  const edgeLimit = VIEW_LIMIT[view] * 6;
  const selectedEdges = sourceEdges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .sort((left, right) => (
      right.weight - left.weight
      || compare(nodeById.get(left.source)!, nodeById.get(right.source)!)
      || left.edge_id.localeCompare(right.edge_id)
    ))
    .slice(0, edgeLimit);
  const layout = view === 'graph'
    ? { positions: graphPositions(selectedNodes, analysis), labels: [] }
    : lanePositions(view, selectedNodes, analysis);
  const positions = layout.positions;
  const labels = viewerLabels(selectedNodes, selectedEdges, aliases);
  const anonymousIds = new Map(selectedNodes.map((node, index) => [
    node.node_id, `n${String(index + 1).padStart(4, '0')}`,
  ]));
  const ranks = selectedNodes.map((node) => analysis.pagerank?.[node.node_id] ?? 0);
  const minRank = Math.min(...ranks, 0);
  const maxRank = Math.max(...ranks, 0);
  const nodes = selectedNodes.map((node): ViewerNode => {
    const rank = analysis.pagerank?.[node.node_id] ?? 0;
    const normalized = maxRank === minRank ? 0.4 : (rank - minRank) / (maxRank - minRank);
    const position = positions.get(node.node_id)!;
    const url = publicUrl(node.url);
    return {
      id: anonymousIds.get(node.node_id)!,
      label: labels.get(node.node_id)!.slice(0, 160),
      kind: node.kind,
      project_id: aliases.get(node.project_id) ?? 'Shared',
      shared: !aliases.has(node.project_id),
      ...(url ? { url } : {}),
      pagerank: rank,
      community: analysis.community?.[node.node_id] ?? -1,
      degree: degree.get(node.node_id) ?? 0,
      x: position.x,
      y: position.y,
      size: 4 + Math.sqrt(normalized) * 8 + (node.kind === 'project' ? 5 : 0),
    };
  });
  return {
    view,
    lane_labels: layout.labels,
    nodes,
    edges: selectedEdges.map((edge, index) => ({
      id: `e${String(index + 1).padStart(4, '0')}`,
      source: anonymousIds.get(edge.source)!,
      target: anonymousIds.get(edge.target)!,
      type: edge.type,
      weight: edge.weight,
    })),
    source_node_count: sourceNodes.length,
    source_edge_count: sourceEdges.length,
    omitted_node_count: sourceNodes.length - nodes.length,
    omitted_edge_count: sourceEdges.length - selectedEdges.length,
  };
}

const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="__SURF_CSP__">
<title>Google Surf Knowledge Graph</title>
<style>
:root{color-scheme:dark;--bg:#0c0d0f;--surface:#141518;--surface2:#1b1d21;--line:#34373e;--text:#f4f3ef;--muted:#a8a8a2;--blue:#4da3ff;--green:#49d17d;--orange:#ff9f43;--pink:#f06aa8;--violet:#9277ff;--yellow:#f0c94d;--cyan:#3fd5d0;--red:#ff625f;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--bg);color:var(--text)}button,input{font:inherit;letter-spacing:0}.app{height:100%;display:grid;grid-template-rows:56px minmax(0,1fr)}header{display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--surface)}.brand{font-weight:600;white-space:nowrap}.tabs{display:flex;height:100%;align-items:stretch}.tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);padding:0 14px;cursor:pointer}.tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--cyan)}.search{margin-left:auto;position:relative;width:min(320px,32vw)}.search input{width:100%;height:34px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);padding:0 10px}.search input:focus{outline:2px solid var(--cyan);outline-offset:1px}.main{display:grid;grid-template-columns:210px minmax(0,1fr) 292px;min-height:0}.rail,.inspector{background:var(--surface);overflow:auto}.rail{border-right:1px solid var(--line);padding:14px}.inspector{border-left:1px solid var(--line);padding:16px}.eyebrow{color:var(--muted);font-size:11px;text-transform:uppercase;margin:0 0 10px}.stats{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:18px}.stats strong{color:var(--text);font-weight:500}.kind-list{display:grid;gap:5px}.kind-toggle{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--muted);padding:6px 4px;text-align:left;cursor:pointer}.kind-toggle[aria-pressed="true"]{color:var(--text)}.swatch{width:9px;height:9px;border-radius:50%;background:var(--color);flex:0 0 auto}.kind-count{margin-left:auto;font-size:11px;color:var(--muted)}.depth{margin-top:20px}.depth-row{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.depth input{width:100%;accent-color:var(--cyan)}.stage{position:relative;min-width:0;min-height:0;background:var(--bg)}canvas{display:block;width:100%;height:100%;cursor:grab}canvas.dragging{cursor:grabbing}.toolbar{position:absolute;left:12px;top:12px;display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--surface)}.stage.has-lanes .toolbar{top:44px}.tool{width:34px;height:32px;border:0;border-right:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}.tool:last-child{border-right:0}.tool:hover{background:var(--surface2)}.notice{position:absolute;left:14px;bottom:12px;color:var(--muted);font-size:11px;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:6px 8px;pointer-events:none}.inspector h1{font-size:18px;line-height:1.3;font-weight:600;margin:0 0 8px;overflow-wrap:anywhere}.meta{display:grid;grid-template-columns:82px 1fr;gap:7px 10px;font-size:12px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.meta dt{color:var(--muted)}.meta dd{margin:0;overflow-wrap:anywhere}.relations{margin-top:16px}.relation{padding:8px 0;border-bottom:1px solid var(--line);font-size:12px}.relation-type{color:var(--cyan);font-size:10px}.relation-label{color:var(--text);margin-top:3px;overflow-wrap:anywhere}.empty{color:var(--muted);font-size:13px;line-height:1.6}.source-link{display:inline-block;margin-top:14px;color:var(--cyan);text-decoration:none;font-size:12px}.source-link:hover{text-decoration:underline}.search-status{font-size:11px;color:var(--muted);margin-top:12px}.mobile-stats{display:none}
@media(max-width:850px){.app{grid-template-rows:auto minmax(0,1fr)}header{min-height:94px;align-content:center;flex-wrap:wrap;padding:9px 12px;gap:6px 10px}.brand{width:100%}.tabs{height:36px}.tab{padding:0 9px}.search{width:auto;flex:1;min-width:120px}.main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(360px,1fr) auto}.rail{display:none}.inspector{border-left:0;border-top:1px solid var(--line);max-height:210px}.stage.has-lanes .toolbar{top:12px}.mobile-stats{display:block;position:absolute;right:12px;top:12px;color:var(--muted);font-size:10px;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:5px 7px}.notice{max-width:calc(100% - 28px)}}
select{font:inherit;letter-spacing:0}.project-picker select{width:min(210px,20vw);height:34px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);padding:0 28px 0 9px}.project-picker select:focus{outline:2px solid var(--cyan);outline-offset:1px}.tool.export{width:44px;font-size:10px}@media(max-width:850px){header{min-height:136px}.project-picker{order:3}.project-picker select{width:min(210px,42vw)}.search{order:4}}
</style>
</head>
<body>
<div class="app">
<header><div class="brand">Knowledge graph</div><div class="tabs" role="tablist"><button class="tab" data-view="graph" role="tab">PKM</button><button class="tab" data-view="lineage" role="tab">Lineage</button><button class="tab" data-view="ontology" role="tab">Ontology</button></div><label class="project-picker"><span hidden>Project</span><select id="project" aria-label="Project"></select></label><label class="search"><span hidden>Search nodes</span><input id="search" type="search" placeholder="Search nodes"></label></header>
<div class="main"><aside class="rail"><p class="eyebrow">Projection</p><div class="stats" id="stats"></div><p class="eyebrow">Node types</p><div class="kind-list" id="kinds"></div><div class="depth"><div class="depth-row"><span>Local depth</span><strong id="depth-value">1</strong></div><input id="depth" type="range" min="1" max="3" value="1"></div><div class="search-status" id="search-status"></div></aside><main class="stage"><canvas id="graph"></canvas><div class="toolbar"><button class="tool" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><button class="tool" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><button class="tool" id="fit" aria-label="Fit graph" title="Fit graph">⌗</button><button class="tool export" id="download-png" aria-label="Download visible graph as PNG" title="Download visible graph as PNG">PNG</button><button class="tool export" id="download-json" aria-label="Download visible graph as JSON" title="Download visible graph as JSON">JSON</button></div><div class="mobile-stats" id="mobile-stats"></div><div class="notice" id="notice"></div></main><aside class="inspector" id="inspector"><div class="empty">Select a node to inspect its provenance and local graph.</div></aside></div>
</div>
<script nonce="__SURF_NONCE__">
const payload=__SURF_DATA__;
const palette=['#4da3ff','#49d17d','#ff9f43','#f06aa8','#9277ff','#f0c94d','#3fd5d0','#ff625f','#73b7ff','#72df9d','#ffb86f','#f58abd'];
const kindColors={project:'#4da3ff',root:'#a8a8a2',directory:'#777b84',source:'#f06aa8',document:'#ff9f43',plan:'#3fd5d0',experiment:'#9277ff',decision:'#ff625f',session:'#73b7ff',intent:'#49d17d',entity:'#f0c94d',assertion:'#49d17d',symbol:'#f06aa8',ontology:'#ff9f43',schema:'#3fd5d0',identity:'#f0c94d',evidence:'#ff9f43',snapshot:'#a8a8a2'};
const canvas=document.getElementById('graph');const ctx=canvas.getContext('2d');const stage=canvas.parentElement;const inspector=document.getElementById('inspector');const kinds=document.getElementById('kinds');const stats=document.getElementById('stats');const notice=document.getElementById('notice');const search=document.getElementById('search');const searchStatus=document.getElementById('search-status');const depth=document.getElementById('depth');const depthValue=document.getElementById('depth-value');const mobileStats=document.getElementById('mobile-stats');const projectSelect=document.getElementById('project');
let view=payload.initial_view;let graph=payload.views[view];let selected=null;let hovered=null;let selectedProject='all';let query='';let hiddenKinds=new Set();let camera={scale:1,tx:0,ty:0};let drag=null;let dimensions={width:1,height:1,dpr:1};let screenNodes=[];
function color(node){return view==='graph'?palette[Math.abs(node.community)%palette.length]:(kindColors[node.kind]||'#a8a8a2')}
function resize(){const box=stage.getBoundingClientRect();const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.max(1,Math.round(box.width*dpr));canvas.height=Math.max(1,Math.round(box.height*dpr));dimensions={width:box.width,height:box.height,dpr:dpr};draw()}
function graphPoint(node){const margin=54;const x=margin+node.x*Math.max(1,dimensions.width-margin*2);const y=margin+node.y*Math.max(1,dimensions.height-margin*2);return{x:(x+camera.tx)*camera.scale,y:(y+camera.ty)*camera.scale}}
function projectScope(){if(selectedProject==='all')return new Set(graph.nodes.map(function(node){return node.id}));const included=new Set(graph.nodes.filter(function(node){return node.project_id===selectedProject}).map(function(node){return node.id}));let changed=true;while(changed){changed=false;graph.edges.forEach(function(edge){const source=graph.nodeMap.get(edge.source);const target=graph.nodeMap.get(edge.target);if(included.has(edge.source)&&target&&target.shared&&!included.has(edge.target)){included.add(edge.target);changed=true}if(included.has(edge.target)&&source&&source.shared&&!included.has(edge.source)){included.add(edge.source);changed=true}})}return included}
function visibleNode(node,focus){return !hiddenKinds.has(node.kind)&&focus.has(node.id)}
function focusSet(scope){if(!selected||!scope.has(selected))return scope;const seen=new Set([selected]);let frontier=new Set([selected]);for(let level=0;level<Number(depth.value);level++){const next=new Set();graph.edges.forEach(function(edge){if(frontier.has(edge.source)&&scope.has(edge.target)&&!seen.has(edge.target)){seen.add(edge.target);next.add(edge.target)}if(frontier.has(edge.target)&&scope.has(edge.source)&&!seen.has(edge.source)){seen.add(edge.source);next.add(edge.source)}});frontier=next}return seen}
function edgeVisible(edge,focus){const source=graph.nodeMap.get(edge.source);const target=graph.nodeMap.get(edge.target);return source&&target&&!hiddenKinds.has(source.kind)&&!hiddenKinds.has(target.kind)&&focus.has(source.id)&&focus.has(target.id)}
function nodeShape(node,x,y,size){ctx.beginPath();if(['source','document','symbol','schema','ontology'].includes(node.kind)){ctx.roundRect(x-size,y-size,size*2,size*2,Math.min(4,size*.3))}else if(node.kind==='decision'){ctx.moveTo(x,y-size*1.2);ctx.lineTo(x+size*1.2,y);ctx.lineTo(x,y+size*1.2);ctx.lineTo(x-size*1.2,y);ctx.closePath()}else{ctx.arc(x,y,size,0,Math.PI*2)}}
function drawHulls(nodes){if(view!=='graph'||camera.scale<.7)return;const groups=new Map();nodes.forEach(function(item){const bucket=groups.get(item.node.community)||[];bucket.push(item);groups.set(item.node.community,bucket)});groups.forEach(function(items){if(items.length<3)return;let cx=0,cy=0;items.forEach(function(item){cx+=item.x;cy+=item.y});cx/=items.length;cy/=items.length;let radius=28;items.forEach(function(item){radius=Math.max(radius,Math.hypot(item.x-cx,item.y-cy)+18)});ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fillStyle=color(items[0].node)+'0d';ctx.strokeStyle=color(items[0].node)+'38';ctx.lineWidth=1;ctx.fill();ctx.stroke()})}
function drawLanes(){const labels=graph.lane_labels;if(!labels.length)return;const showLabels=dimensions.width>=700;ctx.font='600 10px Inter,system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='top';labels.forEach(function(label,index){const x=graphPoint({x:.08+.84*index/Math.max(1,labels.length-1),y:0}).x;ctx.strokeStyle='#34373e80';ctx.setLineDash([3,7]);ctx.beginPath();ctx.moveTo(x,showLabels?38:0);ctx.lineTo(x,dimensions.height-24);ctx.stroke();ctx.setLineDash([]);if(showLabels){ctx.fillStyle='#a8a8a2';ctx.fillText(label,x,16)}});if(view==='lineage'){const split=graphPoint({x:0,y:.62}).y;ctx.strokeStyle='#34373e99';ctx.setLineDash([4,8]);ctx.beginPath();ctx.moveTo(0,split);ctx.lineTo(dimensions.width,split);ctx.stroke();ctx.setLineDash([]);if(showLabels){ctx.textAlign='left';ctx.fillStyle='#a8a8a2';ctx.fillText('DATA LINEAGE',8,92);ctx.fillText('RESEARCH LINEAGE',8,split+12)}}ctx.textAlign='left';ctx.textBaseline='middle'}
function drawArrow(source,target,active){const angle=Math.atan2(target.y-source.y,target.x-source.x);const size=active?6:4;ctx.fillStyle=active?'#f4f3efb8':'#69707b80';ctx.beginPath();ctx.moveTo(target.x,target.y);ctx.lineTo(target.x-Math.cos(angle-.55)*size,target.y-Math.sin(angle-.55)*size);ctx.lineTo(target.x-Math.cos(angle+.55)*size,target.y-Math.sin(angle+.55)*size);ctx.closePath();ctx.fill()}
function draw(){if(!ctx)return;const dpr=dimensions.dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,dimensions.width,dimensions.height);ctx.fillStyle='#0c0d0f';ctx.fillRect(0,0,dimensions.width,dimensions.height);drawLanes();const scope=projectScope();const focus=focusSet(scope);screenNodes=graph.nodes.filter(function(node){return visibleNode(node,focus)}).map(function(node){const point=graphPoint(node);return{node:node,x:point.x,y:point.y,size:Math.max(3,node.size*Math.sqrt(camera.scale))}});drawHulls(screenNodes);ctx.lineWidth=.7;graph.edges.forEach(function(edge){if(!edgeVisible(edge,focus))return;const source=graphPoint(graph.nodeMap.get(edge.source));const target=graphPoint(graph.nodeMap.get(edge.target));const active=selected&&(edge.source===selected||edge.target===selected);ctx.strokeStyle=active?'#f4f3efb8':'#69707b4f';ctx.lineWidth=active?1.7:.65;ctx.beginPath();if(view==='graph'){const dx=target.x-source.x;const dy=target.y-source.y;const bend=Math.min(26,Math.hypot(dx,dy)*.08);ctx.moveTo(source.x,source.y);ctx.quadraticCurveTo((source.x+target.x)/2-dy/Math.max(1,Math.hypot(dx,dy))*bend,(source.y+target.y)/2+dx/Math.max(1,Math.hypot(dx,dy))*bend,target.x,target.y)}else{ctx.moveTo(source.x,source.y);ctx.lineTo(target.x,target.y)}ctx.stroke();if(view!=='graph')drawArrow(source,target,active)});screenNodes.forEach(function(item){const node=item.node;const active=node.id===selected;nodeShape(node,item.x,item.y,item.size+(active?3:0));ctx.fillStyle=color(node)+(active?'ff':'d9');ctx.fill();ctx.lineWidth=active?2.5:node.id===hovered?2:1;ctx.strokeStyle=active?'#f4f3ef':node.id===hovered?'#f4f3efb8':'#0c0d0f';ctx.stroke()});drawLabels(screenNodes);notice.textContent=selected?'Showing '+focus.size+' nodes within '+depth.value+' hop'+(depth.value==='1'?'':'s'):(selectedProject==='all'?'All projects':selectedProject)+' · '+scope.size+' nodes'}
function drawLabels(nodes){const occupied=[];const candidates=nodes.filter(function(item){return item.node.id===selected||item.node.id===hovered||(query&&item.node.label.toLowerCase().includes(query))||(view==='ontology'&&['ontology','schema'].includes(item.node.kind))||item.node.size>=9||camera.scale>1.45}).sort(function(a,b){return (b.node.id===selected)-(a.node.id===selected)||b.node.size-a.node.size||a.node.id.localeCompare(b.node.id)});ctx.font='500 11px Inter,system-ui,sans-serif';ctx.textBaseline='middle';candidates.forEach(function(item){const label=item.node.label.length>38?item.node.label.slice(0,36)+'…':item.node.label;const width=ctx.measureText(label).width;const x=item.x+item.size+5;const y=item.y;const box={x:x-2,y:y-8,w:width+4,h:16};if(item.node.id!==selected&&occupied.some(function(other){return box.x<other.x+other.w&&box.x+box.w>other.x&&box.y<other.y+other.h&&box.y+box.h>other.y}))return;occupied.push(box);ctx.fillStyle='#0c0d0fdb';ctx.fillRect(box.x,box.y,box.w,box.h);ctx.fillStyle=item.node.id===selected?'#f4f3ef':'#d5d4cf';ctx.fillText(label,x,y)})}
function hit(event){const box=canvas.getBoundingClientRect();const x=event.clientX-box.left;const y=event.clientY-box.top;let best=null;let distance=Infinity;screenNodes.forEach(function(item){const value=Math.hypot(x-item.x,y-item.y);if(value<Math.max(12,item.size+5)&&value<distance){distance=value;best=item.node.id}});return best}
function select(id){selected=id;renderInspector();draw()}
function renderInspector(){if(!selected){inspector.innerHTML='<div class="empty">Select a node to inspect its provenance and local graph.</div>';return}const node=graph.nodeMap.get(selected);if(!node){selected=null;renderInspector();return}const relations=graph.edges.filter(function(edge){return edge.source===selected||edge.target===selected}).slice(0,30);let html='<p class="eyebrow">'+escapeHtml(node.kind)+'</p><h1>'+escapeHtml(node.label)+'</h1><dl class="meta"><dt>Project</dt><dd>'+escapeHtml(node.project_id)+'</dd><dt>PageRank</dt><dd>'+node.pagerank.toExponential(3)+'</dd><dt>Community</dt><dd>'+node.community+'</dd><dt>Degree</dt><dd>'+node.degree+'</dd></dl><div class="relations"><p class="eyebrow">Relations</p>';if(!relations.length)html+='<div class="empty">No relation is present in this projection.</div>';relations.forEach(function(edge){const other=graph.nodeMap.get(edge.source===selected?edge.target:edge.source);html+='<div class="relation"><div class="relation-type">'+escapeHtml(edge.type)+'</div><div class="relation-label">'+escapeHtml(other?other.label:'Missing endpoint')+'</div></div>'});html+='</div>';const href=safeHref(node.url);if(href)html+='<a class="source-link" href="'+escapeAttribute(href)+'" target="_blank" rel="noreferrer">Open source</a>';inspector.innerHTML=html}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,function(char){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]})}
function escapeAttribute(value){return escapeHtml(value)}
function safeHref(value){if(!value)return'';try{const parsed=new URL(value);return parsed.protocol==='http:'||parsed.protocol==='https:'?parsed.href:''}catch{return''}}
function prepare(value){value.nodeMap=new Map(value.nodes.map(function(node){return[node.id,node]}));return value}
function renderKinds(){const scope=projectScope();const counts=new Map();graph.nodes.filter(function(node){return scope.has(node.id)}).forEach(function(node){counts.set(node.kind,(counts.get(node.kind)||0)+1)});kinds.innerHTML='';Array.from(counts).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0])}).forEach(function(entry){const button=document.createElement('button');button.className='kind-toggle';button.setAttribute('aria-pressed',hiddenKinds.has(entry[0])?'false':'true');button.innerHTML='<span class="swatch" style="--color:'+(kindColors[entry[0]]||'#a8a8a2')+'"></span><span>'+escapeHtml(entry[0])+'</span><span class="kind-count">'+entry[1]+'</span>';button.addEventListener('click',function(){if(hiddenKinds.has(entry[0]))hiddenKinds.delete(entry[0]);else hiddenKinds.add(entry[0]);renderKinds();draw()});kinds.appendChild(button)})}
function renderStats(){const scope=projectScope();const edgeCount=graph.edges.filter(function(edge){return scope.has(edge.source)&&scope.has(edge.target)}).length;stats.innerHTML='<strong>'+scope.size.toLocaleString()+'</strong> of '+graph.source_node_count.toLocaleString()+' nodes<br><strong>'+edgeCount.toLocaleString()+'</strong> of '+graph.source_edge_count.toLocaleString()+' relations';mobileStats.textContent=scope.size+' nodes · '+edgeCount+' edges';searchStatus.textContent=query?graph.nodes.filter(function(node){return scope.has(node.id)&&node.label.toLowerCase().includes(query)}).length+' matches':'Deterministic semantic projection'}
function renderProjects(){projectSelect.innerHTML='';[['all','All projects']].concat(payload.projects.map(function(project){return[project,project]})).forEach(function(entry){const option=document.createElement('option');option.value=entry[0];option.textContent=entry[1];projectSelect.appendChild(option)});projectSelect.value=selectedProject}
function setProject(next){selectedProject=payload.projects.includes(next)?next:'all';selected=null;hovered=null;camera={scale:1,tx:0,ty:0};projectSelect.value=selectedProject;renderKinds();renderStats();renderInspector();draw()}
function currentProjection(){const scope=projectScope();const focus=focusSet(scope);const nodes=graph.nodes.filter(function(node){return visibleNode(node,focus)});const ids=new Set(nodes.map(function(node){return node.id}));return{schema_version:'surf-visible-graph-v1',view:view,project:selectedProject==='all'?'All projects':selectedProject,lane_labels:graph.lane_labels,nodes:nodes,edges:graph.edges.filter(function(edge){return ids.has(edge.source)&&ids.has(edge.target)})}}
function filename(extension){return((selectedProject==='all'?'all-projects':selectedProject)+'-'+(view==='graph'?'pkm':view)).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')+'.'+extension}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.rel='noopener';document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url)},1000)}
function downloadPng(){draw();canvas.toBlob(function(blob){if(blob)downloadBlob(blob,filename('png'))},'image/png')}
function downloadJson(){downloadBlob(new Blob([JSON.stringify(currentProjection(),null,2)],{type:'application/json'}),filename('json'))}
function setView(next){view=next;graph=prepare(payload.views[view]);selected=null;hovered=null;hiddenKinds=new Set();query='';search.value='';camera={scale:1,tx:0,ty:0};stage.classList.toggle('has-lanes',view!=='graph');document.querySelectorAll('.tab').forEach(function(tab){tab.setAttribute('aria-selected',tab.dataset.view===view?'true':'false')});renderKinds();renderStats();renderInspector();draw()}
canvas.addEventListener('pointerdown',function(event){const id=hit(event);if(id){select(id);return}drag={x:event.clientX,y:event.clientY,tx:camera.tx,ty:camera.ty,moved:false};canvas.classList.add('dragging');canvas.setPointerCapture(event.pointerId)});canvas.addEventListener('pointermove',function(event){if(drag){drag.moved=drag.moved||Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>4;camera.tx=drag.tx+(event.clientX-drag.x)/camera.scale;camera.ty=drag.ty+(event.clientY-drag.y)/camera.scale;draw();return}const next=hit(event);if(next!==hovered){hovered=next;draw()}});canvas.addEventListener('pointerup',function(){if(drag&&!drag.moved)select(null);drag=null;canvas.classList.remove('dragging')});canvas.addEventListener('pointerleave',function(){hovered=null;draw()});canvas.addEventListener('wheel',function(event){event.preventDefault();const factor=event.deltaY<0?1.12:.89;camera.scale=Math.min(5,Math.max(.35,camera.scale*factor));draw()},{passive:false});
search.addEventListener('input',function(){query=search.value.trim().toLowerCase();renderStats();draw()});projectSelect.addEventListener('change',function(){setProject(projectSelect.value)});depth.addEventListener('input',function(){depthValue.textContent=depth.value;draw()});document.getElementById('zoom-in').addEventListener('click',function(){camera.scale=Math.min(5,camera.scale*1.25);draw()});document.getElementById('zoom-out').addEventListener('click',function(){camera.scale=Math.max(.35,camera.scale*.8);draw()});document.getElementById('fit').addEventListener('click',function(){camera={scale:1,tx:0,ty:0};selected=null;renderInspector();draw()});document.getElementById('download-png').addEventListener('click',downloadPng);document.getElementById('download-json').addEventListener('click',downloadJson);document.querySelectorAll('.tab').forEach(function(tab){tab.addEventListener('click',function(){setView(tab.dataset.view)})});
Object.keys(payload.views).forEach(function(key){prepare(payload.views[key])});renderProjects();new ResizeObserver(resize).observe(stage);setView(view);
</script>
</body>
</html>`;

export function exportInteractiveGraphVisualization(
  projection: GraphProjection,
  analysis: GraphAnalysis,
  initialView: View,
): InteractiveVisualizationExport {
  const aliases = projectAliases(projection);
  const views = {
    graph: buildViewerGraph(projection, analysis, 'graph', aliases),
    lineage: buildViewerGraph(projection, analysis, 'lineage', aliases),
    ontology: buildViewerGraph(projection, analysis, 'ontology', aliases),
  };
  const data = JSON.stringify({
    schema_version: 'surf-interactive-graph-v1',
    projects: [...aliases.values()],
    initial_view: initialView,
    views,
  }).replace(/</g, '\\u003c');
  const nonce = createHash('sha256').update(data).digest('base64');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`;
  const content = VIEWER_HTML
    .replace('__SURF_DATA__', data)
    .replaceAll('__SURF_NONCE__', nonce);
  return {
    content: content.replace('__SURF_CSP__', csp),
    node_count: views[initialView].nodes.length,
    edge_count: views[initialView].edges.length,
  };
}
