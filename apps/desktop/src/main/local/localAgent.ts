import { createOpenAI } from '@ai-sdk/openai';
import { generateText, jsonSchema, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';

import type { AgentEvent, AgentStatus, ModelChoice, ModelOption, Selection } from '../../shared/contract';
import { userEvent, type AgentBackend, type PictureKind } from '../agents/assistant';
import type { UpstreamTools } from '../agents/gateProxy';
import { contextAfter, instructionsFor, LOOP_NOTICE, MAX_STEPS, policyToolSet, repeatsItself } from '../agents/loop';
import { allowedChoice, choiceStatus, type ChoiceStore } from '../agents/modelChoice';
import { composeMessage } from '../agents/viewContext';
import { contextFor, findOllama, LOCAL_CONTEXT, type LocalContextSize, MIN_CONTEXT, OLLAMA_URL, type OllamaFound } from './ollama';
import { findOpenAiServers, loadInLmStudio, OPENAI_SERVERS, type OpenAiServer } from './openaiServers';
import { findStrata, STRATA_EFFORTS, STRATA_URL, type StrataFound } from './strata';

/**
 * A local model in PartBuddy's own agent loop (plan step F8, ADR 0011): Ollama through its own API
 * (the context is set per request, `num_ctx`); Strata, LM Studio, llama.cpp and vLLM through their
 * OpenAI API. SolidCraft's tools pass the same policy as every route; nothing leaves the machine.
 * Only models that can call tools and have room for them are offered; where a server does not say
 * whether a model calls tools, one test call with a dummy tool decides before first use.
 */

export interface LocalAgentOptions {
  tools(): Promise<UpstreamTools | null>;
  event(event: AgentEvent): void;
  changed(): void;
  log(message: string): void;
  choices: ChoiceStore;
  fetch?: typeof fetch;
  /** Where the servers listen; tests point them elsewhere. */
  url?: string;
  strataUrl?: string;
  openAiServers?: { name: OpenAiServer['name']; url: string }[];
  /** Requested context window for local Ollama models. */
  contextSize?: () => LocalContextSize;
}

/** A model the route can run, with the server that runs it. */
export interface Runnable {
  option: ModelOption;
  server: string;
  vision: boolean;
  /** Ollama's context to ask for; the other servers keep their own. */
  numCtx: number | null;
  /** The OpenAI API base of the server; null for Ollama. */
  openAiBase: string | null;
  /** The model's name on its server. */
  serverModel: string;
  /** The server does not say whether the model calls tools; a test call decides. */
  toolTest: boolean;
  /** LM Studio's address when PartBuddy has to load the model there first, with enough context. */
  loadAt: string | null;
}

/** The short key of a server in a model's id, so names never clash between servers. */
function serverKey(server: { name: string; url: string }): string {
  const port = new URL(server.url).port;
  return `${server.name.toLowerCase().replace(/[^a-z]/g, '')}${port}`;
}

/** "In memory · 16K context" and the like: what the menu says about a model. */
function describe(parts: (string | null | false)[]): { description?: string } {
  const text = parts.filter((part): part is string => typeof part === 'string').join(' · ');
  return text ? { description: text.slice(0, 200) } : {};
}

const windowOf = (context: number | null) => (context ? { context } : {});

const contextNote = (context: number | null) => (context ? `${String(Math.round(context / 1024))}K context` : null);

/** The models an agent session can use: they call tools (or are still to be tested) and have room for SolidCraft's tools. */
export function usableModels(ollama: OllamaFound | null, strata: StrataFound | null = null, servers: OpenAiServer[] = [], failed: ReadonlySet<string> = new Set(), localContext: LocalContextSize = LOCAL_CONTEXT,): Runnable[] {
  const runnable: Runnable[] = (ollama?.models ?? [])
    .filter((model) => model.tools && contextFor(model, localContext) !== null)
    .map((model) => ({
      option: {
        id: model.id,
        name: `${model.id} · Ollama`.slice(0, 80),
        efforts: [],
        ...describe([model.loaded ? 'In memory' : 'Loads on first use', contextNote(contextFor(model, localContext)), !model.vision && 'Cannot see pictures']),
        ...windowOf(contextFor(model, localContext)),
      },
      server: 'Ollama',
      vision: model.vision,
      numCtx: contextFor(model, localContext),
      openAiBase: null,
      serverModel: model.id,
      toolTest: false,
      loadAt: null,
    }));
  // Strata declares tool calling for every model it serves; a known context below the floor is refused.
  if (strata && !strata.keyNeeded && (strata.context === null || strata.context >= MIN_CONTEXT)) {
    runnable.push({
      option: {
        id: `strata:${strata.model}`.slice(0, 80),
        name: `${strata.model} · Strata`.slice(0, 80),
        efforts: STRATA_EFFORTS,
        ...describe([strata.busy && 'Busy with another request', strata.loaded ? 'In memory' : 'Loads on first use', contextNote(strata.context), !strata.vision && 'Cannot see pictures']),
        ...windowOf(strata.context),
      },
      server: 'Strata',
      vision: strata.vision,
      numCtx: null,
      openAiBase: `${STRATA_URL}/v1`,
      serverModel: strata.model,
      toolTest: false,
      loadAt: null,
    });
  }
  for (const server of servers) {
    for (const model of server.models) {
      const id = `${serverKey(server)}:${model.id}`.slice(0, 80);
      if (model.tools === false || failed.has(id) || (model.context !== null && model.context < MIN_CONTEXT)) continue;
      runnable.push({
        option: {
          id,
          name: `${model.id} · ${server.name}`.slice(0, 80),
          efforts: [],
          ...describe([
            model.busy && 'Busy with another request',
            model.loading ? 'Loads on first use' : 'In memory',
            contextNote(model.context),
            model.tools === null && 'Tool calling is tested on first use',
            !model.vision && 'Cannot see pictures',
          ]),
          // LM Studio models PartBuddy loads itself get its context (loadInLmStudio).
          ...windowOf(server.name === 'LM Studio' && model.loading ? LOCAL_CONTEXT : model.context),
        },
        server: server.name,
        vision: model.vision,
        numCtx: null,
        openAiBase: `${server.url}/v1`,
        serverModel: model.id,
        toolTest: model.tools === null,
        loadAt: server.name === 'LM Studio' && model.loading ? server.url : null,
      });
    }
  }
  return runnable;
}

/** The dummy tool of the connection test (ADR 0011): it only answers. */
const PING = 'partbuddy_ping';

export class LocalAgent implements AgentBackend {
  private ollama: OllamaFound | null = null;
  private strata: StrataFound | null = null;
  private servers: OpenAiServer[] = [];
  private probed = false;
  private choice: ModelChoice | null = null;
  private history: ModelMessage[] = [];
  private abort: AbortController | null = null;
  private busy = false;
  private sequence = 0;
  /** Models that passed or failed the tool test, by option id; kept while PartBuddy runs. */
  private readonly tested = new Set<string>();
  private readonly failed = new Set<string>();
  /** LM Studio models PartBuddy loaded with enough context. */
  private readonly prepared = new Set<string>();
  /** How full the conversation is after the last turn. */
  private context: AgentStatus['context'] | null = null;

  constructor(private readonly options: LocalAgentOptions) {}

 private runnable(): Runnable[] {
  return usableModels(
    this.ollama,
    this.strata,
    this.servers,
    this.failed,
    this.options.contextSize?.() ?? LOCAL_CONTEXT,
  );
}

  private models(): ModelOption[] {
    return this.runnable().map((entry) => entry.option);
  }

  status(): AgentStatus {
    const status: AgentStatus = { agent: 'local', state: 'checking' };
    if (this.probed) {
      const chosen = this.runnable().find((entry) => entry.option.id === this.choice?.model);
      if (!this.ollama && !this.strata && this.servers.length === 0) {
        status.state = 'unavailable';
        status.detail = 'No local model server answers. Start Ollama, Strata, LM Studio, llama.cpp or vLLM and press Check again.';
      } else if (!chosen) {
        status.state = 'unavailable';
        status.detail = this.strata?.keyNeeded
          ? 'Strata asks for an API key, which PartBuddy cannot send yet. Serve it without a key on this computer ("api_key": "none").'
          : 'No local model can call tools with enough context. Load one, for example: ollama pull qwen3.5:9b';
      } else {
        status.state = this.busy ? 'busy' : 'ready';
        status.account = chosen.server;
        if (chosen.server === 'Ollama' && this.ollama) status.version = this.ollama.version;
        if (this.context) status.context = this.context;
      }
    }
    return { ...status, ...choiceStatus(this.models(), this.choice, this.options.choices.get('local')) };
  }

  async refresh(): Promise<AgentStatus> {
    const fetchFn = this.options.fetch ?? fetch;
    const strataUrl = this.options.strataUrl ?? STRATA_URL;
    const [ollama, strata] = await Promise.all([
      findOllama(fetchFn, this.options.url).catch((error: unknown) => {
        this.options.log(`Ollama could not be read: ${(error as Error).message}`);
        return null;
      }),
      findStrata(fetchFn, strataUrl),
    ]);
    // Strata and llama.cpp share port 8080; a Strata found there is not asked again as llama.cpp.
    this.servers = await findOpenAiServers(fetchFn, strata ? [strataUrl] : [], this.options.openAiServers ?? OPENAI_SERVERS);
    this.ollama = ollama;
    this.strata = strata;
    this.probed = true;
    const models = this.models();
    this.choice = allowedChoice(models, this.choice ?? this.options.choices.get('local')) ?? allowedChoice(models, models[0] ? { model: models[0].id, effort: null } : null);
    this.options.changed();
    return this.status();
  }

  signIn(): void {
    void this.refresh();
  }

  async signOut(): Promise<void> {
    await this.newConversation();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await Promise.resolve();
  }

  async newConversation(): Promise<void> {
    await this.stop();
    this.history = [];
    this.context = null;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  freshConversation(): boolean {
    return this.history.length === 0;
  }

  chooseModel(choice: ModelChoice, asDefault: boolean): Promise<void> {
    const allowed = allowedChoice(this.models(), choice);
    if (!allowed) throw new Error(`model ${choice.model} is not available locally`);
    this.choice = allowed;
    if (asDefault) this.options.choices.set('local', allowed);
    this.options.changed();
    return Promise.resolve();
  }

  async send(text: string, selections: Selection[] = [], note: string | null = null, images: readonly Uint8Array[] = [], kind: PictureKind = 'sketch'): Promise<void> {
    if (this.status().state !== 'ready') throw new Error(`assistant is ${this.status().state}`);
    const model = this.runnable().find((entry) => entry.option.id === this.choice?.model);
    if (!model) throw new Error('no local model is chosen');
    const upstream = await this.options.tools();
    if (!upstream) {
      this.options.event({ type: 'error', message: 'SolidCraft is not connected' });
      return;
    }
    const message = composeMessage(text, selections, note);
    this.options.event(userEvent(text, message.label, message.summary, images.length > 0 ? kind : undefined));
    // A model without vision gets the words only, and the user learns why the picture went nowhere.
    const pictures = model.vision ? images : [];
    if (images.length > 0 && pictures.length === 0) this.options.event({ type: 'error', message: `${model.option.name} cannot see pictures; it got your words only.` });
    const turn: ModelMessage = pictures.length > 0
      ? { role: 'user', content: [{ type: 'text', text: message.prompt }, ...pictures.map((image) => ({ type: 'image' as const, image, mediaType: 'image/png' }))] }
      : { role: 'user', content: message.prompt };
    this.busy = true;
    this.options.changed();
    const abort = new AbortController();
    this.abort = abort;
    void this.run(upstream, model, turn, abort.signal).finally(() => {
      this.busy = false;
      this.abort = null;
      this.options.changed();
    });
  }

  /** The AI SDK model and its request options for the server that runs it. */
  private languageModel(model: Runnable): { model: LanguageModel; providerOptions: ProviderOptions } {
    const fetchOption = this.options.fetch ? { fetch: this.options.fetch } : {};
    if (model.openAiBase) {
      // A local server needs no key on this computer; the SDK wants one, so it gets a placeholder.
      const base = model.server === 'Strata' && this.options.strataUrl ? `${this.options.strataUrl}/v1` : model.openAiBase;
      const server = createOpenAI({ baseURL: base, apiKey: 'none', ...fetchOption });
      return {
        model: server.chat(model.serverModel),
        providerOptions: { openai: model.server === 'Strata' && this.choice?.effort ? { reasoningEffort: this.choice.effort } : {} },
      };
    }
    const ollama = createOllama({ baseURL: `${this.options.url ?? OLLAMA_URL}/api`, ...fetchOption });
    // shortcut: thinking stays off for speed on small GPUs; offer it as the effort once models need it.
    return { model: ollama(model.serverModel), providerOptions: { ollama: { think: false, options: { num_ctx: model.numCtx ?? undefined } } } };
  }

  /**
   * The connection test (ADR 0011): one short request with a dummy tool the model is asked to call.
   * Shown as a tool card, so the user sees why the first answer takes a moment.
   */
  private async toolTest(model: Runnable, languageModel: LanguageModel, signal: AbortSignal): Promise<string | null> {
    this.sequence += 1;
    const id = `local-${String(this.sequence)}`;
    const summary = `Can ${model.option.name} call tools?`;
    this.options.event({ type: 'tool', id, name: PING, summary, decision: 'allowed' });
    let problem: string | null = null;
    try {
      const result = await generateText({
        model: languageModel,
        messages: [{ role: 'user', content: `Call the tool ${PING} with word "ok". Do not write anything else.` }],
        tools: {
          [PING]: tool({
            description: 'Connection test of PartBuddy: call it when asked.',
            inputSchema: jsonSchema({ type: 'object', properties: { word: { type: 'string' } }, required: ['word'] }),
            execute: () => Promise.resolve('pong'),
          }),
        },
        stopWhen: stepCountIs(1),
        abortSignal: signal,
        maxRetries: 0,
      });
      if (!result.toolCalls.some((call) => call.toolName === PING)) problem = 'it answered without calling the test tool';
    } catch (error) {
      if (signal.aborted) throw error;
      problem = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
    this.options.event({ type: 'tool', id, name: PING, summary, decision: 'allowed', ok: problem === null });
    return problem;
  }

  private async run(upstream: UpstreamTools, model: Runnable, turn: ModelMessage, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    try {
      const { model: languageModel, providerOptions } = this.languageModel(model);
      if (model.loadAt && !this.prepared.has(model.option.id)) {
        await loadInLmStudio(this.options.fetch ?? fetch, model.loadAt, model.serverModel, LOCAL_CONTEXT);
        this.prepared.add(model.option.id);
      }
      if (model.toolTest && !this.tested.has(model.option.id)) {
        const problem = await this.toolTest(model, languageModel, signal);
        if (problem) {
          this.failed.add(model.option.id);
          this.choice = allowedChoice(this.models(), this.choice ? { model: this.models()[0]?.id ?? '', effort: null } : null);
          this.options.log(`local model ${model.option.id} failed the tool test: ${problem}`);
          this.options.event({ type: 'error', message: `${model.option.name} cannot call tools (${problem}), so it cannot work on the design. Pick another model.` });
          this.options.event({ type: 'done', ok: false, durationMs: Date.now() - started, detail: 'failed' });
          return;
        }
        this.tested.add(model.option.id);
      }
      this.history.push(turn);
      const result = streamText({
        model: languageModel,
        instructions: instructionsFor(upstream, false),
        messages: this.history,
        tools: await policyToolSet(upstream, {
          nextId: () => `local-${String((this.sequence += 1))}`,
          event: (event) => {
            this.options.event(event);
          },
        }),
        stopWhen: [stepCountIs(MAX_STEPS), repeatsItself],
        abortSignal: signal,
        providerOptions,
        // A local server that refuses a request refuses it again; the user gets its reason at once.
        maxRetries: 0,
      });
      for await (const part of result.stream) {
        if (part.type === 'text-delta') this.options.event({ type: 'textDelta', text: part.text });
        if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
      this.history.push(...(await result.responseMessages));
      this.context = contextAfter(await result.steps, model.option.context) ?? this.context;
      if (repeatsItself({ steps: await result.steps })) {
        this.options.event({ type: 'error', message: LOOP_NOTICE });
        this.options.event({ type: 'done', ok: false, durationMs: Date.now() - started, detail: 'failed' });
        return;
      }
      this.options.event({ type: 'done', ok: true, durationMs: Date.now() - started, detail: null });
    } catch (error) {
      const stopped = signal.aborted;
      if (!stopped) this.options.event({ type: 'error', message: serverReason(error) });
      this.options.event({ type: 'done', ok: false, durationMs: Date.now() - started, detail: stopped ? 'stopped' : 'failed' });
    }
  }
}

/**
 * The server's own words for a failed request: the SDK says only "stream failed before any output"
 * and keeps the server's answer in `responseBody` ("request (9376 tokens) exceeds the available
 * context size (8192 tokens)" from LM Studio).
 */
export function serverReason(error: unknown): string {
  const seen = (error as { lastError?: unknown } | null)?.lastError ?? error;
  const body = (seen as { responseBody?: unknown } | null)?.responseBody;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
      if (typeof message === 'string' && message) return `The local server refused the request: ${message}`.slice(0, 500);
    } catch {
      // not JSON: the plain message below
    }
  }
  return (seen instanceof Error ? seen.message : String(seen)).slice(0, 500);
}

/** The per-request options streamText takes, by provider. */
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
