import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Project, initProject, MicrosoftGraphRag, runGraphRag } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const fact = (subject, predicate, object, quote, scope = 'world', holder = null) => ({ subject, predicate, object, scope, holder, evidence: { quote } });
const entity = (id, name, quote, aliases = [], type = 'character') => ({ id, name, type, aliases, description: name, evidence: { quote } });
const event = (id, description, quote, participants = [], causes = [], scope = 'world', holder = null) => ({ id, description, participants, causes, location: null, story_time: null, scope, holder, evidence: { quote } });

test('provider process preserves split Chinese UTF-8, passes literal arguments and hides failure logs', async () => {
  const argument = '问题 $(literal-command)';
  const result = await runGraphRag(process.execPath, ['-e', "const b=Buffer.from('青铜钥匙'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),20); process.stderr.write(process.argv[1]);", argument], tmpdir());
  assert.equal(result.stdout, '青铜钥匙'); assert.equal(result.stderr, argument);
  await assert.rejects(runGraphRag(process.execPath, ['-e', "process.stderr.write('private-test-key'); process.exit(1)"], tmpdir()), error => /exited with code 1/.test(error.message) && !error.message.includes('private-test-key'));
});
function fixture(t, to = 4) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-graph-'));
  initProject(root, '长篇记忆', { memoryBackend: 'local' });
  const project = new Project(root);
  project.propose('opening', '开篇', 1, to);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project };
}
function candidate(project, root, chapter, body, changes = {}, options = {}) {
  const prepared = project.prepare(chapter, 'opening', { query: '林舟', ...options });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, 'opening');
  writeFileSync(paths.delta, JSON.stringify(extraction({ ...load(paths.delta), ...metadata, title: `第${chapter}章`, summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body } }], ...changes }, body)));
  writeFileSync(paths.review, JSON.stringify(assessment(load(paths.review), metadata)));
  return paths;
}
function accept(project, root, chapter, body, changes = {}) {
  candidate(project, root, chapter, body, changes); return project.commit(chapter, 'opening');
}

test('two-hop GraphRAG discovers indirect relationships with original evidence and stable entity aliases', t => {
  const { root, project } = fixture(t);
  const body = '林舟被叫作小舟。林舟认识白衡，白衡持有天书。';
  accept(project, root, 1, body, { entities: [entity('lin-zhou', '林舟', body, ['小舟']), entity('bai-heng', '白衡', body)], facts: [fact('林舟', '认识', '白衡', body), fact('白衡', '持有', '天书', body)] });
  const one = project.query('小舟', { hops: 1 });
  const two = project.query('小舟', { hops: 2 });
  assert.ok(!one.facts.some(item => item.object === '天书'));
  assert.ok(two.facts.some(item => item.object === '天书'));
  assert.ok(two.graph.paths.some(path => path.edgeIds.length === 2));
  assert.ok(two.graph.edges.every(edge => edge.evidence.quote === body && edge.sourceChapter === 1));
  assert.ok(two.passages.some(hit => hit.excerpt.includes('白衡持有天书')));
  assert.throws(() => project.query('林舟', { hops: 5 }), /1–4/);
});

test('alias changes and later event resolution cannot leak into old snapshots or chapter context', t => {
  const { root, project } = fixture(t);
  const first = '林舟捡到青铜钥匙。';
  accept(project, root, 1, first, { entities: [entity('lin-zhou', '林舟', first)], facts: [fact('林舟', '持有', '青铜钥匙', first)] });
  const old = project.graph(1);
  const second = '林舟被揭露为暗帝，白衡死于山洞。';
  accept(project, root, 2, second, { entities: [entity('lin-zhou', '林舟', second, ['暗帝'])], narrative_events: [event('death-bai', '白衡死亡', second, ['白衡'])] });
  assert.equal(project.graph(1).snapshotId, old.snapshotId);
  assert.deepEqual(project.graph(1), old);
  assert.ok(!JSON.stringify(project.query('暗帝', { at: 1 })).includes(second));
  const paths = candidate(project, root, 2, second, {}, { refresh: true });
  const context = load(paths.context);
  assert.equal(context.memorySelection.strategy, 'hybrid-graphrag');
  assert.equal(context.retrieval.snapshotId, old.snapshotId);
  assert.ok(!JSON.stringify(context.memory).includes('暗帝'));
});

test('participant, location and causal edges remain distinct and show the causal source', t => {
  const { root, project } = fixture(t);
  const body = '林舟和白衡在山洞打破封印，因此魔王苏醒。';
  const release = { ...event('break-seal', '封印破碎', body, ['林舟', '白衡']), location: '山洞' };
  accept(project, root, 1, body, { narrative_events: [release, event('demon-wakes', '魔王苏醒', body, ['魔王'], ['break-seal'])] });
  const graph = project.graph();
  assert.equal(graph.edges.filter(edge => edge.kind === 'participant').length, 3);
  assert.equal(graph.edges.filter(edge => edge.kind === 'causal').length, 1);
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length);
  const causal = graph.edges.find(edge => edge.kind === 'causal');
  assert.equal(causal.from, 'event:break-seal'); assert.equal(causal.to, 'event:demon-wakes');
  assert.equal(project.query('魔王', { hops: 3 }).episodes.filter(item => item.kind === 'narrative-event').length, 2);
});

test('beliefs are filtered before graph traversal, including orphan values and private events', t => {
  const { root, project } = fixture(t);
  const body = '林舟误信白衡偷走天书，白衡其实持有银环。';
  accept(project, root, 1, body, { facts: [fact('白衡', '持有', '天书', body, 'belief', '林舟'), fact('白衡', '持有', '银环', body)], narrative_events: [event('false-theft', '白衡偷走天书', body, ['白衡'], [], 'belief', '林舟')] });
  const world = project.graph();
  assert.ok(!world.nodes.some(node => node.label === '天书' || node.recordId === 'false-theft'));
  assert.ok(project.query('白衡').facts.every(item => item.scope === 'world'));
  assert.ok(project.query('白衡', { holder: '林舟' }).facts.some(item => item.scope === 'belief'));
  assert.ok(project.query('白衡', { holder: '林舟' }).episodes.some(item => item.id === 'false-theft'));
});

test('dangling or cyclic event causes and belief-to-world causal promotions block acceptance', t => {
  const { root, project } = fixture(t);
  const body = '林舟以为白衡死了，他决定离开。';
  candidate(project, root, 1, body, { narrative_events: [event('leaves', '林舟离开', body, ['林舟'], ['missing'])] });
  assert.throws(() => project.commit(1, 'opening'), /Unknown event cause/);
  candidate(project, root, 1, body, { narrative_events: [event('one', '事件一', body, [], ['two']), event('two', '事件二', body, [], ['one'])] }, { refresh: true });
  assert.throws(() => project.commit(1, 'opening'), /cycle/);
  candidate(project, root, 1, body, { narrative_events: [event('rumor', '白衡死亡传闻', body, [], [], 'belief', '林舟'), event('death', '白衡确实死亡', body, [], ['rumor'])] }, { refresh: true });
  assert.throws(() => project.commit(1, 'opening'), /belief cannot/);
  assert.equal(project.memory().atChapter, 0);
});

test('resource ledgers verify arithmetic, prior balance and historical balances', t => {
  const { root, project } = fixture(t);
  const one = '林舟有十枚灵石，花掉三枚，还剩七枚。';
  const resource = (opening, change, closing, quote) => ({ entity: '林舟', resource: '灵石', opening, change, closing, evidence: { quote } });
  candidate(project, root, 1, one, { resource_changes: [resource(10, -3, 8, one)] });
  assert.throws(() => project.verify(1, 'opening'), /arithmetic|opening|closing/);
  candidate(project, root, 1, one, { resource_changes: [resource(10, -3, 7, one)] }, { refresh: true }); project.commit(1, 'opening');
  const two = '林舟获得两枚灵石，总共九枚。';
  candidate(project, root, 2, two, { resource_changes: [resource(8, 2, 10, two)] });
  assert.throws(() => project.commit(2, 'opening'), /opening value/);
  candidate(project, root, 2, two, { resource_changes: [resource(7, 2, 9, two)] }, { refresh: true }); project.commit(2, 'opening');
  assert.equal(project.memory(1).resources[0].amount, 7);
  assert.equal(project.query('林舟').resources[0].amount, 9);
});

test('hook dependencies and explicit supersession are replayed without turning payoff expectations into facts', t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现青铜钥匙。', { foreshadow_updates: [
    { id: 'key', action: 'plant', description: '青铜钥匙用途', evidence: { quote: '林舟发现青铜钥匙。' } }
  ] });
  const body = '青铜钥匙失效了，银环却能开启石门。';
  accept(project, root, 2, body, { foreshadow_updates: [
    { id: 'ring', action: 'plant', description: '银环用途', expected_payoff: '寻找门后秘密', evidence: { quote: body } },
    { id: 'door', action: 'plant', description: '门后秘密', depends_on: ['ring'], evidence: { quote: body } },
    { id: 'key', action: 'supersede', description: null, superseded_by: 'ring', evidence: { quote: body } }
  ] });
  assert.equal(project.memory().hooks.find(item => item.id === 'key').status, 'superseded');
  assert.ok(project.graph().edges.some(edge => edge.relation === 'superseded-by'));
  assert.ok(project.query('银环').hooks.some(hook => hook.id === 'door'));
  assert.equal(project.memory().facts.length, 0);
});

test('legacy database migration, corrupted graph cache and retcon invalidation preserve canonical data', t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟持有钥匙。', { facts: [fact('林舟', '持有', '钥匙', '林舟持有钥匙。')], entities: undefined, narrative_events: undefined, resource_changes: undefined });
  const before = project.graph();
  project.store.db.prepare('UPDATE memory_graph SET content = ?').run('corrupt');
  assert.deepEqual(project.graph(), before);
  project.store.db.exec("DROP TABLE memory_graph; UPDATE meta SET value = '1' WHERE key = 'schemaVersion';");
  const migrated = new Project(root);
  try { assert.deepEqual(migrated.graph(), before); assert.equal(migrated.memory().facts.length, 1); } finally { migrated.close(); }
  accept(project, root, 2, '林舟打开石门。');
  candidate(project, root, 1, '林舟从未拿到钥匙。', {}, { refresh: true }); project.commit(1, 'opening');
  assert.notEqual(project.graph().snapshotId, before.snapshotId);
  assert.equal(project.graph().atChapter, 1);
  assert.throws(() => project.graph(2), /reconciled/);
  assert.ok(project.graph().edges.every(edge => edge.sourceChapter <= 1));
});

function fakeRunner(calls, behavior = {}) {
  return async (executable, args, cwd) => {
    calls.push({ executable, args, cwd });
    if (args[0] === '-c') return { stdout: '3.3.0\n', stderr: '' };
    const root = args[args.indexOf('--root') + 1];
    if (args[2] === 'init') {
      mkdirSync(join(root, 'prompts'), { recursive: true });
      writeFileSync(join(root, 'prompts/extract.txt'), 'Extract evidence');
      writeFileSync(join(root, 'settings.yaml'), 'completion_models: {}\nembedding_models: {}\ninput_storage:\n  base_dir: dangerous-shared-input\nvector_store:\n  db_uri: dangerous-shared-vectors\n  vector_size: 1024\n');
      writeFileSync(join(root, '.env'), 'GRAPHRAG_API_KEY=test-placeholder\n');
    } else if (args[2] === 'index' || args[2] === 'update') {
      if (behavior.failIndex) throw new Error('Provider failed');
      mkdirSync(join(root, 'output/lancedb'), { recursive: true });
      for (const name of ['documents', 'text_units', 'entities', 'relationships', 'communities', 'community_reports']) writeFileSync(join(root, `output/${name}.parquet`), `test output ${args[2]}`);
      writeFileSync(join(root, 'output/lancedb/vectors.bin'), `vectors ${args[2]}`);
      if (behavior.afterIndex) behavior.afterIndex(args[2], root);
      if (behavior.duringIndex) behavior.duringIndex();
    } else if (args[2] === 'query') {
      if (behavior.duringQuery) behavior.duringQuery();
      return { stdout: behavior.answer ?? '有来源的模型回答', stderr: '' };
    } else if (args[0] === '-X') {
      return { stdout: JSON.stringify(behavior.citations ?? { sources: [], unresolvedCitations: [] }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

test('external corpus export contains only accepted prefix prose and detects added or changed documents', t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。'); accept(project, root, 2, '白衡就是幕后凶手。');
  candidate(project, root, 3, '尚未接纳的草稿。');
  const provider = new MicrosoftGraphRag(project);
  const exported = provider.export(1);
  assert.equal(exported.manifest.files.length, 1);
  assert.equal(readFileSync(join(exported.root, 'input/0001.txt'), 'utf8'), '林舟发现钥匙。');
  assert.deepEqual(readdirSync(join(exported.root, 'input')), ['0001.txt']);
  assert.ok(!JSON.stringify(exported.manifest).includes('凶手'));
  writeFileSync(join(exported.root, 'input/0002.txt'), '白衡就是幕后凶手。');
  assert.throws(() => provider.export(1), /untracked/);
  rmSync(join(exported.root, 'input/0002.txt'));
  writeFileSync(join(exported.root, 'input/0001.txt'), '篡改的正文');
  assert.throws(() => provider.export(1), /modified/);
});

test('incremental indexes clone a verified strict prefix and preserve parent vectors and old answers', async t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。');
  const calls = [], phases = [];
  const provider = new MicrosoftGraphRag(project, fakeRunner(calls));
  await provider.setup({ python: 'python', model: 'chat', embedding: 'embedding' });
  const first = await provider.index(1);
  const original = readFileSync(join(first.directory, 'output/lancedb/vectors.bin'), 'utf8');
  const answer = await provider.query('钥匙', { at: 1, cache: true });
  accept(project, root, 2, '白衡在第二章揭示未来秘密。');
  const second = await provider.index(2, { onProgress: item => phases.push(item.phase) });
  assert.equal(second.indexing.mode, 'incremental');
  assert.equal(second.indexing.addedChapters, 1);
  assert.equal(second.indexing.parentSnapshotId, first.snapshotId);
  assert.deepEqual(phases, ['starting', 'cloning', 'indexing', 'ready']);
  assert.equal(calls.filter(call => call.args[2] === 'index').length, 1);
  assert.equal(calls.filter(call => call.args[2] === 'update').length, 1);
  assert.equal(readFileSync(join(first.directory, 'output/lancedb/vectors.bin'), 'utf8'), original);
  assert.equal(readFileSync(join(second.directory, 'output/lancedb/vectors.bin'), 'utf8'), 'vectors update');
  assert.deepEqual(readdirSync(join(first.directory, 'input')), ['0001.txt']);
  assert.equal((await provider.query('钥匙', { at: 1, cache: true })).id, answer.id);
  assert.equal((await provider.index(2, { reuse: true })).reused, true);
  candidate(project, root, 1, '林舟从未见过钥匙。', {}, { refresh: true }); project.commit(1, 'opening');
  const replacement = await provider.index(1);
  assert.equal(replacement.indexing.mode, 'standard');
  assert.equal(replacement.indexing.parentSnapshotId, undefined);
  assert.equal(provider.inspect(1).ready, true);
});

test('configuration rebuild, failed update retry and cancelled subprocesses cannot leave false readiness', async t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。');
  const behavior = {}, calls = [], provider = new MicrosoftGraphRag(project, fakeRunner(calls, behavior));
  await provider.setup({ python: 'python', model: 'chat', embedding: 'embedding' });
  const first = await provider.index(1);
  const settings = join(root, '.specwriter/graphrag/provider/settings.yaml');
  writeFileSync(settings, readFileSync(settings, 'utf8') + 'concurrent_requests: 7\n');
  assert.equal(provider.inspect(1).ready, false);
  assert.equal(provider.inspect(1).readyMarker, true);
  await assert.rejects(provider.index(1, { reuse: true }), /changed or is incompatible/);
  await provider.index(1, { rebuild: true });
  accept(project, root, 2, '林舟找到石门。');
  behavior.failIndex = true;
  await assert.rejects(provider.index(2), /Provider failed/);
  assert.equal(provider.inspect(2).job.phase, 'failed');
  assert.equal(provider.inspect(2).busy, false);
  behavior.failIndex = false;
  assert.equal((await provider.index(2)).indexing.mode, 'incremental');
  const controller = new AbortController(); controller.abort();
  const before = calls.length;
  await assert.rejects(provider.index(2, { reuse: true, signal: controller.signal }), /abort/i);
  assert.equal(calls.length, before);
  const running = new AbortController();
  const child = runGraphRag(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, { signal: running.signal });
  setTimeout(() => running.abort(), 100);
  await assert.rejects(child, /cancelled/);
  await assert.rejects(runGraphRag(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, { timeoutMs: 100 }), /timed out/);
  assert.ok(existsSync(join(first.directory, 'ready.json')));
});

test('pruning preserves prepared indexes, receipts and prose; evicted indexes rebuild from canonical chapters', async t => {
  const { root, project } = fixture(t);
  const calls = [], provider = new MicrosoftGraphRag(project, fakeRunner(calls));
  await provider.setup({ python: 'python', model: 'chat', embedding: 'embedding' });
  const indexed = [], receipts = [];
  for (let chapter = 1; chapter <= 3; chapter++) {
    accept(project, root, chapter, `林舟完成第${chapter}步探索。`);
    indexed.push(await provider.index(chapter));
    receipts.push(await provider.query('林舟', { at: chapter, cache: true }));
  }
  const dry = await provider.prune({ keep: 1, dryRun: true });
  assert.deepEqual(new Set(dry.evicted), new Set(indexed.slice(0, 2).map(item => item.snapshotId)));
  assert.equal(provider.inspect(1).ready, true);
  // Bind a pending chapter to the first receipt while keeping Microsoft query entirely model-free.
  const configPath = join(root, 'specwriter/config.yaml');
  const oldConfig = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, oldConfig.replace('backend: local', 'backend: microsoft-graphrag'));
  const prepared = project.prepare(2, 'opening', { query: '林舟', refresh: true });
  assert.equal(load(join(root, prepared.paths.context)).retrieval.snapshotId, indexed[0].snapshotId);
  const result = await provider.prune({ keep: 1 });
  assert.deepEqual(result.evicted, [indexed[1].snapshotId]);
  assert.equal(provider.inspect(1).ready, true);
  assert.equal(provider.inspect(2).evicted, true);
  assert.equal(project.memory().atChapter, 3);
  assert.ok(existsSync(join(indexed[1].directory, 'queries', `${receipts[1].id}.json`)));
  assert.ok(!existsSync(join(indexed[1].directory, 'input')));
  const rebuilt = await provider.index(2);
  assert.equal(rebuilt.indexing.parentSnapshotId, indexed[0].snapshotId);
  assert.equal(provider.inspect(2).evicted, false);
  writeFileSync(configPath, oldConfig);
  assert.equal(project.doctor().healthy, true);
});

test('lock recovery refuses a running owner and only removes a confirmed dead owner', t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。');
  const provider = new MicrosoftGraphRag(project), exported = provider.export(1);
  const path = join(exported.root, '.specwriter-operation.lock');
  writeFileSync(path, JSON.stringify({ pid: process.pid }));
  assert.throws(() => provider.recover(1), /still running/);
  assert.ok(existsSync(path));
  let dead = 999999;
  for (; dead > 1; dead--) { try { process.kill(dead, 0); } catch (error) { if (error.code === 'ESRCH') break; } }
  assert.ok(dead > 1);
  writeFileSync(path, JSON.stringify({ pid: dead, childPid: process.pid }));
  assert.throws(() => provider.recover(1), /worker is still running/);
  assert.ok(existsSync(path));
  writeFileSync(path, JSON.stringify({ pid: dead }));
  assert.equal(provider.recover(1).recovered, true);
  assert.equal(provider.recover(1).recovered, false);
});

test('cancelling a real index worker records its PID and releases the lock only after exit', async t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。');
  const controller = new AbortController(), calls = [];
  const base = fakeRunner(calls);
  let workerPid;
  const runner = async (executable, args, cwd, options) => {
    if (args[2] !== 'index') return base(executable, args, cwd, options);
    return runGraphRag(process.execPath, ['-e', 'setInterval(()=>{},1000)'], cwd, { ...options, onSpawn: pid => {
      options.onSpawn(pid); workerPid = pid;
      assert.equal(load(join(cwd, '.specwriter-operation.lock')).childPid, pid);
      controller.abort();
    } });
  };
  const provider = new MicrosoftGraphRag(project, runner);
  await provider.setup({ python: 'python', model: 'chat', embedding: 'embedding' });
  await assert.rejects(provider.index(1, { signal: controller.signal }), /cancelled/);
  assert.ok(workerPid > 0);
  assert.throws(() => process.kill(workerPid, 0), error => error.code === 'ESRCH');
  const status = provider.inspect(1);
  assert.equal(status.busy, false); assert.equal(status.ready, false); assert.equal(status.job.phase, 'failed');
});

test('Microsoft citations map only to exact accepted prefix revisions and become context evidence', async t => {
  const { root, project } = fixture(t);
  const body = '林舟发现钥匙。'; accept(project, root, 1, body);
  const calls = [], behavior = { answer: '钥匙来自废井。[Data: Entities (1); Sources (999)]' };
  const provider = new MicrosoftGraphRag(project, fakeRunner(calls, behavior));
  await provider.setup({ python: 'python', model: 'chat', embedding: 'embedding' });
  await provider.index(1);
  const doc = project.corpus(1).documents[0];
  behavior.citations = { sources: [{ citationType: 'entities', citationId: '1', chapter: 1, revision: doc.revision, bodyHash: doc.bodyHash, excerpt: body }], unresolvedCitations: [{ citationType: 'text_units', citationId: '999' }] };
  const answer = await provider.query('林舟', { at: 1, cache: true });
  assert.equal(answer.sources[0].bodyHash, doc.bodyHash);
  assert.equal(answer.unresolvedCitations.length, 1);
  assert.deepEqual(provider.cachedQuery('林舟', { at: 1 }).sources, answer.sources);
  const configPath = join(root, 'specwriter/config.yaml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('backend: local', 'backend: microsoft-graphrag'));
  const prepared = project.prepare(2, 'opening', { query: '林舟' });
  assert.ok(load(join(root, prepared.paths.context)).sources.some(item => item.kind === 'prose' && item.chapter === 1 && item.content === body));
  behavior.citations.sources[0].chapter = 2;
  await assert.rejects(provider.query('未来', { at: 1 }), /does not match accepted prefix/);
  assert.ok(!readdirSync(join(provider.export(1).root, 'queries')).some(name => name.endsWith('.answer.txt')));
});

test('Microsoft adapter uses isolated storage and positional CLI queries; answers stay advisory', async t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。');
  const calls = []; const provider = new MicrosoftGraphRag(project, fakeRunner(calls));
  await provider.setup({ python: 'python with spaces', model: 'chat', embedding: 'embedding' });
  const indexed = await provider.index(1);
  const config = readFileSync(join(indexed.directory, 'settings.yaml'), 'utf8');
  assert.ok(!config.includes('dangerous-shared'));
  assert.ok(config.includes('db_uri: output/lancedb'));
  assert.ok(config.includes('vector_size: 1024'));
  assert.ok(config.includes('.*[.]txt$$'));
  const query = '钥匙来自哪里？ $(do-not-execute)';
  const result = await provider.query(query, { at: 1, method: 'global' });
  assert.equal(result.advisory, true); assert.equal(result.answer, '有来源的模型回答');
  assert.ok(calls.some(call => call.args[2] === 'query' && call.args[3] === query));
  assert.equal(project.store.generation(), 1);
  accept(project, root, 2, '林舟发现未来的秘密。');
  assert.equal((await provider.query(query, { at: 1 })).snapshotId, indexed.snapshotId);
  await assert.rejects(provider.query(query, { at: 2 }), /no complete/);
  const settingsPath = join(root, '.specwriter/graphrag/provider/settings.yaml');
  const originalSettings = readFileSync(settingsPath, 'utf8');
  writeFileSync(settingsPath, originalSettings + 'concurrent_requests: 7\n');
  await assert.rejects(provider.query(query, { at: 1 }), /changed or is incompatible/);
  writeFileSync(settingsPath, originalSettings);
  writeFileSync(join(indexed.directory, 'output/entities.parquet'), 'tampered');
  await assert.rejects(provider.query(query, { at: 1 }), /changed or is incompatible/);
});

test('failed, busy or obsolete external index/query cannot be marked ready or returned as fresh', async t => {
  const { root, project } = fixture(t);
  accept(project, root, 1, '林舟发现钥匙。');
  const calls = []; const behavior = { failIndex: true }; const provider = new MicrosoftGraphRag(project, fakeRunner(calls, behavior));
  await provider.setup({ python: 'python', model: 'chat', embedding: 'embedding' });
  const exported = provider.export(1);
  await assert.rejects(provider.index(1), /Provider failed/);
  assert.ok(!existsSync(join(exported.root, 'ready.json')));
  behavior.failIndex = false;
  writeFileSync(join(exported.root, '.specwriter-operation.lock'), '{"pid":123}');
  await assert.rejects(provider.index(1), /busy/); rmSync(join(exported.root, '.specwriter-operation.lock'));
  await provider.index(1);
  behavior.duringQuery = () => {
    candidate(project, root, 1, '林舟发现银环。', {}, { refresh: true }); project.commit(1, 'opening');
  };
  await assert.rejects(provider.query('钥匙', { at: 1 }), /changed during/);
});
