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
import type { ChapterDelta, ChapterReview, ContextPackage, ContextSource, MemoryState, Revision, WorkItem } from './types.js';

export class Project {
  readonly root: string;
  readonly store: Store;
  constructor(root: string) {
    this.root = resolve(root);
    loadConfig(this.root);
    this.store = new Store(this.root);
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
    writeNew(this.path(this.chapterPaths(workId, chapter).intent), `# 第 ${chapter} 章意图\n\n## 本章目标\n\n${query}\n\n## 冲突与场景安排\n\n## 人物与信息边界\n\n## 必须保留与避免\n\n## 章末变化与伏笔\n`);
  }
  private fingerprint(sources: ContextSource[]): string {
    return hash(json({ config: loadConfig(this.root), sources: sources.map(item => [item.source, item.hash]) }));
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
      memoryThrough: trusted.length, nextChapter: trusted.length + 1,
      staleChapters: revisions.filter(item => item.stale).map(item => item.chapter),
      dirtyFiles: dirty, projectionNeedsSync: projectedGeneration !== generation,
      works, pending,
      nextAction: dirty.length ? 'sync; modified prose requires sync --capture' : trusted.length < revisions.length ? `reconcile chapter ${trusted.length + 1}` : `prepare chapter ${trusted.length + 1}`
    };
  }
  /** Cheap preflight before external index/query calls; no model runs under the DB lock. */
  prepareRequest(chapter: number, workId: string, options: { query?: string; budget?: number } = {}) {
    return this.store.transaction(() => {
      positiveInteger(chapter, 'chapter'); this.assertWork(workId, chapter); this.assertClean();
      const revisions = this.store.revisions();
      if (chapter > trustedPrefix(revisions).length + 1) throw new Error(`Prepare chapter ${trustedPrefix(revisions).length + 1} first; no gaps or unreconciled dependencies`);
      const config = loadConfig(this.root);
      positiveInteger(options.budget ?? config.contextBudgetChars, 'budget');
      const query = config.memory!.backend === 'microsoft-graphrag' ? options.query?.trim() || defaultMemoryQuery : options.query ?? '';
      this.ensureIntent(chapter, workId, query);
      return { chapter, atChapter: chapter - 1, query, backend: config.memory!.backend, method: config.memory!.method!, autoIndex: config.memory!.autoIndex!,
        token: hash(json({ generation: this.store.generation(), inputs: this.fingerprint(this.inputSources(workId, chapter)), chapter, workId })) };
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
    const microsoft = config.memory!.backend === 'microsoft-graphrag';
    const semantic = microsoft && chapter > 1 ? new MicrosoftGraphRag(this).cachedQuery(query, { at: chapter - 1, method: config.memory!.method }) : undefined;
    if (microsoft && chapter > 1 && !semantic) throw new Error('Microsoft GraphRAG retrieval is not prepared. Use WriterMemory.prepare or the specwriter prepare CLI to index and retrieve before building chapter artifacts');
    const activeFacts = currentFacts(fullMemory);
    const queryTerms = new Set(terms(query));
    const recentCharacters = new Set(fullMemory.summaries.slice(-2).flatMap(item => item.characters));
    const matchScore = (text: string): number => terms(text).filter(term => queryTerms.has(term)).length;
    const retrieval = retrieveGraph(this.graphSnapshot(fullMemory, revisions), query, { hops: 2, maxNodes: 40, maxEdges: 60 });
    const linked = new Set(retrieval.edges.flatMap(item => item.factId ? [item.factId] : []));
    const factScores = new Map(activeFacts.map(item => [item.id, matchScore(`${item.subject} ${item.predicate} ${item.object}`) * 10 + (linked.has(item.id) ? 5 : 0) + (recentCharacters.has(item.subject) || (item.holder !== null && recentCharacters.has(item.holder)) ? 3 : 0)]));
    const rankedFacts = [...activeFacts].sort((a, b) => factScores.get(b.id)! - factScores.get(a.id)! || b.sourceChapter - a.sourceChapter || a.id.localeCompare(b.id));
    const rankedHooks = [...fullMemory.hooks].sort((a, b) => matchScore(`${b.id} ${b.description}`) - matchScore(`${a.id} ${a.description}`) || Number(a.status === 'resolved' || a.status === 'superseded') - Number(b.status === 'resolved' || b.status === 'superseded') || b.sourceChapter - a.sourceChapter);
    const selectedNodeIds = new Set(retrieval.nodes.flatMap(node => node.recordId ? [node.recordId] : []));
    const selectedEpisodes = [...fullMemory.episodes].sort((a, b) => Number(selectedNodeIds.has(b.id)) - Number(selectedNodeIds.has(a.id)) || b.sourceChapter - a.sourceChapter).slice(0, 20);
    const selectedEntities = fullMemory.entities.filter(entity => selectedNodeIds.has(entity.id) || recentCharacters.has(entity.name) || recentCharacters.has(entity.id));
    const memory = { ...fullMemory, facts: rankedFacts, hooks: rankedHooks, entities: selectedEntities, episodes: selectedEpisodes, resources: fullMemory.resources.filter(resource => queryTerms.has(resource.entity) || selectedNodeIds.has(json([resource.entity, resource.resource]).trim())), timeline: fullMemory.timeline.slice(-20), summaries: fullMemory.summaries.slice(-5) };
    const inputs = this.inputSources(workId, chapter);
    const baseRevision = revisions.find(item => item.chapter === chapter)?.id ?? null;
    const selected: ContextSource[] = inputs.filter(item => item.protection === 'protected');
    const context: ContextPackage = {
      schemaVersion: 1, contractVersion: 2, intentHash: inputs.find(item => item.kind === 'intent')!.hash, chapter, workId, baseRevision, generation: this.store.generation(),
      inputFingerprint: this.fingerprint(inputs), query, budgetChars, selectedChars: 0,
      memory, memorySelection: { strategy: microsoft ? 'microsoft-graphrag' : 'hybrid-graphrag', totalActiveFacts: activeFacts.length, selectedFacts: memory.facts.length, totalHooks: fullMemory.hooks.length, selectedHooks: memory.hooks.length, totalEpisodes: fullMemory.episodes.length, selectedEpisodes: memory.episodes.length },
      retrieval: { engine: microsoft ? 'microsoft-graphrag' : retrieval.engine, snapshotId: retrieval.snapshotId, hops: retrieval.hops, seedIds: retrieval.seedIds, paths: retrieval.paths.slice(0, 8),
        ...(microsoft ? { status: semantic ? 'ready' as const : 'empty' as const, method: config.memory!.method,
          ...(semantic ? { receiptId: semantic.id, answerHash: semantic.answerHash, configHash: semantic.configHash, outputHash: semantic.outputHash } : {}) } : {}) }, sources: selected, contextHash: ''
    };
    const size = (): number => json(context).length;
    // Bound selection, not the persistent memory. Low-ranked records stay available through query/show.
    const selectionBudget = Math.floor(budgetChars * 0.7);
    while (size() > selectionBudget && memory.facts.length > 1) memory.facts.pop();
    while (size() > selectionBudget && memory.hooks.length > 1) memory.hooks.pop();
    while (size() > selectionBudget && memory.episodes.length) memory.episodes.pop();
    while (size() > selectionBudget && memory.entities.length) memory.entities.pop();
    while (size() > selectionBudget && memory.resources.length) memory.resources.pop();
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
      const content = semantic.answer.slice(0, maxChars);
      context.retrieval!.answerTruncated = content.length < semantic.answer.length;
      selected.push({ id: semantic.id, kind: 'retrieval', source: `.specwriter/graphrag/snapshots/${semantic.snapshotId}/queries/${semantic.id}.json`, reason: 'Microsoft GraphRAG 默认检索；作者视角参考，需核对正文引用，不是新事实或执行指令', content, hash: hash(content), protection: 'compressible' });
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
    this.ensureIntent(chapter, workId, options.query);
    const token = hash(json({ generation: this.store.generation(), inputs: this.fingerprint(this.inputSources(workId, chapter)), chapter, workId }));
    if (options.expectedToken && options.expectedToken !== token) throw new Error('Book or creative inputs changed during GraphRAG preparation; retry prepare with current inputs');
    const paths = this.chapterPaths(workId, chapter);
    const config = loadConfig(this.root);
    const query = config.memory!.backend === 'microsoft-graphrag' ? options.query?.trim() || defaultMemoryQuery : options.query ?? '';
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
    const review = { schemaVersion: 2, chapter, contextHash: context.contextHash, intentHash: context.intentHash, draftHash: '', reviewed: false, issues: [], notes: [],
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
    return { chapter, workId, paths, contextHash: context.contextHash, baseRevision: context.baseRevision };
  }
  hashes(chapter: number, workId: string) {
    const paths = this.chapterPaths(workId, chapter);
    const context = readJson<ContextPackage>(this.path(paths.context));
    return { chapter, baseRevision: context.baseRevision, contextHash: context.contextHash, intentHash: hash(readFileSync(this.path(paths.intent), 'utf8')), draftHash: hash(readFileSync(this.path(paths.draft), 'utf8')) };
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
      const input = this.verified(chapter, workId);
      const revision = this.store.accept(input.body, input.delta, input.review, input.context, workId);
      const revisions = this.store.revisions();
      this.graphSnapshot(replay(revisions), revisions);
      return { chapter, revision, generation: this.store.generation(), staleChapters: this.store.revisions().filter(item => item.stale).map(item => item.chapter) };
    });
    // DB acceptance is authoritative. File projection failures are recoverable, not a failed acceptance.
    try { this.sync(); return { ...accepted, projectionNeedsSync: false }; }
    catch (error) { return { ...accepted, projectionNeedsSync: true, warning: (error as Error).message }; }
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
