import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBenchmark, scoreBenchmark, UsageLedger, parseRequestMetrics, usageCost, validatePrices } from '../dist/index.js';

const temp = () => mkdtempSync(join(tmpdir(), 'specwriter-bench-test-'));
function metrics(directory, records) {
  const path = join(directory, 'requests.jsonl');
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n'); return path;
}
const fresh = (kind = 'completion', input = 100, output = 20) => ({ model: `fixture/${kind}`, metrics: {
  attempted_request_count: 1, successful_response_count: 1, failed_response_count: 0,
  responses_with_tokens: 1, prompt_tokens: input, ...(kind === 'completion' ? { completion_tokens: output } : {}),
  [`specwriter_${kind}`]: 1 } });

test('request usage excludes historic cache tokens, separates embeddings and refuses unknown pricing', () => {
  const directory = temp();
  const measured = parseRequestMetrics(metrics(directory, [{ observer: 1 }, fresh(), { ...fresh(), metrics: { ...fresh().metrics, cached_responses: 1 } }, fresh('embedding', 50), { finished: true }]), true);
  assert.equal(measured.coverage, 'complete');
  assert.equal(measured.inputTokens, 100); assert.equal(measured.outputTokens, 20); assert.equal(measured.embeddingTokens, 50);
  assert.equal(measured.models[0].cached, 1);
  const prices = { currency: 'TEST', models: [{ model: 'fixture/completion', kind: 'completion', inputPerMillion: 2, outputPerMillion: 4 }, { model: 'fixture/embedding', kind: 'embedding', inputPerMillion: 1 }] };
  validatePrices(prices);
  assert.ok(Math.abs(usageCost(measured, prices) - 0.00033) < 1e-10);
  assert.equal(usageCost(measured), null);
  assert.equal(usageCost(measured, { ...prices, models: prices.models.slice(0, 1) }), null);
  assert.throws(() => validatePrices({ currency: 'TEST', models: [{ model: 'x', kind: 'completion', inputPerMillion: -1, outputPerMillion: 1 }] }), /price/);
});

test('missing usage, interrupted runs, unknown request types and corrupt metrics remain incomplete', () => {
  const directory = temp();
  assert.equal(parseRequestMetrics(join(directory, 'absent'), true).coverage, 'unavailable');
  const noUsage = { model: 'unknown', metrics: { attempted_request_count: 1, successful_response_count: 1 } };
  for (const records of [[{ observer: 1 }, fresh()], [{ observer: 1 }, noUsage, { finished: true }], [{ observer: 1 }, { ...fresh(), metrics: { ...fresh().metrics, prompt_tokens: -2 } }, { finished: true }], [{ observer: 1 }, { ...fresh(), metrics: { ...fresh().metrics, retries: 1 } }, { finished: true }]]) {
    assert.equal(parseRequestMetrics(metrics(directory, records), true).coverage, 'partial');
  }
  assert.equal(parseRequestMetrics(metrics(directory, [{ observer: 1 }, fresh(), { finished: true }]), false).coverage, 'partial');
  const incompleteTokens = fresh(); delete incompleteTokens.metrics.prompt_tokens;
  assert.equal(parseRequestMetrics(metrics(directory, [{ observer: 1 }, incompleteTokens, { finished: true }]), true).coverage, 'partial');
  assert.equal(parseRequestMetrics(metrics(directory, [{ observer: 1 }, { finished: true }]), true).inputTokens, 0);
});

test('usage ledger preserves failed attempts and counts application reuse as zero new calls', () => {
  const directory = temp();
  // Reuse records are independent from original operations and do not duplicate tokens.
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ snapshotId: 'test', atChapter: 3 }));
  const ledger = new UsageLedger(directory);
  const attempt = ledger.start(directory, 'index');
  const original = metrics(directory, [{ observer: 1 }, fresh(), { finished: true }]);
  // start returns a raw destination whose parents are made by the observer.
  mkdirSync(join(directory, '.specwriter/graphrag/usage/raw'), { recursive: true });
  writeFileSync(attempt.rawPath, readFileSync(original)); ledger.finish(attempt, true);
  ledger.reused(directory, 'index'); ledger.reused(directory, 'query');
  const failed = ledger.start(directory, 'query'); ledger.finish(failed, false);
  const report = ledger.report();
  assert.equal(report.operationCount, 4); assert.equal(report.incompleteOperations, 1);
  assert.equal(report.observedTokens.input, 100); assert.equal(report.estimatedCost, null);
  assert.equal(report.operations.filter(r => r.outcome === 'reused').length, 2);
  assert.equal(report.totalsComplete, false);
  ledger.start(directory, 'update');
  assert.equal(ledger.report().operations.filter(r => r.outcome === 'running').length, 1);
  assert.equal(ledger.report().incompleteOperations, 2);
});

test('offline benchmark compares isolated arms, exercises append/cache/retcon and cannot claim model quality', async () => {
  const result = await runBenchmark({ out: join(temp(), 'run') });
  assert.equal(result.status, 'complete'); assert.equal(result.modelCalls, 0); assert.equal(result.cases.length, 48);
  assert.equal(result.qualityEligible, false);
  assert.ok(result.cases.every(c => c.invalidSources === 0 && c.context.length <= 6000));
  for (const arm of ['cold', 'warm', 'incremental']) {
    assert.equal(result.cases.find(c => c.arm === arm && c.step === 'repeat').cached, true);
    const changed = result.cases.find(c => c.arm === arm && c.step === 'retcon' && c.question === 'location');
    assert.equal(changed.cached, false); assert.ok(changed.context.includes('石桥')); assert.ok(!changed.context.includes('旧塔'));
  }
  const index = (arm, step) => result.measurements.find(m => m.arm === arm && m.step === step && m.operation === 'index').index;
  assert.equal(index('cold', 'append').indexing.mode, 'standard');
  assert.equal(index('warm', 'append').indexing.mode, 'standard'); assert.ok(index('warm', 'append').indexing.parentSnapshotId);
  assert.equal(index('incremental', 'append').indexing.mode, 'incremental');
  assert.equal(index('incremental', 'retcon').indexing.addedChapters, 1);
  assert.throws(() => scoreBenchmark(result.directory, join(result.directory, 'ratings-template.json')), /Offline/);
  assert.ok(existsSync(result.report));
  assert.equal(new UsageLedger(join(result.directory, 'books/cold')).report().estimatedCost, null);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const call = spawnSync(process.execPath, [cli, 'memory', 'usage', '--root', join(result.directory, 'books/cold'), '--json'], { encoding: 'utf8' });
  assert.equal(call.status, 0, call.stderr); assert.equal(JSON.parse(call.stdout).incompleteOperations, 16);
  const wrong = spawnSync(process.execPath, [cli, 'memory', 'usage', '--at', '1', '--root', join(result.directory, 'books/cold'), '--json'], { encoding: 'utf8' });
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /Unsupported option/);
  // Exercise scoring integrity without representing fixture outputs as actual model quality.
  const path = join(result.directory, 'report.json'), report = JSON.parse(readFileSync(path, 'utf8'));
  report.qualityEligible = true; writeFileSync(path, JSON.stringify(report));
  const ratingsPath = join(result.directory, 'ratings-template.json'), ratings = JSON.parse(readFileSync(ratingsPath, 'utf8'));
  const row = ratings.ratings[0]; Object.assign(row, { correct: true, unsupported: false, futureLeak: false, staleLeak: false, knowledgeLeak: false, notes: 'Unit fixture rating.' });
  writeFileSync(ratingsPath, JSON.stringify(ratings));
  assert.equal(scoreBenchmark(result.directory, ratingsPath).complete, false);
  assert.equal(scoreBenchmark(result.directory, ratingsPath).rated, 1);
  row.contextHash = 'stale'; writeFileSync(ratingsPath, JSON.stringify(ratings));
  assert.throws(() => scoreBenchmark(result.directory, ratingsPath), /stale/);
});

test('live experiments require explicit limits; operation cap leaves a readable partial report', async () => {
  await assert.rejects(runBenchmark({ mode: 'live' }), /provider/);
  const out = join(temp(), 'limited');
  await assert.rejects(runBenchmark({ out, arms: ['cold'], maxOperations: 1 }), /limit reached/);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.equal(report.status, 'failed'); assert.equal(report.scheduledOperations, 1);
  assert.ok(report.measurements.some(m => m.operation === 'final'));
  await assert.rejects(runBenchmark({ out }), /EEXIST/);
});
