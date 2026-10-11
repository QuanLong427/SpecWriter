// Opt-in live connection check: one small chapter, one standard index, one local query.
// Uses real Qwen calls and local Ollama BGE-M3. Not a long-novel quality benchmark.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { initProject, Project, MicrosoftGraphRag, UsageLedger } from '../dist/index.js';
import { demoReview } from './artifacts.mjs';

const [output, envFile, python] = process.argv.slice(2);
if (!output || !envFile || !python || process.argv.length !== 5) throw new Error('Usage: node examples/local-memory-smoke.mjs NEW_BOOK_ROOT ENV_FILE GRAPHRAG_PYTHON');
const root = resolve(output);
if (existsSync(root)) throw new Error('Connection check requires a new output directory');
initProject(root, 'Qwen + BGE-M3 connection check', { workflow: 'legacy' });
const project = new Project(root);
try {
  project.propose('connection-check', '连接验证', 1, 1);
  const prepared = project.prepare(1, 'connection-check');
  const body = '林舟带着十枚灵石来到青石镇。他在白衡的店里买了干粮，花掉两枚灵石，还剩八枚灵石。白衡是镇上的商人。林舟随后独自前往旧塔，随身带着一把青铜钥匙。';
  writeFileSync(join(root, prepared.paths.draft), body);
  const metadata = project.hashes(1, 'connection-check');
  const delta = JSON.parse(readFileSync(join(root, prepared.paths.delta), 'utf8'));
  writeFileSync(join(root, prepared.paths.delta), JSON.stringify({ ...delta, ...metadata, title: '青石镇', summary: body,
    characters: ['林舟', '白衡'], key_events: [{ description: body, evidence: { quote: body, basis: 'established' } }] }));
  const review = JSON.parse(readFileSync(join(root, prepared.paths.review), 'utf8'));
  writeFileSync(join(root, prepared.paths.review), JSON.stringify(demoReview(review, metadata, JSON.parse(readFileSync(join(root, prepared.paths.delta), 'utf8')))));
  project.commit(1, 'connection-check');
  const provider = new MicrosoftGraphRag(project);
  const setup = await provider.setup({ python: resolve(python), envFile: resolve(envFile), provider: 'qwen',
    embedding: 'bge-m3', embeddingBase: 'http://127.0.0.1:11434/v1', embeddingDimensions: 1024 });
  // Bound this connection check. Production model/prompts otherwise use the normal defaults.
  const settings = parse(readFileSync(setup.settings, 'utf8'));
  settings.extract_graph.max_gleanings = 0;
  writeFileSync(setup.settings, stringify(settings));
  const index = await provider.index(1, { onProgress: event => console.log(JSON.stringify(event)) });
  const query = await provider.query('林舟买干粮之后还剩多少枚灵石？请引用来源。', { at: 1, method: 'local' });
  const result = { mode: 'live-connection-check', dataset: 'one hand-authored chapter; not a long-novel benchmark',
    proseCharacters: body.length, model: settings.completion_models.default_completion_model.model,
    embedding: 'bge-m3', dimensions: 1024, index, answer: query.answer, sources: query.sources,
    checks: { expectedValueFound: /(?:八|8)\s*枚灵石/.test(query.answer.replace(/[*_`]/g, '')),
      originalEvidenceFound: query.sources.some(source => source.excerpt.includes('还剩八枚灵石')) },
    usage: new UsageLedger(root).report() };
  writeFileSync(join(root, 'connection-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory: root, result: join(root, 'connection-result.json'), answer: result.answer,
    models: result.usage.operations.flatMap(operation => operation.models) }, null, 2));
  if (!result.checks.expectedValueFound || !result.checks.originalEvidenceFound) throw new Error('Connection result lacks the expected value or original-prose evidence; inspect the saved result');
} finally { project.close(); }
