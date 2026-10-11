// Optional official-CLI compatibility check; runs init and index --dry-run without an LLM.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, initProject, MicrosoftGraphRag, runGraphRag } from '../dist/index.js';

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
  writeFileSync(join(root, prepared.paths.delta), JSON.stringify({ ...delta, ...metadata, title: '钥匙', summary: body, characters: ['林舟'], key_events: [{ description: body, evidence: { quote: body } }] }));
  const review = JSON.parse(readFileSync(join(root, prepared.paths.review), 'utf8'));
  writeFileSync(join(root, prepared.paths.review), JSON.stringify({ ...review, contextHash: metadata.contextHash, draftHash: metadata.draftHash, reviewed: true }));
  project.commit(1, 'smoke');
  let dryRun = false;
  const runner = async (executable, args, cwd) => {
    if (args[2] === 'index') { dryRun = true; return runGraphRag(executable, [...args, '--dry-run', '--skip-validation'], cwd); }
    return runGraphRag(executable, args, cwd);
  };
  const provider = new MicrosoftGraphRag(project, runner);
  const setup = await provider.setup({ python, model: 'gpt-4.1', embedding: 'text-embedding-3-large' });
  // A dry run has no index outputs; it must never mark a snapshot ready.
  await assert.rejects(provider.index(1), /did not complete required output/);
  assert.equal(dryRun, true);
  assert.equal(existsSync(join(provider.export(1).root, 'ready.json')), false);
  const queryHelp = await runGraphRag(python, ['-m', 'graphrag', 'query', '--help'], root);
  assert.ok(queryHelp.stdout.includes('no-streaming'));
  console.log(JSON.stringify({ root, providerVersion: setup.version, initialized: true, indexConfigurationValid: true, queryCliCompatible: true, modelCalls: 0 }, null, 2));
} finally { project.close(); }
