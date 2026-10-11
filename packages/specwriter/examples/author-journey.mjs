// Reproduce a Codex-authored three-chapter workflow exercise in explicit offline mode.
// Static prose/assessments demonstrate the plumbing, not autonomous writing or blind quality.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Project, NovelReader, initProject } from '../dist/index.js';
import { chapters, specs } from './author-journey-data.mjs';

const root = resolve(process.argv[2] ?? '.specwriter-experiments/v08-author-journey');
if (existsSync(root)) throw new Error('Use a new exercise directory; existing books are preserved');
initProject(root, '渡口的灯 · 创作流程演练', { memoryBackend: 'local' });
for (const [name, content] of Object.entries(specs)) writeFileSync(join(root, `specwriter/specs/${name}.md`), content);
writeFileSync(join(root, 'specwriter/plans/outline.md'), '# 开篇方向\n渡口争执→船工传递信息→缺口信号兑现。姐姐去向尚未确定，后续由作者选定。');
let project = new Project(root);
const stages = [], started = Date.now();
try {
  project.workflow.adopt('本次流程演练采用随样例保存的原创设定'); project.sync();
  project.propose('opening', '开篇三章', 1, 3);
  project.workflow.authorize('opening', 1, 1, 'draft', '流程演练第一章先留审阅草稿');
  for (let index = 0; index < chapters.length; index++) {
    const chapter = index + 1, data = chapters[index];
    project.workflow.seed(chapter, 'opening');
    const intentPath = join(root, project.workflow.intentPath(chapter, 'opening'));
    const intent = { ...JSON.parse(readFileSync(intentPath, 'utf8')), goal: data.goal, scenes: [data.goal], storyTime: '第一夜', targetChars: null, expectedChanges: [data.goal], ...data.intent };
    writeFileSync(intentPath, JSON.stringify(intent, null, 2)); project.workflow.saveIntent(chapter, 'opening');
    const prepared = project.prepare(chapter, 'opening');
    const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key,path]) => [key,join(root,path)]));
    writeFileSync(paths.draft, data.body);
    const metadata = project.hashes(chapter,'opening');
    const delta = { ...JSON.parse(readFileSync(paths.delta,'utf8')), ...metadata, title:data.title, summary:data.goal, ...data.delta };
    writeFileSync(paths.delta,JSON.stringify(delta,null,2));
    const requirements=project.reviewRequirements(chapter,'opening');
    const critical_checks=requirements.criticalClaims.map(claim => {
      const actual=data.assessments.find(item => item[0]===claim.category && item[1]===claim.evidenceQuote);
      if(!actual) throw new Error(`No actual assessment for ${claim.category}: ${claim.claim}`);
      return { claimHash:claim.claimHash,verdict:'supported',evidenceQuote:actual[1],explanation:actual[2] };
    });
    const review={ ...JSON.parse(readFileSync(paths.review,'utf8')), ...metadata,reviewed:true,critical_checks,intent_checks:data.intentReviews,
      checks:{evidence:{checked:true,notes:[data.notes[0]]},coverage:{checked:true,notes:[data.notes[1]]},continuity:{checked:true,notes:[data.notes[1]]}},notes:data.notes };
    delete review.baseRevision;
    writeFileSync(paths.review,JSON.stringify(review,null,2)); project.verify(chapter,'opening');
    stages.push({chapter,beforeAcceptance:project.resume().stage,chars:data.body.length});
    if(chapter===1) {
      if(project.resume().stage!=='await-acceptance') throw new Error('Expected draft inspection boundary');
      // This script explicitly defines sample authorization; no human approval is inferred for another book.
      project.workflow.authorize('opening',1,1,'auto','演练方案指定第一章完成实际审阅后接纳');
    }
    project.commit(chapter,'opening');
    if(chapter===1) {
      project.workflow.authorize('opening',2,3,'auto','演练方案指定余下两章逐章审阅接纳');
      project.workflow.pause('opening',true,'演练中断恢复'); project.close();
      const restored=spawnSync(process.execPath,[join(root,'.specwriter/bin/specwriter.mjs'),'resume','--json'],{cwd:root,encoding:'utf8'});
      if(restored.status!==0 || JSON.parse(restored.stdout).stage!=='paused') throw new Error('Fresh process failed to recover paused state');
      project=new Project(root); project.workflow.pause('opening',false,'演练方案指定继续原范围');
    }
  }
  if(project.resume().stage!=='complete') throw new Error('Writing exceeded or did not complete the chosen range');
  const reader=new NovelReader(project), exports=['txt','md','html'].map(format => reader.writeExport(format));
  const health=project.doctor(); if(!health.healthy) throw new Error(JSON.stringify(health));
  project.archive('opening');
  const report={book:root,chapters:chapters.length,chars:chapters.reduce((n,item)=>n+item.body.length,0),modelCalls:0,backend:'local',elapsedMs:Date.now()-started,stages,exports,health,
    scope:'Codex-authored static short sample, with chapter-specific extraction and review. No independent literary assessment, paid Qwen generation, real GraphRAG indexing, or long-distance/million-character validation.'};
  mkdirSync(join(root,'exercise'),{recursive:true}); writeFileSync(join(root,'exercise/report.json'),JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
} finally { project.close(); }
