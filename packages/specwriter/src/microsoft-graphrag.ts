import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { assetsRoot, atomicWrite, chapterId, hash, json, readJson, safePath, writeNew } from './files.js';
import type { Project } from './project.js';
import type { GraphRagMethod, RetrievalReceipt, RetrievalSource } from './types.js';
import { UsageLedger } from './usage.js';

export interface ProcessResult { stdout: string; stderr: string }
export interface ProcessOptions { signal?: AbortSignal; timeoutMs?: number; onSpawn?: (pid: number) => void; metricsPath?: string }
export type ProcessRunner = (executable: string, args: string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>;

/** Keep prompts/keys out of error output; detailed logs remain in the private workspace. */
export const runGraphRag: ProcessRunner = (executable, args, cwd, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error('GraphRAG operation cancelled')); return; }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) { reject(new Error('GraphRAG timeout must be a positive integer')); return; }
  const observedArgs = options.metricsPath && args[0] === '-m' && args[1] === 'graphrag'
    ? ['-X', 'utf8', safePath(assetsRoot, 'graphrag-observe.py'), options.metricsPath, ...args.slice(2)] : args;
  const child = spawn(executable, observedArgs, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Stream decoders preserve Chinese characters even across split UTF-8 pipe chunks.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = ''; let stderr = ''; let overflow = false;
  const limit = 4 * 1024 * 1024;
  let stopReason = '';
  const stop = (reason: string) => { stopReason = reason; child.kill(); };
  const abort = () => stop('GraphRAG operation cancelled; unfinished index is not marked ready');
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('GraphRAG timed out; unfinished index is not marked ready'), options.timeoutMs ?? 60 * 60 * 1000);
  const append = (value: string, target: 'stdout' | 'stderr'): void => {
    if (stdout.length + stderr.length + value.length > limit) { overflow = true; child.kill(); return; }
    if (target === 'stdout') stdout += value; else stderr += value;
  };
  child.stdout.on('data', value => append(value, 'stdout'));
  child.stderr.on('data', value => append(value, 'stderr'));
  child.on('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(new Error(`Cannot start GraphRAG Python (${(error as NodeJS.ErrnoException).code ?? 'error'}); check --python and the graphrag installation`)); });
  child.on('close', code => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (stopReason) reject(new Error(stopReason));
    else if (overflow) reject(new Error('GraphRAG output exceeded the capture limit; inspect its private logs'));
    else if (code !== 0) reject(new Error(`GraphRAG exited with code ${code}; inspect private workspace logs (credentials are not printed)`));
    else resolve({ stdout, stderr });
  });
  if (child.pid !== undefined) try { options.onSpawn?.(child.pid); }
  catch { stop('GraphRAG process tracking failed; operation cancelled'); }
});

interface Provider { schemaVersion: 1; python: string; version: string }
interface CorpusFile { name: string; chapter: number; revision: number; bodyHash: string }
interface Manifest { schemaVersion: 1; snapshotId: string; atChapter: number; files: CorpusFile[] }
interface Ready { schemaVersion: 1; snapshotId: string; version: string; configHash: string; corpusHash: string; outputHash: string;
  indexing?: { mode: 'standard' | 'incremental'; parentSnapshotId?: string; addedChapters: number; durationMs: number } }
export interface IndexProgress { snapshotId: string; atChapter: number; phase: 'starting' | 'cloning' | 'indexing' | 'ready' | 'failed'; mode: 'standard' | 'incremental'; addedChapters: number }
export interface IndexOptions { reuse?: boolean; rebuild?: boolean; signal?: AbortSignal; onProgress?: (progress: IndexProgress) => void;
  /** Experimental ablation; normal WriterMemory always uses incremental. */
  strategy?: 'incremental' | 'full'; cacheFromPrefix?: boolean }
const requiredOutputs = ['documents.parquet', 'text_units.parquet', 'entities.parquet', 'relationships.parquet', 'communities.parquet', 'community_reports.parquet'];

/** Microsoft backend for default WriterMemory retrieval. Every index is isolated by accepted prefix and revision. */
export class MicrosoftGraphRag {
  constructor(readonly project: Project, private readonly runner: ProcessRunner = runGraphRag) {}
  private async run(executable: string, args: string[], root: string, signal?: AbortSignal) {
    const operation = args[0] === '-m' && args[1] === 'graphrag' && ['index', 'update', 'query'].includes(args[2]!) ? args[2] as 'index' | 'update' | 'query' : undefined;
    const ledger = new UsageLedger(this.project.root);
    const session = operation ? ledger.start(root, operation) : undefined;
    let success = false;
    try {
    const result = await this.runner(executable, args, root, { signal, ...(session ? { metricsPath: session.rawPath } : {}), onSpawn: childPid => {
      const path = safePath(root, '.specwriter-operation.lock');
      if (!existsSync(path)) return;
      const lock = readJson<{ pid: number; startedAt: string; childPid?: number }>(path);
      if (lock.pid !== process.pid) throw new Error('GraphRAG lock ownership changed');
      atomicWrite(path, json({ ...lock, childPid }));
    } });
    success = true; return result;
    } finally {
      if (session) try { ledger.finish(session, success); }
      catch { process.stderr.write('SpecWriter: could not persist GraphRAG usage; this operation has unknown usage.\n'); }
    }
  }
  private path(...parts: string[]): string { return safePath(this.project.root, '.specwriter', 'graphrag', ...parts); }
  private provider(): Provider {
    if (!existsSync(this.path('provider.json'))) throw new Error('Microsoft GraphRAG is the default memory backend. Run memory graphrag setup --python EXE --model MODEL --embedding MODEL and configure its .env; select memory.backend: local explicitly for offline use');
    const provider = readJson<Provider>(this.path('provider.json'));
    if (provider.schemaVersion !== 1 || !provider.python || !/^3\.3\./.test(provider.version)) throw new Error('Unsupported GraphRAG provider; this adapter supports 3.3.x');
    return provider;
  }
  private async checkVersion(python: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runner(python, ['-c', 'from importlib.metadata import version; print(version("graphrag"))'], this.project.root, { signal });
    const version = result.stdout.trim();
    if (!/^3\.3\.\d+$/.test(version)) throw new Error('Install graphrag==3.3.0 in Python >=3.11,<3.14; the adapter currently supports 3.3.x');
    return version;
  }
  private async locked<T>(root: string, action: () => Promise<T>): Promise<T> {
    mkdirSync(root, { recursive: true });
    const lock = safePath(root, '.specwriter-operation.lock');
    try { writeFileSync(lock, json({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`GraphRAG workspace is busy. If its process stopped, remove ${lock} after checking the recorded PID`);
      throw error;
    }
    try { return await action(); } finally { rmSync(lock, { force: true }); }
  }
  async setup(options: { python: string; model: string; embedding: string }) {
    const python = /[\\/]/.test(options.python) ? resolve(this.project.root, options.python) : options.python;
    const version = await this.checkVersion(python);
    writeNew(this.path('.gitignore'), '*\n!.gitignore\n');
    const root = this.path('provider');
    return this.locked(root, async () => {
      if (!existsSync(safePath(root, 'settings.yaml'))) {
        await this.run(python, ['-m', 'graphrag', 'init', '--root', root, '--model', options.model, '--embedding', options.embedding], root);
      }
      if (!existsSync(safePath(root, 'settings.yaml'))) throw new Error('GraphRAG init did not produce settings.yaml');
      atomicWrite(this.path('provider.json'), json({ schemaVersion: 1, python, version }));
      return { provider: 'microsoft-graphrag', version, directory: root, settings: safePath(root, 'settings.yaml'), credentials: safePath(root, '.env'), note: 'Configure model credentials in this private .env; setup does not call an LLM. Existing settings are preserved.' };
    });
  }
  export(at?: number) {
    const corpus = this.project.corpus(at);
    const root = this.path('snapshots', corpus.snapshotId);
    const manifest: Manifest = { schemaVersion: 1, snapshotId: corpus.snapshotId, atChapter: corpus.atChapter,
      files: corpus.documents.map(document => ({ name: `${chapterId(document.chapter)}.txt`, chapter: document.chapter, revision: document.revision, bodyHash: document.bodyHash })) };
    writeNew(this.path('.gitignore'), '*\n!.gitignore\n');
    if (existsSync(safePath(root, 'manifest.json'))) {
      if (json(readJson(safePath(root, 'manifest.json'))) !== json(manifest)) throw new Error('GraphRAG corpus manifest was modified; use a fresh snapshot directory');
    } else {
      mkdirSync(safePath(root, 'input'), { recursive: true });
      if (readdirSync(safePath(root, 'input')).length) throw new Error('GraphRAG input contains untracked documents; use a fresh snapshot directory');
    }
      mkdirSync(safePath(root, 'input'), { recursive: true });
      if (readdirSync(safePath(root, 'input')).some(name => !manifest.files.some(file => file.name === name))) throw new Error('GraphRAG input contains untracked documents');
      for (const document of corpus.documents) {
        const target = safePath(root, 'input', `${chapterId(document.chapter)}.txt`);
        if (existsSync(target)) {
          if (hash(readFileSync(target, 'utf8')) !== document.bodyHash) throw new Error(`GraphRAG input was modified: ${chapterId(document.chapter)}.txt`);
          continue;
        }
        const object = this.path('documents', `${document.bodyHash}.txt`);
        writeNew(object, document.body);
        if (hash(readFileSync(object, 'utf8')) !== document.bodyHash) throw new Error('GraphRAG immutable document object was modified');
        try { linkSync(object, target); }
        catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          copyFileSync(object, target);
        }
      }
      atomicWrite(safePath(root, 'manifest.json'), json(manifest));
    this.validateInput(root, manifest);
    return { root, manifest, corpusHash: hash(json(manifest)) };
  }
  private validateInput(root: string, manifest: Manifest): void {
    const actual = readdirSync(safePath(root, 'input')).sort();
    const expected = manifest.files.map(file => file.name).sort();
    if (json(actual) !== json(expected)) throw new Error('GraphRAG input contains missing or untracked documents');
    for (const file of manifest.files) if (hash(readFileSync(safePath(root, 'input', file.name), 'utf8')) !== file.bodyHash) throw new Error(`GraphRAG input was modified: ${file.name}`);
  }
  private copyPrompts(source: string, destination: string): void {
    if (!existsSync(source)) return;
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Linked GraphRAG prompts are unsupported');
      if (entry.isDirectory()) this.copyPrompts(safePath(source, entry.name), safePath(destination, entry.name));
      else atomicWrite(safePath(destination, entry.name), readFileSync(safePath(source, entry.name), 'utf8'));
    }
  }
  private configuration(): string {
    const settings = parse(readFileSync(this.path('provider', 'settings.yaml'), 'utf8')) as Record<string, unknown>;
    if (!settings || typeof settings !== 'object') throw new Error('Invalid GraphRAG provider settings');
    // v3.3 storage layout. Never permit a shared future-containing input/cache/vector store.
    // GraphRAG expands Python Template variables in YAML, so a literal regex $ is $$.
    settings.input = { type: 'text', encoding: 'utf-8', file_pattern: '.*[.]txt$$' };
    settings.input_storage = { type: 'file', base_dir: 'input' };
    settings.output_storage = { type: 'file', base_dir: 'output' };
    settings.update_output_storage = { type: 'file', base_dir: 'update_output' };
    settings.cache = { type: 'json', storage: { type: 'file', base_dir: 'cache' } };
    const previousVector = settings.vector_store as Record<string, unknown> | undefined;
    settings.vector_store = { type: 'lancedb', db_uri: 'output/lancedb',
      ...(previousVector?.vector_size !== undefined ? { vector_size: previousVector.vector_size } : {}),
      ...(previousVector?.index_schema !== undefined ? { index_schema: previousVector.index_schema } : {}) };
    settings.table_provider = { type: 'parquet' };
    settings.reporting = { type: 'file', base_dir: 'logs' };
    // Per-request observation depends on the pinned memory store and default processor.
    // No metrics writer paths can escape a snapshot or disclose prompts/credentials.
    for (const group of ['completion_models', 'embedding_models']) {
      const models = settings[group] as Record<string, Record<string, unknown>> | undefined;
      if (models) for (const model of Object.values(models)) model.metrics = { type: 'default', store: 'memory', writer: null };
    }
    // Custom workflows could read external corpora or skip outputs; use the standard pipeline.
    delete settings.workflows;
    // Prompt files must be relative to the snapshot's own prompts directory.
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'prompt' && typeof child === 'string' && (!/^prompts\/[a-zA-Z0-9_.-]+$/.test(child))) throw new Error('GraphRAG prompts must use a relative prompts/ filename');
        inspect(child);
      }
    };
    inspect(settings);
    return stringify(settings);
  }
  private treeHash(root: string): string {
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    const walk = (directory: string, prefix: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error('Linked GraphRAG index files are unsupported');
        if (entry.isDirectory()) walk(safePath(directory, entry.name), `${prefix}${entry.name}/`);
        else {
          const fileHash = createHash('sha256');
          const fd = openSync(safePath(directory, entry.name), 'r');
          try {
            let size: number;
            while ((size = readSync(fd, buffer)) > 0) fileHash.update(buffer.subarray(0, size));
          } finally { closeSync(fd); }
          digest.update(`${prefix}${entry.name}\0${fileHash.digest('hex')}\0`);
        }
      }
    };
    walk(root, ''); return digest.digest('hex');
  }
  private configHash(root: string): string { return hash(readFileSync(safePath(root, 'settings.yaml'), 'utf8') + this.treeHash(safePath(root, 'prompts'))); }
  private credentials(root: string): void {
    const source = this.path('provider', '.env');
    if (existsSync(source)) atomicWrite(safePath(root, '.env'), readFileSync(source, 'utf8'));
    else if (existsSync(safePath(root, '.env'))) rmSync(safePath(root, '.env'));
  }
  private assertCurrent(snapshotId: string, at: number): void {
    if (this.project.corpus(at).snapshotId !== snapshotId) throw new Error('Accepted chapters changed during GraphRAG operation; discard this result and rebuild the current prefix');
  }
  private ready(exported: ReturnType<MicrosoftGraphRag['export']>, version: string): Ready {
    const readyPath = safePath(exported.root, 'ready.json');
    if (!existsSync(readyPath)) throw new Error('This accepted prefix has no complete GraphRAG index; run memory graphrag index --at N');
    const ready = readJson<Ready>(readyPath);
    this.assertCurrent(exported.manifest.snapshotId, exported.manifest.atChapter);
    this.validateInput(exported.root, exported.manifest);
    const providerConfigHash = hash(this.configuration() + this.treeHash(this.path('provider', 'prompts')));
    if (ready.schemaVersion !== 1 || ready.snapshotId !== exported.manifest.snapshotId || ready.version !== version || ready.corpusHash !== exported.corpusHash || ready.configHash !== this.configHash(exported.root) || ready.configHash !== providerConfigHash || ready.outputHash !== this.treeHash(safePath(exported.root, 'output'))) throw new Error('GraphRAG index/configuration changed or is incompatible; rebuild this snapshot');
    return ready;
  }
  private receiptKey(ready: Ready, query: string, method: GraphRagMethod): string {
    return hash(json({ snapshotId: ready.snapshotId, version: ready.version, configHash: ready.configHash, outputHash: ready.outputHash, query, method }));
  }
  private readReceipt(root: string, ready: Ready, query: string, method: GraphRagMethod, at: number): RetrievalReceipt | undefined {
    const id = this.receiptKey(ready, query, method);
    const path = safePath(root, 'queries', `${id}.json`);
    if (!existsSync(path)) return undefined;
    const record = readJson<{ receipt: RetrievalReceipt; checksum: string }>(path);
    const item = record.receipt;
    if (record.checksum !== hash(json(item)) || item.schemaVersion !== 1 || item.id !== id || item.provider !== 'microsoft-graphrag' || item.snapshotId !== ready.snapshotId || item.configHash !== ready.configHash || item.outputHash !== ready.outputHash || item.version !== ready.version || item.atChapter !== at || item.query !== query || item.method !== method || item.answerHash !== hash(item.answer)) throw new Error('GraphRAG retrieval receipt was modified; retrieve again before preparing/reviewing this chapter');
    return item;
  }
  /** Read an already generated answer without model calls; safe for deterministic commit verification. */
  cachedQuery(query: string, options: { at?: number; method?: GraphRagMethod } = {}): RetrievalReceipt | undefined {
    const provider = this.provider();
    const exported = this.export(options.at);
    if (existsSync(safePath(exported.root, '.specwriter-operation.lock'))) throw new Error('GraphRAG snapshot is busy; retry preparation or verification after its operation finishes');
    const ready = this.ready(exported, provider.version);
    return this.readReceipt(exported.root, ready, query, options.method ?? 'local', exported.manifest.atChapter);
  }
  private parent(exported: ReturnType<MicrosoftGraphRag['export']>, version: string) {
    const directory = this.path('snapshots');
    const candidates: ReturnType<MicrosoftGraphRag['export']>[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || entry.name === exported.manifest.snapshotId) continue;
      const root = safePath(directory, entry.name);
      if (!existsSync(safePath(root, 'ready.json')) || existsSync(safePath(root, '.specwriter-operation.lock'))) continue;
      try {
        const manifest = readJson<Manifest>(safePath(root, 'manifest.json'));
        if (manifest.schemaVersion !== 1 || manifest.snapshotId !== entry.name || !manifest.atChapter || manifest.atChapter >= exported.manifest.atChapter || manifest.files.length !== manifest.atChapter) continue;
        if (json(manifest.files) !== json(exported.manifest.files.slice(0, manifest.atChapter))) continue;
        candidates.push({ root, manifest, corpusHash: hash(json(manifest)) });
      } catch { /* An incomplete derived workspace cannot seed another index. */ }
    }
    for (const candidate of candidates.sort((a, b) => b.manifest.atChapter - a.manifest.atChapter)) {
      try { this.ready(candidate, version); return candidate; } catch { /* Never copy invalid or obsolete output. */ }
    }
    return undefined;
  }
  private clearDerived(root: string) {
    // Only these owned derived directories are removable; input, receipts and author settings survive.
    for (const name of ['output', 'cache', 'update_output', 'prompts']) {
      const path = safePath(root, name);
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink()) throw new Error('Cannot replace linked GraphRAG derived directories');
      rmSync(path, { recursive: true, force: true });
    }
  }
  async index(at?: number, options: IndexOptions = {}) {
    options.signal?.throwIfAborted();
    const provider = this.provider();
    const version = await this.checkVersion(provider.python, options.signal);
    options.signal?.throwIfAborted();
    const exported = this.export(at);
    if (!exported.manifest.files.length) throw new Error('Accept at least one chapter before GraphRAG indexing');
    return this.locked(exported.root, async () => {
      const settings = this.configuration();
      const readyPath = safePath(exported.root, 'ready.json');
      if (options.rebuild && existsSync(readyPath)) rmSync(readyPath);
      if (existsSync(readyPath)) {
        if (!options.reuse) throw new Error('This snapshot already has an index; query it or use --rebuild');
        const ready = this.ready(exported, version);
        this.recordReuse(exported.root, 'index');
        return { provider: 'microsoft-graphrag', indexed: true, reused: true, snapshotId: ready.snapshotId, atChapter: exported.manifest.atChapter, directory: exported.root, indexing: ready.indexing };
      }
      const started = Date.now();
      const parent = options.strategy === 'full' && !options.cacheFromPrefix ? undefined : this.parent(exported, version);
      const mode = parent && options.strategy !== 'full' ? 'incremental' as const : 'standard' as const;
      const addedChapters = exported.manifest.atChapter - (mode === 'incremental' ? parent!.manifest.atChapter : 0);
      const progress = (phase: IndexProgress['phase']) => {
        const item = { snapshotId: exported.manifest.snapshotId, atChapter: exported.manifest.atChapter, phase, mode, addedChapters };
        atomicWrite(safePath(exported.root, 'job.json'), json({ ...item, pid: process.pid, updatedAt: new Date().toISOString(), durationMs: Date.now() - started }));
        options.onProgress?.(item);
      };
      progress('starting');
      try {
      this.clearDerived(exported.root);
      if (parent) {
        progress('cloning');
        await this.locked(parent.root, async () => {
          this.ready(parent, version);
          // Copy, never hard-link mutable vectors/output. Updating the child must not change its parent.
          for (const name of mode === 'incremental' ? ['output', 'cache'] : ['cache']) {
            const source = safePath(parent.root, name);
            if (existsSync(source)) { this.treeHash(source); cpSync(source, safePath(exported.root, name), { recursive: true, errorOnExist: true, force: false }); }
          }
          this.ready(parent, version);
        });
      }
      // A failed index cannot retain a readiness marker. All paths remain snapshot-local.
      atomicWrite(safePath(exported.root, 'settings.yaml'), settings);
      this.copyPrompts(this.path('provider', 'prompts'), safePath(exported.root, 'prompts'));
      this.credentials(exported.root);
      const configHash = this.configHash(exported.root);
      if (configHash !== hash(settings + this.treeHash(this.path('provider', 'prompts')))) throw new Error('Obsolete files in snapshot prompts; remove those derived prompt files before retrying the index');
      progress('indexing');
      if (options.signal?.aborted) throw new Error('GraphRAG operation cancelled');
      await this.run(provider.python, ['-m', 'graphrag', mode === 'incremental' ? 'update' : 'index', '--root', exported.root, '--method', 'standard'], exported.root, options.signal);
      options.signal?.throwIfAborted();
      this.assertCurrent(exported.manifest.snapshotId, exported.manifest.atChapter);
      this.validateInput(exported.root, exported.manifest);
      if (this.configHash(exported.root) !== configHash) throw new Error('GraphRAG configuration changed during indexing');
      for (const name of requiredOutputs) if (!existsSync(safePath(exported.root, 'output', name))) throw new Error(`GraphRAG did not complete required output: ${name}`);
      const indexing = { mode, ...(parent ? { parentSnapshotId: parent.manifest.snapshotId } : {}), addedChapters, durationMs: Date.now() - started };
      const ready: Ready = { schemaVersion: 1, snapshotId: exported.manifest.snapshotId, version, configHash, corpusHash: exported.corpusHash, outputHash: this.treeHash(safePath(exported.root, 'output')), indexing };
      atomicWrite(readyPath, json(ready));
      if (existsSync(safePath(exported.root, 'evicted.json'))) rmSync(safePath(exported.root, 'evicted.json'));
      progress('ready');
      return { provider: 'microsoft-graphrag', indexed: true, reused: false, snapshotId: ready.snapshotId, atChapter: exported.manifest.atChapter, directory: exported.root, indexing };
      } catch (error) { if (existsSync(readyPath)) rmSync(readyPath); progress('failed'); throw error; }
    });
  }
  async query(query: string, options: { at?: number; method?: GraphRagMethod; cache?: boolean; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    if (!query.trim()) throw new Error('GraphRAG query must not be empty');
    const method = options.method ?? 'local';
    if (!['local', 'global', 'drift', 'basic'].includes(method)) throw new Error('GraphRAG method must be local, global, drift or basic');
    const provider = this.provider();
    const version = await this.checkVersion(provider.python, options.signal);
    options.signal?.throwIfAborted();
    const exported = this.export(options.at);
    return this.locked(exported.root, async () => {
      const ready = this.ready(exported, version);
      const cached = options.cache ? this.readReceipt(exported.root, ready, query, method, exported.manifest.atChapter) : undefined;
      if (cached) { this.recordReuse(exported.root, 'query'); return { ...cached, advisory: true, cached: true }; }
      this.credentials(exported.root);
      const result = await this.run(provider.python, ['-m', 'graphrag', 'query', query, '--root', exported.root, '--method', method, '--response-type', '中文回答，引用来源；区分正文事实、人物误解和推测', '--no-streaming'], exported.root, options.signal);
      options.signal?.throwIfAborted();
      if (json(this.ready(exported, version)) !== json(ready)) throw new Error('GraphRAG index changed during query');
      const answer = result.stdout.trim();
      if (!answer) throw new Error('GraphRAG returned an empty answer; no retrieval receipt was saved');
      const citations = await this.citations(provider.python, exported, answer, options.signal);
      options.signal?.throwIfAborted();
      if (json(this.ready(exported, version)) !== json(ready)) throw new Error('GraphRAG index changed during citation resolution');
      const receipt: RetrievalReceipt = { schemaVersion: 1, id: this.receiptKey(ready, query, method), provider: 'microsoft-graphrag', version, method, atChapter: exported.manifest.atChapter, snapshotId: ready.snapshotId, configHash: ready.configHash, outputHash: ready.outputHash, query, answer, answerHash: hash(answer), ...citations };
      atomicWrite(safePath(exported.root, 'queries', `${receipt.id}.json`), json({ receipt, checksum: hash(json(receipt)) }));
      return { ...receipt, advisory: true, cached: false };
    });
  }
  private recordReuse(root: string, operation: 'index' | 'query') {
    try { new UsageLedger(this.project.root).reused(root, operation); }
    catch { process.stderr.write('SpecWriter: could not persist GraphRAG cache reuse metrics.\n'); }
  }
  private async citations(python: string, exported: ReturnType<MicrosoftGraphRag['export']>, answer: string, signal?: AbortSignal) {
    if (!/\[Data:/i.test(answer)) return { sources: [], unresolvedCitations: [] };
    const path = safePath(exported.root, 'queries', `${randomUUID()}.answer.txt`);
    atomicWrite(path, answer);
    try {
      const result = await this.run(python, ['-X', 'utf8', safePath(assetsRoot, 'graphrag-sources.py'), exported.root, path], exported.root, signal);
      const value = JSON.parse(result.stdout) as { sources: RetrievalSource[]; unresolvedCitations: { citationType: string; citationId: string }[] };
      if (!Array.isArray(value.sources) || value.sources.length > 64 || !Array.isArray(value.unresolvedCitations)) throw new Error('Invalid GraphRAG citation mapping');
      const corpus = this.project.corpus(exported.manifest.atChapter);
      for (const source of value.sources) {
        const document = corpus.documents.find(item => item.chapter === source.chapter && item.revision === source.revision && item.bodyHash === source.bodyHash);
        if (!document || typeof source.citationType !== 'string' || typeof source.citationId !== 'string' || typeof source.excerpt !== 'string' || source.excerpt.length > 2400 || !document.body.includes(source.excerpt)) throw new Error('GraphRAG citation does not match accepted prefix prose');
      }
      return value;
    } finally { if (existsSync(path)) rmSync(path); }
  }
  inspect(at?: number) {
    const corpus = this.project.corpus(at);
    const root = this.path('snapshots', corpus.snapshotId);
    const readyMarker = existsSync(safePath(root, 'ready.json'));
    let valid = false, error: string | null = null;
    if (readyMarker) try {
      const manifest = readJson<Manifest>(safePath(root, 'manifest.json'));
      this.ready({ root, manifest, corpusHash: hash(json(manifest)) }, this.provider().version);
      valid = true;
    } catch (failure) { error = (failure as Error).message; }
    return { snapshotId: corpus.snapshotId, atChapter: corpus.atChapter, directory: root,
      ready: valid, readyMarker, error, busy: existsSync(safePath(root, '.specwriter-operation.lock')),
      job: existsSync(safePath(root, 'job.json')) ? readJson(safePath(root, 'job.json')) : null,
      evicted: existsSync(safePath(root, 'evicted.json')) };
  }
  recover(at?: number) {
    const info = this.inspect(at);
    const path = safePath(info.directory, '.specwriter-operation.lock');
    if (!existsSync(path)) return { ...info, recovered: false };
    const content = readFileSync(path, 'utf8');
    const lock = JSON.parse(content) as { pid: number; childPid?: number };
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error('Invalid lock PID; inspect the private lock manually');
    try { process.kill(lock.pid, 0); throw new Error('GraphRAG lock owner is still running; cancel its operation or wait'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (lock.childPid !== undefined) {
      if (!Number.isSafeInteger(lock.childPid) || lock.childPid < 1) throw new Error('Invalid GraphRAG worker PID; inspect the private lock manually');
      try { process.kill(lock.childPid, 0); throw new Error('GraphRAG Python worker is still running; stop it or wait before recovery'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    if (readFileSync(path, 'utf8') !== content) throw new Error('GraphRAG lock changed during recovery');
    rmSync(path);
    return { ...info, busy: false, recovered: true };
  }
  async prune(options: { keep?: number; dryRun?: boolean; preserve?: string[] } = {}) {
    const keep = options.keep ?? 2;
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Keep must be a positive integer');
    return this.locked(this.path(), async () => {
      const pinned = new Set(options.preserve ?? []);
      // A prepared chapter must retain the exact index that its verification will consume.
      const status = this.project.status();
      for (const pending of status.pending) {
        const context = readJson<import('./types.js').ContextPackage>(safePath(this.project.root, this.project.chapterPaths(pending.workId, pending.chapter).context));
        if (context.retrieval?.engine === 'microsoft-graphrag') pinned.add(context.retrieval.snapshotId);
      }
      const directory = this.path('snapshots');
      const snapshots: { root: string; manifest: Manifest }[] = [];
      if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const root = safePath(directory, entry.name);
        if (!existsSync(safePath(root, 'ready.json'))) continue;
        const manifest = readJson<Manifest>(safePath(root, 'manifest.json'));
        if (manifest.snapshotId !== entry.name || manifest.schemaVersion !== 1) throw new Error('Invalid snapshot manifest; pruning stopped');
        snapshots.push({ root, manifest });
      }
      const ordered = snapshots.sort((a, b) => b.manifest.atChapter - a.manifest.atChapter || a.manifest.snapshotId.localeCompare(b.manifest.snapshotId));
      const current = this.project.store.revisions().slice(0, status.memoryThrough).map(item => ({ name: `${chapterId(item.chapter)}.txt`, chapter: item.chapter, revision: item.id, bodyHash: item.bodyHash }));
      ordered.filter(item => item.manifest.atChapter <= current.length && json(item.manifest.files) === json(current.slice(0, item.manifest.atChapter)))
        .slice(0, keep).forEach(item => pinned.add(item.manifest.snapshotId));
      const evicted: string[] = [], skipped: string[] = [];
      for (const item of ordered) {
        const id = item.manifest.snapshotId;
        if (pinned.has(id)) continue;
        if (existsSync(safePath(item.root, '.specwriter-operation.lock'))) { skipped.push(id); continue; }
        if (options.dryRun) { evicted.push(id); continue; }
        try {
          await this.locked(item.root, async () => {
            const readyPath = safePath(item.root, 'ready.json');
            atomicWrite(safePath(item.root, 'evicted.json'), json({ schemaVersion: 1, ready: readJson(readyPath), evictedAt: new Date().toISOString() }));
            rmSync(readyPath); // Invalidate first so an interrupted prune cannot leave a false ready marker.
            this.clearDerived(item.root);
            const input = safePath(item.root, 'input');
            if (existsSync(input)) {
              if (lstatSync(input).isSymbolicLink()) throw new Error('Cannot prune linked GraphRAG input');
              rmSync(input, { recursive: true, force: true });
            }
          });
          evicted.push(id);
        } catch (error) {
          if ((error as Error).message.includes('workspace is busy')) skipped.push(id); else throw error;
        }
      }
      return { keep, dryRun: options.dryRun ?? false, evicted, skipped, pinned: [...pinned], note: 'Canonical revisions, document objects, manifests and full query receipts are preserved; evicted indexes rebuild on demand.' };
    });
  }
}
