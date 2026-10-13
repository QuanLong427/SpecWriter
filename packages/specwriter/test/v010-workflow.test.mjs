import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project, NovelReader, WriterMemory, BookVersions, ResearchLibrary, initProject, configureMemory, craftProfile, craftProfiles, useCraftProfile, intentChecks, hash } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const sourceText = '外部练习样本：顾行看见被擦掉的日期，没有直接说出答案，而是去询问守桥人。动作让问题变得具体。';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'specwriter-v010-flow-')), root = join(directory, 'book');
  initProject(root, '渡口的灯', { memoryBackend: 'local' });
  const project = new Project(root);
  project.workflow.adopt('作者采用渡口故事'); project.propose('opening', '开篇', 1, 3);
  project.workflow.authorize('opening', 1, 3, 'auto', '作者授权开篇三章'); project.sync();
  t.after(() => { project.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, project, library: project.research };
}
function analysis(library, id = 'sample-analysis') {
  const path = library.create(id, { kind: 'analysis', title: '开篇行动机制', question: '怎样通过行动呈现悬念？' });
  library.capture(id, { sourceId: 'sample', kind: 'file', title: '原创练习片段', content: sourceText });
  const report = library.draft(id);
  report.observations = [{ text: '样本用擦掉的日期和询问行动连接问题。', evidence: [{ sourceId: 'sample', quote: '顾行看见被擦掉的日期' }] }];
  report.interpretations = [{ text: '可借鉴问题引发行动的结构，保留本书人物与事件。', sourceIds: ['sample'] }];
  report.directions = [{ title: '渡口核查', premise: '人物用一次核查行动回应告示异常。', reason: '作者可以选择适配调查节奏。', sourceIds: ['sample'] }];
  report.unknowns = ['仅阅读这个练习片段，没有关于真实榜单或全书表现的数据。'];
  writeFileSync(path, JSON.stringify(report));
  return { path, version: library.save(id) };
}
function intent(project, root, chapter, references = []) {
  project.workflow.seed(chapter, 'opening');
  const path = join(root, project.workflow.intentPath(chapter, 'opening'));
  writeFileSync(path, JSON.stringify({ ...read(path), goal: '阿宁用实际行动核查渡口的告示', scenes: ['核查告示日期并决定向谁询问'], references }));
  return project.workflow.saveIntent(chapter, 'opening');
}
function candidate(project, root, chapter, refresh = false) {
  const body = '阿宁蹲下，将旧灯移到告示旁。日期上的墨迹被擦去了一半。她没有猜姐姐去了哪里，而是收好灯，沿桥柱去找看守。';
  const prepared = project.prepare(chapter, 'opening', { refresh });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, value]) => [key, join(root, value)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, 'opening');
  const delta = extraction({ ...read(paths.delta), ...metadata, title: '告示', summary: '阿宁核查告示后询问看守', characters: [], key_events: [{ description: '阿宁核查告示日期并去询问看守', evidence: { quote: body } }] }, body);
  writeFileSync(paths.delta, JSON.stringify(delta));
  const review = assessment(read(paths.review), metadata, delta);
  review.intent_checks = intentChecks(read(paths.context).workflow.intent).map(check => ({ id: check.id, verdict: 'satisfied', evidenceQuotes: check.requiresQuote ? [body] : [],
    explanation: check.id.startsWith('reference:') ? '当前正文以核查日期和询问看守承接悬念，保留阿宁、旧灯与本书事件，没有搬用样本姓名。' : '核查告示后决定询问对象，章内动作与目标一致。' }));
  writeFileSync(paths.review, JSON.stringify(review));
  return { paths, body, review, context: read(paths.context) };
}
function changeAnalysis(library, path, note = '修改后的适配建议。') {
  const report = read(path); report.interpretations[0].text = note;
  writeFileSync(path, JSON.stringify(report)); return library.save(report.id);
}

test('selected research enters chapter context and review without entering formal memory', t => {
  const { project, root, library } = fixture(t);
  analysis(library);
  intent(project, root, 1, [{ id: 'sample-analysis', purpose: '借鉴调查行动的场景方法，保留本书人物' }]);
  assert.equal(project.corpus().documents.length, 0);
  assert.equal(project.memory().facts.length, 0);
  const input = candidate(project, root, 1);
  const selected = input.context.sources.find(source => source.kind === 'research');
  assert.equal(selected.protection, 'protected');
  assert.ok(selected.content.includes('sample-analysis'));
  assert.equal(input.context.memory.entities.length, 0);
  assert.ok(!input.context.sources.some(source => source.kind === 'prose' && source.content.includes('顾行')));
  input.review.intent_checks = input.review.intent_checks.filter(check => !check.id.startsWith('reference:'));
  writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.verify(1, 'opening'), /reference:sample-analysis/);
  candidate(project, root, 1); project.commit(1, 'opening');
  assert.ok(project.corpus().documents.every(document => !document.body.includes('顾行')));
  assert.ok(!new NovelReader(project).export('txt').content.includes(sourceText));
});

test('research drafts do not affect a prepared chapter; saved updates require refresh', t => {
  const { project, root, library } = fixture(t), research = analysis(library);
  intent(project, root, 1, [{ id: 'sample-analysis', purpose: '场景适配' }]);
  const input = candidate(project, root, 1), token = project.prepareRequest(1, 'opening').token;
  const report = read(research.path); report.interpretations[0].text = '尚未保存的新建议。'; writeFileSync(research.path, JSON.stringify(report));
  assert.equal(project.prepareRequest(1, 'opening').token, token);
  assert.equal(project.verify(1, 'opening').valid, true);
  library.save('sample-analysis');
  assert.notEqual(project.prepareRequest(1, 'opening').token, token);
  assert.throws(() => project.verify(1, 'opening'), /Context is stale/);
  project.prepare(1, 'opening', { refresh: true });
  assert.equal(readFileSync(input.paths.draft, 'utf8'), input.body);
  assert.equal(read(input.paths.review).reviewed, false);
});

test('an explicitly pinned reference retains its immutable version after a newer report', t => {
  const { project, root, library } = fixture(t), research = analysis(library);
  intent(project, root, 1, [{ id: 'sample-analysis', purpose: '按作者选定版本使用', revision: research.version.revision }]);
  candidate(project, root, 1);
  const token = project.prepareRequest(1, 'opening').token;
  const next = changeAnalysis(library, research.path);
  assert.notEqual(next.revision, research.version.revision);
  assert.equal(project.prepareRequest(1, 'opening').token, token);
  assert.equal(project.verify(1, 'opening').valid, true);
});

test('missing, duplicate and altered referenced material cannot pass chapter preparation', t => {
  const { project, root, library } = fixture(t);
  assert.throws(() => intent(project, root, 1, [{ id: 'missing', purpose: '核对场景' }]), /Missing research|missing|does not exist/);
  analysis(library);
  assert.throws(() => intent(project, root, 1, [{ id: 'sample-analysis', purpose: '甲' }, { id: 'sample-analysis', purpose: '乙' }]), /Duplicate chapter/);
  intent(project, root, 1, [{ id: 'sample-analysis', purpose: '核对调查行动' }]); candidate(project, root, 1);
  const path = join(root, 'specwriter/research/sample-analysis/sources/sample.json'), source = read(path);
  source.content += '静默添加的内容'; writeFileSync(path, JSON.stringify(source));
  assert.throws(() => project.verify(1, 'opening'), /altered|hash/);
  assert.equal(project.status().acceptedChapters, 0);
  assert.ok(project.status().research.error);
});

test('selected reference size is checked before a paid retrieval operation', async t => {
  const { project, root, library } = fixture(t), research = analysis(library);
  intent(project, root, 1); candidate(project, root, 1); project.commit(1, 'opening');
  const report = read(research.path);
  const quote = '顾行看见被擦掉的日期';
  report.observations = Array.from({ length: 24 }, (_, index) => ({ text: `用于预算检查的观察${index}：` + '引用'.repeat(400), evidence: [{ sourceId: 'sample', quote }] }));
  writeFileSync(research.path, JSON.stringify(report)); library.save('sample-analysis');
  intent(project, root, 2, [{ id: 'sample-analysis', purpose: '检验明确选择资料后的预算边界' }]);
  configureMemory(root, { backend: 'microsoft-graphrag' });
  let calls = 0;
  const provider = { index: async () => { calls++; }, query: async () => { calls++; } };
  await assert.rejects(new WriterMemory(project, provider).prepare(2, 'opening', { budget: 8000 }), /protected inputs exceed budget/);
  assert.equal(calls, 0);
});

test('published CLI reports remain readable when an unrelated draft source is damaged', t => {
  const { library, root } = fixture(t), research = analysis(library);
  library.capture('sample-analysis', { sourceId: 'unused', kind: 'file', title: '尚未引用的材料', content: '未用于当前已保存报告。' });
  const path = join(root, 'specwriter/research/sample-analysis/sources/unused.json'), source = read(path);
  source.content += '损坏的额外材料'; writeFileSync(path, JSON.stringify(source));
  const run = (...args) => spawnSync(process.execPath, [cli, 'research', 'show', 'sample-analysis', ...args, '--root', root, '--json'], { encoding: 'utf8' });
  const recorded = run();
  assert.equal(recorded.status, 0, recorded.stderr);
  const report = JSON.parse(recorded.stdout);
  assert.equal(report.revision, research.version.revision);
  assert.deepEqual(report.sources.map(source => source.sourceId), ['sample']);
  assert.notEqual(run('--draft').status, 0);
  const usedPath = join(root, 'specwriter/research/sample-analysis/sources/sample.json'), used = read(usedPath);
  used.content += '损坏的已引用材料'; writeFileSync(usedPath, JSON.stringify(used));
  assert.notEqual(run().status, 0);
});

test('research publication during indexing prevents subsequent query and old artifact publication', async t => {
  const { project, root, library } = fixture(t), research = analysis(library);
  intent(project, root, 1); candidate(project, root, 1); project.commit(1, 'opening');
  intent(project, root, 2, [{ id: 'sample-analysis', purpose: '场景方法' }]);
  configureMemory(root, { backend: 'microsoft-graphrag' });
  const calls = { index: 0, query: 0 };
  const provider = { index: async () => { calls.index++; changeAnalysis(library, research.path); }, query: async () => { calls.query++; } };
  await assert.rejects(new WriterMemory(project, provider).prepare(2, 'opening'), /changed during GraphRAG indexing/);
  assert.deepEqual(calls, { index: 1, query: 0 });
  assert.equal(existsSync(join(root, project.chapterPaths('opening', 2).context)), false);
});

test('recursive skill installation includes auxiliary references and preserves author edits', t => {
  const { project, root } = fixture(t);
  const path = join(root, '.agents/skills/specwriter-research/references/market-evidence.md');
  assert.ok(existsSync(path));
  assert.equal(initProject(root).skills.length, 13);
  writeFileSync(path, '# 作者定制的研究方法');
  const again = initProject(root);
  assert.ok(again.preserved.includes('.agents/skills/specwriter-research/references/market-evidence.md'));
  assert.equal(readFileSync(path, 'utf8'), '# 作者定制的研究方法');
  assert.equal(project.status().research.reports.length, 0);
});

test('original craft references are usable through CLI without adopting story rules', t => {
  const { project, root } = fixture(t);
  assert.equal(craftProfiles().length, 5);
  for (const profile of craftProfiles()) assert.ok(craftProfile(profile.id).principles.length);
  const contracts = project.store.contracts().length;
  const style = hash(readFileSync(join(root, 'specwriter/specs/style.md'), 'utf8'));
  useCraftProfile(project.research, 'mystery-deduction', 'mystery-method');
  assert.equal(project.research.show('mystery-method').report.kind, 'craft');
  assert.equal(project.store.contracts().length, contracts);
  assert.equal(hash(readFileSync(join(root, 'specwriter/specs/style.md'), 'utf8')), style);
  assert.equal(project.corpus().documents.length, 0);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' });
  const listed = run('craft', 'list'); assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 5);
  assert.notEqual(run('research', 'show', 'mystery-method', '--file', 'invalid').status, 0);
  const secret = join(root, '.env'); writeFileSync(secret, 'do-not-capture');
  assert.notEqual(run('research', 'capture', 'mystery-method', '--source', 'secret', '--file', secret, '--title', '无效源').status, 0);
  assert.equal(project.research.listSources('mystery-method').length, 1);
});

test('book checkpoints restore research sources, immutable reports and chapter selections', t => {
  const { project, root, directory, library } = fixture(t), research = analysis(library);
  intent(project, root, 1, [{ id: 'sample-analysis', purpose: '保留来源和使用目的', revision: research.version.revision }]);
  candidate(project, root, 1); project.commit(1, 'opening');
  const versions = new BookVersions(root), checkpoint = versions.init(project);
  const destination = join(directory, 'restored');
  versions.restore(checkpoint.checkpoint.commit, destination);
  const restored = new Project(destination);
  try {
    const selected = restored.store.revisions()[0].context.workflow.intent.references[0];
    assert.equal(selected.revision, research.version.revision);
    assert.equal(new ResearchLibrary(destination).show(selected.id, selected.revision).reportHash, research.version.reportHash);
    assert.ok(restored.corpus().documents.every(document => !document.body.includes('顾行')));
  } finally { restored.close(); }
});
