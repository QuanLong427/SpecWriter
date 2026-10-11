import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Project, initProject, hash } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t, to = 3) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-test-'));
  initProject(root, '青铜钥匙', { memoryBackend: 'local' });
  const project = new Project(root);
  project.propose('opening', '开篇', 1, to);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project };
}
const load = path => JSON.parse(readFileSync(path, 'utf8'));
function candidate(project, root, chapter, body, changes = {}, work = 'opening', options = {}) {
  const prepared = project.prepare(chapter, work, { query: '青铜钥匙', ...options });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, work);
  const delta = { ...load(paths.delta), ...metadata, title: `第${chapter}章`, summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body } }], ...changes };
  const review = { ...load(paths.review), chapter, contextHash: metadata.contextHash, draftHash: metadata.draftHash, reviewed: true };
  writeFileSync(paths.delta, JSON.stringify(delta, null, 2));
  writeFileSync(paths.review, JSON.stringify(review, null, 2));
  return { paths, delta, review, prepared };
}
const fact = (subject, predicate, object, quote, scope = 'world', holder = null) => ({ subject, predicate, object, scope, holder, evidence: { quote } });
const change = (entity, field, old_value, new_value, quote) => ({ entity, field, old_value, new_value, reason: null, scope: 'world', holder: null, evidence: { quote } });

test('init preserves author files and modified skills on repeated installation', t => {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-test-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'AGENTS.md'), '# Existing project rules\n');
  const result = initProject(root, '我的小说');
  assert.equal(result.skills.length, 7);
  const skill = join(root, '.agents/skills/specwriter-write/SKILL.md');
  writeFileSync(skill, 'custom author skill');
  const premise = join(root, 'specwriter/specs/premise.md');
  writeFileSync(premise, '# Author premise');
  const again = initProject(root, '另一个名字');
  assert.ok(again.preserved.includes('.agents/skills/specwriter-write/SKILL.md'));
  assert.equal(readFileSync(skill, 'utf8'), 'custom author skill');
  assert.equal(readFileSync(premise, 'utf8'), '# Author premise');
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Existing project rules'));
  assert.equal(agents.match(/<!-- specwriter:start -->/g).length, 1);
  assert.ok(readFileSync(join(root, 'specwriter/config.yaml'), 'utf8').includes('我的小说'));
});

test('Codex preparation, evidence commit and cross-session recovery work end to end', t => {
  const { root, project } = fixture(t);
  const body = '林舟在废井中捡到青铜钥匙。';
  candidate(project, root, 1, body, { facts: [fact('青铜钥匙', '持有者', '林舟', body)] });
  assert.equal(project.memory().facts.length, 0); // Drafts do not enter memory.
  assert.equal(project.verify(1, 'opening').valid, true);
  const result = project.commit(1, 'opening');
  assert.equal(result.projectionNeedsSync, false);
  assert.equal(project.status().memoryThrough, 1);
  assert.equal(project.status().pending.length, 0);
  const nextSession = new Project(root);
  try {
    assert.equal(nextSession.status().nextChapter, 2);
    const retrieved = nextSession.query('青铜钥匙');
    assert.ok(retrieved.facts.some(item => item.object === '林舟'));
    assert.ok(retrieved.passages.some(item => item.excerpt.includes('青铜钥匙')));
    const context = nextSession.prepare(2, 'opening', { query: '青铜钥匙' });
    assert.equal(load(join(root, context.paths.context)).memory.atChapter, 1);
  } finally { nextSession.close(); }
  assert.equal(project.doctor().healthy, true);
});

test('chapter filters exclude future facts, summaries, original text and future hook resolutions', t => {
  const { root, project } = fixture(t);
  const one = '林舟发现青铜钥匙，锁上的门仍未打开。';
  candidate(project, root, 1, one, { foreshadow_updates: [{ id: 'locked-door', action: 'plant', description: '钥匙能打开什么门', evidence: { quote: one } }] });
  project.commit(1, 'opening');
  const two = '林舟用青铜钥匙打开石门，发现师父就是凶手。';
  candidate(project, root, 2, two, { facts: [fact('师父', '身份', '凶手', two)], foreshadow_updates: [{ id: 'locked-door', action: 'resolve', description: null, evidence: { quote: two } }] });
  project.commit(2, 'opening');
  const early = project.query('师父 凶手 青铜钥匙', { at: 1 });
  assert.ok(!early.facts.some(item => item.object === '凶手'));
  assert.ok(early.passages.every(item => item.chapter <= 1));
  assert.equal(project.memory(1).hooks[0].status, 'open');
  assert.equal(project.memory(1).summaries.length, 1);
  project.propose('revise-one', '改第一章', 1, 1);
  const prepared = project.prepare(1, 'revise-one');
  const context = load(join(root, prepared.paths.context));
  assert.equal(context.memory.atChapter, 0);
  assert.ok(context.sources.filter(item => item.kind === 'prose').every(item => item.chapter < 1));
});

test('world facts and character beliefs stay separate in graph retrieval', t => {
  const { root, project } = fixture(t);
  const body = '林舟误以为师父已死，师父其实躲在山洞里。';
  candidate(project, root, 1, body, { facts: [fact('师父', '状态', '已死', body, 'belief', '林舟'), fact('师父', '状态', '活着', body)] });
  project.commit(1, 'opening');
  const world = project.query('师父');
  assert.ok(world.facts.every(item => item.scope === 'world'));
  assert.ok(project.query('师父', { holder: '林舟' }).facts.some(item => item.scope === 'belief'));
});

test('bounded context retains relevant old facts while complete memory and index stay recoverable', t => {
  const { root, project } = fixture(t);
  const body = '林舟在废井发现青铜钥匙，同时看见许多石碑。';
  const facts = Array.from({ length: 180 }, (_, index) => fact(`石碑${index}`, '文字', `一段用于测试上下文预算的铭文${index}`, body));
  facts.push(fact('青铜钥匙', '持有者', '林舟', body));
  candidate(project, root, 1, body, { facts }); project.commit(1, 'opening');
  const prepared = project.prepare(2, 'opening', { query: '青铜钥匙', budget: 16000 });
  const context = load(join(root, prepared.paths.context));
  assert.ok(context.selectedChars <= 16000);
  assert.ok(context.memorySelection.selectedFacts < context.memorySelection.totalActiveFacts);
  assert.ok(context.memory.facts.some(item => item.subject === '青铜钥匙'));
  assert.equal(project.memory().facts.length, 181);
  const before = project.query('青铜钥匙').passages.map(item => item.excerpt);
  project.rebuildSearch();
  assert.deepEqual(project.query('青铜钥匙').passages.map(item => item.excerpt), before);
});

test('nonexistent quotes and unknown fields are rejected without accepting prose', t => {
  const { root, project } = fixture(t);
  const input = candidate(project, root, 1, '林舟找到青铜钥匙。', { facts: [fact('林舟', '位置', '山洞', '不存在的证据')] });
  assert.throws(() => project.commit(1, 'opening'), /Evidence quote/);
  assert.equal(project.status().acceptedChapters, 0);
  input.delta.facts = [];
  input.delta.unknown = true;
  writeFileSync(input.paths.delta, JSON.stringify(input.delta));
  assert.throws(() => project.verify(1, 'opening'), /additional properties/);
});

test('changed drafts, blocking issues and altered context cannot be accepted', t => {
  const { root, project } = fixture(t);
  let input = candidate(project, root, 1, '林舟找到青铜钥匙。');
  writeFileSync(input.paths.draft, '林舟没有找到青铜钥匙。');
  assert.throws(() => project.commit(1, 'opening'), /Evidence quote|different context or draft/);
  input = candidate(project, root, 1, '林舟找到青铜钥匙。');
  input.review.issues = [{ id: 'contradiction', kind: 'continuity', severity: 'blocking', description: '与明确规则矛盾', resolved: false }];
  writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.commit(1, 'opening'), /Unresolved blocking/);
  input.review.issues = [];
  writeFileSync(input.paths.review, JSON.stringify(input.review));
  const context = load(input.paths.context);
  context.memory.facts.push({ subject: '伪造' });
  writeFileSync(input.paths.context, JSON.stringify(context));
  assert.throws(() => project.commit(1, 'opening'), /stale or modified/);
  assert.equal(project.status().acceptedChapters, 0);
});

test('spec changes invalidate context; refresh preserves prose and resets extraction/review', t => {
  const { root, project } = fixture(t);
  const input = candidate(project, root, 1, '林舟找到青铜钥匙。');
  writeFileSync(join(root, 'specwriter/specs/world.md'), '# 主角不能复活\n');
  assert.throws(() => project.verify(1, 'opening'), /stale or modified/);
  assert.throws(() => project.prepare(1, 'opening', { query: '青铜钥匙' }), /--refresh/);
  project.prepare(1, 'opening', { query: '青铜钥匙', refresh: true });
  assert.equal(readFileSync(input.paths.draft, 'utf8'), '林舟找到青铜钥匙。');
  assert.equal(load(input.paths.delta).title, '');
  assert.equal(load(input.paths.review).reviewed, false);
});

test('state preconditions and chapter time history are enforced', t => {
  const { root, project } = fixture(t);
  const one = '林舟来到废井。';
  candidate(project, root, 1, one, { state_changes: [change('林舟', '位置', null, '废井', one)] });
  project.commit(1, 'opening');
  const two = '林舟从废井走到山洞。';
  const input = candidate(project, root, 2, two, { state_changes: [change('林舟', '位置', '错误位置', '山洞', two)] });
  assert.throws(() => project.commit(2, 'opening'), /precondition/);
  input.delta.state_changes[0].old_value = '废井';
  writeFileSync(input.paths.delta, JSON.stringify(input.delta));
  project.commit(2, 'opening');
  assert.equal(project.query('林舟', { at: 1 }).facts.find(item => item.predicate === '位置').object, '废井');
  assert.equal(project.query('林舟', { at: 2 }).facts.find(item => item.predicate === '位置').object, '山洞');
  assert.ok(project.memory(2).facts.some(item => item.object === '废井' && item.validUntilChapter === 2));
});

test('revising an earlier chapter invalidates later memory and supports sequential reconciliation', t => {
  const { root, project } = fixture(t);
  const one = '林舟来到废井。';
  candidate(project, root, 1, one, { facts: [fact('林舟', '发现', '废井', one)] });
  project.commit(1, 'opening');
  const two = '林舟在废井找到钥匙。';
  candidate(project, root, 2, two, { facts: [fact('钥匙', '持有者', '林舟', two)] });
  project.commit(2, 'opening');
  project.propose('revision', '修订开篇', 1, 1);
  const newOne = '林舟来到废井，听见有人呼救。';
  candidate(project, root, 1, newOne, { facts: [fact('林舟', '听见', '呼救', newOne)] }, 'revision');
  const result = project.commit(1, 'revision');
  assert.equal(result.projectionNeedsSync, false);
  assert.deepEqual(result.staleChapters, [2]);
  assert.equal(project.status().memoryThrough, 1);
  assert.ok(!project.memory().facts.some(item => item.subject === '钥匙'));
  assert.throws(() => project.query('钥匙', { at: 2 }), /beyond reconciled/);
  assert.throws(() => project.prepare(3, 'opening'), /Prepare chapter 2/);
  candidate(project, root, 2, two, { facts: [fact('钥匙', '持有者', '林舟', two)] }, 'opening', { refresh: true });
  project.commit(2, 'opening');
  assert.equal(project.status().memoryThrough, 2);
  assert.equal(project.store.history(1).length, 2);
  assert.equal(project.store.history(2).length, 2);
  assert.ok(!project.query('呼救').passages.some(item => item.excerpt === one));
  assert.ok(project.query('呼救').passages.some(item => item.excerpt.includes('呼救')));
});

test('direct edits are preserved before canonical prose is restored', t => {
  const { root, project } = fixture(t);
  const original = '林舟来到废井。';
  candidate(project, root, 1, original); project.commit(1, 'opening');
  const path = join(root, 'manuscript/chapters/0001.md');
  const edit = '作者直接修改了这一章。';
  writeFileSync(path, edit);
  assert.throws(() => project.sync(), /Direct edits/);
  assert.throws(() => project.prepare(2, 'opening'), /projection differs/);
  assert.equal(readFileSync(path, 'utf8'), edit);
  const result = project.sync({ capture: true });
  assert.equal(readFileSync(join(root, result.captured[0]), 'utf8'), edit);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(project.store.history(1).length, 1);
});

test('SQLite rollback leaves neither accepted chapter nor generation change', t => {
  const { root, project } = fixture(t);
  candidate(project, root, 1, '林舟来到废井。');
  const accept = project.store.accept.bind(project.store);
  project.store.accept = (...args) => { accept(...args); throw new Error('simulated interrupted transaction'); };
  assert.throws(() => project.commit(1, 'opening'), /simulated/);
  assert.equal(project.store.generation(), 0);
  assert.equal(project.store.history(1).length, 0);
  assert.equal(project.status().acceptedChapters, 0);
});

test('accepted DB commit survives projection failure and sync recovers without duplicate acceptance', t => {
  const { root, project } = fixture(t);
  candidate(project, root, 1, '林舟来到废井。');
  const sync = project.sync.bind(project);
  project.sync = () => { throw new Error('simulated disk projection failure'); };
  const result = project.commit(1, 'opening');
  assert.equal(result.projectionNeedsSync, true);
  assert.equal(project.store.history(1).length, 1);
  project.sync = sync;
  project.sync();
  assert.equal(project.status().dirtyFiles.length, 0);
  assert.equal(project.status().projectionNeedsSync, false);
});

test('failed projection of a revised chapter restores its previous accepted projection safely', t => {
  const { root, project } = fixture(t);
  candidate(project, root, 1, '林舟来到废井。'); project.commit(1, 'opening');
  project.propose('revision', '修改第一章', 1, 1);
  candidate(project, root, 1, '林舟来到石桥。', {}, 'revision');
  const sync = project.sync.bind(project);
  project.sync = () => { throw new Error('disk failure'); };
  project.commit(1, 'revision'); project.sync = sync;
  assert.equal(project.status().dirtyFiles[0].kind, 'outdated');
  assert.deepEqual(project.sync().captured, []);
  assert.equal(readFileSync(join(root, 'manuscript/chapters/0001.md'), 'utf8'), '林舟来到石桥。');
});

test('archive requires completed chapters, keeps a historical snapshot and never promotes plans', t => {
  const { root, project } = fixture(t, 1);
  assert.throws(() => project.archive('opening'), /incomplete/);
  writeFileSync(join(root, 'specwriter/plans/outline.md'), '第十章主角会成为皇帝。');
  candidate(project, root, 1, '林舟来到废井。'); project.commit(1, 'opening');
  const generation = project.store.generation();
  project.archive('opening');
  assert.equal(project.store.generation(), generation);
  assert.ok(!project.memory().facts.some(item => item.object.includes('皇帝')));
  const snapshot = join(root, 'specwriter/archive/opening/tasks.md');
  const before = readFileSync(snapshot, 'utf8');
  assert.ok(before.includes('archived'));
  project.propose('revision', '修改第一章', 1, 1);
  candidate(project, root, 1, '林舟来到石桥。', {}, 'revision'); project.commit(1, 'revision');
  assert.equal(readFileSync(snapshot, 'utf8'), before);
  assert.throws(() => project.prepare(1, 'opening'), /archived/);
});

test('work identifiers, chapter gaps and symlinks cannot escape the workspace', t => {
  const { root, project } = fixture(t);
  assert.throws(() => project.propose('../escape', 'Escape', 1, 1), /portable/);
  assert.throws(() => project.propose('con', 'Escape', 1, 1), /portable/);
  assert.throws(() => project.prepare(2, 'opening'), /Prepare chapter 1/);
  const outside = mkdtempSync(join(tmpdir(), 'specwriter-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const link = join(root, 'specwriter/specs/link');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => project.prepare(1, 'opening'), /Linked/);
});

test('CLI and generated launcher accept paths with spaces and report machine-readable failures', t => {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-cli space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync(process.execPath, [cli, 'init', root, '--name', 'CLI 小说', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).skills.length, 7);
  const launcher = join(root, '.specwriter/bin/specwriter.mjs');
  const result = spawnSync(process.execPath, [launcher, 'status', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).nextChapter, 1);
  const wrong = spawnSync(process.execPath, [cli, 'prepare', '1', '--root', root, '--unknown', 'value', '--json'], { encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  const errorLine = wrong.stderr.split('\n').find(line => line.startsWith('{'));
  assert.match(JSON.parse(errorLine).error, /Unsupported option/);
});
