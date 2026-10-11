import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project, WriterMemory, BookVersions, initProject, loadConfig, configureMemory, intentChecks, requiredMemory } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
function book(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'specwriter-v08-')), root = join(directory, 'book');
  initProject(root, '渡口的灯', { memoryBackend: 'local', ...options });
  const project = new Project(root); project.propose('opening', '开篇', 1, 3);
  t.after(() => { project.close(); assert.ok(directory.startsWith(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  return { root, directory, project };
}
function ready(project, mode = 'auto') {
  project.workflow.adopt('作者采用渡口故事'); project.sync();
  project.workflow.authorize('opening', 1, 3, mode, '作者授权开篇三章');
}
function intent(project, root, chapter, changes = {}) {
  project.workflow.seed(chapter, 'opening');
  const path = join(root, project.workflow.intentPath(chapter, 'opening'));
  writeFileSync(path, JSON.stringify({ ...load(path), goal: '灯的线索推动渡口故事', scenes: ['查看渡口并选择下一步行动'], ...changes }));
  return project.workflow.saveIntent(chapter, 'opening');
}
function candidate(project, root, chapter, body, changes = {}, refresh = false) {
  const prepared = project.prepare(chapter, 'opening', { refresh });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, path]) => [key, join(root, path)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, 'opening');
  const delta = extraction({ ...load(paths.delta), ...metadata, title: '渡口', summary: body, characters: [], key_events: [{ description: body, evidence: { quote: body } }], ...changes }, body);
  const context = load(paths.context), review = assessment(load(paths.review), metadata, delta);
  // Fixture protocol assertions only; this is not a generated-novel semantic evaluation.
  review.intent_checks = intentChecks(context.workflow.intent).map(item => ({ id: item.id, verdict: 'satisfied', evidenceQuotes: item.requiresQuote ? [body] : [], explanation: `Hand-authored fixture assertion for ${item.id}; no model quality score.` }));
  writeFileSync(paths.delta, JSON.stringify(delta)); writeFileSync(paths.review, JSON.stringify(review));
  return { paths, delta, review, context };
}
const evidence = quote => ({ quote, basis: 'established' });
function foundation(project, root) {
  const body = '阿宁站在渡口，背着灯。她手里剩下八枚铜钱。她亲眼看见灯柄刻着三道缺口。';
  intent(project, root, 1, { participantIds: ['aning'], pov: 'aning', newEntities: [{ id: 'aning', name: '阿宁', type: 'character' }] });
  candidate(project, root, 1, body, { characters: ['阿宁'],
    entities: [{ id: 'aning', name: '阿宁', type: 'character', aliases: ['小宁'], description: '带灯来到渡口', evidence: evidence('阿宁站在渡口，背着灯。') }],
    state_changes: [{ entity: 'aning', field: '位置', old_value: null, new_value: '渡口', reason: null, scope: 'world', holder: null, evidence: evidence('阿宁站在渡口，背着灯。') }],
    facts: [{ subject: '灯柄', predicate: '缺口', object: '三道', scope: 'belief', holder: 'aning', evidence: evidence('她亲眼看见灯柄刻着三道缺口。') }],
    resource_changes: [{ entity: 'aning', resource: '铜钱', opening: 0, change: 8, closing: 8, evidence: evidence('她手里剩下八枚铜钱。') }],
    narrative_events: [{ id: 'arrival', description: '阿宁到达渡口', story_time: null, participants: ['aning'], location: null, causes: [], scope: 'world', holder: null, evidence: evidence('阿宁站在渡口，背着灯。') }],
    foreshadow_updates: [{ id: 'notches', action: 'plant', description: '灯柄三道缺口的用途', evidence: evidence('她亲眼看见灯柄刻着三道缺口。') }] });
  return project.commit(1, 'opening');
}

test('new books require adopted contract, authorization and saved intent; old books opt in without rewriting canon', t => {
  const { project, root } = book(t);
  assert.equal(loadConfig(root).workflow, 'structured');
  assert.equal(project.resume().stage, 'contract');
  assert.throws(() => project.prepare(1, 'opening'), /adopted creative contract/);
  project.workflow.adopt('作者采用'); project.sync();
  assert.equal(project.resume().stage, 'authorize');
  assert.throws(() => project.prepare(1, 'opening'), /authorization/);
  project.workflow.authorize('opening', 1, 3, 'draft', '先看草稿');
  assert.equal(project.resume().stage, 'intent');
  project.workflow.seed(1, 'opening');
  assert.throws(() => project.workflow.saveIntent(1, 'opening'), /intent|schema/i);
  intent(project, root, 1); assert.equal(project.resume().stage, 'prepare');
  project.prepare(1, 'opening'); assert.equal(project.resume().stage, 'write');
  const config = join(root, 'specwriter/config.yaml'); writeFileSync(config, readFileSync(config, 'utf8').replace('workflow: structured\n', ''));
  assert.equal(project.workflow.structured, true); // Adopted contracts activate old books too.
});

test('draft inspection, author acceptance, pause and complete range recover without model calls', t => {
  const { project, root } = book(t); ready(project, 'draft'); intent(project, root, 1);
  const input = candidate(project, root, 1, '阿宁在渡口点起了灯。');
  assert.equal(project.resume().stage, 'await-acceptance'); assert.equal(project.verify(1, 'opening').valid, true);
  assert.throws(() => project.commit(1, 'opening'), /Draft-only/);
  const before = readFileSync(input.paths.context, 'utf8');
  project.workflow.authorize('opening', 1, 1, 'auto', '作者接纳第一章');
  project.workflow.pause('opening', true, '作者暂看草稿');
  assert.equal(project.resume().stage, 'paused'); assert.equal(project.verify(1, 'opening').valid, true);
  assert.throws(() => project.prepare(1, 'opening'), /paused/); assert.throws(() => project.commit(1, 'opening'), /paused/);
  project.workflow.pause('opening', false, '作者恢复'); assert.equal(project.store.policy('opening').controlReason,'作者恢复'); project.commit(1, 'opening');
  assert.equal(readFileSync(input.paths.context, 'utf8'), before);
  assert.equal(project.resume().stage, 'authorize');
  assert.throws(() => project.prepare(2, 'opening'), /authorization/);
  project.workflow.authorize('opening', 2, 3, 'auto', '作者授权其余两章');
  for (const chapter of [2,3]) { intent(project, root, chapter); candidate(project, root, chapter, `阿宁在第${chapter}夜把灯挂在渡口。`); project.commit(chapter, 'opening'); }
  assert.equal(project.resume().stage, 'complete'); assert.equal(project.resume().chapter, null);
});

test('adopted specs survive draft edits; future versions select by chapter and invalidate unfinished context', t => {
  const { project, root } = book(t); ready(project); intent(project, root, 1);
  const input = candidate(project, root, 1, '阿宁在渡口点灯。'); const old = input.context.workflow.contractId;
  const spec = join(root, 'specwriter/specs/world.md'); writeFileSync(spec, '# 新草案\n灯只能在雨中点亮。');
  assert.equal(project.verify(1, 'opening').valid, true);
  assert.ok(project.workflow.contracts().adopted[0].editedDrafts.includes('specwriter/specs/world.md'));
  project.workflow.adopt('作者从第二章采用雨灯设定', 2); project.sync();
  assert.equal(project.workflow.contract(1).id, old); assert.notEqual(project.workflow.contract(2).id, old);
  assert.throws(() => project.verify(1, 'opening'), /stale/);
  candidate(project, root, 1, '阿宁在渡口点灯。', {}, true); project.commit(1, 'opening');
  assert.ok(!project.memory().facts.some(item => item.object.includes('雨中')));
});

test('required state, old events, hooks, POV balance and previous ending are pinned; missing dependencies fail before models', async t => {
  const { project, root } = book(t); ready(project); foundation(project, root);
  intent(project, root, 2, { participantIds: [], pov: 'aning', requiredState: [{ entity: 'aning', fields: ['location'] }], requiredEvents: ['arrival'], requiredHooks: ['notches'], knowledgeChecks: [{ holder: 'aning', topic: '灯柄缺口' }] });
  const prepared = project.prepare(2, 'opening', { query: '与灯无关的查询', budget: 14000 }); const context = load(join(root, prepared.paths.context));
  assert.equal(context.memory.resources.find(item => item.entity === 'aning').amount, 8);
  assert.ok(context.memory.facts.some(item => item.subject === 'aning' && item.object === '渡口'));
  assert.ok(context.memory.episodes.some(item => item.id === 'arrival')); assert.ok(context.memory.hooks.some(item => item.id === 'notches'));
  assert.ok(context.memory.entities.some(item => item.id === 'aning'));
  assert.ok(context.sources.some(item => item.id.startsWith('previous-ending:') && item.protection === 'protected'));
  const path = join(root, project.workflow.intentPath(2, 'opening')), valid = load(path);
  const lifeState=project.memory(1); lifeState.facts.push({...lifeState.facts.find(item=>item.subject==='aning'),id:'status-life',predicate:'status',object:'alive'});
  assert.ok(requiredMemory(lifeState,{...valid,requiredState:[{entity:'aning',fields:['status']}]}).factIds.includes('status-life'));
  writeFileSync(path, JSON.stringify({ ...valid, requiredState: [{ entity: 'aning', fields: ['realm'] }] }));
  configureMemory(root, { backend: 'microsoft-graphrag' });
  let calls = 0; const memory = new WriterMemory(project, { index: async () => { calls++; }, query: async () => { calls++; } });
  await assert.rejects(memory.prepare(2, 'opening'), /Required state/); assert.equal(calls, 0);
  writeFileSync(path, JSON.stringify({ ...valid, requiredState: [], requiredResources: [{ entity: 'aning', resource: '灵石' }] }));
  assert.throws(() => project.workflow.saveIntent(2, 'opening'), /formal balance/);
  writeFileSync(path, JSON.stringify({ ...valid, requiredEvents: ['future'] })); assert.throws(() => project.workflow.saveIntent(2, 'opening'), /Unknown required event/);
  writeFileSync(path, JSON.stringify(valid)); project.workflow.saveIntent(2, 'opening');
  await assert.rejects(memory.prepare(2, 'opening', { budget: 1000 }), /exceed budget/); assert.equal(calls, 0);
});

test('a pause during indexing blocks the subsequent query and publication', async t => {
  const { project, root } = book(t); ready(project); foundation(project, root); intent(project, root, 2);
  configureMemory(root, { backend: 'microsoft-graphrag' }); let queries = 0;
  const memory = new WriterMemory(project, { index: async () => project.workflow.pause('opening', true, '作者暂停'), query: async () => { queries++; } });
  await assert.rejects(memory.prepare(2, 'opening'), /paused/); assert.equal(queries, 0);
  assert.equal(existsSync(join(root, project.chapterPaths('opening', 2).context)), false);
});

test('intent and prose edits invalidate extraction/review; explicit checks cannot be skipped or use nonexistent quotes', t => {
  const { project, root } = book(t); ready(project);
  intent(project, root, 1, { withhold: ['暂不揭露缺口用途'] });
  const input = candidate(project, root, 1, '阿宁在渡口点灯，仍不知道灯柄缺口的用途。');
  const missing = { ...input.review, intent_checks: [] }; writeFileSync(input.paths.review, JSON.stringify(missing));
  assert.throws(() => project.verify(1, 'opening'), /Intent requires/);
  input.review.intent_checks[0].evidenceQuotes = ['不存在的正文']; writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /Intent requires/);
  writeFileSync(input.paths.intent, '# 手改 Markdown'); assert.throws(() => project.verify(1, 'opening'), /intent changed/);
  project.workflow.saveIntent(1, 'opening');
  const path = join(root, project.workflow.intentPath(1, 'opening')); writeFileSync(path, JSON.stringify({ ...load(path), goal: '新目标' }));
  assert.equal(project.resume().stage, 'intent'); project.workflow.saveIntent(1, 'opening'); assert.equal(project.resume().stage, 'refresh');
  const next = candidate(project, root, 1, '阿宁在渡口点灯。', {}, true); writeFileSync(next.paths.draft, '阿宁改为留在家中。');
  assert.equal(project.resume().stage, 'extract'); assert.throws(() => project.commit(1, 'opening'), /quote|draft/i);
});

test('knowledge gaps are explicit and plans remain outside formal memory; unsafe or missing inputs are rejected', t => {
  const { project, root } = book(t); ready(project);
  intent(project, root, 1, { participantIds: ['aning'], newEntities: [{ id: 'aning', name: '阿宁', type: 'character' }], knowledgeChecks: [{ holder: 'aning', topic: '幕后真相' }], expectedChanges: ['计划她找到幕后人'] });
  const prepared = project.prepare(1, 'opening'), context = load(join(root, prepared.paths.context));
  assert.equal(context.workflow.requirements.knowledgeGaps.length, 1); assert.equal(project.memory().facts.length, 0);
  const path = join(root, project.workflow.intentPath(1, 'opening')), valid = load(path);
  writeFileSync(path, JSON.stringify({ ...valid, newEntities: [...valid.newEntities, { id:'double',name:'阿宁',type:'character' }] })); assert.throws(() => project.workflow.saveIntent(1,'opening'), /Duplicate planned entity names/);
  writeFileSync(path, JSON.stringify({ ...valid, planPaths: ['../escape.md'] })); assert.throws(() => project.workflow.saveIntent(1, 'opening'), /planPaths/);
  writeFileSync(path, JSON.stringify({ ...valid, planPaths: ['specwriter/plans/missing.md'] })); assert.throws(() => project.workflow.saveIntent(1, 'opening'), /Selected plan/);
  writeFileSync(path, JSON.stringify(valid)); project.workflow.saveIntent(1, 'opening');
  candidate(project, root, 1, '阿宁在渡口点灯。'); assert.throws(() => project.commit(1, 'opening'), /supported entity/);
});

test('Git checkpoint detects policy-only changes and restores adopted contract and paused state', t => {
  const { project, root, directory } = book(t); ready(project);
  const versions = new BookVersions(root); versions.init(project);
  project.workflow.pause('opening', true, '作者暂看计划');
  assert.equal(versions.status(project).memoryChanged, true); assert.equal(versions.status(project).needsSave, true);
  const checkpoint = versions.save(project, '暂停检查点'); const target = join(directory, 'restored'); versions.restore(checkpoint.commit, target);
  const restored = new Project(target);
  try { assert.equal(restored.workflow.contract(1).reason, '作者采用渡口故事'); assert.equal(restored.resume().stage, 'paused'); assert.equal(restored.doctor().healthy, true); }
  finally { restored.close(); }
  assert.equal(versions.status(project).needsSave, false);
});

test('structured revision invalidates later chapters and resumes reconciliation without future prose', t => {
  const { project, root } = book(t); ready(project); foundation(project, root);
  for (const chapter of [2,3]) { intent(project, root, chapter); candidate(project, root, chapter, `第${chapter}夜，阿宁仍在渡口，灯还没有熄灭。`); project.commit(chapter, 'opening'); }
  const original = project.store.revisions().find(item => item.chapter === 1).body;
  const oldDelta = project.store.revisions().find(item => item.chapter === 1).delta;
  candidate(project, root, 1, original + '\n她把灯抬高了一些。', oldDelta, true);
  // Use the current hashes/base revision rather than copying an accepted metadata envelope.
  const paths = project.chapterPaths('opening',1), deltaPath = join(root, paths.delta), reviewPath = join(root, paths.review);
  const delta = { ...load(deltaPath), ...project.hashes(1,'opening') }; writeFileSync(deltaPath, JSON.stringify(delta));
  const review = { ...load(reviewPath), ...project.hashes(1,'opening') }; delete review.baseRevision; writeFileSync(reviewPath, JSON.stringify(review));
  project.commit(1,'opening'); assert.deepEqual(project.status().staleChapters,[2,3]);
  assert.equal(project.resume().chapter,2); assert.equal(project.resume().stage,'refresh');
  intent(project,root,2); const prepared=project.prepare(2,'opening',{refresh:true}), context=load(join(root,prepared.paths.context));
  assert.equal(context.memory.atChapter,1); assert.ok(context.sources.every(item => item.chapter === undefined || item.chapter < 2));
  assert.ok(!JSON.stringify(context.memory).includes('第3夜')); assert.equal(project.corpus().atChapter,1);
});

test('schema migration preserves old books, user-edited skill upgrades and new CLI recovery commands', t => {
  const { project, root } = book(t, { workflow: 'legacy' });
  project.store.db.exec("DROP TABLE work_policy; DROP TABLE story_contract; UPDATE meta SET value='2' WHERE key='schemaVersion';");
  const migrated = new Project(root);
  try { assert.equal(migrated.workflow.structured, false); assert.deepEqual(migrated.store.contracts(), []); assert.equal(migrated.store.works().length, 1); }
  finally { migrated.close(); }
  const skill = join(root, '.agents/skills/specwriter/SKILL.md'); writeFileSync(skill, '# 作者自定义入口');
  assert.ok(initProject(root).preserved.includes('.agents/skills/specwriter/SKILL.md')); assert.equal(readFileSync(skill, 'utf8'), '# 作者自定义入口');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' });
  for (const args of [['contract','adopt','--reason','作者采用'], ['work','authorize','opening','--from','1','--to','3','--acceptance','draft','--reason','作者写开篇'], ['intent','seed','1','--work','opening'], ['resume']]) {
    const result = call(...args); assert.equal(result.status, 0, result.stderr); JSON.parse(result.stdout);
  }
  assert.equal(JSON.parse(call('resume').stdout).stage, 'intent');
  assert.equal(call('contract','show','--from','2').status, 1); assert.equal(call('work','pause','opening','--reason','暂停','--to','3').status, 1);
});
