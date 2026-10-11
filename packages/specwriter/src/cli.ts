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

const help = `SpecWriter 0.4 — Codex fiction workflows + WriterMemory + local novel reader

Usage: specwriter <command> [arguments] [--root PATH] [--json]

  init [PATH] --name TITLE [--backend microsoft-graphrag|local]
                                Create a book; Microsoft GraphRAG is the default backend
  status                        Recover progress, drafts and memory freshness
  propose ID --title TITLE --from N --to N
                                Scaffold a scoped writing/revision work package
  prepare N --work ID [--query TEXT] [--budget CHARS] [--refresh]
                                Compile context and prepare chapter artifacts
  hash N --work ID               Get draft/context hashes for extraction and review
  verify N --work ID             Validate evidence, freshness and blocking issues
  commit N --work ID             Accept prose and memory in one SQLite transaction
  memory show [--at N]           Show reconciled chapter-bounded memory (N may be 0)
  memory query TEXT [--at N] [--method local|global|drift|basic]
                                Default Microsoft GraphRAG retrieval; auto-index accepted prefix
  memory query TEXT --backend local [--at N] [--holder NAME] [--hops 1..4]
                                Explicit offline structural memory retrieval
  memory configure --backend microsoft-graphrag|local [--method METHOD] [--auto-index true|false]
                                Set the book's memory backend; no silent fallback
  memory graph [--at N] [--holder NAME]
                                Export the chapter-bounded provenance graph as JSON
  memory rebuild                Rebuild derived full-text and graph indexes
  memory graphrag export [--at N]
                                Export an immutable accepted-prose prefix (no model)
  memory graphrag setup --python EXE --model MODEL --embedding MODEL
                                Initialize the default Microsoft GraphRAG 3.3.x provider
  memory graphrag index [--at N]
                                Build prefix-isolated embeddings and community reports
  memory graphrag query TEXT [--at N] [--method local|global|drift|basic]
                                Retrieve an advisory answer from Microsoft GraphRAG
  history N                     List accepted chapter revisions
  archive ID                    Close completed work without promoting plans to facts
  sync [--capture]              Rebuild projections; preserve direct edits as drafts
  doctor                        Check database, provenance and projected files
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
  const booleans = new Set(['json', 'help', 'refresh', 'capture', 'draft', 'no-open', 'reopen']);
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
    hash: ['work'], verify: ['work'], commit: ['work'], memory: ['at', 'holder', 'limit', 'hops', 'python', 'model', 'embedding', 'method', 'backend', 'auto-index'], history: [], archive: [], sync: ['capture'], doctor: [],
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
  const project = new Project(option('root') ? resolve(option('root')!) : findRoot(process.cwd()));
  try {
    switch (command) {
      case 'status': count(0); print(project.status()); break;
      case 'propose': count(1); print(project.propose(position(0, 'work id'), option('title', true)!, positiveInteger(option('from', true), 'from'), positiveInteger(option('to', true), 'to'))); break;
      case 'prepare': count(1); print(await new WriterMemory(project).prepare(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!, { query: option('query'), budget: option('budget') === undefined ? undefined : positiveInteger(option('budget'), 'budget'), refresh: args.flags.has('refresh') })); break;
      case 'hash': count(1); print(project.hashes(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'verify': count(1); print(project.verify(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'commit': count(1); print(project.commit(positiveInteger(position(0, 'chapter'), 'chapter'), option('work', true)!)); break;
      case 'history': count(1); print(project.store.history(positiveInteger(position(0, 'chapter'), 'chapter'))); break;
      case 'archive': count(1); print(project.archive(position(0, 'work id'))); break;
      case 'sync': count(0); print(project.sync({ capture: args.flags.has('capture') })); break;
      case 'doctor': { count(0); const result = project.doctor(); print(result); if (!result.healthy) process.exitCode = 1; break; }
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
        let at: number | undefined;
        if (option('at') !== undefined) {
          at = Number(option('at'));
          if (!Number.isSafeInteger(at) || at < 0) throw new Error('at must be a nonnegative integer');
        }
        if (subcommand === 'show') { count(1); print(project.memory(at)); }
        else if (subcommand === 'rebuild') { count(1); print(project.rebuildSearch()); }
        else if (subcommand === 'graph') { count(1); print(project.graph(at, option('holder'))); }
        else if (subcommand === 'configure') {
          count(1);
          const autoIndex = option('auto-index');
          if (autoIndex !== undefined && !['true', 'false'].includes(autoIndex)) throw new Error('--auto-index must be true or false');
          print(configureMemory(project.root, { backend: option('backend', true)! as 'microsoft-graphrag' | 'local', method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined, ...(autoIndex === undefined ? {} : { autoIndex: autoIndex === 'true' }) }));
        }
        else if (subcommand === 'query') { count(2); print(await new WriterMemory(project).query(position(1, 'query text'), { at, holder: option('holder'), limit: option('limit') === undefined ? undefined : positiveInteger(option('limit'), 'limit'), hops: option('hops') === undefined ? undefined : positiveInteger(option('hops'), 'hops'), backend: option('backend') as 'microsoft-graphrag' | 'local' | undefined, method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined })); }
        else if (subcommand === 'graphrag') {
          if (option('holder') || option('hops') || option('limit')) throw new Error('Microsoft GraphRAG returns author-level advisory answers; --holder, --hops and --limit apply only to local memory query');
          const provider = new MicrosoftGraphRag(project);
          const action = position(1, 'GraphRAG action');
          if (action === 'export') { count(2); print(provider.export(at)); }
          else if (action === 'setup') { count(2); print(await provider.setup({ python: option('python', true)!, model: option('model', true)!, embedding: option('embedding', true)! })); }
          else if (action === 'index') { count(2); print(await provider.index(at)); }
          else if (action === 'query') { count(3); print(await provider.query(position(2, 'query text'), { at, method: option('method') as 'local' | 'global' | 'drift' | 'basic' | undefined })); }
          else throw new Error('GraphRAG action must be setup, export, index or query');
        }
        else throw new Error('Memory subcommand must be show, query, configure, graph, rebuild or graphrag');
        break;
      }
    }
  } finally { project.close(); }
}
try { await main(); }
catch (error) {
  const message = (error as Error).message;
  if (process.argv.includes('--json')) process.stderr.write(JSON.stringify({ error: message }) + '\n');
  else process.stderr.write(`SpecWriter: ${message}\n`);
  process.exitCode = 1;
}
