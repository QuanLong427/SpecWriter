import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, safePath } from './files.js';
import { proseChunks, terms } from './memory.js';
import type { SearchHit } from './memory.js';
import type { ChapterDelta, ChapterReview, ContextPackage, GraphSnapshot, Revision, WorkItem } from './types.js';

interface RevisionRow {
  id: number; chapter: number; body: string; body_hash: string;
  delta: string; review: string; context: string; work_id: string; accepted_at: string; stale: number;
}
interface WorkRow { id: string; title: string; from_chapter: number; to_chapter: number; status: 'active' | 'archived' }
export class Store {
  readonly db: DatabaseSync;
  constructor(root: string, create = false) {
    const path = safePath(root, '.specwriter', 'memory', 'writer.db');
    if (!create && !existsSync(path)) throw new Error('Memory database missing; initialize with specwriter init');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if (create) this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT OR IGNORE INTO meta VALUES ('schemaVersion', '1'), ('generation', '0');
        CREATE TABLE IF NOT EXISTS work (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, from_chapter INTEGER NOT NULL,
          to_chapter INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'archived'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chapter INTEGER NOT NULL, body TEXT NOT NULL,
          body_hash TEXT NOT NULL, delta TEXT NOT NULL, review TEXT NOT NULL, context TEXT NOT NULL,
          work_id TEXT NOT NULL REFERENCES work(id), accepted_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS chapters (
          chapter INTEGER PRIMARY KEY, revision_id INTEGER NOT NULL REFERENCES revisions(id),
          stale INTEGER NOT NULL CHECK(stale IN (0, 1))
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS prose_search USING fts5(
          tokens, excerpt UNINDEXED, chapter UNINDEXED, revision_id UNINDEXED, line UNINDEXED
        );
      `);
      const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string } | undefined;
      if (version?.value !== '1' && version?.value !== '2') throw new Error('Unsupported memory database schema version');
      // Derived graph cache is added without changing historical chapter/delta contracts.
      if (version.value === '1') this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS memory_graph (
          snapshot_id TEXT PRIMARY KEY, at_chapter INTEGER NOT NULL, content TEXT NOT NULL,
          checksum TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT; UPDATE meta SET value = '2' WHERE key = 'schemaVersion';`);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  generation(): number {
    return Number((this.db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string }).value);
  }
  private bump(): void { this.db.exec("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'generation'"); }
  works(): WorkItem[] {
    return (this.db.prepare('SELECT * FROM work ORDER BY id').all() as unknown as WorkRow[]).map(row => ({
      id: row.id, title: row.title, fromChapter: row.from_chapter, toChapter: row.to_chapter, status: row.status
    }));
  }
  work(id: string): WorkItem {
    const item = this.works().find(work => work.id === id);
    if (!item) throw new Error(`Unknown work: ${id}`);
    return item;
  }
  addWork(item: WorkItem): void {
    this.db.prepare('INSERT INTO work VALUES (?, ?, ?, ?, ?)').run(item.id, item.title, item.fromChapter, item.toChapter, item.status);
  }
  archiveWork(id: string): void { this.db.prepare("UPDATE work SET status = 'archived' WHERE id = ?").run(id); }
  revisions(): Revision[] {
    const rows = this.db.prepare(`SELECT r.*, c.stale FROM chapters c JOIN revisions r ON r.id = c.revision_id ORDER BY c.chapter`).all() as unknown as RevisionRow[];
    return rows.map(row => ({
      id: row.id, chapter: row.chapter, body: row.body, bodyHash: row.body_hash,
      delta: JSON.parse(row.delta) as ChapterDelta, review: JSON.parse(row.review) as ChapterReview,
      context: JSON.parse(row.context) as ContextPackage, workId: row.work_id, acceptedAt: row.accepted_at, stale: Boolean(row.stale)
    }));
  }
  history(chapter: number): { id: number; chapter: number; bodyHash: string; acceptedAt: string }[] {
    return this.db.prepare('SELECT id, chapter, body_hash AS bodyHash, accepted_at AS acceptedAt FROM revisions WHERE chapter = ? ORDER BY id').all(chapter) as unknown as { id: number; chapter: number; bodyHash: string; acceptedAt: string }[];
  }
  cachedGraph(snapshotId: string): GraphSnapshot | undefined {
    const row = this.db.prepare('SELECT content, checksum FROM memory_graph WHERE snapshot_id = ?').get(snapshotId) as { content: string; checksum: string } | undefined;
    if (!row || hash(row.content) !== row.checksum) return undefined;
    try {
      const graph = JSON.parse(row.content) as GraphSnapshot;
      return graph.schemaVersion === 1 && graph.kernelVersion === 1 && graph.snapshotId === snapshotId ? graph : undefined;
    } catch { return undefined; }
  }
  cacheGraph(graph: GraphSnapshot): void {
    const content = JSON.stringify(graph);
    this.db.prepare('INSERT INTO memory_graph VALUES (?, ?, ?, ?, ?) ON CONFLICT(snapshot_id) DO UPDATE SET content = excluded.content, checksum = excluded.checksum, created_at = excluded.created_at')
      .run(graph.snapshotId, graph.atChapter, content, hash(content), new Date().toISOString());
    // Only derived snapshots are evicted; accepted facts and revision history are permanent.
    this.db.exec('DELETE FROM memory_graph WHERE snapshot_id NOT IN (SELECT snapshot_id FROM memory_graph ORDER BY created_at DESC, snapshot_id LIMIT 16)');
  }
  clearGraphCache(): void { this.db.exec('DELETE FROM memory_graph'); }
  private indexBody(chapter: number, revision: number, body: string): void {
    const insert = this.db.prepare('INSERT INTO prose_search (tokens, excerpt, chapter, revision_id, line) VALUES (?, ?, ?, ?, ?)');
    for (const chunk of proseChunks(body)) insert.run(chunk.tokens, chunk.excerpt, chapter, revision, chunk.line);
  }
  rebuildSearch(): void {
    this.db.exec('DELETE FROM prose_search');
    const rows = this.db.prepare('SELECT id, chapter, body FROM revisions').all() as unknown as { id: number; chapter: number; body: string }[];
    for (const row of rows) this.indexBody(row.chapter, row.id, row.body);
  }
  search(query: string, atChapter: number, limit = 8): SearchHit[] {
    const queryTerms = [...new Set(terms(query))].slice(0, 32);
    if (!queryTerms.length) return [];
    const match = queryTerms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT s.excerpt, s.chapter, s.revision_id AS revision, s.line, -bm25(prose_search) AS score
      FROM prose_search s JOIN chapters c ON c.revision_id = s.revision_id
      WHERE prose_search MATCH ? AND c.stale = 0 AND c.chapter <= ?
      ORDER BY bm25(prose_search), c.chapter DESC LIMIT ?
    `).all(match, atChapter, limit) as unknown as Omit<SearchHit, 'source'>[];
    return rows.map(row => ({ ...row, source: `manuscript/chapters/${String(row.chapter).padStart(4, '0')}.md` }));
  }
  accept(body: string, delta: ChapterDelta, review: ChapterReview, context: ContextPackage, workId: string): number {
    const result = this.db.prepare('INSERT INTO revisions (chapter, body, body_hash, delta, review, context, work_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(delta.chapter, body, hash(body), JSON.stringify(delta), JSON.stringify(review), JSON.stringify(context), workId, new Date().toISOString());
    const id = Number(result.lastInsertRowid);
    this.indexBody(delta.chapter, id, body);
    this.db.prepare('INSERT INTO chapters VALUES (?, ?, 0) ON CONFLICT(chapter) DO UPDATE SET revision_id = excluded.revision_id, stale = 0').run(delta.chapter, id);
    // Conservative invalidation: later prose remains accepted but its derived memory needs reconciliation.
    this.db.prepare('UPDATE chapters SET stale = 1 WHERE chapter > ?').run(delta.chapter);
    this.bump();
    return id;
  }
}
