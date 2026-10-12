import { Ajv } from 'ajv';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, hash, identifier, json, readJson, safePath, schemasRoot, writeNew } from './files.js';
import { loadConfig } from './init.js';
import type { ContextSource } from './types.js';

export type ResearchKind = 'market' | 'analysis' | 'craft';
export type ResearchSourceKind = 'web' | 'ranking' | 'file' | 'author' | 'builtin';
export interface ResearchReport {
  schemaVersion: 1; id: string; bookId: string | null; kind: ResearchKind; title: string; question: string;
  platform: string | null; audience: string | null; timeWindow: string | null;
  observations: { text: string; evidence: { sourceId: string; quote: string }[] }[];
  interpretations: { text: string; sourceIds: string[] }[];
  directions: { title: string; premise: string; reason: string; sourceIds: string[] }[];
  unknowns: string[];
}
export interface ResearchSource {
  schemaVersion: 1; reportId: string; bookId: string | null; sourceId: string; title: string; kind: ResearchSourceKind;
  content: string; url: string | null; publishedAt: string | null; observedAt: string;
  metadata: Record<string, string | number | boolean | null>; hash: string; checksum: string;
}
export interface ResearchVersion {
  schemaVersion: 1; id: string; bookId: string | null; revision: string; status: 'recorded'; recordedAt: string;
  report: ResearchReport; reportHash: string; sourceHashes: { sourceId: string; hash: string; checksum: string }[];
  quoteLocations: { observation: number; evidence: number; sourceId: string; start: number; end: number; quoteHash: string }[];
  checksum: string;
}
export interface ResearchReference { id: string; purpose: string; revision?: string }
export interface ResearchSummary {
  id: string; kind: ResearchKind; title: string; question: string; status: 'draft' | 'recorded';
  draftPath: string; revision: string | null; sourceIds: string[];
  hasDraftChanges: boolean;
}
export interface ResearchCapture {
  sourceId: string; title: string; kind: ResearchSourceKind; content: string; url?: string;
  publishedAt?: string; observedAt?: string; metadata?: ResearchSource['metadata'];
}
interface ResearchPointer { schemaVersion: 1; id: string; bookId: string | null; revision: string; versionChecksum: string; checksum: string }

const ajv = new Ajv({ allErrors: true, strict: true });
const reportValidator = ajv.compile(readJson(join(schemasRoot, 'research-report.schema.json')));
const sourceValidator = ajv.compile(readJson(join(schemasRoot, 'research-source.schema.json')));
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_REPORT_CHARS = 30000;
const MAX_SOURCE_BYTES = 4000000;
const MAX_REPORT_BYTES = 250000;
const MAX_SOURCES = 64;
const SOURCE_KEYS = ['sourceId', 'title', 'kind', 'content', 'url', 'publishedAt', 'observedAt', 'metadata'];

function checksum(value: Record<string, unknown>): string {
  const { checksum: _ignored, ...record } = value;
  return hash(json(record));
}
function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}
function timestamp(value: string | null, label: string): void {
  if (value !== null && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error(`Invalid research ${label}`);
}
function sourceUrl(value: string | null): void {
  if (value === null) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Research source URL must be an absolute HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('Research source URL must use HTTP/HTTPS without credentials');
}
function references(report: ResearchReport): string[] {
  return [...new Set([...report.observations.flatMap(row => row.evidence.map(item => item.sourceId)), ...report.interpretations.flatMap(row => row.sourceIds), ...report.directions.flatMap(row => row.sourceIds)])].sort();
}
function sourceHash(source: Pick<ResearchSource, 'schemaVersion' | 'bookId' | 'reportId' | 'sourceId' | 'content'>): string {
  return hash(json({ schemaVersion: source.schemaVersion, bookId: source.bookId, reportId: source.reportId, sourceId: source.sourceId, content: source.content }));
}
function quoteLocations(report: ResearchReport, sources: ResearchSource[]): ResearchVersion['quoteLocations'] {
  const catalog = new Map(sources.map(source => [source.sourceId, source]));
  return report.observations.flatMap((row, observation) => row.evidence.map((item, evidence) => {
    const start = catalog.get(item.sourceId)!.content.indexOf(item.quote);
    return { observation, evidence, sourceId: item.sourceId, start, end: start + item.quote.length, quoteHash: hash(item.quote) };
  }));
}

/** External research can inform author choices; it never enters established story memory. */
export class ResearchLibrary {
  constructor(readonly root: string) { loadConfig(root); }
  private bookId(): string {
    const bookId = loadConfig(this.root).bookId;
    if (!bookId) throw new Error('此旧小说缺稳定bookId；先完成明确的身份迁移或新建测试书，研究库不能用null隔离');
    return bookId;
  }
  private path(...parts: string[]): string {
    const target = safePath(this.root, 'specwriter', 'research', ...parts);
    const base = resolve(this.root);
    let current = base;
    for (const part of relative(base, target).split(sep)) {
      current = join(current, part);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new Error('Research paths must not follow symbolic links or unsupported files');
      }
    }
    return target;
  }
  private read<T>(path: string, maxBytes = MAX_REPORT_BYTES): T {
    if (!existsSync(path)) throw new Error(`Missing research artifact: ${path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Unsupported or oversized research artifact: ${path}`);
    return readJson<T>(path);
  }
  private report(value: unknown, id: string): ResearchReport {
    if (!reportValidator(value)) throw new Error(`Invalid research report: ${ajv.errorsText(reportValidator.errors)}`);
    const report = value as ResearchReport;
    if (report.id !== identifier(id) || report.bookId !== this.bookId() || json(report).length > MAX_REPORT_CHARS) throw new Error('Invalid, oversized or foreign research report');
    references(report).forEach(identifier);
    return report;
  }
  private revision(value: string): string {
    if (!sha256(value)) throw new Error('Research revision must be a SHA-256 hash');
    return value;
  }
  private directory(id: string): string { return this.path(identifier(id)); }
  private draftPath(id: string): string { return this.path(identifier(id), 'draft.json'); }
  private sourcePath(id: string, sourceId: string): string { return this.path(identifier(id), 'sources', `${identifier(sourceId)}.json`); }
  private versionPath(id: string, revision: string): string { return this.path(identifier(id), 'versions', `${this.revision(revision)}.json`); }
  private pointerPath(id: string): string { return this.path(identifier(id), 'current.json'); }
  private requireReport(id: string): void {
    const directory = this.directory(id);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error(`Research report does not exist: ${id}`);
  }
  create(id: string, options: { kind: ResearchKind; title: string; question: string; platform?: string; audience?: string; timeWindow?: string }): string {
    const report = this.report({ schemaVersion: 1, id: identifier(id), bookId: this.bookId(), kind: options.kind, title: options.title, question: options.question,
      platform: options.platform ?? null, audience: options.audience ?? null, timeWindow: options.timeWindow ?? null,
      observations: [], interpretations: [], directions: [], unknowns: [] }, id);
    const directory = this.directory(id);
    if (existsSync(directory)) throw new Error(`Research report already exists: ${id}`);
    mkdirSync(dirname(directory), { recursive: true });
    mkdirSync(directory);
    const path = this.draftPath(id);
    if (!writeNew(path, json(report))) throw new Error(`Research draft already exists: ${id}`);
    return path;
  }
  draft(id: string): ResearchReport { return this.report(this.read(this.draftPath(id)), id); }
  capture(id: string, options: ResearchCapture): ResearchSource {
    this.bookId();
    this.requireReport(id);
    try { this.draft(id); }
    catch (error) { throw new Error(`Research capture requires a valid draft container for ${id}: ${(error as Error).message}`); }
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !SOURCE_KEYS.includes(key))) throw new Error('Invalid research capture fields');
    const sourceId = identifier(options.sourceId), path = this.sourcePath(id, sourceId);
    const prior = existsSync(path) ? this.source(id, sourceId) : undefined;
    const source: ResearchSource = { schemaVersion: 1, reportId: id, bookId: this.bookId(), sourceId, title: options.title, kind: options.kind, content: options.content,
      url: options.url ?? null, publishedAt: options.publishedAt ?? null, observedAt: options.observedAt ?? prior?.observedAt ?? new Date().toISOString(),
      metadata: options.metadata ?? {}, hash: '', checksum: '' };
    source.hash = sourceHash(source);
    source.checksum = checksum(source as unknown as Record<string, unknown>);
    this.validateSource(source, id, sourceId);
    if (prior) {
      if (json(prior) !== json(source)) throw new Error(`Research source is immutable; use a new sourceId: ${sourceId}`);
      return prior;
    }
    if (this.listSources(id).length >= MAX_SOURCES) throw new Error(`Research report permits at most ${MAX_SOURCES} sources`);
    if (Buffer.byteLength(json(source), 'utf8') > MAX_SOURCE_BYTES) throw new Error('Research source artifact is too large');
    if (!writeNew(path, json(source))) {
      const existing = this.source(id, sourceId);
      if (json(existing) !== json(source)) throw new Error(`Research source is immutable; use a new sourceId: ${sourceId}`);
      return existing;
    }
    return source;
  }
  private validateSource(value: unknown, id: string, sourceId: string): asserts value is ResearchSource {
    if (!sourceValidator(value)) throw new Error(`Invalid research source: ${ajv.errorsText(sourceValidator.errors)}`);
    const source = value as ResearchSource;
    if (source.bookId !== this.bookId() || source.reportId !== identifier(id) || source.sourceId !== identifier(sourceId) || source.hash !== sourceHash(source) || source.checksum !== checksum(source as unknown as Record<string, unknown>)) throw new Error('Invalid, altered or foreign research source');
    if ((source.kind === 'web' || source.kind === 'ranking') && source.url === null) throw new Error('Web/ranking research sources require an HTTP(S) URL');
    sourceUrl(source.url); timestamp(source.publishedAt, 'publishedAt'); timestamp(source.observedAt, 'observedAt');
  }
  source(id: string, sourceId: string): ResearchSource {
    this.bookId();
    const source = this.read<ResearchSource>(this.sourcePath(id, sourceId), MAX_SOURCE_BYTES);
    this.validateSource(source, id, sourceId);
    return source;
  }
  listSources(id: string): ResearchSource[] {
    this.requireReport(id);
    const directory = this.path(identifier(id), 'sources');
    if (!existsSync(directory)) return [];
    if (!lstatSync(directory).isDirectory()) throw new Error('Invalid research source directory');
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > MAX_SOURCES) throw new Error('Research source catalog is too large');
    return entries.map(entry => {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) throw new Error(`Unsupported research source artifact: ${entry.name}`);
      return this.source(id, identifier(entry.name.slice(0, -5)));
    });
  }
  private validateEvidence(report: ResearchReport): ResearchSource[] {
    const selected = references(report).map(sourceId => {
      if (!existsSync(this.sourcePath(report.id, sourceId))) throw new Error(`Research source is missing: ${sourceId}`);
      return this.source(report.id, sourceId);
    });
    const catalog = new Map(selected.map(source => [source.sourceId, source]));
    for (const observation of report.observations) for (const evidence of observation.evidence) {
      if (!catalog.get(evidence.sourceId)?.content.includes(evidence.quote)) throw new Error(`Research evidence quote does not occur in source: ${evidence.sourceId}`);
    }
    const realKinds: ResearchSourceKind[] = ['web', 'ranking', 'file'];
    const realQuotes = report.observations.some(row => row.evidence.some(evidence => realKinds.includes(catalog.get(evidence.sourceId)!.kind)));
    if (report.kind !== 'craft' && (!selected.some(source => realKinds.includes(source.kind)) || !realQuotes)) throw new Error('Market/analysis reports require a real captured source and an exact evidence quote; keep unsupported work as a draft');
    if (!selected.length || !report.observations.length) throw new Error('Recorded research requires a captured source and an exact evidence quote; keep unsupported work as a draft');
    return selected;
  }
  private versionIdentity(report: ResearchReport, sourceHashes: ResearchVersion['sourceHashes']): string {
    return hash(json({ schemaVersion: 1, bookId: report.bookId, id: report.id, reportHash: hash(json(report)), sourceHashes }));
  }
  save(id: string): ResearchVersion {
    const report = this.draft(id), sources = this.validateEvidence(report);
    const sourceHashes = sources.map(source => ({ sourceId: source.sourceId, hash: source.hash, checksum: source.checksum }));
    const revision = this.versionIdentity(report, sourceHashes), path = this.versionPath(id, revision);
    // Validate the previous pointer before replacing it, including an unrelated malformed file.
    if (existsSync(this.pointerPath(id))) this.show(id);
    let version: ResearchVersion;
    if (existsSync(path)) version = this.readVersion(id, revision);
    else {
      version = { schemaVersion: 1, id, bookId: this.bookId(), revision, status: 'recorded', recordedAt: new Date().toISOString(), report, reportHash: hash(json(report)), sourceHashes, quoteLocations: quoteLocations(report, sources), checksum: '' };
      version.checksum = checksum(version as unknown as Record<string, unknown>);
      if (!writeNew(path, json(version))) version = this.readVersion(id, revision);
    }
    const pointer: ResearchPointer = { schemaVersion: 1, id, bookId: this.bookId(), revision, versionChecksum: version.checksum, checksum: '' };
    pointer.checksum = checksum(pointer as unknown as Record<string, unknown>);
    const current = this.pointerPath(id);
    // Content-addressed version is durable before the atomic publication pointer.
    if (!existsSync(current) || readFileSync(current, 'utf8') !== json(pointer)) atomicWrite(current, json(pointer));
    return version;
  }
  private readVersion(id: string, revision: string): ResearchVersion {
    const version = this.read<ResearchVersion>(this.versionPath(id, revision));
    exactKeys(version, ['schemaVersion', 'id', 'bookId', 'revision', 'status', 'recordedAt', 'report', 'reportHash', 'sourceHashes', 'quoteLocations', 'checksum'], 'research version');
    if (version.schemaVersion !== 1 || version.id !== identifier(id) || version.bookId !== this.bookId() || version.revision !== this.revision(revision) || version.status !== 'recorded' || !sha256(version.reportHash) || !sha256(version.checksum) || typeof version.recordedAt !== 'string' || !Array.isArray(version.sourceHashes) || version.sourceHashes.length > MAX_SOURCES || version.checksum !== checksum(version as unknown as Record<string, unknown>)) throw new Error('Invalid, altered or foreign recorded research version');
    timestamp(version.recordedAt, 'recordedAt');
    const report = this.report(version.report, id), sources = this.validateEvidence(report);
    for (const item of version.sourceHashes) {
      exactKeys(item, ['sourceId', 'hash', 'checksum'], 'research source hash');
      if (typeof item.sourceId !== 'string' || !sha256(item.hash) || !sha256(item.checksum)) throw new Error('Invalid recorded research source hash');
    }
    const sourceHashes = sources.map(source => ({ sourceId: source.sourceId, hash: source.hash, checksum: source.checksum }));
    if (version.reportHash !== hash(json(report)) || json(version.sourceHashes) !== json(sourceHashes) || json(version.quoteLocations) !== json(quoteLocations(report, sources)) || version.revision !== this.versionIdentity(report, sourceHashes)) throw new Error('Recorded research report, quote locations or source hashes have changed');
    return version;
  }
  show(id: string, revision?: string): ResearchVersion {
    this.bookId();
    identifier(id);
    if (revision !== undefined) this.revision(revision);
    const pointer = this.read<ResearchPointer>(this.pointerPath(id));
    exactKeys(pointer, ['schemaVersion', 'id', 'bookId', 'revision', 'versionChecksum', 'checksum'], 'research publication pointer');
    if (pointer.schemaVersion !== 1 || pointer.id !== id || pointer.bookId !== this.bookId() || !sha256(pointer.revision) || !sha256(pointer.versionChecksum) || !sha256(pointer.checksum) || pointer.checksum !== checksum(pointer as unknown as Record<string, unknown>)) throw new Error('Invalid, altered or foreign research publication pointer');
    const version = this.readVersion(id, revision ?? pointer.revision);
    if (version.revision === pointer.revision && version.checksum !== pointer.versionChecksum) throw new Error('Research pointer version checksum does not match');
    return version;
  }
  list(): ResearchSummary[] {
    const directory = this.path();
    if (!existsSync(directory)) return [];
    if (!statSync(directory).isDirectory()) throw new Error('Invalid research library directory');
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    return entries.map(entry => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsupported research report directory: ${entry.name}`);
      const id = identifier(entry.name), draft = this.draft(id);
      const version = existsSync(this.pointerPath(id)) ? this.show(id) : undefined;
      const report = version?.report ?? draft;
      return { id, kind: report.kind, title: report.title, question: report.question, status: version ? 'recorded' : 'draft', draftPath: this.draftPath(id), revision: version?.revision ?? null,
        sourceIds: this.listSources(id).map(source => source.sourceId), hasDraftChanges: version ? hash(json(draft)) !== version.reportHash : true };
    });
  }
  validateReference(reference: ResearchReference): ResearchVersion {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).some(key => !['id', 'purpose', 'revision'].includes(key)) || typeof reference.purpose !== 'string' || !reference.purpose.trim() || reference.purpose.length > 1000) throw new Error('Research reference requires an id and a concise author purpose');
    return this.show(identifier(reference.id), reference.revision);
  }
  contextSources(selected: ResearchReference[]): ContextSource[] {
    if (!Array.isArray(selected) || selected.length > 8 || new Set(selected.map(reference => reference.id)).size !== selected.length) throw new Error('Select at most 8 unique research references');
    return selected.map(reference => {
      const version = this.validateReference(reference), report = version.report;
      const sources = version.sourceHashes.map(item => {
        const source = this.source(report.id, item.sourceId);
        return { sourceId: source.sourceId, title: source.title, kind: source.kind, url: source.url, publishedAt: source.publishedAt, observedAt: source.observedAt,
          hash: source.hash, checksum: source.checksum, source: `specwriter/research/${report.id}/sources/${source.sourceId}.json`, evidenceRole: source.kind === 'builtin' || source.kind === 'author' ? 'craft/author input; not market evidence'
            : source.kind === 'file' ? 'author-provided local excerpt; original provenance, public credibility and completeness are not independently verified'
              : 'captured external source; sampling and conclusions need author judgment' };
      });
      const content = json({ schemaVersion: 1, status: 'recorded', role: 'external research; never established story canon', purpose: reference.purpose, revision: version.revision, reportHash: version.reportHash, quoteLocations: version.quoteLocations,
        integrity: 'Hashes bind the saved version and exact quote locations; they do not prove conclusions, meaning, sampling quality or market accuracy.', report, sources });
      return { id: `research:${report.id}:${version.revision}`, kind: 'research' as ContextSource['kind'], source: `specwriter/research/${report.id}/versions/${version.revision}.json`,
        reason: `作者参考用途：${reference.purpose}；已记录外部研究，非小说既成事实。`, content, hash: hash(content), protection: 'protected' as const };
    });
  }
}
