import { hash, json, positiveInteger } from './files.js';
import { currentFacts, terms, trustedPrefix } from './memory.js';
import type { GraphEdge, GraphNode, GraphRetrieval, GraphSnapshot, MemoryState, Provenance, Revision } from './types.js';

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase();
export function graphIdentity(revisions: Revision[], atChapter: number) {
  const prefix = trustedPrefix(revisions);
  if (!Number.isSafeInteger(atChapter) || atChapter < 0 || atChapter > prefix.length) throw new Error('Graph chapter is beyond reconciled memory');
  const sourceRevisions = prefix.slice(0, atChapter).map(item => ({ chapter: item.chapter, revision: item.id, bodyHash: item.bodyHash, deltaHash: hash(json(item.delta)) }));
  const snapshotId = hash(json({ kernelVersion: 1, atChapter, sourceRevisions }));
  return { snapshotId, sourceRevisions };
}

export function buildGraph(state: MemoryState, revisions: Revision[]): GraphSnapshot {
  const identity = graphIdentity(revisions, state.atChapter);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const aliases = new Map<string, Set<string>>();
  const addAlias = (label: string, id: string): void => {
    const key = normalize(label);
    const owners = aliases.get(key) ?? new Set<string>();
    owners.add(id); aliases.set(key, owners);
  };
  for (const entity of state.entities) {
    const id = `entity:${entity.id}`;
    nodes.set(id, { id, kind: 'entity', recordId: entity.id, label: entity.name, aliases: entity.aliases, description: entity.description, entityType: entity.type, sourceChapter: entity.sourceChapter, sourceRevision: entity.sourceRevision, evidence: entity.evidence, evidenceLine: entity.evidenceLine });
    for (const label of [entity.id, entity.name, ...entity.aliases]) addAlias(label, id);
  }
  const knownNames = new Set([
    ...currentFacts(state).flatMap(fact => [fact.subject, ...(fact.predicate.startsWith('relationship:') ? [fact.predicate.slice('relationship:'.length)] : [])]),
    ...state.episodes.flatMap(event => [...event.participants, ...(event.location ? [event.location] : [])]),
    ...state.resources.map(resource => resource.entity),
    ...state.summaries.flatMap(summary => summary.characters)
  ].map(normalize));
  const resolveEntity = (label: string, value = false): string => {
    const owners = aliases.get(normalize(label));
    if (owners?.size === 1) return [...owners][0]!;
    // Ambiguous names remain distinct unresolved references rather than merging two characters.
    const literal = value && !knownNames.has(normalize(label));
    const id = `${literal ? 'value' : 'name'}:${hash(normalize(label)).slice(0, 24)}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: literal ? 'value' : 'entity', label, aliases: [], description: owners && owners.size > 1 ? '同名引用未消歧，请使用实体 ID' : '' });
    return id;
  };
  const addEdge = (from: string, to: string, relation: string, kind: GraphEdge['kind'], provenance: Provenance, scope: 'world' | 'belief' = 'world', holder: string | null = null, extra: Partial<GraphEdge> = {}): void => {
    const id = hash(json({ from, to, relation, kind, provenance, scope, holder, extra }));
    edges.push({ id, from, to, relation, kind, sourceChapter: provenance.sourceChapter, sourceRevision: provenance.sourceRevision, evidence: provenance.evidence, evidenceLine: provenance.evidenceLine, scope, holder, ...extra });
  };
  for (const fact of currentFacts(state)) {
    const related = fact.predicate.startsWith('relationship:') ? fact.predicate.slice('relationship:'.length) : null;
    addEdge(resolveEntity(fact.subject), resolveEntity(related ?? fact.object, related === null), related ? `relationship:${fact.object}` : fact.predicate, 'fact', fact, fact.scope, fact.holder, { factId: fact.id });
  }
  for (const episode of state.episodes) {
    const id = `event:${episode.id}`;
    nodes.set(id, { id, kind: 'event', recordId: episode.id, label: episode.description, aliases: [episode.id], description: episode.story_time ? `故事内时间：${episode.story_time}` : '', scope: episode.scope, holder: episode.holder, sourceChapter: episode.sourceChapter, sourceRevision: episode.sourceRevision, evidence: episode.evidence, evidenceLine: episode.evidenceLine });
  }
  for (const episode of state.episodes) {
    const id = `event:${episode.id}`;
    for (const actor of episode.participants) addEdge(resolveEntity(actor), id, 'participates', 'participant', episode, episode.scope, episode.holder, { recordId: episode.id });
    if (episode.location) addEdge(id, resolveEntity(episode.location), 'takes-place-at', 'location', episode, episode.scope, episode.holder, { recordId: episode.id });
    for (const cause of episode.causes) addEdge(`event:${cause}`, id, 'causes', 'causal', episode, episode.scope, episode.holder, { recordId: episode.id });
  }
  for (const hook of state.hooks) {
    const id = `hook:${hook.id}`;
    nodes.set(id, { id, kind: 'hook', recordId: hook.id, label: hook.description, aliases: [hook.id], description: `承诺状态：${hook.status}${hook.expectedPayoff ? `；待兑现目标（并非已发生事件）：${hook.expectedPayoff}` : ''}`, sourceChapter: hook.sourceChapter, sourceRevision: hook.sourceRevision, evidence: hook.evidence });
  }
  for (const hook of state.hooks) {
    const evidenceLine = revisions.find(item => item.id === hook.sourceRevision)?.body.split(hook.evidence.quote)[0]?.split('\n').length ?? 1;
    const provenance = { sourceChapter: hook.sourceChapter, sourceRevision: hook.sourceRevision, evidence: hook.evidence, evidenceLine };
    for (const dependency of hook.dependsOn ?? []) addEdge(`hook:${hook.id}`, `hook:${dependency}`, 'depends-on', 'dependency', provenance, 'world', null, { recordId: hook.id });
    if (hook.supersededBy) addEdge(`hook:${hook.id}`, `hook:${hook.supersededBy}`, 'superseded-by', 'dependency', provenance, 'world', null, { recordId: hook.id });
  }
  for (const resource of state.resources) {
    const id = `resource:${hash(json([resource.entity, resource.resource])).slice(0, 24)}`;
    nodes.set(id, { id, kind: 'resource', recordId: json([resource.entity, resource.resource]).trim(), label: `${resource.resource}=${resource.amount}`, aliases: [resource.resource], description: '当前有正文证据的资源余额', sourceChapter: resource.sourceChapter, sourceRevision: resource.sourceRevision, evidence: resource.evidence, evidenceLine: resource.evidenceLine });
    addEdge(resolveEntity(resource.entity), id, 'owns-resource', 'resource', resource);
  }
  return { schemaVersion: 1, kernelVersion: 1, ...identity, atChapter: state.atChapter, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: edges.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function visibleGraph(snapshot: GraphSnapshot, holder?: string): GraphSnapshot {
  const edges = snapshot.edges.filter(edge => edge.scope === 'world' || (holder !== undefined && edge.holder === holder));
  const referenced = new Set(edges.flatMap(edge => [edge.from, edge.to]));
  const nodes = snapshot.nodes.filter(node => {
    if (node.scope === 'belief' && node.holder !== holder) return false;
    if (node.kind === 'value' || (node.kind === 'entity' && node.sourceChapter === undefined)) return referenced.has(node.id);
    return true;
  });
  const allowed = new Set(nodes.map(node => node.id));
  return { ...snapshot, nodes, edges: edges.filter(edge => allowed.has(edge.from) && allowed.has(edge.to)) };
}

export function retrieveGraph(snapshot: GraphSnapshot, query: string, options: { holder?: string; hops?: number; maxNodes?: number; maxEdges?: number } = {}): GraphRetrieval {
  const hops = positiveInteger(options.hops ?? 2, 'hops');
  if (hops > 4) throw new Error('Graph hops must be 1–4');
  const maxNodes = positiveInteger(options.maxNodes ?? 60, 'maxNodes');
  const maxEdges = positiveInteger(options.maxEdges ?? 100, 'maxEdges');
  const graph = visibleGraph(snapshot, options.holder);
  const queryTerms = new Set(terms(query));
  const score = (text: string): number => terms(text).filter(term => queryTerms.has(term)).length;
  const exactSeeds = graph.nodes.map(node => ({ node, score: [node.label, ...node.aliases].some(label => label.length > 1 && normalize(query).includes(normalize(label))) ? 100 : score(`${node.label} ${node.description}`) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const seeds = exactSeeds.slice(0, Math.min(8, maxNodes)).map(item => item.node.id);
  if (!seeds.length) {
    const related = graph.edges.map(edge => ({ edge, score: score(edge.relation) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    for (const item of related.slice(0, 4)) for (const id of [item.edge.from, item.edge.to]) if (!seeds.includes(id) && seeds.length < maxNodes) seeds.push(id);
  }
  const paths = new Map(seeds.map(id => [id, { nodeIds: [id], edgeIds: [] as string[] }]));
  const selectedEdges = new Map<string, GraphEdge>();
  let frontier = [...seeds];
  let truncated = exactSeeds.length > seeds.length;
  for (let depth = 0; depth < hops && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const adjacent = graph.edges.filter(edge => edge.from === id || edge.to === id)
        .sort((a, b) => score(b.relation) - score(a.relation) || b.sourceChapter - a.sourceChapter || a.id.localeCompare(b.id));
      for (const edge of adjacent) {
        if (selectedEdges.size >= maxEdges && !selectedEdges.has(edge.id)) { truncated = true; continue; }
        const target = edge.from === id ? edge.to : edge.from;
        if (!paths.has(target)) {
          if (paths.size >= maxNodes) { truncated = true; continue; }
          const parent = paths.get(id)!;
          paths.set(target, { nodeIds: [...parent.nodeIds, target], edgeIds: [...parent.edgeIds, edge.id] });
          next.push(target);
        }
        selectedEdges.set(edge.id, edge);
      }
    }
    frontier = next;
  }
  return { engine: 'writer-memory-graphrag', snapshotId: snapshot.snapshotId, atChapter: snapshot.atChapter, hops, seedIds: seeds, nodes: graph.nodes.filter(node => paths.has(node.id)), edges: [...selectedEdges.values()], paths: [...paths.values()], truncated };
}
