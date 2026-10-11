import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Project, NovelReader, initProject, startReader } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v05-'));
  initProject(root, '井底的来信', { memoryBackend: 'local', workflow: 'legacy' });
  const project = new Project(root); project.propose('opening', '开篇', 1, 4);
  t.after(() => {
    project.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, project };
}
function candidate(project, root, chapter, body, changes = {}, refresh = false) {
  const prepared = project.prepare(chapter, 'opening', { query: '林舟', refresh });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, path]) => [key, join(root, path)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, 'opening');
  const delta = extraction({ ...load(paths.delta), ...metadata, title: '来信', summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body } }], ...changes }, body);
  const review = assessment(load(paths.review), metadata, delta);
  writeFileSync(paths.delta, JSON.stringify(delta)); writeFileSync(paths.review, JSON.stringify(review));
  return { paths, delta, review };
}
const entity = (id, name, quote, aliases = []) => ({ id, name, aliases, type: 'character', description: name, evidence: { quote } });
const state = (name, old_value, new_value, quote) => ({ entity: name, field: '位置', old_value, new_value, reason: null, scope: 'world', holder: null, evidence: { quote } });
const resource = (name, opening, change, closing, quote) => ({ entity: name, resource: '灵石', opening, change, closing, evidence: { quote } });

test('stable identity prevents alias/rename state and resource splits; holder aliases query the same belief', t => {
  const { root, project } = fixture(t);
  const one = '林舟又叫小舟，站在城门，有十枚灵石。他相信师父活着。';
  candidate(project, root, 1, one, { entities: [entity('lin-zhou', '林舟', one, ['小舟'])], state_changes: [state('林舟', null, '城门', one)], resource_changes: [resource('林舟', 0, 10, 10, one)], facts: [{ subject: '师父', predicate: '生死', object: '活着', scope: 'belief', holder: '小舟', evidence: { quote: one } }] });
  project.commit(1, 'opening');
  const two = '小舟从城门来到客栈，花掉三枚灵石，还剩七枚。';
  let input = candidate(project, root, 2, two, { state_changes: [state('小舟', null, '客栈', two)] });
  assert.throws(() => project.verify(2, 'opening'), /State already exists/);
  input = candidate(project, root, 2, two, { state_changes: [state('小舟', '城门', '客栈', two)], resource_changes: [resource('小舟', 10, -3, 7, two)] });
  project.commit(2, 'opening');
  assert.deepEqual(project.memory().facts.filter(item => item.predicate === '位置' && item.validUntilChapter === null).map(item => [item.subject, item.object]), [['lin-zhou', '客栈']]);
  assert.deepEqual(project.memory().resources.map(item => [item.entity, item.amount]), [['lin-zhou', 7]]);
  assert.ok(project.query('师父', { holder: '小舟' }).facts.some(item => item.scope === 'belief'));
  assert.ok(project.query('师父', { holder: '林舟' }).facts.some(item => item.scope === 'belief'));
  const three = '小舟宣布自己的真名是周临，从客栈走到码头。';
  candidate(project, root, 3, three, { entities: [entity('lin-zhou', '周临', three)], state_changes: [state('周临', '客栈', '码头', three)] });
  project.commit(3, 'opening');
  assert.equal(project.memory().facts.filter(item => item.predicate === '位置' && item.validUntilChapter === null).length, 1);
  assert.equal(project.memory(1).entities[0].name, '林舟');
  assert.ok(project.memory().entities[0].aliases.includes('小舟'));
});

test('ambiguous names and duplicate operations through two aliases cannot bypass state guards', t => {
  const { root, project } = fixture(t), body = '林舟又叫小舟，白衡也被叫作小舟，两人在城门相遇。';
  candidate(project, root, 1, body, { entities: [entity('lin-zhou', '林舟', body, ['小舟']), entity('bai-heng', '白衡', body, ['小舟'])], state_changes: [state('小舟', null, '城门', body)] });
  assert.throws(() => project.commit(1, 'opening'), /Ambiguous entity/);
  candidate(project, root, 1, body, { entities: [entity('lin-zhou', '林舟', body, ['小舟'])], state_changes: [state('林舟', null, '城门', body), state('小舟', '城门', '客栈', body)] }, true);
  assert.throws(() => project.commit(1, 'opening'), /Duplicate state/);
  assert.equal(project.status().acceptedChapters, 0);
});

test('changed chapter intent invalidates prepared context and review; refresh preserves author prose', t => {
  const { root, project } = fixture(t), body = '林舟收到来信。';
  const input = candidate(project, root, 1, body);
  writeFileSync(input.paths.intent, '# 作者改了章纲\n来信只能被当作传闻。');
  assert.equal(project.status().pending[0].needsRefresh, true);
  assert.throws(() => project.verify(1, 'opening'), /stale or modified/);
  assert.throws(() => project.commit(1, 'opening'), /stale or modified/);
  candidate(project, root, 1, body, {}, true);
  assert.equal(readFileSync(input.paths.draft, 'utf8'), body);
  assert.equal(project.verify(1, 'opening').valid, true);
});

test('reported conclusions stay beliefs; V2 assessments and exact repeated quote offsets are required', t => {
  const { root, project } = fixture(t), body = '林舟听说师父死了，但他不相信。\n\n林舟回头。\n\n林舟回头。';
  const input = candidate(project, root, 1, body, { facts: [{ subject: '师父', predicate: '生死', object: '已死', scope: 'world', holder: null, evidence: { quote: '林舟听说师父死了，但他不相信。', basis: 'reported' } }] });
  assert.throws(() => project.verify(1, 'opening'), /cannot establish a world/);
  input.delta.facts[0].scope = 'belief'; input.delta.facts[0].holder = '村民';
  writeFileSync(input.paths.delta, JSON.stringify(input.delta));
  input.review.checks.coverage.checked = false; writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /Review check coverage/);
  input.review.checks.coverage.checked = true; input.review.checks.evidence.notes = []; writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /Review check evidence/);
  input.review.checks.evidence.notes = ['核对传闻的持有者，未当作师父真实死亡。']; writeFileSync(input.paths.review, JSON.stringify(input.review));
  input.delta.key_events = [{ description: '回头', evidence: { quote: '林舟回头。', basis: 'established' } }]; writeFileSync(input.paths.delta, JSON.stringify(input.delta));
  assert.throws(() => project.verify(1, 'opening'), /Repeated evidence/);
  input.delta.key_events[0].evidence.start = body.lastIndexOf('林舟回头。'); input.delta.key_events[0].evidence.end = body.length;
  writeFileSync(input.paths.delta, JSON.stringify(input.delta));
  writeFileSync(input.paths.review, JSON.stringify(assessment(input.review, project.hashes(1, 'opening'), input.delta)));
  project.commit(1, 'opening');
  assert.equal(project.query('师父').facts.length, 0);
  assert.ok(project.query('师父', { holder: '村民' }).facts.some(item => item.object === '已死'));
  assert.equal(project.memory().episodes[0].evidenceLine, 5);
});

test('accepted V1 history replays unchanged, but new preparation cannot downgrade its contract', t => {
  const { root, project } = fixture(t), one = '林舟又叫小舟，站在城门。';
  const input = candidate(project, root, 1, one, { entities: [entity('lin-zhou', '林舟', one, ['小舟'])], state_changes: [state('林舟', null, '城门', one)] });
  input.delta.schemaVersion = 1; delete input.delta.intentHash;
  input.review.schemaVersion = 1; delete input.review.intentHash; delete input.review.checks;
  writeFileSync(input.paths.delta, JSON.stringify(input.delta)); writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /V2 extraction\/review/);
  // Simulate a historical V1 revision already accepted by v0.4, without rewriting its payload.
  project.store.transaction(() => project.store.accept(one, input.delta, input.review, load(input.paths.context), 'opening')); project.sync();
  assert.equal(project.memory(1).facts[0].subject, '林舟');
  candidate(project, root, 2, '小舟从城门来到客栈。', { state_changes: [state('小舟', '城门', '客栈', '小舟从城门来到客栈。')] });
  project.commit(2, 'opening');
  assert.equal(project.memory().facts.filter(item => item.validUntilChapter === null)[0].subject, 'lin-zhou');
  assert.equal(project.doctor().healthy, true);
});

test('reader preferences survive server restart on another origin, remain scoped, and do not mutate memory', async t => {
  const { root, project } = fixture(t); candidate(project, root, 1, '林舟收到来信。'); project.commit(1, 'opening');
  const reader = new NovelReader(project), chapter = reader.chapter('accepted:1');
  const first = await startReader(project);
  const token = /name="reader-token" content="([a-f0-9]+)"/.exec(await (await fetch(first.url)).text())[1];
  const headers = { 'X-Reader-Token': token, 'Content-Type': 'application/json' };
  const patch = { settings: { font: 24, leading: 2.35, theme: 'dark' }, positions: { accepted: { key: chapter.key, bodyHash: chapter.bodyHash, ratio: .65 } } };
  assert.equal((await fetch(first.url + '/api/preferences', { method: 'POST', headers, body: JSON.stringify(patch) })).status, 200);
  assert.equal((await fetch(first.url + '/api/preferences')).status, 403);
  await first.close();
  const second = await startReader(project); t.after(() => second.close());
  const nextToken = /name="reader-token" content="([a-f0-9]+)"/.exec(await (await fetch(second.url)).text())[1];
  const restored = await (await fetch(second.url + '/api/preferences', { headers: { 'X-Reader-Token': nextToken } })).json();
  assert.deepEqual(restored.settings, patch.settings); assert.deepEqual(restored.positions, patch.positions);
  assert.throws(() => reader.savePreferences({ positions: { '../escape': patch.positions.accepted } }), /Invalid reading position/);
  assert.throws(() => reader.savePreferences({ settings: { ...patch.settings, font: 1000 } }), /Invalid reader settings/);
  assert.equal(project.store.generation(), 1); assert.equal(project.store.history(1).length, 1);
});
