import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Project, WriterMemory, MicrosoftGraphRag, initProject, loadConfig, configureMemory } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const load = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-default-'));
  initProject(root, '默认 GraphRAG');
  const project = new Project(root); project.propose('opening', '开篇', 1, 4);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project };
}
function runner(calls, behavior = {}) {
  return async (_python, args) => {
    calls.push(args);
    if (args[0] === '-c') return { stdout: '3.3.0', stderr: '' };
    const root = args[args.indexOf('--root') + 1];
    if (args[2] === 'init') {
      mkdirSync(join(root, 'prompts'), { recursive: true });
      writeFileSync(join(root, 'settings.yaml'), 'completion_models: {}\nembedding_models: {}\n');
      writeFileSync(join(root, 'prompts/extract.txt'), 'Extract only evidence');
      writeFileSync(join(root, '.env'), 'GRAPHRAG_API_KEY=private-test-placeholder\n');
    }
    if (args[2] === 'index') {
      if (behavior.failIndex) throw new Error('Index unavailable');
      mkdirSync(join(root, 'output'), { recursive: true });
      for (const name of ['documents', 'text_units', 'entities', 'relationships', 'communities', 'community_reports']) writeFileSync(join(root, `output/${name}.parquet`), 'mock provider index');
    }
    if (args[2] === 'query') {
      if (behavior.duringQuery) behavior.duringQuery();
      return { stdout: behavior.answer ?? '林舟与钥匙有关。[Data: Entities (1)] 此回答需要核对正文。', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}
async function configured(project, behavior = {}) {
  const calls = []; const provider = new MicrosoftGraphRag(project, runner(calls, behavior));
  await provider.setup({ python: 'test-python', model: 'chat', embedding: 'embedding' });
  return { memory: new WriterMemory(project, provider), provider, calls };
}
async function candidate(memory, project, root, chapter, body, options = {}) {
  const prepared = await memory.prepare(chapter, 'opening', { query: '林舟和青铜钥匙', ...options });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, 'opening');
  writeFileSync(paths.delta, JSON.stringify({ ...load(paths.delta), ...metadata, title: '钥匙', summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body } }], facts: [{ subject: '林舟', predicate: '行动', object: body, scope: 'world', holder: null, evidence: { quote: body } }] }));
  writeFileSync(paths.review, JSON.stringify({ ...load(paths.review), chapter, contextHash: metadata.contextHash, draftHash: metadata.draftHash, reviewed: true }));
  return { paths, prepared };
}
async function first(project, root) {
  await candidate(new WriterMemory(project), project, root, 1, '林舟在废井发现青铜钥匙。'); project.commit(1, 'opening');
}

test('new and legacy unspecified books default to Microsoft; explicit offline configuration preserves author YAML', t => {
  const { root, project } = fixture(t);
  assert.equal(loadConfig(root).memory.backend, 'microsoft-graphrag');
  assert.equal(project.status().memoryBackend, 'microsoft-graphrag');
  const path = join(root, 'specwriter/config.yaml');
  writeFileSync(path, '# 作者的配置\nschemaVersion: 1\nname: 旧书\nlanguage: zh\ncontextBudgetChars: 30000\ncustomAuthorField: 保留\n');
  assert.equal(loadConfig(root).memory.backend, 'microsoft-graphrag');
  const local = configureMemory(root, { backend: 'local', method: undefined });
  assert.equal(local.backend, 'local'); assert.equal(local.method, 'local');
  const content = readFileSync(path, 'utf8');
  assert.ok(content.includes('# 作者的配置') && content.includes('customAuthorField: 保留'));
  assert.throws(() => configureMemory(root, { backend: 'unknown' }), /Invalid memory/);
  assert.equal(readFileSync(path, 'utf8'), content);
});

test('first chapter and empty memory use default Microsoft cold start without a Python/model requirement', async t => {
  const { root, project } = fixture(t);
  const memory = new WriterMemory(project);
  const empty = await memory.query('前情'); assert.equal(empty.status, 'empty');
  const { paths } = await candidate(memory, project, root, 1, '林舟发现青铜钥匙。', { query: '' });
  const context = load(paths.context);
  assert.equal(context.retrieval.engine, 'microsoft-graphrag');
  assert.equal(context.retrieval.status, 'empty'); assert.ok(context.query.length > 0);
  assert.equal(project.verify(1, 'opening').valid, true); project.commit(1, 'opening');
  assert.equal(project.status().graphRagConfigured, false);
});

test('nonempty defaults require setup and never silently fall back to local retrieval', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const memory = new WriterMemory(project);
  await assert.rejects(memory.prepare(2, 'opening'), /default memory backend/);
  await assert.rejects(memory.query('钥匙'), /default memory backend/);
  assert.ok(!existsSync(join(root, project.chapterPaths('opening', 2).context)));
  const local = await memory.query('钥匙', { backend: 'local', holder: '林舟', hops: 2 });
  assert.equal(local.engine, 'writer-memory-graphrag'); assert.ok(local.passages.length > 0);
  await assert.rejects(memory.query('钥匙', { holder: '林舟' }), /--backend local/);
});

test('default preparation auto-indexes and embeds Microsoft retrieval; repeat prepare, verify and commit reuse the same receipt', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const { memory, calls } = await configured(project);
  const { paths, prepared } = await candidate(memory, project, root, 2, '林舟把青铜钥匙藏进衣袋。');
  const context = load(paths.context);
  assert.equal(context.retrieval.engine, 'microsoft-graphrag'); assert.equal(context.retrieval.status, 'ready');
  assert.equal(context.memorySelection.strategy, 'microsoft-graphrag');
  assert.ok(context.sources.some(source => source.kind === 'retrieval' && source.content.includes('核对正文')));
  assert.ok(!JSON.stringify(context).includes('private-test-placeholder'));
  assert.equal(calls.filter(args => args[2] === 'index').length, 1);
  assert.equal(calls.filter(args => args[2] === 'query').length, 1);
  const repeated = await memory.prepare(2, 'opening', { query: '林舟和青铜钥匙' });
  assert.equal(repeated.contextHash, prepared.contextHash);
  project.verify(2, 'opening'); project.commit(2, 'opening');
  assert.equal(calls.filter(args => args[2] === 'query').length, 1);
  assert.equal(calls.filter(args => args[2] === 'index').length, 1);
  assert.ok(!project.memory().facts.some(fact => fact.object.includes('[Data:')));
});

test('global default query caches semantic answer and returns separate formal state without model calls under SQLite locks', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const behavior = { duringQuery: () => project.store.db.exec('BEGIN IMMEDIATE; ROLLBACK;') };
  const { memory, calls } = await configured(project, behavior);
  const result = await memory.query('这一卷的主题？', { method: 'global' });
  assert.equal(result.engine, 'microsoft-graphrag'); assert.equal(result.method, 'global');
  assert.equal(result.structural.atChapter, 1); assert.equal(result.advisory, true);
  assert.equal((await memory.query('这一卷的主题？', { method: 'global' })).id, result.id);
  assert.equal(calls.filter(args => args[2] === 'query').length, 1);
});

test('default old-chapter preparation reuses only its earlier prefix; retcon creates a new index and excludes stale future prose', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const { memory, calls } = await configured(project);
  const second = await candidate(memory, project, root, 2, '白衡其实是幕后凶手。');
  const originalSnapshot = load(second.paths.context).retrieval.snapshotId;
  project.commit(2, 'opening');
  const early = await memory.prepare(2, 'opening', { query: '林舟和青铜钥匙', refresh: true });
  const earlyContext = load(join(root, early.paths.context));
  assert.equal(earlyContext.retrieval.snapshotId, originalSnapshot);
  assert.ok(!JSON.stringify(earlyContext).includes('幕后凶手'));
  assert.equal(calls.filter(args => args[2] === 'index').length, 1);
  await candidate(memory, project, root, 1, '林舟发现银环。', { refresh: true }); project.commit(1, 'opening');
  await assert.rejects(memory.query('白衡', { at: 2 }), /reconciled memory/);
  const revised = await memory.prepare(2, 'opening', { query: '林舟和青铜钥匙', refresh: true });
  const revisedContext = load(join(root, revised.paths.context));
  assert.notEqual(revisedContext.retrieval.snapshotId, originalSnapshot);
  assert.equal(calls.filter(args => args[2] === 'index').length, 2);
  assert.ok(!JSON.stringify(revisedContext).includes('幕后凶手'));
});

test('automatic indexing can be disabled; provider failure prevents preparing misleading chapter context', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const { memory, calls } = await configured(project, { failIndex: true });
  await assert.rejects(memory.prepare(2, 'opening'), /Index unavailable/);
  assert.ok(!existsSync(join(root, project.chapterPaths('opening', 2).context)));
  configureMemory(root, { backend: 'microsoft-graphrag', autoIndex: false });
  const count = calls.filter(args => args[2] === 'index').length;
  await assert.rejects(memory.query('钥匙'), /no complete/);
  assert.equal(calls.filter(args => args[2] === 'index').length, count);
});

test('creative input changes during semantic retrieval are rejected before artifacts are written', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const { memory } = await configured(project, { duringQuery: () => writeFileSync(join(root, 'specwriter/specs/world.md'), '# 新设定\n') });
  await assert.rejects(memory.prepare(2, 'opening'), /creative inputs changed/);
  assert.ok(!existsSync(join(root, project.chapterPaths('opening', 2).context)));
});

test('retrieval receipt tampering blocks verification without regenerating the model answer', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const { memory, calls } = await configured(project);
  const { paths } = await candidate(memory, project, root, 2, '林舟保存青铜钥匙。');
  const context = load(paths.context);
  const recordPath = join(root, context.sources.find(source => source.kind === 'retrieval').source);
  const record = load(recordPath); record.receipt.answer = '修改过的模型回答'; writeFileSync(recordPath, JSON.stringify(record));
  assert.throws(() => project.verify(2, 'opening'), /receipt was modified/);
  assert.equal(calls.filter(args => args[2] === 'query').length, 1);
  assert.equal(project.memory().atChapter, 1);
});

test('long model answers are budgeted deterministically, preserving the receipt hash and full private answer', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const answer = '带引用的检索建议。'.repeat(3000);
  const { memory } = await configured(project, { answer });
  const { paths } = await candidate(memory, project, root, 2, '林舟保存青铜钥匙。');
  const context = load(paths.context);
  assert.equal(context.retrieval.answerTruncated, true);
  assert.ok(JSON.stringify(context, null, 2).length < context.budgetChars);
  const source = context.sources.find(source => source.kind === 'retrieval');
  assert.ok(source.content.length <= 6000);
  assert.equal(load(join(root, source.source)).receipt.answer, answer);
  assert.equal(project.verify(2, 'opening').valid, true);
});

test('CLI uses Microsoft by default and supports explicit local configuration and query overrides', async t => {
  const { root, project } = fixture(t); await first(project, root);
  const call = args => spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' });
  const failed = call(['memory', 'query', '钥匙']); assert.equal(failed.status, 1);
  const local = call(['memory', 'query', '钥匙', '--backend', 'local']);
  assert.equal(local.status, 0, local.stderr); assert.equal(JSON.parse(local.stdout).engine, 'writer-memory-graphrag');
  const configured = call(['memory', 'configure', '--backend', 'local']); assert.equal(configured.status, 0, configured.stderr);
  assert.equal(loadConfig(root).memory.backend, 'local');
  const prepared = call(['prepare', '2', '--work', 'opening']); assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).memoryBackend, 'local');
});
