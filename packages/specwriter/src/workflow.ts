import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite, chapterId, hash, identifier, json, positiveInteger, readJson, safePath, writeNew } from './files.js';
import { loadConfig } from './init.js';
import { resolveEntityReference } from './entity-reference.js';
import { currentFacts, replay, terms } from './memory.js';
import { stateField } from './memory-policy.js';
import { Store } from './store.js';
import { validateIntent } from './validation.js';
import { projectViews } from './projections.js';
import { ResearchLibrary } from './research.js';
import type { AdoptedContract, ChapterIntent, ContextRequirements, MemoryState, WorkPolicy } from './types.js';

export const resourceKey = (entity: string, resource: string) => JSON.stringify([entity, resource]);

/** Book-scoped creation policy and readable task artifacts; never generates story facts. */
export class StoryWorkflow {
  constructor(readonly root: string, readonly store: Store, private readonly progress?: (work: import('./types.js').WorkItem) => ReturnType<typeof import('./work-progress.js').workProgress>) {}
  get structured(): boolean { return loadConfig(this.root).workflow === 'structured' || this.store.contracts().length > 0; }
  contract(chapter: number): AdoptedContract {
    const selected = this.store.contracts().filter(item => item.fromChapter <= chapter).sort((a, b) => b.fromChapter - a.fromChapter || b.id - a.id)[0];
    if (!selected) throw new Error(`No adopted creative contract for chapter ${chapter}; use contract adopt after the author selects the foundation`);
    return selected;
  }
  adopt(reason: string, fromChapter = (this.store.revisions().at(-1)?.chapter ?? 0) + 1) {
    positiveInteger(fromChapter, 'from');
    if (!reason.trim()) throw new Error('Contract adoption requires the author instruction or adoption reason');
    const sources = ['premise', 'world', 'characters', 'style'].map(name => {
      const source = `specwriter/specs/${name}.md`, content = readFileSync(safePath(this.root, source), 'utf8');
      if (!content.trim()) throw new Error(`Creative spec is empty: ${source}`);
      return { name, source, content, hash: hash(content) };
    });
    const existing = this.store.contracts().find(item => item.fromChapter === fromChapter && json(item.sources) === json(sources) && item.reason === reason);
    if (existing) return { adopted: existing, reused: true, staleChapters: [] as number[] };
    const result = this.store.transaction(() => {
      const adopted = this.store.adoptContract({ fromChapter, reason, adoptedAt: new Date().toISOString(), sources });
      const staleChapters = this.store.invalidateFrom(fromChapter);
      return { adopted, reused: false, staleChapters };
    });
    // Adoption is canonical even if readable projection rebuilding fails; sync can recover it.
    try {
      projectViews(this.root, this.store.revisions(), this.store.works(), this.store.generation(), id => this.store.workRevisions(id), this.progress);
      return { ...result, projectionNeedsSync: false };
    } catch (error) { return { ...result, projectionNeedsSync: true, warning: (error as Error).message }; }
  }
  contracts() {
    return { mode: this.structured ? 'structured' : 'legacy', adopted: this.store.contracts().map(item => ({ ...item,
      editedDrafts: item.sources.filter(source => !existsSync(safePath(this.root, source.source)) || hash(readFileSync(safePath(this.root, source.source), 'utf8')) !== source.hash).map(source => source.source) })) };
  }
  authorize(workId: string, from: number, to: number, acceptance: WorkPolicy['acceptance'], reason: string) {
    identifier(workId); positiveInteger(from, 'from'); positiveInteger(to, 'to');
    return this.store.transaction(() => {
      const work = this.store.work(workId);
      if (work.status !== 'active' || from < work.fromChapter || to > work.toChapter || from > to) throw new Error('Authorization must be inside an active work range');
      if (!['draft', 'auto'].includes(acceptance) || !reason.trim()) throw new Error('Use acceptance draft|auto and record the author instruction');
      const previous = this.store.policy(workId);
      const policy: WorkPolicy = { schemaVersion: 1, workId, fromChapter: from, toChapter: to, acceptance, reason, paused: previous?.paused ?? false, pauseReason: previous?.pauseReason ?? null, controlReason: previous?.controlReason };
      this.store.setPolicy(policy); return policy;
    });
  }
  pause(workId: string, paused: boolean, reason: string) {
    if (!reason.trim()) throw new Error('Pause/resume requires a reason');
    return this.store.transaction(() => {
      const work = this.store.work(identifier(workId)), policy = this.store.policy(workId);
      if (work.status !== 'active' || !policy) throw new Error('Work has no active writing authorization');
      const next = { ...policy, paused, pauseReason: paused ? reason : null, controlReason: reason };
      this.store.setPolicy(next); return next;
    });
  }
  assertAdvance(chapter: number, workId: string, accept = false): void {
    if (!this.structured) return;
    this.contract(chapter);
    const policy = this.store.policy(workId);
    if (!policy || chapter < policy.fromChapter || chapter > policy.toChapter) throw new Error('Chapter is outside the author authorization; use work authorize with the existing author instruction');
    if (policy.paused) throw new Error(`Work is paused: ${policy.pauseReason}; review remains available, resume only on author instruction`);
    if (accept && policy.acceptance !== 'auto') throw new Error('Draft-only authorization cannot accept prose; record the author acceptance with work authorize');
  }
  intentPath(chapter: number, workId: string): string { return `specwriter/work/${identifier(workId)}/chapters/${chapterId(positiveInteger(chapter, 'chapter'))}/intent.json`; }
  seed(chapter: number, workId: string) {
    const work = this.store.work(identifier(workId)); positiveInteger(chapter, 'chapter');
    if (work.status !== 'active' || chapter < work.fromChapter || chapter > work.toChapter) throw new Error('Chapter is outside active work');
    const state = replay(this.store.revisions(), chapter - 1), contract = this.contract(chapter);
    const previous = this.store.revisions().find(item => item.chapter === chapter - 1);
    const participants = [...new Set(state.summaries.slice(-2).flatMap(item => item.characters).map(item => resolveEntityReference(state, item)))].filter(id => state.entities.some(item => item.id === id));
    const template: ChapterIntent = { schemaVersion: 1, chapter, goal: '', scenes: [], participantIds: participants, newEntities: [], pov: null, storyTime: null, requiredState: [], requiredResources: [], requiredEvents: [], requiredHooks: [], knowledgeChecks: [], withhold: [], expectedChanges: [], targetChars: null, planPaths: ['specwriter/plans/outline.md'] };
    const path = this.intentPath(chapter, workId); writeNew(safePath(this.root, path), json(template));
    return { chapter, workId, path, contract, policy: this.store.policy(workId) ?? null, previousEnding: previous?.body.slice(-3000) ?? '', summaries: state.summaries.slice(-3), entities: state.entities.filter(item => participants.includes(item.id)), currentFacts: currentFacts(state).filter(item => participants.includes(item.subject)).slice(0, 40), openHooks: state.hooks.filter(item => !['resolved', 'superseded'].includes(item.status)).slice(-12), note: 'Complete intent.json, then run intent save. Planned changes are not canon; query omitted history as needed.' };
  }
  readIntent(chapter: number, workId: string): ChapterIntent {
    const path = safePath(this.root, this.intentPath(chapter, workId));
    if (!existsSync(path)) throw new Error('Structured chapter intent is missing; run intent seed, complete intent.json and intent save before prepare');
    const intent: unknown = readJson(path); validateIntent(intent);
    if (intent.chapter !== chapter) throw new Error('Intent chapter identity mismatch');
    return intent;
  }
  saveIntent(chapter: number, workId: string) {
    const intent = this.readIntent(chapter, workId), state = replay(this.store.revisions(), chapter - 1);
    const work = this.store.work(workId);
    if (work.status !== 'active' || chapter < work.fromChapter || chapter > work.toChapter) throw new Error('Intent is outside active work');
    requiredMemory(state, intent);
    for (const path of intent.planPaths) if (!existsSync(safePath(this.root, path))) throw new Error(`Selected plan is missing: ${path}`);
    new ResearchLibrary(this.root).contextSources(intent.references ?? []);
    const markdown = renderIntent(intent);
    atomicWrite(safePath(this.root, `specwriter/work/${workId}/chapters/${chapterId(chapter)}/intent.md`), markdown);
    return { chapter, workId, path: this.intentPath(chapter, workId), intentHash: hash(markdown), intentDataHash: hash(json(intent)), query: intentQuery(intent), nextAction: `prepare ${chapter} --work ${workId}` };
  }
}

export function renderIntent(intent: ChapterIntent): string {
  return `# 第 ${intent.chapter} 章意图\n\n${intent.goal}\n\n## 场景\n\n${intent.scenes.map(item => `- ${item}`).join('\n')}\n\n## 结构化章纲\n\n以下是计划及信息边界，不是已发生事实。\n\n\`\`\`json\n${JSON.stringify(intent, null, 2)}\n\`\`\`\n`;
}
export function intentQuery(intent: ChapterIntent): string {
  return [intent.goal, `人物：${intent.participantIds.join('、')}`, ...intent.requiredState.map(item => `${item.entity} ${item.fields.join(' ')}`), ...intent.requiredResources.map(item => `${item.entity} ${item.resource}`), ...intent.knowledgeChecks.map(item => `${item.holder} 对 ${item.topic} 的认知依据`), ...intent.requiredEvents, ...intent.requiredHooks].filter(Boolean).join('；');
}
export function requiredMemory(state: MemoryState, intent: ChapterIntent): ContextRequirements {
  const introduced = new Set(intent.newEntities.map(item => item.id)), known = new Set(state.entities.map(item => item.id));
  const normalized = (name: string) => name.normalize('NFKC').trim().toLowerCase();
  for (const item of intent.newEntities) if (known.has(item.id) || state.entities.some(entity => [entity.name, ...entity.aliases].some(name => normalized(name) === normalized(item.name)))) throw new Error(`Planned entity already exists: ${item.name}; use its stable id`);
  for (const id of [...intent.participantIds, ...(intent.pov ? [intent.pov] : [])]) if (!known.has(id) && !introduced.has(id)) throw new Error(`Unknown participant ${id}; declare a new entity or read its formal identity`);
  const factIds = new Set<string>(), entities = new Set([...intent.participantIds, ...(intent.pov ? [intent.pov] : [])].filter(id => known.has(id)));
  const active = currentFacts(state), canon = (id: string) => resolveEntityReference(state, id);
  const fieldKey = (field: string, value = '') => stateField(field, value) ?? field.normalize('NFKC').trim().toLowerCase();
  for (const request of intent.requiredState) for (const field of request.fields) {
    const matches = active.filter(item => item.scope === 'world' && canon(item.subject) === request.entity && (normalized(item.predicate) === normalized(field) || fieldKey(item.predicate, item.object) === fieldKey(field)));
    if (!matches.length) throw new Error(`Required state has no formal evidence: ${request.entity}.${field}; read history or revise the intent`);
    matches.forEach(item => factIds.add(item.id)); entities.add(request.entity);
  }
  const resources = new Set<string>();
  for (const request of intent.requiredResources) {
    const match = state.resources.find(item => canon(item.entity) === request.entity && item.resource === request.resource);
    if (!match) throw new Error(`Required resource has no formal balance: ${request.entity}.${request.resource}`);
    resources.add(resourceKey(match.entity, match.resource)); entities.add(request.entity);
  }
  for (const id of intent.requiredEvents) {
    const event = state.episodes.find(item => item.id === id);
    if (!event) throw new Error(`Unknown required event: ${id}`);
    event.participants.forEach(item => { if (known.has(canon(item))) entities.add(canon(item)); });
  }
  for (const id of intent.requiredHooks) if (!state.hooks.some(item => item.id === id)) throw new Error(`Unknown required hook: ${id}`);
  const gaps: string[] = [];
  for (const check of intent.knowledgeChecks) {
    if (!known.has(check.holder) && !introduced.has(check.holder)) throw new Error(`Unknown knowledge holder: ${check.holder}`);
    if (known.has(check.holder)) entities.add(check.holder);
    const keys = terms(check.topic);
    const matches = active.filter(item => item.scope === 'belief' && item.holder !== null && canon(item.holder) === check.holder && keys.some(term => terms(`${item.subject} ${item.predicate} ${item.object}`).includes(term)));
    matches.forEach(item => factIds.add(item.id));
    if (!matches.length) gaps.push(`${check.holder} / ${check.topic}：没有匹配的登记认知；不代表未知，也不代表已知，须核对获知过程。`);
  }
  for (const item of active) if (item.scope === 'world' && entities.has(canon(item.subject)) && stateField(item.predicate, item.object)) factIds.add(item.id);
  for (const item of state.resources) if (entities.has(canon(item.entity))) resources.add(resourceKey(item.entity, item.resource));
  return { factIds: [...factIds], entityIds: [...entities], eventIds: intent.requiredEvents, hookIds: intent.requiredHooks, resourceKeys: [...resources], knowledgeGaps: gaps };
}

export function intentChecks(intent: ChapterIntent) {
  return [
    { id: 'goal', description: intent.goal, requiresQuote: true },
    ...intent.knowledgeChecks.map((item, index) => ({ id: `knowledge:${index}`, description: `${item.holder} 对 ${item.topic} 的认知须有获知依据；作者知识不可泄漏给角色`, requiresQuote: true })),
    ...intent.withhold.map((description, index) => ({ id: `withhold:${index}`, description, requiresQuote: false })),
    ...(intent.references ?? []).map(reference => ({ id: `reference:${reference.id}`, description: `核对参考用途：${reference.purpose}；保留本书声音与事实边界，不能照搬外书内容或将研究推断当成已发生事实`, requiresQuote: true }))
  ];
}
