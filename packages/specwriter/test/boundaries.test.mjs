import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { assessRetrieval, hash } from '../dist/index.js';
import { book, draft, fact, change } from './boundary-fixture.mjs';
import { assessment } from './contract-fixture.mjs';

test('critical assertions require exact evidence-specific review and extraction changes invalidate it', t => {
  const { root, project } = book(t), body = '林舟来到城门。';
  const input = draft(project, root, 1, body, { facts: [fact('林舟', '位置', '城门', body)] });
  const required = project.reviewRequirements(1, 'arc');
  assert.equal(required.criticalClaims.length, 2); // fact plus the narrative key event
  input.review.critical_checks = [];
  writeFileSync(input.paths.review, JSON.stringify(input.review));
  assert.throws(() => project.commit(1, 'arc'), /Critical claim/);
  for (const verdict of ['uncertain', 'unsupported']) {
    const review = assessment(input.review, project.hashes(1, 'arc'), input.delta);
    review.critical_checks[0].verdict = verdict;
    writeFileSync(input.paths.review, JSON.stringify(review));
    assert.throws(() => project.verify(1, 'arc'), /Critical claim/);
  }
  const review = assessment(input.review, project.hashes(1, 'arc'), input.delta);
  review.critical_checks[0].evidenceQuote = '错误引用'; writeFileSync(input.paths.review, JSON.stringify(review));
  assert.throws(() => project.verify(1, 'arc'), /Critical claim/);
  writeFileSync(input.paths.review, JSON.stringify(assessment(input.review, project.hashes(1, 'arc'), input.delta)));
  input.delta.facts[0].object = '山洞'; writeFileSync(input.paths.delta, JSON.stringify(input.delta));
  assert.throws(() => project.verify(1, 'arc'), /outdated or unknown/);
  assert.equal(project.status().memoryThrough, 0);
});

test('established label cannot turn explicit hearsay or imagined death into world truth', t => {
  const { root, project } = book(t);
  for (const body of ['林舟以为师父死了。', '林舟听说师父死了。', '林舟梦见师父死了。']) {
    draft(project, root, 1, body, { facts: [fact('师父', '生死', '死亡', body)] }, { refresh: true });
    assert.throws(() => project.verify(1, 'arc'), /Subjective-only evidence/);
  }
  const body = '林舟听说师父死了。师父其实活着。';
  draft(project, root, 1, body, { facts: [{ ...fact('师父', '生死', '死亡', '林舟听说师父死了。'), scope: 'belief', holder: '林舟', evidence: { quote: '林舟听说师父死了。', basis: 'reported' } }, fact('师父', '生死', '活着', '师父其实活着。')] }, { refresh: true });
  project.commit(1, 'arc');
  assert.equal(project.query('师父').facts[0].object, '活着');
  assert.ok(project.query('师父', { holder: '林舟' }).facts.some(f => f.scope === 'belief' && f.object === '死亡'));
});

test('location, life, realm and true identity are single-valued across field aliases with preserved history', t => {
  const { root, project } = book(t), body = '林舟活着，在城门，境界是炼气，真实身份是少主。';
  const values = [['location', '城门'], ['生死', '活着'], ['realm', '炼气'], ['identity', '少主']];
  draft(project, root, 1, body, { facts: values.map(([field, value]) => fact('林舟', field, value, body)) }); project.commit(1, 'arc');
  const next = '林舟死在山洞。';
  for (const [field, value] of [['所在地', '山洞'], ['状态', '已死'], ['境界', '筑基'], ['真正身份', '皇子']]) {
    draft(project, root, 2, next, { facts: [fact('林舟', field, value, next)] }, { refresh: true });
    assert.throws(() => project.commit(2, 'arc'), /Single-valued state conflict/);
  }
  draft(project, root, 2, next, { state_changes: [change('林舟', '当前位置', '城门', '山洞', next), change('林舟', '状态', 'alive', '已死', next)], facts: [fact('林舟', '生死', '死亡', next)] }, { refresh: true });
  project.commit(2, 'arc');
  assert.equal(project.memory(1).facts.find(f => f.predicate === '位置').object, '城门');
  assert.equal(project.memory(2).facts.find(f => f.predicate === '位置' && f.validUntilChapter === null).object, '山洞');
  assert.equal(project.memory(2).facts.find(f => f.object === '城门').validUntilChapter, 2);
});

test('retrieval reconciliation reports current state and numeric resource conflicts with canonical provenance', t => {
  const { root, project } = book(t), body = '林舟活着，在旧塔，还剩八枚灵石。';
  draft(project, root, 1, body, {
    entities: [{ id: 'lin', type: 'character', name: '林舟', aliases: ['小舟'], description: '主角', evidence: { quote: body, basis: 'established' } }],
    facts: [fact('林舟', '生死', '活着', body), fact('林舟', '位置', '旧塔', body)],
    resource_changes: [{ entity: '林舟', resource: '灵石', opening: 10, change: -2, closing: 8, evidence: { quote: body, basis: 'established' } }]
  }); project.commit(1, 'arc');
  const receipt = answer => ({ id: 'fixture', answer, answerHash: hash(answer), sources: [{ chapter: 1, revision: 1, bodyHash: hash(body), excerpt: body, citationType: 'entities', citationId: '1' }], unresolvedCitations: [] });
  const report = assessRetrieval(receipt('小舟已经死了。林舟在山洞。林舟还剩十枚灵石。[Data: Entities (1)]'), project.memory());
  assert.equal(report.status, 'conflicting'); assert.equal(report.accepted, false);
  assert.deepEqual(report.conflicts.map(c => c.field), ['生死', '位置', '灵石']);
  assert.equal(report.conflicts[2].expected, '8'); assert.equal(report.conflicts[2].quote, body);
  assert.equal(assessRetrieval(receipt('林舟活着。林舟在旧塔。小舟还剩8枚灵石。'), project.memory()).accepted, true);
  assert.equal(assessRetrieval(receipt('林舟曾经在山洞。林舟听说小舟死了。'), project.memory()).conflicts.length, 0);
  assert.equal(assessRetrieval({ ...receipt('回答'), sources: [] }, project.memory()).evidenceStatus, 'missing');
  assert.equal(assessRetrieval({ ...receipt('回答'), unresolvedCitations: [{ citationType: 'entities', citationId: '2' }] }, project.memory()).accepted, false);
  const oversized = assessRetrieval(receipt('无关内容'.repeat(15000) + '林舟已经死了。'), project.memory());
  assert.equal(oversized.analysisTruncated, true); assert.equal(oversized.checkedCharacters, 60000);
  assert.equal(oversized.accepted, false); // unscanned ending cannot acquire a clean bill of health
});
