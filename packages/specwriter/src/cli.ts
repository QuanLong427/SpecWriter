#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { configureMemory, findRoot, initProject } from './init.js';
import { atomicWrite, hash, identifier, json, positiveInteger, safePath } from './files.js';
import { Project } from './project.js';
import { MicrosoftGraphRag } from './microsoft-graphrag.js';
import { WriterMemory } from './writer-memory.js';
import { NovelReader } from './reader.js';
import { AuthorInstructions } from './author-guidance.js';
import { ResearchLibrary } from './research.js';
import { collectMarket } from './market-sources.js';
import { craftProfile, craftProfiles, useCraftProfile } from './craft.js';
import { startReader } from './reader-server.js';
import { spawn } from 'node:child_process';
import { UsageLedger, validatePrices, type Prices } from './usage.js';
import { readJson } from './files.js';
import { BookVersions } from './versions.js';
import { runBenchmark, scoreBenchmark, type BenchmarkArm } from './benchmark.js';

const help = `SpecWriter 0.10 — Codex fiction workflows + WriterMemory + research references

Usage: specwriter <command> [arguments] [--root PATH] [--json]

  init [PATH] --name TITLE [--backend microsoft-graphrag|local]
                                Create a book; Microsoft GraphRAG is the default backend
  status                        Recover progress, drafts and memory freshness
  resume [--work ID]             Recover next action from files without model calls
  contract show                 Inspect adopted creative contracts and edited draft specs
  contract adopt --reason TEXT [--from N]
                                Adopt the author's selected specs from chapter N
  work show ID                  Inspect scoped writing authorization
  work authorize ID --from N --to N --acceptance draft|auto --reason TEXT
                                Record the actual author instruction; auto permits chapter acceptance
  work pause|resume ID --reason TEXT
                                Pause advancement or record the author's resume instruction
  intent seed|save|show N --work ID
                                Seed/edit/validate structured intent before prepare
  propose ID --title TITLE --from N --to N
                                Scaffold a scoped writing/revision work package
  prepare N --work ID [--query TEXT] [--budget CHARS] [--refresh]
                                Compile context and prepare chapter artifacts
  hash N --work ID               Get draft/context hashes for extraction and review
  review-requirements N --work ID List claim hashes/evidence and retrieval checks for review
  verify N --work ID             Validate evidence, freshness and blocking issues
  commit N --work ID             Accept prose and memory in one SQLite transaction
  memory show [--at N]           Show reconciled chapter-bounded memory (N may be 0)
  memory query TEXT [--at N] [--method local|global|drift|basic]
                                Default Microsoft GraphRAG retrieval; auto-index accepted prefix
  memory query TEXT --backend local [--at N] [--holder NAME] [--hops 1..4]
                                Explicit offline structural memory retrieval
  memory configure --backend microsoft-graphrag|local [--method METHOD] [--auto-index true|false] [--retain N]
                                Set the book's memory backend; no silent fallback
  memory graph [--at N] [--holder NAME]
                                Export the chapter-bounded provenance graph as JSON
  memory rebuild                Rebuild derived full-text and graph indexes
  memory usage [--prices FILE]   Report observed GraphRAG tokens, cache hits and optional cost
  memory budget show|clear|recover
  memory budget configure [--max-requests N --max-tokens N --max-cost N --prices FILE]
                [--unknown-usage block|allow]
                                Limit new requests and stop after observed book usage reaches thresholds
  benchmark run [--mode offline|live] [--dataset FILE] [--out NEW_DIR]
                [--provider BOOK_ROOT --max-operations N] [--arms cold,warm,incremental,structural]
                [--budget CHARS] [--method local|global|drift|basic]
                                Run isolated memory experiments; offline is the default
  benchmark score --run DIR --ratings FILE [--prices FILE]
                                Aggregate version-bound human ratings and usage
  memory graphrag export [--at N]
                                Export an immutable accepted-prose prefix (no model)
  memory graphrag setup --python EXE --embedding MODEL [--model MODEL | --credentials FILE]
                [--provider NAME --embedding-base URL --embedding-dimensions N --reconfigure]
                [--preset qwen-bge-m3]
                                Initialize the default Microsoft GraphRAG 3.3.x provider
  memory graphrag diagnose [--probe]
                                Check Python/models; --probe sends small, potentially paid requests
  memory graphrag index [--at N] [--rebuild]
                                Incrementally extend a verified prefix; rebuild changed configuration
  memory graphrag status [--at N]
                                Inspect index progress, lock and readiness without model calls
  memory graphrag recover [--at N]
                                Recover only a lock whose recorded process has stopped
  memory graphrag prune [--keep N] [--dry-run]
                                Keep recent/current and prepared indexes; preserve prose and receipts
  memory graphrag query TEXT [--at N] [--method local|global|drift|basic]
                                Retrieve an advisory answer from Microsoft GraphRAG
  history N                     List accepted chapter revisions
  version init                  Enable independent local Git checkpoints and auto-save
  version save [--message TEXT]  Save prose/specs/reviews and a consistent memory DB copy
  version log                   List up to 50 checkpoints
  version status                Inspect pending backup edits and the last backup failure
  version bundle --out NEW_FILE Export complete Git history for backup/migration
  version restore HASH --to NEW_DIR [--bundle FILE]
                                Restore and verify a new book directory; never overwrite
  archive ID                    Close completed work without promoting plans to facts
  sync [--capture]              Rebuild projections; preserve direct edits as drafts
  doctor [--models --probe]      Check book health; --models checks provider, --probe calls models
  read [--draft --work ID] [--port N] [--no-open]
                                Open the local novel reader; Ctrl+C stops its server
  export [--format txt|md|html]   Export only reconciled accepted chapters to exports/
  feedback list [--chapter N] [--work ID]
                                Read version-bound author annotations for Codex
  feedback request [--chapter N] [--work ID]
                                Generate a revision request from open annotations
  feedback resolve ID [--reopen] Mark an annotation handled, or reopen it
  feedback decide ID --decision adopt|decline|clarify --reason TEXT [--work ID --anchor FILE]
                                Record the author's decision and version-bound revision target
  feedback reconcile --chapter N --work ID
                                Recover applied-feedback metadata after successful acceptance
  instruction add ID --text TEXT --kind require|avoid --from N [--to N --work ID]
                                Persist scoped author instructions; historical global changes need reconciliation
  instruction list [--chapter N --work ID]
  instruction retire ID --reason TEXT
                                Withdraw future enforcement while preserving the decision record
  research create ID --kind market|analysis|craft --title TEXT --question TEXT
                [--platform TEXT --audience TEXT --window TEXT]
                                Create an editable research draft; no canon changes
  research capture ID --source ID --file UTF8_FILE --title TEXT
                [--kind web|ranking|file|author --url URL --published-at ISO]
                                Preserve a source excerpt with identity, time and hash
  research save ID               Validate citations and record an immutable report version
  research show ID [--draft]     Inspect recorded report or draft and its source catalog
  research list                 List book-local research reports
  research radar ID --platform fanqie|qidian [--limit N --timeout MS]
                                Capture public ranking samples; report unavailable data explicitly
  craft list|show [PROFILE]      Inspect original genre writing methods, without model calls
  craft use PROFILE --as ID      Record a craft reference; author chooses which rules to adopt

Codex: $specwriter (entry) + explore / propose / write / review / revise / commit / archive
       + $specwriter-research / analyze / craft for external evidence and writing methods
Codex writes prose, extraction and review artifacts. Default prepare/query use Microsoft
GraphRAG and call configured models for nonempty corpora; explicit local mode uses no model.
`;
interface Arguments { positional: string[]; flags: Map<string, string | boolean> }
function sourceText(path: string): string {
  const absolute = resolve(path), name = basename(absolute).toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || /^(secrets?|credentials?)(\.|$)/.test(name)) throw new Error('Credential files are not research sources');
  const info = statSync(absolute);
  if (!info.isFile() || info.size > 1000000) throw new Error('Research capture needs a UTF-8 text excerpt no larger than 1 MB; select a smaller excerpt first');
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) throw new Error('Research capture needs UTF-8 text; extract binary documents first');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}
function parseArguments(values: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const booleans = new Set(['json', 'help', 'refresh', 'capture', 'draft', 'no-open', 'reopen', 'rebuild', 'dry-run', 'reconfigure', 'models', 'probe']);
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if (flags.has(key)) throw new Error(`Repeated option --${key}`);
    if (booleans.has(key)) flags.set(key, true);
    else {
      const next = values[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`Option --${key} requires a value`);
      flags.set(key, next);
    }
  }
  return { positional, flags };
}
async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const command = args.positional.shift();
  if (!command || command === 'help' || args.flags.has('help')) { process.stdout.write(help); return; }
  const allowed: Record<string, string[]> = {
    init: ['name', 'backend'], status: [], propose: ['title', 'from', 'to'], prepare: ['work', 'query', 'budget', 'refresh'],
    resume: ['work'], contract: ['from', 'reason'], work: ['from', 'to', 'acceptance', 'reason'], intent: ['work'],
    hash: ['work'], verify: ['work'], commit: ['work'], memory: ['at', 'holder', 'limit', 'hops', 'python', 'model', 'embedding', 'env-file', 'credentials', 'provider', 'embedding-base', 'embedding-dimensions', 'reconfigure', 'preset', 'probe', 'method', 'backend', 'auto-index', 'retain', 'keep', 'rebuild', 'dry-run', 'prices', 'max-requests', 'max-tokens', 'max-cost', 'unknown-usage'], history: [], archive: [], sync: ['capture'], doctor: ['models', 'probe'],
    'review-requirements': ['work'], version: ['message', 'to', 'bundle', 'out'],
    benchmark: ['mode', 'dataset', 'out', 'provider', 'max-operations', 'arms', 'budget', 'method', 'run', 'ratings', 'prices'],
    read: ['draft', 'work', 'port', 'no-open'], export: ['format'], feedback: ['chapter', 'work', 'reopen', 'decision', 'reason', 'anchor'],
    instruction: ['chapter', 'work', 'text', 'kind', 'from', 'to', 'reason'],
    research: ['kind', 'title', 'question', 'platform', 'audience', 'window', 'source', 'file', 'url', 'published-at', 'limit', 'timeout', 'draft'],
    craft: ['as']
  };
  if (!allowed[command]) throw new Error(`Unknown command: ${command}`);
  for (const flag of args.flags.keys()) if (!['root', 'json', ...allowed[command]!].includes(flag)) throw new Error(`Unsupported option --${flag} for ${command}`);
  const option = (name: string, required = false): string | undefined => {
    const value = args.flags.get(name);
    if (typeof value === 'string') return value;
    if (required) throw new Error(`--${name} is required`);
    return undefined;
  };
  const position = (index: number, label: string): string => {
    const value = args.positional[index];
    if (!value) throw new Error(`${label} is required`);
    return value;
  };
  const count = (max: number): void => { if (args.positional.length > max) throw new Error('Too many positional arguments'); };
  const print = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };
  if (command === 'craft' && args.positional[0] !== 'use') {
    const action = position(0, 'craft action'); count(action === 'list' ? 1 : 2);
    if (![...args.flags.keys()].every(flag => ['json', 'root'].includes(flag))) throw new Error('Craft options apply only to use');
    if (action === 'list') print(craftProfiles());
    else if (action === 'show') print(craftProfile(position(1, 'profile')));
    else throw new Error('Craft action must be list, show or use');
    return;
  }
  if (command === 'init') {
    count(1);
    if (args.positional[0] && option('root')) throw new Error('Use init PATH or --root, not both');
    const result = initProject(resolve(args.positional[0] ?? option('root') ?? process.cwd()), option('name'), { memoryBackend: option('backend') as 'microsoft-graphrag' | 'local' | undefined });
    const project = new Project(result.root);
    try { if (!project.store.revisions().length) project.sync(); } finally { project.close(); }
    print(result); return;
  }
  const prices = () => { const path = option('prices'); if (!path) return undefined; const value = readJson<Prices>(resolve(path)); validatePrices(value); return value; };
  if (command === 'benchmark') {
    count(1); const action = position(0, 'benchmark action');
    const flags = action === 'run' ? ['mode', 'dataset', 'out', 'provider', 'max-operations', 'arms', 'budget', 'method'] : action === 'score' ? ['run', 'ratings', 'prices'] : [];
    if (!['run', 'score'].includes(action)) throw new Error('Benchmark action must be run or score');
    for (const flag of args.flags.keys()) if (!['json', ...flags].includes(flag)) throw new Error(`Unsupported option --${flag} for benchmark ${action}`);
    if (action === 'score') { print(scoreBenchmark(option('run', true)!, option('ratings', true)!, prices())); return; }
    const controller = new AbortController(), stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { const result = await runBenchmark({ mode: option('mode') as 'offline' | 'live' | undefined, dataset: option('dataset'), out: option('out'), provider: option('provider'),
      maxOperations: option('max-operations') === undefined ? undefined : positiveInteger(option('max-operations'), 'max-operations'),
      arms: option('arms')?.split(',') as BenchmarkArm[] | undefined, budget: option('budget') === undefined ? undefined : positiveInteger(option('budget'), 'budget'),
      method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined, signal: controller.signal,
      onProgress: event => { if (event.operation) process.stderr.write(JSON.stringify({ event: 'benchmark-progress', ...event }) + '\n'); } });
      print({ directory: result.directory, report: result.report, data: result.data, runId: result.runId, mode: result.mode, status: result.status,
        cases: result.cases.length, arms: result.arms, modelCalls: result.modelCalls, scheduledOperations: result.scheduledOperations, qualityEligible: result.qualityEligible, note: result.note }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); } return;
  }
  if (command === 'version') {
    count(2); const action = position(0, 'version action');
    const flags: Record<string, string[]> = { init: [], save: ['message'], log: [], status: [], bundle: ['out'], restore: ['to', 'bundle'] };
    if (!flags[action]) throw new Error('Version action must be init, save, log, bundle or restore');
    for (const flag of args.flags.keys()) if (!['root', 'json', ...flags[action]!].includes(flag)) throw new Error(`Unsupported option --${flag} for version ${action}`);
    if (action !== 'restore' && args.positional.length > 1) throw new Error('Too many positional arguments');
    const root = option('root') ? resolve(option('root')!) : action === 'restore' && option('bundle') ? process.cwd() : findRoot(process.cwd());
    const versions = new BookVersions(root);
    if (action === 'restore') { print(versions.restore(position(1, 'checkpoint hash or HEAD'), option('to', true)!, option('bundle'))); return; }
    if (action === 'log') { print(versions.log()); return; }
    if (action === 'bundle') { print(versions.bundle(option('out', true)!)); return; }
    const book = new Project(root);
    try { print(action === 'init' ? versions.init(book) : action === 'status' ? versions.status(book) : versions.save(book, option('message'))); }
    finally { book.close(); }
    return;
  }
  const project = new Project(option('root') ? resolve(option('root')!) : findRoot(process.cwd()));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (command !== 'read') { process.once('SIGINT', cancel); process.once('SIGTERM', cancel); }
  const memoryOptions = { signal: controller.signal, onProgress: (progress: import('./microsoft-graphrag.js').IndexProgress) => process.stderr.write(JSON.stringify({ event: 'graphrag-progress', ...progress }) + '\n') };
  try {
    switch (command) {
      case 'research': {
        const library = new ResearchLibrary(project.root), action = position(0, 'research action');
        const flags: Record<string, string[]> = {
          create: ['kind', 'title', 'question', 'platform', 'audience', 'window'],
          capture: ['source', 'file', 'title', 'kind', 'url', 'published-at'],
          save: [], show: ['draft'], list: [], radar: ['platform', 'limit', 'timeout']
        };
        if (!flags[action]) throw new Error('Research action must be create, capture, save, show, list or radar');
        for (const flag of args.flags.keys()) if (!['root', 'json', ...flags[action]!].includes(flag)) throw new Error(`Unsupported option --${flag} for research ${action}`);
        count(action === 'list' ? 1 : 2);
        const catalog = (id: string, sourceIds?: string[]) => (sourceIds === undefined ? library.listSources(id) : sourceIds.map(sourceId => library.source(id, sourceId)))
          .map(({ content, ...metadata }) => ({ ...metadata, characters: content.length }));
        if (action === 'list') { print(library.list()); break; }
        const id = identifier(position(1, 'research id'));
        if (action === 'create') print({ draftPath: project.store.transaction(() => library.create(id, { kind: option('kind', true)! as 'market' | 'analysis' | 'craft',
          title: option('title', true)!, question: option('question', true)!, platform: option('platform'), audience: option('audience'), timeWindow: option('window') })) });
        else if (action === 'capture') {
          const content = sourceText(option('file', true)!);
          const { content: _, ...source } = project.store.transaction(() => library.capture(id, { sourceId: option('source', true)!, title: option('title', true)!,
            kind: (option('kind') ?? 'file') as 'web' | 'ranking' | 'file' | 'author', content, url: option('url'), publishedAt: option('published-at') }));
          print({ ...source, characters: content.length });
        } else if (action === 'save') print(project.store.transaction(() => library.save(id)));
        else if (action === 'show') {
          if (args.flags.has('draft')) print({ draftPath: safePath(project.root, 'specwriter', 'research', id, 'draft.json'), report: library.draft(id), sources: catalog(id) });
          else { const version = library.show(id); print({ ...version, sources: catalog(id, version.sourceHashes.map(source => source.sourceId)) }); }
        }
        else {
          const platform = option('platform', true)! as 'fanqie' | 'qidian';
          if (!['fanqie', 'qidian'].includes(platform)) throw new Error('Radar platform must be fanqie or qidian');
          const limit = option('limit') === undefined ? 15 : positiveInteger(option('limit'), 'limit');
          const timeoutMs = option('timeout') === undefined ? 10000 : positiveInteger(option('timeout'), 'timeout');
          if (limit > 50 || timeoutMs > 30000) throw new Error('Radar limit is 1..50; timeout is 1..30000 milliseconds');
          const path = safePath(project.root, 'specwriter', 'research', id, 'draft.json');
          if (existsSync(path)) { if (library.draft(id).kind !== 'market') throw new Error('Radar needs a market research report'); }
          else project.store.transaction(() => library.create(id, { kind: 'market', title: `${platform} 榜单采样`, question: '这些公开榜单样本显示哪些题材信号，证据与限制是什么？', platform, timeWindow: '本次采样时刻' }));
          const result = await collectMarket(platform, { limit, timeoutMs, signal: controller.signal });
          const captured = project.store.transaction(() => result.sources.map(source => {
            const sourceId = `${source.sourceId}-${hash(json(source)).slice(0, 12)}`;
            return library.capture(id, { ...source, sourceId });
          }));
          const report = library.draft(id);
          report.unknowns = [...new Set([...report.unknowns, ...result.issues.map(issue => `${issue.source}: ${issue.message}`),
            '榜单只代表本次公开样本；作品类型、平台口径和目标读者需要核对，尚未形成市场结论。'])].slice(-20);
          project.store.transaction(() => atomicWrite(path, json(report)));
          print({ ...result, sources: captured.map(({ content, ...source }) => ({ ...source, characters: content.length })), sourceIds: captured.map(source => source.sourceId), draftPath: path,
            nextAction: 'Read captured sources, complete the evidence/interpretation/directions in the draft, then research save; no report or canon was adopted automatically' });
          if (result.status === 'unavailable') process.exitCode = 1;
        }
        break;
      }
      case 'craft': {
        count(2);
        if (position(0, 'craft action') !== 'use') throw new Error('Craft action must be list, show or use');
        print(project.store.transaction(() => useCraftProfile(new ResearchLibrary(project.root), position(1, 'profile'), option('as', true)!)));
        break;
      }
      case 'status': count(0); print(project.status()); break;
      case 'resume': count(0); print(project.resume(option('work'))); break;
      case 'contract': {
        count(1); const action = position(0, 'contract action');
        if (!['show', 'adopt'].includes(action)) throw new Error('Contract action must be show or adopt');
        for (const flag of args.flags.keys()) if (!['root', 'json', ...(action === 'adopt' ? ['reason', 'from'] : [])].includes(flag)) throw new Error(`Unsupported option --${flag} for contract ${action}`);
        if (action === 'show') print(project.workflow.contracts());
        else { const result = project.workflow.adopt(option('reason', true)!, option('from') === undefined ? undefined : positiveInteger(option('from'), 'from')); project.sync(); print(result); }
        break;
      }
      case 'work': {
        count(2); const action = position(0, 'work action'), id = position(1, 'work id');
        if (!['show', 'authorize', 'pause', 'resume'].includes(action)) throw new Error('Work action must be show, authorize, pause or resume');
        for (const flag of args.flags.keys()) if (!['root', 'json', ...(action === 'show' ? [] : action === 'authorize' ? ['from', 'to', 'acceptance', 'reason'] : ['reason'])].includes(flag)) throw new Error(`Unsupported option --${flag} for work ${action}`);
        print(action === 'show' ? { work: project.store.work(id), policy: project.store.policy(id) ?? null } : action === 'authorize'
          ? project.workflow.authorize(id, positiveInteger(option('from', true), 'from'), positiveInteger(option('to', true), 'to'), option('acceptance', true)! as 'draft' | 'auto', option('reason', true)!)
          : project.workflow.pause(id, action === 'pause', option('reason', true)!)); break;
      }
      case 'intent': {
        count(2); const action = position(0, 'intent action'), chapter = positiveInteger(position(1, 'chapter'), 'chapter'), work = option('work', true)!;
        if (!['seed', 'save', 'show'].includes(action)) throw new Error('Intent action must be seed, save or show');
        print(action === 'seed' ? project.workflow.seed(chapter, work) : action === 'save' ? project.workflow.saveIntent(chapter, work) : project.workflow.readIntent(chapter, work)); break;
      }
      case 'propose': count(1); print(project.propose(position(0, 'work id'), option('title', true)!, positiveInteger(option('from', true), 'from'), positiveInteger(option('to', true), 'to'))); break;
      case 'prepare': count(1); print(await new WriterMemory(project).prepare(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!, { ...memoryOptions, query: option('query'), budget: option('budget') === undefined ? undefined : positiveInteger(option('budget'), 'budget'), refresh: args.flags.has('refresh') })); break;
      case 'hash': count(1); print(project.hashes(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'review-requirements': count(1); print(project.reviewRequirements(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'verify': count(1); print(project.verify(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'commit': count(1); print(project.commit(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'history': count(1); print(project.store.history(positiveInteger(position(0, 'chapter'), 'chapter'))); break;
      case 'archive': count(1); print(project.archive(position(0, 'work id'))); break;
      case 'sync': count(0); print(project.sync({ capture: args.flags.has('capture') })); break;
      case 'doctor': {
        count(0); if (args.flags.has('probe') && !args.flags.has('models')) throw new Error('--probe requires --models');
        const result = project.doctor();
        const models = args.flags.has('models') ? await new MicrosoftGraphRag(project).diagnose({ probe: args.flags.has('probe'), signal: controller.signal }) : undefined;
        print({ ...result, ...(models ? { models } : {}) });
        if (!result.healthy || (models && (!models.runtime.ready || !models.configured || (args.flags.has('probe') && !models.ready)))) process.exitCode = 1;
        break;
      }
      case 'export': count(0); print(new NovelReader(project).writeExport((option('format') ?? 'txt') as 'txt' | 'md' | 'html')); break;
      case 'read': {
        count(0);
        const draft = args.flags.has('draft');
        if (!draft && option('work')) throw new Error('--work requires --draft');
        const works = project.store.works().filter(item => item.status === 'active');
        const work = option('work') ?? (draft && works.length === 1 ? works[0]!.id : undefined);
        if (draft && !work) throw new Error('Choose a draft work with --work ID');
        const port = option('port') === undefined ? undefined : Number(option('port'));
        const running = await startReader(project, { draft, work, port });
        print({ url: running.url, scope: draft ? 'draft' : 'accepted', workId: work ?? null, stop: 'Ctrl+C' });
        if (!args.flags.has('no-open')) {
          const child = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', running.url], { windowsHide: true, stdio: 'ignore', detached: true })
            : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [running.url], { stdio: 'ignore', detached: true });
          child.once('error', () => process.stderr.write(`Open ${running.url} in your browser.\n`)); child.unref();
        }
        await new Promise<void>((resolve, reject) => {
          const stop = () => { running.close().then(resolve, reject); };
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          running.server.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); });
        });
        break;
      }
      case 'feedback': {
        const reader = new NovelReader(project), action = position(0, 'feedback action');
        const actionFlags: Record<string, string[]> = { resolve: ['reopen'], list: ['chapter', 'work'], request: ['chapter', 'work'], decide: ['decision', 'reason', 'work', 'anchor'], reconcile: ['chapter', 'work'] };
        if (!actionFlags[action]) throw new Error('Feedback action must be list, request, resolve, decide or reconcile');
        for (const flag of args.flags.keys()) if (!['root', 'json', ...actionFlags[action]!].includes(flag)) throw new Error(`Unsupported option --${flag} for feedback ${action}`);
        if (action === 'decide') {
          count(2);
          print(reader.feedbackDecision(position(1, 'feedback id'), { decision: option('decision', true)! as 'adopt' | 'decline' | 'clarify', reason: option('reason', true)!,
            ...(option('work') ? { workId: option('work') } : {}), ...(option('anchor') ? { anchor: readJson(option('anchor')!) } : {}) }));
        } else if (action === 'reconcile') {
          count(1); const chapter = positiveInteger(option('chapter', true), 'chapter'), work = option('work', true)!;
          const revision = project.store.revisions().find(item => item.chapter === chapter && item.workId === work && !item.stale);
          if (!revision) throw new Error('No current accepted revision from this work to reconcile');
          print(reader.markFeedbackApplied(chapter, work, revision.id));
        } else if (action === 'resolve') {
          count(2);
          if (option('chapter') || option('work')) throw new Error('Resolve feedback by its id');
          print(reader.resolveFeedback(position(1, 'feedback id'), !args.flags.has('reopen')));
        } else if (action === 'list' || action === 'request') {
          count(1);
          if (args.flags.has('reopen')) throw new Error('--reopen applies only to feedback resolve');
          if (option('work') && !option('chapter')) throw new Error('--work requires --chapter');
          const chapter = option('chapter') === undefined ? undefined : positiveInteger(option('chapter'), 'chapter');
          const key = chapter === undefined ? undefined : option('work') ? `draft:${option('work')}:${chapter}` : `accepted:${chapter}`;
          if (key) reader.chapter(key);
          print(action === 'list' ? reader.feedback(key) : { text: reader.revisionRequest(key) });
        } else throw new Error('Feedback action must be list, request or resolve');
        break;
      }
      case 'instruction': {
        const instructions = new AuthorInstructions(project.root, project.store), action = position(0, 'instruction action');
        const actionFlags: Record<string, string[]> = { add: ['text', 'kind', 'from', 'to', 'work'], list: ['chapter', 'work'], retire: ['reason'] };
        if (!actionFlags[action]) throw new Error('Instruction action must be add, list or retire');
        for (const flag of args.flags.keys()) if (!['root', 'json', ...actionFlags[action]!].includes(flag)) throw new Error(`Unsupported option --${flag} for instruction ${action}`);
        count(action === 'list' ? 1 : 2);
        if (action === 'list') print(instructions.list(option('chapter') === undefined ? undefined : positiveInteger(option('chapter'), 'chapter'), option('work')));
        else if (action === 'retire') print(instructions.retire(position(1, 'instruction id'), option('reason', true)!));
        else {
          const result = instructions.add(position(1, 'instruction id'), { text: option('text', true)!, kind: (option('kind') ?? 'require') as 'require' | 'avoid',
            fromChapter: positiveInteger(option('from', true), 'from'), toChapter: option('to') === undefined ? undefined : positiveInteger(option('to'), 'to'), workId: option('work') });
          project.sync(); print(result);
        }
        break;
      }
      case 'memory': {
        const subcommand = position(0, 'memory subcommand');
        if (option('prices') && !['usage', 'budget'].includes(subcommand)) throw new Error('--prices applies only to memory usage/budget');
        const memoryFlags: Record<string, string[]> = { show: ['at'], usage: ['prices'], budget: ['prices', 'max-requests', 'max-tokens', 'max-cost', 'unknown-usage'], rebuild: [], graph: ['at', 'holder'], configure: ['backend', 'method', 'auto-index', 'retain'], query: ['at', 'holder', 'limit', 'hops', 'backend', 'method'] };
        if (subcommand !== 'graphrag') {
          if (!memoryFlags[subcommand]) throw new Error('Unknown memory subcommand');
          for (const flag of args.flags.keys()) if (!['root', 'json', ...memoryFlags[subcommand]!].includes(flag)) throw new Error(`Unsupported option --${flag} for memory ${subcommand}`);
        }
        let at: number | undefined;
        if (option('at') !== undefined) {
          at = Number(option('at'));
          if (!Number.isSafeInteger(at) || at < 0) throw new Error('at must be a nonnegative integer');
        }
        if (subcommand === 'show') { count(1); print(project.memory(at)); }
        else if (subcommand === 'usage') {
          count(1);
          print(new UsageLedger(project.root).report(prices()));
        }
        else if (subcommand === 'budget') {
          count(2); const ledger = new UsageLedger(project.root), action = position(1, 'budget action');
          if (action !== 'configure' && [...args.flags.keys()].some(flag => !['root', 'json'].includes(flag))) throw new Error('Budget options apply only to configure');
          const numeric = (flag: string) => option(flag) === undefined ? undefined : Number(option(flag));
          if (action === 'show') print(ledger.budgetStatus());
          else if (action === 'clear') print(ledger.configureBudget(null));
          else if (action === 'recover') print(ledger.recoverBudget());
          else if (action === 'configure') print(ledger.configureBudget({ schemaVersion: 1, maxRequestsPerOperation: numeric('max-requests'), maxObservedTokens: numeric('max-tokens'),
            maxEstimatedCost: numeric('max-cost'), prices: prices(), unknownUsage: (option('unknown-usage') ?? 'block') as 'block' | 'allow' }));
          else throw new Error('Budget action must be show, configure, clear or recover');
        }
        else if (subcommand === 'rebuild') { count(1); print(project.rebuildSearch()); }
        else if (subcommand === 'graph') { count(1); print(project.graph(at, option('holder'))); }
        else if (subcommand === 'configure') {
          count(1);
          const autoIndex = option('auto-index');
          if (autoIndex !== undefined && !['true', 'false'].includes(autoIndex)) throw new Error('--auto-index must be true or false');
          const retain = option('retain') === undefined ? undefined : Number(option('retain'));
          print(configureMemory(project.root, { backend: option('backend', true)! as 'microsoft-graphrag' | 'local', method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined, ...(autoIndex === undefined ? {} : { autoIndex: autoIndex === 'true' }), ...(retain === undefined ? {} : { indexRetention: retain }) }));
        }
        else if (subcommand === 'query') { count(2); print(await new WriterMemory(project).query(position(1, 'query text'), { ...memoryOptions, at, holder: option('holder'), limit: option('limit') === undefined ? undefined : positiveInteger(option('limit'), 'limit'), hops: option('hops') === undefined ? undefined : positiveInteger(option('hops'), 'hops'), backend: option('backend') as 'microsoft-graphrag' | 'local' | undefined, method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined })); }
        else if (subcommand === 'graphrag') {
          if (option('holder') || option('hops') || option('limit')) throw new Error('Microsoft GraphRAG returns author-level advisory answers; --holder, --hops and --limit apply only to local memory query');
          const provider = new MicrosoftGraphRag(project);
          const action = position(1, 'GraphRAG action');
          const actionFlags: Record<string, string[]> = { setup: ['python', 'model', 'embedding', 'env-file', 'credentials', 'provider', 'embedding-base', 'embedding-dimensions', 'reconfigure', 'preset'], diagnose: ['probe'], index: ['at', 'rebuild'], query: ['at', 'method'], export: ['at'], status: ['at'], recover: ['at'], prune: ['keep', 'dry-run'] };
          if (!actionFlags[action]) throw new Error('Unknown GraphRAG action');
          for (const flag of args.flags.keys()) if (!['root', 'json', ...actionFlags[action]!].includes(flag)) throw new Error(`Unsupported option --${flag} for GraphRAG ${action}`);
          if (action === 'export') { count(2); print(provider.export(at)); }
          else if (action === 'setup') { count(2);
            const preset = option('preset');
            if (preset && preset !== 'qwen-bge-m3') throw new Error('Unknown model preset');
            if (preset && ['embedding', 'embedding-base', 'embedding-dimensions'].some(flag => args.flags.has(flag))) throw new Error('The preset supplies embedding settings; omit explicit embedding options');
            if (option('env-file') && option('credentials')) throw new Error('Use --credentials or --env-file, not both');
            const credentials = option('credentials') ?? option('env-file');
            if (preset && !credentials) throw new Error('--preset qwen-bge-m3 requires --credentials FILE');
            print(await provider.setup({ python: option('python', true)!, model: option('model'), embedding: preset ? 'bge-m3' : option('embedding', true)!,
            envFile: credentials, provider: option('provider'), embeddingBase: option('embedding-base'),
            embeddingDimensions: option('embedding-dimensions') === undefined ? undefined : positiveInteger(option('embedding-dimensions'), 'embedding-dimensions'), reconfigure: args.flags.has('reconfigure'),
            ...(preset ? { embeddingBase: 'http://127.0.0.1:11434/v1', embeddingDimensions: 1024 } : {}) })); }
          else if (action === 'diagnose') { count(2); const result = await provider.diagnose({ probe: args.flags.has('probe'), signal: controller.signal }); print(result);
            if (!result.runtime.ready || !result.configured || (args.flags.has('probe') && !result.ready)) process.exitCode = 1; }
          else if (action === 'index') { count(2); print(await provider.index(at, { ...memoryOptions, rebuild: args.flags.has('rebuild') })); }
          else if (action === 'query') { count(3); print(await provider.query(position(2, 'query text'), { signal: controller.signal, at, method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined })); }
          else if (action === 'status') { count(2); print(provider.inspect(at)); }
          else if (action === 'recover') { count(2); print(provider.recover(at)); }
          else if (action === 'prune') { count(2); print(await provider.prune({ keep: option('keep') === undefined ? undefined : positiveInteger(option('keep'), 'keep'), dryRun: args.flags.has('dry-run') })); }
        }
        else throw new Error('Memory subcommand must be show, query, configure, graph, rebuild or graphrag');
        break;
      }
    }
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); project.close(); }
}
try { await main(); }
catch (error) {
  const message = (error as Error).message;
  if (process.argv.includes('--json')) process.stderr.write(JSON.stringify({ error: message }) + '\n');
  else process.stderr.write(`SpecWriter: ${message}\n`);
  process.exitCode = 1;
}
