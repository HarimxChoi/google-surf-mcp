import type {
  GraphAnalysis, GraphEdgeRecord, GraphNodeRecord, GraphProjection,
} from './contracts.js';

export type GraphVisualizationFormat = 'dot' | 'd3' | 'html' | 'neo4j';
export type GraphVisualizationView = 'graph' | 'ontology' | 'lineage';

export interface GraphVisualizationExport {
  format: GraphVisualizationFormat;
  view: GraphVisualizationView;
  projection_id: string;
  project_ids: string[];
  node_count: number;
  edge_count: number;
  content: string;
}

export interface Neo4jVisualizationExport extends Omit<GraphVisualizationExport, 'content'> {
  files: Array<{ name: string; content: string }>;
}

const ONTOLOGY_KINDS = new Set<GraphNodeRecord['kind']>([
  'project', 'ontology', 'schema', 'entity', 'identity',
]);

const LINEAGE_KINDS = new Set<GraphNodeRecord['kind']>([
  'project', 'root', 'directory', 'source', 'document', 'snapshot', 'symbol',
  'evidence', 'assertion', 'session', 'intent', 'plan', 'experiment', 'decision',
]);

function selectGraph(
  projection: GraphProjection,
  view: GraphVisualizationView,
): { nodes: GraphNodeRecord[]; edges: GraphEdgeRecord[] } {
  const allowed = view === 'ontology' ? ONTOLOGY_KINDS
    : view === 'lineage' ? LINEAGE_KINDS
      : undefined;
  const nodes = allowed
    ? projection.nodes.filter((node) => allowed.has(node.kind))
    : projection.nodes;
  const ids = new Set(nodes.map((node) => node.node_id));
  const edges = projection.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges };
}

function dotValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function dotShape(kind: GraphNodeRecord['kind']): string {
  if (kind === 'ontology' || kind === 'schema') return 'hexagon';
  if (kind === 'identity') return 'diamond';
  if (kind === 'evidence') return 'note';
  if (kind === 'assertion') return 'ellipse';
  if (kind === 'project') return 'folder';
  return 'box';
}

function serializeDot(
  projection: GraphProjection,
  analysis: GraphAnalysis,
  nodes: GraphNodeRecord[],
  edges: GraphEdgeRecord[],
  view: GraphVisualizationView,
): string {
  const lines = [
    `digraph ${dotValue(projection.projection_id)} {`,
    `  graph [rankdir="LR", overlap="false", splines="true", view=${dotValue(view)}, source_hash=${dotValue(projection.source_hash)}];`,
    '  node [fontname="Arial", fontsize="10"];',
    '  edge [fontname="Arial", fontsize="9"];',
  ];
  for (const node of nodes) {
    const attributes = [
      `label=${dotValue(node.label)}`,
      `shape=${dotValue(dotShape(node.kind))}`,
      `kind=${dotValue(node.kind)}`,
      `project_id=${dotValue(node.project_id)}`,
    ];
    const rank = analysis.pagerank?.[node.node_id];
    const community = analysis.community?.[node.node_id];
    if (rank !== undefined) attributes.push(`pagerank=${dotValue(String(rank))}`);
    if (community !== undefined) attributes.push(`community=${dotValue(String(community))}`);
    lines.push(`  ${dotValue(node.node_id)} [${attributes.join(', ')}];`);
  }
  for (const edge of edges) {
    lines.push(
      `  ${dotValue(edge.source)} -> ${dotValue(edge.target)} [`
      + `label=${dotValue(edge.type)}, weight=${dotValue(String(edge.weight))}];`,
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function serializeD3(
  projection: GraphProjection,
  analysis: GraphAnalysis,
  nodes: GraphNodeRecord[],
  edges: GraphEdgeRecord[],
  view: GraphVisualizationView,
): string {
  return `${JSON.stringify({
    schema_version: 'surf-graph-visualization-v1',
    view,
    projection_id: projection.projection_id,
    source_hash: projection.source_hash,
    project_ids: projection.project_ids,
    analysis: {
      engine: analysis.engine,
      component_count: analysis.component_count,
      strongly_connected_component_count: analysis.strongly_connected_component_count,
      community_count: analysis.community_count,
    },
    nodes: nodes.map((node) => ({
      id: node.node_id,
      label: node.label,
      kind: node.kind,
      project_id: node.project_id,
      ...(node.source_id ? { source_id: node.source_id } : {}),
      ...(node.url ? { url: node.url } : {}),
      ...(analysis.pagerank?.[node.node_id] !== undefined
        ? { pagerank: analysis.pagerank[node.node_id] }
        : {}),
      ...(analysis.community?.[node.node_id] !== undefined
        ? { community: analysis.community[node.node_id] }
        : {}),
    })),
    links: edges.map((edge) => ({
      id: edge.edge_id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: edge.weight,
      ...(edge.evidence_ids?.length ? { evidence_ids: edge.evidence_ids } : {}),
    })),
  }, null, 2)}\n`;
}

function csvValue(value: string | number | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return String(value);
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/"/g, '""')}"`;
}

function csvRow(values: Array<string | number | undefined>): string {
  return values.map(csvValue).join(',');
}

function neo4jLabel(kind: GraphNodeRecord['kind']): string {
  return kind.split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('') || 'Node';
}

function neo4jRelationshipType(type: string): string {
  const value = type.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Z_]/.test(value) ? value || 'RELATED_TO' : `REL_${value || 'RELATED_TO'}`;
}

export function exportNeo4jVisualization(
  projection: GraphProjection,
  analysis: GraphAnalysis,
  view: GraphVisualizationView,
): Neo4jVisualizationExport {
  const { nodes, edges } = selectGraph(projection, view);
  const nodeLines = [
    ':ID(SurfNode),id,:LABEL,kind,project_id,label,source_id,url,pagerank:double,community:int',
    ...nodes.map((node) => csvRow([
      node.node_id,
      node.node_id,
      `SurfNode;${neo4jLabel(node.kind)}`,
      node.kind,
      node.project_id,
      node.label,
      node.source_id,
      node.url,
      analysis.pagerank?.[node.node_id],
      analysis.community?.[node.node_id],
    ])),
  ];
  const relationshipLines = [
    ':START_ID(SurfNode),:END_ID(SurfNode),:TYPE,edge_id,relation_type,project_id,weight:double,evidence_ids:string[]',
    ...edges.map((edge) => csvRow([
      edge.source,
      edge.target,
      neo4jRelationshipType(edge.type),
      edge.edge_id,
      edge.type,
      edge.project_id,
      edge.weight,
      edge.evidence_ids?.join(';'),
    ])),
  ];
  const constraints = [
    'CREATE CONSTRAINT surf_node_id IF NOT EXISTS',
    'FOR (node:SurfNode) REQUIRE node.id IS UNIQUE;',
    '',
  ].join('\n');
  const load = [
    "LOAD CSV WITH HEADERS FROM 'file:///nodes.csv' AS row",
    "MERGE (node:SurfNode {id: row['id:ID(SurfNode)']})",
    "SET node.kind = row.kind, node.project_id = row.project_id, node.label = row.label,",
    "    node.source_id = CASE row.source_id WHEN '' THEN null ELSE row.source_id END,",
    "    node.url = CASE row.url WHEN '' THEN null ELSE row.url END,",
    "    node.pagerank = CASE row['pagerank:double'] WHEN '' THEN null ELSE toFloat(row['pagerank:double']) END,",
    "    node.community = CASE row['community:int'] WHEN '' THEN null ELSE toInteger(row['community:int']) END;",
    '',
    "LOAD CSV WITH HEADERS FROM 'file:///relationships.csv' AS row",
    "MATCH (source:SurfNode {id: row[':START_ID(SurfNode)']})",
    "MATCH (target:SurfNode {id: row[':END_ID(SurfNode)']})",
    'MERGE (source)-[edge:SURF_RELATION {edge_id: row.edge_id}]->(target)',
    "SET edge.type = row.relation_type, edge.project_id = row.project_id,",
    "    edge.weight = toFloat(row['weight:double']),",
    "    edge.evidence_ids = CASE row['evidence_ids:string[]'] WHEN '' THEN [] ELSE split(row['evidence_ids:string[]'], ';') END;",
    '',
  ].join('\n');
  const manifest = `${JSON.stringify({
    schema_version: 'surf-neo4j-export-v1',
    view,
    projection_id: projection.projection_id,
    source_hash: projection.source_hash,
    project_ids: projection.project_ids,
    node_count: nodes.length,
    edge_count: edges.length,
    analysis: {
      engine: analysis.engine,
      component_count: analysis.component_count,
      strongly_connected_component_count: analysis.strongly_connected_component_count,
      community_count: analysis.community_count,
    },
  }, null, 2)}\n`;
  const instructions = [
    'Neo4j export from Google Surf',
    '',
    'Empty or new database:',
    'neo4j-admin database import full --nodes=nodes.csv --relationships=relationships.csv neo4j',
    '',
    'Existing local database:',
    '1. Copy nodes.csv and relationships.csv into the Neo4j import directory.',
    '2. Run constraints.cypher with cypher-shell.',
    '3. Run load.cypher with cypher-shell.',
    '',
    'The online loader uses SurfNode and SURF_RELATION while preserving original kinds and relation types as properties.',
    '',
  ].join('\n');
  return {
    format: 'neo4j',
    view,
    projection_id: projection.projection_id,
    project_ids: projection.project_ids,
    node_count: nodes.length,
    edge_count: edges.length,
    files: [
      { name: 'nodes.csv', content: `${nodeLines.join('\n')}\n` },
      { name: 'relationships.csv', content: `${relationshipLines.join('\n')}\n` },
      { name: 'constraints.cypher', content: constraints },
      { name: 'load.cypher', content: load },
      { name: 'manifest.json', content: manifest },
      { name: 'README.txt', content: instructions },
    ],
  };
}

export function exportGraphVisualization(
  projection: GraphProjection,
  analysis: GraphAnalysis,
  format: GraphVisualizationFormat,
  view: GraphVisualizationView,
): GraphVisualizationExport {
  if (format === 'neo4j' || format === 'html') {
    throw new Error(`use the dedicated ${format} exporter`);
  }
  const { nodes, edges } = selectGraph(projection, view);
  return {
    format,
    view,
    projection_id: projection.projection_id,
    project_ids: projection.project_ids,
    node_count: nodes.length,
    edge_count: edges.length,
    content: format === 'dot'
      ? serializeDot(projection, analysis, nodes, edges, view)
      : serializeD3(projection, analysis, nodes, edges, view),
  };
}
