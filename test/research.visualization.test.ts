import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import type { GraphAnalysis, GraphProjection } from '../src/research/contracts.js';
import { exportInteractiveGraphVisualization } from '../src/research/interactiveVisualization.js';
import {
  exportGraphVisualization, exportNeo4jVisualization,
} from '../src/research/visualization.js';

const projection: GraphProjection = {
  projection_id: 'graph-export-test',
  schema_version: 'graph-v3',
  source_hash: 'source-export-test',
  source_versions: { alpha: 'v1' },
  project_ids: ['alpha'],
  nodes: [
    {
      node_id: 'project:alpha', project_id: 'alpha', kind: 'project', label: 'Alpha',
    },
    {
      node_id: 'ontology:paper', project_id: 'alpha', kind: 'ontology', label: 'Paper',
      text: 'entity_type v1',
    },
    {
      node_id: 'schema:paper', project_id: 'shared', kind: 'schema', label: 'paper',
    },
    {
      node_id: 'document:one', project_id: 'alpha', kind: 'document', label: 'Quoted "paper"',
      text: 'body must not be exported', url: 'https://example.test/paper',
    },
  ],
  edges: [
    {
      edge_id: 'edge:ontology', project_id: 'alpha', source: 'ontology:paper',
      target: 'schema:paper', type: 'ALIGNS_TO_SCHEMA', weight: 2,
    },
    {
      edge_id: 'edge:document', project_id: 'alpha', source: 'project:alpha',
      target: 'document:one', type: 'HAS_DOCUMENT', weight: 1,
    },
  ],
};

const analysis: GraphAnalysis = {
  engine: 'graphology',
  node_count: 4,
  edge_count: 2,
  component_count: 2,
  community_count: 2,
  pagerank: { 'ontology:paper': 0.25 },
  community: { 'ontology:paper': 1 },
  elapsed_ms: 1,
};

describe('graph visualization export', () => {
  it('exports an ontology-only D3 graph without node bodies', () => {
    const result = exportGraphVisualization(projection, analysis, 'd3', 'ontology');
    const document = JSON.parse(result.content) as Record<string, any>;

    expect(result.node_count).toBe(3);
    expect(result.edge_count).toBe(1);
    expect(document.view).toBe('ontology');
    expect(document.nodes.find((node: any) => node.id === 'ontology:paper')).toMatchObject({
      pagerank: 0.25,
      community: 1,
    });
    expect(document.nodes.every((node: any) => !('text' in node))).toBe(true);
  });

  it('escapes labels in Graphviz DOT', () => {
    const result = exportGraphVisualization(projection, analysis, 'dot', 'graph');

    expect(result.content).toContain('digraph "graph-export-test"');
    expect(result.content).toContain('label="Quoted \\"paper\\""');
    expect(result.content).not.toContain('body must not be exported');
  });

  it('exports a deterministic standalone explorer without node bodies', () => {
    const result = exportInteractiveGraphVisualization(projection, analysis, 'graph');
    const repeated = exportInteractiveGraphVisualization(projection, analysis, 'graph');

    expect(result.content).toBe(repeated.content);
    expect(result.content).toContain('surf-interactive-graph-v1');
    expect(result.content).toContain('>PKM</button>');
    expect(result.content).toContain('>Lineage</button>');
    expect(result.content).toContain('>Ontology</button>');
    expect(result.content).toContain('<select id="project"');
    expect(result.content).toContain('id="download-png"');
    expect(result.content).toContain('id="download-json"');
    expect(result.content).toContain("script-src 'nonce-");
    expect(result.content).not.toContain("script-src 'unsafe-inline'");
    expect(result.content).toContain('Quoted \\"paper\\"');
    expect(result.content).toContain('Paper · type / relation');
    expect(result.content).toContain('paper · shared schema');
    expect(result.content).not.toContain('body must not be exported');
    expect(result.node_count).toBe(4);
    expect(result.edge_count).toBe(2);
  });

  it('bounds a large interactive graph and keeps selected nodes connected', () => {
    const kinds = ['source', 'symbol', 'entity', 'directory', 'experiment'] as const;
    const nodes = Array.from({ length: 360 }, (_, index) => ({
      node_id: `node:${index}`,
      project_id: 'large',
      kind: kinds[index % kinds.length],
      label: `Node ${index}`,
    }));
    const largeProjection: GraphProjection = {
      ...projection,
      projection_id: 'large-graph',
      project_ids: ['large'],
      nodes: [{
        node_id: 'project:large', project_id: 'large', kind: 'project', label: 'Large',
      }, ...nodes],
      edges: nodes.map((node, index) => ({
        edge_id: `edge:${index}`,
        project_id: 'large',
        source: index === 0 ? 'project:large' : nodes[index - 1].node_id,
        target: node.node_id,
        type: 'LINKS',
        weight: 1,
      })),
    };
    const largeAnalysis: GraphAnalysis = {
      ...analysis,
      node_count: largeProjection.nodes.length,
      edge_count: largeProjection.edges.length,
      pagerank: Object.fromEntries(largeProjection.nodes.map((node, index) => [
        node.node_id, 1 / (index + 1),
      ])),
      community: Object.fromEntries(largeProjection.nodes.map((node, index) => [
        node.node_id, index % 12,
      ])),
    };
    const result = exportInteractiveGraphVisualization(largeProjection, largeAnalysis, 'graph');
    const match = result.content.match(/const payload=(.*);\nconst palette=/);
    const payload = JSON.parse(match![1]) as Record<string, any>;
    const graph = payload.views.graph as Record<string, any>;
    const connected = new Set(graph.edges.flatMap((edge: any) => [edge.source, edge.target]));

    expect(result.node_count).toBeLessThanOrEqual(240);
    expect(graph.source_node_count).toBe(361);
    expect(graph.omitted_node_count).toBe(361 - result.node_count);
    expect(graph.nodes.every((node: any) => connected.has(node.id))).toBe(true);
  });

  it('removes private identifiers and disambiguates duplicate display labels', () => {
    const privateProjection: GraphProjection = {
      ...projection,
      projection_id: 'private-graph',
      project_ids: ['baubrowser-warpquant'],
      nodes: [
        {
          node_id: 'project:baubrowser-warpquant',
          project_id: 'baubrowser-warpquant',
          kind: 'project',
          label: 'BauBrowser WarpQuant',
          source_id: 'baubrowser-warpquant',
        },
        {
          node_id: 'source:one', project_id: 'baubrowser-warpquant', kind: 'source',
          label: 'C:\\Users\\harim\\repo\\first.ts', source_id: 'private-source-one',
          url: 'surf://projects/baubrowser-warpquant/files/private-source-one',
        },
        {
          node_id: 'source:two', project_id: 'baubrowser-warpquant', kind: 'source',
          label: '2.harim.choi@gmail.com second.ts', source_id: 'private-source-two',
        },
        {
          node_id: 'symbol:one', project_id: 'baubrowser-warpquant', kind: 'symbol',
          label: 'main', source_id: 'private-symbol-one',
        },
        {
          node_id: 'symbol:two', project_id: 'baubrowser-warpquant', kind: 'symbol',
          label: 'main', source_id: 'private-symbol-two',
        },
      ],
      edges: [
        {
          edge_id: 'edge:one', project_id: 'baubrowser-warpquant',
          source: 'project:baubrowser-warpquant', target: 'source:one', type: 'CONTAINS', weight: 1,
        },
        {
          edge_id: 'edge:two', project_id: 'baubrowser-warpquant',
          source: 'project:baubrowser-warpquant', target: 'source:two', type: 'CONTAINS', weight: 1,
        },
        {
          edge_id: 'edge:three', project_id: 'baubrowser-warpquant',
          source: 'source:one', target: 'symbol:one', type: 'DEFINES', weight: 2,
        },
        {
          edge_id: 'edge:four', project_id: 'baubrowser-warpquant',
          source: 'source:two', target: 'symbol:two', type: 'DEFINES', weight: 2,
        },
      ],
    };
    const privateAnalysis: GraphAnalysis = {
      ...analysis,
      node_count: privateProjection.nodes.length,
      edge_count: privateProjection.edges.length,
    };
    const result = exportInteractiveGraphVisualization(privateProjection, privateAnalysis, 'graph');
    const match = result.content.match(/const payload=(.*);\nconst palette=/);
    const payload = JSON.parse(match![1]) as Record<string, any>;
    const labels = payload.views.graph.nodes.map((node: any) => node.label);
    const lower = result.content.toLowerCase();

    expect(payload.projects).toEqual(['WarpQuant']);
    expect(payload.views.graph.nodes.every((node: any) => /^n\d{4}$/.test(node.id))).toBe(true);
    expect(payload.views.graph.edges.every((edge: any) => /^e\d{4}$/.test(edge.id))).toBe(true);
    expect(payload.views.graph.nodes.every((node: any) => !('source_id' in node))).toBe(true);
    expect(payload.views.graph.nodes.every((node: any) => typeof node.shared === 'boolean')).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    expect(lower).not.toContain('baubrowser');
    expect(lower).not.toContain('harim');
    expect(lower).not.toContain('gmail.com');
    expect(lower).not.toContain('private-source');
  });

  it('filters projects, clears focus, downloads visible views, and binds the script CSP', () => {
    const result = exportInteractiveGraphVisualization(projection, analysis, 'graph');
    const payloadText = result.content.match(/const payload=(.*);\nconst palette=/)![1];
    const nonce = result.content.match(/<script nonce="([^"]+)/)![1];
    const csp = result.content.match(/Content-Security-Policy" content="([^"]+)/)![1];
    const expectedNonce = createHash('sha256').update(payloadText).digest('base64');
    const downloads: string[] = [];
    const context = new Proxy({
      measureText: (value: string) => ({ width: value.length * 6 }),
    } as Record<string, unknown>, {
      get: (target, property) => property in target ? target[property as string] : () => undefined,
      set: (target, property, value) => {
        target[property as string] = value;
        return true;
      },
    });
    const dom = new JSDOM(result.content, {
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
          value: () => ({
            x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700,
            width: 1000, height: 700, toJSON: () => ({}),
          }),
        });
        Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
          value: () => context,
        });
        Object.defineProperty(window.HTMLCanvasElement.prototype, 'toBlob', {
          value: (callback: BlobCallback) => callback(new window.Blob(['png'], { type: 'image/png' })),
        });
        Object.defineProperty(window.HTMLCanvasElement.prototype, 'setPointerCapture', {
          value: () => undefined,
        });
        Object.defineProperty(window, 'ResizeObserver', {
          value: class {
            constructor(private readonly callback: ResizeObserverCallback) {}
            observe(): void { this.callback([], this as unknown as ResizeObserver); }
          },
        });
        Object.defineProperty(window.URL, 'createObjectURL', {
          value: (blob: Blob) => `blob:${blob.type}`,
        });
        Object.defineProperty(window.URL, 'revokeObjectURL', { value: () => undefined });
        Object.defineProperty(window.HTMLAnchorElement.prototype, 'click', {
          value() { downloads.push(this.download); },
        });
      },
    });
    const document = dom.window.document;
    const project = document.querySelector<HTMLSelectElement>('#project')!;
    const canvas = document.querySelector<HTMLCanvasElement>('#graph')!;
    const firstNode = JSON.parse(result.content.match(/const payload=(.*);\nconst palette=/)![1])
      .views.graph.nodes[0];

    expect(nonce).toBe(expectedNonce);
    expect(csp).toContain(`script-src 'nonce-${expectedNonce}'`);
    expect([...project.options].map((option) => option.text)).toEqual(['All projects', 'Alpha']);
    project.value = 'Alpha';
    project.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(document.querySelector('#notice')!.textContent).toContain('Alpha');

    const x = 54 + firstNode.x * 892;
    const y = 54 + firstNode.y * 592;
    canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: x, clientY: y }));
    expect(document.querySelector('#inspector h1')).not.toBeNull();
    canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 999, clientY: 699 }));
    canvas.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 999, clientY: 699 }));
    expect(document.querySelector('#inspector')!.textContent).toContain('Select a node');

    document.querySelector<HTMLButtonElement>('[data-view="ontology"]')!.click();
    document.querySelector<HTMLButtonElement>('#download-json')!.click();
    document.querySelector<HTMLButtonElement>('#download-png')!.click();
    expect(downloads).toEqual(['alpha-ontology.json', 'alpha-ontology.png']);
    dom.window.close();
  });

  it('exports an import-ready Neo4j bundle', () => {
    const result = exportNeo4jVisualization(projection, analysis, 'graph');
    const files = new Map(result.files.map((file) => [file.name, file.content]));

    expect([...files.keys()]).toEqual([
      'nodes.csv', 'relationships.csv', 'constraints.cypher',
      'load.cypher', 'manifest.json', 'README.txt',
    ]);
    expect(files.get('nodes.csv')).toContain(':ID(SurfNode),id,:LABEL');
    expect(files.get('nodes.csv')).toContain('SurfNode;Document');
    expect(files.get('nodes.csv')).not.toContain('body must not be exported');
    expect(files.get('relationships.csv')).toContain(':TYPE,edge_id,relation_type');
    expect(files.get('relationships.csv')).toContain('ALIGNS_TO_SCHEMA');
    expect(files.get('constraints.cypher')).toContain('REQUIRE node.id IS UNIQUE');
    expect(files.get('load.cypher')).toContain('SURF_RELATION');
    expect(JSON.parse(files.get('manifest.json')!)).toMatchObject({
      schema_version: 'surf-neo4j-export-v1',
      projection_id: 'graph-export-test',
      node_count: 4,
      edge_count: 2,
    });
  });
});
