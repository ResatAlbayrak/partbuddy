import { jsonSchema, tool, type StopCondition, type ToolSet } from 'ai';

import type { AgentEvent } from '../../shared/contract';
import type { ToolResult, UpstreamTools } from './gateProxy';
import { decide } from './policy';
import { cadToolDescription, normalizeToolArguments } from './toolArguments';
import { ANSWER_GUIDANCE, QUESTION_GUIDANCE } from './questions';
import { RESEARCH_GUIDANCE } from './research';
import { withToolNotes } from './toolNotes';
import { VIEW_GUIDANCE } from './viewContext';
import { ASSEMBLY_GUIDANCE, JOINT_GUIDANCE } from './assemblyTool';
import { BLOCK_GUIDANCE } from './blockTool';
import { MECHANISM_GUIDANCE } from './mechanismTool';

/**
 * What PartBuddy's own agent loop shares between its routes (ChatGPT plan, local models): the
 * instructions and SolidCraft's tools behind the same policy as the gate proxy (ADR 0010).
 */

const INSTRUCTIONS = [
  'You are the design assistant inside PartBuddy, a desktop app for 3D-printable parts.',
  'SolidCraft is open and the user watches every step live, mirrored in PartBuddy.',
  'Use the solidcraft tools to inspect and change the design. Work in small visible steps:',
  'one sketch or one feature group per call. Units are millimetres.',
  'If PartBuddy refuses a tool, tell the user why and continue without it.',
  'Answer in the language the user writes in, and name bodies, features and sketches in it too: the structure tree and the timeline show these names.',
  VIEW_GUIDANCE,
  ASSEMBLY_GUIDANCE,
  JOINT_GUIDANCE,
  MECHANISM_GUIDANCE,
  BLOCK_GUIDANCE,
  QUESTION_GUIDANCE,
  ANSWER_GUIDANCE,
].join(' ');

/** Tool rounds per turn before the loop stops. */
export const MAX_STEPS = 25;

/**
 * The AI SDK can stop at the round budget while the last turn still asks for
 * tools. That is not a completed answer, even when the stream ends normally.
 */
export function reachedStepCap(steps: readonly { toolCalls: readonly unknown[] }[], limit = MAX_STEPS): boolean {
  return steps.length >= limit && (steps.at(-1)?.toolCalls.length ?? 0) > 0;
}

/** Rounds in a row with the same tool calls after which the loop stops: small models can circle. */
export const REPEAT_LIMIT = 3;

/** Told to the user when {@link repeatsItself} stopped a turn. */
export const LOOP_NOTICE = 'The model repeated the same tool calls three times in a row, so PartBuddy stopped this turn. Rephrase the request or pick a stronger model.';

/** What a round called; rounds of only unknown or unreadable calls count as one kind, whatever the names. */
function roundCalls(step: Parameters<StopCondition<ToolSet>>[0]['steps'][number]): string {
  const calls = step.toolCalls;
  if (calls.length > 0 && calls.every((call) => call.invalid === true)) return 'invalid';
  return JSON.stringify(calls.map((call) => [call.toolName, call.input as unknown]));
}

/** Stop condition: the last {@link REPEAT_LIMIT} rounds made the same tool calls (or only invalid ones). */
export const repeatsItself: StopCondition<ToolSet> = ({ steps }) => {
  if (steps.length < REPEAT_LIMIT) return false;
  const rounds = steps.slice(-REPEAT_LIMIT).map(roundCalls);
  return rounds[0] !== '[]' && rounds.every((round) => round === rounds[0]);
};

/**
 * How full the context is after a turn: the last request's input plus its answer, which the next
 * request carries. Null without a known window or when the server reported no token counts.
 */
export function contextAfter(steps: { usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }[], size: number | undefined): { used: number; size: number } | null {
  const usage = steps.at(-1)?.usage;
  if (!size || typeof usage?.inputTokens !== 'number') return null;
  return { used: Math.max(0, Math.round(usage.inputTokens + (usage.outputTokens ?? 0))), size };
}

/**
 * PartBuddy's role, then SolidCraft's server instructions with PartBuddy's tool notes: the gate
 * proxy hands those to Claude Code as MCP instructions, this loop has to pass them itself.
 */
export function instructionsFor(upstream: UpstreamTools, research: boolean): string {
  return `${INSTRUCTIONS}${research ? ` ${RESEARCH_GUIDANCE}` : ''}\n\n${withToolNotes(upstream.instructions())}`;
}

/** Text of an MCP tool result for the model; images are summarised, not forwarded. */
function resultText(result: ToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : `[${part.type} omitted]`))
    .join('\n');
}

/** Short SolidCraft error detail for an opt-in diagnostics view; successful calls have none. */
export function toolFailureReason(result: ToolResult): string | undefined {
  if (result.isError !== true) return undefined;
  const output = resultText(result).trim();
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      const reply = parsed as Record<string, unknown>;
      const failure = reply.failed;
      if (failure && typeof failure === 'object' && typeof (failure as Record<string, unknown>).error === 'string') {
        return String((failure as Record<string, unknown>).error).slice(0, 500);
      }
      if (typeof reply.error === 'string') return reply.error.slice(0, 500);
    }
  } catch {
    // SolidCraft often returns plain text instead of JSON.
  }
  return (output || 'SolidCraft returned an error without details').slice(0, 500);
}

export interface PolicyToolOptions {
  /** A new id for each call, shown with its tool card. */
  nextId(): string;
  event(event: AgentEvent): void;
  /** Provider options for every tool, such as the OpenAI namespace. */
  providerOptions?: Parameters<typeof tool>[0]['providerOptions'];
}

/** SolidCraft's tools for the AI SDK; every call passes PartBuddy's policy first. */
export async function policyToolSet(upstream: UpstreamTools, options: PolicyToolOptions): Promise<ToolSet> {
  const tools: ToolSet = {};
  for (const definition of await upstream.listTools()) {
    tools[definition.name] = tool({
      description: cadToolDescription(definition.name, definition.description ?? definition.name),
      inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      execute: async (input: unknown) => callTool(upstream, definition.name, (input ?? {}) as Record<string, unknown>, options),
    });
  }
  return tools;
}

async function callTool(upstream: UpstreamTools, name: string, input: Record<string, unknown>, options: PolicyToolOptions): Promise<string> {
  const args = normalizeToolArguments(name, input);
  const id = options.nextId();
  const summary = JSON.stringify(args).slice(0, 2000);
  const decision = decide(name, args);
  if (!decision.allow) {
    options.event({ type: 'tool', id, name, summary, decision: 'denied', reason: decision.reason.slice(0, 500) });
    return decision.reason;
  }
  options.event({ type: 'tool', id, name, summary, decision: 'allowed' });
  try {
    const result = await upstream.callTool(name, args, id);
    options.event({ type: 'tool', id, name, summary, decision: 'allowed', ok: result.isError !== true, reason: toolFailureReason(result) });
    return result.isError === true
      ? `SOLIDCRAFT TOOL FAILED: ${resultText(result)}\nThis command did not complete. Inspect the design before claiming that the feature exists.`
      : resultText(result);
  } catch (error) {
    const message = `SolidCraft tool failed: ${error instanceof Error ? error.message : String(error)}`;
    options.event({ type: 'tool', id, name, summary, decision: 'allowed', ok: false, reason: message.slice(0, 500) });
    return `${message}\nThis command did not complete. Inspect the design before claiming that the feature exists.`;
  }
}
