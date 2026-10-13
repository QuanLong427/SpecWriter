import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkpointState } from './store.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, rmSync, mkdtempSync, renameSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { parse, parseDocument } from 'yaml';
import { atomicWrite, json, safePath } from './files.js';
import { initProject, loadConfig } from './init.js';
import { Project } from './project.js';

interface Snapshot {
  schemaVersion: 1; bookId: string; generation: number; createdAt: string;
  files: { path: string; hash: string; bytes: number }[];
  runtime: { graphrag?: string; models: { kind: string; model: string; provider: string }[] };
  stateHash?: string;
}
const authorRoots = ['specwriter', 'manuscript', '.agents/skills', 'AGENTS.md', '.specwriter/reader/preferences.json', '.specwriter/installation.json', '.specwriter/projection.json', '.specwriter/graphrag/usage/operations'];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const backupDb = '.specwriter/backup/writer.db', manifestFile = '.specwriter/backup/manifest.json';
const allowed = (path: string) => ['AGENTS.md', '.specwriter/reader/preferences.json', '.specwriter/installation.json', '.specwriter/projection.json', backupDb].includes(path)
  || /^\.specwriter\/graphrag\/usage\/operations\/[a-f0-9-]+\.json$/.test(path)
  || ['specwriter/', 'manuscript/', '.agents/skills/'].some(prefix => path.startsWith(prefix));
const privateName = (name: string) => /^\.env(?:\.|$)/i.test(name) || /^(credentials|secrets)(?:\.|$)/i.test(name);
const portablePath = (path: string) => !path.includes('\\') && path.split('/').every(part =>
  !['..', '.', '', '.git'].includes(part.toLowerCase()) && !privateName(part) && !/[<>:"|?*\x00-\x1f]/.test(part)
  && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

/** Each book owns a private Git repository. It never stages or changes the author's
 * existing repository, index, hooks or remote. Git trees contain consistent DB copies. */
export class BookVersions {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(...parts: string[]) { return safePath(this.root, '.specwriter', 'version', ...parts); }
  private repo() { return this.path('repository.git'); }
  private git(args: string[], options: { repo?: string; workTree?: string; input?: string; binary?: boolean } = {}): any {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    try {
      return execFileSync('git', ['--no-replace-objects', '--git-dir', options.repo ?? this.repo(), ...(options.workTree ? ['--work-tree', options.workTree] : []),
        '-c', 'user.name=SpecWriter', '-c', 'user.email=specwriter@localhost', '-c', 'core.autocrlf=false', ...args],
      { windowsHide: true, cwd: options.workTree ?? dirname(options.repo ?? this.repo()), env, encoding: options.binary ? undefined : 'utf8', input: options.input, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { throw new Error('Git checkpoint operation failed; check Git installation and the book version repository'); }
  }
  private head(): string | undefined {
    try { return this.git(['rev-parse', '--verify', 'HEAD']).trim(); } catch { return undefined; }
  }
  private locked<T>(action: () => T): T {
    mkdirSync(this.path(), { recursive: true });
    const lock = this.path('operation.lock');
    try { writeFileSync(lock, json({ pid: process.pid }), { flag: 'wx' }); }
    catch { throw new Error('Book version operation is busy; inspect operation.lock and its PID before recovery'); }
    try { return action(); } finally { rmSync(lock, { force: true }); }
  }
  init(project: Project) {
    if (resolve(project.root) !== this.root) throw new Error('Checkpoint project identity mismatch');
    this.locked(() => {
      if (!existsSync(this.repo())) {
        mkdirSync(this.repo(), { recursive: true });
        this.git(['init', '--bare', this.repo()]); this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
      }
      const configPath = safePath(this.root, 'specwriter/config.yaml');
      const config = parseDocument(readFileSync(configPath, 'utf8'));
      config.set('versioning', { enabled: true, autoSave: true }); atomicWrite(configPath, config.toString());
    });
    return { repository: this.repo(), enabled: true, autoSave: true, checkpoint: this.save(project, '启用小说版本管理') };
  }
  log() {
    if (!existsSync(this.repo())) throw new Error('Run version init before saving or reading checkpoints');
    if (!this.head()) return [];
    return this.git(['log', '-50', '--format=%H%x09%aI%x09%s', 'HEAD']).trim().split('\n').filter(Boolean).map((line: string) => {
      const [commit, at, ...message] = line.split('\t'); return { commit, at, message: message.join('\t') };
    });
  }
  /** Compare author files against the actual Git HEAD, including edits made outside the CLI. */
  status(project: Project) {
    const config = loadConfig(this.root).versioning;
    const result = { enabled: config?.enabled ?? false, autoSave: config?.autoSave ?? false,
      repositoryExists: existsSync(this.repo()), needsSave: true as boolean | null,
      lastCheckpoint: null as { commit: string; at: string; generation: number } | null,
      changedFiles: [] as string[], memoryChanged: false, error: null as string | null,
      lastFailure: null as { at: string; message: string } | null };
    const failure = this.path('last-failure.json');
    if (existsSync(failure)) try { result.lastFailure = JSON.parse(readFileSync(failure, 'utf8')); }
    catch { result.error = 'Cannot read the previous backup failure; run version save to refresh'; }
    if (!result.enabled && !result.repositoryExists) { result.needsSave = null; return result; }
    try {
      if (!result.repositoryExists) throw new Error('Versioning is enabled but its repository is missing; run version init');
      const commit = this.head();
      if (!commit) throw new Error('No readable checkpoint; run version save or check Git installation');
      const manifest = JSON.parse(this.git(['show', `${commit}:${manifestFile}`])) as Snapshot;
      if (manifest.schemaVersion !== 1 || manifest.bookId !== (loadConfig(this.root).bookId ?? '') || !Array.isArray(manifest.files)) throw new Error('Invalid checkpoint metadata; inspect the book version repository');
      result.lastCheckpoint = { commit, at: manifest.createdAt, generation: manifest.generation };
      result.memoryChanged = manifest.generation !== project.store.generation()
        || (manifest.stateHash !== undefined && manifest.stateHash !== this.stateHash(project));
      const previous = new Map(manifest.files.filter(file => file.path !== backupDb).map(file => [file.path, file.hash]));
      const current = new Map<string, string>();
      const walk = (relative: string) => {
        const source = safePath(this.root, relative);
        if (!existsSync(source) || privateName(relative.split('/').at(-1)!)) return;
        const stat = lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error('Linked author files prevent backup comparison');
        if (stat.isDirectory()) for (const entry of readdirSync(source)) {
          if (entry === '.git') throw new Error('Nested author repositories prevent backup comparison');
          walk(`${relative}/${entry}`);
        }
        else if (stat.isFile() && allowed(relative)) current.set(relative, sha(readFileSync(source)));
      };
      for (const path of authorRoots) walk(path);
      result.changedFiles = [...new Set([...previous.keys(), ...current.keys()])].filter(path => previous.get(path) !== current.get(path)).sort();
      result.needsSave = result.memoryChanged || result.changedFiles.length > 0;
    } catch (error) { result.needsSave = null; result.error = (error as Error).message; }
    return result;
  }
  private stateHash(project: Project) {
    return sha(Buffer.from(json(checkpointState(project.store.db))));
  }
  private secrets(): string[] {
    const values: string[] = [];
    for (const path of [safePath(this.root, '.env'), safePath(this.root, '.specwriter/graphrag/provider/.env')]) if (existsSync(path)) {
      const env = parseEnv(readFileSync(path, 'utf8'));
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (/KEY|TOKEN|SECRET/i.test(key) && value.length >= 8) values.push(value);
        if (key === 'LLM_PROVIDERS') try { for (const provider of Object.values(JSON.parse(value)) as any[]) if (typeof provider.api_key === 'string' && provider.api_key.length >= 8) values.push(provider.api_key); } catch { /* never log credentials */ }
      }
    }
    return values;
  }
  save(project: Project, message = '保存小说检查点') {
    try {
      const result = this.saveCheckpoint(project, message);
      rmSync(this.path('last-failure.json'), { force: true });
      return result;
    } catch (error) {
      // Persist a generic reason: author-controlled messages and credentials never enter this file.
      try { atomicWrite(this.path('last-failure.json'), json({ at: new Date().toISOString(),
        message: 'Checkpoint failed; run version save after checking synchronization, Git and credential-free author files' })); } catch { /* status still compares against HEAD */ }
      throw error;
    }
  }
  private saveCheckpoint(project: Project, message: string) {
    if (resolve(project.root) !== this.root) throw new Error('Checkpoint project identity mismatch');
    if (!message.trim() || message.length > 500 || /[\r\n\0]/.test(message)) throw new Error('Checkpoint message must be a single nonempty line up to 500 characters');
    if (!existsSync(this.repo())) throw new Error('Run version init first');
    return this.locked(() => {
      const stage = this.path('staging', randomUUID()); mkdirSync(stage, { recursive: true });
      try {
        const status = project.status();
        if (status.dirtyFiles.length || status.projectionNeedsSync) throw new Error('Checkpoint requires synchronized accepted prose; run sync or sync --capture first');
        const db = safePath(stage, backupDb); mkdirSync(dirname(db), { recursive: true });
        // VACUUM INTO produces a standalone, consistent backup including WAL data.
        if (project.store.db.isTransaction) throw new Error('Cannot checkpoint inside a database transaction');
        project.store.db.prepare('VACUUM INTO ?').run(db);
        const copied = new DatabaseSync(db, { readOnly: true });
        let generation: number, stateHash: string;
        try {
          generation = Number((copied.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string }).value);
          stateHash = sha(Buffer.from(json(checkpointState(copied))));
        }
        finally { copied.close(); }
        const files: Snapshot['files'] = [], secrets = this.secrets();
        const authorFiles = new Map<string, string>();
        if (secrets.some(secret => message.includes(secret))) throw new Error('Checkpoint message contains a configured credential');
        const capture = (path: string, bytes: Buffer) => {
          if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) throw new Error(`Configured credential found in checkpoint content: ${path}`);
          const target = safePath(stage, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
          const digest = sha(bytes);
          files.push({ path, hash: digest, bytes: bytes.length });
          if (path !== backupDb) authorFiles.set(path, digest);
        };
        const walk = (relative: string) => {
          const source = safePath(this.root, relative);
          if (!existsSync(source)) return;
          const stat = lstatSync(source);
          if (stat.isSymbolicLink()) throw new Error(`Checkpoint cannot follow a linked author file: ${relative}`);
          if (privateName(relative.split('/').at(-1)!)) return;
          if (!portablePath(relative)) throw new Error('Checkpoint requires portable author file paths');
          if (stat.isDirectory()) { for (const entry of readdirSync(source).sort()) { if (entry === '.git') throw new Error('Nested author repositories cannot be checkpointed'); walk(`${relative}/${entry}`); } }
          else if (stat.isFile() && allowed(relative)) capture(relative, readFileSync(source));
        };
        project.store.transaction(() => {
          if (this.stateHash(project) !== stateHash) throw new Error('Book changed while copying its database; retry checkpoint');
          for (const path of authorRoots) walk(path);
          for (const [path, digest] of authorFiles) if (!existsSync(safePath(this.root, path)) || sha(readFileSync(safePath(this.root, path))) !== digest) throw new Error('Author documents changed during checkpoint; retry after edits finish');
        });
        capture(backupDb, readFileSync(db));
        const runtime: Snapshot['runtime'] = { models: [] };
        const settings = safePath(this.root, '.specwriter/graphrag/provider/settings.yaml');
        if (existsSync(settings)) {
          const config = parse(readFileSync(settings, 'utf8'));
          for (const [kind, models] of [['completion', config.completion_models], ['embedding', config.embedding_models]] as const) {
            for (const model of Object.values(models ?? {}) as any[]) runtime.models.push({ kind, model: String(model.model ?? ''), provider: String(model.model_provider ?? '') });
          }
          const provider = safePath(this.root, '.specwriter/graphrag/provider.json');
          if (existsSync(provider)) runtime.graphrag = JSON.parse(readFileSync(provider, 'utf8')).version;
        }
        const manifest: Snapshot = { schemaVersion: 1, bookId: loadConfig(stage).bookId ?? '', generation, stateHash, createdAt: new Date().toISOString(), files: files.sort((a,b) => a.path.localeCompare(b.path)), runtime };
        if (secrets.some(secret => json(manifest).includes(secret))) throw new Error('Configured credential found in checkpoint metadata');
        atomicWrite(safePath(stage, manifestFile), json(manifest));
        // Preserve exact prose bytes across OSes and prevent external clean filters.
        atomicWrite(safePath(stage, '.gitattributes'), '* -text -filter\n');
        const previous = this.head();
        this.git(['read-tree', '--empty'], { workTree: stage });
        this.git(['add', '--all', '--', '.'], { workTree: stage });
        const tree = this.git(['write-tree']).trim();
        const commit = this.git(['commit-tree', tree, ...(previous ? ['-p', previous] : [])], { input: message + '\n' }).trim();
        this.git(['update-ref', 'refs/heads/main', commit, previous ?? '0'.repeat(40)]);
        let maintenanceWarning: string | undefined;
        // Plumbing commits do not invoke Git's usual automatic housekeeping.
        // Pack only recent loose objects periodically to bound repeated DB copies.
        try {
          if (Number(this.git(['rev-list', '--count', 'HEAD']).trim()) % 20 === 0) this.git(['-c', 'pack.threads=2', '-c', 'pack.windowMemory=64m', 'repack', '-d', '--window=10', '--depth=20']);
        } catch { maintenanceWarning = 'Checkpoint saved; Git packing failed. History remains valid but disk use may grow.'; }
        return { saved: true, commit, generation, files: files.length, repository: this.repo(), ...(maintenanceWarning ? { maintenanceWarning } : {}) };
      } finally { rmSync(stage, { recursive: true, force: true }); }
    });
  }
  bundle(output: string) {
    const target = resolve(output);
    if (existsSync(target)) throw new Error('Bundle output must be a new file');
    if (!this.head()) throw new Error('No checkpoint exists to bundle');
    return this.locked(() => { mkdirSync(dirname(target), { recursive: true }); this.git(['bundle', 'create', target, '--all']); return { path: target, commit: this.head(), note: 'Contains novel text and memory history; no API keys or model/index files.' }; });
  }
  restore(revision: string, destination: string, bundle?: string) {
    if (!/^(HEAD|[a-f0-9]{7,40})$/.test(revision)) throw new Error('Restore revision must be HEAD or a commit hash');
    const target = resolve(destination);
    if (existsSync(target)) throw new Error('Restore requires a new directory; existing novels are never overwritten');
    const rel = relative(this.root, target);
    if (!bundle && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error('Restore must be outside the original novel directory');
    const temp = mkdtempSync(join(tmpdir(), 'specwriter-restore-'));
    let publish: string | undefined;
    let source = this.repo();
    try {
      if (bundle) {
        const input = resolve(bundle);
        if (!existsSync(input) || !lstatSync(input).isFile()) throw new Error('Bundle must be an existing local file');
        source = join(temp, 'repository.git');
        this.git(['clone', '--mirror', input, source], { repo: source });
      }
      const commit = this.git(['rev-parse', '--verify', `${revision}^{commit}`], { repo: source }).trim();
      const entries = this.git(['ls-tree', '-rz', '--full-tree', commit], { repo: source, binary: true }) as Buffer;
      const blobs = new Map<string, string>();
      const foldedPaths = new Set<string>();
      for (const entry of entries.toString('utf8').split('\0').filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if (!match) throw new Error('Snapshot contains unsupported entries');
        const path = match[3]!;
        if ((!allowed(path) && ![manifestFile, '.gitattributes'].includes(path)) || !portablePath(path)) throw new Error('Snapshot contains an unexpected or private path');
        safePath(target, path); if (foldedPaths.has(path.toLowerCase())) throw new Error('Duplicate snapshot path'); foldedPaths.add(path.toLowerCase()); blobs.set(path, match[2]!);
      }
      const read = (path: string) => { const oid = blobs.get(path); if (!oid) throw new Error(`Snapshot is incomplete: ${path}`); return this.git(['cat-file', 'blob', oid], { repo: source, binary: true }) as Buffer; };
      const manifest = JSON.parse(read(manifestFile).toString('utf8')) as Snapshot;
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.generation) || manifest.files.length > 50000) throw new Error('Invalid checkpoint manifest');
      const seen = new Set<string>();
      const restored = join(temp, 'validated'); mkdirSync(restored);
      for (const file of manifest.files) {
        if (typeof file.path !== 'string' || !allowed(file.path) || seen.has(file.path)) throw new Error('Invalid snapshot file list');
        seen.add(file.path); const bytes = read(file.path);
        if (sha(bytes) !== file.hash || bytes.length !== file.bytes) throw new Error('Snapshot file checksum mismatch');
        const path = safePath(restored, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
      }
      if (seen.size + 2 !== blobs.size || !seen.has(backupDb) || !seen.has('specwriter/config.yaml')) throw new Error('Snapshot file list does not match its Git tree');
      const db = new DatabaseSync(safePath(restored, backupDb), { readOnly: true });
      try {
        if (JSON.stringify(db.prepare('PRAGMA integrity_check').all()) !== '[{"integrity_check":"ok"}]') throw new Error('Snapshot database integrity failed');
        if (Number((db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string }).value) !== manifest.generation) throw new Error('Snapshot database generation mismatch');
      } finally { db.close(); }
      const config = loadConfig(restored);
      if ((config.bookId ?? '') !== manifest.bookId) throw new Error('Snapshot book identity mismatch');
      // Build and validate the recovered book before exposing the requested target.
      const live = safePath(restored, '.specwriter/memory/writer.db'); mkdirSync(dirname(live), { recursive: true }); writeFileSync(live, readFileSync(safePath(restored, backupDb)));
      rmSync(safePath(restored, '.specwriter/backup'), { recursive: true, force: true });
      initProject(restored, config.name);
      const check = new Project(restored);
      let warnings: string[];
      try { const health = check.doctor(); if (!health.healthy) throw new Error('Restored novel failed consistency checks'); warnings = health.warnings; }
      finally { check.close(); }
      const restoredRepo = safePath(restored, '.specwriter/version/repository.git'); mkdirSync(dirname(restoredRepo), { recursive: true });
      this.git(['clone', '--mirror', '--no-local', source, restoredRepo], { repo: restoredRepo });
      this.git(['config', '--remove-section', 'remote.origin'], { repo: restoredRepo });
      const tip = this.git(['rev-parse', 'HEAD'], { repo: source }).trim();
      if (tip !== commit) this.git(['update-ref', `refs/specwriter/source-tips/${tip}`, tip], { repo: restoredRepo });
      this.git(['update-ref', 'refs/heads/main', commit], { repo: restoredRepo });
      mkdirSync(dirname(target), { recursive: true });
      publish = mkdtempSync(join(dirname(target), '.specwriter-restore-'));
      const copy = (directory: string, relative = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          const out = safePath(publish!, path);
          if (entry.isDirectory()) { mkdirSync(out, { recursive: true }); copy(join(directory, entry.name), path); }
          else writeFileSync(out, readFileSync(join(directory, entry.name)), { flag: 'wx' });
        }
      };
      copy(restored);
      // Publish only a fully validated book with a complete, independent Git history.
      if (existsSync(target)) throw new Error('Restore target appeared during recovery; refusing overwrite');
      renameSync(publish, target); publish = undefined;
      return { root: target, commit, generation: manifest.generation, runtime: manifest.runtime, warnings, needsModelSetup: config.memory?.backend === 'microsoft-graphrag', note: 'Original novel preserved. Inspect returned warnings; recovery does not certify audit or completion status. Configure model credentials locally; GraphRAG indexes rebuild on demand.' };
    } finally {
      if (publish) rmSync(publish, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  }
}
