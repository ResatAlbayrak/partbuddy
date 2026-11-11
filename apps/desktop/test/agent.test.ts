import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentService } from '../src/main/agents/agentService';
import { findClaudeCode, parseStreamLine } from '../src/main/agents/claudeCode';
import { GateProxy, REPEAT_REASON, type ToolCallRecord, type UpstreamTools } from '../src/main/agents/gateProxy';
import { decide } from '../src/main/agents/policy';
import { cadToolDescription, normalizeToolArguments } from '../src/main/agents/toolArguments';
import { TOOL_NOTES } from '../src/main/agents/toolNotes';
import { reachedStepCap } from '../src/main/agents/loop';
import { reduce, type ConversationItem } from '../src/renderer/src/assistant/store';
import type { AgentEvent, AgentStatus, ModelChoice } from '../src/shared/contract';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeUpstream() {
  const calls: string[] = [];
  const upstream: UpstreamTools = {
    instructions: () => 'SolidCraft drives the app.',
    listTools: () =>
      Promise.resolve([
        { name: 'inspect_design', description: 'The whole design', inputSchema: { type: 'object', properties: {} } },
        { name: 'export', description: 'Export bodies', inputSchema: { type: 'object', properties: {} } },
      ]),
    callTool: (name) => {
      calls.push(name);
      return Promise.resolve({ content: [{ type: 'text', text: `${name} ok` }] });
    },
  };
  return { upstream, calls };
}

describe('local agent step budget', () => {
  it('flags a full tool-calling round at the limit, but not a completed final answer', () => {
    const unfinished = Array.from({ length: 25 }, (_, index) => ({ toolCalls: index === 24 ? ['execute'] : [] }));
    expect(reachedStepCap(unfinished)).toBe(true);
    expect(reachedStepCap(unfinished.slice(0, 24))).toBe(false);
    expect(reachedStepCap(unfinished, 50)).toBe(false);
    expect(reachedStepCap(Array.from({ length: 50 }, () => ({ toolCalls: ['execute'] })), 50)).toBe(true);
    expect(reachedStepCap([...unfinished.slice(0, -1), { toolCalls: [] }])).toBe(false);
  });
});

describe('tool policy', () => {
  it('rejects reserved parameter names before sending a destructive batch', () => {
    const bad = { commands: [{ command: 'set_parameter', params: { name: 'L', value: 100 } }, { command: 'set_parameter', params: { name: 'floor', value: 3 } }] };
    const decision = decide('batch', bad);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain('floor');
    expect(decide('set_parameter', { name: 'floor', value: 3 }).allow).toBe(false);
    expect(decide('execute', { command: 'parameters.change', params: { name: 'floor', value: 3 } }).allow).toBe(false);
    expect(decide('batch', { commands: '[]' }).allow).toBe(false);
  });

  it('repairs only well-formed JSON-stringified command arrays', () => {
    const encoded = JSON.stringify([{ command: 'solid.box', params: { length: 30 } }]);
    expect(normalizeToolArguments('batch', { commands: encoded }).commands).toEqual([{ command: 'solid.box', params: { length: 30 } }]);
    expect(normalizeToolArguments('batch', { commands: 'not json' }).commands).toBe('not json');
    expect(normalizeToolArguments('batch', { commands: '{"not":"an array"}' }).commands).toBe('{"not":"an array"}');
    expect(normalizeToolArguments('execute', { commands: encoded }).commands).toBe(encoded);
    expect(cadToolDescription('batch', 'Batch tools')).toContain('JSON array');
  });

  it('normalizes shell face arrays in batches and direct execute calls', () => {
    const shell = { command: 'solid.shell', params: { faces: '[[50,35,32]]', thickness: 'wall' } };
    expect(normalizeToolArguments('batch', { commands: [shell] }).commands).toEqual([{ command: 'solid.shell', params: { faces: [[50, 35, 32]], thickness: 'wall' } }]);
    expect(normalizeToolArguments('execute', shell).params).toEqual({ faces: [[50, 35, 32]], thickness: 'wall' });
    expect(normalizeToolArguments('batch', { commands: JSON.stringify([shell]) }).commands).toEqual([{ command: 'solid.shell', params: { faces: [[50, 35, 32]], thickness: 'wall' } }]);
    expect(normalizeToolArguments('execute', { ...shell, params: { faces: 'not json' } }).params).toEqual({ faces: 'not json' });
    expect(decide('execute', { ...shell, params: { faces: 'not json' } }).allow).toBe(false);
  });

  it('blocks hallucinated CAD command names with actionable guidance', () => {
    for (const command of ['solid.round', 'solid.union']) {
      expect(decide('execute', { command, params: {} }).allow).toBe(false);
      expect(decide('batch', { commands: [{ command, params: {} }] }).allow).toBe(false);
      expect(decide('describe_command', { id: command }).allow).toBe(false);
    }
    expect(decide('execute', { command: 'solid.fillet', params: {} }).allow).toBe(true);
    expect(decide('execute', { command: 'solid.combine', params: {} }).allow).toBe(true);
  });

  it('allows reading and modelling tools', () => {
    expect(decide('inspect_design', {})).toEqual({ allow: true });
    expect(decide('execute', { command: 'solid.extrude', params: {} })).toEqual({ allow: true });
  });

  it('refuses tools that discard the design or touch files, with a reason', () => {
    for (const name of ['new_design', 'open', 'save', 'export']) {
      const decision = decide(name, {});
      expect(decision.allow, name).toBe(false);
    }
    expect(decide('unknown_tool', {}).allow).toBe(false);
  });

  it('refuses file commands hidden in execute and batch', () => {
    expect(decide('execute', { command: 'file.export', params: {} }).allow).toBe(false);
    expect(decide('batch', { commands: [{ command: 'sketch.line' }, { command: 'doc.open' }] }).allow).toBe(false);
    expect(decide('batch', { commands: [{ command: 'sketch.line' }] }).allow).toBe(true);
  });

  it('decides tools that SolidCraft runs as batch steps like the tools themselves', () => {
    for (const command of ['save', 'open', 'new_design', 'export', 'crash_reports']) {
      const decision = decide('batch', { commands: [{ command: 'solid.box', params: {} }, { command, params: { path: 'part.sc' } }] });
      expect(decision.allow, command).toBe(false);
      if (!decision.allow) expect(decision.reason).toContain(`batch step 1 (${command})`);
    }
    const nested = { commands: [{ command: 'execute', params: { command: 'file.save_as', params: { path: 'x.sc' } } }] };
    expect(decide('batch', nested).allow).toBe(false);
    expect(decide('batch', { commands: [{ command: 'set_parameter', params: { name: 'L', value: 40 } }] }).allow).toBe(true);
  });

  it('refuses settings, diagnostics and checkpoint commands with the next step', () => {
    expect(decide('execute', { command: 'settings.profile.export', params: { name: 'a' } }).allow).toBe(false);
    expect(decide('execute', { command: 'diagnostics.crash_reports', params: {} }).allow).toBe(false);
    const restore = decide('batch', { commands: [{ command: 'edit.restore_checkpoint', params: { checkpoint: 1 } }] });
    expect(restore.allow).toBe(false);
    if (!restore.allow) expect(restore.reason).toContain('Use undo and redo');
  });

  it('refuses a file path on any command but keeps geometry paths', () => {
    for (const path of ['out.dxf', 'designs\\part', 'notes']) {
      expect(decide('execute', { command: 'sketch.export_dxf', params: { path } }).allow, path).toBe(false);
    }
    expect(decide('execute', { command: 'sketch.export_dxf', params: {} }).allow).toBe(true);
    expect(decide('execute', { command: 'parameters.export', params: { format: 'json' } }).allow).toBe(true);
    expect(decide('execute', { command: 'solid.pattern.path', params: { path: ['l1', 'l2'], count: 3 } }).allow).toBe(true);
    expect(decide('execute', { command: 'construct.point.along_path', params: { path: 'l1', t: 0.5 } }).allow).toBe(true);
    expect(decide('execute', { command: 'component.activate', params: { component: 1, path: [2, 3] } }).allow).toBe(true);
  });
});

describe('gate proxy', () => {
  async function startProxy() {
    const { upstream, calls } = fakeUpstream();
    const records: ToolCallRecord[] = [];
    const proxy = new GateProxy(upstream, (record) => records.push(record));
    await proxy.start();
    cleanups.push(() => proxy.stop());
    return { proxy, calls, records };
  }

  async function connect(proxy: GateProxy, token = proxy.token) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(proxy.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    cleanups.push(() => client.close());
    return client;
  }

  it('lists SolidCraft tools unchanged and forwards allowed calls', async () => {
    const { proxy, calls, records } = await startProxy();
    const client = await connect(proxy);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['inspect_design', 'export']);
    expect(client.getInstructions()).toBe(`SolidCraft drives the app.\n\n${TOOL_NOTES}`);
    const result = await client.callTool({ name: 'inspect_design', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual(['inspect_design']);
    expect(records.at(-1)).toMatchObject({ name: 'inspect_design', decision: 'allowed', ok: true });
  });

  it('refuses gated calls without reaching SolidCraft', async () => {
    const { proxy, calls, records } = await startProxy();
    const client = await connect(proxy);
    const result = await client.callTool({ name: 'export', arguments: { path: 'x.3mf' } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(records.at(-1)).toMatchObject({ name: 'export', decision: 'denied' });
  });

  it('refuses the third identical call in a row until the next turn', async () => {
    const { proxy, calls, records } = await startProxy();
    const client = await connect(proxy);
    const inspect = () => client.callTool({ name: 'inspect_design', arguments: { depth: 1 } });
    await inspect();
    await inspect();
    const third = await inspect();
    expect(third.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({ name: 'inspect_design', decision: 'denied', reason: REPEAT_REASON });
    // Other arguments, or a new turn, start the count again.
    await client.callTool({ name: 'inspect_design', arguments: { depth: 2 } });
    await inspect();
    await inspect();
    proxy.newTurn();
    await inspect();
    expect(calls).toHaveLength(6);
  });

  it('refuses requests without the token or for another host', async () => {
    const { proxy } = await startProxy();
    await expect(connect(proxy, 'wrong')).rejects.toThrow();
    // A DNS-rebinding page would send its own host name; fetch cannot set Host, node:http can.
    const status = await new Promise<number | undefined>((done) => {
      const call = request(
        { host: '127.0.0.1', port: proxy.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${proxy.token}` } },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      call.end('{}');
    });
    expect(status).toBe(401);
  });
});

describe('Claude Code adapter', () => {
  it('maps stream-json lines to events', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","model":"m"}')).toEqual([{ type: 'started', model: 'm' }]);
    expect(
      parseStreamLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}'),
    ).toEqual([{ type: 'textDelta', text: 'Hi' }]);
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"A"},{"type":"tool_use"}]}}')).toEqual([
      { type: 'text', text: 'A' },
    ]);
    // Text blocks around a tool call stay paragraphs, while streaming and in the final text.
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"A."},{"type":"tool_use"},{"type":"text","text":"B"}]}}')).toEqual([
      { type: 'text', text: 'A.\n\nB' },
    ]);
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}}')).toEqual([
      { type: 'textDelta', text: '\n\n' },
    ]);
    expect(parseStreamLine('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}')).toEqual([]);
    expect(parseStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true}')).toEqual([
      { type: 'done', ok: false, durationMs: null, detail: 'error_max_turns' },
    ]);
    // An expired sign-in comes as a "success" with is_error; a plain error with is_error is a failure, not a stop.
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}')).toEqual([
      { type: 'done', ok: false, durationMs: null, detail: 'signedOut', reason: 'Failed to authenticate: OAuth session expired and could not be refreshed' },
    ]);
    // The made-up answer before it stays out of the chat: the German card says it (chat polish).
    expect(
      parseStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]},"error":"authentication_failed","isApiErrorMessage":true}',
      ),
    ).toEqual([]);
    // Another Claude Code process renewing the shared token is a failed turn, not a sign-out (2026-11-08).
    const refreshing = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh';
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: refreshing }))).toEqual([
      { type: 'done', ok: false, durationMs: null, detail: 'failed', reason: refreshing },
    ]);
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":true,"result":"API Error: 500"}')).toEqual([
      { type: 'done', ok: false, durationMs: null, detail: 'failed', reason: 'API Error: 500' },
    ]);
    expect(parseStreamLine('not json')).toEqual([]);
    // The plan's limits after a request (Claude Code 2.1.302); odd values are left out or clamped.
    expect(
      parseStreamLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":1.2},"seven_day":{"utilization":0.69,"resetsAt":1794117600},"odd":{"utilization":"x"}}}}'),
    ).toEqual([{ type: 'usage', windows: [{ window: 'five_hour', used: 1, resetsAt: null }, { window: 'seven_day', used: 0.69, resetsAt: 1794117600 }] }]);
    expect(parseStreamLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual([]);
    // Context: each request's prompt and answer, and the window with the result; odd counts are ignored.
    expect(parseStreamLine('{"type":"assistant","message":{"content":[],"usage":{"input_tokens":2,"cache_read_input_tokens":70,"cache_creation_input_tokens":18,"output_tokens":4}}}')).toEqual([{ type: 'context', used: 94 }]);
    expect(parseStreamLine('{"type":"assistant","message":{"content":[],"usage":{"input_tokens":2,"output_tokens":-1}}}')).toEqual([]);
    expect(parseStreamLine('{"type":"result","subtype":"success","modelUsage":{"a":{"contextWindow":200000},"b":{"contextWindow":1000000},"c":{"contextWindow":"x"}}}')[0]).toEqual({ type: 'context', size: 1000000 });
  });

  it('finds the native install in the user folder', () => {
    const home = join(tmpdir(), 'partbuddy-home');
    const expected = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    expect(findClaudeCode({}, home, (path) => path === expected)).toEqual({ command: expected, prefix: [] });
    expect(findClaudeCode({}, home, () => false)).toBeNull();
  });
});

describe('agent service with a fake Claude Code', () => {
  function setup(env: Record<string, string> = {}) {
    const workDir = mkdtempSync(join(tmpdir(), 'partbuddy-agent-'));
    cleanups.push(() => {
      rmSync(workDir, { recursive: true, force: true });
    });
    const { upstream, calls } = fakeUpstream();
    const billing = { allowed: false };
    const kept: { choice: ModelChoice | null } = { choice: null };
    const choices = { get: () => kept.choice, set: (_route: string, choice: ModelChoice) => (kept.choice = choice) };
    const statuses: AgentStatus[] = [];
    const events: AgentEvent[] = [];
    const service = new AgentService(
      {
        env: {
          ...process.env,
          PARTBUDDY_CLAUDE_COMMAND: JSON.stringify([process.execPath, resolve(__dirname, 'fakeClaude.mjs')]),
          ...env,
        },
        home: workDir,
        workDir,
        apiBilling: { get: () => billing.allowed, set: (allow: boolean) => (billing.allowed = allow) },
        tools: () => Promise.resolve(upstream),
        log: () => undefined,
        choices,
      },
      { status: (status) => statuses.push(status), event: (event) => events.push(event) },
    );
    cleanups.push(() => service.dispose());
    return { service, statuses, events, calls, workDir, kept };
  }

  it('shows the plan but never account data', async () => {
    const { service } = setup();
    const status = await service.refresh();
    expect(status).toMatchObject({ agent: 'claude-code', state: 'ready', version: '9.9.9', method: 'claude.ai', plan: 'max', apiBillingAllowed: false });
    expect(JSON.stringify(status)).not.toContain('example.com');
  });

  it('lets Claude Code leave on its own and starts it once for the models, however often it looks', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'partbuddy-claude-trace-'));
    cleanups.push(() => {
      rmSync(traceDir, { recursive: true, force: true });
    });
    const { service } = setup({ FAKE_CLAUDE_TRACE_DIR: traceDir });
    // Two looks at once are one; a third later reads no models again.
    await Promise.all([service.refresh(), service.refresh()]);
    await service.refresh();
    expect(readFileSync(join(traceDir, 'starts'), 'utf8')).toBe('start\n');
    // The process was not killed: it wrote its file after its input closed.
    expect(existsSync(join(traceDir, 'left'))).toBe(true);
  });

  it('lists the models of the plan and changes model and effort, also in a running session (B1)', async () => {
    const { service, events, kept } = setup();
    const status = await service.refresh();
    // The aliases with their effort levels; pinned older versions are left out.
    expect(status.models?.map((model) => model.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(status.models?.find((model) => model.id === 'haiku')?.efforts).toEqual(['low', 'medium', 'high']);
    // Nothing kept yet: the plan's default model with a named effort, as on the other routes.
    expect(status).toMatchObject({ model: 'default', effort: 'medium' });

    // Chosen before the first message: the session starts with it, and it is kept for new chats.
    await service.chooseModel({ model: 'sonnet', effort: 'low' }, true);
    expect(service.status()).toMatchObject({ model: 'sonnet', effort: 'low', defaultChoice: { model: 'sonnet', effort: 'low' } });
    expect(kept.choice).toEqual({ model: 'sonnet', effort: 'low' });
    await service.send('Which model?');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'done')).toHaveLength(1), { timeout: 15_000 });
    expect(events.filter((e) => e.type === 'text').at(-1)).toEqual({ type: 'text', text: 'model sonnet effort low' });
    // After an answer the status carries the plan's limits, and keeps them through a refresh.
    expect(service.status().usage).toEqual([{ window: 'five_hour', used: 0.23, resetsAt: 1794117600 }, { window: 'seven_day', used: 0.69, resetsAt: 1794117600 }]);
    expect((await service.refresh()).usage).toHaveLength(2);
    // And how full the session is: the last request's tokens of the model's window.
    expect(service.status().context).toEqual({ used: 43000, size: 200000 });

    // Changed mid-conversation: the running session switches; the kept default stays.
    await service.chooseModel({ model: 'haiku', effort: 'max' }, false);
    expect(service.status()).toMatchObject({ model: 'haiku', defaultChoice: { model: 'sonnet' } });
    // A level the model does not take becomes a named one ("medium"), never an unnamed default.
    expect(service.status().effort).toBe('medium');
    await service.send('Which model now?');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'done')).toHaveLength(2), { timeout: 15_000 });
    expect(events.filter((e) => e.type === 'text').at(-1)).toEqual({ type: 'text', text: 'model haiku effort medium' });

    await expect(service.chooseModel({ model: 'gpt-9', effort: null }, false)).rejects.toThrow(/not offered/);
  });

  it('asks the user to sign in when Claude Code is signed out', async () => {
    const { service } = setup({ FAKE_CLAUDE_SIGNED_OUT: '1' });
    expect((await service.refresh()).state).toBe('signedOut');
    await expect(service.send('hello')).rejects.toThrow(/signedOut/);
  });

  it('asks Claude Code again after an answer that says the sign-in expired, and stays usable while it holds', async () => {
    const { service, events } = setup();
    await service.refresh();
    await service.send('Expire my sign-in');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'done')).toHaveLength(1), { timeout: 15_000 });
    expect(events.find((e) => e.type === 'done')).toMatchObject({ detail: 'signedOut' });
    // `auth status` still says signed in: the chat is not locked until the next start.
    await vi.waitFor(() => expect(service.status().state).toBe('ready'), { timeout: 15_000 });
    // Let the check's model listing end before the work folder goes.
    expect((await service.refresh()).state).toBe('ready');
  });

  it('uses Claude Code with a subscription unless the user allowed API billing', async () => {
    const { service, events } = setup({ FAKE_CLAUDE_API_KEY: '1' });
    const status = await service.refresh();
    expect(status.state).toBe('needsSubscription');
    await expect(service.send('hello')).rejects.toThrow(/needsSubscription/);
    expect(events).toEqual([]);

    // The user may allow API billing explicitly; then the session runs.
    await service.allowApiBilling(true);
    expect(service.status()).toMatchObject({ state: 'ready', apiBillingAllowed: true });
    await service.send('How many bodies?');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done')).toBe(true), { timeout: 15_000 });
    await service.allowApiBilling(false);
    expect(service.status().state).toBe('needsSubscription');
  }, 30_000);

  it('runs a turn through the gate proxy and streams the answer', async () => {
    const { service, events, calls, statuses } = setup();
    await service.refresh();
    await service.send('How many bodies?');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done')).toBe(true), { timeout: 15_000 });
    expect(calls).toEqual(['inspect_design']);
    expect(events.find((e) => e.type === 'tool')).toMatchObject({ name: 'inspect_design', decision: 'allowed' });
    expect(events.filter((e) => e.type === 'textDelta').length).toBeGreaterThan(1);
    expect(events.find((e) => e.type === 'text')).toEqual({ type: 'text', text: 'The design has one body.' });
    expect(statuses.at(-1)?.state).toBe('ready');

    // The second turn reuses the session; a gated tool is refused and explained.
    await service.send('Please export it');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'done')).toHaveLength(2), { timeout: 15_000 });
    expect(calls).toEqual(['inspect_design']);
    expect(events.filter((e) => e.type === 'tool').at(-1)).toMatchObject({ name: 'export', decision: 'denied' });
  }, 30_000);

  it('removes its MCP configuration with the token on dispose', async () => {
    const { service, events, workDir } = setup();
    await service.refresh();
    await service.send('How many bodies?');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done')).toBe(true), { timeout: 15_000 });
    expect(readdirSync(workDir).some((name) => name.startsWith('mcp-'))).toBe(true);
    await service.dispose();
    expect(readdirSync(workDir).some((name) => name.startsWith('mcp-'))).toBe(false);
  }, 30_000);
});

describe('conversation items', () => {
  it('joins deltas into one answer and closes it with the final text', () => {
    let items: ConversationItem[] = [];
    const events: AgentEvent[] = [
      { type: 'user', text: 'Hi' },
      { type: 'textDelta', text: 'Hel' },
      { type: 'textDelta', text: 'lo' },
      { type: 'text', text: 'Hello' },
      { type: 'tool', id: 'c1', name: 'execute', summary: '{}', decision: 'allowed' },
      { type: 'tool', id: 'c1', name: 'execute', summary: '{}', decision: 'allowed', ok: true },
      { type: 'done', ok: false, durationMs: null, detail: 'stopped' },
    ];
    for (const event of events) items = reduce(items, event);
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'stopped']);
    expect(items[1]).toMatchObject({ text: 'Hello', open: false });
    expect(items[2]).toMatchObject({ ok: true });
  });
});
