// Deterministic workflow exercise. This is a 24-chapter fixture, not a literary quality benchmark.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, NovelReader, initProject } from '../dist/index.js';
import { demoReview } from './artifacts.mjs';

const root = mkdtempSync(join(tmpdir(), 'specwriter-sustained-'));
initProject(root, '小舟的二十四站 · 工作流样本', { memoryBackend: 'local' });
const project = new Project(root), reader = new NovelReader(project);
const load = path => JSON.parse(readFileSync(path, 'utf8'));
function accept(chapter, work, revised = false) {
  let prepared = project.prepare(chapter, work, { query: '林舟 小舟 铜匣 灵石' });
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, path]) => [key, join(root, path)]));
  writeFileSync(paths.intent, `# 第${chapter}站\n\n推进行程，核对灵石余额；${chapter < 24 ? '保留铜匣的秘密。' : '兑现铜匣悬念。'}\n`);
  prepared = project.prepare(chapter, work, { query: '林舟 小舟 铜匣 灵石', refresh: true });
  const previous = project.memory(chapter - 1);
  const room = revised ? '第五站南楼' : `第${chapter}站客舍`;
  const name = chapter % 2 ? '林舟' : '小舟';
  const body = `${chapter === 1 ? '林舟的旧称是小舟。他带着四十枚灵石和一个上锁的铜匣出门。\n\n' : ''}${name}抵达${room}，付了一枚灵石，剩下${40 - chapter}枚。${chapter === 12 ? '他发现铜匣锁孔里的字样指向终点。' : chapter === 24 ? '他用终点的钥匙打开铜匣，里面是母亲留下的路线图。' : '铜匣依旧锁着。'}`;
  writeFileSync(paths.draft, body);
  const evidence = { quote: body, basis: 'established' }, metadata = project.hashes(chapter, work);
  const delta = { ...load(paths.delta), ...metadata, title: `第${chapter}站`, summary: body, characters: [name],
    key_events: [{ description: `${name}抵达${room}`, evidence }],
    entities: chapter === 1 ? [{ id: 'lin-zhou', name: '林舟', type: 'character', aliases: ['小舟'], description: '带着铜匣旅行的人', evidence }] : [],
    state_changes: [{ entity: name, field: '位置', old_value: previous.facts.find(item => item.validUntilChapter === null && item.subject === 'lin-zhou' && item.predicate === '位置')?.object ?? null, new_value: room, reason: null, scope: 'world', holder: null, evidence }],
    resource_changes: [{ entity: name, resource: '灵石', opening: 41 - chapter, change: -1, closing: 40 - chapter, evidence }],
    narrative_events: [{ id: `station-${chapter}`, description: `抵达${room}`, participants: [name], location: room, story_time: `旅途第${chapter}日`, causes: chapter > 1 ? [`station-${chapter - 1}`] : [], scope: 'world', holder: null, evidence }],
    foreshadow_updates: [1, 12, 24].includes(chapter) ? [{ id: 'locked-box', action: chapter === 1 ? 'plant' : chapter === 12 ? 'advance' : 'resolve', description: chapter === 1 ? '铜匣里的秘密' : null, evidence }] : [] };
  writeFileSync(paths.delta, JSON.stringify(delta));
  writeFileSync(paths.review, JSON.stringify(demoReview(load(paths.review), metadata, delta)));
  project.verify(chapter, work); project.commit(chapter, work);
}
try {
  project.propose('journey', '二十四站行程', 1, 24);
  for (let chapter = 1; chapter <= 24; chapter++) accept(chapter, 'journey');
  assert.equal(project.memory(12).resources[0].amount, 28);
  assert.equal(project.memory(12).hooks[0].status, 'progressing');
  assert.equal(project.memory().hooks[0].status, 'resolved');
  assert.equal(project.memory().facts.filter(item => item.validUntilChapter === null && item.predicate === '位置').length, 1);
  assert.equal(project.memory().resources[0].amount, 16);
  const fifth = reader.chapter('accepted:5'), quote = '林舟抵达第5站客舍';
  const start = fifth.body.indexOf(quote);
  const feedback = reader.addFeedback({ chapterKey: fifth.key, bodyHash: fifth.bodyHash, quote, start, end: start + quote.length, note: '将第五站改到南楼。' });
  project.propose('south-wing', '改第五站地点并协调后续', 5, 24);
  accept(5, 'south-wing', true);
  assert.equal(project.status().memoryThrough, 5);
  assert.equal(reader.feedback('accepted:5')[0].outdated, true);
  assert.equal(reader.export('txt').chapters, 5);
  for (let chapter = 6; chapter <= 24; chapter++) accept(chapter, 'south-wing');
  reader.resolveFeedback(feedback.id, true);
  project.archive('south-wing'); project.archive('journey');
  reader.savePreferences({ settings: { font: 22, leading: 2.35, theme: 'dark' }, positions: { accepted: { key: 'accepted:24', ratio: 0.6, bodyHash: reader.chapter('accepted:24').bodyHash } } });
  const exported = reader.writeExport('html');
  assert.equal(project.status().staleChapters.length, 0);
  assert.equal(project.doctor().healthy, true);
  assert.equal(project.memory().resources[0].entity, 'lin-zhou');
  console.log(JSON.stringify({ root, fixtureChapters: 24, acceptedRevisions: project.store.generation(), reconciledThrough: project.status().memoryThrough, singleCharacterState: true, resourceBalance: 16, hookResolved: true, retconAndFeedbackVerified: true, readerPreferences: reader.preferences(), export: exported, modelCalls: 0 }, null, 2));
} finally { project.close(); }
