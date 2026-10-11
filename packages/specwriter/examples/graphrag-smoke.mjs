// Optional official-CLI compatibility check; runs init and index --dry-run without an LLM.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, initProject, MicrosoftGraphRag, runGraphRag, UsageLedger, parseRequestMetrics } from '../dist/index.js';
import { demoReview } from './artifacts.mjs';

const python = process.argv[2];
if (!python) throw new Error('Usage: node examples/graphrag-smoke.mjs PATH/TO/PYTHON_WITH_GRAPHRAG_3.3');
const root = mkdtempSync(join(tmpdir(), 'specwriter-graphrag-smoke-'));
initProject(root, 'GraphRAG compatibility');
const project = new Project(root);
try {
  project.propose('smoke', '兼容性检查', 1, 1);
  const prepared = project.prepare(1, 'smoke');
  const body = '林舟在废井发现青铜钥匙。';
  writeFileSync(join(root, prepared.paths.draft), body);
  const metadata = project.hashes(1, 'smoke');
  const delta = JSON.parse(readFileSync(join(root, prepared.paths.delta), 'utf8'));
  writeFileSync(join(root, prepared.paths.delta), JSON.stringify({ ...delta, ...metadata, title: '钥匙', summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body, basis: 'established' } }] }));
  const review = JSON.parse(readFileSync(join(root, prepared.paths.review), 'utf8'));
  writeFileSync(join(root, prepared.paths.review), JSON.stringify(demoReview(review, metadata, JSON.parse(readFileSync(join(root, prepared.paths.delta), 'utf8')))));
  project.commit(1, 'smoke');
  let dryRun = false;
  const runner = async (executable, args, cwd, options) => {
    if (args[2] === 'index') { dryRun = true; return runGraphRag(executable, [...args, '--dry-run', '--skip-validation'], cwd, options); }
    return runGraphRag(executable, args, cwd, options);
  };
  const provider = new MicrosoftGraphRag(project, runner);
  const setup = await provider.setup({ python, model: 'gpt-4.1', embedding: 'text-embedding-3-large' });
  // A dry run has no index outputs; it must never mark a snapshot ready.
  await assert.rejects(provider.index(1), /did not complete required output/);
  assert.equal(dryRun, true);
  assert.equal(existsSync(join(provider.export(1).root, 'ready.json')), false);
  const usage = new UsageLedger(root).report();
  assert.equal(usage.operations[0].coverage, 'complete');
  assert.equal(usage.operations[0].inputTokens, 0);
  const queryHelp = await runGraphRag(python, ['-m', 'graphrag', 'query', '--help'], root);
  assert.ok(queryHelp.stdout.includes('no-streaming'));
  const updateHelp = await runGraphRag(python, ['-m', 'graphrag', 'update', '--help'], root);
  assert.ok(updateHelp.stdout.includes('skip-validation'));
  const exported = provider.export(1);
  // update has no dry-run flag in 3.3.0; index can validate the standard-update pipeline offline.
  await runGraphRag(python, ['-m', 'graphrag', 'index', '--root', exported.root, '--method', 'standard-update', '--dry-run', '--skip-validation'], exported.root);
  const offline = await runGraphRag(python, ['-X', 'utf8', fileURLToPath(new URL('./graphrag-offline-check.py', import.meta.url)), join(root, 'offline-check'), fileURLToPath(new URL('../assets/graphrag-sources.py', import.meta.url))], root);
  const metricsFile = join(root, 'observer-check.jsonl');
  const observed = await runGraphRag(python, ['-X', 'utf8', fileURLToPath(new URL('./graphrag-metrics-check.py', import.meta.url)), fileURLToPath(new URL('../assets/graphrag-observe.py', import.meta.url)), metricsFile], root);
  const measured = parseRequestMetrics(metricsFile, true);
  assert.equal(measured.coverage, 'complete'); assert.equal(measured.inputTokens, 100); assert.equal(measured.outputTokens, 20); assert.equal(measured.embeddingTokens, 50);
  console.log(JSON.stringify({ root, providerVersion: setup.version, initialized: true, indexConfigurationValid: true, updateConfigurationValid: true, queryCliCompatible: true, ...JSON.parse(offline.stdout), ...JSON.parse(observed.stdout), measuredFixtureTokens: { input: measured.inputTokens, output: measured.outputTokens, embedding: measured.embeddingTokens } }, null, 2));
} finally { project.close(); }
