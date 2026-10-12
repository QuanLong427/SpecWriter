import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Project, NovelReader, initProject, intentChecks } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
function book(t, to = 2, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v09-lifecycle-'));
  initProject(root, '渡口旧灯', { memoryBackend: 'local', ...(legacy ? { workflow: 'legacy' } : {}) });
  const project = new Project(root);
  project.propose('opening', '开篇', 1, to);
  if (!legacy) { project.workflow.adopt('作者采用故事约定'); project.workflow.authorize('opening', 1, to, 'auto', '作者授权开篇'); }
  t.after(() => { project.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\')); rmSync(root, { recursive: true, force: true }); });
  return { root, project };
}
function intent(project, root, chapter, work = 'opening') {
  if (!project.workflow.structured) return;
  project.workflow.seed(chapter, work);
  const path = join(root, project.workflow.intentPath(chapter, work));
  writeFileSync(path, JSON.stringify({ ...load(path), goal: '按作者章纲寻找旧灯的线索', scenes: ['查看渡口并推动旧灯线索'] }));
  project.workflow.saveIntent(chapter, work);
}
function candidate(project, root, chapter, body, work = 'opening', refresh = false) {
  intent(project, root, chapter, work);
  const result = project.prepare(chapter, work, { refresh, query: '旧灯' });
  const paths = Object.fromEntries(Object.entries(result.paths).map(([key, path]) => [key, join(root, path)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, work);
  const delta = extraction({ ...load(paths.delta), ...metadata, title: '旧灯', summary: body, characters: [], key_events: [{ description: body, evidence: { quote: body } }] }, body);
  const review = assessment(load(paths.review), metadata, delta), context = load(paths.context);
  if (context.workflow) review.intent_checks = intentChecks(context.workflow.intent).map(item => ({ id: item.id, verdict: 'satisfied', evidenceQuotes: item.requiresQuote ? [body] : [], explanation: 'Static fixture assertion, not a model quality evaluation.' }));
  writeFileSync(paths.delta, JSON.stringify(delta)); writeFileSync(paths.review, JSON.stringify(review));
  return paths;
}
function accept(project, root, chapter, work = 'opening', refresh = false) {
  candidate(project, root, chapter, `第${chapter}夜，阿宁在渡口找到旧灯的线索。`, work, refresh);
  project.commit(chapter, work);
}
function reviseWork(project, id = 'revision', from = 1, to = 1) {
  project.propose(id, '修订已接纳章节', from, to);
  if (project.workflow.structured) project.workflow.authorize(id, from, to, 'auto', '作者授权修订');
}

test('historical revision work remains unfinished before preparation and after draft review', t => {
  const { project, root } = book(t);
  accept(project, root, 1); accept(project, root, 2);
  assert.equal(project.resume('opening').stage, 'complete');
  reviseWork(project);
  assert.equal(project.resume('revision').chapter, 1);
  assert.equal(project.resume('revision').stage, 'intent');
  assert.equal(project.workProgress('revision')[0].completed, false);
  assert.ok(readFileSync(join(root, 'specwriter/work/revision/tasks.md'), 'utf8').includes('- [ ] 第 1 章'));
  assert.throws(() => project.archive('revision'), /incomplete work/);
  intent(project, root, 1, 'revision');
  assert.equal(project.resume('revision').stage, 'prepare');
  project.prepare(1, 'revision');
  assert.equal(project.resume('revision').stage, 'extract'); // Existing canonical body is seeded, extraction still required.
  assert.equal(project.status().pending.find(item => item.workId === 'revision').chapter, 1);
  candidate(project, root, 1, '第一夜，阿宁在渡口找到旧灯，并听见姐姐的呼唤。', 'revision', true);
  assert.equal(project.resume('revision').stage, 'commit');
  assert.throws(() => project.archive('revision'), /incomplete work/);
  project.commit(1, 'revision');
  assert.equal(project.resume('revision').stage, 'complete');
  assert.equal(project.status().pending.some(item => item.workId === 'revision'), false);
  assert.equal(project.archive('revision').status, 'archived');
});

test('later work does not erase original completion, while stale dependencies need reconciliation', t => {
  const { project, root } = book(t);
  accept(project, root, 1); accept(project, root, 2);
  reviseWork(project);
  accept(project, root, 1, 'revision');
  assert.equal(project.workProgress('opening')[0].completed, true);
  assert.equal(project.workProgress('opening')[1].completed, false);
  assert.equal(project.resume('opening').chapter, 2);
  assert.throws(() => project.archive('opening'), /incomplete work/);
  reviseWork(project, 'reconcile', 2, 2);
  accept(project, root, 2, 'reconcile');
  assert.ok(project.store.revisions().every(item => item.workId !== 'opening'));
  assert.equal(project.resume('opening').stage, 'complete');
  project.sync();
  assert.equal((readFileSync(join(root, 'specwriter/work/opening/tasks.md'), 'utf8').match(/\[x\]/g) ?? []).length, 2);
  assert.equal(project.archive('opening').status, 'archived');
});

test('changed accepted work artifacts stay pending and prevent archive even when another work accepted the chapter', t => {
  const { project, root } = book(t, 1);
  accept(project, root, 1);
  reviseWork(project); accept(project, root, 1, 'revision');
  assert.equal(project.resume('opening').stage, 'complete');
  const paths = project.chapterPaths('opening', 1);
  writeFileSync(join(root, paths.draft), '阿宁改走了另一条路，旧灯也没有出现。');
  assert.equal(project.workProgress('opening')[0].pending, true);
  assert.equal(project.status().pending.find(item => item.workId === 'opening').stage, 'draft');
  assert.notEqual(project.resume('opening').stage, 'complete');
  assert.throws(() => project.archive('opening'), /pending candidate/);
});

test('legacy work acceptance history survives removed historical files and schema migration', t => {
  const { project, root } = book(t, 1, true);
  accept(project, root, 1);
  const paths = project.chapterPaths('opening', 1);
  for (const path of Object.values(paths)) rmSync(join(root, path), { force: true });
  project.store.db.exec("DROP TABLE work_policy; DROP TABLE story_contract; UPDATE meta SET value='2' WHERE key='schemaVersion';");
  const migrated = new Project(root);
  try {
    reviseWork(migrated); accept(migrated, root, 1, 'revision');
    assert.equal(migrated.resume('opening').stage, 'complete');
    assert.equal(migrated.store.workRevisions('opening').length, 1);
    assert.equal(migrated.archive('opening').status, 'archived');
  } finally { migrated.close(); }
});

test('backdated contract adoption preserves prose but excludes all affected chapters from memory and exports', t => {
  const { project, root } = book(t, 3);
  for (const chapter of [1, 2, 3]) accept(project, root, chapter);
  const old = project.workflow.contract(1), bodies = project.store.revisions().map(item => item.body);
  writeFileSync(join(root, 'specwriter/specs/world.md'), '# 作者新的故事约定\n旧灯只能在雨中点亮。');
  const adopted = project.workflow.adopt('作者从第二章回溯采用雨灯设定', 2);
  assert.deepEqual(adopted.staleChapters, [2, 3]);
  assert.equal(adopted.projectionNeedsSync, false);
  assert.equal(project.workflow.contract(1).id, old.id);
  assert.deepEqual(project.store.revisions().map(item => item.body), bodies);
  assert.equal(project.status().memoryThrough, 1);
  assert.deepEqual(project.corpus().documents.map(item => item.chapter), [1]);
  assert.ok(project.query('旧灯').passages.every(item => item.chapter <= 1));
  assert.throws(() => project.query('旧灯', { at: 2 }), /beyond reconciled/);
  const reader = new NovelReader(project);
  assert.deepEqual(reader.catalog().chapters.map(item => item.status), ['accepted', 'stale', 'stale']);
  const exported = reader.export('txt');
  assert.ok(!exported.content.includes('第2夜') && !exported.content.includes('第3夜'));
  assert.throws(() => project.prepare(3, 'opening', { refresh: true }), /Prepare chapter 2/);
  assert.equal(project.resume('opening').chapter, 2);
  writeFileSync(join(root, 'specwriter/specs/style.md'), '# 未来文风\n每章结尾留下一处清楚的疑问。');
  const future = project.workflow.adopt('作者将新文风用于尚未写的章节');
  assert.equal(future.adopted.fromChapter, 4);
  assert.deepEqual(future.staleChapters, []);
  assert.deepEqual(project.status().staleChapters, [2, 3]);
  assert.equal(project.workflow.contract(2).id, adopted.adopted.id);
  accept(project, root, 2, 'opening', true); accept(project, root, 3, 'opening', true);
  assert.equal(project.resume('opening').stage, 'complete');
  assert.equal(project.status().memoryThrough, 3);
  const generation = project.store.generation();
  const reused = project.workflow.adopt('作者将新文风用于尚未写的章节', 4);
  assert.equal(reused.reused, true); assert.equal(project.store.generation(), generation); assert.deepEqual(project.status().staleChapters, []);
});

test('default future adoption preserves accepted prefix; explicit adoption from one blocks all historical recall', t => {
  const { project, root } = book(t, 1);
  accept(project, root, 1);
  writeFileSync(join(root, 'specwriter/specs/style.md'), '# 新文风\n减少长句。');
  const future = project.workflow.adopt('作者从下一章采用新文风');
  assert.equal(future.adopted.fromChapter, 2); assert.deepEqual(future.staleChapters, []);
  assert.equal(project.status().memoryThrough, 1); assert.equal(project.resume('opening').stage, 'complete');
  const retro = project.workflow.adopt('作者要求第一章也按新文风重审', 1);
  assert.deepEqual(retro.staleChapters, [1]);
  assert.equal(project.corpus().documents.length, 0); assert.equal(project.query('旧灯').passages.length, 0);
  assert.equal(project.resume('opening').chapter, 1); assert.notEqual(project.resume('opening').stage, 'complete');
});
