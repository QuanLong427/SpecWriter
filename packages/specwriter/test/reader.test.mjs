import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { Project, NovelReader, initProject, startReader, hash, configureMemory } from '../dist/index.js';
import { extraction, assessment } from './contract-fixture.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'specwriter-reader-test-'));
  initProject(root, '废井来信', { memoryBackend: 'local' });
  const project = new Project(root); project.propose('opening', '开篇两章', 1, 2);
  t.after(() => { project.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project, reader: new NovelReader(project) };
}
function draft(project, root, chapter, body, work = 'opening') {
  const result = project.prepare(chapter, work, { query: '林舟' });
  const paths = Object.fromEntries(Object.entries(result.paths).map(([key, path]) => [key, join(root, path)]));
  writeFileSync(paths.draft, body);
  const metadata = project.hashes(chapter, work);
  writeFileSync(paths.delta, JSON.stringify(extraction({ ...load(paths.delta), ...metadata, title: `废井来信 ${chapter}`, summary: '林舟收到一封信。', characters: ['林舟'], key_events: [{ description: '林舟收到信', evidence: { quote: body } }] }, body)));
  writeFileSync(paths.review, JSON.stringify(assessment(load(paths.review), metadata)));
  return paths;
}
function input(chapter, note = '此处让人物多一些迟疑。', quote = '', start = 0) {
  return { chapterKey: chapter.key, bodyHash: chapter.bodyHash, start, end: start + quote.length, quote, note };
}

test('reader uses canonical accepted prose, reads drafts separately, and needs no GraphRAG provider', t => {
  const { root, project, reader } = fixture(t);
  const paths = draft(project, root, 1, '# 废井来信\n\n林舟站在废井前。\n\n信封上没有名字。');
  assert.equal(reader.catalog().chapters.length, 0);
  assert.equal(reader.chapter('draft:opening:1').status, 'draft');
  project.commit(1, 'opening');
  configureMemory(root, { backend: 'microsoft-graphrag' });
  assert.equal(existsSync(join(root, '.specwriter/graphrag/provider.json')), false);
  assert.equal(reader.catalog().trustedThrough, 1);
  const canonical = reader.chapter('accepted:1');
  assert.equal(canonical.revision, 1);
  writeFileSync(join(root, 'manuscript/chapters/0001.md'), '手工改写尚未接纳');
  assert.equal(reader.chapter('accepted:1').body, canonical.body);
  writeFileSync(paths.draft, '新草稿里有另一封信。');
  assert.notEqual(reader.chapter('draft:opening:1').bodyHash, canonical.bodyHash);
  assert.ok(reader.export('txt').content.includes('林舟站在废井前'));
  assert.ok(!reader.export('txt').content.includes('手工改写'));
  assert.equal(project.store.generation(), 1);
});

test('feedback binds duplicate quotes to exact offsets, rejects changed prose, and supports resolve/reopen', t => {
  const { root, project, reader } = fixture(t);
  const paths = draft(project, root, 1, '林舟回头。\n\n林舟回头。');
  const chapter = reader.chapter('draft:opening:1');
  const start = chapter.body.lastIndexOf('林舟回头。');
  const note = reader.addFeedback(input(chapter, '第二次回头应有不同的动机。', '林舟回头。', start));
  assert.equal(note.start, start); assert.equal(note.end, chapter.body.length);
  assert.equal(load(join(root, 'specwriter/feedback', `${note.id}.json`)).bodyHash, chapter.bodyHash);
  assert.equal(project.store.generation(), 0);
  assert.throws(() => reader.addFeedback({ ...input(chapter), quote: '不存在的句子' }), /offsets/);
  assert.throws(() => reader.addFeedback({ ...input(chapter), start: -1 }), /offsets/);
  assert.throws(() => reader.addFeedback(input(chapter, '   ')), /请填写/);
  writeFileSync(paths.draft, '林舟没有回头。');
  assert.throws(() => reader.addFeedback(input(chapter)), /正文已改变/);
  assert.equal(reader.feedback(chapter.key)[0].outdated, true);
  assert.ok(reader.revisionRequest(chapter.key).includes('旧版本批注'));
  assert.equal(reader.resolveFeedback(note.id, true).status, 'resolved');
  assert.equal(reader.revisionRequest(chapter.key), '当前没有未处理的阅读批注。');
  assert.equal(reader.resolveFeedback(note.id, false).status, 'open');
  assert.throws(() => reader.resolveFeedback('../../config', true), /Invalid feedback id/);
});

test('retcon marks later reading as stale, changes annotation freshness and limits every export to trusted prefix', t => {
  const { root, project, reader } = fixture(t);
  draft(project, root, 1, '第一封信藏在废井里。'); project.commit(1, 'opening');
  const old = reader.chapter('accepted:1'); reader.addFeedback(input(old));
  draft(project, root, 2, '第二章揭露了未来的凶手。'); project.commit(2, 'opening');
  project.propose('rewrite', '改写第一章', 1, 1);
  draft(project, root, 1, '第一封信藏在林舟袖中。', 'rewrite'); project.commit(1, 'rewrite');
  assert.equal(reader.catalog().chapters[1].status, 'stale');
  assert.equal(reader.chapter('accepted:2').body, '第二章揭露了未来的凶手。');
  assert.equal(reader.feedback('accepted:1')[0].outdated, true);
  for (const format of ['txt', 'md', 'html']) {
    const output = reader.export(format);
    assert.equal(output.chapters, 1); assert.equal(output.through, 1);
    assert.ok(output.content.includes('林舟袖中')); assert.ok(!output.content.includes('未来的凶手'));
  }
  assert.equal(reader.version(1, old.revision).body, old.body);
  assert.equal(reader.versions(1).length, 2);
  assert.throws(() => reader.version(2, old.revision), /does not exist/);
});

test('standalone HTML escapes prose, exports omit feedback and private data, and author-edited exports are preserved', t => {
  const { root, project, reader } = fixture(t);
  draft(project, root, 1, '林舟收到 <script>alert("信")</script> 和 & 符号。'); project.commit(1, 'opening');
  reader.addFeedback(input(reader.chapter('accepted:1'), '作者私下批注，不可交付。'));
  const html = reader.export('html').content;
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('作者私下批注')); assert.ok(!html.includes('bodyHash'));
  const exported = reader.writeExport('txt');
  assert.equal(load(`${exported.path}.manifest.json`).contentHash, hash(readFileSync(exported.path, 'utf8')));
  assert.equal(reader.writeExport('txt').path, exported.path);
  writeFileSync(exported.path, '作者直接修改了交付稿。');
  assert.throws(() => reader.writeExport('txt'), /手工修改/);
  assert.equal(readFileSync(exported.path, 'utf8'), '作者直接修改了交付稿。');
});

test('draft paths and feedback storage cannot escape a book; malformed feedback fails visibly', t => {
  const { root, project, reader } = fixture(t);
  assert.throws(() => reader.chapter('draft:../outside:1'), /Invalid chapter key/);
  assert.throws(() => reader.catalog({ draft: true, work: '../outside' }), /portable/);
  assert.throws(() => reader.chapter('draft:opening:1'), /Draft does not exist/);
  assert.throws(() => reader.export('html'), /没有可导出/);
  mkdirSync(join(root, 'specwriter/feedback'), { recursive: true });
  writeFileSync(join(root, 'specwriter/feedback/12345678-1234-4123-8123-123456789abc.json'), JSON.stringify({ schemaVersion: 100 }));
  assert.throws(() => reader.feedback(), /Invalid reader feedback record/);
  assert.equal(project.store.generation(), 0);
});

test('local reader HTTP validates session, origin, routes and version-bound writes; exports work without model calls', async t => {
  const { root, project } = fixture(t);
  draft(project, root, 1, '# 废井来信\n\n林舟收到一封信。'); project.commit(1, 'opening');
  const running = await startReader(project);
  t.after(async () => running.close());
  const html = await (await fetch(running.url)).text();
  const token = /name="reader-token" content="([a-f0-9]+)"/.exec(html)[1];
  const headers = { 'X-Reader-Token': token };
  const get = async path => { const response = await fetch(running.url + path, { headers }); assert.equal(response.status, 200); return response.json(); };
  const book = await get('/api/book'); assert.equal(book.chapters.length, 1);
  const chapter = await get('/api/chapter?key=accepted:1');
  assert.equal((await fetch(running.url + '/api/book')).status, 403);
  assert.equal((await fetch(running.url + '/api/book', { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(running.url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(running.url + '/.specwriter/memory/book.db', { headers })).status, 404);
  const posted = await fetch(running.url + '/api/feedback', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: running.url }, body: JSON.stringify(input(chapter)) });
  assert.equal(posted.status, 201);
  const note = await posted.json(); assert.equal((await get('/api/feedback?key=accepted:1'))[0].id, note.id);
  assert.ok((await get('/api/request?key=accepted:1')).text.includes(note.id));
  const denied = await fetch(running.url + '/api/feedback', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input(chapter), bodyHash: 'changed' }) });
  assert.equal(denied.status, 400);
  const resolved = await fetch(running.url + '/api/feedback/resolve', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: note.id, resolved: true }) });
  assert.equal((await resolved.json()).status, 'resolved');
  const exportResponse = await fetch(running.url + '/api/export?format=html', { headers });
  assert.equal(exportResponse.status, 200); assert.match(exportResponse.headers.get('content-disposition'), /attachment/);
  assert.ok((await exportResponse.text()).includes('林舟收到一封信'));
  const savedExport = await fetch(running.url + '/api/export', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'html' }) });
  assert.equal(savedExport.status, 200);
  const saved = await savedExport.json();
  assert.equal(readFileSync(saved.path, 'utf8'), new NovelReader(project).export('html').content);
  assert.equal((await fetch(running.url + '/reader.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(project.store.generation(), 1);
});

test('reader CLI exports and exposes feedback to Codex, with reader references installed in skills', t => {
  const { root, project, reader } = fixture(t);
  draft(project, root, 1, '林舟收到一封信。'); project.commit(1, 'opening');
  const note = reader.addFeedback(input(reader.chapter('accepted:1')));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal(run('export', '--format', 'md').chapters, 1);
  assert.equal(run('feedback', 'list', '--chapter', '1')[0].id, note.id);
  assert.ok(run('feedback', 'request', '--chapter', '1').text.includes(note.id));
  assert.equal(run('feedback', 'resolve', note.id).status, 'resolved');
  assert.equal(run('feedback', 'resolve', note.id, '--reopen').status, 'open');
  assert.ok(readFileSync(join(root, '.agents/skills/specwriter-revise/references/reader.md'), 'utf8').includes('bodyHash'));
});
