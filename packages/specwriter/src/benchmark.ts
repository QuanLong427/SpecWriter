import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assetsRoot, atomicWrite, hash, identifier, json, readJson, safePath } from './files.js';
import { initProject } from './init.js';
import { Project } from './project.js';
import { MicrosoftGraphRag, runGraphRag, type ProcessRunner } from './microsoft-graphrag.js';
import { UsageLedger, type Prices } from './usage.js';
import type { GraphRagMethod } from './types.js';

export type BenchmarkArm = 'cold' | 'warm' | 'incremental' | 'structural';
interface FixtureChapter { chapter: number; body: string; delta: Record<string, unknown> }
interface Question { id: string; query: string; category: string; expectedAnswer: string; unanswerable?: boolean; evidence: { chapter: number; quote: string }[] }
interface Step { id: string; through: number; retcon?: FixtureChapter; questions: Question[] }
export interface BenchmarkDataset { schemaVersion: 1; title: string; chapters: FixtureChapter[]; steps: Step[] }
export interface BenchmarkCase {
  id: string; arm: BenchmarkArm; step: string; question: string; category: string; atChapter: number;
  query: string; answer: string | null; context: string; answerHash: string; contextHash: string; durationMs: number;
  cached: boolean; expectedAnswer: string; unanswerable: boolean; evidenceRecall: number | null;
  invalidSources: number; unresolvedCitations: number;
}
export interface BenchmarkOptions {
  dataset?: string; out?: string; mode?: 'offline' | 'live'; provider?: string;
  arms?: BenchmarkArm[]; maxOperations?: number; budget?: number; method?: GraphRagMethod; signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
}
function validateDataset(value: unknown): asserts value is BenchmarkDataset {
  const d = value as BenchmarkDataset;
  if (!d || d.schemaVersion !== 1 || typeof d.title !== 'string' || !Array.isArray(d.chapters) || !d.chapters.length || !Array.isArray(d.steps) || !d.steps.length) throw new Error('Invalid benchmark dataset');
  const chapter = (c: FixtureChapter) => {
    if (!c || !Number.isSafeInteger(c.chapter) || c.chapter < 1 || typeof c.body !== 'string' || !c.body.trim() || !c.delta || typeof c.delta !== 'object' || Array.isArray(c.delta)) throw new Error('Invalid fixture chapter');
    for (const key of ['schemaVersion', 'chapter', 'contextHash', 'draftHash', 'intentHash', 'baseRevision']) if (key in c.delta) throw new Error(`Fixture delta cannot override ${key}`);
  };
  d.chapters.forEach((c, i) => { chapter(c); if (c.chapter !== i + 1) throw new Error('Fixture chapters must be contiguous and ordered'); });
  const ids = new Set<string>();
  let reached = 0;
  for (const step of d.steps) {
    identifier(step.id);
    if (ids.has(step.id) || !Number.isSafeInteger(step.through) || step.through < 1 || step.through > d.chapters.length || !Array.isArray(step.questions) || !step.questions.length) throw new Error('Invalid benchmark step');
    ids.add(step.id);
    if (step.retcon) { chapter(step.retcon); if (step.retcon.chapter > reached || step.retcon.chapter > step.through) throw new Error('Retcon must revise an already accepted chapter'); }
    reached = Math.max(reached, step.through);
    const questionIds = new Set<string>();
    for (const q of step.questions) {
      identifier(q.id);
      if (questionIds.has(q.id) || typeof q.query !== 'string' || !q.query.trim() || typeof q.expectedAnswer !== 'string' || !q.expectedAnswer.trim() || typeof q.category !== 'string' || !Array.isArray(q.evidence)
        || (q.unanswerable !== undefined && typeof q.unanswerable !== 'boolean') || (!q.unanswerable && !q.evidence.length)) throw new Error('Invalid benchmark question');
      questionIds.add(q.id);
      for (const source of q.evidence) if (!Number.isSafeInteger(source.chapter) || source.chapter < 1 || source.chapter > step.through || typeof source.quote !== 'string' || !source.quote) throw new Error('Gold evidence exceeds question chapter boundary');
    }
  }
}
function accept(project: Project, chapter: FixtureChapter) {
  const prepared = project.prepare(chapter.chapter, 'benchmark-fixture', { refresh: true });
  atomicWrite(safePath(project.root, prepared.paths.draft), chapter.body);
  const metadata = project.hashes(chapter.chapter, 'benchmark-fixture');
  const delta = readJson<Record<string, unknown>>(safePath(project.root, prepared.paths.delta));
  // Hand-authored fixtures exercise the protocol; these checks are not an AI review.
  const data = { ...delta, title: `第${chapter.chapter}章`, summary: chapter.body, characters: [],
    key_events: [{ description: chapter.body, evidence: { quote: chapter.body, basis: 'established' } }], ...chapter.delta, ...metadata };
  atomicWrite(safePath(project.root, prepared.paths.delta), json(data));
  const review = readJson<Record<string, unknown>>(safePath(project.root, prepared.paths.review));
  atomicWrite(safePath(project.root, prepared.paths.review), json({ ...review,
    ...Object.fromEntries(['chapter', 'contextHash', 'draftHash', 'intentHash'].map(key => [key, metadata[key as keyof typeof metadata]])), reviewed: true,
    checks: Object.fromEntries(['evidence', 'coverage', 'continuity'].map(key => [key, { checked: true, notes: ['人工编写的实验夹具；自动接纳不代表语义审阅通过。'] }])) }));
  project.verify(chapter.chapter, 'benchmark-fixture'); project.commit(chapter.chapter, 'benchmark-fixture');
}
function advance(project: Project, dataset: BenchmarkDataset, step: Step, versions: Map<number, FixtureChapter>) {
  if (step.retcon) { versions.set(step.retcon.chapter, step.retcon); accept(project, step.retcon); }
  while (project.status().memoryThrough < step.through) {
    const next = project.status().memoryThrough + 1;
    accept(project, versions.get(next) ?? dataset.chapters[next - 1]!);
  }
  const corpus = project.corpus(step.through);
  for (const q of step.questions) for (const source of q.evidence) {
    if (!corpus.documents.find(d => d.chapter === source.chapter)?.body.includes(source.quote)) throw new Error(`Gold evidence does not match ${step.id}/${q.id}`);
  }
}
function createBook(root: string, dataset: BenchmarkDataset) {
  initProject(root, dataset.title, { memoryBackend: 'local' });
  const project = new Project(root);
  project.propose('benchmark-fixture', '实验夹具接纳与返修', 1, dataset.chapters.length); return project;
}
function logicalBytes(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Benchmark cannot follow linked files');
    const path = safePath(root, entry.name);
    total += entry.isDirectory() ? logicalBytes(path) : lstatSync(path).size;
  }
  return total;
}
function noLinks(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Provider configuration cannot contain links');
    if (entry.isDirectory()) noLinks(safePath(root, entry.name));
  }
}
function promptFingerprint(root: string): string {
  if (!existsSync(root)) return '';
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const path = safePath(root, entry.name);
    return `${entry.name}:${entry.isDirectory() ? promptFingerprint(path) : hash(readFileSync(path, 'utf8'))}`;
  }).join('\n');
}
function structuralText(result: ReturnType<Project['query']>) {
  return [
    ...result.entities.map(e => `人物/实体 ${e.id}：${e.name}；别名 ${e.aliases.join('、')}；${e.description}`),
    ...result.facts.map(f => `${f.scope}/${f.holder ?? '作者'} ${f.subject} ${f.predicate} ${f.object}`),
    ...result.resources.map(r => `${r.entity} ${r.resource}余额=${r.amount}`),
    ...result.hooks.map(h => `伏笔 ${h.description}：${h.status}`),
    ...result.episodes.map(e => `事件 ${e.description}`),
    ...result.passages.map(p => `[第${p.chapter}章] ${p.excerpt}`),
  ].join('\n');
}
function offlineRunner(project: Project): ProcessRunner {
  let sources: unknown[] = [];
  return async (_exe, args) => {
    if (args[0] === '-c') return { stdout: '3.3.0\n', stderr: '' };
    if (args[0] === '-X') return { stdout: json({ sources, unresolvedCitations: [] }), stderr: '' };
    const root = args[args.indexOf('--root') + 1]!;
    if (args[2] === 'init') {
      atomicWrite(safePath(root, 'settings.yaml'), 'completion_models: {}\nembedding_models: {}\n');
    } else if (['index', 'update'].includes(args[2]!)) {
      for (const name of ['documents', 'text_units', 'entities', 'relationships', 'communities', 'community_reports']) atomicWrite(safePath(root, 'output', `${name}.parquet`), 'offline harness placeholder; not a GraphRAG index');
      atomicWrite(safePath(root, 'cache', 'harness.json'), '{}');
    } else if (args[2] === 'query') {
      const manifest = readJson<{ atChapter: number }>(safePath(root, 'manifest.json'));
      const result = project.query(args[3]!, { at: manifest.atChapter, limit: 8 });
      const corpus = project.corpus(manifest.atChapter);
      sources = result.passages.map((p, i) => ({ citationType: 'text_units', citationId: String(i), chapter: p.chapter, revision: p.revision,
        bodyHash: corpus.documents.find(d => d.chapter === p.chapter)!.bodyHash, excerpt: p.excerpt.slice(0, 2400) }));
      return { stdout: structuralText(result) || '离线夹具未检索到内容；这不是模型回答。', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

/** Isolated experiment books never index or mutate the user's production novel. */
export async function runBenchmark(options: BenchmarkOptions = {}) {
  const mode = options.mode ?? 'offline', arms = options.arms ?? ['cold', 'warm', 'incremental', 'structural'];
  const budget = options.budget ?? 6000;
  if (!['offline', 'live'].includes(mode) || !arms.length || new Set(arms).size !== arms.length || arms.some(a => !['cold', 'warm', 'incremental', 'structural'].includes(a))) throw new Error('Invalid benchmark mode/arms');
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Benchmark budget must be a positive character count');
  if (options.method && !['local', 'global', 'drift', 'basic'].includes(options.method)) throw new Error('Invalid benchmark query method');
  if (options.maxOperations !== undefined && (!Number.isSafeInteger(options.maxOperations) || options.maxOperations < 1)) throw new Error('max-operations must be a positive integer');
  if (mode === 'live' && arms.some(a => a !== 'structural') && (!options.provider || !options.maxOperations)) throw new Error('Live benchmark requires --provider BOOK_ROOT and --max-operations N; model calls can incur charges');
  const datasetPath = resolve(options.dataset ?? safePath(assetsRoot, 'benchmark', 'fixture.json'));
  const dataset = readJson<BenchmarkDataset>(datasetPath); validateDataset(dataset);
  let sourceProvider: string | undefined, providerVersion: string | undefined, configFingerprint: string | undefined, providerInfo: { version: string; python: string } | undefined;
  if (mode === 'live' && arms.some(a => a !== 'structural')) {
    sourceProvider = safePath(resolve(options.provider!), '.specwriter', 'graphrag', 'provider'); noLinks(sourceProvider);
    const info = readJson<{ version: string; python: string }>(safePath(resolve(options.provider!), '.specwriter', 'graphrag', 'provider.json'));
    if (!/^3\.3\.\d+$/.test(info.version) || !info.python) throw new Error('Set up a GraphRAG 3.3.x provider before a live experiment');
    providerVersion = info.version;
    providerInfo = info;
    configFingerprint = hash(readFileSync(safePath(sourceProvider, 'settings.yaml'), 'utf8') + promptFingerprint(safePath(sourceProvider, 'prompts')));
  }
  const out = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), 'specwriter-benchmark-'));
  if (options.out) { mkdirSync(dirname(out), { recursive: true }); mkdirSync(out); }
  atomicWrite(safePath(out, '.gitignore'), '*\n');
  atomicWrite(safePath(out, 'dataset.json'), json(dataset));
  if (sourceProvider) {
    // Freeze once so edits to a production provider cannot change later arms.
    const frozen = safePath(out, 'provider'); cpSync(sourceProvider, frozen, { recursive: true });
    if (hash(readFileSync(safePath(frozen, 'settings.yaml'), 'utf8') + promptFingerprint(safePath(frozen, 'prompts'))) !== configFingerprint) throw new Error('Provider changed while freezing benchmark configuration');
    atomicWrite(safePath(out, 'provider.json'), json(providerInfo)); sourceProvider = frozen;
  }
  // Validate every chapter, retcon and gold source before the first paid operation.
  const preflight = createBook(safePath(out, 'preflight'), dataset);
  try { const versions = new Map<number, FixtureChapter>(); for (const step of dataset.steps) advance(preflight, dataset, step, versions); }
  finally { preflight.close(); }
  const runId = randomUUID();
  const cases: BenchmarkCase[] = [], measurements: Record<string, unknown>[] = [];
  const report = { schemaVersion: 1, runId, mode, status: 'running', specwriterVersion: readJson<{ version: string }>(join(assetsRoot, '..', 'package.json')).version,
    datasetHash: hash(json(dataset)), configFingerprint: configFingerprint ?? null,
    providerVersion: providerVersion ?? null, nodeVersion: process.version, contextBudgetChars: budget, queryMethod: options.method ?? 'local', arms,
    modelCalls: mode === 'offline' || arms.every(a => a === 'structural') ? 0 : null, scheduledOperations: 0, maxOperations: options.maxOperations ?? null,
    qualityEligible: mode === 'live', note: mode === 'offline' ? 'Offline validates orchestration only. Answers are structural placeholders; no semantic quality or token savings claim.' : 'Measured GraphRAG retrieval only. Fixture deltas/reviews are hand-authored; excludes writing and extraction costs.', cases, measurements };
  const save = () => {
    atomicWrite(safePath(out, 'report.json'), json(report));
    atomicWrite(safePath(out, 'ratings-template.json'), json({ schemaVersion: 1, runId, ratings: cases.map(c => ({ caseId: c.id, answerHash: c.answerHash, contextHash: c.contextHash,
      correct: null, unsupported: null, futureLeak: null, staleLeak: null, knowledgeLeak: null, notes: '' })) }));
    const rows = cases.map(c => `| ${c.arm} | ${c.step}/${c.question} | ${c.durationMs} | ${c.cached} | ${c.evidenceRecall ?? 'N/A'} | ${c.invalidSources} |`);
    const indexRows = measurements.filter(m => m.operation === 'index').map(m => {
      const index = m.index as { reused: boolean; indexing?: { mode: string } } | null;
      return `| ${m.arm} | ${m.step} | ${index?.reused ? 'reuse' : index?.indexing?.mode ?? 'structural'} | ${m.durationMs} | ${m.logicalBytes} |`;
    });
    const usageRows = arms.map(arm => {
      const entry = [...measurements].reverse().find(m => m.arm === arm && m.usage);
      const usage = entry?.usage as ReturnType<UsageLedger['report']> | undefined;
      const tokens = usage?.observedTokens;
      return `| ${arm} | ${usage?.operationCount ?? 0} | ${usage?.totalsComplete ? '完整' : arm === 'structural' ? '无 GraphRAG 调用' : '未知/不完整'} | ${tokens?.input ?? 0} / ${tokens?.output ?? 0} / ${tokens?.embedding ?? 0} |`;
    });
    atomicWrite(safePath(out, 'report.md'), `# WriterMemory 实验 ${runId}\n\n模式：${mode}；状态：${report.status}；上下文预算：${budget} 字符。\n\n${report.note}\n\n## 用量\n\n| 组 | 已记录操作 | 用量覆盖 | 已观测输入/输出/Embedding tokens |\n|---|---:|---|---|\n${usageRows.join('\n')}\n\n未知用量不能按零费用处理；离线占位组不能用于 token 节省评估。\n\n## 索引\n\n| 组 | 检查点 | 模式 | 耗时 ms | 逻辑字节 |\n|---|---|---|---:|---:|\n${indexRows.join('\n')}\n\n## 检索\n\n| 组 | 问题 | 耗时 ms | 应用缓存 | 证据覆盖率 | 无效来源 |\n|---|---|---:|---|---:|---:|\n${rows.join('\n')}\n\n证据覆盖率只检查所需引用是否进入上下文，不是答案正确率。人工填写 ratings-template.json 后执行 benchmark score。\n`);
  };
  save();
  try {
    for (const arm of arms) {
      const project = createBook(safePath(out, 'books', arm), dataset);
      try {
        const versions = new Map<number, FixtureChapter>();
        const underlying = mode === 'offline' ? offlineRunner(project) : runGraphRag;
        const runner: ProcessRunner = async (exe, args, cwd, processOptions) => {
          if (args[0] === '-m' && args[1] === 'graphrag' && ['index', 'update', 'query'].includes(args[2]!)) {
            options.signal?.throwIfAborted();
            if (options.maxOperations && report.scheduledOperations >= options.maxOperations) throw new Error('Benchmark operation limit reached; partial report saved');
            report.scheduledOperations++;
            options.onProgress?.({ arm, operation: args[2], scheduledOperations: report.scheduledOperations });
          }
          return underlying(exe, args, cwd, processOptions);
        };
        const provider = new MicrosoftGraphRag(project, runner);
        if (arm !== 'structural') {
          if (sourceProvider) {
            const target = safePath(project.root, '.specwriter', 'graphrag', 'provider');
            cpSync(sourceProvider, target, { recursive: true });
            cpSync(safePath(out, 'provider.json'), safePath(project.root, '.specwriter', 'graphrag', 'provider.json'));
          } else await provider.setup({ python: 'offline-harness', model: 'placeholder', embedding: 'placeholder' });
        }
        for (const step of dataset.steps) {
          options.signal?.throwIfAborted(); advance(project, dataset, step, versions);
          const started = Date.now();
          const index = arm === 'structural' ? null : await provider.index(step.through, { reuse: true, signal: options.signal,
            strategy: arm === 'incremental' ? 'incremental' : 'full', cacheFromPrefix: arm === 'warm',
            onProgress: event => options.onProgress?.({ arm, step: step.id, ...event }) });
          measurements.push({ arm, step: step.id, operation: 'index', durationMs: Date.now() - started, index,
            logicalBytes: logicalBytes(safePath(project.root, '.specwriter', 'graphrag')) }); save();
          for (const q of step.questions) {
            const before = Date.now();
            const local = arm === 'structural' ? project.query(q.query, { at: step.through, limit: 8 }) : undefined;
            const result = local ? undefined : await provider.query(q.query, { at: step.through, method: options.method, cache: true, signal: options.signal });
            const answer = result?.answer ?? null;
            const context = (local ? structuralText(local) : [answer, ...(result?.sources ?? []).map(s => `[第${s.chapter}章] ${s.excerpt}`)].join('\n')).slice(0, budget);
            const corpus = project.corpus(step.through);
            const sources = result?.sources ?? local?.passages.map(p => ({ ...p, bodyHash: corpus.documents.find(d => d.chapter === p.chapter)!.bodyHash })) ?? [];
            const invalidSources = sources.filter(s => { const d = corpus.documents.find(d => d.chapter === s.chapter); return !d || d.revision !== s.revision || d.bodyHash !== s.bodyHash || !d.body.includes(s.excerpt); }).length;
            cases.push({ id: `${arm}/${step.id}/${q.id}`, arm, step: step.id, question: q.id, category: q.category, atChapter: step.through,
              query: q.query, answer, context, answerHash: hash(answer ?? ''), contextHash: hash(context), durationMs: Date.now() - before,
              cached: result?.cached ?? false, expectedAnswer: q.expectedAnswer, unanswerable: q.unanswerable ?? false,
              evidenceRecall: q.evidence.length ? q.evidence.filter(s => context.includes(s.quote) && sources.some(found => found.chapter === s.chapter && found.excerpt.includes(s.quote))).length / q.evidence.length : null,
              invalidSources, unresolvedCitations: result?.unresolvedCitations?.length ?? 0 }); save();
          }
          const { operations: _operations, ...usage } = new UsageLedger(project.root).report();
          measurements.push({ arm, step: step.id, operation: 'cumulative', usage, logicalBytes: logicalBytes(safePath(project.root, '.specwriter', 'graphrag')) }); save();
        }
      } finally {
        const { operations: _operations, ...usage } = new UsageLedger(project.root).report();
        measurements.push({ arm, operation: 'final', usage, logicalBytes: logicalBytes(safePath(project.root, '.specwriter', 'graphrag')) });
        project.close(); save();
      }
    }
    report.status = 'complete'; save(); return { directory: out, report: safePath(out, 'report.md'), data: safePath(out, 'report.json'), ...report };
  } catch (error) { report.status = 'failed'; save(); throw new Error(`Benchmark stopped; partial report: ${safePath(out, 'report.json')}. ${(error as Error).message}`); }
}

export function scoreBenchmark(directory: string, ratingsPath: string, prices?: Prices) {
  const report = readJson<{ runId: string; qualityEligible: boolean; cases: BenchmarkCase[]; arms: BenchmarkArm[] }>(safePath(resolve(directory), 'report.json'));
  if (!report.qualityEligible) throw new Error('Offline fixture answers cannot be scored as model quality; run a live experiment');
  const ratings = readJson<{ schemaVersion: number; runId: string; ratings: Record<string, unknown>[] }>(resolve(ratingsPath));
  if (ratings.schemaVersion !== 1 || ratings.runId !== report.runId || !Array.isArray(ratings.ratings)) throw new Error('Ratings do not match this experiment');
  if (report.cases.some(c => hash(c.answer ?? '') !== c.answerHash || hash(c.context) !== c.contextHash)) throw new Error('Benchmark answers/context changed after retrieval; rerun before scoring');
  const seen = new Set<string>(), rated: Record<string, unknown>[] = [];
  const checks = ['correct', 'unsupported', 'futureLeak', 'staleLeak', 'knowledgeLeak'];
  for (const rating of ratings.ratings) {
    const c = report.cases.find(c => c.id === rating.caseId);
    if (!c || seen.has(c.id) || c.answerHash !== rating.answerHash || c.contextHash !== rating.contextHash) throw new Error('Duplicate, stale or unknown rating');
    seen.add(c.id);
    if (checks.every(key => rating[key] === null)) continue;
    if (!checks.every(key => typeof rating[key] === 'boolean') || typeof rating.notes !== 'string' || !rating.notes.trim()) throw new Error('Complete each rating with boolean checks and review notes');
    rated.push({ ...rating, arm: c.arm });
  }
  const arms = report.arms.map(arm => {
    const rows = rated.filter(r => r.arm === arm), count = rows.length;
    return { arm, total: report.cases.filter(c => c.arm === arm).length, rated: count,
      ...Object.fromEntries(checks.map(key => [key, count ? rows.filter(r => r[key] === true).length / count : null])),
      usage: new UsageLedger(safePath(resolve(directory), 'books', arm)).report(prices) };
  });
  const result = { schemaVersion: 1, runId: report.runId, complete: rated.length === report.cases.length, rated: rated.length, total: report.cases.length,
    note: 'Human ratings; correctness for structural arm means context sufficiency. No unreviewed case is counted as correct.', arms };
  atomicWrite(safePath(resolve(directory), 'quality.json'), json(result)); return result;
}
