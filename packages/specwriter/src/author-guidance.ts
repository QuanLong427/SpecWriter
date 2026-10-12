import { existsSync, readdirSync } from 'node:fs';
import { atomicWrite, hash, identifier, json, positiveInteger, readJson, safePath } from './files.js';
import { loadConfig } from './init.js';
import type { Store } from './store.js';
import type { FeedbackDirective } from './reader.js';

export interface AuthorInstruction {
  schemaVersion: 1;
  id: string;
  bookId: string | null;
  text: string;
  kind: 'require' | 'avoid';
  fromChapter: number;
  toChapter: number | null;
  workId: string | null;
  createdAt: string;
  status: 'active' | 'retired';
  retiredAt?: string;
  retiredReason?: string;
}
export interface AuthorGuidance { version: 1; instructions: AuthorInstruction[]; feedback: FeedbackDirective[] }

/** Book-local author decisions, distinct from prose evidence and future plans. */
export class AuthorInstructions {
  private reconciledKey?: string;
  constructor(readonly root: string, readonly store: Store) {}
  private path(id: string) { return safePath(this.root, 'specwriter', 'instructions', `${identifier(id)}.json`); }
  private save(record: AuthorInstruction, fresh = false) {
    const content = json({ record, checksum: hash(json(record)) });
    if (fresh && existsSync(this.path(record.id))) throw new Error(`Instruction already exists: ${record.id}`);
    atomicWrite(this.path(record.id), content);
  }
  list(chapter?: number, workId?: string): AuthorInstruction[] {
    if (chapter !== undefined) positiveInteger(chapter, 'chapter');
    if (workId !== undefined) this.store.work(identifier(workId));
    const directory = safePath(this.root, 'specwriter', 'instructions');
    if (!existsSync(directory)) return [];
    const bookId = loadConfig(this.root).bookId ?? null;
    const records = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).filter(entry => entry.name.endsWith('.json')).map(entry => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsupported instruction file: ${entry.name}`);
      const data = readJson<{ record: AuthorInstruction; checksum: string }>(safePath(this.root, 'specwriter', 'instructions', entry.name));
      const r = data.record;
      if (!r || data.checksum !== hash(json(r)) || r.schemaVersion !== 1 || `${identifier(r.id)}.json` !== entry.name || r.bookId !== bookId ||
          typeof r.text !== 'string' || !r.text.trim() || r.text.length > 10000 || !['require', 'avoid'].includes(r.kind) || !['active', 'retired'].includes(r.status) ||
          !Number.isSafeInteger(r.fromChapter) || r.fromChapter < 1 || (r.toChapter !== null && (!Number.isSafeInteger(r.toChapter) || r.toChapter < r.fromChapter)) ||
          (r.workId !== null && (typeof r.workId !== 'string' || identifier(r.workId) !== r.workId)) || typeof r.createdAt !== 'string' ||
          (r.status === 'retired' && (!r.retiredReason?.trim() || typeof r.retiredAt !== 'string'))) throw new Error(`Invalid or foreign author instruction: ${entry.name}`);
      return r;
    });
    if (chapter === undefined && workId === undefined) return records;
    return records.filter(r => r.status === 'active' && (chapter === undefined || (chapter >= r.fromChapter && (r.toChapter === null || chapter <= r.toChapter))) && (r.workId === null || r.workId === workId));
  }
  add(id: string, options: { text: string; kind?: 'require' | 'avoid'; fromChapter: number; toChapter?: number; workId?: string }) {
    identifier(id); const text = options.text.trim(), kind = options.kind ?? 'require';
    const fromChapter = positiveInteger(options.fromChapter, 'from'), toChapter = options.toChapter === undefined ? null : positiveInteger(options.toChapter, 'to');
    if (!text || text.length > 10000) throw new Error('Instruction text must contain 1..10000 characters');
    if (!['require', 'avoid'].includes(kind)) throw new Error('Instruction kind must be require or avoid');
    if (toChapter !== null && toChapter < fromChapter) throw new Error('Instruction to must be >= from');
    const record: AuthorInstruction = { schemaVersion: 1, id, bookId: loadConfig(this.root).bookId ?? null, text, kind, fromChapter, toChapter, workId: options.workId ?? null, createdAt: new Date().toISOString(), status: 'active' };
    return this.store.transaction(() => {
      this.list();
      if (existsSync(this.path(id))) throw new Error(`Instruction already exists: ${id}`);
      if (record.workId !== null) {
        const work = this.store.work(identifier(record.workId));
        if (work.status !== 'active' || fromChapter < work.fromChapter || toChapter === null || toChapter > work.toChapter) throw new Error('A work instruction needs an explicit range inside an active work');
      } else if (this.store.revisions().some(r => r.chapter >= fromChapter)) this.store.invalidateFrom(fromChapter);
      this.save(record, true);
      return record;
    });
  }
  retire(id: string, reason: string) {
    if (!reason.trim()) throw new Error('Retiring an instruction requires the author reason');
    return this.store.transaction(() => {
      const record = this.list().find(r => r.id === identifier(id));
      if (!record) throw new Error(`Instruction does not exist: ${id}`);
      if (record.status === 'retired') return record;
      const retired: AuthorInstruction = { ...record, status: 'retired', retiredAt: new Date().toISOString(), retiredReason: reason.trim() };
      this.save(retired); return retired;
    });
  }
  /** Recover a file written just before a process/SQLite commit failure. */
  reconcile(): number[] {
    const reconcile = () => {
      const instructions = this.list().filter(r => r.status === 'active' && r.workId === null);
      if (!instructions.length) { this.reconciledKey = undefined; return []; }
      const fingerprint = hash(json(instructions)), key = `${this.store.generation()}:${fingerprint}`;
      if (this.reconciledKey === key) return [];
      const affected = this.store.revisions().filter(revision => !revision.stale && instructions.some(r =>
        revision.chapter >= r.fromChapter && (r.toChapter === null || revision.chapter <= r.toChapter) &&
        !revision.context.authorGuidance?.instructions.some(saved => json(saved) === json(r))));
      const invalidated = affected.length ? this.store.invalidateFrom(Math.min(...affected.map(r => r.chapter))) : [];
      this.reconciledKey = `${this.store.generation()}:${fingerprint}`;
      return invalidated;
    };
    return this.store.db.isTransaction ? reconcile() : this.store.transaction(reconcile);
  }
}

export function guidanceChecks(guidance?: AuthorGuidance) {
  if (!guidance) return [];
  return [
    ...guidance.instructions.map(r => ({ id: `instruction:${r.id}`, description: r.text, requiresQuote: r.kind === 'require', kind: r.kind, source: `specwriter/instructions/${r.id}.json` })),
    ...guidance.feedback.map(r => ({ id: `feedback:${r.feedbackId}`, description: r.note, requiresQuote: true, kind: 'feedback', source: `specwriter/feedback/${r.feedbackId}.json` })),
  ];
}
