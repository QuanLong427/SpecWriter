import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
export interface UsageBudget {
  schemaVersion: 1; maxRequestsPerOperation?: number; maxObservedTokens?: number; maxEstimatedCost?: number;
  prices?: Prices; unknownUsage: 'block' | 'allow';
}
export function validateBudget(value: unknown): asserts value is UsageBudget {
  const b = value as UsageBudget;
  if (!b || b.schemaVersion !== 1 || !['block', 'allow'].includes(b.unknownUsage)
    || Object.keys(b).some(key => !['schemaVersion', 'maxRequestsPerOperation', 'maxObservedTokens', 'maxEstimatedCost', 'prices', 'unknownUsage'].includes(key))) throw new Error('Invalid usage budget');
  for (const field of ['maxRequestsPerOperation', 'maxObservedTokens'] as const) if (b[field] !== undefined && (!Number.isSafeInteger(b[field]) || b[field]! < 0)) throw new Error(`${field} must be a nonnegative integer`);
  if (b.maxEstimatedCost !== undefined && (!Number.isFinite(b.maxEstimatedCost) || b.maxEstimatedCost < 0 || !b.prices)) throw new Error('maxEstimatedCost requires a nonnegative number and model prices');
  if (b.prices) validatePrices(b.prices);
  if (b.maxRequestsPerOperation === undefined && b.maxObservedTokens === undefined && b.maxEstimatedCost === undefined) throw new Error('Configure at least one usage limit');
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
  private budgetPath() { return safePath(this.root, 'specwriter', 'memory-budget.json'); }
  budget(): UsageBudget | undefined {
    if (!existsSync(this.budgetPath())) return undefined;
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.budgetPath(), 'utf8')); } catch { throw new Error('Invalid memory-budget.json; fix it or run memory budget clear'); }
    validateBudget(value); return value;
  }
  configureBudget(value: UsageBudget | null) {
    if (value) validateBudget(value);
    if (existsSync(this.path('budget.lock'))) throw new Error('A budget-controlled operation is active; finish or recover it before changing the budget');
    if (value) atomicWrite(this.budgetPath(), json(value)); else rmSync(this.budgetPath(), { force: true });
    return this.budgetStatus();
  }
  budgetStatus() {
    const budget = this.budget();
    const report = this.report(budget?.prices);
    const observedPaidTokens = report.operations.reduce((sum, record) => sum + record.models.filter(model => !model.local).reduce((s, m) => s + m.inputTokens + m.outputTokens, 0), 0);
    const knownCost = report.operations.reduce((sum, record) => sum + (record.estimatedCost ?? 0), 0);
    const unknownCost = report.operations.filter(record => record.estimatedCost === null).length;
    let blocked: string | null = null;
    if (budget) {
      if (budget.maxRequestsPerOperation === 0) blocked = 'New model requests are disabled by the request limit';
      if (budget.maxObservedTokens !== undefined && observedPaidTokens >= budget.maxObservedTokens) blocked = 'Observed paid-token threshold reached';
      if (budget.maxEstimatedCost !== undefined && knownCost >= budget.maxEstimatedCost) blocked = 'Estimated-cost threshold reached';
      if (budget.unknownUsage === 'block' && ((budget.maxObservedTokens !== undefined && report.incompleteOperations > 0) || (budget.maxEstimatedCost !== undefined && unknownCost > 0))) blocked = 'Previous usage/cost is incomplete; reconcile it or explicitly configure --unknown-usage allow';
    }
    return { enabled: !!budget, budget: budget ?? null, observedPaidTokens, knownEstimatedCost: knownCost, unknownCostOperations: unknownCost,
      incompleteOperations: report.incompleteOperations, blocked, busy: existsSync(this.path('budget.lock')),
      note: 'GraphRAG only. Request limit counts noncached model attempts per index/update/query; token/cost thresholds stop subsequent requests after responses. In-flight requests may overshoot; Codex and diagnostic probes are excluded.' };
  }
  recoverBudget() {
    const lock = this.path('budget.lock');
    if (!existsSync(lock)) return { recovered: false };
    let owner: { pid: number; childPid?: number };
    try { owner = JSON.parse(readFileSync(lock, 'utf8')); } catch { throw new Error('Invalid budget lock; inspect it manually'); }
    for (const pid of [owner.pid, ...(owner.childPid === undefined ? [] : [owner.childPid])]) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid budget lock PID; inspect it manually');
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        throw new Error('Cannot confirm budget process stopped');
      }
      throw new Error('Budget owner or worker is still running; do not recover its lock');
    }
    rmSync(lock); return { recovered: true };
  }
  /** Serialize book operations while thresholds are active; independent snapshots share the same budget. */
  acquireBudget() {
    if (!this.budget()) return undefined;
    mkdirSync(this.path(), { recursive: true });
    const lock = this.path('budget.lock');
    try { writeFileSync(lock, json({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
    catch { throw new Error('Book usage budget is busy; run memory budget recover only after its process stops'); }
    try {
      const status = this.budgetStatus();
      if (status.blocked) throw new Error(`GraphRAG budget stopped the operation: ${status.blocked}`);
      return { guard: { ...status.budget!, initialTokens: status.observedPaidTokens, initialCost: status.knownEstimatedCost },
        onSpawn: (childPid: number) => atomicWrite(lock, json({ pid: process.pid, childPid, startedAt: new Date().toISOString() })),
        release: () => rmSync(lock, { force: true }) };
    } catch (error) { rmSync(lock, { force: true }); throw error; }
  }
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
