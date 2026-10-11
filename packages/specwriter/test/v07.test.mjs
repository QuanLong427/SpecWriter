import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { BookVersions, Project, UsageLedger, MicrosoftGraphRag, diagnoseModels } from '../dist/index.js';
import { book, draft } from './boundary-fixture.mjs';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('backup status survives restart and detects standalone specs, feedback, deletions and unsaved accepted chapters', t => {
  const { root, project } = book(t), versions = new BookVersions(root);
  assert.equal(project.status().backup.enabled, false);
  assert.equal(project.status().backup.needsSave, null);
  versions.init(project);
  assert.equal(project.status().backup.needsSave, false);
  const style = join(root, 'specwriter/specs/style.md');
  writeFileSync(style, readFileSync(style, 'utf8') + '\n作者新约定');
  mkdirSync(join(root, 'specwriter/feedback'));
  const feedback = join(root, 'specwriter/feedback/note.json'); writeFileSync(feedback, '{}');
  const restart = new Project(root);
  try {
    const status = restart.status().backup;
    assert.equal(status.needsSave, true); assert.equal(status.memoryChanged, false);
    assert.ok(status.changedFiles.includes('specwriter/specs/style.md'));
    assert.ok(status.changedFiles.includes('specwriter/feedback/note.json'));
    versions.save(restart); assert.equal(restart.status().backup.needsSave, false);
    rmSync(feedback); assert.ok(restart.status().backup.changedFiles.includes('specwriter/feedback/note.json'));
    writeFileSync(feedback, '{}');
    const path = join(root, 'specwriter/config.yaml'), config = parse(readFileSync(path, 'utf8'));
    config.versioning.autoSave = false; writeFileSync(path, stringify(config)); versions.save(restart);
    draft(restart, root, 1, '林舟走进茶楼。'); restart.commit(1, 'arc');
    assert.equal(restart.status().backup.memoryChanged, true);
    assert.equal(restart.status().backup.needsSave, true);
    versions.save(restart); assert.equal(restart.status().backup.needsSave, false);
  } finally { restart.close(); }
});

test('backup failures persist without exposing secrets and clear after successful save', t => {
  const { root, project } = book(t), versions = new BookVersions(root); versions.init(project);
  writeFileSync(join(root, '.env'), 'QWEN_API_KEY=secret-v07-fixture\n');
  writeFileSync(join(root, 'specwriter/specs/style.md'), 'secret-v07-fixture');
  assert.throws(() => versions.save(project), /credential/);
  const next = new Project(root);
  try {
    const status = next.status().backup;
    assert.ok(status.lastFailure.at); assert.equal(status.needsSave, true);
    assert.ok(!JSON.stringify(status).includes('secret-v07-fixture'));
    writeFileSync(join(root, 'specwriter/specs/style.md'), '作者设定');
    versions.save(next); assert.equal(next.status().backup.lastFailure, null);
  } finally { next.close(); }
});

test('model diagnosis is offline by default, probes HTTP endpoints and checks BGE dimensions without echoing credentials', async t => {
  const { root, project } = book(t);
  const requests = [];
  let dimensions = 3, denied = false;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(text) });
    res.setHeader('Content-Type', 'application/json');
    if (denied) { res.statusCode = 401; res.end(JSON.stringify({ error: 'DO-NOT-ECHO-SECRET' })); return; }
    res.end(JSON.stringify(req.url.endsWith('embeddings') ? { data: [{ embedding: Array(dimensions).fill(0.2) }], usage: { prompt_tokens: 4 } }
      : { choices: [{ message: { content: 'DO-NOT-ECHO-RESPONSE' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const directory = join(root, '.specwriter/graphrag/provider'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.env'), 'SPECWRITER_TEST_MODEL_KEY=offline-secret\n');
  const model = { model_provider: 'openai', model: 'qwen', api_key: '${SPECWRITER_TEST_MODEL_KEY}', api_base: base };
  writeFileSync(join(directory, 'settings.yaml'), stringify({ completion_models: { main: model }, embedding_models: { main: { ...model, model: 'bge-m3' } }, vector_store: { vector_size: 3 } }));
  const offline = await diagnoseModels(root);
  assert.equal(offline.configured, true); assert.equal(offline.ready, false); assert.equal(requests.length, 0);
  const live = await diagnoseModels(root, { probe: true });
  assert.equal(live.ready, true); assert.equal(requests.length, 2);
  assert.equal(requests[0].body.max_tokens, 16); assert.equal(requests[0].auth, 'Bearer offline-secret');
  assert.ok(!JSON.stringify(live).includes('offline-secret')); assert.ok(!JSON.stringify(live).includes('DO-NOT-ECHO'));
  dimensions = 2; const bad = await diagnoseModels(root, { probe: true });
  assert.equal(bad.ready, false); assert.match(bad.models[1].issue, /dimensions/);
  denied = true; const unauthorized = await diagnoseModels(root, { probe: true });
  assert.match(unauthorized.models[0].issue, /HTTP 401/); assert.ok(!JSON.stringify(unauthorized).includes('DO-NOT-ECHO'));
  writeFileSync(join(root, '.specwriter/graphrag/provider.json'), JSON.stringify({ schemaVersion: 1, python: 'fake', version: '3.3.0' }));
  const count = requests.length;
  const runtimeBad = await new MicrosoftGraphRag(project, async () => { throw new Error('private credential'); }).diagnose({ probe: true });
  assert.equal(runtimeBad.ready, false); assert.equal(requests.length, count); assert.ok(!JSON.stringify(runtimeBad).includes('private credential'));
  rmSync(join(directory, '.env'));
  assert.equal((await diagnoseModels(root)).configured, false);
});

test('book usage thresholds count observed paid usage, preserve unknowns, serialize operations and validate limits', t => {
  const { root, project, directory } = book(t), ledger = new UsageLedger(root);
  assert.equal(ledger.budgetStatus().enabled, false);
  assert.throws(() => ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxRequestsPerOperation: -1 }), /nonnegative/);
  assert.throws(() => ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxEstimatedCost: 2 }), /prices/);
  ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxRequestsPerOperation: 1, maxObservedTokens: 100 });
  const held = ledger.acquireBudget(); assert.equal(held.guard.maxRequestsPerOperation, 1);
  assert.throws(() => ledger.acquireBudget(), /busy/); assert.throws(() => ledger.configureBudget(null), /active/);
  assert.throws(() => ledger.recoverBudget(), /still running/); held.release();
  const snap = join(root, 'snapshot'); mkdirSync(snap); writeFileSync(join(snap, 'manifest.json'), JSON.stringify({ snapshotId: 'test', atChapter: 1 }));
  const session = ledger.start(snap, 'index');
  mkdirSync(dirname(session.rawPath), { recursive: true });
  writeFileSync(session.rawPath, [
    { observer: 1 },
    { model: 'openai/bge-m3', metrics: { attempted_request_count: 1, successful_response_count: 1, responses_with_tokens: 1, prompt_tokens: 900, specwriter_embedding: 1, specwriter_local: 1 } },
    { model: 'openai/qwen', metrics: { attempted_request_count: 1, successful_response_count: 1, responses_with_tokens: 1, prompt_tokens: 90, completion_tokens: 10, specwriter_completion: 1 } },
    { finished: true }
  ].map(JSON.stringify).join('\n')); ledger.finish(session, true);
  const status = ledger.budgetStatus(); assert.equal(status.observedPaidTokens, 100); assert.match(status.blocked, /threshold/);
  assert.throws(() => ledger.acquireBudget(), /stopped/); assert.equal(existsSync(join(root, '.specwriter/graphrag/usage/budget.lock')), false);
  const prices = { currency: 'TEST', models: [{ model: 'openai/qwen', kind: 'completion', inputPerMillion: 1, outputPerMillion: 2 }] };
  ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxEstimatedCost: 0.0001, prices });
  assert.match(ledger.budgetStatus().blocked, /cost/);
  const failed = ledger.start(snap, 'query'); ledger.finish(failed, false);
  ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxObservedTokens: 200 });
  assert.match(ledger.budgetStatus().blocked, /incomplete/);
  ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'allow', maxObservedTokens: 200 });
  const retry = ledger.acquireBudget(); retry.release();
  const versions = new BookVersions(root); versions.init(project);
  const restoredRoot = join(directory, 'migrated-budget'); versions.restore('HEAD', restoredRoot);
  const restored = new UsageLedger(restoredRoot).budgetStatus();
  assert.equal(restored.observedPaidTokens, 100); assert.equal(restored.incompleteOperations, 1);
  assert.equal(restored.budget.maxObservedTokens, 200);
  assert.equal(existsSync(join(restoredRoot, '.specwriter/graphrag/usage/raw')), false);
  ledger.configureBudget(null); assert.equal(ledger.budgetStatus().enabled, false);
});

test('CLI exposes backup and budget states and rejects accidental probe options before model calls', t => {
  const { root } = book(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' });
  let result = run('version', 'status'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).enabled, false);
  result = run('doctor', '--probe'); assert.equal(result.status, 1); assert.match(result.stderr, /requires --models/);
  result = run('memory', 'budget', 'configure', '--max-requests', '0'); assert.equal(result.status, 0, result.stderr);
  result = run('memory', 'budget', 'show'); assert.match(JSON.parse(result.stdout).blocked, /disabled/);
  result = run('memory', 'budget', 'clear'); assert.equal(result.status, 0, result.stderr);
  result = run('memory', 'graphrag', 'diagnose'); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).runtime.ready, false);
  result = run('memory', 'graphrag', 'setup', '--python', 'unused', '--credentials', 'unused', '--preset', 'invalid'); assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Unknown model preset/);
});

test('adapter blocks fresh model operations before spawn, passes budgets to workers and reuses indexes after thresholds', async t => {
  const { root, project } = book(t);
  draft(project, root, 1, '林舟走进茶楼。'); project.commit(1, 'arc');
  const calls = [];
  const provider = new MicrosoftGraphRag(project, async (_python, args, cwd, options) => {
    calls.push(args);
    if (args[0] === '-c') return { stdout: '3.3.0', stderr: '' };
    const directory = args[args.indexOf('--root') + 1];
    if (args[2] === 'init') {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'settings.yaml'), 'completion_models: {}\nembedding_models: {}\n');
      writeFileSync(join(directory, '.env'), 'GRAPHRAG_API_KEY=fixture-only\n');
    } else if (args[2] === 'index') {
      assert.equal(options.budget.maxRequestsPerOperation, 3); assert.equal(options.budget.initialTokens, 0);
      mkdirSync(join(directory, 'output'));
      for (const name of ['documents', 'text_units', 'entities', 'relationships', 'communities', 'community_reports']) writeFileSync(join(directory, 'output', name + '.parquet'), 'fixture');
      mkdirSync(dirname(options.metricsPath), { recursive: true });
      writeFileSync(options.metricsPath, [{ observer: 1 }, { model: 'openai/qwen', metrics: { attempted_request_count: 1,
        successful_response_count: 1, responses_with_tokens: 1, prompt_tokens: 90, completion_tokens: 20, specwriter_completion: 1 } }, { finished: true }].map(JSON.stringify).join('\n'));
    } else throw new Error('An exhausted budget must never spawn a query');
    return { stdout: '', stderr: '' };
  });
  await provider.setup({ python: 'fake', model: 'qwen', embedding: 'bge-m3' });
  const ledger = new UsageLedger(root); ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxRequestsPerOperation: 0 });
  await assert.rejects(provider.index(1), /budget stopped/); assert.equal(calls.some(args => args[2] === 'index'), false);
  ledger.configureBudget({ schemaVersion: 1, unknownUsage: 'block', maxRequestsPerOperation: 3, maxObservedTokens: 100 });
  await provider.index(1); assert.equal(ledger.budgetStatus().busy, false);
  await provider.index(1, { reuse: true }); assert.equal(calls.filter(args => args[2] === 'index').length, 1);
  await assert.rejects(provider.query('茶楼', { at: 1 }), /budget stopped/);
  assert.equal(ledger.budgetStatus().busy, false); assert.equal(calls.some(args => args[2] === 'query'), false);
});
