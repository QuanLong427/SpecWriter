import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Project, NovelReader, initProject } from '../dist/index.js';
import { StoryAudits } from '../dist/story-audits.js';
import { BookVersions } from '../dist/versions.js';
import { parseDocument } from 'yaml';
import { draft } from './boundary-fixture.mjs';
import { hash, json } from '../dist/files.js';

const BODY1 = '林舟在渡口点亮旧灯。绳结没有拆开。';
const BODY2 = '林舟拿回旧灯，决定追查灯主。';
const authorEnd = '作者决定本书在此完结；灯主身份留作开放悬念，调查者的选择已兑现。';
const load = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t, { empty = false, repeated = false, resolvedHook = false, queryer } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v011-audits-'));
  initProject(root, '河镇灯影', { memoryBackend: 'local', workflow: 'legacy' });
  const project = new Project(root); project.propose('arc', '河镇调查', 1, 3); project.sync();
  t.after(() => { project.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\')); rmSync(root, { recursive: true, force: true }); });
  if (!empty) {
    const first = repeated ? BODY1 + '林舟在渡口点亮旧灯。' : BODY1;
    draft(project, root, 1, first, { foreshadow_updates: [{ id: 'lamp-owner', action: 'plant', description: '旧灯灯主身份尚未确定', evidence: { quote: '绳结没有拆开。' } }] });
    project.commit(1, 'arc'); draft(project, root, 2, BODY2, resolvedHook ? { foreshadow_updates: [{ id: 'lamp-owner', action: 'resolve', description: null, evidence: { quote: BODY2 } }] } : {}); project.commit(2, 'arc');
  }
  return { root, project, audits: new StoryAudits(project, { queryer }) };
}
const evidence = revision => ({ chapter: revision.chapter, revision: revision.id, quote: revision.body, start: 0, end: revision.body.length });
function completeMemory(input, id, verdict = 'supported') {
  const report = input.audits.lifecycle.draft(id), row = input.project.store.revisions().find(row => row.chapter === report.scope.to);
  report.findings = report.questions.map(question => ({ questionId: question.id, checked: true, verdict,
    conclusion: '手工核对测试正文：林舟取回旧灯并开始追查灯主，灯主身份尚未由正文揭露。',
    evidence: [{ ...evidence(row), bodyHash: row.bodyHash }], limitations: verdict === 'uncertain' ? ['没有足够正文证明灯主身份。'] : [] }));
  report.reviewed = true; report.reviewNotes = ['手工读取测试范围的原文与未关伏笔；检索答案只是线索，结论限于引文。'];
  writeFileSync(join(input.root, 'specwriter/memory/tasks', id, 'draft.json'), json(report));
  return input.audits.lifecycle.save(id);
}
function fill(input, id, patches = {}) {
  const report = load(join(input.root, 'specwriter/story-audits', id, 'draft.json')), row = input.project.store.revisions().find(row => row.chapter === report.scope.to);
  const quote = evidence(row);
  Object.assign(report, {
    summary: { text: '调查者取回旧灯，并将调查目标转向灯主身份。', evidence: [quote] },
    characterChanges: [{ text: '林舟由保管旧灯转为主动调查灯主。', evidence: [quote] }],
    mainlineChanges: [{ text: '下一步调查问题转为灯主身份，未把猜测当成揭底。', evidence: [quote] }],
    hookDecisions: report.hookInventory.map(hook => ({ hookId: hook.id, disposition: report.kind === 'finish' ? 'author-retained' : 'deferred',
      reason: report.kind === 'finish' ? '作者选择保留灯主身份；报告不将open hook改resolved。' : '在下一剧情段核查灯主身份。',
      authorReason: report.kind === 'finish' ? authorEnd : null, evidence: [hook.evidence] })),
    reviewed: true, reviewNotes: ['已对照原文核对人物、主线与每个未关伏笔，未知项独立保留。'],
    ...patches,
  });
  writeFileSync(join(input.root, 'specwriter/story-audits', id, 'draft.json'), json(report));
  return report;
}
async function ready(input, id = 'book-finish', kind = 'finish', options = {}) {
  const prepared = await input.audits.prepare(id, { kind, ...options });
  completeMemory(input, id); fill(input, id);
  return { prepared, saved: input.audits.save(id) };
}

test('empty and legacy unidentified books have an ordinary unfinished status; no audit query is run', async t => {
  let calls = 0;
  const input = fixture(t, { empty: true, queryer: async () => { calls++; throw new Error('must not query'); } });
  assert.equal(input.audits.status().completed, false);
  assert.deepEqual(input.audits.status().reports, []);
  assert.equal(input.audits.status().completion, null);
  await assert.rejects(input.audits.prepare('empty-finish', { kind: 'finish' }), /nonempty/);
  await assert.rejects(input.audits.prepare('empty-recap', { kind: 'recap' }), /nonempty/);
  assert.equal(calls, 0);
  const configPath = join(input.root, 'specwriter/config.yaml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/^bookId:.*\r?\n/m, ''));
  assert.equal(input.audits.status().status, 'unfinished');
  await assert.rejects(input.audits.prepare('old-book', { kind: 'recap' }), /bookId/);
});

test('recap preparation is recoverable, reuses its memory packet, and does not count as reviewed', async t => {
  let calls = 0;
  const input = fixture(t, { queryer: async (_query, { at }) => { calls++; assert.equal(at, 2); assert.equal(input.project.store.db.isTransaction, false); return { answer: '需核查原文，灯主仍未知。' }; } });
  const first = await input.audits.prepare('river-recap', { kind: 'recap', from: 2, to: 2 });
  assert.equal(first.memoryTask.id, 'river-recap');
  assert.equal(first.memoryTask.stage, 'recap');
  assert.equal(first.memoryTask.scope.atChapter, 2);
  assert.equal(existsSync(first.memoryTask.draftPath), true);
  assert.equal(input.audits.draft('river-recap').reviewed, false);
  fill(input, 'river-recap');
  assert.throws(() => input.audits.save('river-recap'), /memory check artifact|completed/);
  const second = await input.audits.prepare('river-recap', { kind: 'recap', from: 2, to: 2 });
  assert.equal(second.preparedRevision, first.preparedRevision);
  assert.equal(calls, 1);
  assert.equal(input.audits.draft('river-recap').reviewed, true);
  completeMemory(input, 'river-recap');
  const saved = input.audits.save('river-recap');
  assert.equal(saved.status, 'ready');
  assert.equal(input.audits.show('river-recap').fresh, true);
  assert.equal(input.audits.list('recap')[0].status, 'ready');
  assert.equal(input.project.memory().hooks[0].status, 'open');
  assert.equal(input.audits.status().completed, false);
});

test('a saved uncertain memory review is recorded but cannot make a story audit ready', async t => {
  const input = fixture(t); await input.audits.prepare('uncertain-recap', { kind: 'recap' });
  const task = completeMemory(input, 'uncertain-recap', 'uncertain');
  assert.equal(task.status, 'recorded'); assert.equal(task.completed, false);
  fill(input, 'uncertain-recap');
  assert.throws(() => input.audits.save('uncertain-recap'), /completed, fresh memory task/);
});

test('every unclosed hook must be handled once; recap cannot close canon by report', async t => {
  const input = fixture(t); await input.audits.prepare('hook-recap', { kind: 'recap' }); completeMemory(input, 'hook-recap');
  let report = fill(input, 'hook-recap', { hookDecisions: [] });
  assert.throws(() => input.audits.save('hook-recap'), /Every unclosed hook/);
  report = fill(input, 'hook-recap');
  report.hookDecisions[0].disposition = 'needs-resolution'; fill(input, 'hook-recap', { hookDecisions: report.hookDecisions });
  assert.throws(() => input.audits.save('hook-recap'), /Unresolved hook review/);
  report = fill(input, 'hook-recap'); fill(input, 'hook-recap', { hookDecisions: [...report.hookDecisions, ...report.hookDecisions] });
  assert.throws(() => input.audits.save('hook-recap'), /duplicate hook decision/);
  report = fill(input, 'hook-recap'); report.hookDecisions[0].disposition = 'resolved'; fill(input, 'hook-recap', { hookDecisions: report.hookDecisions });
  assert.throws(() => input.audits.save('hook-recap'), /Invalid story audit report/);
  fill(input, 'hook-recap'); input.audits.save('hook-recap');
  assert.equal(input.project.memory().hooks[0].status, 'open');
});

test('finish requires the entire valid book; a recap range cannot masquerade as completion', async t => {
  const input = fixture(t);
  await assert.rejects(input.audits.prepare('partial-finish', { kind: 'finish', from: 2, to: 2 }), /every chapter/);
  await assert.rejects(input.audits.prepare('short-finish', { kind: 'finish', to: 1 }), /every chapter/);
  await assert.rejects(input.audits.prepare('future-recap', { kind: 'recap', to: 3 }), /accepted prefix/);
  input.project.store.invalidateFrom(2);
  await assert.rejects(input.audits.prepare('stale-finish', { kind: 'finish' }), /every chapter/);
  const prior = await input.audits.prepare('valid-prefix-recap', { kind: 'recap', from: 1, to: 1 });
  assert.equal(prior.memoryTask.scope.atChapter, 1);
});

test('finish preserves suspense only with an explicit author decision and never resolves formal hooks', async t => {
  const input = fixture(t); await input.audits.prepare('retained-finish', { kind: 'finish' }); completeMemory(input, 'retained-finish');
  let report = fill(input, 'retained-finish');
  report.hookDecisions[0].authorReason = null; fill(input, 'retained-finish', { hookDecisions: report.hookDecisions });
  assert.throws(() => input.audits.save('retained-finish'), /actual author decision/);
  report = fill(input, 'retained-finish'); report.hookDecisions[0].disposition = 'deferred'; fill(input, 'retained-finish', { hookDecisions: report.hookDecisions });
  assert.throws(() => input.audits.save('retained-finish'), /explicit author-retained suspense/);
  fill(input, 'retained-finish'); const saved = input.audits.save('retained-finish');
  assert.equal(saved.report.hookDecisions[0].authorReason, authorEnd);
  assert.equal(input.project.memory().hooks[0].status, 'open');
});

test('already resolved canonical hooks do not require artificial suspense decisions', async t => {
  const input = fixture(t, { resolvedHook: true });
  const { saved } = await ready(input);
  assert.deepEqual(saved.report.hookInventory, []);
  assert.deepEqual(saved.report.hookDecisions, []);
  assert.equal(input.audits.accept('book-finish', '作者确认这一版已完结。').retainedHooks.length, 0);
  assert.equal(input.project.memory().hooks[0].status, 'resolved');
});

test('unsupported, wrong-version, out-of-range and repeated quotes cannot support saved changes', async t => {
  const input = fixture(t, { repeated: true }); await input.audits.prepare('quotes-recap', { kind: 'recap', from: 2, to: 2 }); completeMemory(input, 'quotes-recap');
  const second = input.project.store.revisions()[1], good = evidence(second);
  for (const quote of [{ ...good, quote: '作者未写过的答案' }, { ...good, revision: 9999 }, { ...good, chapter: 3 }, { ...good, start: 1 }]) {
    fill(input, 'quotes-recap', { summary: { text: '需要核查的总结。', evidence: [quote] } });
    assert.throws(() => input.audits.save('quotes-recap'), /quote|offsets|reviewed range/);
  }
  const first = input.project.store.revisions()[0];
  fill(input, 'quotes-recap', { summary: { text: '错误引用范围。', evidence: [{ chapter: 1, revision: first.id, quote: '林舟在渡口点亮旧灯。' }] } });
  assert.throws(() => input.audits.save('quotes-recap'), /reviewed range/);
  fill(input, 'quotes-recap', { characterChanges: [{ text: '第二章决定调查，引用第一章只是背景。', evidence: [good, { chapter: 1, revision: first.id, quote: '林舟在渡口点亮旧灯。' }] }] });
  assert.throws(() => input.audits.save('quotes-recap'), /Repeated.*offsets/);
  fill(input, 'quotes-recap', { characterChanges: [{ text: '由第一章保管转到第二章调查。', evidence: [good, { chapter: 1, revision: first.id, quote: '林舟在渡口点亮旧灯。', start: 0, end: '林舟在渡口点亮旧灯。'.length }] }] });
  assert.equal(input.audits.save('quotes-recap').status, 'ready');
});

test('machine inventory and scope are immutable; blocking findings require a real resolution', async t => {
  const input = fixture(t); await input.audits.prepare('review-recap', { kind: 'recap' }); completeMemory(input, 'review-recap');
  fill(input, 'review-recap', { hookInventory: [] });
  assert.throws(() => input.audits.save('review-recap'), /machine field/);
  const prepared = load(join(input.root, 'specwriter/story-audits/review-recap/prepared.json'));
  fill(input, 'review-recap', { hookInventory: prepared.hookInventory });
  const quote = evidence(input.project.store.revisions()[1]);
  const finding = { id: 'missing-payoff', severity: 'blocking', description: '需核对开篇承诺。', resolved: false, resolution: null, evidence: [quote] };
  fill(input, 'review-recap', { findings: [finding] });
  assert.throws(() => input.audits.save('review-recap'), /Unresolved blocking/);
  fill(input, 'review-recap', { findings: [{ ...finding, resolved: true }] });
  assert.throws(() => input.audits.save('review-recap'), /substantive resolution/);
  fill(input, 'review-recap', { findings: [{ ...finding, severity: 'warning' }], unknowns: ['作者尚未决定灯主身份的后续解释。'] });
  assert.equal(input.audits.save('review-recap').status, 'ready');
});

test('completion acceptance is explicit, idempotent, transaction-aware and grants no chapter authority', async t => {
  const input = fixture(t), before = json({ revisions: input.project.store.revisions(), contracts: input.project.store.contracts(), policy: input.project.store.policy('arc'), specs: readdirSync(join(input.root, 'specwriter/specs')).map(name => readFileSync(join(input.root, 'specwriter/specs', name), 'utf8')) });
  const { saved } = await ready(input);
  assert.equal(input.audits.status().status, 'unfinished');
  assert.throws(() => input.audits.accept('book-finish', ''), /actual author completion instruction/);
  const receipt = input.project.store.transaction(() => input.audits.accept('book-finish', authorEnd));
  assert.equal(receipt.valid, true); assert.equal(receipt.reportRevision, saved.revision); assert.ok(existsSync(receipt.receiptPath));
  assert.equal(input.audits.accept('book-finish', authorEnd).receiptId, receipt.receiptId);
  assert.equal(input.project.store.transaction(() => input.audits.status()).completed, true);
  assert.equal(input.project.status().storyAudits.value.completed, true);
  assert.equal(input.audits.status().completion.authorReason, authorEnd);
  assert.equal(json({ revisions: input.project.store.revisions(), contracts: input.project.store.contracts(), policy: input.project.store.policy('arc'), specs: readdirSync(join(input.root, 'specwriter/specs')).map(name => readFileSync(join(input.root, 'specwriter/specs', name), 'utf8')) }), before);
});

test('enabling or disabling book backup and changing context size preserves a reviewed completion', async t => {
  const input = fixture(t); await ready(input); const receipt = input.audits.accept('book-finish', authorEnd);
  const backup = new BookVersions(input.root).init(input.project);
  assert.equal(backup.enabled, true);
  assert.equal(input.audits.show('book-finish').fresh, true);
  assert.equal(input.audits.status().completed, true);
  assert.equal(input.audits.status().completion.receiptId, receipt.receiptId);
  const path = join(input.root, 'specwriter/config.yaml'), config = parseDocument(readFileSync(path, 'utf8'));
  config.set('versioning', { enabled: false, autoSave: false }); config.set('contextBudgetChars', 90000); writeFileSync(path, config.toString());
  assert.equal(input.audits.show('book-finish').fresh, true);
  assert.equal(input.audits.lifecycle.show('book-finish').fresh, true);
  assert.equal(input.audits.status().completed, true);
  assert.equal(input.audits.status().completion.receiptId, receipt.receiptId);
});

test('new accepted chapters invalidate completion while old review and receipt files remain readable', async t => {
  const input = fixture(t); const { saved } = await ready(input); const receipt = input.audits.accept('book-finish', authorEnd);
  const historyText = readFileSync(receipt.receiptPath, 'utf8');
  draft(input.project, input.root, 3, '林舟再次启程，去询问旧灯的主人。'); input.project.commit(3, 'arc');
  assert.equal(input.audits.status().completed, false); assert.equal(input.audits.status().status, 'invalidated');
  assert.equal(input.audits.show('book-finish', saved.revision).fresh, false);
  assert.equal(readFileSync(receipt.receiptPath, 'utf8'), historyText);
  assert.throws(() => input.audits.accept('book-finish', authorEnd), /fresh saved finish report/);
  await assert.rejects(input.audits.prepare('book-finish', { kind: 'finish', refresh: true }), /range are immutable/);
  await ready(input, 'book-finish-extended');
  const next = input.audits.accept('book-finish-extended', '作者决定在追加的第三章后完结，灯主仍有意保留。');
  assert.notEqual(next.receiptId, receipt.receiptId); assert.equal(input.audits.status().history.length, 2);
  assert.equal(input.audits.status().completed, true);
});

test('unfinished author guidance and dirty/stale prose invalidate completion instead of reopening automatically', async t => {
  const input = fixture(t); await ready(input); input.audits.accept('book-finish', authorEnd);
  const specs = join(input.root, 'specwriter/specs/style.md'); writeFileSync(specs, readFileSync(specs, 'utf8') + '\n作者正在考虑改变结尾语气。');
  assert.equal(input.audits.status().status, 'invalidated');
  await assert.rejects(input.audits.prepare('book-finish', { kind: 'finish' }), /refresh/);
  await ready(input, 'book-finish', 'finish', { refresh: true }); input.audits.accept('book-finish', authorEnd);
  input.project.instructions.add('future-scene', { text: '作者要求后续考虑新调查方向。', fromChapter: 3 });
  assert.equal(input.audits.status().status, 'invalidated');
  input.project.instructions.retire('future-scene', '作者撤回该方向。');
  assert.equal(input.audits.status().completed, false);
  await ready(input, 'book-finish', 'finish', { refresh: true }); input.audits.accept('book-finish', authorEnd);
  writeFileSync(join(input.root, 'manuscript/chapters/0002.md'), '手工改动尚未接纳。');
  assert.equal(input.audits.status().status, 'invalidated');
  await assert.rejects(input.audits.prepare('dirty-finish', { kind: 'finish' }), /modified canonical/);
});

test('blocking reader feedback requires a decision/application and cannot be bypassed at finish', async t => {
  const input = fixture(t); await ready(input); input.audits.accept('book-finish', authorEnd);
  const reader = new NovelReader(input.project), row = input.project.store.revisions()[1];
  const feedback = reader.addFeedback({ chapterKey: 'accepted:2', bodyHash: row.bodyHash, quote: '决定追查灯主。', start: row.body.indexOf('决定追查灯主。'), end: row.body.length, note: '请先核对为何没有兑现主线答案。', blocking: true });
  assert.equal(input.audits.status().completed, false);
  await assert.rejects(input.audits.prepare('feedback-finish', { kind: 'finish' }), /blocking author feedback/);
  assert.throws(() => reader.resolveFeedback(feedback.id, true), /阻塞批注/);
  reader.feedbackDecision(feedback.id, { decision: 'decline', reason: '作者明确选择开放结局，不采用改成封闭谜底的要求。' });
  await ready(input, 'book-finish', 'finish', { refresh: true });
  assert.equal(input.audits.accept('book-finish', authorEnd).valid, true);
});

test('stale accepted chapters immediately invalidate an existing completion without erasing history', async t => {
  const input = fixture(t); const { saved } = await ready(input); const receipt = input.audits.accept('book-finish', authorEnd);
  input.project.store.invalidateFrom(2);
  assert.equal(input.audits.status().status, 'invalidated');
  assert.equal(input.audits.status().completed, false);
  assert.equal(input.audits.show('book-finish', saved.revision).fresh, false);
  assert.equal(existsSync(receipt.receiptPath), true);
  await assert.rejects(input.audits.prepare('cannot-finish-stale', { kind: 'finish' }), /every chapter/);
});

test('unreviewed story edits and superseding memory reviews prevent reuse of a completion receipt', async t => {
  const input = fixture(t); await ready(input); input.audits.accept('book-finish', authorEnd);
  fill(input, 'book-finish', { reviewNotes: ['新草案尚未保存。'] });
  assert.equal(input.audits.status().completed, false);
  assert.throws(() => input.audits.accept('book-finish', authorEnd), /unreviewed changes/);
  input.audits.save('book-finish'); input.audits.accept('book-finish', authorEnd);
  completeMemory(input, 'book-finish', 'uncertain');
  assert.equal(input.audits.show('book-finish').fresh, false);
  assert.equal(input.audits.status().completed, false);
});

test('bad or missing mutable drafts do not hide saved versions or completion history', async t => {
  const input = fixture(t); const { saved } = await ready(input); const receipt = input.audits.accept('book-finish', authorEnd);
  const draftPath = join(input.root, 'specwriter/story-audits/book-finish/draft.json');
  const pristineDraft = readFileSync(draftPath, 'utf8'), pristineReceipt = readFileSync(receipt.receiptPath, 'utf8');
  for (const damage of [() => writeFileSync(draftPath, '{bad-json'), () => unlinkSync(draftPath)]) {
    damage();
    const current = input.audits.show('book-finish'), historical = input.audits.show('book-finish', saved.revision);
    assert.equal(current.revision, saved.revision); assert.deepEqual(current.report, saved.report);
    assert.equal(current.fresh, true); assert.equal(current.hasDraftChanges, true); assert.match(current.draftError, /JSON|Missing/);
    assert.equal(historical.revision, saved.revision); assert.deepEqual(historical.report, saved.report); assert.equal(typeof historical.draftError, 'string');
    const listed = input.audits.list('finish')[0]; assert.equal(listed.revision, saved.revision); assert.equal(listed.draftError, current.draftError);
    const status = input.project.store.transaction(() => input.audits.status());
    assert.equal(status.status, 'invalidated'); assert.equal(status.completed, false); assert.equal(status.completion.receiptId, receipt.receiptId);
    assert.equal(status.history.length, 1); assert.match(status.reasons.join(' '), /Finish draft cannot be validated/);
    assert.equal(input.project.status().storyAudits.error, null);
    assert.throws(() => input.audits.draft('book-finish'), /JSON|Missing/);
    assert.throws(() => input.audits.save('book-finish'), /JSON|Missing/);
    assert.throws(() => input.audits.accept('book-finish', authorEnd), /unreviewed changes/);
    assert.equal(readFileSync(receipt.receiptPath, 'utf8'), pristineReceipt);
    writeFileSync(draftPath, pristineDraft); assert.equal(input.audits.status().completed, true);
  }
});

test('older published revisions remain inspectable when a newer revision has a malformed draft', async t => {
  const input = fixture(t); const { saved: first } = await ready(input, 'history-recap', 'recap');
  fill(input, 'history-recap', { reviewNotes: ['第二次实际复核仍保留同一调查问题，新增本次审阅说明。'] });
  const second = input.audits.save('history-recap'); assert.notEqual(second.revision, first.revision);
  const draftPath = join(input.root, 'specwriter/story-audits/history-recap/draft.json'); writeFileSync(draftPath, '{');
  const historical = input.audits.show('history-recap', first.revision), current = input.audits.show('history-recap');
  assert.equal(historical.revision, first.revision); assert.deepEqual(historical.report, first.report);
  assert.equal(current.revision, second.revision); assert.deepEqual(current.report, second.report);
  assert.equal(typeof historical.draftError, 'string'); assert.equal(input.audits.list('recap')[0].revision, second.revision);
});

test('a broken unpublished draft is listed separately without hiding a published audit', async t => {
  const input = fixture(t); await ready(input, 'published-recap', 'recap'); await input.audits.prepare('pending-recap', { kind: 'recap' });
  const draftPath = join(input.root, 'specwriter/story-audits/pending-recap/draft.json'); writeFileSync(draftPath, 'not-json');
  const listed = input.audits.list('recap');
  assert.equal(listed.length, 2);
  assert.equal(listed.find(item => item.id === 'published-recap').status, 'ready');
  const pending = listed.find(item => item.id === 'pending-recap'); assert.equal(pending.status, 'draft'); assert.equal(pending.revision, null); assert.equal(typeof pending.draftError, 'string');
  assert.equal(input.audits.status().reports.length, 2);
  assert.throws(() => input.audits.draft('pending-recap'), /JSON/);
});

test('mutations during asynchronous retrieval cannot publish a stale story review packet', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), start = new Promise(resolve => { entered = resolve; });
  const input = fixture(t, { queryer: async () => { entered(); await gate; return { answer: '查询已完成。' }; } });
  const pending = input.audits.prepare('race-recap', { kind: 'recap' }); await start;
  writeFileSync(join(input.root, 'specwriter/specs/style.md'), '作者在等待中修改表达目标。'); release();
  await assert.rejects(pending, /changed|binding|stale/i);
  assert.equal(existsSync(join(input.root, 'specwriter/story-audits/race-recap/current.json')), false);
  assert.equal(existsSync(join(input.root, 'specwriter/story-audits/race-recap/draft.json')), false);
});

test('foreign and altered immutable artifacts are rejected rather than displaying ready completion', async t => {
  const input = fixture(t), other = fixture(t); const { saved } = await ready(input); const receipt = input.audits.accept('book-finish', authorEnd);
  cpSync(join(input.root, 'specwriter/story-audits'), join(other.root, 'specwriter/story-audits'), { recursive: true });
  assert.throws(() => other.audits.show('book-finish'), /foreign/);
  const versionPath = join(input.root, 'specwriter/story-audits/book-finish/versions', saved.revision + '.json');
  const pristine = readFileSync(versionPath, 'utf8'), altered = JSON.parse(pristine); altered.report.summary.text = '伪造的总结。'; writeFileSync(versionPath, json(altered));
  assert.throws(() => input.audits.show('book-finish'), /Altered/);
  writeFileSync(versionPath, pristine);
  const alteredReceipt = load(receipt.receiptPath); alteredReceipt.authorReason = '假造授权'; writeFileSync(receipt.receiptPath, json(alteredReceipt));
  assert.throws(() => input.audits.status(), /Altered/);
});
