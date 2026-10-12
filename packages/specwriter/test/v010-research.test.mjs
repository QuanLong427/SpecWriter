import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchLibrary } from '../dist/research.js';
import { hash, json } from '../dist/files.js';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const payload = { sourceId: 'ranking-oct', title: '十月榜单快照', kind: 'ranking', url: 'https://example.test/ranking', publishedAt: '2026-10-01', observedAt: '2026-10-13T00:00:00.000Z', content: '榜单样本：推理类作品为三部。\n仅含当前页面采样。', metadata: { sampleCount: 3, platform: '测试平台' } };
function fixture(t, kind = 'market', id = 'oct-market') {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v010-research-'));
  mkdirSync(join(root, 'specwriter'));
  writeFileSync(join(root, 'specwriter/config.yaml'), `schemaVersion: 1\nbookId: ${randomUUID()}\nname: 青铜钥匙\nlanguage: zh\ncontextBudgetChars: 30000\nmemory:\n  backend: local\n`);
  const library = new ResearchLibrary(root), draftPath = library.create(id, { kind, title: '十月写作方向', question: '当前样本中哪些方向值得继续验证？', platform: '测试平台', audience: '推理读者', timeWindow: '2026-10' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, library, id, draftPath };
}
function fill(input, patch = {}, source = payload) {
  input.library.capture(input.id, source);
  const report = input.library.draft(input.id);
  Object.assign(report, {
    observations: [{ text: '该页当前样本出现三部推理作品。', evidence: [{ sourceId: source.sourceId, quote: '推理类作品为三部。' }] }],
    interpretations: [{ text: '这个小样本值得继续核查，不能推出全平台偏好。', sourceIds: [source.sourceId] }],
    directions: [{ title: '机关推理', premise: '一把钥匙引出密室谜题。', reason: '先做人物和悬念验证。', sourceIds: [source.sourceId] }],
    unknowns: ['未覆盖榜单之外的作品，也未验证付费表现。'],
  }, patch);
  writeFileSync(input.draftPath, json(report));
  return report;
}
function pointerPath(input) { return join(input.root, 'specwriter/research', input.id, 'current.json'); }
function versionPath(input, revision) { return join(input.root, 'specwriter/research', input.id, 'versions', `${revision}.json`); }
function sourcePath(input, sourceId = payload.sourceId) { return join(input.root, 'specwriter/research', input.id, 'sources', `${sourceId}.json`); }

test('unsupported reports remain drafts and cannot become recorded external evidence', t => {
  const input = fixture(t);
  assert.equal(input.library.list()[0].status, 'draft');
  assert.throws(() => input.library.save(input.id), /real captured source/);
  assert.throws(() => input.library.show(input.id), /Missing research artifact/);
  assert.throws(() => input.library.contextSources([{ id: input.id, purpose: '选择题材' }]), /Missing research artifact/);
  assert.equal(existsSync(pointerPath(input)), false);
});

test('captured source artifacts are immutable, repeatable and independently scoped', t => {
  const input = fixture(t);
  const first = input.library.capture(input.id, payload);
  assert.equal(first.hash, hash(json({ schemaVersion: 1, bookId: first.bookId, reportId: input.id, sourceId: payload.sourceId, content: payload.content })));
  assert.equal(first.bookId, input.library.draft(input.id).bookId);
  assert.deepEqual(input.library.capture(input.id, { ...payload }), first);
  assert.throws(() => input.library.capture(input.id, { ...payload, content: '新榜单' }), /immutable/);
  assert.equal(input.library.source(input.id, payload.sourceId).content, payload.content);
  input.library.create('other-report', { kind: 'analysis', title: '另一个样本', question: '另一个问题' });
  const other = input.library.capture('other-report', { ...payload, content: '独立报告的新来源内容。' });
  assert.equal(other.reportId, 'other-report');
  assert.equal(input.library.listSources(input.id).length, 1);
  assert.equal(input.library.listSources('other-report').length, 1);
  assert.throws(() => input.library.create(input.id, { kind: 'market', title: '覆盖', question: '覆盖' }), /already exists/);
});

test('exact quotes, real source roles and every referenced source are required on save', t => {
  const input = fixture(t);
  fill(input, { observations: [{ text: '未检查的结论。', evidence: [{ sourceId: payload.sourceId, quote: '全平台最受欢迎。' }] }] });
  assert.throws(() => input.library.save(input.id), /quote does not occur/);
  fill(input, { directions: [{ title: '候选', premise: '候选方向', reason: '待验证', sourceIds: ['missing-source'] }] });
  assert.throws(() => input.library.save(input.id), /source is missing/);
  fill(input, { observations: [] });
  assert.throws(() => input.library.save(input.id), /real captured source/);
  const author = { sourceId: 'author-method', title: '作者写作经验', kind: 'author', content: '作者建议：先建立悬念再揭露线索。' };
  input.library.capture(input.id, author);
  fill(input, { observations: [{ text: '作者采用这个写作方法。', evidence: [{ sourceId: author.sourceId, quote: '先建立悬念再揭露线索。' }] }], interpretations: [], directions: [] });
  assert.throws(() => input.library.save(input.id), /real captured source/);
});

test('saved revisions are immutable and draft changes cannot alter selected context', t => {
  const input = fixture(t);
  fill(input);
  const first = input.library.save(input.id);
  assert.equal(first.status, 'recorded');
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(first.reportHash, hash(json(first.report)));
  assert.equal(payload.content.slice(first.quoteLocations[0].start, first.quoteLocations[0].end), first.report.observations[0].evidence[0].quote);
  const path = versionPath(input, first.revision), original = readFileSync(path, 'utf8');
  const reference = { id: input.id, purpose: '判断是否采用机关推理方向' };
  const context = input.library.contextSources([reference])[0];
  assert.equal(context.kind, 'research');
  assert.equal(context.protection, 'protected');
  assert.match(context.content, /never established story canon/);
  assert.equal(context.content.includes('仅含当前页面采样。'), false);
  assert.equal(JSON.parse(context.content).sources[0].content, undefined);
  const report = input.library.draft(input.id);
  report.title = '尚未保存的新标题';
  report.directions[0].title = '修订后的方向';
  writeFileSync(input.draftPath, json(report));
  assert.equal(input.library.contextSources([reference])[0].hash, context.hash);
  assert.equal(input.library.show(input.id).report.directions[0].title, '机关推理');
  assert.equal(input.library.list()[0].title, first.report.title);
  assert.equal(input.library.list()[0].hasDraftChanges, true);
  const second = input.library.save(input.id);
  assert.notEqual(second.revision, first.revision);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(input.library.show(input.id).report.directions[0].title, '修订后的方向');
  assert.equal(input.library.contextSources([{ ...reference, revision: first.revision }])[0].hash, context.hash);
  assert.deepEqual(input.library.save(input.id), second);
  assert.equal(input.library.list()[0].revision, second.revision);
  assert.equal(input.library.list()[0].hasDraftChanges, false);
});

test('craft can record builtin guidance but context explicitly distinguishes its evidence role', t => {
  const input = fixture(t, 'craft', 'suspense-method');
  const source = { sourceId: 'builtin-suspense', title: '悬念写作方法', kind: 'builtin', content: '先展示问题，再控制线索揭露。' };
  input.library.capture(input.id, source);
  const report = input.library.draft(input.id);
  report.observations = [{ text: '可供作者选择的技巧。', evidence: [{ sourceId: source.sourceId, quote: '控制线索揭露。' }] }];
  writeFileSync(input.draftPath, json(report));
  input.library.save(input.id);
  const context = JSON.parse(input.library.contextSources([{ id: input.id, purpose: '设计章节悬念' }])[0].content);
  assert.match(context.sources[0].evidenceRole, /not market evidence/);
  assert.match(context.integrity, /do not prove conclusions/);
});

test('missing, altered and recomputed source artifacts fail closed for recorded versions', t => {
  const input = fixture(t);
  fill(input); input.library.save(input.id);
  const path = sourcePath(input), original = readFileSync(path, 'utf8');
  rmSync(path);
  assert.throws(() => input.library.show(input.id), /missing/i);
  writeFileSync(path, original);
  const artifact = read(path);
  artifact.content = '篡改来源正文。';
  writeFileSync(path, json(artifact));
  assert.throws(() => input.library.show(input.id), /altered or foreign/);
  writeFileSync(path, original);
  const recomputed = read(path);
  recomputed.title = '未经保存的新标题';
  const { checksum: ignored, ...withoutChecksum } = recomputed;
  recomputed.checksum = hash(json(withoutChecksum));
  writeFileSync(path, json(recomputed));
  assert.throws(() => input.library.contextSources([{ id: input.id, purpose: '参考' }]), /hashes have changed/);
});

test('uncited draft sources cannot contaminate or block a pinned recorded report', t => {
  const input = fixture(t);
  fill(input); const saved = input.library.save(input.id);
  const reference = { id: input.id, purpose: '使用已保存样本', revision: saved.revision };
  const originalHash = input.library.contextSources([reference])[0].hash;
  input.library.capture(input.id, { sourceId: 'uncited-draft', kind: 'file', title: '未引用的新资料', content: '未完成的新草稿来源。' });
  const unrelatedPath = sourcePath(input, 'uncited-draft'), unrelated = read(unrelatedPath);
  unrelated.content = '该未引用文件被直接改动。';
  writeFileSync(unrelatedPath, json(unrelated));
  assert.equal(input.library.show(input.id, saved.revision).revision, saved.revision);
  assert.equal(input.library.contextSources([reference])[0].hash, originalHash);
  assert.equal(input.library.show(input.id).revision, saved.revision);
  assert.throws(() => input.library.listSources(input.id), /altered or foreign/);
  const cited = read(sourcePath(input)); cited.content = '已被引用的来源发生改动。';
  writeFileSync(sourcePath(input), json(cited));
  assert.throws(() => input.library.show(input.id, saved.revision), /altered or foreign/);
  assert.throws(() => input.library.contextSources([reference]), /altered or foreign/);
});

test('pointer, immutable version and unknown files cannot be silently overwritten', t => {
  const input = fixture(t);
  fill(input); const saved = input.library.save(input.id);
  const version = versionPath(input, saved.revision), original = readFileSync(version, 'utf8');
  const altered = read(version); altered.report.title = '未经保存的新结论';
  writeFileSync(version, json(altered));
  assert.throws(() => input.library.show(input.id), /altered or foreign/);
  assert.throws(() => input.library.save(input.id), /altered or foreign/);
  assert.equal(read(version).report.title, '未经保存的新结论');
  writeFileSync(version, original);
  const pointer = read(pointerPath(input)); pointer.revision = 'a'.repeat(64);
  writeFileSync(pointerPath(input), json(pointer));
  assert.throws(() => input.library.show(input.id), /publication pointer/);
  assert.throws(() => input.library.show(input.id, saved.revision), /publication pointer/);
  assert.throws(() => input.library.save(input.id), /publication pointer/);
  assert.equal(read(pointerPath(input)).revision, 'a'.repeat(64));
});

test('book identity blocks copied sources, pointers, versions and drafts', t => {
  const input = fixture(t), other = fixture(t);
  fill(input); input.library.save(input.id);
  cpSync(join(input.root, 'specwriter/research', input.id), join(other.root, 'specwriter/research', other.id), { recursive: true, force: true });
  assert.throws(() => other.library.source(other.id, payload.sourceId), /foreign/);
  assert.throws(() => other.library.draft(other.id), /foreign/);
  assert.throws(() => other.library.show(other.id), /foreign/);
});

test('capture rejects a copied foreign draft-only container before writing new sources', t => {
  const input = fixture(t), other = fixture(t);
  cpSync(join(input.root, 'specwriter/research', input.id), join(other.root, 'specwriter/research', other.id), { recursive: true, force: true });
  assert.throws(() => other.library.capture(other.id, payload), /valid draft container.*foreign/);
  assert.equal(existsSync(sourcePath(other)), false);
  assert.equal(existsSync(join(other.root, 'specwriter/research', other.id, 'sources')), false);
  assert.equal(read(other.draftPath).bookId, input.library.draft(input.id).bookId);
});

test('portable ids, revision paths, credentials and bounded source fields are enforced', t => {
  const input = fixture(t);
  assert.throws(() => input.library.create('../escape', { kind: 'market', title: '标题', question: '问题' }), /portable/);
  assert.throws(() => input.library.capture(input.id, { ...payload, sourceId: 'con' }), /portable/);
  assert.throws(() => input.library.capture(input.id, { ...payload, sourceId: '../escape' }), /portable/);
  assert.throws(() => input.library.capture(input.id, { ...payload, kind: 'web', url: undefined }), /require an HTTP\(S\) URL/);
  assert.throws(() => input.library.capture(input.id, { ...payload, url: undefined }), /require an HTTP\(S\) URL/);
  assert.throws(() => input.library.capture(input.id, { ...payload, url: 'https://user:password@example.test/ranking' }), /without credentials/);
  assert.throws(() => input.library.capture(input.id, { ...payload, url: 'file:///outside.txt' }), /without credentials/);
  assert.throws(() => input.library.capture(input.id, { ...payload, content: '长'.repeat(250001) }), /Invalid research source/);
  assert.throws(() => input.library.capture(input.id, { ...payload, metadata: { nested: { content: '全文' } } }), /Invalid research source/);
  assert.throws(() => input.library.capture(input.id, { ...payload, surprise: 'unchecked' }), /capture fields/);
  assert.throws(() => input.library.show(input.id, '../escape'), /SHA-256/);
  assert.throws(() => input.library.contextSources([{ id: input.id, purpose: '' }]), /purpose/);
  assert.throws(() => input.library.contextSources([{ id: input.id, purpose: '用途' }, { id: input.id, purpose: '第二用途' }]), /unique research/);
  const report = input.library.draft(input.id); report.extra = 'unchecked'; writeFileSync(input.draftPath, json(report));
  assert.throws(() => input.library.save(input.id), /Invalid research report/);
});

test('research directories cannot redirect immutable artifacts through junctions', t => {
  const input = fixture(t), outside = mkdtempSync(join(tmpdir(), 'specwriter-v010-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const directory = join(input.root, 'specwriter/research', input.id, 'sources');
  try { symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Creating test links is not available'); return; } throw error; }
  assert.throws(() => input.library.capture(input.id, payload), /link outside|symbolic links/);
  assert.equal(existsSync(join(outside, `${payload.sourceId}.json`)), false);
});

test('legacy projects can read an empty library without unsafe null-scoped research writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-v010-legacy-research-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'specwriter'));
  const config = join(root, 'specwriter/config.yaml');
  const original = 'schemaVersion: 1\nname: 旧小说\nlanguage: zh\ncontextBudgetChars: 30000\nmemory:\n  backend: local\n';
  writeFileSync(config, original);
  const library = new ResearchLibrary(root);
  assert.deepEqual(library.list(), []);
  assert.deepEqual(library.contextSources([]), []);
  assert.throws(() => library.create('old-research', { kind: 'market', title: '旧书研究', question: '身份尚未迁移' }), /缺稳定bookId/);
  assert.throws(() => library.capture('old-research', payload), /缺稳定bookId/);
  assert.throws(() => library.show('old-research'), /缺稳定bookId/);
  assert.throws(() => library.source('old-research', payload.sourceId), /缺稳定bookId/);
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.equal(existsSync(join(root, 'specwriter/research')), false);
});
