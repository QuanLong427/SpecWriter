import { Ajv } from 'ajv';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { atomicWrite, hash, identifier, json, readJson, safePath, schemasRoot, writeNew } from './files.js';
import { loadConfig } from './init.js';
import { replay, trustedPrefix } from './memory.js';
import { MemoryLifecycle } from './memory-lifecycle.js';
import { NovelReader } from './reader.js';
import { dirtyFiles } from './projections.js';
import type { Project } from './project.js';

export type StoryAuditKind = 'recap' | 'finish';
export interface StoryAuditEvidence { chapter: number; revision: number; quote: string; start?: number; end?: number }
export interface StoryAuditClaim { text: string; evidence: StoryAuditEvidence[] }
export interface StoryAuditScope { from: number; to: number; chapters: { chapter: number; revision: number; bodyHash: string }[] }
export interface StoryAuditHook {
  id: string; description: string; status: 'open' | 'progressing' | 'deferred';
  sourceChapter: number; sourceRevision: number; evidence: StoryAuditEvidence;
}
export interface StoryAuditReport {
  schemaVersion: 1; id: string; bookId: string; kind: StoryAuditKind;
  preparedRevision: string; taskId: string; taskPreparedRevision: string; taskRevision: string | null;
  inputFingerprint: string; scope: StoryAuditScope; hookInventory: StoryAuditHook[];
  summary: StoryAuditClaim; characterChanges: StoryAuditClaim[]; mainlineChanges: StoryAuditClaim[];
  hookDecisions: { hookId: string; disposition: 'deferred' | 'author-retained' | 'needs-resolution'; reason: string; authorReason: string | null; evidence: StoryAuditEvidence[] }[];
  findings: { id: string; severity: 'blocking' | 'warning' | 'suggestion'; description: string; resolved: boolean; resolution: string | null; evidence: StoryAuditEvidence[] }[];
  unknowns: string[]; reviewed: boolean; reviewNotes: string[];
}
interface Preparation {
  schemaVersion: 1; id: string; bookId: string; kind: StoryAuditKind; taskId: string; taskPreparedRevision: string;
  scope: StoryAuditScope; hookInventory: StoryAuditHook[]; inputFingerprint: string; preparedAt: string; preparedRevision: string; checksum: string;
}
export interface StoryAuditVersion {
  schemaVersion: 1; id: string; bookId: string; kind: StoryAuditKind; revision: string;
  status: 'ready'; recordedAt: string; report: StoryAuditReport; reportHash: string; checksum: string;
}
export interface CompletionReceipt {
  schemaVersion: 1; bookId: string; reportId: string; reportRevision: string; receiptId: string;
  scope: StoryAuditScope; inputFingerprint: string; authorReason: string;
  retainedHooks: { hookId: string; authorReason: string }[]; completedAt: string; checksum: string;
}
export interface StoryAuditPrepareOptions {
  kind: StoryAuditKind; from?: number; to?: number; questions?: string[]; refresh?: boolean; signal?: AbortSignal;
}
type LifecycleQueryer = ConstructorParameters<typeof MemoryLifecycle>[1];
const ajv = new Ajv({ allErrors: true, strict: true });
const reportValidator = ajv.compile(readJson(join(schemasRoot, 'story-audit.schema.json')));
const MAX_BYTES = 1_048_576;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function checksum(value: object): string { const { checksum: _checksum, ...rest } = value as Record<string, unknown>; return hash(json(rest)); }
function preparationRevision(value: Preparation): string {
  const { preparedRevision: _revision, checksum: _checksum, ...rest } = value;
  return hash(json(rest));
}
function receiptId(value: CompletionReceipt): string {
  const { receiptId: _receipt, checksum: _checksum, ...rest } = value;
  return hash(json(rest));
}
function keys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}
function timestamp(value: string): boolean { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }

/** Review artifacts and author completion receipts, never a source of new canon. */
export class StoryAudits {
  readonly lifecycle: MemoryLifecycle;
  constructor(readonly project: Project, options: { queryer?: LifecycleQueryer } = {}) {
    this.lifecycle = new MemoryLifecycle(project, options.queryer);
  }
  private locked<T>(action: () => T): T { return this.project.store.db.isTransaction ? action() : this.project.store.transaction(action); }
  private bookId(): string {
    const id = loadConfig(this.project.root).bookId;
    if (!id) throw new Error('Story audits require a stable bookId; migrate the book identity explicitly');
    return id;
  }
  private path(...parts: string[]): string {
    const target = safePath(this.project.root, 'specwriter', ...parts), base = resolve(this.project.root);
    let current = base;
    for (const part of relative(base, target).split(sep)) {
      current = join(current, part);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new Error('Story audit paths cannot follow links or unsupported files');
      }
    }
    return target;
  }
  private auditPath(id: string, ...parts: string[]): string { return this.path('story-audits', identifier(id), ...parts); }
  private read<T>(path: string): T {
    if (!existsSync(path)) throw new Error(`Missing story audit artifact: ${path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Unsupported or oversized story audit artifact');
    return readJson<T>(path);
  }
  private validateReport(value: unknown, id: string): StoryAuditReport {
    if (!reportValidator(value)) throw new Error(`Invalid story audit report: ${ajv.errorsText(reportValidator.errors)}`);
    const report = value as StoryAuditReport;
    if (report.id !== identifier(id) || report.bookId !== this.bookId() || report.scope.from > report.scope.to || Buffer.byteLength(json(report)) > MAX_BYTES) throw new Error('Invalid, oversized or foreign story audit report');
    identifier(report.taskId);
    return report;
  }
  private blank(prepared: Preparation): StoryAuditReport {
    return {
      schemaVersion: 1, id: prepared.id, bookId: prepared.bookId, kind: prepared.kind, preparedRevision: prepared.preparedRevision,
      taskId: prepared.taskId, taskPreparedRevision: prepared.taskPreparedRevision, taskRevision: null, inputFingerprint: prepared.inputFingerprint,
      scope: structuredClone(prepared.scope), hookInventory: structuredClone(prepared.hookInventory),
      summary: { text: '', evidence: [] }, characterChanges: [], mainlineChanges: [],
      hookDecisions: prepared.hookInventory.map(hook => ({ hookId: hook.id, disposition: 'needs-resolution', reason: '', authorReason: null, evidence: [] })),
      findings: [], unknowns: [], reviewed: false, reviewNotes: [],
    };
  }
  private prepared(id: string, revision?: string): Preparation {
    if (revision !== undefined && !sha256(revision)) throw new Error('Invalid story audit preparation revision');
    const value = this.read<Preparation>(this.auditPath(id, ...(revision ? ['preparations', `${revision}.json`] : ['prepared.json'])));
    keys(value, ['schemaVersion', 'id', 'bookId', 'kind', 'taskId', 'taskPreparedRevision', 'scope', 'hookInventory', 'inputFingerprint', 'preparedAt', 'preparedRevision', 'checksum'], 'story audit preparation');
    if (!sha256(value.preparedRevision) || !sha256(value.checksum) || value.preparedRevision !== preparationRevision(value) || value.checksum !== checksum(value) || !timestamp(value.preparedAt) || (revision && value.preparedRevision !== revision)) throw new Error('Altered story audit preparation');
    this.validateReport(this.blank(value), id);
    return value;
  }
  private machine(report: StoryAuditReport, prepared: Preparation): void {
    const fields = ['id', 'bookId', 'kind', 'preparedRevision', 'taskId', 'taskPreparedRevision', 'inputFingerprint', 'scope', 'hookInventory'] as const;
    for (const field of fields) if (json(report[field]) !== json(prepared[field])) throw new Error(`Story audit machine field was changed: ${field}`);
  }
  private scope(from: number, to: number): StoryAuditScope {
    const revisions = trustedPrefix(this.project.store.revisions());
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > revisions.length) throw new Error('Story audit range must be within the nonempty reconciled accepted prefix');
    return { from, to, chapters: revisions.filter(item => item.chapter <= to).map(item => ({ chapter: item.chapter, revision: item.id, bodyHash: item.bodyHash })) };
  }
  private hooks(at: number): StoryAuditHook[] {
    const revisions = trustedPrefix(this.project.store.revisions());
    return replay(revisions, at).hooks.filter(hook => !['resolved', 'superseded'].includes(hook.status)).map(hook => {
      const body = revisions.find(row => row.id === hook.sourceRevision && row.chapter === hook.sourceChapter)?.body;
      if (!body || !body.includes(hook.evidence.quote)) throw new Error(`Hook lacks canonical evidence: ${hook.id}`);
      const start = hook.evidence.start ?? body.indexOf(hook.evidence.quote);
      return { id: hook.id, description: hook.description, status: hook.status as StoryAuditHook['status'], sourceChapter: hook.sourceChapter,
        sourceRevision: hook.sourceRevision, evidence: { chapter: hook.sourceChapter, revision: hook.sourceRevision, quote: hook.evidence.quote, start, end: start + hook.evidence.quote.length } };
    });
  }
  private fingerprint(scope: StoryAuditScope, kind: StoryAuditKind): string {
    this.project.assertInstructionConsistency();
    // Backup switches and context sizing do not change the reviewed story or author intent.
    const { versioning: _versioning, contextBudgetChars: _budget, ...storyConfig } = loadConfig(this.project.root);
    const specs = ['premise', 'world', 'characters', 'style'].map(name => {
      const path = this.path('specs', `${name}.md`);
      return [name, existsSync(path) ? hash(this.readText(path)) : null];
    });
    return hash(json({ bookId: this.bookId(), scope: this.scope(scope.from, scope.to), hooks: this.hooks(scope.to),
      config: storyConfig, specs, contracts: this.project.store.contracts(), instructions: this.project.instructions.list(),
      feedback: new NovelReader(this.project).feedback(),
      ...(kind === 'finish' ? { allChapters: this.project.store.revisions().map(row => [row.chapter, row.id, row.bodyHash, row.stale]) } : {}),
    }));
  }
  private readText(path: string): string {
    // Same artifact limits and path checks apply to mutable specs; this does not adopt them.
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Unsupported or oversized story audit input');
    return readFileSync(path, 'utf8');
  }
  private finishGuard(scope: StoryAuditScope): void {
    this.project.assertInstructionConsistency();
    const revisions = this.project.store.revisions();
    if (!revisions.length || scope.from !== 1 || scope.to !== revisions.length || trustedPrefix(revisions).length !== revisions.length) throw new Error('Finish requires every chapter in the complete reconciled accepted book');
    if (dirtyFiles(this.project.root, revisions).length) throw new Error('Finish refuses modified canonical files; reconcile/sync them first');
    const blocking = new NovelReader(this.project).feedback().filter(item => item.blocking && !item.applied && !(item.status === 'resolved' && item.decision?.decision === 'decline'));
    if (blocking.length) throw new Error(`Finish requires processing blocking author feedback: ${blocking.map(item => item.id).join(', ')}`);
  }
  async prepare(id: string, options: StoryAuditPrepareOptions) {
    identifier(id); this.bookId();
    if (!options || !['recap', 'finish'].includes(options.kind)) throw new Error('Story audit kind must be recap or finish');
    const preparedPath = this.auditPath(id, 'prepared.json'), draftPath = this.auditPath(id, 'draft.json');
    const { scope, inputFingerprint, prior, expectedPreparedRevision } = this.locked(() => {
      this.project.assertInstructionConsistency();
      const trusted = trustedPrefix(this.project.store.revisions());
      if (!trusted.length) throw new Error('Story audit requires nonempty reconciled accepted prose');
      const scope = this.scope(options.from ?? 1, options.to ?? trusted.length);
      if (options.kind === 'finish') this.finishGuard(scope);
      const inputFingerprint = this.fingerprint(scope, options.kind);
      const existing = existsSync(preparedPath) ? this.prepared(id) : null;
      if (existing && (existing.kind !== options.kind || existing.scope.from !== scope.from || existing.scope.to !== scope.to)) throw new Error('Story audit kind and range are immutable; choose a new id');
      const prior = !options.refresh ? existing : null;
      if (prior && (prior.kind !== options.kind || json(prior.scope) !== json(scope) || prior.inputFingerprint !== inputFingerprint)) throw new Error('Story audit inputs changed; prepare with refresh or use a new id');
      return { scope, inputFingerprint, prior, expectedPreparedRevision: existing?.preparedRevision ?? null };
    });
    const task = await this.lifecycle.prepare(id, { stage: options.kind, from: scope.from, to: scope.to, questions: options.questions, refresh: options.refresh, signal: options.signal });
    return this.locked(() => {
      if (inputFingerprint !== this.fingerprint(scope, options.kind)) throw new Error('Story changed during memory preparation; refresh before reviewing');
      if ((existsSync(preparedPath) ? this.prepared(id).preparedRevision : null) !== expectedPreparedRevision) throw new Error('Story audit preparation changed concurrently; retry without overwriting it');
      if (this.lifecycle.draft(id).preparedRevision !== task.preparedRevision) throw new Error('Memory preparation changed before story audit publication');
      if (prior) {
        if (task.preparedRevision !== prior.taskPreparedRevision || this.prepared(id).preparedRevision !== prior.preparedRevision) throw new Error('Memory/story preparation changed; refresh the story audit');
        writeNew(draftPath, json(this.blank(prior)));
        return { id, kind: options.kind, draftPath, preparedPath, preparedRevision: prior.preparedRevision, memoryTask: task };
      }
      const prepared: Preparation = { schemaVersion: 1, id, bookId: this.bookId(), kind: options.kind, taskId: id,
        taskPreparedRevision: task.preparedRevision, scope, hookInventory: this.hooks(scope.to), inputFingerprint,
        preparedAt: new Date().toISOString(), preparedRevision: '', checksum: '' };
      prepared.preparedRevision = preparationRevision(prepared); prepared.checksum = checksum(prepared);
      const report = this.blank(prepared); this.validateReport(report, id);
      writeNew(this.auditPath(id, 'preparations', `${prepared.preparedRevision}.json`), json(prepared));
      atomicWrite(preparedPath, json(prepared)); atomicWrite(draftPath, json(report));
      return { id, kind: options.kind, draftPath, preparedPath, preparedRevision: prepared.preparedRevision, memoryTask: task };
    });
  }
  draft(id: string): StoryAuditReport { return this.validateReport(this.read(this.auditPath(id, 'draft.json')), id); }
  private evidence(evidence: StoryAuditEvidence, report: StoryAuditReport): void {
    const reference = report.scope.chapters.find(row => row.chapter === evidence.chapter && row.revision === evidence.revision);
    const revision = trustedPrefix(this.project.store.revisions()).find(row => row.chapter === evidence.chapter && row.id === evidence.revision);
    if (!reference || !revision || reference.bodyHash !== revision.bodyHash || hash(revision.body) !== revision.bodyHash || !revision.body.includes(evidence.quote)) throw new Error('Story audit quote is absent from its exact accepted chapter/revision');
    if (evidence.start !== undefined && (evidence.end! <= evidence.start || revision.body.slice(evidence.start, evidence.end) !== evidence.quote)) throw new Error('Story audit quote offsets do not match canonical prose');
    if (evidence.start === undefined && revision.body.indexOf(evidence.quote) !== revision.body.lastIndexOf(evidence.quote)) throw new Error('Repeated story audit quote requires exact offsets');
  }
  private review(report: StoryAuditReport): void {
    if (!report.reviewed || !report.reviewNotes.length || report.reviewNotes.some(note => !note.trim())) throw new Error('Story audit requires actual review and review notes');
    for (const claim of [report.summary, ...report.characterChanges, ...report.mainlineChanges]) {
      if (!claim.text.trim() || !claim.evidence.length || !claim.evidence.some(item => item.chapter >= report.scope.from && item.chapter <= report.scope.to)) throw new Error('Story audit claims need text and precise evidence from the reviewed range');
      claim.evidence.forEach(item => this.evidence(item, report));
    }
    const inventory = new Set(report.hookInventory.map(hook => hook.id)), handled = new Set<string>();
    for (const hook of report.hookInventory) this.evidence(hook.evidence, report);
    for (const decision of report.hookDecisions) {
      if (!inventory.has(decision.hookId) || handled.has(decision.hookId)) throw new Error('Unknown or duplicate hook decision');
      handled.add(decision.hookId);
      if (!decision.reason.trim() || decision.disposition === 'needs-resolution') throw new Error(`Unresolved hook review: ${decision.hookId}`);
      if (decision.disposition === 'author-retained' && !decision.authorReason?.trim()) throw new Error(`Retained hook requires the actual author decision: ${decision.hookId}`);
      if (report.kind === 'finish' && decision.disposition !== 'author-retained') throw new Error(`Finish needs resolution or explicit author-retained suspense: ${decision.hookId}`);
      decision.evidence.forEach(item => this.evidence(item, report));
    }
    if (inventory.size !== handled.size) throw new Error('Every unclosed hook needs an explicit review decision');
    const findings = new Set<string>();
    for (const finding of report.findings) {
      identifier(finding.id);
      if (findings.has(finding.id)) throw new Error('Duplicate story audit finding');
      findings.add(finding.id);
      if (!finding.description.trim() || (finding.resolved && !finding.resolution?.trim())) throw new Error('Resolved findings need a substantive resolution');
      if (finding.severity === 'blocking' && !finding.resolved) throw new Error(`Unresolved blocking story audit finding: ${finding.id}`);
      if (!finding.evidence.length) throw new Error('Story audit findings need canonical prose evidence');
      finding.evidence.forEach(item => this.evidence(item, report));
    }
  }
  private freshness(report: StoryAuditReport): string[] {
    const reasons: string[] = [];
    try {
      if (this.prepared(report.id).preparedRevision !== report.preparedRevision) reasons.push('A newer story preparation supersedes this review');
      if (this.fingerprint(report.scope, report.kind) !== report.inputFingerprint) reasons.push('Accepted prose, scope, specs or author guidance changed');
      const task = report.taskRevision ? this.lifecycle.show(report.taskId, report.taskRevision) : null;
      if (!task?.completed || !task.fresh || task.report.preparedRevision !== report.taskPreparedRevision) reasons.push('Associated memory task is incomplete, stale or from a different preparation');
      if (task && this.lifecycle.show(report.taskId).revision !== task.revision) reasons.push('A newer memory review supersedes this audit');
      if (report.kind === 'finish') this.finishGuard(report.scope);
    } catch (error) { reasons.push((error as Error).message); }
    return reasons;
  }
  save(id: string): StoryAuditVersion { return this.locked(() => this.saveLocked(id)); }
  private saveLocked(id: string): StoryAuditVersion {
    const report = this.draft(id), prepared = this.prepared(id); this.machine(report, prepared);
    const task = this.lifecycle.show(report.taskId);
    if (!task.completed || !task.fresh || task.report.preparedRevision !== report.taskPreparedRevision || task.stage !== report.kind) throw new Error('Story audit needs its completed, fresh memory task from the same preparation');
    if (report.taskRevision !== null && report.taskRevision !== task.revision) throw new Error('Memory task review changed; refresh/review the story audit');
    report.taskRevision = task.revision;
    const stale = this.freshness(report); if (stale.length) throw new Error(`Story audit is stale: ${stale.join('; ')}`);
    this.review(report);
    if (existsSync(this.auditPath(id, 'current.json'))) this.show(id);
    const reportHash = hash(json(report)), revision = reportHash;
    const path = this.auditPath(id, 'versions', `${revision}.json`);
    let version: StoryAuditVersion;
    if (existsSync(path)) version = this.version(id, revision);
    else {
      version = { schemaVersion: 1, id, bookId: this.bookId(), kind: report.kind, revision, status: 'ready', recordedAt: new Date().toISOString(), report, reportHash, checksum: '' };
      version.checksum = checksum(version); writeNew(path, json(version));
      version = this.version(id, revision);
    }
    const pointer = { schemaVersion: 1, id, bookId: this.bookId(), revision, versionChecksum: version.checksum, checksum: '' };
    pointer.checksum = checksum(pointer); atomicWrite(this.auditPath(id, 'current.json'), json(pointer));
    atomicWrite(this.auditPath(id, 'draft.json'), json(report));
    return version;
  }
  private version(id: string, revision: string): StoryAuditVersion {
    if (!sha256(revision)) throw new Error('Invalid story audit revision');
    const version = this.read<StoryAuditVersion>(this.auditPath(id, 'versions', `${revision}.json`));
    keys(version, ['schemaVersion', 'id', 'bookId', 'kind', 'revision', 'status', 'recordedAt', 'report', 'reportHash', 'checksum'], 'story audit version');
    const report = this.validateReport(version.report, id);
    if (version.schemaVersion !== 1 || version.id !== id || version.bookId !== this.bookId() || version.kind !== report.kind || version.status !== 'ready' || !timestamp(version.recordedAt) || version.revision !== revision || version.reportHash !== hash(json(report)) || revision !== version.reportHash || version.checksum !== checksum(version) || !sha256(report.taskRevision)) throw new Error('Altered or foreign story audit version');
    this.machine(report, this.prepared(id, report.preparedRevision));
    return version;
  }
  show(id: string, revision?: string) { return this.locked(() => this.showLocked(id, revision)); }
  private draftState(id: string, published: StoryAuditReport) {
    let draftPath: string | null = null;
    try {
      draftPath = this.auditPath(id, 'draft.json');
      return { draftPath, draftError: null, hasDraftChanges: json(this.draft(id)) !== json(published) };
    } catch (error) {
      return { draftPath, draftError: (error as Error).message, hasDraftChanges: true };
    }
  }
  private showLocked(id: string, revision?: string) {
    if (revision === undefined) {
      const pointer = this.read<{ schemaVersion: 1; id: string; bookId: string; revision: string; versionChecksum: string; checksum: string }>(this.auditPath(id, 'current.json'));
      keys(pointer, ['schemaVersion', 'id', 'bookId', 'revision', 'versionChecksum', 'checksum'], 'story audit pointer');
      if (pointer.schemaVersion !== 1 || pointer.id !== id || pointer.bookId !== this.bookId() || pointer.checksum !== checksum(pointer)) throw new Error('Altered or foreign story audit pointer');
      const version = this.version(id, pointer.revision);
      if (pointer.versionChecksum !== version.checksum) throw new Error('Story audit pointer checksum mismatch');
      const staleReasons = this.freshness(version.report);
      return { ...version, fresh: !staleReasons.length, staleReasons, ...this.draftState(id, version.report) };
    }
    const version = this.version(id, revision), staleReasons = this.freshness(version.report);
    return { ...version, fresh: !staleReasons.length, staleReasons, ...this.draftState(id, version.report) };
  }
  list(kind?: StoryAuditKind) {
    if (kind !== undefined && !['recap', 'finish'].includes(kind)) throw new Error('Invalid story audit kind');
    const directory = this.path('story-audits'); if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsupported story audit catalog entry');
      const id = identifier(entry.name), current = existsSync(this.auditPath(id, 'current.json')) ? this.show(id) : null;
      const prepared = current ? null : this.prepared(id);
      const draft = current ?? this.draftState(id, this.blank(prepared!));
      return { id, kind: current?.kind ?? prepared!.kind, status: current ? (current.fresh ? 'ready' as const : 'stale' as const) : 'draft' as const,
        revision: current?.revision ?? null, fresh: current?.fresh ?? false, staleReasons: current?.staleReasons ?? [],
        hasDraftChanges: current?.hasDraftChanges ?? !!draft.draftError, draftError: draft.draftError, draftPath: draft.draftPath, scope: current?.report.scope ?? prepared!.scope };
    }).filter(item => kind === undefined || item.kind === kind);
  }
  private receipt(id: string): CompletionReceipt {
    if (!sha256(id)) throw new Error('Invalid completion receipt id');
    const value = this.read<CompletionReceipt>(this.path('completion', 'receipts', `${id}.json`));
    keys(value, ['schemaVersion', 'bookId', 'reportId', 'reportRevision', 'receiptId', 'scope', 'inputFingerprint', 'authorReason', 'retainedHooks', 'completedAt', 'checksum'], 'completion receipt');
    if (value.schemaVersion !== 1 || value.bookId !== this.bookId() || value.receiptId !== id || value.receiptId !== receiptId(value) || value.checksum !== checksum(value) || !timestamp(value.completedAt) || typeof value.authorReason !== 'string' || !value.authorReason.trim() || value.authorReason.length > 10000) throw new Error('Altered or foreign completion receipt');
    const version = this.version(value.reportId, value.reportRevision);
    if (version.kind !== 'finish' || json(value.scope) !== json(version.report.scope) || value.inputFingerprint !== version.report.inputFingerprint || json(value.retainedHooks) !== json(version.report.hookDecisions.map(row => ({ hookId: row.hookId, authorReason: row.authorReason })))) throw new Error('Completion receipt does not match its finish report');
    return value;
  }
  private receiptFreshness(receipt: CompletionReceipt): string[] {
    try {
      const current = this.show(receipt.reportId), version = this.show(receipt.reportId, receipt.reportRevision);
      return [...version.staleReasons, ...(current.revision !== receipt.reportRevision ? ['A newer finish report supersedes this completion'] : []),
        ...(current.hasDraftChanges ? [current.draftError ? `Finish draft cannot be validated: ${current.draftError}` : 'Finish report has unreviewed draft changes'] : [])];
    } catch (error) { return [(error as Error).message]; }
  }
  status() { return this.locked(() => this.statusLocked()); }
  private statusLocked() {
    const directory = this.path('completion', 'receipts'), pointerPath = this.path('completion', 'current.json');
    let currentId: string | null = null;
    if (existsSync(pointerPath)) {
      const pointer = this.read<{ schemaVersion: 1; bookId: string; receiptId: string; receiptChecksum: string; checksum: string }>(pointerPath);
      keys(pointer, ['schemaVersion', 'bookId', 'receiptId', 'receiptChecksum', 'checksum'], 'completion pointer');
      if (pointer.schemaVersion !== 1 || pointer.bookId !== this.bookId() || pointer.checksum !== checksum(pointer) || this.receipt(pointer.receiptId).checksum !== pointer.receiptChecksum) throw new Error('Altered or foreign completion pointer');
      currentId = pointer.receiptId;
    }
    const history = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).map(entry => {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) throw new Error('Unsupported completion receipt catalog entry');
      const receipt = this.receipt(entry.name.slice(0, -5)), reasons = this.receiptFreshness(receipt);
      return { receipt, current: receipt.receiptId === currentId, valid: !reasons.length, reasons };
    }).sort((a, b) => a.receipt.completedAt.localeCompare(b.receipt.completedAt)) : [];
    const current = history.find(item => item.current) ?? null;
    if (currentId && !current) throw new Error('Current completion receipt is missing');
    return { status: current ? (current.valid ? 'completed' as const : 'invalidated' as const) : 'unfinished' as const,
      completed: current?.valid ?? false, completion: current?.receipt ?? null, reasons: current?.reasons ?? [], reports: this.list(), current, history };
  }
  accept(id: string, reason: string) { return this.locked(() => this.acceptLocked(id, reason)); }
  private acceptLocked(id: string, reason: string) {
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 10000) throw new Error('Completion acceptance requires the actual author completion instruction');
    const version = this.show(id);
    if (version.kind !== 'finish' || !version.fresh || version.hasDraftChanges) throw new Error('Completion requires the fresh saved finish report without unreviewed changes');
    this.finishGuard(version.report.scope); this.review(version.report);
    const prior = this.status().current;
    if (prior?.valid && prior.receipt.reportId === id && prior.receipt.reportRevision === version.revision && prior.receipt.authorReason === reason.trim()) return { ...prior.receipt, receiptPath: this.path('completion', 'receipts', `${prior.receipt.receiptId}.json`), valid: true };
    const receipt: CompletionReceipt = { schemaVersion: 1, bookId: this.bookId(), reportId: id, reportRevision: version.revision, receiptId: '',
      scope: version.report.scope, inputFingerprint: version.report.inputFingerprint, authorReason: reason.trim(),
      retainedHooks: version.report.hookDecisions.map(row => ({ hookId: row.hookId, authorReason: row.authorReason! })), completedAt: new Date().toISOString(), checksum: '' };
    receipt.receiptId = receiptId(receipt); receipt.checksum = checksum(receipt);
    const receiptPath = this.path('completion', 'receipts', `${receipt.receiptId}.json`);
    writeNew(receiptPath, json(receipt)); this.receipt(receipt.receiptId);
    const pointer = { schemaVersion: 1, bookId: this.bookId(), receiptId: receipt.receiptId, receiptChecksum: receipt.checksum, checksum: '' };
    pointer.checksum = checksum(pointer); atomicWrite(this.path('completion', 'current.json'), json(pointer));
    return { ...receipt, receiptPath, valid: true };
  }
}
