import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { atomicWrite, chapterId, hash, identifier, json, positiveInteger, readJson, safePath, writeNew } from './files.js';
import { defaultMemoryQuery, loadConfig } from './init.js';
import { resolveEntityReference } from './entity-reference.js';
import { applyRevision, currentFacts, replay, terms, trustedPrefix } from './memory.js';
import { dirtyFiles, projectViews } from './projections.js';
import { Store } from './store.js';
import { buildGraph, graphIdentity, retrieveGraph, visibleGraph } from './graphrag.js';
import { MicrosoftGraphRag } from './microsoft-graphrag.js';
import { validateDelta, validateReview } from './validation.js';
import { assessRetrieval, criticalClaims, reviewCriticalClaims } from './memory-policy.js';
import { BookVersions } from './versions.js';
import { UsageLedger } from './usage.js';
import { StoryWorkflow, intentChecks, intentQuery, renderIntent, requiredMemory, resourceKey } from './workflow.js';
import type { ChapterDelta, ChapterReview, ContextPackage, ContextSource, MemoryState, Revision, WorkItem } from './types.js';

export class Project {
  readonly root: string;
  readonly store: Store;
  readonly workflow: StoryWorkflow;
  constructor(root: string) {
    this.root = resolve(root);
    loadConfig(this.root);
    this.store = new Store(this.root);
    this.workflow = new StoryWorkflow(this.root, this.store);
  }
  close(): void { this.store.close(); }
  private graphSnapshot(state: MemoryState, revisions: Revision[]) {
    const identity = graphIdentity(revisions, state.atChapter);
    const cached = this.store.cachedGraph(identity.snapshotId);
    if (cached) return cached;
    const graph = buildGraph(state, revisions);
    this.store.cacheGraph(graph);
    return graph;
  }
  private path(...parts: string[]): string { return safePath(this.root, ...parts); }
  private dirty(revisions: Revision[]) {
    const known = new Map(revisions.map(item => [item.chapter, new Set(this.store.history(item.chapter).map(row => row.bodyHash))]));
    return dirtyFiles(this.root, revisions, known);
  }
  private assertClean(): void {
    const dirty = this.dirty(this.store.revisions());
    if (dirty.length) throw new Error(`Accepted prose projection differs: ${dirty.map(item => item.path).join(', ')}. Run sync (or sync --capture to preserve direct edits).`);
  }
  private assertWork(workId: string, chapter?: number): WorkItem {
    const work = this.store.work(identifier(workId));
    if (work.status !== 'active') throw new Error(`Work is archived: ${workId}`);
    if (chapter !== undefined && (chapter < work.fromChapter || chapter > work.toChapter)) throw new Error('Chapter is outside this work range');
    return work;
  }
  private inputSources(workId: string, chapter?: number): ContextSource[] {
    const sources: ContextSource[] = [];
    if (this.workflow.structured && chapter !== undefined) {
      const contract = this.workflow.contract(chapter), intent = this.workflow.readIntent(chapter, workId);
      const markdown = renderIntent(intent), source = this.chapterPaths(workId, chapter).intent;
      if (!existsSync(this.path(source)) || readFileSync(this.path(source), 'utf8') !== markdown) throw new Error('Structured intent changed or was not saved; run intent save before prepare');
      sources.push(...contract.sources.map(item => ({ id: `contract:${contract.id}:${item.name}`, kind: 'spec' as const, source: item.source, content: item.content, hash: item.hash, reason: `作者采用的约定版本 ${contract.id}；不是事件证据`, protection: 'protected' as const })));
      for (const path of intent.planPaths) {
        const content = readFileSync(this.path(path), 'utf8');
        sources.push({ id: path, kind: 'plan', source: path, content, hash: hash(content), reason: '章纲选中的当前计划；不是正式事实', protection: 'compressible' });
      }
      const proposal = `specwriter/work/${workId}/proposal.md`, content = readFileSync(this.path(proposal), 'utf8');
      sources.push({ id: proposal, kind: 'proposal', source: proposal, content, hash: hash(content), reason: '本轮作者意图', protection: 'protected' });
      sources.push({ id: source, kind: 'intent', source, content: markdown, hash: hash(markdown), reason: '已校验的本章目标、依赖与认知边界', protection: 'protected' });
      return sources;
    }
    const walk = (directory: string, kind: 'spec' | 'plan'): void => {
      const path = this.path(directory);
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Linked spec/plan inputs are unsupported: ${child}`);
        if (entry.isDirectory()) walk(child, kind);
        else if (entry.name.endsWith('.md')) {
          const content = readFileSync(this.path(child), 'utf8');
          sources.push({ id: child, kind, source: child, reason: kind === 'spec' ? '创作约定；不能作为正文事件证据' : '未来计划；不能作为已发生事实', content, hash: hash(content), protection: kind === 'spec' ? 'protected' : 'compressible' });
        }
      }
    };
    walk('specwriter/specs', 'spec'); walk('specwriter/plans', 'plan');
    const source = `specwriter/work/${workId}/proposal.md`;
    const content = readFileSync(this.path(source), 'utf8');
    sources.push({ id: source, kind: 'proposal', source, reason: '本轮作者意图', content, hash: hash(content), protection: 'protected' });
    if (chapter !== undefined) {
      const source = this.chapterPaths(workId, chapter).intent;
      const content = readFileSync(this.path(source), 'utf8');
      sources.push({ id: source, kind: 'intent', source, reason: '当前章纲与信息边界；变化后须刷新上下文并重新审阅', content, hash: hash(content), protection: 'protected' });
    }
    return sources;
  }
  private ensureIntent(chapter: number, workId: string, query = '') {
    if (this.workflow.structured) { this.inputSources(workId, chapter); return; }
    writeNew(this.path(this.chapterPaths(workId, chapter).intent), `# 第 ${chapter} 章意图\n\n## 本章目标\n\n${query}\n\n## 冲突与场景安排\n\n## 人物与信息边界\n\n## 必须保留与避免\n\n## 章末变化与伏笔\n`);
  }
  private fingerprint(sources: ContextSource[]): string {
    const { versioning: _versioning, ...config } = loadConfig(this.root);
    return hash(json({ config, sources: sources.map(item => [item.source, item.hash]) }));
  }
  private prepareToken(chapter: number, workId: string): string {
    return hash(json({ generation: this.store.generation(), inputFingerprint: this.fingerprint(this.inputSources(workId, chapter)), chapter, workId,
      ...(this.workflow.structured ? { policy: this.store.policy(workId) } : {}) }));
  }
  private previousEnding(chapter: number): ContextSource {
    const previous = this.store.revisions().find(item => item.chapter === chapter - 1 && !item.stale);
    if (!previous) throw new Error('Previous accepted chapter is missing or stale');
    const content = previous.body.slice(-3000);
    return { id: `previous-ending:${previous.id}`, kind: 'prose', source: `manuscript/chapters/${chapterId(previous.chapter)}.md`, content, hash: hash(content),
      reason: '上一章已接纳结尾；直接衔接必须保留，全文可按需读取', chapter: previous.chapter, revision: previous.id, protection: 'protected' };
  }
  private checkProtectedBudget(chapter: number, workId: string, budget: number): void {
    const intent = this.workflow.readIntent(chapter, workId), state = replay(this.store.revisions(), chapter - 1), required = requiredMemory(state, intent);
    const sources = this.inputSources(workId, chapter).filter(item => item.protection === 'protected');
    if (chapter > 1) sources.push(this.previousEnding(chapter));
    // Lower bound before paid index/query; full context is checked again after retrieval.
    const minimum = json({ sources, workflow: { version: 1, contractId: this.workflow.contract(chapter).id, intentDataHash: hash(json(intent)), intent, requirements: required },
      memory: { facts: currentFacts(state).filter(item => required.factIds.includes(item.id)), entities: state.entities.filter(item => required.entityIds.includes(item.id)),
        episodes: state.episodes.filter(item => required.eventIds.includes(item.id)), hooks: state.hooks.filter(item => required.hookIds.includes(item.id)),
        resources: state.resources.filter(item => required.resourceKeys.includes(resourceKey(item.entity, item.resource))) } }).length;
    if (minimum > budget) throw new Error(`Required memory and protected inputs exceed budget (${minimum} > ${budget}); increase --budget or explicitly narrow the intent`);
  }
  chapterPaths(workId: string, chapter: number): Record<'context' | 'intent' | 'draft' | 'delta' | 'review', string> {
    identifier(workId); positiveInteger(chapter, 'chapter');
    const directory = `specwriter/work/${workId}/chapters/${chapterId(chapter)}`;
    return {
      context: `${directory}/context.json`, intent: `${directory}/intent.md`,
      draft: `manuscript/drafts/${workId}/${chapterId(chapter)}.md`,
      delta: `${directory}/memory-delta.json`, review: `${directory}/review.json`
    };
  }
  status() {
    const revisions = this.store.revisions();
    const trusted = trustedPrefix(revisions);
    const dirty = this.dirty(revisions);
    const generation = this.store.generation();
    const markerPath = this.path('.specwriter', 'projection.json');
    let projectedGeneration: number | null = null;
    try { projectedGeneration = readJson<{ generation: number }>(markerPath).generation; } catch { /* report missing/corrupt projection */ }
    const works = this.store.works();
    const pending = works.filter(work => work.status === 'active').flatMap(work => {
      const result: { workId: string; chapter: number; stage: string; needsRefresh: boolean }[] = [];
      for (let chapter = work.fromChapter; chapter <= work.toChapter; chapter++) {
        const paths = this.chapterPaths(work.id, chapter);
        if (!existsSync(this.path(paths.context))) continue;
        let needsRefresh = true;
        let preparedContext: ContextPackage | undefined;
        try {
          const context = readJson<ContextPackage>(this.path(paths.context));
          preparedContext = context;
          needsRefresh = context.generation !== generation || context.inputFingerprint !== this.fingerprint(this.inputSources(work.id, chapter));
          if (context.retrieval?.receiptId && !context.sources.some(source => source.kind === 'retrieval' && existsSync(this.path(source.source)))) needsRefresh = true;
        } catch { /* report broken draft context */ }
        const revision = revisions.find(item => item.chapter === chapter);
        // A work may contain a prepared revision of an already accepted chapter.
        if (revision?.workId === work.id && !revision.stale) {
          const draftPath = this.path(paths.draft);
          if (existsSync(draftPath) && hash(readFileSync(draftPath, 'utf8')) === revision.bodyHash && preparedContext && json(preparedContext) === json(revision.context)) continue;
        }
        result.push({ workId: work.id, chapter, stage: existsSync(this.path(paths.draft)) && readFileSync(this.path(paths.draft), 'utf8').trim() ? 'draft' : 'prepared', needsRefresh });
      }
      return result;
    });
    return {
      name: loadConfig(this.root).name, generation, acceptedChapters: revisions.length,
      memoryBackend: loadConfig(this.root).memory!.backend,
      graphRagConfigured: existsSync(this.path('.specwriter', 'graphrag', 'provider.json')),
      backup: new BookVersions(this.root).status(this),
      memoryThrough: trusted.length, nextChapter: trusted.length + 1,
      staleChapters: revisions.filter(item => item.stale).map(item => item.chapter),
      dirtyFiles: dirty, projectionNeedsSync: projectedGeneration !== generation,
      works, pending,
      workflow: { mode: this.workflow.structured ? 'structured' : 'legacy', contracts: this.store.contracts().map(item => ({ id: item.id, fromChapter: item.fromChapter })), policies: works.map(work => this.store.policy(work.id)).filter(Boolean) },
      nextAction: dirty.length ? 'sync; modified prose requires sync --capture' : trusted.length < revisions.length ? `reconcile chapter ${trusted.length + 1}` : `prepare chapter ${trusted.length + 1}`
    };
  }
  /** Recover from canonical files, never from a remembered conversation or a model call. */
  resume(workId?: string) {
    const status = this.status(), active = status.works.filter(item => item.status === 'active');
    const work = workId ? this.assertWork(workId) : active.length === 1 ? active[0] : undefined;
    const result = { status, work: work ?? null, policy: work ? this.store.policy(work.id) ?? null : null,
      usageBudget: new UsageLedger(this.root).budget() ?? null,
      chapter: null as number | null, stage: 'select-work', paths: null as Record<string, string> | null, nextAction: '', detail: '' };
    if (status.dirtyFiles.length) return { ...result, stage: 'sync', nextAction: 'sync --capture', detail: 'Preserve modified accepted prose before recovering the writing task.' };
    if (status.projectionNeedsSync) return { ...result, stage: 'sync', nextAction: 'sync', detail: 'Rebuild readable projections before advancing.' };
    if (!work) return { ...result, nextAction: active.length ? 'resume --work ID' : 'propose ID --title TITLE --from N --to N', detail: active.length ? 'Select the intended active work; no task was chosen automatically.' : 'Choose a new scope from the author instruction.' };
    const next = status.nextChapter;
    const pending = status.pending.filter(item => item.workId === work.id && item.chapter <= next).sort((a,b) => a.chapter - b.chapter)[0];
    const chapter = pending?.chapter ?? Math.max(work.fromChapter, next);
    if (chapter > work.toChapter) return { ...result, stage: 'complete', nextAction: `archive ${work.id}`, detail: 'This work range is reconciled; obtain new scope before writing beyond it.' };
    result.chapter = chapter;
    result.paths = { ...this.chapterPaths(work.id, chapter), intentData: this.workflow.intentPath(chapter, work.id) };
    if (chapter > next) return { ...result, stage: 'reconcile', nextAction: `resume --work ID`, detail: `Chapter ${next} must be accepted/reconciled first; select work covering it.` };
    if (this.workflow.structured) {
      try { this.workflow.contract(chapter); }
      catch (error) { return { ...result, stage: 'contract', nextAction: 'contract adopt --reason AUTHOR_INSTRUCTION', detail: (error as Error).message }; }
      const policy = result.policy;
      if (policy?.paused) return { ...result, stage: 'paused', nextAction: `work resume ${work.id} --reason AUTHOR_INSTRUCTION`, detail: `Paused: ${policy.pauseReason}; review is available, advancement requires author instruction.` };
      if (!policy || chapter < policy.fromChapter || chapter > policy.toChapter) return { ...result, stage: 'authorize', nextAction: `work authorize ${work.id} --from ${chapter} --to ${work.toChapter} --acceptance draft --reason AUTHOR_INSTRUCTION`, detail: 'Record the actual author scope and acceptance mode; do not invent authorization.' };
      try { this.workflow.readIntent(chapter, work.id); this.inputSources(work.id, chapter); }
      catch (error) { return { ...result, stage: 'intent', nextAction: existsSync(this.path(result.paths.intentData!)) ? `intent save ${chapter} --work ${work.id}` : `intent seed ${chapter} --work ${work.id}`, detail: (error as Error).message }; }
    }
    const paths = result.paths;
    if (!existsSync(this.path(paths.context!))) return { ...result, stage: 'prepare', nextAction: `prepare ${chapter} --work ${work.id}` };
    let context: ContextPackage;
    try {
      context = readJson<ContextPackage>(this.path(paths.context!));
      if (context.contextHash !== this.buildContext(chapter, work.id, context.query, context.budgetChars).contextHash || hash(json({ ...context, contextHash: '' })) !== context.contextHash) throw new Error('Context is stale or modified');
    } catch (error) { return { ...result, stage: 'refresh', nextAction: `prepare ${chapter} --work ${work.id} --refresh`, detail: (error as Error).message }; }
    if (!existsSync(this.path(paths.draft!)) || !readFileSync(this.path(paths.draft!), 'utf8').trim()) return { ...result, stage: 'write', nextAction: '$specwriter-write', detail: 'Write the draft from the prepared intent and context.' };
    try {
      const delta: unknown = readJson(this.path(paths.delta!)); validateDelta(delta, readFileSync(this.path(paths.draft!), 'utf8'));
      const hashes = this.hashes(chapter, work.id);
      if (delta.contextHash !== hashes.contextHash || delta.draftHash !== hashes.draftHash || delta.intentHash !== hashes.intentHash) throw new Error('Extraction hashes are outdated');
    } catch (error) { return { ...result, stage: 'extract', nextAction: '$specwriter-write', detail: (error as Error).message }; }
    try { this.verified(chapter, work.id); }
    catch (error) { return { ...result, stage: 'review', nextAction: '$specwriter-review', detail: (error as Error).message }; }
    if (this.workflow.structured && result.policy?.acceptance !== 'auto') return { ...result, stage: 'await-acceptance', nextAction: '$specwriter-commit', detail: 'Reviewed draft is ready for author inspection. Record explicit acceptance before commit.' };
    return { ...result, stage: 'commit', nextAction: `commit ${chapter} --work ${work.id}`, detail: 'All deterministic checks pass within the recorded acceptance scope.' };
  }
  /** Cheap preflight before external index/query calls; no model runs under the DB lock. */
  prepareRequest(chapter: number, workId: string, options: { query?: string; budget?: number } = {}) {
    return this.store.transaction(() => {
      positiveInteger(chapter, 'chapter'); this.assertWork(workId, chapter); this.assertClean();
      const revisions = this.store.revisions();
      if (chapter > trustedPrefix(revisions).length + 1) throw new Error(`Prepare chapter ${trustedPrefix(revisions).length + 1} first; no gaps or unreconciled dependencies`);
      const config = loadConfig(this.root);
      positiveInteger(options.budget ?? config.contextBudgetChars, 'budget');
      this.workflow.assertAdvance(chapter, workId);
      const intent = this.workflow.structured ? this.workflow.readIntent(chapter, workId) : undefined;
      if (intent) requiredMemory(replay(revisions, chapter - 1), intent);
      const query = options.query?.trim() || (intent ? intentQuery(intent) : config.memory!.backend === 'microsoft-graphrag' ? defaultMemoryQuery : '');
      this.ensureIntent(chapter, workId, query);
      if (intent) this.checkProtectedBudget(chapter, workId, options.budget ?? config.contextBudgetChars);
      return { chapter, atChapter: chapter - 1, query, backend: config.memory!.backend, method: config.memory!.method!, autoIndex: config.memory!.autoIndex!,
        token: this.prepareToken(chapter, workId) };
    });
  }
  propose(workId: string, title: string, from: number, to: number): WorkItem {
    this.assertClean();
    identifier(workId); positiveInteger(from, 'from'); positiveInteger(to, 'to');
    if (to < from || to - from > 999) throw new Error('Work range must contain 1–1000 chapters');
    if (!title.trim()) throw new Error('Work title is required');
    const work: WorkItem = { id: workId, title, fromChapter: from, toChapter: to, status: 'active' };
    this.store.transaction(() => {
      if (this.store.works().some(item => item.id === workId)) throw new Error(`Work already exists: ${workId}`);
      // Scaffold first; a failed DB transaction leaves recoverable author files, never overwrites them.
      writeNew(this.path('specwriter', 'work', workId, 'proposal.md'), `# ${title}\n\n范围：第 ${from}–${to} 章。\n\n## 作者意图与读者体验\n\n## 必须保留与避免\n\n## 计划与场景方向\n\n## 创作约定变更（如有）\n\n## 完成后回顾与遗留问题\n`);
      this.store.addWork(work);
      projectViews(this.root, this.store.revisions(), this.store.works(), this.store.generation());
    });
    return work;
  }
  private buildContext(chapter: number, workId: string, query: string, budgetChars: number): ContextPackage {
    this.assertWork(workId, chapter); this.assertClean();
    positiveInteger(chapter, 'chapter'); positiveInteger(budgetChars, 'budget');
    const revisions = this.store.revisions();
    const through = trustedPrefix(revisions).length;
    if (chapter > through + 1) throw new Error(`Prepare chapter ${through + 1} first; no gaps or unreconciled dependencies`);
    const fullMemory = replay(revisions, chapter - 1);
    const config = loadConfig(this.root);
    const intent = this.workflow.structured ? this.workflow.readIntent(chapter, workId) : undefined;
    const requirements = intent ? requiredMemory(fullMemory, intent) : undefined;
    const pinnedFacts = new Set(requirements?.factIds), pinnedHooks = new Set(requirements?.hookIds), pinnedEvents = new Set(requirements?.eventIds), pinnedEntities = new Set(requirements?.entityIds), pinnedResources = new Set(requirements?.resourceKeys);
    const microsoft = config.memory!.backend === 'microsoft-graphrag';
    const semantic = microsoft && chapter > 1 ? new MicrosoftGraphRag(this).cachedQuery(query, { at: chapter - 1, method: config.memory!.method }) : undefined;
    if (microsoft && chapter > 1 && !semantic) throw new Error('Microsoft GraphRAG retrieval is not prepared. Use WriterMemory.prepare or the specwriter prepare CLI to index and retrieve before building chapter artifacts');
    const assessment = semantic ? assessRetrieval(semantic, fullMemory) : undefined;
    const activeFacts = currentFacts(fullMemory);
    const queryTerms = new Set(terms(query));
    const recentCharacters = new Set(fullMemory.summaries.slice(-2).flatMap(item => item.characters).map(item => resolveEntityReference(fullMemory, item)));
    const matchScore = (text: string): number => terms(text).filter(term => queryTerms.has(term)).length;
    const retrieval = retrieveGraph(this.graphSnapshot(fullMemory, revisions), query, { hops: 2, maxNodes: 40, maxEdges: 60 });
    const linked = new Set(retrieval.edges.flatMap(item => item.factId ? [item.factId] : []));
    const factScores = new Map(activeFacts.map(item => [item.id, (pinnedFacts.has(item.id) ? 1000000 : 0) + matchScore(`${item.subject} ${item.predicate} ${item.object}`) * 10 + (linked.has(item.id) ? 5 : 0) + (recentCharacters.has(resolveEntityReference(fullMemory, item.subject)) || (item.holder !== null && recentCharacters.has(resolveEntityReference(fullMemory, item.holder))) ? 3 : 0)]));
    const rankedFacts = [...activeFacts].sort((a, b) => factScores.get(b.id)! - factScores.get(a.id)! || b.sourceChapter - a.sourceChapter || a.id.localeCompare(b.id));
    const rankedHooks = [...fullMemory.hooks].sort((a, b) => Number(pinnedHooks.has(b.id)) - Number(pinnedHooks.has(a.id)) || matchScore(`${b.id} ${b.description}`) - matchScore(`${a.id} ${a.description}`) || Number(a.status === 'resolved' || a.status === 'superseded') - Number(b.status === 'resolved' || b.status === 'superseded') || b.sourceChapter - a.sourceChapter);
    const selectedNodeIds = new Set(retrieval.nodes.flatMap(node => node.recordId ? [node.recordId] : []));
    const selectedEpisodes = [...fullMemory.episodes].sort((a, b) => Number(pinnedEvents.has(b.id)) - Number(pinnedEvents.has(a.id)) || Number(selectedNodeIds.has(b.id)) - Number(selectedNodeIds.has(a.id)) || b.sourceChapter - a.sourceChapter).slice(0, Math.max(20, pinnedEvents.size));
    const selectedEntities = fullMemory.entities.filter(entity => pinnedEntities.has(entity.id) || selectedNodeIds.has(entity.id) || recentCharacters.has(entity.id));
    const memory = { ...fullMemory, facts: rankedFacts, hooks: rankedHooks, entities: selectedEntities, episodes: selectedEpisodes, resources: fullMemory.resources.filter(resource => pinnedResources.has(resourceKey(resource.entity, resource.resource)) || queryTerms.has(resource.entity) || selectedNodeIds.has(json([resource.entity, resource.resource]).trim())), timeline: fullMemory.timeline.slice(-20), summaries: fullMemory.summaries.slice(-5) };
    const inputs = this.inputSources(workId, chapter);
    const baseRevision = revisions.find(item => item.chapter === chapter)?.id ?? null;
    const selected: ContextSource[] = inputs.filter(item => item.protection === 'protected');
    if (intent && chapter > 1) selected.push(this.previousEnding(chapter));
    const context: ContextPackage = {
      schemaVersion: 1, contractVersion: 2, reviewPolicyVersion: 1, intentHash: inputs.find(item => item.kind === 'intent')!.hash, chapter, workId, baseRevision, generation: this.store.generation(),
      inputFingerprint: this.fingerprint(inputs), query, budgetChars, selectedChars: 0,
      ...(intent ? { workflow: { version: 1 as const, contractId: this.workflow.contract(chapter).id, intentDataHash: hash(json(intent)), intent, requirements: requirements! } } : {}),
      memory, memorySelection: { strategy: microsoft ? 'microsoft-graphrag' : 'hybrid-graphrag', totalActiveFacts: activeFacts.length, selectedFacts: memory.facts.length, totalHooks: fullMemory.hooks.length, selectedHooks: memory.hooks.length, totalEpisodes: fullMemory.episodes.length, selectedEpisodes: memory.episodes.length },
      retrieval: { engine: microsoft ? 'microsoft-graphrag' : retrieval.engine, snapshotId: retrieval.snapshotId, hops: retrieval.hops, seedIds: retrieval.seedIds, paths: retrieval.paths.slice(0, 8),
        ...(microsoft ? { status: semantic ? 'ready' as const : 'empty' as const, method: config.memory!.method,
          ...(semantic ? { receiptId: semantic.id, answerHash: semantic.answerHash, configHash: semantic.configHash, outputHash: semantic.outputHash, assessment } : {}) } : {}) }, sources: selected, contextHash: ''
    };
    const size = (): number => json(context).length;
    // Bound selection, not the persistent memory. Low-ranked records stay available through query/show.
    const selectionBudget = Math.floor(budgetChars * 0.7);
    const trim = <T>(items: T[], protectedItem: (item: T) => boolean, minimum = 0) => {
      while (size() > selectionBudget && items.length > minimum) {
        const index = items.findLastIndex(item => !protectedItem(item));
        if (index < 0) break;
        items.splice(index, 1);
      }
    };
    trim(memory.facts, item => pinnedFacts.has(item.id), 1);
    trim(memory.hooks, item => pinnedHooks.has(item.id), 1);
    trim(memory.episodes, item => pinnedEvents.has(item.id));
    trim(memory.entities, item => pinnedEntities.has(item.id));
    trim(memory.resources, item => pinnedResources.has(resourceKey(item.entity, item.resource)));
    while (size() > selectionBudget && context.retrieval!.paths.length) context.retrieval!.paths.pop();
    while (size() > selectionBudget && memory.summaries.length > 1) memory.summaries.shift();
    while (size() > selectionBudget && memory.timeline.length) memory.timeline.shift();
    context.memorySelection.selectedFacts = memory.facts.length;
    context.memorySelection.selectedHooks = memory.hooks.length;
    context.memorySelection.selectedEpisodes = memory.episodes.length;
    if (size() > budgetChars) throw new Error('Protected specs and selected memory exceed context character budget; explicitly increase --budget or shorten the creative constraints');
    if (semantic) {
      const maxChars = Math.min(6000, Math.floor((budgetChars - size() - 1000) / 2));
      if (maxChars < Math.min(200, semantic.answer.length)) throw new Error('Context has no room for default GraphRAG retrieval; increase --budget or shorten protected specs');
      const answer = assessment!.accepted ? semantic.answer : `Microsoft GraphRAG 回答未采用：${assessment!.warnings.join(' ')} 请核对以下正式记忆和原文；原始回答保留在查询记录中。`;
      const content = answer.slice(0, maxChars);
      context.retrieval!.answerTruncated = content.length < answer.length;
      selected.push({ id: semantic.id, kind: 'retrieval', source: `.specwriter/graphrag/snapshots/${semantic.snapshotId}/queries/${semantic.id}.json`, reason: 'Microsoft GraphRAG 默认检索；核对 assessment，正式状态优先。未通过证据/冲突核对的回答不进入本章上下文。', content, hash: hash(content), protection: 'compressible' });
    }
    for (const source of inputs.filter(item => item.protection === 'compressible')) {
      selected.push(source);
      if (size() > budgetChars) {
        selected.pop();
        // A literal excerpt, labeled as truncated. Full file stays available to the Agent.
        const room = budgetChars - size() - 500;
        if (room > 200) selected.push({ ...source, content: source.content.slice(0, Math.floor(room / 2)), reason: source.reason + '；预算限制，仅提供前段，请按需读取完整计划' });
      }
    }
    const hits = this.store.search(query, chapter - 1, 8);
    for (const citation of semantic?.sources ?? []) {
      if (!citation.excerpt || hits.some(hit => hit.revision === citation.revision && hit.excerpt.includes(citation.excerpt))) continue;
      const revision = revisions.find(item => item.id === citation.revision && item.chapter === citation.chapter && item.bodyHash === citation.bodyHash);
      if (!revision || revision.chapter >= chapter || !revision.body.includes(citation.excerpt)) throw new Error('Semantic citation is outside this chapter prefix');
      hits.unshift({ chapter: citation.chapter, revision: citation.revision, source: `manuscript/chapters/${chapterId(citation.chapter)}.md`, line: revision.body.slice(0, revision.body.indexOf(citation.excerpt)).split('\n').length, excerpt: citation.excerpt, score: 0 });
    }
    // Recent prose is useful even when the chapter goal has no searchable keywords.
    if (!hits.length && chapter > 1) {
      const previous = revisions.find(item => item.chapter === chapter - 1)!;
      const offset = Math.max(0, previous.body.length - 3000);
      hits.push({ chapter: previous.chapter, revision: previous.id, source: `manuscript/chapters/${chapterId(previous.chapter)}.md`, line: previous.body.slice(0, offset).split('\n').length, excerpt: previous.body.slice(offset), score: 0 });
    }
    for (const hit of hits) {
      const source: ContextSource = { id: `revision:${hit.revision}:line:${hit.line}:${hash(hit.excerpt).slice(0, 12)}`, kind: 'prose', source: hit.source, reason: `已接纳原文；检索分数 ${hit.score.toFixed(3)}`, content: hit.excerpt, hash: hash(hit.excerpt), chapter: hit.chapter, revision: hit.revision, protection: 'compressible' };
      selected.push(source); if (size() > budgetChars) selected.pop();
    }
    context.selectedChars = size();
    context.contextHash = hash(json({ ...context, contextHash: '' }));
    // Account for filled counters/hash without pretending character counts are model tokens.
    context.selectedChars = json(context).length;
    context.contextHash = hash(json({ ...context, contextHash: '' }));
    if (json(context).length > budgetChars) throw new Error('Context exceeds budget after metadata; increase --budget');
    return context;
  }
  prepare(chapter: number, workId: string, options: { query?: string; budget?: number; refresh?: boolean; expectedToken?: string } = {}) {
    return this.store.transaction(() => this.prepareArtifacts(chapter, workId, options));
  }
  private prepareArtifacts(chapter: number, workId: string, options: { query?: string; budget?: number; refresh?: boolean; expectedToken?: string }) {
    this.assertWork(workId, chapter); this.assertClean();
    this.workflow.assertAdvance(chapter, workId);
    this.ensureIntent(chapter, workId, options.query);
    const token = this.prepareToken(chapter, workId);
    if (options.expectedToken && options.expectedToken !== token) throw new Error('Book or creative inputs changed during GraphRAG preparation; retry prepare with current inputs');
    const paths = this.chapterPaths(workId, chapter);
    const config = loadConfig(this.root);
    const query = options.query?.trim() || (this.workflow.structured ? intentQuery(this.workflow.readIntent(chapter, workId)) : config.memory!.backend === 'microsoft-graphrag' ? defaultMemoryQuery : '');
    const context = this.buildContext(chapter, workId, query, options.budget ?? config.contextBudgetChars);
    const contextPath = this.path(paths.context);
    if (existsSync(contextPath) && !options.refresh) {
      const old = readJson<ContextPackage>(contextPath);
      if (old.contextHash !== context.contextHash) throw new Error('Prepared context changed; use prepare --refresh. Draft is preserved; extraction and review will be reset.');
    }
    const delta = {
      schemaVersion: 2, chapter, baseRevision: context.baseRevision, contextHash: context.contextHash, intentHash: context.intentHash, draftHash: '',
      title: '', summary: '', characters: [], key_events: [], timeline_events: [], foreshadow_updates: [], relationship_changes: [], state_changes: [], cast_intros: [], facts: [], entities: [], narrative_events: [], resource_changes: []
    };
    const review = { schemaVersion: 2, chapter, contextHash: context.contextHash, intentHash: context.intentHash, draftHash: '', reviewed: false, issues: [], notes: [], critical_checks: [],
      ...(context.workflow ? { intent_checks: [] } : {}),
      ...(context.retrieval?.assessment && !context.retrieval.assessment.accepted ? { retrieval_check: { assessmentHash: context.retrieval.assessment.assessmentHash, decision: 'use-formal-memory', notes: '' } } : {}),
      checks: { evidence: { checked: false, notes: [] }, coverage: { checked: false, notes: [] }, continuity: { checked: false, notes: [] } } };
    const reset = (path: string, value: string): void => {
      if (options.refresh) {
        if (existsSync(path)) writeNew(`${path}.${hash(readFileSync(path, 'utf8')).slice(0, 12)}.bak`, readFileSync(path, 'utf8'));
        atomicWrite(path, value);
      } else writeNew(path, value);
    };
    atomicWrite(contextPath, json(context));
    reset(this.path(paths.delta), json(delta)); reset(this.path(paths.review), json(review));
    const existing = this.store.revisions().find(item => item.chapter === chapter);
    writeNew(this.path(paths.draft), existing?.body ?? '');
    return { chapter, workId, paths, contextHash: context.contextHash, baseRevision: context.baseRevision, ...(context.retrieval?.assessment ? { retrievalAssessment: context.retrieval.assessment } : {}) };
  }
  hashes(chapter: number, workId: string) {
    const paths = this.chapterPaths(workId, chapter);
    const context = readJson<ContextPackage>(this.path(paths.context));
    return { chapter, baseRevision: context.baseRevision, contextHash: context.contextHash, intentHash: hash(readFileSync(this.path(paths.intent), 'utf8')), draftHash: hash(readFileSync(this.path(paths.draft), 'utf8')) };
  }
  reviewRequirements(chapter: number, workId: string) {
    this.assertWork(workId, chapter);
    const paths = this.chapterPaths(workId, chapter);
    const delta: unknown = readJson(this.path(paths.delta));
    validateDelta(delta, readFileSync(this.path(paths.draft), 'utf8'));
    const context = readJson<ContextPackage>(this.path(paths.context));
    return { ...this.hashes(chapter, workId), criticalClaims: criticalClaims(delta), retrievalAssessment: context.retrieval?.assessment ?? null,
      intentChecks: context.workflow ? intentChecks(context.workflow.intent) : [] };
  }
  private verified(chapter: number, workId: string) {
    const paths = this.chapterPaths(workId, chapter);
    this.assertWork(workId, chapter); this.assertClean();
    const context = readJson<ContextPackage>(this.path(paths.context));
    const expected = this.buildContext(chapter, workId, context.query, context.budgetChars);
    if (context.contextHash !== expected.contextHash || hash(json({ ...context, contextHash: '' })) !== context.contextHash) throw new Error('Context is stale or modified; prepare --refresh and re-extract/review');
    const body = readFileSync(this.path(paths.draft), 'utf8');
    if (!body.trim()) throw new Error('Draft is empty');
    const delta: unknown = readJson(this.path(paths.delta));
    const review: unknown = readJson(this.path(paths.review));
    validateDelta(delta, body); validateReview(review);
    if (context.workflow) {
      const expectedChecks = intentChecks(context.workflow.intent), checks = review.intent_checks ?? [];
      const ids = new Set(checks.map(item => item.id));
      if (ids.size !== checks.length || checks.some(item => !expectedChecks.some(expected => expected.id === item.id))) throw new Error('Duplicate or outdated intent review; review the current chapter intent');
      for (const expected of expectedChecks) {
        const check = checks.find(item => item.id === expected.id);
        if (!check || check.verdict !== 'satisfied' || !check.explanation.trim() || (expected.requiresQuote && !check.evidenceQuotes.length)
          || check.evidenceQuotes.some(quote => !quote.trim() || !body.includes(quote))) throw new Error(`Intent requires a completed, prose-specific review: ${expected.id} / ${expected.description}`);
      }
    }
    if (context.reviewPolicyVersion === 1) {
      reviewCriticalClaims(delta, review);
      const assessment = context.retrieval?.assessment;
      if (assessment && !assessment.accepted && (review.retrieval_check?.assessmentHash !== assessment.assessmentHash || review.retrieval_check.decision !== 'use-formal-memory' || !review.retrieval_check.notes.trim())) throw new Error('Retrieval evidence/conflicts require an explicit review against formal memory and original prose');
    }
    if (context.contractVersion === 2 && (delta.schemaVersion !== 2 || review.schemaVersion !== 2 || delta.intentHash !== context.intentHash || review.intentHash !== context.intentHash)) throw new Error('Prepared V2 chapters require V2 extraction/review bound to the current intentHash');
    if (delta.chapter !== chapter || review.chapter !== chapter) throw new Error('Chapter identity mismatch');
    if (delta.baseRevision !== context.baseRevision) throw new Error('Delta baseRevision mismatch');
    for (const item of [delta, review]) {
      if (item.contextHash !== context.contextHash || item.draftHash !== hash(body)) throw new Error('Extraction/review is bound to a different context or draft');
    }
    const state = replay(this.store.revisions(), chapter - 1);
    const proposed: Revision = { id: -1, chapter, body, bodyHash: hash(body), delta, review, context, workId, acceptedAt: '', stale: false };
    applyRevision(state, proposed); // Validate state preconditions and hook transitions before any commit.
    return { body, delta, review, context };
  }
  verify(chapter: number, workId: string) {
    return this.store.transaction(() => {
      const { delta, review } = this.verified(chapter, workId);
      return { valid: true, chapter, warnings: review.issues.filter(item => item.severity !== 'blocking' && !item.resolved), factCount: delta.facts.length + delta.state_changes.length + delta.relationship_changes.length + delta.cast_intros.length, eventCount: delta.narrative_events?.length ?? 0 };
    });
  }
  commit(chapter: number, workId: string) {
    const accepted = this.store.transaction(() => {
      this.workflow.assertAdvance(chapter, workId, true);
      const input = this.verified(chapter, workId);
      if (input.context.workflow) for (const item of input.context.workflow.intent.newEntities.filter(entity => {
        const intent = input.context.workflow!.intent;
        return intent.participantIds.includes(entity.id) || intent.pov === entity.id || intent.knowledgeChecks.some(check => check.holder === entity.id);
      })) {
        if (!input.delta.entities?.some(entity => entity.id === item.id && entity.name === item.name && entity.type === item.type)) throw new Error(`Planned participant needs a supported entity record: ${item.id}`);
      }
      const revision = this.store.accept(input.body, input.delta, input.review, input.context, workId);
      const revisions = this.store.revisions();
      this.graphSnapshot(replay(revisions), revisions);
      return { chapter, revision, generation: this.store.generation(), staleChapters: this.store.revisions().filter(item => item.stale).map(item => item.chapter) };
    });
    // DB acceptance is authoritative. File projection failures are recoverable, not a failed acceptance.
    try { this.sync(); }
    catch (error) { return { ...accepted, projectionNeedsSync: true, warning: (error as Error).message }; }
    const versioning = loadConfig(this.root).versioning;
    if (versioning?.enabled && versioning.autoSave) {
      try { return { ...accepted, projectionNeedsSync: false, versionCheckpoint: new BookVersions(this.root).save(this, `接纳第 ${chapter} 章：${this.store.revisions().find(item => item.chapter === chapter)!.delta.title}`) }; }
      catch (error) { return { ...accepted, projectionNeedsSync: false, versionCheckpoint: { saved: false, warning: (error as Error).message }, versionNeedsSave: true }; }
    }
    return { ...accepted, projectionNeedsSync: false };
  }
  sync(options: { capture?: boolean } = {}) {
    return this.store.transaction(() => {
      const revisions = this.store.revisions();
      const dirty = this.dirty(revisions);
      const modified = dirty.filter(item => item.kind === 'modified');
      if (modified.length && !options.capture) throw new Error('Direct edits detected. Use sync --capture to preserve modified prose as drafts before restoring accepted versions.');
      const captured: string[] = [];
      for (const item of modified) {
        const body = readFileSync(this.path(item.path), 'utf8');
        const destination = `manuscript/drafts/imported/${chapterId(item.chapter)}-${hash(body).slice(0, 16)}.md`;
        const target = this.path(destination);
        if (existsSync(target) && readFileSync(target, 'utf8') !== body) throw new Error('Captured draft hash collision');
        writeNew(target, body); captured.push(destination);
      }
      for (const revision of revisions) {
        // Modified files are only overwritten after their content has been preserved above.
        const path = this.path('manuscript', 'chapters', `${chapterId(revision.chapter)}.md`);
        if (!existsSync(path) || hash(readFileSync(path, 'utf8')) !== revision.bodyHash) atomicWrite(path, revision.body);
      }
      projectViews(this.root, revisions, this.store.works(), this.store.generation());
      return { generation: this.store.generation(), memoryThrough: trustedPrefix(revisions).length, captured };
    });
  }
  memory(atChapter?: number) { return replay(this.store.revisions(), atChapter); }
  /** Immutable accepted-prefix corpus; drafts, plans and stale later chapters are excluded. */
  corpus(atChapter?: number) {
    const read = () => {
      this.assertClean();
      const revisions = this.store.revisions();
      const state = replay(revisions, atChapter);
      return { ...graphIdentity(revisions, state.atChapter), atChapter: state.atChapter,
        documents: revisions.filter(item => item.chapter <= state.atChapter).map(item => ({
          chapter: item.chapter, revision: item.id, bodyHash: item.bodyHash, body: item.body
        })) };
    };
    // Verification already owns a transaction. Corpus reads must share that snapshot.
    return this.store.db.isTransaction ? read() : this.store.transaction(read);
  }
  graph(atChapter?: number, holder?: string) {
    return this.store.transaction(() => {
      this.assertClean();
      const revisions = this.store.revisions();
      const state = replay(revisions, atChapter);
      return visibleGraph(this.graphSnapshot(state, revisions), holder === undefined ? undefined : resolveEntityReference(state, holder));
    });
  }
  query(query: string, options: { at?: number; holder?: string; limit?: number; hops?: number; expectedSnapshotId?: string } = {}) {
    return this.store.transaction(() => {
      this.assertClean();
      const revisions = this.store.revisions();
      const state = replay(revisions, options.at);
      const holder = options.holder === undefined ? undefined : resolveEntityReference(state, options.holder);
      const graph = retrieveGraph(this.graphSnapshot(state, revisions), query, { holder, hops: options.hops });
      if (options.expectedSnapshotId && graph.snapshotId !== options.expectedSnapshotId) throw new Error('Accepted chapters changed before structural memory retrieval; retry the semantic query');
      const factIds = new Set(graph.edges.flatMap(edge => edge.factId ? [edge.factId] : []));
      const facts = currentFacts(state).filter(fact => factIds.has(fact.id));
      const recordIds = new Set(graph.nodes.flatMap(node => node.recordId ? [node.recordId] : []));
      const episodes = state.episodes.filter(event => recordIds.has(event.id) && (event.scope === 'world' || (event.holder !== null && resolveEntityReference(state, event.holder, false) === holder)));
      const entities = state.entities.filter(entity => recordIds.has(entity.id));
      const hooks = state.hooks.filter(hook => recordIds.has(hook.id));
      const resources = state.resources.filter(resource => recordIds.has(json([resource.entity, resource.resource]).trim()));
      const passages = this.store.search(query, state.atChapter, options.limit ?? 8);
      // Multi-hop discoveries contribute literal source evidence even if query words miss that passage.
      for (const evidence of [...graph.edges, ...entities, ...episodes, ...hooks, ...resources]) {
        if (passages.length >= (options.limit ?? 8)) break;
        if (passages.some(hit => hit.revision === evidence.sourceRevision && hit.excerpt.includes(evidence.evidence.quote))) continue;
        const revision = revisions.find(item => item.id === evidence.sourceRevision);
        if (!revision || revision.chapter > state.atChapter || !revision.body.includes(evidence.evidence.quote)) continue;
        passages.push({ chapter: revision.chapter, revision: revision.id, source: `manuscript/chapters/${chapterId(revision.chapter)}.md`, line: revision.body.slice(0, revision.body.indexOf(evidence.evidence.quote)).split('\n').length, excerpt: evidence.evidence.quote, score: 0 });
      }
      return { engine: graph.engine, generation: this.store.generation(), atChapter: state.atChapter, facts, entities, episodes, hooks, resources, passages, graph };
    });
  }
  rebuildSearch() {
    this.store.transaction(() => {
      this.store.rebuildSearch(); this.store.clearGraphCache();
      const revisions = this.store.revisions(); this.graphSnapshot(replay(revisions), revisions);
    });
    return { rebuilt: true, generation: this.store.generation() };
  }
  archive(workId: string) {
    return this.store.transaction(() => {
      const work = this.store.work(identifier(workId)); this.assertClean();
      const revisions = this.store.revisions();
      for (let chapter = work.fromChapter; chapter <= work.toChapter; chapter++) {
        if (!trustedPrefix(revisions).some(item => item.chapter === chapter)) throw new Error(`Cannot archive incomplete work; chapter ${chapter} is not reconciled`);
      }
      const destination = this.path('specwriter', 'archive', workId);
      if (work.status === 'active') {
        const source = this.path('specwriter', 'work', workId);
        const copy = (directory: string): void => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = safePath(this.root, relative(this.root, join(directory, entry.name)));
            if (entry.isSymbolicLink()) throw new Error('Archive cannot follow linked work files');
            if (entry.isDirectory()) copy(file);
            else atomicWrite(safePath(destination, relative(source, file)), readFileSync(file, 'utf8'));
          }
        };
        copy(source);
        atomicWrite(safePath(destination, 'tasks.md'), `# ${work.title}\n\n状态：archived\n\n` + Array.from({ length: work.toChapter - work.fromChapter + 1 }, (_, index) => `- [x] 第 ${work.fromChapter + index} 章：正文接纳与记忆同步`).join('\n') + '\n');
        atomicWrite(safePath(destination, 'manifest.json'), json({ work: { ...work, status: 'archived' }, closedAt: new Date().toISOString(), generation: this.store.generation(), chapters: revisions.filter(item => item.chapter >= work.fromChapter && item.chapter <= work.toChapter).map(item => ({ chapter: item.chapter, revision: item.id, bodyHash: item.bodyHash })) }));
        this.store.archiveWork(workId);
        atomicWrite(safePath(source, 'tasks.md'), `# ${work.title}\n\n状态：archived。文档快照位于 specwriter/archive/${workId}。\n`);
      }
      projectViews(this.root, revisions, this.store.works(), this.store.generation());
      return { workId, status: 'archived', directory: relative(this.root, destination).replaceAll('\\', '/'), generation: this.store.generation() };
    });
  }
  doctor() {
    const integrity = this.store.db.prepare('PRAGMA integrity_check').all();
    const errors: string[] = [];
    const warnings: string[] = [];
    if (JSON.stringify(integrity) !== JSON.stringify([{ integrity_check: 'ok' }])) errors.push('SQLite integrity check failed');
    const status = this.status();
    errors.push(...status.dirtyFiles.map(item => `${item.kind}: ${item.path}`));
    if (status.staleChapters.length) warnings.push(`Memory reconciliation required for chapters ${status.staleChapters.join(', ')}`);
    if (status.projectionNeedsSync) warnings.push('Readable projections need sync');
    if (status.memoryBackend === 'microsoft-graphrag' && !status.graphRagConfigured) warnings.push('Default Microsoft GraphRAG needs provider setup and model credentials before retrieving accepted chapters');
    for (const revision of this.store.revisions()) {
      if (hash(revision.body) !== revision.bodyHash) errors.push(`Stored body hash mismatch: ${revision.chapter}`);
      try { validateDelta(revision.delta, revision.body); validateReview(revision.review); }
      catch (error) { errors.push(`Revision ${revision.id}: ${(error as Error).message}`); }
    }
    try { replay(this.store.revisions()); } catch (error) { errors.push((error as Error).message); }
    return { healthy: !errors.length, errors, warnings, integrity };
  }
}
