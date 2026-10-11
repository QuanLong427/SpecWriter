import { loadConfig } from './init.js';
import { MicrosoftGraphRag } from './microsoft-graphrag.js';
import type { Project } from './project.js';
import type { GraphRagMethod } from './types.js';

/** Default memory orchestration. Canonical state remains in Project; model calls run outside its transactions. */
export class WriterMemory {
  constructor(readonly project: Project, private readonly provider = new MicrosoftGraphRag(project)) {}
  async prepare(chapter: number, workId: string, options: { query?: string; budget?: number; refresh?: boolean } = {}) {
    const request = this.project.prepareRequest(chapter, workId, options);
    if (request.backend === 'microsoft-graphrag' && request.atChapter > 0) {
      if (request.autoIndex) await this.provider.index(request.atChapter, { reuse: true });
      await this.provider.query(request.query, { at: request.atChapter, method: request.method, cache: true });
    }
    return { ...this.project.prepare(chapter, workId, { ...options, query: request.query, expectedToken: request.token }), memoryBackend: request.backend };
  }
  async query(query: string, options: { at?: number; holder?: string; limit?: number; hops?: number; backend?: 'microsoft-graphrag' | 'local'; method?: GraphRagMethod } = {}) {
    if (!query.trim()) throw new Error('Memory query must not be empty');
    const config = loadConfig(this.project.root).memory!;
    const backend = options.backend ?? config.backend;
    if (!['microsoft-graphrag', 'local'].includes(backend)) throw new Error('Memory backend must be microsoft-graphrag or local');
    if (options.method !== undefined && !['local', 'global', 'drift', 'basic'].includes(options.method)) throw new Error('GraphRAG method must be local, global, drift or basic');
    if (backend === 'local' && options.method !== undefined) throw new Error('--method applies to Microsoft GraphRAG; use --hops for local retrieval');
    if (backend === 'microsoft-graphrag' && (options.holder !== undefined || options.hops !== undefined)) throw new Error('Default Microsoft GraphRAG returns author-level retrieval. Use --backend local for --holder or --hops');
    const corpus = this.project.corpus(options.at);
    if (backend === 'local') return this.project.query(query, options);
    if (!corpus.atChapter) return { engine: 'microsoft-graphrag', status: 'empty', atChapter: 0, advisory: true, answer: '', note: 'No accepted prose exists yet; no model or index call is needed', structural: this.project.query(query, { at: 0, limit: options.limit }) };
    if (config.autoIndex) await this.provider.index(corpus.atChapter, { reuse: true });
    const result = await this.provider.query(query, { at: corpus.atChapter, method: options.method ?? config.method, cache: true });
    if (this.project.corpus(corpus.atChapter).snapshotId !== corpus.snapshotId) throw new Error('Accepted chapters changed during memory retrieval; retry against the current prefix');
    return { engine: 'microsoft-graphrag', ...result, structural: this.project.query(query, { at: corpus.atChapter, limit: options.limit, expectedSnapshotId: corpus.snapshotId }) };
  }
}
