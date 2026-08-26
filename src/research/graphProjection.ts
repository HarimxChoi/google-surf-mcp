import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  AssertionRecord, CodeRelationRecord, CodeSymbolRecord, DecisionRecord, EntityAliasRecord,
  EntityRecord, EvidenceRecord, ExperimentRunRecord, GraphEdgeRecord, GraphNodeRecord, GraphProjection,
  IntentRevisionRecord, MemorySessionRecord,
  OntologyTermRecord, PlanRevisionRecord, ProjectDocumentRecord, ProjectRecord,
  ProjectSourceEntryRecord, ProjectSourceSnapshot,
} from './contracts.js';
import { normalizeEntityName } from './entities.js';

export interface ProjectGraphSource {
  project: ProjectRecord;
  source_snapshots?: ProjectSourceSnapshot[];
  source_entries: ProjectSourceEntryRecord[];
  documents: ProjectDocumentRecord[];
  plans: PlanRevisionRecord[];
  experiments: ExperimentRunRecord[];
  decisions: DecisionRecord[];
  sessions: MemorySessionRecord[];
  intents: IntentRevisionRecord[];
  entities: EntityRecord[];
  aliases?: EntityAliasRecord[];
  ontology_terms?: OntologyTermRecord[];
  evidence?: EvidenceRecord[];
  assertions: AssertionRecord[];
  symbols: CodeSymbolRecord[];
  code_relations: CodeRelationRecord[];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function graphId(kind: string, projectId: string, sourceId: string): string {
  return `${kind}:${projectId}:${hash(sourceId)}`;
}

interface SchemaIndex {
  term_keys: Map<string, string>;
  label_keys: Map<string, string>;
}

function termLabels(term: OntologyTermRecord): string[] {
  return [...new Set([term.name, ...term.aliases].map(normalizeEntityName).filter(Boolean))];
}

function buildSchemaIndex(terms: OntologyTermRecord[]): SchemaIndex {
  const active = terms.filter((term) => term.status === 'active');
  const parent = new Map(active.map((term) => [term.term_id, term.term_id]));
  const find = (termId: string): string => {
    const current = parent.get(termId)!;
    if (current === termId) return current;
    const root = find(current);
    parent.set(termId, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  };
  const owners = new Map<string, string>();
  for (const term of active) {
    for (const label of termLabels(term)) {
      const key = `${term.kind}\0${label}`;
      const owner = owners.get(key);
      if (owner) union(term.term_id, owner);
      else owners.set(key, term.term_id);
    }
  }
  const componentLabels = new Map<string, Set<string>>();
  const componentTerms = new Map<string, OntologyTermRecord[]>();
  for (const term of active) {
    const root = find(term.term_id);
    const labels = componentLabels.get(root) ?? new Set<string>();
    for (const label of termLabels(term)) labels.add(label);
    componentLabels.set(root, labels);
    const members = componentTerms.get(root) ?? [];
    members.push(term);
    componentTerms.set(root, members);
  }
  const termKeys = new Map<string, string>();
  const labelKeys = new Map<string, string>();
  for (const [root, members] of componentTerms) {
    const ordered = [...members].sort((a, b) => Number(Boolean(a.project_id)) - Number(Boolean(b.project_id))
      || b.version - a.version || a.name.localeCompare(b.name));
    const representative = ordered[0];
    const key = `${representative.kind}:${normalizeEntityName(representative.name)}`;
    for (const term of members) termKeys.set(term.term_id, key);
    for (const label of componentLabels.get(root)!) {
      labelKeys.set(`${representative.kind}\0${label}`, key);
    }
  }
  return { term_keys: termKeys, label_keys: labelKeys };
}

function stableIdentityAliases(entity: EntityRecord, aliases: EntityAliasRecord[]): EntityAliasRecord[] {
  return aliases.filter((alias) => {
    if (alias.status !== 'active') return false;
    if (alias.source === 'explicit') return true;
    const raw = alias.alias.trim();
    if (/^https?:\/\//i.test(raw)) return true;
    if (/^(?:doi:|arxiv:|pmid:|pmcid:|s2:|scholar:|github:|10\.\d{4,9}\/)/i.test(raw)) return true;
    return alias.normalized_alias !== entity.normalized_name
      && !/\s/.test(raw) && raw.length >= 8;
  });
}

export function buildGraphProjection(sources: ProjectGraphSource[]): GraphProjection {
  const nodes = new Map<string, GraphNodeRecord>();
  const edges = new Map<string, GraphEdgeRecord>();
  const linkedEntities: Array<{
    project_id: string;
    node_id: string;
    entity: EntityRecord;
    aliases: EntityAliasRecord[];
    schema_key: string;
  }> = [];
  const addNode = (node: GraphNodeRecord): void => {
    if (!nodes.has(node.node_id)) nodes.set(node.node_id, node);
  };
  const addEdge = (
    projectId: string,
    source: string,
    target: string,
    type: string,
    weight = 1,
    evidenceIds?: string[],
  ): void => {
    const edgeId = hash(`${projectId}\0${source}\0${target}\0${type}`);
    if (!edges.has(edgeId)) {
      edges.set(edgeId, {
        edge_id: edgeId,
        project_id: projectId,
        source,
        target,
        type,
        weight,
        ...(evidenceIds?.length ? { evidence_ids: evidenceIds } : {}),
      });
    }
  };

  const ontologyTerms = [...new Map(sources.flatMap((source) => source.ontology_terms ?? [])
    .map((term) => [term.term_id, term])).values()];
  const schemaIndex = buildSchemaIndex(ontologyTerms);
  const schemaNodes = new Map<string, string>();
  const ensureSchemaNode = (schemaKey: string): string => {
    const existing = schemaNodes.get(schemaKey);
    if (existing) return existing;
    const node = graphId('schema', 'shared', schemaKey);
    schemaNodes.set(schemaKey, node);
    addNode({
      node_id: node,
      project_id: 'shared',
      kind: 'schema',
      label: schemaKey.slice(schemaKey.indexOf(':') + 1),
      source_id: schemaKey,
    });
    return node;
  };
  const ontologyNodes = new Map<string, string>();
  for (const term of ontologyTerms) {
    const scope = term.project_id ?? 'core';
    const node = graphId('ontology', scope, term.term_id);
    ontologyNodes.set(term.term_id, node);
    addNode({
      node_id: node,
      project_id: scope,
      kind: 'ontology',
      label: term.name,
      text: `${term.kind} v${term.version}`,
      source_id: term.term_id,
    });
    const schemaKey = schemaIndex.term_keys.get(term.term_id)
      ?? `${term.kind}:${normalizeEntityName(term.name)}`;
    addEdge(scope, node, ensureSchemaNode(schemaKey), 'ALIGNS_TO_SCHEMA', 2);
  }
  for (const term of ontologyTerms) {
    const node = ontologyNodes.get(term.term_id)!;
    const prior = term.supersedes_term_id
      ? ontologyNodes.get(term.supersedes_term_id)
      : undefined;
    if (prior) addEdge(term.project_id ?? 'core', node, prior, 'SUPERSEDES_TERM', 2);
  }
  const addInstanceOf = (projectId: string, node: string, type: string): void => {
    const schemaKey = schemaIndex.label_keys.get(`entity_type\0${normalizeEntityName(type)}`);
    if (schemaKey) addEdge(projectId, node, ensureSchemaNode(schemaKey), 'INSTANCE_OF', 2);
  };

  for (const source of sources) {
    const projectId = source.project.project_id;
    const projectNode = graphId('project', projectId, projectId);
    addNode({
      node_id: projectNode,
      project_id: projectId,
      kind: 'project',
      label: source.project.name,
      source_id: projectId,
    });
    addInstanceOf(projectId, projectNode, 'project');
    for (const term of source.ontology_terms ?? []) {
      const termNode = ontologyNodes.get(term.term_id);
      if (termNode && term.status === 'active') {
        addEdge(projectId, projectNode, termNode, 'USES_ONTOLOGY', 1.5);
      }
    }

    const snapshotNodes = new Map<string, string>();
    for (const snapshot of source.source_snapshots ?? []) {
      const node = graphId('snapshot', projectId, snapshot.snapshot_id);
      snapshotNodes.set(snapshot.snapshot_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'snapshot',
        label: snapshot.snapshot_id.slice(0, 12),
        text: `${snapshot.policy} ${snapshot.inventory_digest}`,
        source_id: snapshot.snapshot_id,
      });
      addInstanceOf(projectId, node, 'source_snapshot');
      addEdge(projectId, projectNode, node, 'HAS_SOURCE_SNAPSHOT', 1.5);
    }
    for (const snapshot of source.source_snapshots ?? []) {
      const node = snapshotNodes.get(snapshot.snapshot_id)!;
      const parent = snapshot.parent_snapshot_id
        ? snapshotNodes.get(snapshot.parent_snapshot_id)
        : undefined;
      if (parent) addEdge(projectId, node, parent, 'SUPERSEDES_SNAPSHOT', 2);
    }

    const sourceNodes = new Map<string, string>();
    for (const entry of source.source_entries) {
      const rootNode = graphId('root', projectId, entry.root);
      addNode({
        node_id: rootNode,
        project_id: projectId,
        kind: 'root',
        label: entry.root,
        source_id: entry.root,
      });
      addInstanceOf(projectId, rootNode, 'directory');
      addEdge(projectId, projectNode, rootNode, 'CONTAINS', 1);
      const parts = entry.path.replace(/\\/g, '/').split('/').filter(Boolean);
      let parent = rootNode;
      for (let index = 0; index < parts.length - 1; index++) {
        const directoryPath = parts.slice(0, index + 1).join('/');
        const directoryNode = graphId('directory', projectId, `${entry.root}/${directoryPath}`);
        addNode({
          node_id: directoryNode,
          project_id: projectId,
          kind: 'directory',
          label: parts[index],
          source_id: `${entry.root}/${directoryPath}`,
        });
        addInstanceOf(projectId, directoryNode, 'directory');
        addEdge(projectId, parent, directoryNode, 'CONTAINS', 1);
        parent = directoryNode;
      }
      const sourceNode = graphId('source', projectId, entry.entry_id);
      sourceNodes.set(entry.entry_id, sourceNode);
      addNode({
        node_id: sourceNode,
        project_id: projectId,
        kind: 'source',
        label: `${entry.root}/${entry.path}`,
        text: [entry.kind, entry.experiment_key].filter(Boolean).join(' '),
        url: `surf://projects/${projectId}/files/${entry.entry_id}`,
        source_id: entry.entry_id,
      });
      addInstanceOf(projectId, sourceNode, 'source_file');
      addEdge(projectId, parent, sourceNode, 'CONTAINS', 1);
      const snapshot = snapshotNodes.get(
        entry.updated_snapshot_id ?? source.project.active_source_snapshot_id ?? '',
      );
      if (snapshot) addEdge(projectId, snapshot, sourceNode, 'CONTAINS_ENTRY', 2);
      if (entry.experiment_key) {
        const experimentNode = graphId('experiment', projectId, `group:${entry.experiment_key}`);
        addNode({
          node_id: experimentNode,
          project_id: projectId,
          kind: 'experiment',
          label: posix.basename(entry.experiment_key),
          source_id: entry.experiment_key,
        });
        addInstanceOf(projectId, experimentNode, 'experiment');
        addEdge(projectId, sourceNode, experimentNode, 'PART_OF_EXPERIMENT', 1.5);
      }
    }

    const symbolNodes = new Map<string, string>();
    for (const symbol of source.symbols) {
      const node = graphId('symbol', projectId, symbol.symbol_id);
      symbolNodes.set(symbol.symbol_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'symbol',
        label: symbol.name,
        text: `${symbol.language} ${symbol.kind}`,
        source_id: symbol.symbol_id,
      });
      addInstanceOf(projectId, node, 'code_symbol');
      const file = sourceNodes.get(symbol.source_entry_id);
      if (file) addEdge(projectId, file, node, 'DEFINES', 2);
    }
    for (const relation of source.code_relations) {
      const from = relation.source_symbol_id
        ? symbolNodes.get(relation.source_symbol_id)
        : sourceNodes.get(relation.source_entry_id);
      if (!from) continue;
      let target = relation.target_symbol_id
        ? symbolNodes.get(relation.target_symbol_id)
        : undefined;
      if (!target) {
        target = graphId('entity', projectId, `code:${relation.target_name}`);
        addNode({
          node_id: target,
          project_id: projectId,
          kind: 'entity',
          label: relation.target_name,
          source_id: relation.target_name,
        });
        addInstanceOf(projectId, target, 'code_dependency');
      }
      addEdge(projectId, from, target, relation.kind.toUpperCase(), relation.confidence);
    }

    const documentNodes = new Map<string, string>();
    for (const document of source.documents) {
      const node = graphId('document', projectId, document.document_id);
      documentNodes.set(document.document_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'document',
        label: document.title,
        text: document.text,
        url: document.url,
        source_id: document.document_id,
      });
      addInstanceOf(projectId, node, 'document');
      addEdge(projectId, projectNode, node, 'HAS_DOCUMENT', 1);
    }

    const planNodes = new Map<string, string>();
    for (const plan of source.plans) {
      const node = graphId('plan', projectId, plan.plan_revision_id);
      planNodes.set(plan.plan_revision_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'plan',
        label: plan.title,
        text: plan.body,
        source_id: plan.plan_revision_id,
      });
      addInstanceOf(projectId, node, 'plan');
      addEdge(projectId, projectNode, node, 'HAS_PLAN', 1.5);
      if (plan.parent_revision_id) {
        addEdge(projectId, node, graphId('plan', projectId, plan.parent_revision_id), 'SUPERSEDES', 2);
      }
    }

    const experimentNodes = new Map<string, string>();
    for (const experiment of source.experiments) {
      const node = graphId('experiment', projectId, experiment.experiment_id);
      experimentNodes.set(experiment.experiment_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'experiment',
        label: experiment.name,
        text: `${experiment.hypothesis} ${experiment.summary ?? ''}`,
        source_id: experiment.experiment_id,
      });
      addInstanceOf(projectId, node, 'experiment');
      addEdge(projectId, projectNode, node, 'HAS_EXPERIMENT', 1.5);
      const plan = planNodes.get(experiment.plan_revision_id);
      if (plan) addEdge(projectId, node, plan, 'USES_PLAN', 2);
    }

    for (const plan of source.plans) {
      if (plan.based_on_experiment_id) {
        const experiment = experimentNodes.get(plan.based_on_experiment_id);
        const node = planNodes.get(plan.plan_revision_id);
        if (experiment && node) addEdge(projectId, node, experiment, 'BASED_ON', 2);
      }
    }

    const decisionNodes = new Map<string, string>();
    for (const decision of source.decisions) {
      const node = graphId('decision', projectId, decision.decision_id);
      decisionNodes.set(decision.decision_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'decision',
        label: decision.title,
        text: decision.summary,
        source_id: decision.decision_id,
      });
      addInstanceOf(projectId, node, 'decision');
      addEdge(projectId, projectNode, node, 'HAS_DECISION', 1.5);
      if (decision.plan_revision_id && planNodes.has(decision.plan_revision_id)) {
        addEdge(projectId, node, planNodes.get(decision.plan_revision_id)!, 'DECIDES_PLAN', 2);
      }
      if (decision.experiment_id && experimentNodes.has(decision.experiment_id)) {
        addEdge(projectId, node, experimentNodes.get(decision.experiment_id)!, 'DECIDES_EXPERIMENT', 2);
      }
    }

    const evidenceNodes = new Map<string, string>();
    for (const evidence of source.evidence ?? []) {
      const node = graphId('evidence', projectId, evidence.evidence_id);
      evidenceNodes.set(evidence.evidence_id, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'evidence',
        label: evidence.locator ?? evidence.source_type,
        text: evidence.quote,
        source_id: evidence.evidence_id,
      });
      addInstanceOf(projectId, node, 'evidence');
      const sourceNode = evidence.source_type === 'document'
        ? documentNodes.get(evidence.source_id)
        : evidence.source_type === 'source'
          ? sourceNodes.get(evidence.source_id)
          : evidence.source_type === 'experiment'
            ? experimentNodes.get(evidence.source_id)
            : evidence.source_type === 'decision'
              ? decisionNodes.get(evidence.source_id)
              : undefined;
      if (sourceNode) addEdge(projectId, node, sourceNode, 'DERIVED_FROM', 2);
    }

    const sessionNodes = new Map<string, string>();
    for (const session of source.sessions) {
      const node = graphId('session', projectId, session.memory_handle);
      sessionNodes.set(session.memory_handle, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'session',
        label: session.memory_handle.slice(0, 8),
        source_id: session.memory_handle,
      });
      addInstanceOf(projectId, node, 'session');
      addEdge(projectId, projectNode, node, 'HAS_SESSION', 1);
    }
    for (const intent of source.intents) {
      const node = graphId('intent', projectId, intent.intent_revision_id);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'intent',
        label: intent.intent.slice(0, 120),
        text: intent.intent,
        source_id: intent.intent_revision_id,
      });
      addInstanceOf(projectId, node, 'intent');
      const session = sessionNodes.get(intent.memory_handle);
      if (session) addEdge(projectId, session, node, 'HAS_INTENT', 1.5);
    }

    const entityNodes = new Map<string, string>();
    const nameToEntity = new Map<string, string>();
    const aliasesByEntity = new Map<string, EntityAliasRecord[]>();
    for (const alias of source.aliases ?? []) {
      const aliases = aliasesByEntity.get(alias.entity_id) ?? [];
      aliases.push(alias);
      aliasesByEntity.set(alias.entity_id, aliases);
    }
    for (const entity of source.entities.filter((row) => row.status !== 'merged')) {
      const node = graphId('entity', projectId, entity.entity_id);
      entityNodes.set(entity.entity_id, node);
      nameToEntity.set(entity.normalized_name, node);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'entity',
        label: entity.canonical_name,
        source_id: entity.entity_id,
      });
      addEdge(projectId, projectNode, node, 'HAS_ENTITY', 1);
      const kind = normalizeEntityName(entity.kind);
      const schemaKey = schemaIndex.label_keys.get(`entity_type\0${kind}`)
        ?? `entity_type:${kind}`;
      addEdge(projectId, node, ensureSchemaNode(schemaKey), 'INSTANCE_OF', 2);
      linkedEntities.push({
        project_id: projectId,
        node_id: node,
        entity,
        aliases: aliasesByEntity.get(entity.entity_id) ?? [],
        schema_key: schemaKey,
      });
    }

    const resolveEntityNode = (value: string): string => {
      const direct = entityNodes.get(value) ?? nameToEntity.get(normalizeEntityName(value));
      if (direct) return direct;
      const node = graphId('entity', projectId, `unresolved:${value}`);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'entity',
        label: value,
        source_id: value,
      });
      return node;
    };
    for (const assertion of source.assertions) {
      const node = graphId('assertion', projectId, assertion.assertion_id);
      addNode({
        node_id: node,
        project_id: projectId,
        kind: 'assertion',
        label: assertion.predicate,
        text: assertion.value === undefined ? undefined : String(assertion.value),
        source_id: assertion.assertion_id,
      });
      addInstanceOf(projectId, node, 'assertion');
      addEdge(projectId, resolveEntityNode(assertion.subject), node, 'ASSERTS', 2, assertion.evidence_ids);
      if (assertion.object !== undefined) {
        addEdge(projectId, node, resolveEntityNode(assertion.object), assertion.predicate, 2, assertion.evidence_ids);
      }
      for (const evidenceId of assertion.evidence_ids) {
        const evidence = evidenceNodes.get(evidenceId);
        if (evidence) addEdge(projectId, node, evidence, 'SUPPORTED_BY', 2, [evidenceId]);
      }
      const predicate = normalizeEntityName(assertion.predicate);
      const schemaKey = schemaIndex.label_keys.get(`relation\0${predicate}`)
        ?? `relation:${predicate}`;
      addEdge(projectId, node, ensureSchemaNode(schemaKey), 'USES_RELATION', 1.5);
      addEdge(projectId, projectNode, node, 'HAS_ASSERTION', 1);
    }
  }

  const identityGroups = new Map<string, typeof linkedEntities>();
  for (const linked of linkedEntities) {
    const aliases = stableIdentityAliases(linked.entity, linked.aliases);
    for (const alias of aliases) {
      const key = `${linked.schema_key}\0${alias.normalized_alias}`;
      const group = identityGroups.get(key) ?? [];
      group.push(linked);
      identityGroups.set(key, group);
    }
  }
  const linkedSignatures = new Set<string>();
  for (const [key, group] of [...identityGroups].sort(([a], [b]) => a.localeCompare(b))) {
    const byProject = new Map<string, typeof linkedEntities>();
    for (const linked of group) {
      const members = byProject.get(linked.project_id) ?? [];
      if (!members.some((member) => member.node_id === linked.node_id)) members.push(linked);
      byProject.set(linked.project_id, members);
    }
    if (byProject.size < 2 || [...byProject.values()].some((members) => members.length !== 1)) continue;
    const members = [...byProject.values()].map(([member]) => member)
      .sort((a, b) => a.node_id.localeCompare(b.node_id));
    const signature = members.map((member) => member.node_id).join('\0');
    if (linkedSignatures.has(signature)) continue;
    linkedSignatures.add(signature);
    const alias = key.slice(key.indexOf('\0') + 1);
    const node = graphId('identity', 'shared', key);
    addNode({
      node_id: node,
      project_id: 'shared',
      kind: 'identity',
      label: alias,
      text: members[0].schema_key,
      source_id: key,
    });
    for (const member of members) {
      addEdge(member.project_id, member.node_id, node, 'IDENTITY_LINK', 3);
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => a.node_id.localeCompare(b.node_id));
  const sortedEdges = [...edges.values()].sort((a, b) => a.edge_id.localeCompare(b.edge_id));
  const sourceVersions = Object.fromEntries(sources.map((source) => [
    source.project.project_id,
    source.project.graph_dirty_at ?? source.project.updated_at,
  ]).sort(([a], [b]) => a.localeCompare(b)));
  const sourceHash = createHash('sha256').update(JSON.stringify({
    storage: 'content-addressed-artifact-v3',
    analysis: 'louvain-validated-v3',
    source_versions: sourceVersions,
    nodes: sortedNodes.map((node) => [
      node.node_id, node.kind, node.label, node.text, node.url, node.source_id,
    ]),
    edges: sortedEdges.map((edge) => [
      edge.edge_id, edge.source, edge.target, edge.type, edge.weight, edge.evidence_ids,
    ]),
  })).digest('hex');
  return {
    projection_id: `graph-${sourceHash.slice(0, 24)}`,
    schema_version: 'graph-v3',
    source_hash: sourceHash,
    source_versions: sourceVersions,
    project_ids: sources.map((source) => source.project.project_id).sort(),
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}
