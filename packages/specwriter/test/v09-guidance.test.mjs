import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AuthorInstructions, Project, NovelReader, WriterMemory, initProject } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t, to = 3) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v09-guidance-'));
  initProject(root, '青铜钥匙', { memoryBackend: 'local', workflow: 'legacy' });
  const project = new Project(root);
  project.propose('opening', '开篇', 1, to);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { project, root, instructions: project.instructions, reader: new NovelReader(project) };
}
function candidate(project, root, chapter, work = 'opening', body = '林舟把青铜钥匙收进怀中。', refresh = false) {
  const prepared = project.prepare(chapter, work, { refresh });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, work);
  const delta = extraction({ ...read(paths.delta), ...metadata, title: '青铜钥匙', summary: body, key_events: [{ description: body, evidence: { quote: body } }] }, body);
  writeFileSync(paths.delta, JSON.stringify(delta));
  const review = assessment(read(paths.review), metadata, delta);
  review.intent_checks = project.reviewRequirements(chapter, work).intentChecks.map(expected => ({ id: expected.id, verdict: 'satisfied', explanation: '逐项核对当前正文。', evidenceQuotes: expected.requiresQuote ? [body] : [] }));
  writeFileSync(paths.review, JSON.stringify(review));
  return { paths, prepared, review, body };
}
function annotate(reader, chapter, note = '补充钥匙的动作细节。', blocking = true) {
  const source = reader.chapter(`accepted:${chapter}`);
  return reader.addFeedback({ chapterKey: source.key, bodyHash: source.bodyHash, quote: source.body, start: 0, end: source.body.length, note, blocking });
}

test('author instructions are protected scoped inputs requiring exact prose review', t => {
  const { project, root, instructions } = fixture(t);
  instructions.add('key-action', { text: '描写把钥匙收进怀中的动作。', fromChapter: 1, toChapter: 1, workId: 'opening' });
  instructions.add('no-reveal', { text: '暂不揭露师父身份。', kind: 'avoid', fromChapter: 1, toChapter: 2, workId: 'opening' });
  const input = candidate(project, root, 1);
  const context = read(input.paths.context);
  assert.equal(context.authorGuidance.instructions.length, 2);
  assert.ok(context.sources.filter(s => s.kind === 'instruction').every(s => s.protection === 'protected'));
  const checks = project.reviewRequirements(1, 'opening').intentChecks;
  assert.equal(checks.find(c => c.id === 'instruction:no-reveal').requiresQuote, false);
  input.review.intent_checks = [];
  writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /instruction:/);
  input.review.intent_checks = checks.map(c => ({ id: c.id, verdict: 'satisfied', evidenceQuotes: c.requiresQuote ? ['不存在的正文'] : [], explanation: '已检查。' }));
  writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /prose-specific review/);
  candidate(project, root, 1); project.commit(1, 'opening');
  const two = project.prepare(2, 'opening');
  assert.deepEqual(read(join(root, two.paths.context)).authorGuidance.instructions.map(r => r.id), ['no-reveal']);
});

test('new author instructions invalidate prepared context without discarding prose', t => {
  const { project, root, instructions } = fixture(t);
  const input = candidate(project, root, 1);
  const token = project.prepareRequest(1, 'opening').token;
  instructions.add('latest-choice', { text: '保留钥匙。', fromChapter: 1, toChapter: 1, workId: 'opening' });
  assert.throws(() => project.prepare(1, 'opening', { expectedToken: token }), /inputs changed/);
  assert.throws(() => project.verify(1, 'opening'), /Context is stale/);
  project.prepare(1, 'opening', { refresh: true });
  assert.equal(readFileSync(input.paths.draft, 'utf8'), input.body);
  assert.equal(read(input.paths.review).reviewed, false);
});

test('retroactive global instructions preserve prose and invalidate trusted memory/export', t => {
  const { project, root, instructions, reader } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening');
  candidate(project, root, 2); project.commit(2, 'opening');
  const old = project.store.revisions().map(r => r.body);
  instructions.add('retro-style', { text: '所有章节加强动作细节。', fromChapter: 1 });
  assert.deepEqual(project.store.revisions().map(r => r.body), old);
  assert.deepEqual(project.status().staleChapters, [1, 2]);
  assert.equal(project.corpus().documents.length, 0);
  assert.equal(reader.catalog().trustedThrough, 0);
  assert.throws(() => reader.writeExport('txt'), /reconciled|没有|No accepted/);
  project.sync();
  assert.throws(() => project.prepare(2, 'opening'), /chapter 1 first/);
  candidate(project, root, 1, 'opening', old[0], true); project.commit(1, 'opening');
  candidate(project, root, 2, 'opening', old[1], true); project.commit(2, 'opening');
  assert.equal(project.status().memoryThrough, 2);
});

test('new adopted feedback and work instructions reopen previously completed work', t => {
  const { project, root, reader, instructions } = fixture(t, 1);
  candidate(project, root, 1); project.commit(1, 'opening');
  assert.equal(project.resume('opening').stage, 'complete');
  instructions.add('new-detail', { text: '补充动作细节。', fromChapter: 1, toChapter: 1, workId: 'opening' });
  const feedback = annotate(reader, 1);
  reader.feedbackDecision(feedback.id, { decision: 'adopt', reason: '按作者意见补充。', workId: 'opening' });
  assert.notEqual(project.resume('opening').stage, 'complete');
  assert.throws(() => project.archive('opening'), /incomplete|accepted application record/);
  project.sync();
  assert.match(readFileSync(join(root, 'specwriter/work/opening/tasks.md'), 'utf8'), /\[ \] 第 1 章/);
  const input = candidate(project, root, 1, 'opening', '林舟用衣角擦去灰尘，把青铜钥匙收进怀中。', true);
  assert.ok(read(input.paths.context).authorGuidance.feedback.some(d => d.feedbackId === feedback.id));
  const accepted = project.commit(1, 'opening');
  const item = reader.feedback().find(f => f.id === feedback.id);
  assert.equal(item.applied.revisionId, accepted.revision);
  assert.equal(item.resolutionKind, 'applied');
  assert.equal(project.resume('opening').stage, 'complete');
  project.archive('opening');
});

test('blocking feedback arriving after prepare blocks verify and publication', t => {
  const { project, root, reader } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening');
  candidate(project, root, 2);
  const token = project.prepareRequest(2, 'opening').token;
  const feedback = annotate(reader, 1);
  assert.throws(() => project.verify(2, 'opening'), /阻塞批注/);
  assert.throws(() => project.prepare(2, 'opening', { expectedToken: token }), /阻塞批注/);
  assert.equal(project.resume('opening').stage, 'feedback');
  assert.throws(() => reader.resolveFeedback(feedback.id, true), /blocking|阻塞/);
  reader.feedbackDecision(feedback.id, { decision: 'decline', reason: '作者决定保留原文。' });
  assert.equal(project.verify(2, 'opening').valid, true);
});

test('applied-feedback write failures preserve acceptance and offer idempotent recovery', t => {
  const { project, root, reader } = fixture(t, 1);
  candidate(project, root, 1); project.commit(1, 'opening');
  const feedback = annotate(reader, 1);
  project.propose('fix-key', '完善细节', 1, 1);
  reader.feedbackDecision(feedback.id, { decision: 'adopt', reason: '补充动作。', workId: 'fix-key' });
  candidate(project, root, 1, 'fix-key', '林舟用衣角擦净钥匙，把青铜钥匙收进怀中。');
  const original = NovelReader.prototype.markFeedbackApplied;
  let accepted;
  try {
    NovelReader.prototype.markFeedbackApplied = () => { throw new Error('simulated feedback disk failure'); };
    accepted = project.commit(1, 'fix-key');
  } finally { NovelReader.prototype.markFeedbackApplied = original; }
  assert.equal(accepted.feedbackNeedsReconcile, true);
  assert.equal(project.store.revisions()[0].id, accepted.revision);
  assert.equal(project.resume('fix-key').stage, 'feedback-reconcile');
  assert.throws(() => project.archive('fix-key'), /accepted application record/);
  const first = reader.markFeedbackApplied(1, 'fix-key', accepted.revision)[0];
  assert.deepEqual(reader.markFeedbackApplied(1, 'fix-key', accepted.revision)[0], first);
  assert.equal(project.resume('fix-key').stage, 'complete');
  project.archive('fix-key');
});

test('instruction retirement, foreign identities and checksums preserve decision boundaries', t => {
  const { project, root, instructions } = fixture(t);
  instructions.add('choice', { text: '保留钥匙。', fromChapter: 1 });
  assert.throws(() => instructions.add('choice', { text: '另一个要求', fromChapter: 1 }), /already exists/);
  assert.throws(() => instructions.add('../escape', { text: '要求', fromChapter: 1 }), /portable/);
  assert.throws(() => instructions.add('bad-scope', { text: '要求', fromChapter: 1, workId: 'opening' }), /explicit range/);
  assert.throws(() => instructions.retire('choice', ''), /reason/);
  instructions.retire('choice', '作者取消这条要求。');
  assert.equal(instructions.list(1, 'opening').length, 0);
  assert.equal(instructions.list()[0].retiredReason, '作者取消这条要求。');
  const path = join(root, 'specwriter/instructions/choice.json'), record = read(path);
  record.record.text = '未经记录的新要求';
  writeFileSync(path, JSON.stringify(record));
  assert.throws(() => project.status(), /Invalid or foreign/);
});

test('protected instructions fail budget preflight before any GraphRAG provider call', async t => {
  const { project, root, instructions } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening');
  instructions.add('long-guidance', { text: '加强人物动作。'.repeat(800), fromChapter: 2 });
  const config = join(root, 'specwriter/config.yaml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('backend: local', 'backend: microsoft-graphrag'));
  let calls = 0;
  const provider = { index: async () => { calls++; }, query: async () => { calls++; } };
  await assert.rejects(new WriterMemory(project, provider).prepare(2, 'opening', { budget: 3000 }), /protected inputs exceed budget/);
  assert.equal(calls, 0);
});

test('instruction CLI records scoped instructions and rejects unrelated flags', t => {
  const { root } = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' });
  let result = run('instruction', 'add', 'author-choice', '--text', '暂不揭密。', '--kind', 'avoid', '--from', '1', '--to', '2', '--work', 'opening');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, 'avoid');
  result = run('instruction', 'list', '--chapter', '1', '--work', 'opening');
  assert.equal(JSON.parse(result.stdout).length, 1);
  assert.notEqual(run('instruction', 'list', '--text', 'invalid').status, 0);
  assert.equal(run('instruction', 'retire', 'author-choice', '--reason', '作者撤回。').status, 0);
});

test('a long-lived project repairs interrupted instruction publication before memory reads', t => {
  const { project, root, reader, instructions } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening');
  const transaction = project.store.transaction.bind(project.store);
  try {
    project.store.transaction = action => transaction(() => { action(); throw new Error('simulated commit failure'); });
    assert.throws(() => instructions.add('interrupted-change', { text: '从首章加强细节。', fromChapter: 1 }), /commit failure/);
  } finally { project.store.transaction = transaction; }
  assert.throws(() => reader.export('txt'), /没有可导出/);
  assert.equal(reader.catalog().trustedThrough, 0);
  assert.equal(project.query('钥匙').passages.length, 0);
  assert.equal(project.memory().atChapter, 0);
  assert.deepEqual(project.status().staleChapters, [1]);
});
