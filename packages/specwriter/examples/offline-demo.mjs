import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, Project } from '../dist/index.js';
import { demoReview } from './artifacts.mjs';

// Deterministic, model-free demonstration of the same artifact protocol used by Codex Skills.
const root = mkdtempSync(join(tmpdir(), 'specwriter-demo-'));
initProject(root, '废井中的青铜钥匙', { memoryBackend: 'local' });
const project = new Project(root);
const parse = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const save = (path, value) => writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
try {
  project.sync();
  project.propose('opening', '开篇两章', 1, 2);
  writeFileSync(join(root, 'specwriter/specs/premise.md'), '# 已采用的创作约定\n\n悬疑冒险；围绕青铜钥匙与师父失踪展开。\n');
  writeFileSync(join(root, 'specwriter/plans/outline.md'), '# 未来计划\n\n开篇发现钥匙，后续逐步探索师父失踪的真相。\n');
  const passages = [
    { title: '废井', body: '林舟在废井的淤泥里摸到一把青铜钥匙。钥匙上刻着师父的名字，他把它藏进衣袋。', changes: { entity: '青铜钥匙', field: '持有者', old_value: null, new_value: '林舟' } },
    { title: '门后的呼吸', body: '林舟把青铜钥匙插进石门。门后传来师父的咳嗽声，他却没有推门。林舟相信师父还活着。', changes: null }
  ];
  for (const [index, passage] of passages.entries()) {
    const chapter = index + 1;
    let prepared = project.prepare(chapter, 'opening', { query: '林舟 青铜钥匙 师父' });
    writeFileSync(join(root, prepared.paths.draft), passage.body + '\n');
    writeFileSync(join(root, prepared.paths.intent), `# 第${chapter}章意图\n\n${passage.title}：用发现和行动推进悬念。\n`);
    prepared = project.prepare(chapter, 'opening', { query: '林舟 青铜钥匙 师父', refresh: true });
    const metadata = project.hashes(chapter, 'opening');
    const evidence = { quote: passage.body, basis: 'established' };
    const delta = { ...parse(prepared.paths.delta), ...metadata, title: passage.title, summary: passage.body, characters: ['林舟'], key_events: [{ description: passage.title, evidence }] };
    delta.entities = [{ id: 'lin-zhou', name: '林舟', type: 'character', aliases: [], description: '探索师父失踪真相的人物', evidence }];
    delta.narrative_events = [{ id: chapter === 1 ? 'find-key' : 'try-door', description: chapter === 1 ? '林舟在废井拾取钥匙' : '林舟尝试开门，听见咳嗽声', story_time: null, participants: ['lin-zhou'], location: chapter === 1 ? '废井' : '石门', causes: [], scope: 'world', holder: null, evidence }];
    delta.foreshadow_updates = [{ id: 'masters-disappearance', action: chapter === 1 ? 'plant' : 'advance', description: chapter === 1 ? '师父失踪与青铜钥匙的联系' : null, evidence }];
    if (passage.changes) delta.state_changes.push({ ...passage.changes, reason: null, scope: 'world', holder: null, evidence });
    else delta.facts.push({ subject: '师父', predicate: '状态', object: '活着', scope: 'belief', holder: '林舟', evidence: { ...evidence, basis: 'inferred' } });
    save(prepared.paths.delta, delta);
    save(prepared.paths.review, demoReview(parse(prepared.paths.review), metadata, parse(prepared.paths.delta)));
    project.verify(chapter, 'opening'); project.commit(chapter, 'opening');
  }
  project.archive('opening');
  console.log(JSON.stringify({ root, status: project.status(), memory: project.query('青铜钥匙'), graph: project.query('林舟', { hops: 2 }).graph, beliefs: project.query('师父', { holder: '林舟' }), doctor: project.doctor() }, null, 2));
} finally { project.close(); }
