#!/usr/bin/env node
import { resolve } from 'node:path';
import { configureMemory, findRoot, initProject } from './init.js';
import { positiveInteger } from './files.js';
import { Project } from './project.js';
import { MicrosoftGraphRag } from './microsoft-graphrag.js';
import { WriterMemory } from './writer-memory.js';
import { NovelReader } from './reader.js';
import { startReader } from './reader-server.js';
import { spawn } from 'node:child_process';
import { UsageLedger, validatePrices, type Prices } from './usage.js';
import { readJson } from './files.js';
import { BookVersions } from './versions.js';
import { runBenchmark, scoreBenchmark, type BenchmarkArm } from './benchmark.js';

const help = `SpecWriter 0.7 — Codex fiction workflows + WriterMemory + local novel reader

Usage: specwriter <command> [arguments] [--root PATH] [--json]

  init [PATH] --name TITLE [--backend microsoft-graphrag|local]
                                Create a book; Microsoft GraphRAG is the default backend
  status                        Recover progress, drafts and memory freshness
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

Codex: $specwriter-explore / propose / write / review / revise / commit / archive
Codex writes prose, extraction and review artifacts. Default prepare/query use Microsoft
GraphRAG and call configured models for nonempty corpora; explicit local mode uses no model.
`;
interface Arguments { positional: string[]; flags: Map<string, string | boolean> }
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
    hash: ['work'], verify: ['work'], commit: ['work'], memory: ['at', 'holder', 'limit', 'hops', 'python', 'model', 'embedding', 'env-file', 'credentials', 'provider', 'embedding-base', 'embedding-dimensions', 'reconfigure', 'preset', 'probe', 'method', 'backend', 'auto-index', 'retain', 'keep', 'rebuild', 'dry-run', 'prices', 'max-requests', 'max-tokens', 'max-cost', 'unknown-usage'], history: [], archive: [], sync: ['capture'], doctor: ['models', 'probe'],
    'review-requirements': ['work'], version: ['message', 'to', 'bundle', 'out'],
    benchmark: ['mode', 'dataset', 'out', 'provider', 'max-operations', 'arms', 'budget', 'method', 'run', 'ratings', 'prices'],
    read: ['draft', 'work', 'port', 'no-open'], export: ['format'], feedback: ['chapter', 'work', 'reopen']
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
      case 'status': count(0); print(project.status()); break;
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
        if (action === 'resolve') {
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
