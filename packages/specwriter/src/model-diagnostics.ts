import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { safePath } from './files.js';
import { modelApiBase } from './provider-config.js';

export interface ModelCheck {
  kind: 'completion' | 'embedding'; name: string; model: string;
  configured: boolean; connection: 'not-tested' | 'ready' | 'failed';
  issue: string | null; fix: string | null; observedUsage?: { inputTokens: number | null; outputTokens: number | null };
}
/** Offline by default. A probe sends one tiny request per configured model, never prints response bodies. */
export async function diagnoseModels(root: string, options: { probe?: boolean; signal?: AbortSignal; fetch?: typeof fetch } = {}) {
  const directory = safePath(root, '.specwriter/graphrag/provider');
  const models: ModelCheck[] = [];
  let settings: any, environment: Record<string, string | undefined>;
  try {
    settings = parse(readFileSync(safePath(directory, 'settings.yaml'), 'utf8'));
    environment = { ...(existsSync(safePath(directory, '.env')) ? parseEnv(readFileSync(safePath(directory, '.env'), 'utf8')) : {}), ...process.env };
    if (!settings || typeof settings !== 'object') throw new Error();
  } catch { return { configured: false, ready: false, models, issue: 'Missing or invalid provider settings', fix: 'Run memory graphrag setup --python EXE --credentials FILE --preset qwen-bge-m3' }; }
  for (const [kind, group] of [['completion', 'completion_models'], ['embedding', 'embedding_models']] as const) {
    const entries = settings[group];
    if (!entries || typeof entries !== 'object' || !Object.keys(entries).length) {
      models.push({ kind, name: 'default', model: '', configured: false, connection: 'not-tested', issue: 'No model configured', fix: 'Reconfigure this model group' }); continue;
    }
    for (const [name, config] of Object.entries(entries) as [string, any][]) {
      const row: ModelCheck = { kind, name, model: typeof config?.model === 'string' ? config.model : '', configured: false, connection: 'not-tested', issue: null, fix: null };
      models.push(row);
      let base: string, key: string;
      try {
        const expand = (value: unknown) => {
          if (typeof value !== 'string') throw new Error();
          return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable) => {
            if (!environment[variable]) throw new Error(); return environment[variable]!;
          });
        };
        if (config.model_provider !== 'openai' || !row.model || !config.api_key) throw new Error();
        key = expand(config.api_key);
        if (!key.trim() || /[\r\n]/.test(key)) throw new Error();
        base = modelApiBase(expand(config.api_base ?? 'https://api.openai.com/v1'));
        row.configured = true;
      } catch { row.issue = 'Invalid endpoint, unsupported provider or missing credential'; row.fix = 'Check this model in provider/settings.yaml and provider/.env; credentials are never printed'; continue; }
      if (!options.probe) continue;
      try {
        const response = await (options.fetch ?? fetch)(`${base}/${kind === 'completion' ? 'chat/completions' : 'embeddings'}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(options.signal ? [options.signal] : [])]),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(kind === 'completion' ? { model: row.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16, stream: false }
            : { model: row.model, input: ['连接检查'], encoding_format: 'float' })
        });
        if (!response.ok) { await response.body?.cancel(); row.issue = `Model endpoint returned HTTP ${response.status}`; throw new Error(); }
        const body: any = await response.json();
        if (kind === 'completion' && (!Array.isArray(body.choices) || !body.choices.length || !body.choices[0]?.message)) throw new Error();
        if (kind === 'embedding') {
          const vector = body.data?.[0]?.embedding;
          const dimensions = settings.vector_store?.index_schema?.text_unit_text?.vector_size ?? settings.vector_store?.vector_size;
          if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite) || (dimensions !== undefined && vector.length !== dimensions)) {
            row.issue = 'Embedding response dimensions do not match the configured vector store'; throw new Error();
          }
        }
        row.connection = 'ready';
        const token = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
        row.observedUsage = { inputTokens: token(body.usage?.prompt_tokens), outputTokens: kind === 'embedding' ? 0 : token(body.usage?.completion_tokens) };
      } catch { row.connection = 'failed'; row.issue ??= 'Model request failed, timed out or returned an invalid response'; row.fix = kind === 'embedding' ? 'Start Ollama, install bge-m3 and check the embedding dimensions/API endpoint' : 'Check API key, endpoint, model access and network'; }
    }
  }
  return { configured: models.length > 0 && models.every(row => row.configured), ready: models.length > 0 && models.every(row => row.connection === 'ready'),
    probed: options.probe ?? false, models, note: options.probe ? 'Small model probes may incur charges; diagnostic usage is shown separately and excludes GraphRAG indexing and Codex writing' : 'No model request was sent; configured does not imply connected' };
}
