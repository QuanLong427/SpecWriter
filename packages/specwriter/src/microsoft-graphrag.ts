import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { atomicWrite, chapterId, hash, json, readJson, safePath, writeNew } from './files.js';
import type { Project } from './project.js';
import type { GraphRagMethod, RetrievalReceipt } from './types.js';

export interface ProcessResult { stdout: string; stderr: string }
export type ProcessRunner = (executable: string, args: string[], cwd: string) => Promise<ProcessResult>;

/** Keep prompts/keys out of error output; detailed logs remain in the private workspace. */
export const runGraphRag: ProcessRunner = (executable, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Stream decoders preserve Chinese characters even across split UTF-8 pipe chunks.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = ''; let stderr = ''; let overflow = false;
  const limit = 4 * 1024 * 1024;
  const timer = setTimeout(() => { child.kill(); reject(new Error('GraphRAG timed out after 60 minutes; index is not marked ready')); }, 60 * 60 * 1000);
  const append = (value: string, target: 'stdout' | 'stderr'): void => {
    if (stdout.length + stderr.length + value.length > limit) { overflow = true; child.kill(); return; }
    if (target === 'stdout') stdout += value; else stderr += value;
  };
  child.stdout.on('data', value => append(value, 'stdout'));
  child.stderr.on('data', value => append(value, 'stderr'));
  child.on('error', error => { clearTimeout(timer); reject(new Error(`Cannot start GraphRAG Python (${(error as NodeJS.ErrnoException).code ?? 'error'}); check --python and the graphrag installation`)); });
  child.on('close', code => {
    clearTimeout(timer);
    if (overflow) reject(new Error('GraphRAG output exceeded the capture limit; inspect its private logs'));
    else if (code !== 0) reject(new Error(`GraphRAG exited with code ${code}; inspect private workspace logs (credentials are not printed)`));
    else resolve({ stdout, stderr });
  });
});

interface Provider { schemaVersion: 1; python: string; version: string }
interface CorpusFile { name: string; chapter: number; revision: number; bodyHash: string }
interface Manifest { schemaVersion: 1; snapshotId: string; atChapter: number; files: CorpusFile[] }
interface Ready { schemaVersion: 1; snapshotId: string; version: string; configHash: string; corpusHash: string; outputHash: string }
const requiredOutputs = ['documents.parquet', 'text_units.parquet', 'entities.parquet', 'relationships.parquet', 'communities.parquet', 'community_reports.parquet'];

/** Microsoft backend for default WriterMemory retrieval. Every index is isolated by accepted prefix and revision. */
export class MicrosoftGraphRag {
  constructor(readonly project: Project, private readonly runner: ProcessRunner = runGraphRag) {}
  private path(...parts: string[]): string { return safePath(this.project.root, '.specwriter', 'graphrag', ...parts); }
  private provider(): Provider {
    if (!existsSync(this.path('provider.json'))) throw new Error('Microsoft GraphRAG is the default memory backend. Run memory graphrag setup --python EXE --model MODEL --embedding MODEL and configure its .env; select memory.backend: local explicitly for offline use');
    const provider = readJson<Provider>(this.path('provider.json'));
    if (provider.schemaVersion !== 1 || !provider.python || !/^3\.3\./.test(provider.version)) throw new Error('Unsupported GraphRAG provider; this adapter supports 3.3.x');
    return provider;
  }
  private async checkVersion(python: string): Promise<string> {
    const result = await this.runner(python, ['-c', 'from importlib.metadata import version; print(version("graphrag"))'], this.project.root);
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
        await this.runner(python, ['-m', 'graphrag', 'init', '--root', root, '--model', options.model, '--embedding', options.embedding], root);
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
      this.validateInput(root, manifest);
    } else {
      mkdirSync(safePath(root, 'input'), { recursive: true });
      if (readdirSync(safePath(root, 'input')).length) throw new Error('Unmanaged files in GraphRAG input; use a fresh snapshot directory');
      for (const document of corpus.documents) atomicWrite(safePath(root, 'input', `${chapterId(document.chapter)}.txt`), document.body);
      atomicWrite(safePath(root, 'manifest.json'), json(manifest));
    }
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
  async index(at?: number, options: { reuse?: boolean } = {}) {
    const provider = this.provider();
    const version = await this.checkVersion(provider.python);
    const exported = this.export(at);
    if (!exported.manifest.files.length) throw new Error('Accept at least one chapter before GraphRAG indexing');
    return this.locked(exported.root, async () => {
      const settings = this.configuration();
      const readyPath = safePath(exported.root, 'ready.json');
      if (existsSync(readyPath)) {
        if (!options.reuse) throw new Error('This snapshot already has an index; query it or explicitly remove ready.json to rebuild');
        const ready = this.ready(exported, version);
        return { provider: 'microsoft-graphrag', indexed: true, reused: true, snapshotId: ready.snapshotId, atChapter: exported.manifest.atChapter, directory: exported.root };
      }
      // A failed index cannot retain a readiness marker. All paths remain snapshot-local.
      atomicWrite(safePath(exported.root, 'settings.yaml'), settings);
      this.copyPrompts(this.path('provider', 'prompts'), safePath(exported.root, 'prompts'));
      this.credentials(exported.root);
      const configHash = this.configHash(exported.root);
      if (configHash !== hash(settings + this.treeHash(this.path('provider', 'prompts')))) throw new Error('Obsolete files in snapshot prompts; remove those derived prompt files before retrying the index');
      await this.runner(provider.python, ['-m', 'graphrag', 'index', '--root', exported.root, '--method', 'standard'], exported.root);
      this.assertCurrent(exported.manifest.snapshotId, exported.manifest.atChapter);
      this.validateInput(exported.root, exported.manifest);
      if (this.configHash(exported.root) !== configHash) throw new Error('GraphRAG configuration changed during indexing');
      for (const name of requiredOutputs) if (!existsSync(safePath(exported.root, 'output', name))) throw new Error(`GraphRAG did not complete required output: ${name}`);
      const ready: Ready = { schemaVersion: 1, snapshotId: exported.manifest.snapshotId, version, configHash, corpusHash: exported.corpusHash, outputHash: this.treeHash(safePath(exported.root, 'output')) };
      atomicWrite(readyPath, json(ready));
      return { provider: 'microsoft-graphrag', indexed: true, reused: false, snapshotId: ready.snapshotId, atChapter: exported.manifest.atChapter, directory: exported.root };
    });
  }
  async query(query: string, options: { at?: number; method?: GraphRagMethod; cache?: boolean } = {}) {
    if (!query.trim()) throw new Error('GraphRAG query must not be empty');
    const method = options.method ?? 'local';
    if (!['local', 'global', 'drift', 'basic'].includes(method)) throw new Error('GraphRAG method must be local, global, drift or basic');
    const provider = this.provider();
    const version = await this.checkVersion(provider.python);
    const exported = this.export(options.at);
    return this.locked(exported.root, async () => {
      const ready = this.ready(exported, version);
      const cached = options.cache ? this.readReceipt(exported.root, ready, query, method, exported.manifest.atChapter) : undefined;
      if (cached) return { ...cached, advisory: true, cached: true };
      this.credentials(exported.root);
      const result = await this.runner(provider.python, ['-m', 'graphrag', 'query', query, '--root', exported.root, '--method', method, '--response-type', '中文回答，引用来源；区分正文事实、人物误解和推测', '--no-streaming'], exported.root);
      if (json(this.ready(exported, version)) !== json(ready)) throw new Error('GraphRAG index changed during query');
      const answer = result.stdout.trim();
      if (!answer) throw new Error('GraphRAG returned an empty answer; no retrieval receipt was saved');
      const receipt: RetrievalReceipt = { schemaVersion: 1, id: this.receiptKey(ready, query, method), provider: 'microsoft-graphrag', version, method, atChapter: exported.manifest.atChapter, snapshotId: ready.snapshotId, configHash: ready.configHash, outputHash: ready.outputHash, query, answer, answerHash: hash(answer) };
      atomicWrite(safePath(exported.root, 'queries', `${receipt.id}.json`), json({ receipt, checksum: hash(json(receipt)) }));
      return { ...receipt, advisory: true, cached: false };
    });
  }
}
