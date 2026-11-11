/**
 * Local models, first step of plan step F8 (ADR 0011, issue #26): finds Ollama on its documented
 * port and reads what each installed model can do. Other local servers (LM Studio, llama.cpp,
 * vLLM, Strata) follow as their own step.
 */

export const OLLAMA_URL = 'http://127.0.0.1:11434';
/**
 * Below this many tokens of context an agent session does not fit: PartBuddy's instructions and
 * SolidCraft's tools alone took 9,376 tokens (LM Studio's count, 2026-11-06), plus the conversation.
 */
export const MIN_CONTEXT = 16384;
/**
 * The context PartBuddy asks for: Ollama's OpenAI endpoint ignores it and runs with 4096 on GPUs
 * under 24 GiB (measured with 0.34.0), so the loop talks to Ollama's own API with `num_ctx`.
 * shortcut: one fixed size; upgrade to one chosen from free VRAM once users report out-of-memory.
 */
export const LOCAL_CONTEXT = 16384;

export const CONTEXT_OPTIONS = [16384, 32768, 65536] as const;

export type LocalContextSize = typeof CONTEXT_OPTIONS[number];

export interface LocalModel {
  id: string;
  /** The model can call tools; without it, it cannot work on the design. */
  tools: boolean;
  vision: boolean;
  /** The model's own context length, when Ollama tells it. */
  context: number | null;
  /** In memory now (`/api/ps`); otherwise the first request loads it. */
  loaded: boolean;
}

export interface OllamaFound {
  version: string;
  models: LocalModel[];
}

/** What `/api/show` says about one model: its capabilities and `<family>.context_length`. */
export function modelFromShow(id: string, body: unknown): LocalModel {
  const show = (body ?? {}) as { capabilities?: unknown; model_info?: Record<string, unknown> };
  const capabilities = Array.isArray(show.capabilities) ? show.capabilities.filter((entry): entry is string => typeof entry === 'string') : [];
  const length = Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
  return {
    id,
    tools: capabilities.includes('tools'),
    vision: capabilities.includes('vision'),
    context: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null,
    loaded: false,
  };
}

/** The models `/api/tags` lists, by name. */
export function modelNames(body: unknown): string[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => (model as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 120)
    .slice(0, 50);
}

/** The context to run a model with, or null when it is too small for an agent session. */
export function contextFor(
  model: LocalModel,
  requested: LocalContextSize = LOCAL_CONTEXT,
): number | null {
  const context = Math.min(
    model.context ?? requested,
    requested,
  );

  return context >= MIN_CONTEXT ? context : null;
}

/** Ollama and its models, or null when nothing answers on its port. A short timeout keeps the panel quick. */
export async function findOllama(fetchFn: typeof fetch = fetch, base = OLLAMA_URL, timeoutMs = 1500): Promise<OllamaFound | null> {
  const get = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetchFn(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${path}: HTTP ${String(response.status)}`);
    return response.json();
  };
  let version: string;
  try {
    const answer = (await get('/api/version')) as { version?: unknown };
    version = typeof answer.version === 'string' ? answer.version.slice(0, 40) : 'unknown';
  } catch {
    return null;
  }
  const names = modelNames(await get('/api/tags'));
  const loaded = new Set(modelNames(await get('/api/ps').catch(() => null)));
  const models = await Promise.all(
    names.map(async (name) => {
      try {
        return { ...modelFromShow(name, await get('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) })), loaded: loaded.has(name) };
      } catch {
        return { id: name, tools: false, vision: false, context: null, loaded: false };
      }
    }),
  );
  return { version, models };
}
