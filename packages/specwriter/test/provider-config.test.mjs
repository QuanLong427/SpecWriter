import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { completionCredentials } from '../dist/provider-config.js';
import { initProject, Project, MicrosoftGraphRag, parseRequestMetrics, usageCost } from '../dist/index.js';
import { assessment } from './contract-fixture.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'specwriter-provider-'));
const source = root => {
  const path = join(root, '.env');
  writeFileSync(path, `LLM_PROVIDERS='${JSON.stringify({ qwen: { protocol: 'openai_chat_completions', api_key: 'fixture-secret#only', api_url: 'https://example.invalid/v1', models: { rewrite: 'fixture-qwen' } } })}'\n`);
  return path;
};

test('provider env selects a unique model, rejects ambiguity and hides malformed secrets', () => {
  const root = temp(), path = source(root);
  assert.deepEqual(completionCredentials(path), { model: 'fixture-qwen', apiKey: 'fixture-secret#only', apiBase: 'https://example.invalid/v1' });
  writeFileSync(path, `LLM_PROVIDERS='{"qwen":{"api_key":"fixture-secret", BROKEN}}'`);
  assert.throws(() => completionCredentials(path), error => !error.message.includes('fixture-secret') && error.message.includes('valid JSON'));
  writeFileSync(path, `LLM_PROVIDERS='${JSON.stringify({ qwen: { protocol: 'openai_chat_completions', api_key: 'secret', api_url: 'https://example.invalid/v1', models: { a: 'one', b: 'two' } } })}'`);
  assert.throws(() => completionCredentials(path), /--model/);
  assert.equal(completionCredentials(path, 'qwen', 'chosen').model, 'chosen');
});

test('setup configures local BGE dimensions separately from Qwen and keeps credentials private', async () => {
  const root = temp(), env = source(root); initProject(root, 'local embedding');
  const project = new Project(root), calls = [];
  const runner = async (_python, args) => {
    calls.push(args);
    if (args[0] === '-c') return { stdout: '3.3.0', stderr: '' };
    assert.equal(args[2], 'init');
    const directory = args[args.indexOf('--root') + 1]; mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'settings.yaml'), 'completion_models:\n  default_completion_model: {}\nembedding_models:\n  default_embedding_model: {}\n');
    return { stdout: '', stderr: '' };
  };
  try {
    const provider = new MicrosoftGraphRag(project, runner);
    const options = { python: 'fixture-python', embedding: 'bge-m3', envFile: env, embeddingBase: 'http://127.0.0.1:11434/v1', embeddingDimensions: 1024 };
    const result = await provider.setup(options);
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    assert.ok(!JSON.stringify(calls).includes('fixture-secret'));
    const settings = parse(readFileSync(result.settings, 'utf8'));
    assert.equal(settings.completion_models.default_completion_model.model, 'fixture-qwen');
    assert.equal(settings.embedding_models.default_embedding_model.api_key, 'local-embedding');
    assert.equal(settings.embedding_models.default_embedding_model.specwriter_local, true);
    assert.equal(settings.vector_store.vector_size, 1024);
    assert.equal(settings.vector_store.index_schema.entity_description.vector_size, 1024);
    assert.equal(new Set(Object.values(settings.vector_store.index_schema).map(schema => schema.index_name)).size, 3);
    assert.ok(!readFileSync(result.settings, 'utf8').includes('fixture-secret'));
    assert.equal(completionCredentials(env).apiKey, 'fixture-secret#only');
    writeFileSync(result.credentials, readFileSync(result.credentials, 'utf8') + 'OTHER_PROVIDER_KEY=keep-this-value\n');
    await assert.rejects(provider.setup(options), /--reconfigure/);
    await provider.setup({ ...options, reconfigure: true });
    assert.ok(readFileSync(result.credentials, 'utf8').includes('OTHER_PROVIDER_KEY=keep-this-value'));
    await assert.rejects(provider.setup({ ...options, embeddingBase: 'https://example.invalid/v1', reconfigure: true }), /loopback/);
    const exported = provider.export(0);
    assert.equal(project.corpus(0).documents.length, 0);
    assert.ok(exported.root);
    project.propose('schema-check', 'schema check', 1, 1);
    const prepared = project.prepare(1, 'schema-check'), body = '林舟留下了八枚灵石。';
    writeFileSync(join(root, prepared.paths.draft), body);
    const metadata = project.hashes(1, 'schema-check');
    const delta = JSON.parse(readFileSync(join(root, prepared.paths.delta), 'utf8'));
    writeFileSync(join(root, prepared.paths.delta), JSON.stringify({ ...delta, ...metadata, title: '灵石', summary: body,
      key_events: [{ description: body, evidence: { quote: body, basis: 'established' } }] }));
    writeFileSync(join(root, prepared.paths.review), JSON.stringify(assessment(JSON.parse(readFileSync(join(root, prepared.paths.review), 'utf8')), metadata, JSON.parse(readFileSync(join(root, prepared.paths.delta), 'utf8')))));
    project.commit(1, 'schema-check');
    const badSettings = parse(readFileSync(result.settings, 'utf8'));
    badSettings.vector_store.index_schema.entity_description.index_name = badSettings.vector_store.index_schema.text_unit_text.index_name;
    writeFileSync(result.settings, JSON.stringify(badSettings)); // JSON is also valid YAML.
    await assert.rejects(provider.index(1), /distinct index_name/);
    assert.equal(calls.filter(args => args[2] === 'index').length, 0);
  } finally { project.close(); }
});

test('local embedding tokens have zero API cost while unpriced Qwen remains unknown', () => {
  const root = temp(), path = join(root, 'metrics.jsonl');
  const embedding = { model: 'openai/bge-m3', metrics: { attempted_request_count: 1, successful_response_count: 1,
    responses_with_tokens: 1, prompt_tokens: 30, specwriter_embedding: 1, specwriter_local: 1 } };
  const records = [{ observer: 1 }, embedding, { ...embedding, metrics: { ...embedding.metrics, cached_responses: 1 } }, { finished: true }];
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n'));
  const local = parseRequestMetrics(path, true);
  assert.equal(local.coverage, 'complete'); assert.equal(local.embeddingTokens, 30);
  assert.equal(local.models[0].local, true); assert.equal(usageCost(local), 0);
  const completion = { model: 'openai/qwen', metrics: { attempted_request_count: 1, successful_response_count: 1,
    responses_with_tokens: 1, prompt_tokens: 40, completion_tokens: 10, specwriter_completion: 1 } };
  records.splice(2, 0, completion); writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n'));
  const mixed = parseRequestMetrics(path, true); assert.equal(usageCost(mixed), null);
  assert.equal(usageCost(mixed, { currency: 'TEST', models: [{ model: 'openai/qwen', kind: 'completion', inputPerMillion: 1, outputPerMillion: 2 }] }), 0.00006);
});
