import { describe, expect, it, vi } from 'vitest';

import type { UpstreamTools } from '../src/main/agents/gateProxy';
import type { AgentEvent } from '../src/shared/contract';
import { strataFromHealth } from '../src/main/local/strata';

import { LocalAgent, usableModels } from '../src/main/local/localAgent';
import { contextFor, findOllama, modelFromShow, modelNames } from '../src/main/local/ollama';

// Answers as Ollama 0.34.0 gives them (shortened), recorded on the home server on 2026-11-06.
const TAGS = { models: [{ name: 'qwen3.5:9b' }, { name: 'embeddinggemma:latest' }, { name: 'tiny:1b' }] };
const SHOW: Record<string, unknown> = {
  'qwen3.5:9b': { capabilities: ['completion', 'vision', 'tools', 'thinking'], model_info: { 'qwen35.context_length': 262144 } },
  'embeddinggemma:latest': { capabilities: ['embedding'], model_info: { 'gemma3.context_length': 2048 } },
  'tiny:1b': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 4096 } },
};

function fakeOllama(up = true): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    if (!up) return Promise.reject(new TypeError('fetch failed'));
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (path === '/api/version') return json({ version: '0.34.0' });
    if (path === '/api/tags') return json(TAGS);
    if (path === '/api/show') return json(SHOW[(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model: string }).model]);
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

const noChoices = { get: () => null, set: () => undefined };

function agent(up = true) {
  const events: unknown[] = [];
  const local = new LocalAgent({ tools: () => Promise.resolve(null), event: (event) => events.push(event), changed: () => undefined, log: () => undefined, choices: noChoices, fetch: fakeOllama(up) });
  return { local, events };
}

describe('local models through Ollama (F8)', () => {
  it('reads capabilities and context length from /api/show', () => {
    expect(modelFromShow('qwen3.5:9b', SHOW['qwen3.5:9b'])).toEqual({ id: 'qwen3.5:9b', tools: true, vision: true, context: 262144, loaded: false });
    expect(modelFromShow('x', null)).toEqual({ id: 'x', tools: false, vision: false, context: null, loaded: false });
    expect(modelNames(TAGS)).toEqual(['qwen3.5:9b', 'embeddinggemma:latest', 'tiny:1b']);
  });

  it('supports configurable context sizes', () => {
    const model = {
      id: 'qwen',
      tools: true,
      vision: false,
      context: 262144,
      loaded: false,
    };

    expect(contextFor(model)).toBe(16384);
    expect(contextFor(model, 32768)).toBe(32768);
    expect(contextFor(model, 65536)).toBe(65536);

    // Never exceed the model's actual capacity
    expect(contextFor({ ...model, context: 32768 }, 65536))
      .toBe(32768);

    // Reject models below minimum requirements
    expect(contextFor({ ...model, context: 4096 }))
      .toBeNull();
  });

  it('offers only models that call tools and have room for them', async () => {
    const found = await findOllama(fakeOllama());
    expect(found?.version).toBe('0.34.0');
    expect(usableModels(found ?? { version: '', models: [] }).map((model) => model.option.id)).toEqual(['qwen3.5:9b']);
    expect(await findOllama(fakeOllama(false))).toBeNull();
  });

  it('is ready with the first usable model, or says what is missing', async () => {
    const { local } = agent();
    expect(local.status().state).toBe('checking');
    const status = await local.refresh();
    expect(status).toMatchObject({ agent: 'local', state: 'ready', version: '0.34.0', model: 'qwen3.5:9b' });
    const down = await agent(false).local.refresh();
    expect(down.state).toBe('unavailable');
    expect(down.detail).toContain('Start Ollama');
  });
});

// /health as Strata's serve/server.py answers it (read 2026-11-06), with the PC's model.
const HEALTH = { status: 'ok', max_context: 131072, model: 'qwen3.8-flash-next-iq3_xxs', images: true, api_key: false, image_generation: false, loaded: true, service: 'strata' };

/** Strata at :8080 answering /health and a streamed chat completion; nothing on Ollama's port. */
function fakeStrata(health: Record<string, unknown> = HEALTH) {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.port !== '8080') return Promise.reject(new TypeError('fetch failed'));
    if (url.pathname === '/health') return Promise.resolve(Response.json(health));
    if (url.pathname === '/v1/chat/completions') {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-flash-next-iq3_xxs', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const usage = `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-flash-next-iq3_xxs', choices: [], usage: { prompt_tokens: 9800, completion_tokens: 200 } })}\n\n`;
      const sse = chunk({ role: 'assistant', content: 'Hello from Strata' }, null) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as typeof fetch;
  return { fetchFn, bodies };
}

describe('local models through Strata (F8)', () => {
  it('tells Strata from other servers on its port by /health', () => {
    expect(strataFromHealth(HEALTH)).toEqual({ model: 'qwen3.8-flash-next-iq3_xxs', context: 131072, vision: true, keyNeeded: false, loaded: true, busy: false });
    // llama.cpp answers /health on 8080 too, without "service".
    expect(strataFromHealth({ status: 'ok' })).toBeNull();
    expect(strataFromHealth({ ...HEALTH, max_context: 0, loaded: false })).toMatchObject({ context: null, loaded: false });
  });

  it('runs the Strata model through its OpenAI API with the chosen effort and the tools', async () => {
    const strata = fakeStrata();
    const events: AgentEvent[] = [];
    const upstream: UpstreamTools = {
      instructions: () => undefined,
      listTools: () => Promise.resolve([{ name: 'measure', description: 'Volume', inputSchema: { type: 'object', properties: {} } }]),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
    };
    const local = new LocalAgent({ tools: () => Promise.resolve(upstream), event: (event) => events.push(event), changed: () => undefined, log: () => undefined, choices: noChoices, fetch: strata.fetchFn });
    const status = await local.refresh();
    expect(status).toMatchObject({ state: 'ready', account: 'Strata', model: 'strata:qwen3.8-flash-next-iq3_xxs', effort: 'medium' });
    expect(status.models).toEqual([{ id: 'strata:qwen3.8-flash-next-iq3_xxs', name: 'qwen3.8-flash-next-iq3_xxs · Strata', efforts: ['low', 'medium', 'high'], description: 'In memory · 128K context', context: 131072 }]);
    await local.chooseModel({ model: 'strata:qwen3.8-flash-next-iq3_xxs', effort: 'high' }, false);
    await local.send('Hello');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done')).toBe(true));
    expect(strata.bodies[0]).toMatchObject({ model: 'qwen3.8-flash-next-iq3_xxs', reasoning_effort: 'high', stream: true });
    expect((strata.bodies[0]?.tools as unknown[] | undefined)?.length).toBe(1);
    expect(events.flatMap((e) => (e.type === 'textDelta' ? [e.text] : [])).join('')).toBe('Hello from Strata');
    // How full the 128K window is after the turn.
    expect(local.status().context).toEqual({ used: 10000, size: 131072 });
    expect(events.find((e) => e.type === 'done')).toMatchObject({ ok: true });
  });

  it('says so when Strata wants an API key', async () => {
    const local = new LocalAgent({ tools: () => Promise.resolve(null), event: () => undefined, changed: () => undefined, log: () => undefined, choices: noChoices, fetch: fakeStrata({ ...HEALTH, api_key: true }).fetchFn });
    const status = await local.refresh();
    expect(status.state).toBe('unavailable');
    expect(status.detail).toContain('API key');
  });
});
