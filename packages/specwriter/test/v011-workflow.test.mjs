import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project, MemoryLifecycle, WriterMemory, initProject, intentChecks, BookVersions } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const bodies = [
  '阿宁在渡口发现告示日期被擦掉。她决定向守桥人核实。',
  '守桥人说，告示是在昨夜贴上的。阿宁将这句话记为证词，去寻找贴告示的人。',
  '阿宁核对了船工的记账簿。姐姐从渡口另一边走来，解释自己借宿船工家修船。阿宁带姐姐回家。',
  '阿宁回到渡口，把修好的灯还给船工，约定下次渡河再见。'
];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'specwriter-v011-flow-')), root = join(directory, 'book');
  initProject(root, '渡口的灯', { memoryBackend: 'local' });
  const project = new Project(root);
  project.workflow.adopt('作者采用渡口故事'); project.propose('opening', '开篇', 1, 3);
  project.workflow.authorize('opening', 1, 3, 'auto', '作者授权逐章审阅并接纳三章'); project.sync();
  t.after(() => { project.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, project };
}
function intent(project, root, chapter, work = 'opening') {
  project.workflow.seed(chapter, work);
  const path = join(root, project.workflow.intentPath(chapter, work));
  writeFileSync(path, JSON.stringify({ ...read(path), goal: '通过实际调查推进寻找姐姐的故事', scenes: ['核对渡口线索并决定下一步行动'] }));
  project.workflow.saveIntent(chapter, work);
}
function candidate(project, root, chapter, work = 'opening') {
  intent(project, root, chapter, work);
  const prepared = project.prepare(chapter, work);
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  const body = bodies[chapter - 1]; writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, work);
  const delta = extraction({ ...read(paths.delta), ...metadata, title: '渡口', summary: body, characters: [], key_events: [{ description: body, evidence: { quote: body } }] }, body);
  writeFileSync(paths.delta, JSON.stringify(delta));
  const review = assessment(read(paths.review), metadata, delta);
  review.memory_checks = project.reviewRequirements(chapter, work).memoryCheckBindings;
  review.intent_checks = intentChecks(read(paths.context).workflow.intent).map(check => ({ id: check.id, verdict: 'satisfied', evidenceQuotes: check.requiresQuote ? [body] : [], explanation: '本地夹具核对了渡口调查行动与当前章目标。' }));
  writeFileSync(paths.review, JSON.stringify(review));
  return { paths, body };
}
function completeCheck(project, id) {
  const report = project.lifecycle.draft(id);
  const row = report.history.chapters[0];
  const evidence = row ? [{ chapter: row.chapter, revision: row.revision, bodyHash: row.bodyHash, quote: project.store.revisions().find(item => item.id === row.revision).body }] : [];
  report.findings = report.questions.map(question => ({ questionId: question.id, checked: true,
    verdict: row ? 'supported' : 'not-applicable', conclusion: row ? '已核对所引渡口调查原文，保留其实际行动和信息范围。' : '没有已接纳历史，历史核查不适用；本章仍需按约定和正文审阅。',
    evidence, limitations: row ? ['夹具验证版本和流程，不证明所有历史疑点都已发现。'] : ['空历史不能支持已发生事件或不存在事件的结论。'] }));
  report.reviewed = true; report.reviewNotes = ['实际读取本地夹具中的原文；本测试只验证核查保存与推进边界。'];
  writeFileSync(join(project.root, 'specwriter/memory/tasks', id, 'draft.json'), JSON.stringify(report));
  return project.lifecycle.save(id);
}
const run = (root, ...args) => spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8', timeout: 30000 });

test('CLI work creation registers planning checks that block preparation until recorded', t => {
  const { root, project } = fixture(t);
  const created = run(root, 'propose', 'extra', '--title', '新范围', '--from', '1', '--to', '1');
  assert.equal(created.status, 0, created.stderr);
  const data = JSON.parse(created.stdout);
  assert.equal(data.memoryChecks.plan.stage, 'plan');
  assert.equal(data.memoryChecks.impact, null);
  project.workflow.authorize('extra', 1, 1, 'draft', '作者只授权本章草稿'); intent(project, root, 1, 'extra');
  assert.equal(project.resume('extra').stage, 'memory-check');
  assert.throws(() => project.prepare(1, 'extra'), /Memory check|Plan memory/);
  completeCheck(project, 'plan-extra');
  const context = project.prepare(1, 'extra');
  assert.ok(read(join(root, context.paths.context)).sources.some(source => source.kind === 'memory-check'));
  assert.equal(project.status().acceptedChapters, 0);
});

test('failed CLI revision retrieval leaves both plan and impact requests recoverable', t => {
  const { root, project } = fixture(t);
  for (let chapter = 1; chapter <= 3; chapter++) { candidate(project, root, chapter); project.commit(chapter, 'opening'); }
  // A missing index with auto-index disabled stops before any external model request.
  assert.equal(run(root, 'memory', 'configure', '--backend', 'microsoft-graphrag', '--auto-index', 'false').status, 0);
  const created = run(root, 'propose', 'repair-two', '--title', '返修第二章', '--from', '2', '--to', '2');
  assert.notEqual(created.status, 0);
  assert.equal(project.store.work('repair-two').fromChapter, 2);
  const tasks = project.lifecycle.list().filter(task => task.scope.workId === 'repair-two');
  assert.deepEqual(tasks.map(task => [task.id, task.stage, task.status, task.ready]), [
    ['impact-repair-two', 'impact', 'pending', false], ['plan-repair-two', 'plan', 'pending', false]
  ]);
  assert.throws(() => project.prepare(2, 'repair-two'), /Memory check|Plan memory/);
});

test('planning gates stop before GraphRAG calls and refreshed findings require chapter refresh', async t => {
  const { root, project } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening');
  project.propose('next', '第二章', 2, 2); project.workflow.authorize('next', 2, 2, 'auto', '作者授权第二章');
  intent(project, root, 2, 'next');
  await project.lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next' });
  let calls = 0;
  await assert.rejects(new WriterMemory(project, { index: async () => { calls++; }, query: async () => { calls++; } }).prepare(2, 'next'), /Memory check|Plan memory/);
  assert.equal(calls, 0);
  completeCheck(project, 'plan-next'); candidate(project, root, 2, 'next');
  const report = project.lifecycle.draft('plan-next'); report.reviewNotes.push('补充核对范围说明。');
  writeFileSync(join(root, 'specwriter/memory/tasks/plan-next/draft.json'), JSON.stringify(report)); project.lifecycle.save('plan-next');
  assert.throws(() => project.verify(2, 'next'), /Context is stale/);
});

test('review checks reuse chapter context and block acceptance when incomplete or draft-bound stale', async t => {
  const { root, project } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening');
  const input = candidate(project, root, 2);
  let calls = 0;
  const lifecycle = new MemoryLifecycle(project, async (query, options) => { calls++; return project.query(query, { at: options.at }); });
  const prepared = await lifecycle.prepare('review-opening-2', { stage: 'review', workId: 'opening', chapter: 2 });
  assert.equal(calls, 0);
  assert.equal(prepared.query.engine, 'context-reuse');
  assert.equal(project.resume('opening').stage, 'memory-check');
  assert.throws(() => project.commit(2, 'opening'), /Memory check/);
  completeCheck(project, 'review-opening-2');
  assert.throws(() => project.verify(2, 'opening'), /bind the current recorded memory check/);
  const review = read(input.paths.review); review.memory_checks = project.reviewRequirements(2, 'opening').memoryCheckBindings;
  writeFileSync(input.paths.review, JSON.stringify(review)); assert.equal(project.verify(2, 'opening').valid, true);
  writeFileSync(input.paths.draft, input.body + '她停在桥边。');
  assert.equal(project.lifecycle.ready('review-opening-2').ready, false);
  await lifecycle.prepare('review-opening-2', { stage: 'review', workId: 'opening', chapter: 2, refresh: true, retrieve: true });
  assert.equal(calls, 1);
  assert.equal(project.lifecycle.ready('review-opening-2').ready, false);
});

test('recap and finish CLI connect reviewed memory, canonical evidence and recoverable completion', async t => {
  const { root, project, directory } = fixture(t);
  for (let chapter = 1; chapter <= 3; chapter++) { candidate(project, root, chapter); project.commit(chapter, 'opening'); }
  const prepareAudit = (kind, id, args = []) => {
    const result = run(root, kind, 'prepare', id, ...args); assert.equal(result.status, 0, result.stderr);
    const prepared = JSON.parse(result.stdout); completeCheck(project, id);
    const report = project.audits.draft(id), row = project.store.revisions().find(item => item.chapter === report.scope.to);
    report.summary = { text: '阿宁核对渡口线索并接回姐姐。', evidence: [{ chapter: row.chapter, revision: row.id, quote: row.body }] };
    report.reviewed = true; report.reviewNotes = ['已阅读夹具三章，核对所引结尾与正式版本；不作文学质量保证。'];
    writeFileSync(prepared.draftPath, JSON.stringify(report));
    const saved = run(root, kind, 'save', id); assert.equal(saved.status, 0, saved.stderr);
    return JSON.parse(saved.stdout);
  };
  prepareAudit('recap', 'opening-recap', ['--from', '1', '--to', '3']);
  prepareAudit('finish', 'book-finish');
  const accepted = run(root, 'finish', 'accept', 'book-finish', '--reason', '作者确认本夹具短篇完结');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(project.status().storyAudits.value.completed, true);
  project.archive('opening'); assert.equal(project.resume().stage, 'finished');
  const versions = new BookVersions(root), checkpoint = versions.init(project);
  const restoredRoot = join(directory, 'restored'); versions.restore(checkpoint.checkpoint.commit, restoredRoot);
  const restored = new Project(restoredRoot);
  try {
    assert.equal(restored.status().storyAudits.value.completed, true);
    assert.ok(existsSync(join(restoredRoot, 'specwriter/memory/tasks/book-finish/current.json')));
  } finally { restored.close(); }
  project.propose('epilogue', '后记', 4, 4); project.workflow.authorize('epilogue', 4, 4, 'auto', '作者授权追加后记');
  candidate(project, root, 4, 'epilogue'); project.commit(4, 'epilogue');
  assert.equal(project.status().storyAudits.value.completed, false);
});

test('paused authors can review prepared material without advancing or calling GraphRAG', async t => {
  const { root, project } = fixture(t);
  candidate(project, root, 1); project.commit(1, 'opening'); candidate(project, root, 2);
  project.workflow.pause('opening', true, '作者暂停续写并审阅草稿');
  let calls = 0;
  const lifecycle = new MemoryLifecycle(project, async () => { calls++; throw new Error('Unexpected model call'); });
  await lifecycle.prepare('paused-review', { stage: 'review', workId: 'opening', chapter: 2 });
  completeCheck(project, 'paused-review');
  assert.equal(calls, 0); assert.equal(project.resume('opening').stage, 'paused');
  assert.throws(() => project.commit(2, 'opening'), /paused/);
});

test('restoring valid canon reports damaged audit artifacts without certifying completion', async t => {
  const { root, project, directory } = fixture(t);
  await project.lifecycle.prepare('plan-corrupted', { stage: 'plan', workId: 'opening' });
  writeFileSync(join(root, 'specwriter/memory/tasks/plan-corrupted/request.json'), '{invalid');
  assert.equal(project.doctor().healthy, true);
  assert.ok(project.doctor().warnings.some(warning => warning.includes('Lifecycle memory checks')));
  const versions = new BookVersions(root), checkpoint = versions.init(project), restoredRoot = join(directory, 'restored-warning');
  const result = versions.restore(checkpoint.checkpoint.commit, restoredRoot);
  assert.ok(result.warnings.some(warning => warning.includes('Lifecycle memory checks')));
  const restored = new Project(restoredRoot);
  try {
    assert.notEqual(restored.status().memoryChecks.error, null);
    assert.equal(restored.status().storyAudits.value.completed, false);
  } finally { restored.close(); }
});

test('CLI validates lifecycle options before creating tasks and installs thirteen complete skills', t => {
  const { root, project } = fixture(t);
  assert.equal(initProject(root).skills.length, 13);
  for (const name of ['specwriter-recap', 'specwriter-finish']) assert.ok(existsSync(join(root, '.agents/skills', name, 'references/lifecycle.md')));
  assert.notEqual(run(root, 'memory', 'check', 'prepare', 'wrong', '--stage', 'plan', '--work', 'opening', '--question', '甲', '--questions-file', 'missing').status, 0);
  assert.notEqual(run(root, 'finish', 'status', '--from', '1').status, 0);
  assert.notEqual(run(root, 'recap', 'prepare', 'missing-range').status, 0);
  assert.equal(project.lifecycle.list().length, 0);
});
