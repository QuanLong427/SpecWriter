import { hash } from './files.js';
import { resolveEntityReference } from './entity-reference.js';
import { stateField, stateValue } from './memory-policy.js';
import type { MemoryFact, MemoryState, Revision, ScopedFact } from './types.js';

export function trustedPrefix(revisions: Revision[]): Revision[] {
  const prefix: Revision[] = [];
  for (const revision of revisions) {
    if (revision.stale || revision.chapter !== prefix.length + 1) break;
    prefix.push(revision);
  }
  return prefix;
}
const factKey = (fact: Pick<ScopedFact, 'subject' | 'predicate' | 'scope' | 'holder'>): string => JSON.stringify([fact.scope, fact.holder, fact.subject, fact.predicate]);

export function replay(revisions: Revision[], atChapter = trustedPrefix(revisions).length): MemoryState {
  if (!Number.isSafeInteger(atChapter) || atChapter < 0 || atChapter > trustedPrefix(revisions).length) {
    throw new Error('Requested chapter is beyond reconciled memory; repair the first stale chapter');
  }
  const state: MemoryState = { atChapter, facts: [], hooks: [], timeline: [], summaries: [], entities: [], episodes: [], resources: [] };
  for (const revision of revisions.filter(item => item.chapter <= atChapter)) {
    applyRevision(state, revision);
  }
  return state;
}

export function applyRevision(state: MemoryState, revision: Revision): void {
  const { delta, chapter } = revision;
  const evidenceLine = (evidence: import('./types.js').Evidence): number => revision.body.slice(0, evidence.start ?? revision.body.indexOf(evidence.quote)).split('\n').length;
  const provenance = (evidence: import('./types.js').Evidence) => ({ sourceChapter: chapter, sourceRevision: revision.id, evidence, evidenceLine: evidenceLine(evidence) });
  for (const input of delta.entities ?? []) {
    const previous = state.entities.find(item => item.id === input.id);
    if (previous && previous.type !== input.type) throw new Error(`Entity type cannot change: ${input.id}`);
    const updated = { ...input, aliases: [...new Set([...(previous?.aliases ?? []), ...(previous && previous.name !== input.name ? [previous.name] : []), ...input.aliases])], ...provenance(input.evidence) };
    if (previous) state.entities[state.entities.indexOf(previous)] = updated;
    else state.entities.push(updated);
  }
  const ref = (value: string) => delta.schemaVersion === 2 ? resolveEntityReference(state, value) : value;
  const valueOf = (field: string, value: string) => delta.schemaVersion === 2 ? stateValue(field, value) : value;
  const scoped = (fact: ScopedFact): ScopedFact => ({ ...fact, subject: ref(fact.subject), predicate: delta.schemaVersion === 2 ? stateField(fact.predicate, fact.object) ?? fact.predicate : fact.predicate, holder: fact.holder === null ? null : ref(fact.holder) });
  const key = (fact: ScopedFact) => delta.schemaVersion === 2 ? factKey({ ...fact, subject: resolveEntityReference(state, fact.subject, false), predicate: stateField(fact.predicate, fact.object) ?? (fact.predicate.startsWith('relationship:') ? `relationship:${resolveEntityReference(state, fact.predicate.slice(13), false)}` : fact.predicate), holder: fact.holder === null ? null : resolveEntityReference(state, fact.holder, false) }) : factKey(fact);
  const operationKeys = new Set<string>();
  const add = (rawFact: ScopedFact, replace = false, expected?: string | null): void => {
    const fact = scoped(rawFact);
    if (replace && operationKeys.has(key(fact))) throw new Error('Duplicate state operations after entity alias resolution');
    if (replace) operationKeys.add(key(fact));
    const current = state.facts.filter(item => item.validUntilChapter === null && key(item) === key(fact));
    if (replace) {
      if (expected === null && current.length) throw new Error(`State already exists for ${fact.subject}.${fact.predicate}; old_value must match`);
      if (expected !== null && (current.length !== 1 || valueOf(fact.predicate, current[0]!.object) !== valueOf(fact.predicate, expected ?? ''))) {
        throw new Error(`State precondition failed for ${fact.subject}.${fact.predicate}: expected ${expected}`);
      }
      for (const item of current) item.validUntilChapter = chapter;
    } else {
      if (delta.schemaVersion === 2 && stateField(fact.predicate, fact.object) && current.some(item => stateValue(fact.predicate, item.object) !== stateValue(fact.predicate, fact.object))) throw new Error(`Single-valued state conflict: ${fact.subject}.${fact.predicate}; use state_changes with matching old_value`);
      if (current.some(item => valueOf(fact.predicate, item.object) === valueOf(fact.predicate, fact.object))) return;
    }
    state.facts.push({
      ...fact, id: hash(JSON.stringify([revision.id, state.facts.length, fact])),
      sourceChapter: chapter, sourceRevision: revision.id, validFromChapter: chapter,
      validUntilChapter: null, evidenceLine: evidenceLine(fact.evidence)
    });
  };
  // Apply preconditioned state updates before additive facts from the same chapter.
  for (const change of delta.state_changes) add({
    subject: change.entity, predicate: change.field, object: change.new_value,
    scope: change.scope, holder: change.holder, evidence: change.evidence
  }, true, change.old_value);
  for (const relation of delta.relationship_changes) {
    const fact: ScopedFact = { subject: ref(relation.character_a), predicate: `relationship:${ref(relation.character_b)}`, object: relation.relation, scope: 'world', holder: null, evidence: relation.evidence };
    for (const item of state.facts.filter(item => item.validUntilChapter === null && key(item) === key(fact))) item.validUntilChapter = chapter;
    add(fact);
  }
  for (const intro of delta.cast_intros) add({ subject: intro.name, predicate: 'role', object: intro.brief_role, scope: 'world', holder: null, evidence: intro.evidence });
  for (const fact of delta.facts) {
    if (delta.state_changes.some(change => key({ subject: change.entity, predicate: change.field, scope: change.scope, holder: change.holder, object: change.new_value, evidence: change.evidence }) === key(fact) && valueOf(change.field, change.new_value) !== valueOf(fact.predicate, fact.object))) {
      throw new Error(`Fact contradicts this chapter's state update: ${fact.subject}.${fact.predicate}`);
    }
    add(fact);
  }
  for (const change of delta.resource_changes ?? []) {
    const entity = ref(change.entity);
    const resourceKey = JSON.stringify(['resource', entity, change.resource]);
    if (operationKeys.has(resourceKey)) throw new Error('Duplicate resource operations after entity alias resolution');
    operationKeys.add(resourceKey);
    const previous = state.resources.find(item => (delta.schemaVersion === 2 ? resolveEntityReference(state, item.entity, false) : item.entity) === entity && item.resource === change.resource);
    if (previous && Math.abs(previous.amount - change.opening) > 1e-9 * Math.max(1, Math.abs(change.opening))) throw new Error(`Resource opening value does not match: ${change.entity}.${change.resource}`);
    const updated = { entity, resource: change.resource, amount: change.closing, ...provenance(change.evidence) };
    if (previous) state.resources[state.resources.indexOf(previous)] = updated;
    else state.resources.push(updated);
  }
  for (const [index, event] of delta.key_events.entries()) {
    state.episodes.push({ id: `chapter-${chapter}-key-${index + 1}`, description: event.description, story_time: null, participants: [], location: null, causes: [], scope: 'world', holder: null, kind: 'key-event', ...provenance(event.evidence) });
  }
  for (const event of delta.narrative_events ?? []) {
    if (state.episodes.some(item => item.id === event.id)) throw new Error(`Event already exists: ${event.id}`);
    state.episodes.push({ ...event, participants: event.participants.map(ref), location: event.location === null ? null : ref(event.location), holder: event.holder === null ? null : ref(event.holder), kind: 'narrative-event', ...provenance(event.evidence) });
  }
  for (const episode of state.episodes) {
    for (const cause of episode.causes) {
      const source = state.episodes.find(item => item.id === cause);
      if (!source) throw new Error(`Unknown event cause: ${cause}`);
      if (episode.scope === 'world' && source.scope === 'belief') throw new Error('A character belief cannot be promoted to a world causal event');
      if (episode.scope === 'belief' && source.scope === 'belief' && episode.holder !== source.holder) throw new Error('Belief causal chains must have the same holder');
    }
  }
  assertAcyclic(new Map(state.episodes.map(item => [item.id, item.causes])), 'Event causes');
  for (const update of delta.foreshadow_updates) {
    let hook = state.hooks.find(item => item.id === update.id);
    if (update.action === 'plant') {
      if (hook) throw new Error(`Hook already exists: ${update.id}`);
      if (!update.description?.trim()) throw new Error(`Plant requires a description: ${update.id}`);
      hook = { id: update.id, description: update.description, status: 'open', startChapter: chapter, sourceChapter: chapter, sourceRevision: revision.id, evidence: update.evidence };
      state.hooks.push(hook);
    } else {
      if (!hook) throw new Error(`Unknown hook: ${update.id}`);
      if (hook.status === 'resolved' || hook.status === 'superseded') throw new Error(`Closed hook cannot be advanced again: ${update.id}`);
      hook.status = update.action === 'advance' ? 'progressing' : update.action === 'resolve' ? 'resolved' : update.action === 'supersede' ? 'superseded' : 'deferred';
      hook.sourceChapter = chapter; hook.sourceRevision = revision.id; hook.evidence = update.evidence;
    }
    if (update.expected_payoff !== undefined) hook.expectedPayoff = update.expected_payoff;
    if (update.depends_on !== undefined) hook.dependsOn = update.depends_on;
    if (update.action === 'supersede') {
      if (!update.superseded_by?.trim()) throw new Error(`Supersede requires a replacement hook id: ${update.id}`);
      hook.supersededBy = update.superseded_by;
    }
  }
  for (const hook of state.hooks) {
    for (const dependency of [...(hook.dependsOn ?? []), ...(hook.supersededBy ? [hook.supersededBy] : [])]) {
      if (!state.hooks.some(item => item.id === dependency)) throw new Error(`Unknown hook dependency: ${dependency}`);
    }
  }
  assertAcyclic(new Map(state.hooks.map(item => [item.id, [...(item.dependsOn ?? []), ...(item.supersededBy ? [item.supersededBy] : [])]])), 'Hook dependencies');
  state.timeline.push(...delta.timeline_events.map(item => ({ ...item, characters: item.characters.map(ref), sourceChapter: chapter, sourceRevision: revision.id })));
  state.summaries.push({ chapter, revision: revision.id, title: delta.title, summary: delta.summary, characters: delta.characters.map(ref) });
  state.atChapter = chapter;
}

function assertAcyclic(links: Map<string, string[]>, label: string): void {
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`${label} contain a cycle: ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const next of links.get(id) ?? []) visit(next);
    visiting.delete(id); done.add(id);
  };
  for (const id of links.keys()) visit(id);
}

export function currentFacts(state: MemoryState): MemoryFact[] {
  return state.facts.filter(item => item.validUntilChapter === null);
}

// Chinese segmentation + character bigrams avoid whitespace-only retrieval failure.
export function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = [...segmenter.segment(normalized)]
    .filter(item => item.isWordLike).map(item => item.segment);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length - 1; i++) words.push(chars[i]! + chars[i + 1]!);
  }
  return words;
}
export interface SearchHit { chapter: number; revision: number; source: string; line: number; excerpt: string; score: number }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function proseChunks(body: string): { excerpt: string; line: number; tokens: string }[] {
  const chunks: { excerpt: string; line: number; tokens: string }[] = [];
  let line = 1;
  for (const paragraph of body.split(/(?<=\n)\s*\n/u)) {
    for (let offset = 0; offset < paragraph.length; offset += 1200) {
      const excerpt = paragraph.slice(offset, offset + 1200);
      chunks.push({ excerpt, line: line + paragraph.slice(0, offset).split('\n').length - 1, tokens: terms(excerpt).join(' ') });
    }
    line += paragraph.split('\n').length - 1;
  }
  return chunks;
}

export function graphFacts(state: MemoryState, query: string, holder?: string): MemoryFact[] {
  const visible = currentFacts(state).filter(item => item.scope === 'world' || (holder !== undefined && item.holder !== null && resolveEntityReference(state, item.holder, false) === resolveEntityReference(state, holder)));
  const queryTerms = new Set(terms(query));
  const seeds = visible.filter(item => terms(`${item.subject} ${item.predicate} ${item.object}`).some(term => queryTerms.has(term)));
  const entities = new Set(seeds.flatMap(item => [item.subject, item.object]));
  return visible.filter(item => seeds.includes(item) || entities.has(item.subject) || entities.has(item.object));
}
