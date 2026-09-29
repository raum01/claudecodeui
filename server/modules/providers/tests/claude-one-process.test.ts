import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { abortClaudeSDKSession, queryClaudeSDK, resolveToolApproval } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * One conversation must be driven by one CLI process at a time.
 *
 * The stand-in below reproduces the three CLI/SDK behaviours that let a
 * second process appear next to a held one (measured 2026-09-29 on the live
 * install, CLI 2.1.281, SDK 0.3.266, and read from the SDK source):
 *
 *  1. Closing the prompt iterable ends the CLI's stdin.
 *  2. After stdin ends, a CLI with background agents still running does not
 *     exit: it waits for them (up to CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) and
 *     keeps running the turns their notifications trigger.
 *  3. A control request written after stdin ended is dropped by the SDK
 *     ("Dropping write to ended stdin stream"), so `interrupt()` never
 *     reaches the CLI; its promise only rejects, with "Query closed before
 *     response received", once the query is finally closed.
 *
 * Only `close()` stops such a process.
 */

const SESSION_ID = 'app-one-process-session';
const NATIVE_ID = 'native-one-process-session';

type FakeCli = {
  id: number;
  alive: boolean;
  stdinEnded: boolean;
  prompts: Array<{ uuid?: string; message?: { content?: unknown } }>;
  emit: (message: Record<string, unknown>) => void;
  exit: () => void;
};

type Harness = {
  spawned: FakeCli[];
  maxAlive: () => number;
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>;
  /** Background work the CLI is still waiting for; while non-empty an EOF does not end the process. */
  outstanding: Set<string>;
  /** Makes the CLI ignore EOF altogether, as one stuck in a hook or MCP shutdown would. */
  lingerOnEof: boolean;
  /** Makes the CLI never answer an interrupt, even with stdin open. */
  wedged: boolean;
  /** SDK options of the most recent query, for calling its `canUseTool`. */
  options: Record<string, any>;
};

function createHarness(): Harness {
  const harness = { lingerOnEof: false, wedged: false } as Harness;
  const spawned: FakeCli[] = [];
  const outstanding = new Set<string>();
  let peak = 0;
  const countAlive = () => {
    peak = Math.max(peak, spawned.filter((cli) => cli.alive).length);
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    harness.options = options;
    const queue: Array<Record<string, unknown> | null> = [];
    let wake: (() => void) | null = null;
    let rejectDroppedControls: Array<(error: Error) => void> = [];

    const cli: FakeCli = {
      id: spawned.length + 1,
      alive: true,
      stdinEnded: false,
      prompts: [],
      emit: (message) => { queue.push(message); wake?.(); },
      exit: () => {
        if (!cli.alive) return;
        cli.alive = false;
        queue.push(null);
        wake?.();
        for (const reject of rejectDroppedControls) reject(new Error('Query closed before response received'));
        rejectDroppedControls = [];
      },
    };
    spawned.push(cli);
    countAlive();

    void (async () => {
      for await (const message of prompt) {
        cli.prompts.push(message as FakeCli['prompts'][number]);
      }
      cli.stdinEnded = true;
      // Print wind-down: exit at once unless background agents are still running.
      if (outstanding.size === 0 && !harness.lingerOnEof) cli.exit();
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) return;
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: () => {
        if (cli.stdinEnded || harness.wedged) {
          // The SDK drops the control request; nothing answers it.
          return new Promise<void>((_resolve, reject) => { rejectDroppedControls.push(reject); });
        }
        return Promise.resolve();
      },
      stopTask: async (taskId: string) => { outstanding.delete(taskId); },
      close: () => { cli.exit(); },
    });
  };

  return Object.assign(harness, { spawned, maxAlive: () => peak, createQuery, outstanding });
}

function createContext(createQuery: Harness['createQuery']): ProviderRuntimeContext {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
}

const createWriter = () => {
  const sent: NormalizedMessage[] = [];
  return { sent, writer: { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null } };
};

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const agentLaunch = (toolUseId: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { prompt: 'work', run_in_background: true } }] },
});
const taskStarted = (taskId: string, toolUseId: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: 'local_agent',
});
const taskNotification = (taskId: string, toolUseId: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status: 'completed', summary: `Task ${taskId} completed`, output_file: '',
});
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
// The CLI echoes the uuid of the user message a turn answered (verified on CLI 2.1.281).
const result = (userMessageUuid?: string) => ({
  type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1,
  ...(userMessageUuid ? { user_message_uuid: userMessageUuid, user_message_uuids: [userMessageUuid] } : {}),
});

const promptText = (prompt: FakeCli['prompts'][number]) => {
  const content = prompt.message?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
};

test('a message sent while background work holds the process goes into that process', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const second = createWriter();

  try {
    // Turn 1 launches a background agent and ends; the process is held for it.
    const firstRun = queryClaudeSDK('launch an agent', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    harness.outstanding.add('agent-1');
    cli.emit(init());
    cli.emit(agentLaunch('toolu_agent'));
    cli.emit(taskStarted('agent-1', 'toolu_agent'));
    cli.emit(result(cli.prompts[0].uuid));
    await until(() => first.sent.some((message) => message.kind === 'complete'), 'turn 1 complete');

    // Turn 2 arrives while the agent is still running.
    const secondRun = queryClaudeSDK('what is the agent doing?', { sessionId: SESSION_ID, cwd }, second.writer as never, context);
    await until(
      () => cli.prompts.length === 2 || harness.spawned.length > 1,
      'turn 2 to reach a CLI',
    );

    assert.equal(harness.spawned.length, 1, 'turn 2 must not spawn a second CLI while the first is alive');
    assert.equal(harness.maxAlive(), 1, 'never more than one live CLI for the conversation');
    assert.equal(promptText(cli.prompts[1]), 'what is the agent doing?');
    assert.equal(cli.stdinEnded, false, 'the held process keeps its stdin for later turns');

    cli.emit(assistantText('It is still working.'));
    cli.emit(result(cli.prompts[1].uuid));
    await secondRun;
    assert.equal(second.sent.filter((message) => message.kind === 'complete').length, 1);

    // The agent reports back to the same process, and the follow-up turn it
    // triggers reaches the writer of the conversation's latest turn.
    harness.outstanding.delete('agent-1');
    cli.emit(taskNotification('agent-1', 'toolu_agent'));
    cli.emit(assistantText('The agent finished.'));
    cli.emit(result());
    await until(
      () => second.sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'),
      'the agent follow-up on the latest writer',
    );
    assert.equal(
      first.sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'),
      false,
      'the superseded turn\'s writer must not receive later output',
    );

    void firstRun;
  } finally {
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a new process is started only after the previous one is gone', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const second = createWriter();

  try {
    // An idle conversation (nothing in the background) whose next turn needs
    // a fresh process: an edit resumes the transcript partway, which only a
    // new CLI can do.
    const firstRun = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(result(cli.prompts[0].uuid));
    await until(() => first.sent.some((message) => message.kind === 'complete'), 'turn 1 complete');

    const secondRun = queryClaudeSDK('edited', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'anchor-row' }, second.writer as never, context);
    await until(() => harness.spawned.length === 2, 'the replacement CLI');
    const replacement = harness.spawned[1];
    assert.equal(cli.alive, false, 'the previous CLI is gone before its replacement starts');
    assert.equal(harness.maxAlive(), 1);

    await until(() => replacement.prompts.length === 1, 'the edited prompt');
    replacement.emit(init());
    replacement.emit(result(replacement.prompts[0].uuid));
    await secondRun;
    await firstRun;
  } finally {
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn settles when it completes, while its conversation keeps the CLI', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();

  try {
    // The agent API and the scheduled-message dispatcher wait on this
    // promise; it must not wait out the idle process behind the turn.
    let settled = false;
    const run = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context)
      .then(() => { settled = true; });
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(result(cli.prompts[0].uuid));
    await until(() => settled, 'the turn to settle');
    assert.equal(cli.alive, true, 'the idle CLI stays for the next turn');
    await run;
  } finally {
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a run without a session id settles and lets its CLI exit when its turn completes', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();

  try {
    // Commit-message generation: no app session, so no later turn can ever
    // reach this CLI, and the HTTP request is waiting on the turn.
    let settled = false;
    const run = queryClaudeSDK('write a commit message', { cwd }, first.writer as never, context)
      .then(() => { settled = true; });
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(assistantText('fix: something'));
    cli.emit(result(cli.prompts[0].uuid));
    await until(() => settled, 'the run to settle');
    await until(() => !cli.alive, 'the CLI to exit');
    assert.equal(cli.stdinEnded, true);
    await run;
  } finally {
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an abort while the old CLI winds down for a restart cancels the new turn too', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const second = createWriter();

  try {
    const firstRun = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(result(cli.prompts[0].uuid));
    await until(() => first.sent.some((message) => message.kind === 'complete'), 'turn 1 complete');

    harness.lingerOnEof = true;
    const secondRun = queryClaudeSDK('edited', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'anchor-row' }, second.writer as never, context);
    await until(() => cli.stdinEnded, 'the old CLI to be asked to exit');
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await secondRun;
    await firstRun;

    assert.equal(cli.alive, false);
    assert.equal(harness.spawned.length, 1, 'the aborted turn must not start a CLI');
  } finally {
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a CLI that ignores EOF is closed before its replacement starts', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const second = createWriter();
  const drain = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  try {
    const firstRun = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(result(cli.prompts[0].uuid));
    await until(() => first.sent.some((message) => message.kind === 'complete'), 'turn 1 complete');

    harness.lingerOnEof = true;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const secondRun = queryClaudeSDK('edited', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'anchor-row' }, second.writer as never, context);
    for (let i = 0; i < 20 && !cli.stdinEnded; i++) await drain();
    assert.equal(cli.stdinEnded, true);
    t.mock.timers.tick(9_999);
    for (let i = 0; i < 20; i++) await drain();
    assert.equal(harness.spawned.length, 1, 'the grace period is still running');
    assert.equal(cli.alive, true);

    t.mock.timers.tick(1);
    for (let i = 0; i < 20 && cli.alive; i++) await drain();
    assert.equal(cli.alive, false, 'the lingering CLI is closed');
    // The replacement's setup reads files; give it real time.
    t.mock.timers.reset();
    await until(() => harness.spawned.length === 2, 'the replacement CLI');
    assert.equal(harness.maxAlive(), 1);

    const replacement = harness.spawned[1];
    await until(() => replacement.prompts.length === 1, 'the edited prompt');
    replacement.emit(init());
    replacement.emit(result(replacement.prompts[0].uuid));
    await secondRun;
    await firstRun;
  } finally {
    t.mock.timers.reset();
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Stop still closes a CLI that never answers the interrupt', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const drain = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  try {
    const run = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    await until(() => first.sent.length > 0 || cli.prompts.length === 1, 'the turn to start');

    harness.wedged = true;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted: boolean | null = null;
    void abortClaudeSDKSession(SESSION_ID).then((value) => { aborted = value; });
    for (let i = 0; i < 20; i++) await drain();
    assert.equal(cli.alive, true, 'the interrupt is still being waited for');

    t.mock.timers.tick(5_000);
    for (let i = 0; i < 50 && aborted === null; i++) await drain();
    t.mock.timers.reset();
    assert.equal(cli.alive, false, 'the unanswered interrupt did not keep the CLI alive');
    assert.equal(aborted, true);
    await run;
  } finally {
    t.mock.timers.reset();
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('background work of a run without a session id is bounded by the idle timeout', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const drain = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  try {
    const run = queryClaudeSDK('write a commit message', { cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the prompt');
    const cli = harness.spawned[0];
    harness.outstanding.add('agent-1');
    cli.emit(init());
    cli.emit(agentLaunch('toolu_agent'));
    cli.emit(taskStarted('agent-1', 'toolu_agent'));
    // The ceiling is armed when the turn's result lands.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    cli.emit(result(cli.prompts[0].uuid));
    await run;
    for (let i = 0; i < 20; i++) await drain();
    assert.equal(cli.stdinEnded, false, 'held while its work runs');

    // Nobody can see or stop this work from the UI, and its notification
    // never comes: the idle timeout is its ceiling.
    t.mock.timers.tick(30 * 60 * 1000);
    for (let i = 0; i < 20 && !cli.stdinEnded; i++) await drain();
    t.mock.timers.reset();
    assert.equal(cli.stdinEnded, true);
  } finally {
    t.mock.timers.reset();
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a permission prompt is retracted on the stream that showed it', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const second = createWriter();

  try {
    const firstRun = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(result(cli.prompts[0].uuid));
    await firstRun;

    // An automatic turn asks for a permission on turn 1's stream...
    const decision = harness.options.canUseTool('AskUserQuestion', { question: 'Proceed?' }, { signal: new AbortController().signal });
    const request = first.sent.find((message) => message.kind === 'permission_request');
    assert.ok(request?.requestId);

    // ...then the user sends the next message, which takes the writer over.
    const secondRun = queryClaudeSDK('next', { sessionId: SESSION_ID, cwd }, second.writer as never, context);
    await until(() => cli.prompts.length === 2, 'turn 2 in the same CLI');
    resolveToolApproval(request.requestId as string, { allow: true });
    assert.equal((await decision).behavior, 'allow');

    assert.ok(first.sent.some((message) => message.kind === 'permission_resolved' && message.requestId === request.requestId));
    assert.equal(second.sent.some((message) => message.kind === 'permission_resolved'), false);
    cli.emit(result(cli.prompts[1].uuid));
    await secondRun;
  } finally {
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Stop returns before the stopped turn settles, so the caller reports it as aborted', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-one-process-'));
  const harness = createHarness();
  const context = createContext(harness.createQuery);
  const first = createWriter();
  const second = createWriter();

  try {
    const firstRun = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, first.writer as never, context);
    await until(() => harness.spawned[0]?.prompts.length === 1, 'the first prompt');
    const cli = harness.spawned[0];
    cli.emit(init());
    cli.emit(result(cli.prompts[0].uuid));
    await firstRun;

    // The chat handler awaits the abort and then emits the aborted
    // `complete`; the dispatcher's safety net emits a failed one when the
    // run's promise settles first. The abort has to come back first.
    const order: string[] = [];
    const secondRun = queryClaudeSDK('long task', { sessionId: SESSION_ID, cwd }, second.writer as never, context)
      .then(() => { order.push('run settled'); });
    await until(() => cli.prompts.length === 2, 'turn 2 in the same CLI');
    await abortClaudeSDKSession(SESSION_ID).then(() => { order.push('abort returned'); });
    await secondRun;
    assert.deepEqual(order, ['abort returned', 'run settled']);
    assert.equal(cli.alive, false);
  } finally {
    await abortClaudeSDKSession(SESSION_ID);
    for (const cli of harness.spawned) cli.exit();
    await rm(cwd, { recursive: true, force: true });
  }
});
