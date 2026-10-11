// Disposable sample book for previewing the reader. It never uses model APIs.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, NovelReader, initProject, startReader } from '../dist/index.js';
import { demoReview } from './artifacts.mjs';

const root = mkdtempSync(join(tmpdir(), 'specwriter-reader-demo-'));
initProject(root, '废井来信 · 示例小说', { memoryBackend: 'local', workflow: 'legacy' });
const project = new Project(root);
project.propose('opening', '废井来信', 1, 3);
const bodies = [
  '# 井底的信\n\n雨停的时候，林舟在井沿看见了一封信。\n\n它没有被打湿。信封白得扎眼，像是有人刚刚把它放在那里，又退回了身后的雨里。\n\n“不要下去。”\n\n这是信上唯一的一句话。字迹很熟，最后一笔习惯向上挑。林舟已经七年没有见过这种写法了。\n\n他把信翻过来。背面空白。\n\n院墙外传来车铃声，又很快远去。雨水顺着井绳一滴滴落下去，井底没有回声。\n\n林舟认得这口井。小时候，他在这里丢过一只纸船。父亲告诉他，井水通向山背面的河。\n\n“纸船会回来吗？”那时他问。\n\n父亲没有回答。\n\n现在，纸船没有回来，信却来了。\n\n他把手按在井沿上。石头凉得像一块冰。\n\n身后有人轻轻咳了一声。',
  '# 雨后的脚步\n\n白衡站在廊下，手里拎着一双干净的鞋。\n\n“你没下去吧？”\n\n林舟没有回答。他把那封信收进袖中，目光落在白衡的鞋底。那里没有泥。\n\n白衡循着他的视线低头看了一眼。\n\n“我从前门进来的。”他说。\n\n前门已经锁了七年。\n\n林舟往旁边让了一步。两个人之间露出了那口井，雨水把井沿洗得发亮。\n\n“这双鞋是谁的？”\n\n“你的。”白衡说，“有人让我带给你。”\n\n鞋口塞着一张折起的纸。林舟伸手去拿，白衡却把鞋收了回去。\n\n“等你决定以后。”',
  '# 第三封信（草稿）\n\n林舟最后还是接过了那双鞋。\n\n纸上画着一条路，从废井一直延伸到山背面的河。\n\n他看着那条路，忽然记起父亲当年没有说完的话。'
];
const load = path => JSON.parse(readFileSync(path, 'utf8'));
for (let index = 0; index < bodies.length; index++) {
  const chapter = index + 1;
  const prepared = project.prepare(chapter, 'opening');
  const paths = Object.fromEntries(Object.entries(prepared.paths).map(([key, path]) => [key, join(root, path)]));
  writeFileSync(paths.draft, bodies[index]);
  const metadata = project.hashes(chapter, 'opening');
  writeFileSync(paths.delta, JSON.stringify({ ...load(paths.delta), ...metadata, title: ['井底的信', '雨后的脚步', '第三封信'][index], summary: ['林舟在废井边收到来历不明的信。', '白衡带来一双鞋，要求林舟先作决定。', '林舟接过鞋，找到通向河流的路线。'][index], characters: ['林舟'], key_events: [{ description: ['林舟收到信', '白衡带来鞋', '林舟发现路线'][index], evidence: { quote: bodies[index], basis: 'established' } }] }));
  writeFileSync(paths.review, JSON.stringify(demoReview(load(paths.review), metadata, load(paths.delta))));
  if (chapter < 3) project.commit(chapter, 'opening');
}
const reader = new NovelReader(project);
const chapter = reader.chapter('accepted:1');
const quote = '字迹很熟，最后一笔习惯向上挑。'; const start = chapter.body.indexOf(quote);
reader.addFeedback({ chapterKey: chapter.key, bodyHash: chapter.bodyHash, quote, start, end: start + quote.length, note: '这里可以再增加一点林舟的身体反应，保留来信人的身份悬念。' });
const running = await startReader(project);
console.log(JSON.stringify({ root, url: running.url, note: '示例小说，Ctrl+C 停止阅读器' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); project.close(); });
