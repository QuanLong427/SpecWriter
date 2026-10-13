import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Project } from '../dist/project.js';
import { initProject } from '../dist/init.js';
import { MemoryLifecycle } from '../dist/memory-lifecycle.js';
import { extraction, assessment } from './contract-fixture.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function accept(project, chapter, body, work = 'seed') {
  const prepared = project.prepare(chapter, work, { refresh: true });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, path]) => [key, join(project.root, path)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, work);
  const delta = extraction({ ...read(paths.delta), ...metadata, title: `第${chapter}章`, summary: body, characters: [], key_events: [{ description: body, evidence: { quote: body } }] }, body);
  writeFileSync(paths.delta, JSON.stringify(delta));
  const review = assessment(read(paths.review), metadata, delta);
  const requirements = project.reviewRequirements(chapter, work);
  review.intent_checks = requirements.intentChecks.map(check => ({ id: check.id, verdict: 'satisfied', explanation: '核对当前正文中的查看与保留动作。', evidenceQuotes: check.requiresQuote ? [body] : [] }));
  review.memory_checks = requirements.memoryCheckBindings;
  writeFileSync(paths.review, JSON.stringify(review));
  return project.commit(chapter, work);
}
function fixture(t, chapters = 1) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v011-check-'));
  initProject(root, '核查测试书', { memoryBackend: 'local', workflow: 'legacy' });
  const project = new Project(root);
  project.propose('seed', '建立历史', 1, 10);
  for (let chapter = 1; chapter <= chapters; chapter++) accept(project, chapter, `林舟在第${chapter}章查看告示，保留青铜钥匙。`);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project };
}
function path(input, id, name = 'draft.json') { return join(input.root, 'specwriter/memory/tasks', id, name); }
function queryer(project, calls) {
  return async (query, options) => { assert.equal(project.store.db.isTransaction, false); calls.push({ query, ...options }); return project.query(query, { at: options.at }); };
}
function reviewTask(lifecycle, id, verdict = 'supported') {
  const report = lifecycle.draft(id);
  const source = report.history.chapters[0];
  const row = source && lifecycle.project.store.db.prepare('SELECT body FROM revisions WHERE id = ?').get(source.revision);
  report.reviewed = true; report.reviewNotes = ['逐项回看已接纳原文，区分已确立动作和未检出的未知。'];
  report.findings = report.questions.map(question => ({ questionId: question.id, checked: true, verdict: source ? verdict : 'not-applicable',
    conclusion: source ? '已核对原文的查看告示和保留钥匙动作，未把检索答案当作新的事实。' : '暂无已接纳历史可作这项历史核查；本结论不推断未来不存在冲突。',
    evidence: source && verdict !== 'uncertain' ? [{ chapter: source.chapter, revision: source.revision, bodyHash: source.bodyHash, quote: row.body }] : [],
    limitations: !source || verdict === 'uncertain' ? ['仅能说明当前历史范围或证据缺口，未知不等于不存在。'] : [] }));
  writeFileSync(path({ root: lifecycle.project.root }, id), JSON.stringify(report));
  return report;
}
function work(input, id = 'next', from = 2, to = 3) { input.project.propose(id, '待核查的工作', from, to); return id; }

test('empty history does not query or claim completed review until explicit scoped review is saved', async t => {
  const input = fixture(t, 0), calls = [], lifecycle = new MemoryLifecycle(input.project, queryer(input.project, calls));
  work(input, 'opening', 1, 2);
  const prepared = await lifecycle.prepare('plan-opening', { stage: 'plan', workId: 'opening' });
  assert.equal(prepared.history.atChapter, 0); assert.equal(calls.length, 0);
  assert.equal(lifecycle.ready('plan-opening').status, 'prepared');
  assert.throws(() => lifecycle.guard('opening', 1, 'prepare'), /blocks prepare/);
  assert.throws(() => lifecycle.save('plan-opening'), /actual completed review/);
  reviewTask(lifecycle, 'plan-opening'); const saved = lifecycle.save('plan-opening');
  assert.equal(saved.completed, true); assert.equal(saved.fresh, true);
  assert.equal(lifecycle.ready('plan-opening').ready, true);
  assert.equal(lifecycle.contextSources('opening', 1).length, 1);
  assert.equal(input.project.corpus().documents.length, 0);
});

test('register persists both requirements before queries and failures publish no completed packet', async t => {
  const input = fixture(t, 2); work(input, 'repair', 1, 2);
  let calls = 0;
  const lifecycle = new MemoryLifecycle(input.project, async () => { calls++; throw new Error('offline model failure'); });
  lifecycle.register('plan-repair', { stage: 'plan', workId: 'repair' });
  lifecycle.register('impact-repair', { stage: 'impact', workId: 'repair' });
  assert.equal(calls, 0); assert.equal(lifecycle.list().length, 2);
  assert.throws(() => lifecycle.guard('repair', 1, 'commit'), /blocks commit/);
  await assert.rejects(lifecycle.prepare('impact-repair'), /offline model failure/);
  assert.equal(lifecycle.ready('impact-repair').status, 'pending');
  assert.equal(existsSync(path(input, 'impact-repair')), false);
  assert.equal(existsSync(path(input, 'impact-repair', 'prepared.json')), false);
  assert.equal(lifecycle.list().find(task => task.id === 'impact-repair').ready, false);
});

test('task queries are merged, N-1 bounded, reusable and still pending semantic review', async t => {
  const input = fixture(t), calls = [], lifecycle = new MemoryLifecycle(input.project, queryer(input.project, calls));
  work(input);
  const first = await lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next', questions: ['哪些动作已经确立？', '哪些问题仍然未知？'] });
  assert.equal(calls.length, 1); assert.equal(calls[0].at, 1);
  assert.match(calls[0].query, /哪些动作已经确立/); assert.match(calls[0].query, /哪些问题仍然未知/);
  const repeated = await lifecycle.prepare('plan-next');
  assert.equal(repeated.reused, true); assert.equal(repeated.preparedRevision, first.preparedRevision); assert.equal(calls.length, 1);
  assert.equal(lifecycle.ready('plan-next').ready, false);
  assert.throws(() => lifecycle.guard('next', 2, 'prepare'), /item-by-item review/);
});

test('unknown findings can be honestly recorded but cannot satisfy mandatory gates', async t => {
  const input = fixture(t), lifecycle = new MemoryLifecycle(input.project, queryer(input.project, [])); work(input);
  await lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next' });
  reviewTask(lifecycle, 'plan-next', 'uncertain');
  const saved = lifecycle.save('plan-next');
  assert.equal(saved.status, 'recorded'); assert.equal(saved.completed, false);
  assert.throws(() => lifecycle.guard('next', 2, 'commit'), /unknown or conflicting/);
  assert.equal(input.project.memory().facts.length, 0);
});

test('rejected GraphRAG answers remain in their receipt and never become lifecycle draft material', async t => {
  const input = fixture(t); work(input);
  const rejected = 'REJECTED_RAW_ANSWER_林舟已经死亡_不得作为创作素材';
  const corpus = input.project.corpus(1), document = corpus.documents[0];
  const lifecycle = new MemoryLifecycle(input.project, async () => ({ engine: 'microsoft-graphrag', atChapter: 1, snapshotId: corpus.snapshotId,
    id: 'original-rejected-receipt', answer: rejected, assessment: { accepted: false, status: 'conflicting', evidenceStatus: 'verified', warnings: ['检索回答与正式状态冲突。'] },
    sources: [{ chapter: document.chapter, revision: document.revision, bodyHash: document.bodyHash, excerpt: document.body }],
    structural: input.project.query('告示', { at: 1 }) }));
  const packet = await lifecycle.prepare('plan-rejected', { stage: 'plan', workId: 'next' });
  assert.equal(packet.query.receiptId, 'original-rejected-receipt');
  assert.match(packet.query.answer, /回答未采用.*正式状态冲突/);
  assert.match(packet.query.answer, /正式记忆与已接纳原文逐项核对/);
  assert.equal(packet.query.answer.includes(rejected), false);
  assert.equal(readFileSync(packet.draftPath, 'utf8').includes(rejected), false);
  assert.equal(packet.sources[0].quote, document.body);
  assert.equal(lifecycle.draft('plan-rejected').reviewed, false);
  assert.ok(lifecycle.draft('plan-rejected').findings.every(finding => !finding.checked));
  assert.equal(lifecycle.ready('plan-rejected').ready, false);
  assert.throws(() => lifecycle.save('plan-rejected'), /actual completed review/);
  assert.throws(() => lifecycle.guard('next', 2, 'prepare'), /blocks prepare/);
});

test('planning output edits do not stale the package but adopted instructions do', async t => {
  const input = fixture(t), lifecycle = new MemoryLifecycle(input.project, queryer(input.project, [])); work(input);
  await lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next' }); reviewTask(lifecycle, 'plan-next'); const saved = lifecycle.save('plan-next');
  writeFileSync(join(input.root, 'specwriter/work/next/proposal.md'), '# 新规划输出');
  writeFileSync(join(input.root, 'specwriter/plans/outline.md'), '# 卷纲输出已修改');
  assert.equal(lifecycle.show('plan-next').fresh, true);
  const edited = lifecycle.draft('plan-next'); edited.findings[0].conclusion = '未保存的核查修改'; writeFileSync(path(input, 'plan-next'), JSON.stringify(edited));
  assert.equal(lifecycle.show('plan-next').revision, saved.revision);
  input.project.instructions.add('keep-key', { text: '保留钥匙动作', fromChapter: 2, toChapter: 3, workId: 'next' });
  assert.equal(lifecycle.show('plan-next').fresh, false);
  assert.throws(() => lifecycle.guard('next', 2, 'prepare'), /stale|changed/);
});

test('recorded versions remain immutable and refresh preserves the previous reviewed draft', async t => {
  const input = fixture(t), lifecycle = new MemoryLifecycle(input.project, queryer(input.project, [])); work(input);
  await lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next' }); reviewTask(lifecycle, 'plan-next'); const first = lifecycle.save('plan-next');
  const originalPath = path(input, 'plan-next', `versions/${first.revision}.json`), original = readFileSync(originalPath, 'utf8');
  await lifecycle.prepare('plan-next', { refresh: true, questions: ['只核对告示动作。'] });
  assert.equal(lifecycle.show('plan-next', first.revision).fresh, false);
  assert.equal(lifecycle.ready('plan-next').ready, false);
  reviewTask(lifecycle, 'plan-next'); const second = lifecycle.save('plan-next');
  assert.notEqual(second.revision, first.revision); assert.equal(readFileSync(originalPath, 'utf8'), original);
  assert.equal(lifecycle.save('plan-next').revision, second.revision);
  assert.equal(existsSync(path(input, 'plan-next', 'drafts')), true);
});

test('draft review reuses valid chapter context, explicit retrieve queries once, and draft edits stale it', async t => {
  const input = fixture(t), calls = [], lifecycle = new MemoryLifecycle(input.project, queryer(input.project, calls)); work(input);
  const chapter = input.project.prepare(2, 'next'); writeFileSync(join(input.root, chapter.paths.draft), '林舟在第二章再次查看告示。');
  const first = await lifecycle.prepare('review-next-2', { stage: 'review', workId: 'next', chapter: 2 });
  assert.equal(calls.length, 0); assert.equal(first.query.engine, 'context-reuse'); assert.equal(first.history.atChapter, 1);
  assert.match(first.query.answer, /not an answer to new review questions/);
  reviewTask(lifecycle, 'review-next-2'); lifecycle.save('review-next-2');
  assert.equal(lifecycle.contextSources('next', 2).length, 0);
  await lifecycle.prepare('review-next-2-new', { stage: 'review', workId: 'next', chapter: 2, retrieve: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].at, 1);
  writeFileSync(join(input.root, chapter.paths.draft), '林舟在第二章改变了查看顺序。');
  assert.equal(lifecycle.show('review-next-2').fresh, false);
  assert.throws(() => lifecycle.guard('next', 2, 'review'), /changed|prepared/);
});

test('standalone accepted-range review is bounded, stales on target changes, and never blocks revision work', async t => {
  const input = fixture(t, 2), calls = [], lifecycle = new MemoryLifecycle(input.project, queryer(input.project, calls));
  const packet = await lifecycle.prepare('review-range', { stage: 'review', from: 1, to: 2 });
  assert.equal(packet.scope.workId, null); assert.equal(packet.history.atChapter, 2); assert.equal(packet.binding.draftHash, null); assert.equal(calls.length, 1);
  reviewTask(lifecycle, 'review-range', 'conflicting'); lifecycle.save('review-range');
  work(input, 'repair', 2, 2);
  assert.doesNotThrow(() => lifecycle.guard('repair', 2, 'commit'));
  assert.deepEqual(lifecycle.contextSources('repair', 2), []);
  accept(input.project, 2, '林舟修订第二章，确认了新的告示内容。', 'repair');
  assert.equal(lifecycle.show('review-range').fresh, false);
  assert.doesNotThrow(() => lifecycle.guard('repair', 2, 'prepare'));
});

test('impact preserves the original full prefix through authorized multi-chapter revision without entering context', async t => {
  const input = fixture(t, 3), calls = [], lifecycle = new MemoryLifecycle(input.project, queryer(input.project, calls)); work(input, 'repair', 1, 2);
  const packet = await lifecycle.prepare('impact-repair', { stage: 'impact', workId: 'repair' });
  assert.equal(packet.history.atChapter, 3); assert.equal(calls[0].at, 3);
  assert.doesNotThrow(() => lifecycle.guard('repair', 1, 'prepare'));
  assert.throws(() => lifecycle.guard('repair', 1, 'commit'), /blocks commit/);
  reviewTask(lifecycle, 'impact-repair'); const saved = lifecycle.save('impact-repair');
  assert.deepEqual(lifecycle.contextSources('repair', 1), []);
  accept(input.project, 1, '林舟修订第一章，重新核对青铜钥匙。', 'repair');
  assert.equal(input.project.corpus().atChapter, 1);
  assert.equal(lifecycle.show('impact-repair').historical, true); assert.equal(lifecycle.ready('impact-repair').ready, true);
  assert.equal(lifecycle.show('impact-repair').report.history.atChapter, 3);
  assert.doesNotThrow(() => lifecycle.guard('repair', 2, 'commit'));
  accept(input.project, 2, '林舟修订第二章，重新确认告示内容。', 'repair');
  assert.equal(lifecycle.ready('impact-repair').ready, true);
  const repeated = await lifecycle.prepare('impact-repair'); assert.equal(repeated.reused, true); assert.equal(calls.length, 1);
  work(input, 'other', 3, 3); accept(input.project, 3, '另一工作包改变第三章的后文内容。', 'other');
  assert.equal(lifecycle.show('impact-repair', saved.revision).fresh, false);
});

test('quotes must match real canonical revisions and repeated quotations require explicit offsets', async t => {
  const input = fixture(t, 0); accept(input.project, 1, '林舟查看告示。林舟查看告示。'); work(input);
  const lifecycle = new MemoryLifecycle(input.project, queryer(input.project, [])); await lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next' });
  let report = reviewTask(lifecycle, 'plan-next'); report.findings[0].evidence[0].quote = '外部材料中的一句话'; writeFileSync(path(input, 'plan-next'), JSON.stringify(report));
  assert.throws(() => lifecycle.save('plan-next'), /quote does not occur/);
  report = reviewTask(lifecycle, 'plan-next'); report.findings[0].evidence[0].quote = '林舟查看告示。'; writeFileSync(path(input, 'plan-next'), JSON.stringify(report));
  assert.throws(() => lifecycle.save('plan-next'), /Repeated.*exact offsets/);
  const evidence = report.findings[0].evidence[0]; evidence.start = 0; evidence.end = evidence.quote.length; writeFileSync(path(input, 'plan-next'), JSON.stringify(report));
  assert.equal(lifecycle.save('plan-next').completed, true);
});

test('source boundary violations and concurrent refresh prevent old publication', async t => {
  const input = fixture(t); work(input);
  const resolvers = [], lifecycle = new MemoryLifecycle(input.project, async (_query, options) => new Promise(resolve => resolvers.push({ resolve, at: options.at })));
  const old = lifecycle.prepare('plan-cas', { stage: 'plan', workId: 'next', questions: ['旧问题'] });
  const next = lifecycle.prepare('plan-cas', { refresh: true, questions: ['新问题'] });
  assert.equal(resolvers.length, 2);
  resolvers[1].resolve(input.project.query('告示', { at: 1 })); await next;
  resolvers[0].resolve(input.project.query('告示', { at: 1 })); await assert.rejects(old, /changed during retrieval/);
  assert.equal(lifecycle.draft('plan-cas').questions[0].text, '新问题');
  const wrong = new MemoryLifecycle(input.project, async () => ({ engine: 'stub', sources: [{ chapter: 2, revision: 999, excerpt: '未来内容' }] }));
  await assert.rejects(wrong.prepare('plan-wrong', { stage: 'plan', workId: 'next' }), /outside its prefix/);
  assert.equal(wrong.ready('plan-wrong').status, 'pending'); assert.equal(existsSync(path(input, 'plan-wrong')), false);
});

test('immutable task identity, portable paths, budgets, book identity and artifact checksums fail closed', async t => {
  const input = fixture(t), other = fixture(t), calls = [], lifecycle = new MemoryLifecycle(input.project, queryer(input.project, calls)); work(input); work(input, 'another', 2, 3);
  await assert.rejects(lifecycle.prepare('../escape', { stage: 'plan', workId: 'next' }), /portable/);
  await assert.rejects(lifecycle.prepare('plan-budget', { stage: 'plan', workId: 'next', budget: 10 }), /before retrieval/); assert.equal(calls.length, 0);
  await lifecycle.prepare('plan-next', { stage: 'plan', workId: 'next' });
  await assert.rejects(lifecycle.prepare('plan-next', { stage: 'impact', refresh: true }), /stage is immutable/);
  await assert.rejects(lifecycle.prepare('plan-next', { workId: 'another', refresh: true }), /scope is immutable/);
  reviewTask(lifecycle, 'plan-next'); const saved = lifecycle.save('plan-next');
  const versionPath = path(input, 'plan-next', `versions/${saved.revision}.json`), version = read(versionPath); version.report.findings[0].conclusion = '静默篡改'; writeFileSync(versionPath, JSON.stringify(version));
  assert.throws(() => lifecycle.show('plan-next'), /altered or foreign/);
  cpSync(join(input.root, 'specwriter/memory/tasks'), join(other.root, 'specwriter/memory/tasks'), { recursive: true });
  assert.throws(() => new MemoryLifecycle(other.project).list(), /foreign/);
});

test('legacy empty checks remain compatible and never migrate book identity implicitly', t => {
  const input = fixture(t, 0), config = join(input.root, 'specwriter/config.yaml');
  const content = readFileSync(config, 'utf8').replace(/^bookId:.*\r?\n/m, ''); writeFileSync(config, content);
  const lifecycle = new MemoryLifecycle(input.project);
  assert.deepEqual(lifecycle.list(), []); assert.deepEqual(lifecycle.contextSources('seed', 1), []);
  assert.doesNotThrow(() => lifecycle.guard('seed', 1, 'prepare'));
  assert.throws(() => lifecycle.register('legacy-check', { stage: 'plan', workId: 'seed' }), /缺稳定bookId/);
  assert.equal(readFileSync(config, 'utf8'), content);
});
