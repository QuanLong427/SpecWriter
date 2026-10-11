import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export interface CompletionCredentials { model: string; apiBase: string; apiKey: string }

/** Read credentials without letting JSON parser diagnostics expose the original payload. */
export function completionCredentials(path: string, provider = 'qwen', requestedModel?: string): CompletionCredentials {
  let env: Record<string, string | undefined>;
  try { env = parseEnv(readFileSync(path, 'utf8')); }
  catch { throw new Error('Cannot read the model .env file'); }
  let entry: Record<string, unknown> | undefined;
  if (env.LLM_PROVIDERS) {
    try { entry = JSON.parse(env.LLM_PROVIDERS)[provider]; }
    catch { throw new Error('LLM_PROVIDERS must contain valid JSON (credentials are not printed)'); }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Requested provider is missing from LLM_PROVIDERS');
    if (entry.protocol !== 'openai_chat_completions') throw new Error('The completion provider must use openai_chat_completions');
  }
  const modelValues = entry?.models && typeof entry.models === 'object' ? Object.values(entry.models) : [];
  const models = [...new Set(modelValues.filter((value): value is string => typeof value === 'string' && !!value.trim()))];
  const model = requestedModel ?? env.QWEN_MODEL ?? (models.length === 1 ? models[0] : undefined);
  if (!model) throw new Error('Specify --model when the provider has no unique model');
  const apiKey = entry?.api_key ?? env.QWEN_API_KEY;
  const base = entry?.api_url ?? env.QWEN_BASE_URL;
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('The selected provider requires a valid API key in .env');
  if (typeof base !== 'string') throw new Error('The selected provider requires an API base URL in .env');
  return { model, apiKey, apiBase: modelApiBase(base.replace(/\/chat\/completions\/?$/, '')) };
}

export function modelApiBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid model API base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid model API base URL');
  return url.toString().replace(/\/$/, '');
}

export function isLoopbackApi(value: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(modelApiBase(value)).hostname);
}
