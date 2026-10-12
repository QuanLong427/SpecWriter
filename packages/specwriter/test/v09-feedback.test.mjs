import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Project, NovelReader, initProject, startReader } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v09-feedback-'));
  initProject(root, '井边旧信', { memoryBackend: 'local', workflow: 'legacy' });
  const project = new Project(root); project.propose('opening', '开篇', 1, 3);
  const prepared = project.prepare(1, 'opening', { query: '林舟' });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, path]) => [key, join(root, path)]));
  const body = '# 井边旧信\n\n林舟回头。\n\n林舟回头。';
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(1, 'opening');
  const delta = extraction({ ...load(paths.delta), ...metadata, title: '井边旧信', summary: '林舟回头。', characters: ['林舟'], key_events: [{ description: '林舟回头', evidence: { quote: body } }] }, body);
  writeFileSync(paths.delta, JSON.stringify(delta));
  const review = assessment(load(paths.review), metadata, delta);
  writeFileSync(paths.review, JSON.stringify(review));
  const reader = new NovelReader(project);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project, reader, paths, body, delta, review, context: load(paths.context) };
}
function input(chapter, blocking = true) {
  const quote = '林舟回头。'; const start = chapter.body.lastIndexOf(quote);
  return { chapterKey: chapter.key, bodyHash: chapter.bodyHash, start, end: start + quote.length, quote, note: '第二次回头要有迟疑，不要揭露寄信人。', blocking };
}
function notePath(root, id) { return join(root, 'specwriter', 'feedback', `${id}.json`); }

test('v0.9 feedback remains compatible with unextended schemaVersion 1 and validates blocking', t => {
  const { root, reader } = fixture(t);
  const chapter = reader.chapter('draft:opening:1');
  assert.throws(() => reader.addFeedback({ ...input(chapter), blocking: 'true' }), /Invalid feedback fields/);
  const note = reader.addFeedback(input(chapter, false));
  const legacy = load(notePath(root, note.id)); delete legacy.blocking;
  writeFileSync(notePath(root, note.id), JSON.stringify(legacy));
  assert.equal(reader.feedback()[0].schemaVersion, 1);
  assert.equal(reader.feedback()[0].blocking, false);
  assert.equal(reader.resolveFeedback(note.id, true).resolutionKind, 'manual');
  assert.equal(reader.feedback()[0].applied, undefined);
});

test('blocking draft feedback gates only its work; decisions require reasons and manual resolve cannot bypass', t => {
  const { root, reader } = fixture(t);
  const note = reader.addFeedback(input(reader.chapter('draft:opening:1')));
  assert.throws(() => reader.assertFeedbackAdvance(1, 'opening'), /阻塞批注/);
  assert.throws(() => reader.assertFeedbackAdvance(2, 'opening'), /阻塞批注/);
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'another'));
  assert.throws(() => reader.resolveFeedback(note.id, true), /不能用人工标记/);
  assert.throws(() => reader.feedbackDecision(note.id, { decision: 'decline', reason: ' ' }), /requires/);
  reader.feedbackDecision(note.id, { decision: 'clarify', reason: '需要作者解释人物迟疑的动机。' });
  assert.throws(() => reader.assertFeedbackAdvance(1, 'opening'), /阻塞批注/);
  // Older tools may have manually resolved a blocking record. This is still not an author decision.
  const tampered = load(notePath(root, note.id)); tampered.status = 'resolved'; tampered.resolutionKind = 'manual';
  writeFileSync(notePath(root, note.id), JSON.stringify(tampered));
  assert.throws(() => reader.assertFeedbackAdvance(2, 'opening'), /阻塞批注/);
  const declined = reader.feedbackDecision(note.id, { decision: 'decline', reason: '作者希望保留直接回头的节奏。' });
  assert.equal(declined.status, 'resolved'); assert.equal(declined.resolutionKind, 'decision');
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'opening'));
});

test('accepted blocking feedback gates later chapters across works but permits its exact adopted revision', t => {
  const { project, reader } = fixture(t);
  project.commit(1, 'opening');
  const note = reader.addFeedback(input(reader.chapter('accepted:1')));
  assert.throws(() => reader.assertFeedbackAdvance(2, 'another'), /阻塞批注/);
  project.store.addWork({ id: 'rewrite', title: '修订第一章', fromChapter: 1, toChapter: 1, status: 'active' });
  reader.feedbackDecision(note.id, { decision: 'adopt', reason: '采纳作者迟疑要求。', workId: 'rewrite' });
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(1, 'rewrite'));
  assert.throws(() => reader.assertFeedbackAdvance(1, 'opening'), /阻塞批注/);
  assert.throws(() => reader.assertFeedbackAdvance(2, 'rewrite'), /阻塞批注/);
  assert.throws(() => reader.resolveFeedback(note.id, true), /不能用人工标记/);
});

test('adopting draft blocking feedback into another work also gates that target work beyond the source chapter', t => {
  const { project, reader } = fixture(t);
  const note = reader.addFeedback(input(reader.chapter('draft:opening:1')));
  project.store.addWork({ id: 'rewrite', title: '修订前两章', fromChapter: 1, toChapter: 2, status: 'active' });
  reader.feedbackDecision(note.id, { decision: 'adopt', reason: '在新修订包落实草稿意见。', workId: 'rewrite' });
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(1, 'rewrite'));
  assert.throws(() => reader.assertFeedbackAdvance(2, 'rewrite'), /阻塞批注/);
  assert.throws(() => reader.assertFeedbackAdvance(1, 'opening'), /阻塞批注/);
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'unrelated'));
  reader.feedbackDecision(note.id, { decision: 'decline', reason: '作者明确撤回这次修改要求。' });
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'rewrite'));
});

test('outdated feedback adoption requires exact relocated quote offsets; original record and directive are immutable', t => {
  const { root, project, reader, paths } = fixture(t);
  const source = reader.chapter('draft:opening:1');
  const note = reader.addFeedback(input(source));
  writeFileSync(paths.draft, `新开头。\n\n${source.body}`);
  const current = reader.chapter(source.key), start = current.body.lastIndexOf(note.quote);
  assert.throws(() => reader.feedbackDecision(note.id, { decision: 'adopt', reason: '重新定位并采纳。', workId: 'opening' }), /重新定位/);
  const anchor = { bodyHash: current.bodyHash, start, end: start + note.quote.length, quote: note.quote };
  assert.throws(() => reader.feedbackDecision(note.id, { decision: 'adopt', reason: '重新定位并采纳。', workId: 'opening', anchor: { ...anchor, start: 0 } }), /exact quote offsets/);
  project.store.addWork({ id: 'wrong', title: '下一章', fromChapter: 2, toChapter: 2, status: 'active' });
  assert.throws(() => reader.feedbackDecision(note.id, { decision: 'adopt', reason: '采纳。', workId: 'wrong', anchor }), /covering/);
  const adopted = reader.feedbackDecision(note.id, { decision: 'adopt', reason: '重新定位并采纳。', workId: 'opening', anchor });
  assert.equal(adopted.bodyHash, source.bodyHash); assert.equal(adopted.start, note.start);
  assert.deepEqual(adopted.decision.anchor, anchor);
  assert.equal(adopted.decision.directive.sourceBodyHash, current.bodyHash);
  const saved = load(notePath(root, note.id));
  assert.equal(reader.feedbackDecision(note.id, { decision: 'adopt', reason: '重新定位并采纳。', workId: 'opening', anchor }).id, note.id);
  assert.deepEqual(load(notePath(root, note.id)), saved);
  assert.throws(() => reader.feedbackDecision(note.id, { decision: 'adopt', reason: '改主意，切换目标。', workId: 'wrong', anchor }), /immutable/);
  const guidance = reader.guidance(1, 'opening');
  writeFileSync(paths.draft, '林舟迟疑后回头，不知寄信人是谁。');
  assert.deepEqual(reader.guidance(1, 'opening'), guidance);
  assert.deepEqual(reader.guidance(2, 'opening'), []);
});

test('an author can withdraw adoption with a reason and adopt another work while keeping immutable history', t => {
  const { project, reader } = fixture(t);
  project.commit(1, 'opening');
  project.store.addWork({ id: 'rewrite', title: '修订第一章', fromChapter: 1, toChapter: 1, status: 'active' });
  const note = reader.addFeedback(input(reader.chapter('accepted:1')));
  reader.feedbackDecision(note.id, { decision: 'adopt', reason: '先采纳到开篇。', workId: 'opening' });
  const original = reader.guidance(1, 'opening')[0];
  const withdrawn = reader.feedbackDecision(note.id, { decision: 'decline', reason: '作者暂时保留原正文，另建修订包。' });
  assert.equal(withdrawn.status, 'resolved');
  assert.deepEqual(withdrawn.decisionHistory[0].directive, original);
  assert.deepEqual(reader.guidance(1, 'opening'), []);
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'opening'));
  const readopted = reader.feedbackDecision(note.id, { decision: 'adopt', reason: '只在新修订包落实。', workId: 'rewrite' });
  assert.equal(readopted.decisionHistory.length, 2);
  assert.deepEqual(readopted.decisionHistory[0].directive, original);
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(1, 'rewrite'));
  assert.throws(() => reader.assertFeedbackAdvance(2, 'opening'), /阻塞批注/);
});

test('applied feedback requires its immutable directive in the actual accepted target revision', t => {
  const { project, reader, body, delta, review, context } = fixture(t);
  const note = reader.addFeedback(input(reader.chapter('draft:opening:1')));
  reader.feedbackDecision(note.id, { decision: 'adopt', reason: '采纳，不泄露寄信人。', workId: 'opening' });
  const guidance = reader.guidance(1, 'opening');
  const wrong = project.store.accept(body, delta, review, context, 'opening');
  assert.throws(() => reader.markFeedbackApplied(1, 'opening', wrong), /does not contain/);
  assert.equal(reader.feedback()[0].applied, undefined);
  const revision = project.store.accept(body, delta, review, { ...context, authorGuidance: { feedback: guidance } }, 'opening');
  assert.throws(() => reader.markFeedbackApplied(1, 'another', revision), /target work/);
  assert.throws(() => reader.markFeedbackApplied(1, 'opening', wrong), /current accepted/);
  const applied = reader.markFeedbackApplied(1, 'opening', revision)[0];
  assert.equal(applied.status, 'resolved'); assert.equal(applied.resolutionKind, 'applied');
  assert.equal(applied.applied.revisionId, revision); assert.equal(applied.applied.bodyHash, reader.chapter('accepted:1').bodyHash);
  assert.throws(() => reader.resolveFeedback(note.id, false), /已落实意见请新增批注/);
  const stillApplied = reader.resolveFeedback(note.id, true);
  assert.equal(stillApplied.resolutionKind, 'applied');
  assert.deepEqual(stillApplied.applied, applied.applied);
  assert.equal(stillApplied.status, 'resolved');
  assert.deepEqual(reader.guidance(1, 'opening'), guidance);
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'opening'));
  const acceptedBody = reader.chapter('accepted:1').body;
  const withdrawn = reader.feedbackDecision(note.id, { decision: 'decline', reason: '已落实的内容保留，取消后续采用。' });
  assert.equal(withdrawn.applied.revisionId, revision);
  assert.equal(reader.chapter('accepted:1').body, acceptedBody);
  assert.equal(withdrawn.decisionHistory[0].decision, 'adopt');
  assert.deepEqual(reader.guidance(1, 'opening'), []);
  assert.doesNotThrow(() => reader.assertFeedbackAdvance(2, 'opening'));
});

test('nonblocking adopted feedback remains in guidance even after an author manual resolution', t => {
  const { reader } = fixture(t);
  const note = reader.addFeedback(input(reader.chapter('draft:opening:1'), false));
  reader.feedbackDecision(note.id, { decision: 'adopt', reason: '采纳文风意见。', workId: 'opening' });
  const guidance = reader.guidance(1, 'opening');
  reader.resolveFeedback(note.id, true);
  assert.deepEqual(reader.guidance(1, 'opening'), guidance);
  assert.equal(reader.feedback()[0].resolutionKind, 'manual');
  assert.equal(reader.feedback()[0].applied, undefined);
});

test('reader HTTP persists blocking and decisions, rejects bypasses, and copies book identity', async t => {
  const { project, reader, root } = fixture(t);
  const running = await startReader(project, { draft: true, work: 'opening' });
  t.after(() => running.close());
  const html = await (await fetch(running.url)).text();
  const token = /name="reader-token" content="([a-f0-9]+)"/.exec(html)[1];
  const headers = { 'X-Reader-Token': token, 'Content-Type': 'application/json', Origin: running.url };
  const post = (path, input) => fetch(running.url + path, { method: 'POST', headers, body: JSON.stringify(input) });
  const response = await post('/api/feedback', input(reader.chapter('draft:opening:1')));
  assert.equal(response.status, 201); const note = await response.json(); assert.equal(note.blocking, true);
  const request = reader.revisionRequest(note.chapterKey);
  assert.ok(request.includes('bookId')); assert.ok(request.includes('井边旧信')); assert.ok(request.includes(JSON.stringify(root)));
  assert.ok(request.includes('是否先处理再继续：是')); assert.ok(request.includes('人工 feedback resolve'));
  assert.ok(request.includes('feedback decide')); assert.ok(!request.includes('feedback decision'));
  const bypass = await post('/api/feedback/resolve', { id: note.id, resolved: true }); assert.equal(bypass.status, 400);
  const invalid = await post('/api/feedback/decision', { id: note.id, decision: 'decline', reason: '' }); assert.equal(invalid.status, 400);
  const decision = await post('/api/feedback/decision', { id: note.id, decision: 'clarify', reason: '请作者说明试探动机。' });
  assert.equal(decision.status, 200); assert.equal((await decision.json()).status, 'open');
  assert.match(html, /先处理这条意见，再继续写作/);
});
