import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { atomicWrite, json, readJson, safePath } from './files.js';

export interface ModelUsage {
  model: string; kind: 'completion' | 'embedding' | 'unknown'; requests: number; cached: number;
  local?: true;
  successful: number; failed: number; responsesWithTokens: number;
  inputTokens: number; outputTokens: number; retries: number;
}
export interface UsageRecord {
  schemaVersion: 1; id: string; operation: 'index' | 'update' | 'query';
  snapshotId: string; atChapter: number; startedAt: string; durationMs: number;
  outcome: 'running' | 'success' | 'failed' | 'reused'; coverage: 'complete' | 'partial' | 'unavailable' | 'not-called';
  models: ModelUsage[]; inputTokens: number | null; outputTokens: number | null; embeddingTokens: number | null;
  source: 'request-metrics' | 'application-reuse';
}
export interface Prices {
  currency: string;
  models: { model: string; kind: 'completion' | 'embedding'; inputPerMillion: number; outputPerMillion?: number }[];
}
export function validatePrices(value: unknown): asserts value is Prices {
  const p = value as Prices;
  if (!p || typeof p.currency !== 'string' || !p.currency.trim() || !Array.isArray(p.models)) throw new Error('Invalid prices: currency and models are required');
  const keys = new Set<string>();
  for (const rate of p.models) {
    const key = `${rate?.kind}:${rate?.model}`;
    if (!rate || typeof rate.model !== 'string' || !rate.model || !['completion', 'embedding'].includes(rate.kind) || keys.has(key)
      || !Number.isFinite(rate.inputPerMillion) || rate.inputPerMillion < 0
      || (rate.outputPerMillion !== undefined && (!Number.isFinite(rate.outputPerMillion) || rate.outputPerMillion < 0))
      || (rate.kind === 'completion' && rate.outputPerMillion === undefined)) throw new Error('Invalid or duplicate model price');
    keys.add(key);
  }
}
export function usageCost(record: UsageRecord, prices?: Prices): number | null {
  if (record.coverage === 'not-called') return 0;
  if (record.coverage === 'complete' && record.models.every(m => m.requests === m.cached && !m.failed)) return 0;
  if (record.coverage !== 'complete') return null;
  let cost = 0;
  for (const model of record.models) {
    if (model.local) continue; // Local compute has no per-token API charge; hardware/electricity excluded.
    if (model.requests === model.cached && !model.failed) continue;
    const rate = prices?.models.find(item => item.model === model.model && item.kind === model.kind);
    if (!rate) return null;
    cost += (model.inputTokens * rate.inputPerMillion + model.outputTokens * (rate.outputPerMillion ?? 0)) / 1_000_000;
  }
  return cost;
}

/** Never infer missing provider usage from character counts or aggregate cache metrics. */
export function parseRequestMetrics(path: string, successfulProcess: boolean): Pick<UsageRecord, 'coverage' | 'models' | 'inputTokens' | 'outputTokens' | 'embeddingTokens'> {
  const models = new Map<string, ModelUsage>();
  let started = false, finished = false, malformed = false, records = 0;
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      if (item.observer === 1) { started = true; continue; }
      if (item.finished === true) { finished = true; continue; }
      const m = item.metrics;
      if (typeof item.model !== 'string' || !m || typeof m !== 'object') { malformed = true; continue; }
      const number = (key: string) => {
        const value = m[key];
        if (value === undefined) return 0;
        if (!Number.isSafeInteger(value) || value < 0) { malformed = true; return 0; }
        return value as number;
      };
      const kind = number('specwriter_embedding') ? 'embedding' : number('specwriter_completion') ? 'completion' : 'unknown';
      const local = number('specwriter_local') === 1 && kind === 'embedding';
      const key = `${kind}:${item.model}:${local}`;
      let entry = models.get(key);
      if (!entry) { entry = { model: item.model, kind, ...(local ? { local: true as const } : {}), requests: 0, cached: 0, successful: 0, failed: 0, responsesWithTokens: 0, inputTokens: 0, outputTokens: 0, retries: 0 }; models.set(key, entry); }
      records++;
      entry.requests += number('attempted_request_count'); entry.successful += number('successful_response_count');
      entry.failed += number('failed_response_count');
      const cached = number('cached_responses'); entry.cached += cached;
      // Local cache metrics contain old prompt/output tokens; they are NOT new usage.
      if (!cached) {
        if (number('responses_with_tokens') > 0 && (m.prompt_tokens === undefined || (kind === 'completion' && m.completion_tokens === undefined))) malformed = true;
        entry.retries += number('retries');
        entry.responsesWithTokens += number('responses_with_tokens');
        entry.inputTokens += number('prompt_tokens'); entry.outputTokens += number('completion_tokens');
      }
      if (number('attempted_request_count') !== 1 || number('successful_response_count') + number('failed_response_count') !== 1 || cached > number('successful_response_count')) malformed = true;
    } catch { malformed = true; }
  }
  const values = [...models.values()];
  const complete = started && finished && successfulProcess && !malformed && values.every(m => !m.failed && !m.retries
    && m.responsesWithTokens === m.successful - m.cached && (m.kind !== 'unknown' || m.requests === m.cached));
  const coverage = !started ? 'unavailable' : complete ? 'complete' : 'partial';
  // An initialized observer with no request callbacks is a measured no-request run.
  const total = (kind: string, field: 'inputTokens' | 'outputTokens') => values.filter(m => m.kind === kind).reduce((sum, m) => sum + m[field], 0);
  return { coverage, models: values, inputTokens: records || complete ? total('completion', 'inputTokens') : null,
    outputTokens: records || complete ? total('completion', 'outputTokens') : null,
    embeddingTokens: records || complete ? total('embedding', 'inputTokens') : null };
}

export class UsageLedger {
  constructor(readonly root: string) {}
  private path(...parts: string[]) { return safePath(this.root, '.specwriter', 'graphrag', 'usage', ...parts); }
  start(snapshotRoot: string, operation: UsageRecord['operation']) {
    const manifest = readJson<{ snapshotId: string; atChapter: number }>(safePath(snapshotRoot, 'manifest.json'));
    const id = randomUUID();
    const session = { id, operation, snapshotId: manifest.snapshotId, atChapter: manifest.atChapter, startedAt: new Date().toISOString(), started: Date.now(), rawPath: this.path('raw', `${id}.jsonl`) };
    // A hard-killed Node process still leaves an explicit unknown operation.
    atomicWrite(this.path('operations', `${id}.json`), json({ schemaVersion: 1, id, operation, snapshotId: manifest.snapshotId,
      atChapter: manifest.atChapter, startedAt: session.startedAt, durationMs: 0, outcome: 'running', coverage: 'unavailable',
      models: [], inputTokens: null, outputTokens: null, embeddingTokens: null, source: 'request-metrics' } satisfies UsageRecord));
    return session;
  }
  finish(session: ReturnType<UsageLedger['start']>, success: boolean): UsageRecord {
    const record: UsageRecord = { schemaVersion: 1, id: session.id, operation: session.operation, snapshotId: session.snapshotId,
      atChapter: session.atChapter, startedAt: session.startedAt, durationMs: Date.now() - session.started,
      outcome: success ? 'success' : 'failed', source: 'request-metrics', ...parseRequestMetrics(session.rawPath, success) };
    atomicWrite(this.path('operations', `${record.id}.json`), json(record)); return record;
  }
  reused(snapshotRoot: string, operation: 'index' | 'query') {
    const session = this.start(snapshotRoot, operation);
    const record: UsageRecord = { schemaVersion: 1, id: session.id, operation, snapshotId: session.snapshotId, atChapter: session.atChapter,
      startedAt: session.startedAt, durationMs: 0, outcome: 'reused', coverage: 'not-called', models: [],
      inputTokens: 0, outputTokens: 0, embeddingTokens: 0, source: 'application-reuse' };
    atomicWrite(this.path('operations', `${record.id}.json`), json(record)); return record;
  }
  records(): UsageRecord[] {
    const directory = this.path('operations');
    return !existsSync(directory) ? [] : readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => readJson<UsageRecord>(safePath(directory, name)))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }
  report(prices?: Prices) {
    if (prices) validatePrices(prices);
    const operations = this.records().map(record => ({ ...record, estimatedCost: usageCost(record, prices) }));
    const incomplete = operations.filter(record => !['complete', 'not-called'].includes(record.coverage)).length;
    const sum = (field: 'inputTokens' | 'outputTokens' | 'embeddingTokens') => operations.reduce((sum, r) => sum + (r[field] ?? 0), 0);
    return { schemaVersion: 1, scope: 'GraphRAG only; excludes Codex writing/extraction/review', currency: prices?.currency ?? null,
      operationCount: operations.length, incompleteOperations: incomplete, observedTokens: { input: sum('inputTokens'), output: sum('outputTokens'), embedding: sum('embeddingTokens') },
      totalsComplete: incomplete === 0 && operations.length > 0,
      estimatedCost: operations.length && operations.every(r => r.estimatedCost !== null) ? operations.reduce((sum, r) => sum + r.estimatedCost!, 0) : null,
      pricingNote: 'User-supplied rates; excludes provider cache discounts, tiers and unknown failed-request charges. Reconcile with provider billing.', operations };
  }
}
