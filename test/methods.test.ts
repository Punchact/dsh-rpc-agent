// Contract tests for the bridge logic, driven by a fake `sessionController`.
//
// These run out of process, so they pin the turn-tracking rules (subscribe →
// baseline snapshot → prompt → wait for `baseline.turn + 1`) without needing a
// live Harness. The fake mirrors the real shapes: `follow` yields a snapshot
// first and then live `{type:'event', event}` frames.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import ts from "typescript";

// The sticky-session registry lives under `$DSH_HOME/dsh-rpc/`. A suite that
// remembered a session between runs would make "created" vs "reused" depend on
// what ran five minutes ago, so every run gets its own home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-home-"));

import { resolveConfig } from "../dist/lib/config.mjs";
import { collectTurn, createMethods, METHOD_CATALOG } from "../dist/lib/methods.mjs";
import { buildDispatcher } from "../dist/lib/http.mjs";

// The bridge deliberately `unref()`s its timers so a bridge run never keeps the
// Host process alive. In this process those timers are the only handles, so a
// test that waits on one would see the loop drain and the run cancel itself
// (`cancelledByParent`, Linux only — Windows happens to keep other handles).
// The suite therefore holds one handle of its own for its whole lifetime.
const SUITE_KEEPALIVE = setInterval(() => {}, 60_000);
after(() => clearInterval(SUITE_KEEPALIVE));

const ORIGIN = { getOrigin: () => "http://127.0.0.1:0" };

function req<T>(value: T | undefined, what = "item"): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

interface FakeScriptStep {
  kind: "start" | "foreign" | "text" | "reasoning" | "tool" | "toolResult" | "end" | "rawEnd";
  turn?: number;
  own?: boolean;
  text?: string;
  callId?: string;
  name?: string;
  isError?: boolean;
  error?: unknown;
  gate?: Promise<unknown>;
  reason?: { kind: string; [key: string]: unknown };
}

interface FakeEvent {
  type: string;
  seq: number;
  time?: number;
  data: Record<string, unknown>;
}

interface TimelineEntry {
  kind: "model" | "prompt" | "permission";
  request?: Record<string, unknown>;
  sessionId?: string | undefined;
  name?: string;
}

interface FakeControllerOptions {
  script?: FakeScriptStep[];
  scripts?: FakeScriptStep[][] | null;
  historical?: FakeEvent[];
  distinctSessions?: boolean;
  timeline?: TimelineEntry[] | null;
  hostCwd?: string;
  models?: Record<string, unknown> | null;
  stuckAfterSnapshot?: boolean;
  stuckBeforeSnapshot?: boolean;
  stuckOnReturn?: boolean;
}

interface RpcErrorLike {
  code?: number;
  message?: string;
  data?: {
    sessionId?: string;
    turn?: number;
    next?: { tool?: string; args?: Record<string, unknown> };
    [key: string]: unknown;
  };
}

interface TurnToolRecord {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  seq: number;
  at: number;
  output?: string;
  isError?: boolean;
  error?: Record<string, unknown> | string;
  endedAt?: number;
  ok?: boolean;
}

interface CollectTurnResultLike {
  status?: string;
  reason?: { kind: string; [key: string]: unknown };
  text?: string;
  reasoning?: string;
  tools: TurnToolRecord[];
  [key: string]: unknown;
}

interface HistoryRecord {
  type: string;
  seq: number;
  time?: number;
  data?: Record<string, unknown>;
}

interface HistoryResult {
  sessionId: string;
  cursor: number;
  turn?: number;
  running?: boolean;
  messageCount?: number;
  hasMore?: boolean;
  truncated?: boolean;
  records: HistoryRecord[];
}

interface TurnResult {
  sessionId: string;
  turn: number | null;
  status: string;
  reason?: { kind: string; message?: string; [key: string]: unknown };
  partial?: boolean;
  text: string;
  reasoning?: string;
  tools: TurnToolRecord[];
  created?: boolean;
  reused?: boolean;
  rotated?: boolean;
  previousSessionId?: string;
  timedOut?: boolean;
  accepted?: boolean;
  requestId?: string;
  cwd?: string;
  usage?: Record<string, number | undefined>;
  selected?: { provider: string; model: string; reasoningEffort?: string };
  permissionPreset?: string;
  sandbox?: { denied: boolean; marker?: string; source?: string };
  since?: number;
  cursor: number;
  sliceMs?: number;
  requestedMs?: number;
  pendingApproval?: { approvalId: string; [key: string]: unknown };
  next?: { tool: string; reason?: string; args?: Record<string, unknown> };
  [key: string]: unknown;
}

interface DispatchResultTest {
  plugin: string;
  methods: Array<{ name: string; [key: string]: unknown }>;
  ok?: boolean;
  [key: string]: unknown;
}

interface MethodsTestApi {
  ask(
    params: Record<string, unknown>,
    options?: { onEvent?: (frame: { type: string; [key: string]: unknown }) => void; signal?: AbortSignal },
  ): Promise<TurnResult>;
  wait(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<TurnResult>;
  history(params: Record<string, unknown>): Promise<HistoryResult>;
  prompt(params: Record<string, unknown>): Promise<{
    accepted: boolean;
    mode: string;
    requestId: string;
    selected?: Record<string, unknown>;
  }>;
  cancel(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  listSessions(params?: Record<string, unknown>): Promise<{
    total: number;
    sort: string;
    items: Array<{ sessionId: string; [key: string]: unknown }>;
  }>;
  createSession(params?: Record<string, unknown>): Promise<{ sessionId: string; [key: string]: unknown }>;
  configure(params: Record<string, unknown>): Promise<{ permissionPreset?: string; [key: string]: unknown }>;
  permissionCatalog(): Promise<{
    defaultPreset: string | null;
    options: Array<{ value: string; cost: string | null; [key: string]: unknown }>;
  }>;
  listWorkspaces(params?: Record<string, unknown>): Promise<{
    total: number;
    items: Array<{
      id: string;
      title: string;
      path: string;
      status: string;
      sessions: number;
      createdAt: number;
      updatedAt: number;
    }>;
  }>;
  createWorkspace(params: Record<string, unknown>): Promise<{ id: string; [key: string]: unknown }>;
  discover(): Promise<{
    plugin: string;
    config: { defaultTimeoutMs: number; maxWaitSliceMs: number; [key: string]: unknown };
    methods: Array<{ name: string; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  ping(): Promise<{
    ok: boolean;
    activeRuns: Array<Record<string, unknown>>;
    taskCentre?: {
      autopilot?: Record<string, unknown>;
      autopilotStats?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  handlers: Record<string, (params?: Record<string, unknown>) => Promise<Record<string, unknown>>>;
}

interface ResolvedConfigTest {
  maxWaitSliceMs: number;
  maxWaitSliceMsRequested?: number;
  [key: string]: unknown;
}

async function waitFor(predicate: () => unknown | Promise<unknown>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bus<T = unknown>() {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else queue.push(item);
    },
    next(): Promise<IteratorResult<T>> {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };
}

function fakeController({
  script = [],
  scripts = null,
  historical = [],
  distinctSessions = false,
  timeline = null,
  hostCwd = "/host/resolved",
  models = null,
  stuckAfterSnapshot = false,
  stuckBeforeSnapshot = false,
  stuckOnReturn = false,
}: FakeControllerOptions = {}) {
  const events: FakeEvent[] = [...historical];
  const subscribers = new Set<(frame: { type: "event"; event: FakeEvent }) => void>();
  const prompts: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const sessions = new Map<string, { running: boolean; blank: boolean; cwd: string }>();
  const cancelled: Array<Record<string, unknown>> = [];
  const inspected: string[] = [];
  const selections: Array<Record<string, unknown>> = [];
  let seq = events.length > 0 ? req(events[events.length - 1], "last event").seq : 0;

  // The real SessionController dereferences the caller signal unconditionally
  // (`signal.throwIfAborted()`), so tolerating an undefined signal here would
  // hide a genuine crash class from the suite.
  const requireSignal = (signal: AbortSignal) => signal.throwIfAborted();

  const append = (type: string, data: Record<string, unknown>) => {
    seq += 1;
    const event: FakeEvent = { type, seq, time: Date.now(), data };
    events.push(event);
    for (const push of subscribers) push({ type: "event", event });
  };

  const controller = {
    events,
    prompts,
    created,
    cancelled,
    inspected,
    selections,

    async create(request: { agentPreset?: string; [key: string]: unknown }) {
      created.push(request);
      const sessionId = distinctSessions ? `session-${created.length}` : "session-test";
      if (distinctSessions) sessions.set(sessionId, { running: false, blank: true, cwd: hostCwd });
      return { sessionId, agentPreset: request.agentPreset };
    },

    async inspect(sessionId: string, signal: AbortSignal) {
      requireSignal(signal);
      inspected.push(sessionId);
      return { meta: { cwd: hostCwd }, inheritedEventCount: 0, events: [] };
    },

    async list(_request: unknown, signal: AbortSignal): Promise<{
      items: Array<{ sessionId: string; running: boolean; blank: boolean; updatedAt: number | string; cwd?: string }>;
    }> {
      requireSignal(signal);
      if (!distinctSessions) {
        return { items: [{ sessionId: "session-test", running: false, blank: false, updatedAt: 1, cwd: "/tmp" }] };
      }
      const items = [...sessions].map(([sessionId, status]) => ({ sessionId, ...status, updatedAt: 1 }));
      return { items };
    },

    async modelCatalog() {
      if (models) return models;
      return { default: { provider: "p", model: "m" }, routableProviders: ["p"], groups: [], failures: [] };
    },

    async selectModel(request: { provider: string; model: string; reasoningEffort?: string; [key: string]: unknown }) {
      // The Host declares `selectModel(request)` without a signal argument, so the
      // bridge must not invent one — this fake fails loudly if it ever does.
      timeline?.push({ kind: "model", request });
      selections.push(request);
      const selected: { provider: string; model: string; reasoningEffort?: string } = {
        provider: request.provider,
        model: request.model,
      };
      if (request.reasoningEffort !== undefined) selected.reasoningEffort = request.reasoningEffort;
      return { selected };
    },

    async cancel(request: { sessionId?: string; [key: string]: unknown }) {
      cancelled.push(request);
      return { accepted: true, sessionId: request.sessionId };
    },

    prompt(request: { sessionId: string; requestId?: string; [key: string]: unknown }, signal: AbortSignal) {
      requireSignal(signal);
      timeline?.push({ kind: "prompt", request });
      prompts.push(request);
      // `scripts` gives each prompt its own turn sequence, which is what a queued
      // second run needs: it must observe its own turn, not replay the first one's.
      const promptIndex = prompts.length - 1;
      const steps = scripts ? (scripts[promptIndex] ?? []) : script;
      const session = sessions.get(request.sessionId);
      if (session) {
        session.blank = false;
        session.running = true;
      }
      void (async () => {
        // Steering joins a turn that is already running, so the Host appends the
        // message without a fresh `turn/start`; model that explicitly.
        if (steps.length > 0 && req(steps[0], "step 0").kind !== "start") {
          append("user/message", {
            role: "user",
            content: [{ type: "text", text: "…" }],
            source: { kind: "user", rpcId: request.requestId },
          });
        }
        for (const step of steps) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (step.kind === "start") {
            append("turn/start", { turn: step.turn });
            // The Host appends the admitted prompt inside the turn that consumed
            // it. Emulating that here is what makes turn attribution testable.
            if (step.own !== false) {
              append("user/message", {
                role: "user",
                content: [{ type: "text", text: "…" }],
                source: { kind: "user", rpcId: request.requestId },
              });
            }
          } else if (step.kind === "foreign") {
            append("user/message", {
              role: "user",
              content: [{ type: "text", text: "…" }],
              source: { kind: "user", rpcId: "rpc-someone-else" },
            });
          } else if (step.kind === "text") {
            append("assistant/message", {
              turn: step.turn,
              step: 1,
              message: { content: [{ type: "text", text: step.text }] },
              usage: { inputTokens: 10, outputTokens: 5 },
            });
          } else if (step.kind === "reasoning") {
            append("assistant/message", {
              turn: step.turn,
              step: 1,
              message: { content: [{ type: "reasoning", text: step.text }] },
            });
          } else if (step.kind === "tool") {
            append("tool/call", { turn: step.turn, step: 1, callId: step.callId, name: step.name, arguments: {} });
          } else if (step.kind === "toolResult") {
            // The Host stores a tool's answer as a tool-role message; the sandbox
            // writes its denial marker into that text.
            append("tool/result", {
              turn: step.turn,
              step: 1,
              message: {
                toolCallId: step.callId,
                content: [{ type: "text", text: step.text }],
                isError: step.isError ?? false,
              },
              ...(step.error !== undefined ? { error: step.error } : {}),
            });
          } else if (step.kind === "end") {
            if (step.gate) await step.gate;
            append("turn/end", { turn: step.turn, reason: step.reason ?? { kind: "completed" } });
            if (session) session.running = false;
          } else if (step.kind === "rawEnd") {
            // A `turn/end` with no `reason` field at all: the union requires one,
            // but the union is a type, not a runtime guard.
            append("turn/end", { turn: step.turn });
          }
        }
      })();
      return Promise.resolve({ accepted: true });
    },

    async *follow(_request: unknown, signal?: AbortSignal) {
      const out = bus<{ type: "event"; event: FakeEvent }>();
      const push = (frame: { type: "event"; event: FakeEvent }) => out.push(frame);
      subscribers.add(push);
      const onAbort = () => out.close();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (stuckBeforeSnapshot) {
          // A Host that accepted the subscription and then stopped answering: the
          // very first frame never arrives, so nothing bounds `history` unless the
          // bridge bounds it itself.
          await new Promise<never>(() => {});
        }
        yield {
          type: "snapshot",
          header: {},
          cursor: seq,
          records: events.slice(-50).map((event) => ({ type: "event", event })),
          hasMore: false,
        };
        if (stuckAfterSnapshot) {
          // A Host whose stream stopped producing frames and whose abort handler
          // never runs: nothing is pending on an event, so there is nothing for
          // `out.close()` to resolve.
          await new Promise<never>(() => {});
        }
        for (;;) {
          const next = await out.next();
          if (next.done || signal?.aborted) return;
          yield next.value;
        }
      } finally {
        subscribers.delete(push);
        signal?.removeEventListener("abort", onAbort);
        out.close();
        if (stuckOnReturn) {
          // Teardown that never completes: the answer must not wait for it.
          await new Promise<never>(() => {});
        }
      }
    },
  };

  return controller;
}

function build(
  controller: ReturnType<typeof fakeController> | Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  services: Record<string, unknown> = {},
  options: { approvals?: unknown } = {},
): MethodsTestApi {
  return createMethods(
    {
      sessionController: controller as never,
      webServer: ORIGIN as never,
      approvals: (options.approvals ?? null) as null,
    },
    resolveConfig(overrides),
    { get: (name: string) => services[name] },
    {},
  ) as unknown as MethodsTestApi;
}

// The optional Host services the bridge reaches for through `ctx.get`. They are
// genuinely optional, so a deployment that lacks them must fail with a readable
// message rather than a TypeError.
function fakeWorkspaces({ items = [] }: { items?: Array<Record<string, unknown>> } = {}) {
  return {
    calls: [] as Array<{ path: string; title: string | undefined }>,
    list() {
      return items;
    },
    async create(path: string, title?: string) {
      this.calls.push({ path, title });
      return { id: "ws-new", path, title: title ?? path, createdAt: 1, updatedAt: 1, sessionIds: [] };
    },
  };
}

function fakePermissions({
  options = [],
  defaultPreset = null,
  timeline = null,
}: {
  options?: Array<Record<string, unknown>>;
  defaultPreset?: string | null;
  timeline?: TimelineEntry[] | null;
} = {}) {
  return {
    applied: [] as Array<{ sessionId: string | undefined; name: string }>,
    async catalog() {
      return { options, defaultOptions: {}, defaultPreset };
    },
    set(session: { id?: string } | undefined, name: string) {
      timeline?.push({ kind: "permission", sessionId: session?.id, name });
      this.applied.push({ sessionId: session?.id, name });
    },
  };
}

const happyScript: FakeScriptStep[] = [
  { kind: "start", turn: 1 },
  { kind: "tool", turn: 1, callId: "c1", name: "bash" },
  { kind: "reasoning", turn: 1, text: "thinking" },
  { kind: "text", turn: 1, text: "收到了" },
  { kind: "end", turn: 1 },
];

test("ask creates a session, prompts it, and returns the turn's text", async () => {
  const controller = fakeController({ script: happyScript, hostCwd: "/tmp/work" });
  const result = await build(controller).ask({ text: "ping", cwd: "/tmp/work" });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "收到了");
  assert.equal(result.reasoning, "thinking");
  assert.equal(result.turn, 1);
  assert.equal(result.created, true);
  assert.equal(result.sessionId, "session-test");
  assert.equal(result.timedOut, false);
  assert.equal(result.cwd, "/tmp/work");
  assert.equal(result.tools.length, 1);
  assert.equal(req(result.tools[0], "tools[0]").name, "bash");
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
  });
  assert.equal(controller.prompts.length, 1);
  const p0 = req(controller.prompts[0], "prompts[0]");
  assert.deepEqual(p0.content, [{ type: "text", text: "ping" }]);
  assert.equal(p0.mode, "queue");
  assert.equal(req(controller.created[0], "created[0]").cwd, "/tmp/work");
});

test("ask reports the turn-end reason when the turn was aborted", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "text", turn: 1, text: "partial" },
      { kind: "end", turn: 1, reason: { kind: "aborted", reason: "user" } },
    ],
  });
  const result = await build(controller).ask({ text: "go" });
  assert.equal(result.status, "aborted");
  assert.equal(result.text, "partial");
  assert.deepEqual(result.reason, { kind: "aborted", reason: "user" });
});

test("a turn that ended without a reason is unverified, not completed", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "text", turn: 1, text: "did it finish?" },
      { kind: "rawEnd", turn: 1 },
    ],
  });
  const result = await build(controller).ask({ text: "go" });
  // `TurnEndReason` is a union, and a union is not a runtime guard: a Host that
  // omits the field would otherwise be reported as a successful turn.
  assert.equal(result.status, "unknown", "an unrecorded ending must not read as success");
  assert.equal(result.reason?.kind, "unknown");
  assert.match(result.reason?.message ?? "", /without a reason/);
  assert.equal(result.text, "did it finish?", "the text is still returned");
  assert.equal(result.partial, false, "a turn that did end is not a partial read");
});

test("an unlisted turn-end kind keeps its own name instead of being coerced", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "text", turn: 1, text: "truncated" },
      { kind: "end", turn: 1, reason: { kind: "max-tokens" } },
    ],
  });
  const result = await build(controller).ask({ text: "go" });
  // `TurnEndReasonMap` is merge-extensible, so a backend variant must survive
  // verbatim rather than be mapped onto a known outcome.
  assert.equal(result.status, "max-tokens");
  assert.deepEqual(result.reason, { kind: "max-tokens" });
});

test("ask waits for the next turn when the session already had one", async () => {
  const historical = [
    { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
    { type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const controller = fakeController({
    historical,
    script: [
      { kind: "start", turn: 2 },
      { kind: "text", turn: 2, text: "second" },
      { kind: "end", turn: 2 },
    ],
  });
  const result = await build(controller).ask({ text: "again", sessionId: "session-test" });
  assert.equal(result.turn, 2);
  assert.equal(result.text, "second");
  assert.equal(result.created, false);
});

test("steer into a running turn targets that same turn", async () => {
  const historical = [
    { type: "turn/start", seq: 1, time: 1, data: { turn: 4 } },
  ];
  const controller = fakeController({
    historical,
    script: [
      { kind: "text", turn: 4, text: "steered" },
      { kind: "end", turn: 4 },
    ],
  });
  const result = await build(controller).ask({ text: "hurry", sessionId: "session-test", mode: "steer" });
  assert.equal(result.turn, 4);
  assert.equal(result.text, "steered");
  assert.equal(req(controller.prompts[0], "prompts[0]").mode, "steer");
});

test("ask times out without cancelling the turn", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "text", turn: 1, text: "slow" },
    ],
  });
  // `drive()` unrefs its deadline timer on purpose: a bridge call must never be
  // the thing keeping the Host process alive. In this test the fake Host settles
  // in ~10ms and then nothing but that unref'd timer is left, so on a runner
  // without extra handles the loop empties and the process exits before the 1s
  // deadline is ever reached (node:test reports it as "Promise resolution is
  // still pending…"). Hold the loop open for the duration of the assertion.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  try {
    const result = await build(controller).ask({ text: "go", timeoutMs: 50 });
    assert.equal(result.status, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.text, "slow");
    assert.equal(controller.cancelled.length, 0, "a timeout must not cancel the turn");
    assert.ok(Date.now() - started >= 900, "timeoutMs is clamped to the 1s floor");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("wait returns the last completed turn of an idle session", async () => {
  const historical = [
    { type: "turn/start", seq: 1, time: 1, data: { turn: 3 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 2,
      data: { turn: 3, message: { content: [{ type: "text", text: "already done" }] } },
    },
    { type: "turn/end", seq: 3, time: 3, data: { turn: 3, reason: { kind: "completed" } } },
  ];
  const result = await build(fakeController({ historical })).wait({ sessionId: "session-test" });
  assert.equal(result.turn, 3);
  assert.equal(result.text, "already done");
  assert.equal(result.status, "completed");
});

test("wait on a blank session reports idle", async () => {
  const result = await build(fakeController()).wait({ sessionId: "session-test" });
  assert.equal(result.status, "idle");
  assert.equal(result.turn, 0);
  assert.equal(result.text, "");
});

test("wait reports the last turn's own end reason, not a blanket completion", async () => {
  const historical = [
    { type: "turn/start", seq: 1, time: 1, data: { turn: 2 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 2,
      data: { turn: 2, message: { content: [{ type: "text", text: "partial" }] } },
    },
    {
      type: "turn/end",
      seq: 3,
      time: 3,
      data: { turn: 2, reason: { kind: "aborted", reason: { kind: "user" } } },
    },
  ];
  const result = await build(fakeController({ historical })).wait({ sessionId: "session-test" });
  assert.equal(result.turn, 2);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.reason, { kind: "aborted", reason: { kind: "user" } });
  assert.equal(result.text, "partial");
});

test("history returns the snapshot window without prompting", async () => {
  const historical = [
    { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
    { type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const controller = fakeController({ historical });
  const result = await build(controller).history({ sessionId: "session-test" });
  assert.equal(result.cursor, 2);
  assert.equal(result.running, false);
  assert.equal(result.turn, 1);
  assert.equal(result.messageCount, 2);
  assert.equal(result.records.length, 2);
  assert.equal(req(result.records[1], "records[1]").type, "turn/end");
  assert.equal(controller.prompts.length, 0);
});

test("a turn typed by someone else is not returned as this call's answer", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1, own: false },
      { kind: "foreign" },
      { kind: "text", turn: 1, text: "别人的回答" },
      { kind: "end", turn: 1 },
      { kind: "start", turn: 2 },
      { kind: "text", turn: 2, text: "我的回答" },
      { kind: "end", turn: 2 },
    ],
  });
  const result = await build(controller).ask({ text: "只回复：我的" });
  assert.equal(result.turn, 2, "adopted a turn our prompt was never in");
  assert.equal(result.text, "我的回答");
  assert.equal(result.status, "completed");
  assert.equal(result.partial, false);
});

test("the concurrency cap counts runs, not sessions", async () => {
  const historical = [{ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }];
  const methods = build(fakeController({ historical }), { maxSessions: 1 });
  const ac = new AbortController();
  const first = methods.wait({ sessionId: "session-test", timeoutMs: 5000 }, { signal: ac.signal });
  await assert.rejects(
    () => methods.wait({ sessionId: "session-test", timeoutMs: 5000 }),
    (error: RpcErrorLike) => error.code === -32004,
  );
  ac.abort();
  const result = await first;
  assert.equal(result.sessionId, "session-test");
});

test("a non-positive or fractional limit is rejected instead of coerced", async () => {
  const methods = build(fakeController({ historical: [] }));
  for (const limit of [0, -1, 2.5, "5"]) {
    await assert.rejects(
      () => methods.listSessions({ limit }),
      (error: RpcErrorLike) => {
        assert.equal(error.code, -32602);
        assert.match(error.message ?? "", /`limit` must be a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => methods.history({ sessionId: "session-test", limit }),
      (error: RpcErrorLike) => error.code === -32602,
    );
  }
});

test("cancel forwards to the controller", async () => {
  const controller = fakeController();
  const result = await build(controller).cancel({ sessionId: "session-test" });
  assert.deepEqual(result, { accepted: true, sessionId: "session-test" });
  assert.deepEqual(controller.cancelled, [{ sessionId: "session-test" }]);
});

test("sessions.list maps the host summary shape", async () => {
  const result = await build(fakeController()).listSessions({});
  assert.equal(result.total, 1);
  assert.equal(result.sort, "updatedAt");
  assert.deepEqual(result.items[0], {
    sessionId: "session-test",
    running: false,
    blank: false,
    agentAvailable: true,
    updatedAt: 1,
    createdAt: null,
    cwd: "/tmp",
    agentPreset: null,
    origin: null,
    parentSessionId: null,
  });
});

test("dispatcher rejects unknown methods and exposes the catalog", async () => {
  const dispatch = buildDispatcher(build(fakeController({ script: happyScript })) as never) as unknown as (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<DispatchResultTest>;

  const catalog = await dispatch("dsh.discover", {});
  assert.equal(catalog.plugin, "dsh-rpc-agent");
  assert.equal(catalog.methods.some((entry: { name: string }) => entry.name === "dsh.sessions.ask"), true);

  await assert.rejects(() => dispatch("dsh.nope", {}), (error: RpcErrorLike) => error.code === -32601);
  await assert.rejects(() => dispatch("ask", { text: "   " }), (error: RpcErrorLike) => error.code === -32602);
  const aliased = await dispatch("ping", {});
  assert.equal(aliased.ok, true);
});

test("prompt-only returns immediately without waiting for the turn", async () => {
  const controller = fakeController({ script: happyScript });
  const result = await build(controller).prompt({ sessionId: "session-test", text: "hello" });
  assert.equal(result.accepted, true);
  assert.equal(result.mode, "queue");
  assert.equal(typeof result.requestId, "string");
});

test("prompt applies session options instead of dropping them", async () => {
  // The CLI accepts `prompt --model`; before this test that value reached the
  // bridge and was silently discarded, so one real dispatch ran on the profile
  // default model while its caller believed it had named another.
  const controller = fakeController({ models: twoProviderModels, script: happyScript });
  const result = await build(controller).prompt({
    sessionId: "session-test",
    text: "hello",
    model: "beta/shared",
    reasoningEffort: "low",
  });
  assert.deepEqual(controller.selections, [
    { sessionId: "session-test", provider: "beta", model: "shared", reasoningEffort: "low" },
  ]);
  assert.deepEqual(result.selected, { provider: "beta", model: "shared", reasoningEffort: "low" });
});

test("prompt refuses create-time-only options instead of ignoring them", async () => {
  const controller = fakeController({ script: happyScript });
  const methods = build(controller);
  await assert.rejects(
    () => methods.prompt({ sessionId: "session-test", text: "hi", cwd: "C:/elsewhere" }),
    (error: RpcErrorLike) => error.code === -32602 && /only apply when the session is created/.test(error.message ?? ""),
  );
  await assert.rejects(
    () => methods.prompt({ sessionId: "session-test", text: "hi", agentPreset: "minimal" }),
    (error: RpcErrorLike) => error.code === -32602 && /only applies when the session is created/.test(error.message ?? ""),
  );
});

test("driver options cannot be injected through JSON params", async () => {
  // `onEvent` and `signal` belong to the internal channel; a wire caller that
  // sends them must not reach the driver (it used to throw a TypeError).
  const controller = fakeController({ script: happyScript });
  const result = await build(controller).ask({ text: "go", onEvent: 1, signal: "boom" });
  assert.equal(result.status, "completed");
  assert.equal(controller.prompts.length, 1);
});

test("driver options are honoured through the internal channel", async () => {
  const controller = fakeController({ script: happyScript });
  const seen: string[] = [];
  const result = await build(controller).ask(
    { text: "go" },
    { onEvent: (frame) => seen.push(frame.type) },
  );
  assert.equal(result.status, "completed");
  assert.ok(seen.includes("event"), "the driver never reported events");
});

test("a second prompting run on one session is refused instead of crossing turns", async () => {
  const controller = fakeController({ script: happyScript });
  const methods = build(controller);
  const first = methods.ask({ sessionId: "session-test", text: "甲" });
  await assert.rejects(
    () => methods.ask({ sessionId: "session-test", text: "乙" }),
    (error: RpcErrorLike) => error.code === -32004,
  );
  const result = await first;
  assert.equal(result.status, "completed");
});

test("a queued run waits for the session and still reports its own turn", async () => {
  const controller = fakeController({
    scripts: [
      [{ kind: "start", turn: 1 }, { kind: "text", turn: 1, text: "甲" }, { kind: "end", turn: 1 }],
      [{ kind: "start", turn: 2 }, { kind: "text", turn: 2, text: "乙" }, { kind: "end", turn: 2 }],
    ],
  });
  const methods = build(controller);
  const [first, second] = await Promise.all([
    methods.ask({ sessionId: "session-test", text: "甲" }),
    methods.ask({ sessionId: "session-test", text: "乙", queue: true }),
  ]);
  assert.equal(first.text, "甲");
  assert.equal(second.text, "乙");
  assert.equal(second.turn, 2, "the queued run must be attributed to its own turn");
});

test("two waiters behind one holder take the session in arrival order", async () => {
  const controller = fakeController({
    scripts: [
      [{ kind: "start", turn: 1 }],
      [{ kind: "start", turn: 2 }, { kind: "text", turn: 2, text: "乙" }, { kind: "end", turn: 2 }],
      [{ kind: "start", turn: 3 }, { kind: "text", turn: 3, text: "丙" }, { kind: "end", turn: 3 }],
    ],
  });
  const methods = build(controller);
  const holder = new AbortController();
  const first = methods.ask({ sessionId: "session-test", text: "甲" }, { signal: holder.signal });
  const second = methods.ask({ sessionId: "session-test", text: "乙", queue: true, timeoutMs: 5000 });
  const third = methods.ask({ sessionId: "session-test", text: "丙", queue: true, timeoutMs: 5000 });

  await new Promise((resolve) => setTimeout(resolve, 60));
  // However many callers are waiting, exactly one may own the session — the whole
  // point of the slot. Taking it is fused with the wait, so a release cannot hand
  // the same session to two waiters.
  const running = (await methods.ping()).activeRuns.filter((run) => run.state === "running");
  assert.equal(running.length, 1, "only one run may be prompting the session");

  holder.abort();
  await first.catch(() => {});
  const [queued1, queued2] = await Promise.all([second, third]);
  assert.deepEqual([queued1.turn, queued2.turn], [2, 3], "waiters are served in arrival order");
  assert.equal(queued1.text, "乙");
  assert.equal(queued2.text, "丙");
});

test("a queued run is visible while waiting, and its own deadline ends the wait", async () => {
  // The holder never finishes its turn, so the queued run can only leave by timing out.
  const controller = fakeController({ scripts: [[{ kind: "start", turn: 1 }], []] });
  const methods = build(controller);
  const holder = new AbortController();
  const first = methods.ask({ sessionId: "session-test", text: "长" }, { signal: holder.signal });
  const second = methods.ask({ sessionId: "session-test", text: "等", queue: true, timeoutMs: 1000 });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const states = (await methods.ping()).activeRuns.map((run) => run.state).sort();
  assert.deepEqual(states, ["queued", "running"], "a waiting run must be observable, not invisible");

  await assert.rejects(
    () => second,
    (error: RpcErrorLike) => error.code === -32005 && /stayed busy/.test(error.message ?? ""),
  );

  holder.abort();
  await first.catch(() => {});
});

test("creating a session leaves cwd to the Host when the caller names none", async () => {
  const controller = fakeController();
  const result = await build(controller).createSession({});
  assert.equal("cwd" in req(controller.created[0], "created[0]"), false, "create must not override the Host default cwd");
  assert.equal(result.cwd, "/host/resolved", "the resolved cwd is read back from inspect");
  assert.deepEqual(controller.inspected, ["session-test"]);
});

test("an explicit cwd is forwarded verbatim", async () => {
  const controller = fakeController({ hostCwd: "/tmp/work" });
  const result = await build(controller).createSession({ cwd: "/tmp/work" });
  assert.equal(req(controller.created[0], "created[0]").cwd, "/tmp/work");
  assert.equal(result.cwd, "/tmp/work", "the echoed cwd is the one the Host attached");
  assert.deepEqual(controller.inspected, ["session-test"]);
});

// ------------------------------------------------------- workspaces & options --

test("a workspace is forwarded instead of a cwd, never both", async () => {
  const controller = fakeController({ hostCwd: "/home/dev/work" });
  const result = await build(controller).createSession({ workspaceId: "ws-1" });
  const c0 = req(controller.created[0], "created[0]");
  assert.equal(c0.workspaceId, "ws-1");
  assert.equal("cwd" in c0, false, "the Host derives the directory from the workspace");
  assert.equal(result.cwd, "/home/dev/work");
});

test("naming a workspace and a cwd together is refused", async () => {
  const controller = fakeController();
  await assert.rejects(
    () => build(controller).createSession({ workspaceId: "ws-1", cwd: "/tmp/work" }),
    (error: RpcErrorLike) => error.code === -32602 && /cannot be combined/.test(error.message ?? ""),
  );
  assert.equal(controller.created.length, 0, "nothing may be created when the request is contradictory");
});

test("a caller-chosen session id is refused instead of silently replaced", async () => {
  const controller = fakeController();
  await assert.rejects(
    () => build(controller).createSession({ sessionId: "session-3f2a" }),
    (error: RpcErrorLike) => error.code === -32602 && /assigned by the Host/.test(error.message ?? ""),
  );
  assert.equal(controller.created.length, 0, "nothing may be created when the requested id cannot be honoured");
});

const twoProviderModels = {
  default: { provider: "alpha", model: "one" },
  routableProviders: ["alpha", "beta"],
  groups: [
    { id: "alpha", name: "Alpha", models: [{ id: "one", name: "One" }, { id: "shared", name: "Shared" }] },
    { id: "beta", name: "Beta", models: [{ id: "shared", name: "Shared" }] },
  ],
  failures: [],
};

test("a model switch reaches the Host with the resolved provider", async () => {
  const controller = fakeController({ models: twoProviderModels });
  const methods = build(controller);
  const result = await methods.configure({ sessionId: "session-test", model: "alpha/one", reasoningEffort: "high" });
  assert.deepEqual(controller.selections, [
    { sessionId: "session-test", provider: "alpha", model: "one", reasoningEffort: "high" },
  ]);
  assert.deepEqual(result.selected, { provider: "alpha", model: "one", reasoningEffort: "high" });
});

test("a bare model id resolves when only one provider offers it", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await build(controller).configure({ sessionId: "session-test", model: "one" });
  assert.equal(req(controller.selections[0], "selections[0]").provider, "alpha");
});

test("a bare model id offered twice names both spellings instead of guessing", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test", model: "shared" }),
    (error: RpcErrorLike) => error.code === -32602 && /spell it "provider\/shared"/.test(error.message ?? ""),
  );
  assert.equal(controller.selections.length, 0);
});

test("an unknown model is refused with a pointer to the catalog", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test", model: "nope" }),
    (error: RpcErrorLike) => error.code === -32602 && /call dsh\.models/.test(error.message ?? ""),
  );
});

test("reasoning effort alone is refused, because the Host cannot read the model back", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test", reasoningEffort: "high" }),
    (error: RpcErrorLike) => error.code === -32602 && /needs `model`/.test(error.message ?? ""),
  );
  assert.equal(controller.selections.length, 0);
});

test("configure with nothing to configure says so", async () => {
  const controller = fakeController();
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test" }),
    (error: RpcErrorLike) => error.code === -32602 && /nothing to configure/.test(error.message ?? ""),
  );
});

test("a permission preset is applied to the live session object", async () => {
  const permissions = fakePermissions({
    options: [{ value: "read-only" }, { value: "workspace-write" }],
    defaultPreset: "workspace-write",
  });
  const controller = fakeController();
  const services = { permissionPresets: permissions, sessions: { get: (id: string) => ({ id }) } };
  const result = await build(controller, {}, services).configure({
    sessionId: "session-test",
    permissionPreset: "read-only",
  });
  assert.equal(result.permissionPreset, "read-only");
  assert.deepEqual(permissions.applied, [{ sessionId: "session-test", name: "read-only" }]);
});

test("an unknown permission preset is refused before touching the session", async () => {
  const permissions = fakePermissions({ options: [{ value: "read-only" }] });
  const services = { permissionPresets: permissions, sessions: { get: (id: string) => ({ id }) } };
  await assert.rejects(
    () => build(fakeController(), {}, services).configure({ sessionId: "session-test", permissionPreset: "yolo" }),
    (error: RpcErrorLike) => error.code === -32602 && /available: read-only/.test(error.message ?? ""),
  );
  assert.equal(permissions.applied.length, 0);
});

test("a deployment without permissionPresets reports that instead of crashing", async () => {
  await assert.rejects(
    () => build(fakeController(), {}, {}).configure({ sessionId: "session-test", permissionPreset: "read-only" }),
    (error: RpcErrorLike) => error.code === -32000 && /no permissionPresets service/.test(error.message ?? ""),
  );
});

test("a sandbox refusal is reported as a fact, and the preset stays the caller's decision", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "tool", turn: 1, callId: "c1", name: "write_file" },
      {
        kind: "toolResult",
        turn: 1,
        callId: "c1",
        text: "Error: EPERM\n[sandbox: file access denied under workspace-write mode]",
        isError: true,
      },
      { kind: "text", turn: 1, text: "写入被沙箱挡住了。" },
      { kind: "end", turn: 1 },
    ],
  });
  const result = await build(controller).ask({ text: "写到 workspace 外" });

  assert.equal(result.status, "completed");
  assert.equal(result.sandbox!.denied, true);
  assert.equal(result.sandbox!.marker, "[sandbox: file access denied under workspace-write mode]");
  assert.equal(result.sandbox!.source, "tool");
  // The bridge names the decision but does not make it: handing back a ready-made
  // "retry with danger-full-access" call would let the blocked agent's own wording
  // steer it. Only the session id travels; `permission` is the caller's to add.
  assert.deepEqual(result.next!.args, { session_id: "session-test" });
  assert.match(result.next!.reason ?? "", /caller's decision/);
  assert.doesNotMatch(JSON.stringify(result.next), /danger-full-access/);
  assert.equal(result.next!.tool, "dsh_ask");
  // The refusal is not an error: the turn ran and the tool error keeps its own flag.
  const t0 = req(result.tools[0], "tools[0]");
  assert.equal(t0.isError, true);
  assert.match(t0.output ?? "", /sandbox: file access denied/);
});

test("a refusal only the agent mentions is reported, but flagged as the weaker source", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "tool", turn: 1, callId: "c1", name: "bash" },
      { kind: "toolResult", turn: 1, callId: "c1", text: "ok" },
      { kind: "text", turn: 1, text: "写入被挡住了：[sandbox: file access denied under workspace-write mode]" },
      { kind: "end", turn: 1 },
    ],
  });
  const result = await build(controller).ask({ text: "写到 workspace 外" });

  assert.equal(result.sandbox!.denied, true);
  assert.equal(result.sandbox!.source, "text");
});

test("a turn's tool output is bounded even when every call is chatty", async () => {
  const noisy = "x".repeat(4000);
  const script: FakeScriptStep[] = [{ kind: "start", turn: 1 }];
  for (let i = 0; i < 6; i += 1) {
    script.push({ kind: "tool", turn: 1, callId: `c${i}`, name: "bash" });
    script.push({ kind: "toolResult", turn: 1, callId: `c${i}`, text: noisy });
  }
  script.push({ kind: "end", turn: 1 });

  const result = await build(fakeController({ script })).ask({ text: "跑很多命令" });
  const total = result.tools.reduce((sum, tool) => sum + (tool.output?.length ?? 0), 0);

  assert.ok(total <= 20000 + 400, `tool output should stay near the budget, got ${total}`);
  assert.match(result.tools.at(-1)?.output ?? "", /omitted/);
});

test("an ordinary failure is not mistaken for a sandbox refusal", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "tool", turn: 1, callId: "c1", name: "bash" },
      { kind: "toolResult", turn: 1, callId: "c1", text: "error: permission denied (os error 13)", isError: true },
      { kind: "text", turn: 1, text: "权限不足，但不是沙箱拒绝。" },
      { kind: "end", turn: 1 },
    ],
  });
  const result = await build(controller).ask({ text: "chmod" });

  assert.equal(result.status, "completed");
  assert.equal("sandbox" in result, false);
  assert.equal("next" in result, false);
});

test("permission presets carry a cost sentence even when the deployment declared none", async () => {
  const permissions = fakePermissions({
    options: [{ value: "workspace-write" }, { value: "danger-full-access" }, { value: "house-rules" }],
    defaultPreset: "workspace-write",
  });
  const catalog = await build(fakeController(), {}, { permissionPresets: permissions }).permissionCatalog();

  assert.equal(catalog.defaultPreset, "workspace-write");
  assert.match(req(catalog.options[0], "options[0]").cost ?? "", /writes inside the session workspace/);
  assert.match(req(catalog.options[1], "options[1]").cost ?? "", /approvals disabled/);
  assert.equal(req(catalog.options[2], "options[2]").cost, null); // unknown preset: no invented wording
});

test("workspaces are listed with their directory status", async () => {
  const workspaces = fakeWorkspaces({
    items: [
      {
        id: "ws-1",
        path: "/home/dev/work",
        title: "工作",
        createdAt: 1,
        updatedAt: 2,
        sessionIds: ["s1", "s2"],
        status: async () => "ok",
      },
      {
        id: "ws-2",
        path: "/gone",
        title: "gone",
        createdAt: 1,
        updatedAt: 2,
        sessionIds: [],
        status: async () => {
          throw new Error("stat failed");
        },
      },
    ],
  });
  const result = await build(fakeController(), {}, { workspaceRegistry: workspaces }).listWorkspaces({});
  assert.equal(result.total, 2);
  assert.deepEqual(result.items[0], {
    id: "ws-1",
    title: "工作",
    path: "/home/dev/work",
    status: "ok",
    sessions: 2,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(req(result.items[1], "items[1]").status, "unknown", "a failing status probe must not fail the whole listing");
});

test("a workspace can be registered by path", async () => {
  const workspaces = fakeWorkspaces();
  const result = await build(fakeController(), {}, { workspaceRegistry: workspaces }).createWorkspace({
    path: "/tmp/new",
    title: "新",
  });
  assert.equal(result.id, "ws-new");
  assert.deepEqual(workspaces.calls, [{ path: "/tmp/new", title: "新" }]);
});

test("reusing a session cannot relocate it", async () => {
  const controller = fakeController({ script: happyScript });
  await assert.rejects(
    () => build(controller).ask({ sessionId: "session-test", text: "go", workspaceId: "ws-1" }),
    (error: RpcErrorLike) => error.code === -32602 && /only apply when the session is created/.test(error.message ?? ""),
  );
  assert.equal(controller.prompts.length, 0, "a refused request must not reach the Host");
});

test("reusing a session cannot change its agent preset", async () => {
  const controller = fakeController({ script: happyScript });
  await assert.rejects(
    () => build(controller).ask({ sessionId: "session-test", text: "go", agentPreset: "minimal" }),
    (error: RpcErrorLike) => error.code === -32602 && /`agentPreset` only applies when the session is created/.test(error.message ?? ""),
  );
  assert.equal(controller.prompts.length, 0, "a refused request must not reach the Host");
});

test("ask applies options and reports them alongside the turn", async () => {
  const controller = fakeController({ models: twoProviderModels, script: happyScript });
  const permissions = fakePermissions({ options: [{ value: "read-only" }] });
  const services = { permissionPresets: permissions, sessions: { get: (id: string) => ({ id }) } };
  const result = await build(controller, {}, services).ask({
    text: "go",
    model: "alpha/one",
    permissionPreset: "read-only",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.selected, { provider: "alpha", model: "one" });
  assert.equal(result.permissionPreset, "read-only");
});



// --- 0.4.5: R2 (ask can return a handle) and R4 (wait can return a delta) ---

test("ask with wait:false hands back a handle instead of waiting for the turn", async () => {
  const controller = fakeController({ script: happyScript });
  const result = await build(controller).ask({ text: "long job", wait: false });

  assert.equal(result.accepted, true);
  assert.equal(result.status, "running");
  assert.equal(result.turn, null);
  assert.equal(result.text, "");
  assert.equal(result.sessionId, "session-test");
  assert.match(result.requestId ?? "", /^rpc-/);
  assert.equal(controller.prompts.length, 1, "the prompt must still be submitted");
});

test("queue and wait:false are refused together instead of silently ignoring one", async () => {
  const controller = fakeController({ script: happyScript });

  await assert.rejects(
    () => build(controller).ask({ text: "x", wait: false, queue: true }),
    (error: RpcErrorLike) => error.code === -32602 && /queue.*wait: false/.test(error.message ?? ""),
  );
  assert.equal(controller.prompts.length, 0, "a contradictory request must not reach the Host");
});

test("a non-blocking ask refuses to stack onto a turn that is already running", async () => {
  const controller = fakeController({ script: happyScript });
  controller.list = async (_request, signal) => {
    signal?.throwIfAborted();
    return { items: [{ sessionId: "session-test", running: true, blank: false, updatedAt: 1 }] };
  };

  await assert.rejects(
    () => build(controller).ask({ sessionId: "session-test", text: "again", wait: false }),
    (error: RpcErrorLike) => error.code === -32004 && /already running a turn/.test(error.message ?? ""),
  );
  assert.equal(controller.prompts.length, 0, "a refused request must not reach the Host");
});

const historicalTurn = [
  { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
  {
    type: "assistant/message",
    seq: 2,
    time: 2,
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "旧答案" }] } },
  },
  { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
];

test("wait with since returns only what happened after that cursor", async () => {
  const controller = fakeController({ historical: historicalTurn });
  const result = await build(controller).wait({ sessionId: "session-test", since: 2 });

  assert.equal(result.since, 2);
  assert.equal(result.turn, 1);
  assert.equal(result.text, "", "the text before the cursor must not be replayed");
  assert.ok(result.cursor >= 3, `cursor must still advance (got ${result.cursor})`);
});

const historicalTurnWithTool = [
  { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
  { type: "tool/call", seq: 2, time: 2, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: { command: "ls" } } },
  {
    type: "tool/result",
    seq: 3,
    time: 3,
    data: { turn: 1, step: 1, callId: "c1", message: { toolCallId: "c1", content: [{ type: "text", text: "a.txt" }] } },
  },
  {
    type: "assistant/message",
    seq: 4,
    time: 4,
    data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "旧答案" }] } },
  },
  { type: "turn/end", seq: 5, time: 5, data: { turn: 1, reason: { kind: "completed" } } },
];

/**
 * A delta is about the prose. Reporting an empty tool list next to a delta
 * would let a polling caller conclude the turn did nothing, when in fact it
 * ran commands before the cursor.
 */
test("a delta answer still reports the whole turn's tool calls", async () => {
  const controller = fakeController({ historical: historicalTurnWithTool });
  const result = await build(controller).wait({ sessionId: "session-test", since: 4 });

  assert.equal(result.text, "", "earlier text must not be replayed");
  assert.equal(result.tools.length, 1, "a delta must not hide the tool call it excluded");
  const t0 = req(result.tools[0], "tools[0]");
  assert.equal(t0.name, "bash");
  assert.equal(t0.output, "a.txt");
});

test("wait without since still replays the whole turn", async () => {
  const controller = fakeController({ historical: historicalTurn });
  const result = await build(controller).wait({ sessionId: "session-test" });

  assert.equal(result.text, "旧答案");
  assert.equal(result.since, undefined, "no since means no delta marker");
});

test("a timed-out wait still says why, instead of leaving reason null", async () => {
  const controller = fakeController({ script: [{ kind: "start", turn: 1 }, { kind: "text", turn: 1, text: "还没完" }] });
  const result = await build(controller).ask({ text: "slow", timeoutMs: 60 });

  assert.equal(result.status, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.reason?.kind, "timeout");
  assert.match(result.reason?.message ?? "", /keeps running/);
});

// ------------------------------------------------------------ 0.5.0: sticky sessions

test("a project's second ask reuses the session the first one created", async () => {
  const methods = build(fakeController({ script: happyScript }));
  const first = await methods.ask({ text: "第一件事", project: "sticky-a" });
  assert.equal(first.created, true);
  assert.equal(first.reused, undefined);

  const second = await methods.ask({ text: "第二件事", project: "sticky-a" });
  assert.equal(second.created, false);
  assert.equal(second.reused, true, "the project must carry the session forward");
  assert.equal(second.sessionId, first.sessionId);
});

test("an implicit sticky reuse applies options and increments its ask counter", async () => {
  const { lookupEntry, registryKey } = await import("../dist/lib/registry.mjs");
  const controller = fakeController({ models: twoProviderModels, script: happyScript });
  const permissions = fakePermissions({
    options: [{ value: "workspace-write" }, { value: "read-only" }],
    defaultPreset: "workspace-write",
  });
  const sessions = new Map([["session-test", { id: "session-test" }]]);
  const methods = build(controller, {}, { permissionPresets: permissions, sessions });
  const first = await methods.ask({ text: "first", project: "sticky-options", wait: false, model: "alpha/one" });
  const second = await methods.ask({
    text: "second",
    project: "sticky-options",
    wait: false,
    model: "beta/shared",
    reasoningEffort: "low",
    permissionPreset: "read-only",
  });

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.reused, true);
  assert.deepEqual(controller.selections.at(-1), {
    sessionId: first.sessionId,
    provider: "beta",
    model: "shared",
    reasoningEffort: "low",
  });
  assert.deepEqual(permissions.applied.at(-1), { sessionId: first.sessionId, name: "read-only" });
  assert.deepEqual(second.selected, { provider: "beta", model: "shared", reasoningEffort: "low" });
  assert.equal(second.permissionPreset, "read-only");
  assert.equal((await lookupEntry(registryKey({ project: "sticky-options" }))).asks, 2);
});

test("concurrent first asks for one sticky key create one session", async () => {
  const controller = fakeController({ script: happyScript });
  const list = controller.list.bind(controller);
  controller.list = async (...args) => {
    const result = await list(...args);
    return { ...result, items: result.items.map((item) => ({ ...item, blank: true })) };
  };
  const methods = build(controller);
  const [first, second] = await Promise.all([
    methods.ask({ text: "first", project: "sticky-single-flight", wait: false }),
    methods.ask({ text: "second", project: "sticky-single-flight", wait: false }),
  ]);

  assert.equal(controller.created.length, 1, "the in-flight sticky key must be shared");
  assert.equal(first.sessionId, second.sessionId);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
  assert.equal(controller.prompts.length, 2, "both prompts are still delivered to the shared session");
  const { lookupEntry, registryKey } = await import("../dist/lib/registry.mjs");
  assert.equal((await lookupEntry(registryKey({ project: "sticky-single-flight" }))).asks, 2);
});

test("concurrent default-turn asks for one sticky key queue on one active session", async () => {
  const { lookupEntry, registryKey } = await import("../dist/lib/registry.mjs");
  const firstTurnEnd = deferred();
  const timeline: TimelineEntry[] = [];
  const controller = fakeController({
    distinctSessions: true,
    timeline,
    models: twoProviderModels,
    scripts: [
      [
        { kind: "start", turn: 1 },
        { kind: "text", turn: 1, text: "first answer" },
        { kind: "end", turn: 1, gate: firstTurnEnd.promise },
      ],
      [
        { kind: "start", turn: 2 },
        { kind: "text", turn: 2, text: "second answer" },
        { kind: "end", turn: 2 },
      ],
    ],
  });
  const permissions = fakePermissions({ options: [{ value: "read-only" }], timeline });
  const services = { permissionPresets: permissions, sessions: { get: (id: string) => ({ id }) } };
  const methods = build(controller, {}, services);
  const firstPromise = methods.ask({ text: "first", project: "sticky-wait-true" });
  firstPromise.catch(() => {});
  let secondPromise: Promise<TurnResult> | undefined;
  try {
    await waitFor(() => controller.prompts.length === 1, "the first prompt is active before starting the second ask");
    const hostSession = req((await controller.list({}, new AbortController().signal)).items[0], "hostSession");
    assert.equal(hostSession.blank, false, "the Host reports the reserved session as nonblank");
    assert.equal(hostSession.running, true, "the first turn is still active in the Host");

    secondPromise = methods.ask({
      text: "second",
      project: "sticky-wait-true",
      model: "beta/shared",
      reasoningEffort: "low",
      permissionPreset: "read-only",
    });
    secondPromise.catch(() => {});
    await waitFor(async () => (await methods.ping()).activeRuns.length === 2, "the second ask is waiting on the active session");
    assert.equal(controller.created.length, 1, "the active sticky reservation is reused");
    assert.equal(controller.prompts.length, 1, "the second prompt waits for the first turn");
    assert.equal(controller.selections.length, 0, "the queued model change waits for the prompt slot");
    assert.equal(permissions.applied.length, 0, "the queued permission change waits for the prompt slot");
    assert.deepEqual(timeline.map((item) => item.kind), ["prompt"]);
  } finally {
    firstTurnEnd.resolve();
  }
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reused, true);
  assert.equal(first.text, "first answer");
  assert.equal(second.text, "second answer");
  assert.deepEqual(second.selected, { provider: "beta", model: "shared", reasoningEffort: "low" });
  assert.equal(second.permissionPreset, "read-only");
  assert.deepEqual(timeline.map((item) => item.kind), ["prompt", "model", "permission", "prompt"]);
  assert.deepEqual(controller.prompts.map((prompt) => prompt.sessionId), [first.sessionId, first.sessionId]);
  assert.equal(controller.created.length, 1);
  assert.equal((await lookupEntry(registryKey({ project: "sticky-wait-true" }))).asks, 2);
});

test("a sticky queued ask does not change options when the previous ask times out with its Host turn still running", async () => {
  const firstTurnEnd = deferred();
  const timeline: TimelineEntry[] = [];
  const controller = fakeController({
    distinctSessions: true,
    timeline,
    models: twoProviderModels,
    scripts: [
      [
        { kind: "start", turn: 1 },
        { kind: "text", turn: 1, text: "first answer" },
        { kind: "end", turn: 1, gate: firstTurnEnd.promise },
      ],
      [
        { kind: "start", turn: 2 },
        { kind: "text", turn: 2, text: "second answer" },
        { kind: "end", turn: 2 },
      ],
    ],
  });
  const permissions = fakePermissions({ options: [{ value: "read-only" }], timeline });
  const methods = build(controller, {}, {
    permissionPresets: permissions,
    sessions: { get: (id: string) => ({ id }) },
  });
  const firstPromise = methods.ask({ text: "first", project: "sticky-host-still-running", timeoutMs: 1000 });
  firstPromise.catch(() => {});
  let secondPromise: Promise<TurnResult> | undefined;
  try {
    await waitFor(
      () => controller.events.some((event) => event.type === "assistant/message"),
      "the first Host turn is waiting at its end gate",
    );
    secondPromise = methods.ask({
      text: "second",
      project: "sticky-host-still-running",
      model: "beta/shared",
      reasoningEffort: "low",
      permissionPreset: "read-only",
      timeoutMs: 5000,
    });
    secondPromise.catch(() => {});
    await waitFor(
      async () => (await methods.ping()).activeRuns.some((run) => run.state === "queued"),
      "the second ask is queued before the first bridge run times out",
    );

    const first = await firstPromise;
    assert.equal(first.status, "timeout");
    assert.equal(req((await controller.list({}, new AbortController().signal)).items[0], "hostSession").running, true);
    assert.equal(controller.events.some((event) => event.type === "turn/end"), false);
    await assert.rejects(secondPromise, (error: RpcErrorLike) => {
      assert.equal(error.code, -32004);
      assert.equal(error.data!.sessionId, first.sessionId);
      assert.equal(error.data!.turn, 1);
      return true;
    });
    assert.equal(controller.created.length, 1);
    assert.equal(controller.prompts.length, 1, "the second prompt must not reach the still-running Host");
    assert.deepEqual(controller.selections, [], "the old Host turn must keep its model and effort");
    assert.deepEqual(permissions.applied, [], "the old Host turn must keep its permission preset");
    assert.deepEqual(timeline.map((item) => item.kind), ["prompt"]);
    assert.deepEqual((await methods.ping()).activeRuns, []);
  } finally {
    firstTurnEnd.resolve();
    await Promise.allSettled([firstPromise, ...(secondPromise ? [secondPromise] : [])]);
  }
});

test("reuse: never always starts a fresh session", async () => {
  const methods = build(fakeController({ script: happyScript }));
  const first = await methods.ask({ text: "甲", project: "sticky-b", reuse: "never" });
  const second = await methods.ask({ text: "乙", project: "sticky-b", reuse: "never" });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(second.reused, undefined);
});

test("two clients do not inherit each other's sticky session", async () => {
  const methods = build(fakeController({ script: happyScript }));
  const mine = await methods.ask({ text: "甲", project: "sticky-c", namespace: "agent-a" });
  const theirs = await methods.ask({ text: "乙", project: "sticky-c", namespace: "agent-b" });
  assert.equal(theirs.created, true, "a different client is a different scope");
  const back = await methods.ask({ text: "丙", project: "sticky-c", namespace: "agent-a" });
  assert.equal(back.sessionId, mine.sessionId);
});

test("a recorded session that the Host no longer has is not reused", async () => {
  const controller = fakeController({ script: happyScript });
  const methods = build(controller);
  const first = await methods.ask({ text: "甲", project: "sticky-d" });
  assert.equal(first.created, true);
  // The Host forgets every session: the registry must not insist on a dead id.
  controller.list = async () => ({ items: [] });
  const second = await methods.ask({ text: "乙", project: "sticky-d" });
  assert.equal(second.created, true);
});

test("an unknown mode or reuse value is refused, not silently mapped", async () => {
  const methods = build(fakeController({ script: happyScript }));
  await assert.rejects(
    () => methods.ask({ text: "甲", mode: "detach" }),
    (error: RpcErrorLike) => error.code === -32602 && /mode/.test(error.message ?? ""),
  );
  await assert.rejects(
    () => methods.ask({ text: "甲", reuse: "sometimes" }),
    (error: RpcErrorLike) => error.code === -32602 && /reuse/.test(error.message ?? ""),
  );
});

test("mode: turn refuses a session that is already running, and names the way out", async () => {
  // A turn started without holding a bridge slot (fire-and-forget `prompt`) is
  // exactly the case the old busy check missed: `prompting` is empty, the Host is
  // running. Default mode must refuse rather than append a follow-up silently.
  const controller = fakeController({ script: [{ kind: "start", turn: 1 }, { kind: "text", turn: 1, text: "跑着" }] });
  const methods = build(controller);
  await methods.prompt({ sessionId: "session-test", text: "先跑起来" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await assert.rejects(
    () => methods.ask({ sessionId: "session-test", text: "插队" }),
    (error: RpcErrorLike) =>
      error.code === -32004 &&
      /already running/.test(error.message ?? "") &&
      error.data?.next?.tool === "dsh_wait" &&
      error.data?.next?.args?.session_id === "session-test",
  );
});

test("a sticky session rotates after the bridge's ask budget, and says which one it left", async () => {
  const { forgetEntry, lookupEntry, registryKey, rememberEntry } = await import("../dist/lib/registry.mjs");
  const { ROTATE_AFTER_ASKS } = await import("../dist/lib/registry.mjs");
  const key = registryKey({ namespace: "mcp", project: "sticky-rot" });
  await forgetEntry(key);
  await rememberEntry(key, { sessionId: "session-old", asks: ROTATE_AFTER_ASKS });

  const controller = fakeController({ script: happyScript });
  controller.list = async () => ({
    items: [{ sessionId: "session-old", running: false, blank: false, updatedAt: 2, cwd: "/tmp" }],
  });
  const result = await build(controller).ask({ text: "新一轮", project: "sticky-rot" });
  assert.equal(result.rotated, true);
  assert.equal(result.previousSessionId, "session-old");
  assert.notEqual(result.sessionId, "session-old");
  assert.equal((await lookupEntry(key)).sessionId, result.sessionId);
});

// ------------------------------------------------------------ 0.5.0: listSessions

test("sessions.list filters by cwd prefix and sorts newest first", async () => {
  const controller = fakeController();
  controller.list = async () => ({
    items: [
      { sessionId: "s-old", running: false, blank: false, updatedAt: "2026-01-01T00:00:00.000Z", cwd: "C:\\work\\proj" },
      { sessionId: "s-new", running: false, blank: false, updatedAt: "2026-02-01T00:00:00.000Z", cwd: "C:\\work\\proj\\sub" },
      { sessionId: "s-other", running: false, blank: false, updatedAt: "2026-03-01T00:00:00.000Z", cwd: "C:\\elsewhere" },
    ],
  });
  const methods = build(controller);

  const scoped = await methods.listSessions({ cwd: "C:/work/proj" });
  assert.deepEqual(scoped.items.map((item) => item.sessionId), ["s-new", "s-old"], "prefix match, newest first");
  assert.equal(scoped.total, 2);

  const everything = await methods.listSessions({});
  assert.deepEqual(everything.items.map((item) => item.sessionId), ["s-other", "s-new", "s-old"]);

  const byCreated = await methods.listSessions({ sort: "createdAt" });
  assert.equal(byCreated.sort, "createdAt", "a sort the Host cannot answer still sorts deterministically");
});
test("a wait longer than the slice is answered at the slice boundary", async () => {
  // The transport aborts a request after ~300 s, so the bridge must answer first
  // and let the caller ask again. The slice is configurable so this exercises it
  // in milliseconds instead of five minutes.
  const controller = fakeController({
    script: [{ kind: "start", turn: 1 }, { kind: "text", turn: 1, text: "还没完" }],
  });
  const methods = build(controller, { maxWaitSliceMs: 1_200 });
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    const result = await methods.ask({ text: "slow", timeoutMs: 10_000 });
    assert.equal(result.status, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.sliceMs, 1_200, "say how long this request was allowed to wait");
    assert.equal(result.requestedMs, 10_000, "and how long the caller actually asked for");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a budget below the slice is not reported as sliced", async () => {
  const controller = fakeController({
    script: [{ kind: "start", turn: 1 }, { kind: "text", turn: 1, text: "还没完" }],
  });
  const methods = build(controller, { maxWaitSliceMs: 60_000 });
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    const result = await methods.ask({ text: "slow", timeoutMs: 1_000 });
    assert.equal(result.status, "timeout");
    assert.equal(result.sliceMs, undefined, "no slice means no slice field");
    assert.equal(result.requestedMs, undefined);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("discover publishes the running config, so clients stop copying defaults", async () => {
  const controller = fakeController({ script: [] });
  const methods = build(controller);
  const info = await methods.discover();
  assert.equal(info.plugin, "dsh-rpc-agent");
  assert.ok(info.config, "discover must carry the config the MCP layer reads");
  assert.equal(info.config.defaultTimeoutMs, 600_000);
  assert.equal(info.config.maxWaitSliceMs, 120_000, "the slice default is part of the contract");
});

test("the wait slice default is two minutes and a stray value is clamped, not rejected", () => {
  assert.equal(resolveConfig({}).maxWaitSliceMs, 120_000);
  assert.equal((resolveConfig({}) as ResolvedConfigTest).maxWaitSliceMsRequested, undefined);

  const tooBig = resolveConfig({ maxWaitSliceMs: 900_000 }) as ResolvedConfigTest;
  assert.equal(tooBig.maxWaitSliceMs, 240_000, "one response cannot wait longer than the ceiling");
  assert.equal(tooBig.maxWaitSliceMsRequested, 900_000, "the operator can still see what was asked for");

  const tooSmall = resolveConfig({ maxWaitSliceMs: 200 }) as ResolvedConfigTest;
  assert.equal(tooSmall.maxWaitSliceMs, 1_000, "a slice below one second is pointless");
  assert.equal(tooSmall.maxWaitSliceMsRequested, 200);

  assert.equal((resolveConfig({ maxWaitSliceMs: 90_000 }) as ResolvedConfigTest).maxWaitSliceMsRequested, undefined);
});

test("a Host stream that never returns control cannot hold the answer past the slice", async () => {
  // The field case this guards: the turn was parked on a long background job, the
  // stream produced no frames, and one `wait` never came back (13 minutes on a
  // five-minute budget). The abort is cooperative, so the deadline must be able to
  // answer on its own.
  // A turn already in flight when we attach: that is what makes this a *wait*
  // rather than the "nothing to wait for" shortcut.
  const controller = fakeController({
    historical: [{ type: "turn/start", data: { turn: 1 }, seq: 1 }],
    script: [],
    stuckAfterSnapshot: true,
  });
  // 1000 is the floor `MIN_WAIT_SLICE_MS` enforces, so a smaller value would be
  // clamped up and this test would measure the clamp instead of the deadline.
  const methods = build(controller, { maxWaitSliceMs: 1_000 });
  const started = Date.now();
  const result = await methods.wait({ sessionId: "s-1", timeoutMs: 10_000 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.sliceMs, 1_000);
  assert.ok(elapsed < 3_000, `answered at the slice boundary, not when the Host felt like it (${elapsed} ms)`);
});


test("a finished call lets go of the caller's abort signal", async () => {
  // Only a real AbortSignal is forwarded by the RPC layer, so the observation has
  // to happen on the instance itself: shadow add/removeEventListener to see the
  // subscription and its release.
  const controller = new AbortController();
  const signal = controller.signal;
  type SignalListener = Parameters<AbortSignal["addEventListener"]>[1];
  type SignalAddOptions = Parameters<AbortSignal["addEventListener"]>[2];
  type SignalRemoveOptions = Parameters<AbortSignal["removeEventListener"]>[2];
  const added: SignalListener[] = [];
  const removed: SignalListener[] = [];
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: SignalListener,
    options?: SignalAddOptions,
  ) => {
    if (type === "abort") added.push(listener);
    return realAdd(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: SignalListener,
    options?: SignalRemoveOptions,
  ) => {
    if (type === "abort") removed.push(listener);
    return realRemove(type, listener, options);
  }) as typeof signal.removeEventListener;

  const methods = build(fakeController({ script: happyScript }));
  const result = await methods.ask({ sessionId: "session-test", text: "go" }, { signal });
  assert.equal(result.status, "completed");
  assert.equal(added.length, 1, "the run must subscribe to the caller's signal");
  assert.ok(removed.includes(req(added[0], "added[0]")), "and let go of it when the call ends");
});


test("a turn held on an approval answers while the approval is still open", async () => {
  // The field shape this guards: the caller is blocked inside the very tool call
  // that is holding the turn, so it cannot ask `approvals.pending` until the call
  // returns. Without the race the deadline always expires first and `delegate`
  // can never actually delegate.
  const { createPendingStore } = await import("../dist/lib/pending.mjs");
  const store = createPendingStore({ deadlineMs: 60_000 });
  const controller = fakeController({
    historical: [{ type: "turn/start", data: { turn: 1 }, seq: 1 }],
    script: [],
    stuckAfterSnapshot: true,
  });
  const methods = build(
    controller,
    { maxWaitSliceMs: 30_000, approvals: { mode: "delegate", deadlineMs: 60_000 } },
    {},
    { approvals: store },
  );

  const started = Date.now();
  const pending = methods.wait({ sessionId: "s-1", timeoutMs: 30_000 });
  // Give the run time to reach the consume loop before the question appears.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const opened = store.open({ sessionId: "s-1", toolName: "bash", escalation: "danger-full-access", argv: "echo hi" });

  const result = await pending;
  const elapsed = Date.now() - started;
  assert.equal(result.status, "waiting-approval");
  assert.equal(result.timedOut, false);
  assert.equal(result.pendingApproval!.approvalId, opened.approvalId);
  assert.equal(result.next!.tool, "dsh_approvals_resolve");
  assert.ok(elapsed < 5_000, `answered while the approval was open (${elapsed} ms)`);
  store.resolve(opened.approvalId, "reject");
});


test("a preset change cannot touch a session this bridge does not own", async () => {
  // A preset change is an escalation route that never passes through the tool
  // gate. Without this rule, `configure` would let any holder of the token widen
  // a session a human is driving, and no one would be asked.
  const permissions = fakePermissions({
    options: [{ value: "workspace-write" }, { value: "danger-full-access" }],
    defaultPreset: "workspace-write",
  });
  const sessions = { get: (id: string) => ({ id, header: { cwd: "C:/work" } }) };
  const methods = build(fakeController({}), {}, { permissionPresets: permissions, sessions });
  await assert.rejects(
    () => methods.configure({ sessionId: "someone-else", permissionPreset: "workspace-write" }),
    /not created by this bridge/,
  );
  assert.deepEqual(permissions.applied, []);
});

test("with approvals on, a preset change cannot skip the gate to full access", async () => {
  const permissions = fakePermissions({
    options: [{ value: "workspace-write" }, { value: "danger-full-access" }],
    defaultPreset: "workspace-write",
  });
  const sessions = { get: (id: string) => ({ id, header: { cwd: "C:/work" } }) };
  const methods = build(
    fakeController({}),
    { approvals: { mode: "deny", deadlineMs: 60_000 } },
    { permissionPresets: permissions, sessions },
  );
  const created = await methods.createSession({ cwd: "C:/work" });
  await assert.rejects(
    () => methods.configure({ sessionId: created.sessionId, permissionPreset: "danger-full-access" }),
    /refusing to raise a session/,
  );
  // Nothing wider than the current preset is an escalation, so it still works.
  await methods.configure({ sessionId: created.sessionId, permissionPreset: "workspace-write" });
  assert.equal(permissions.applied.at(-1)?.name, "workspace-write");
});

test("a prompt that never settles reports a timeout and releases its run slot", async () => {
  const controller = fakeController({ script: happyScript });
  controller.prompt = () => new Promise(() => {});
  const methods = build(controller);
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const started = Date.now();
    const result = await methods.ask({ sessionId: "session-test", text: "stuck", timeoutMs: 150 });
    assert.equal(result.status, "timeout");
    assert.ok(Date.now() - started < 5_000, "the deadline ends the unanswered Host prompt");
    assert.deepEqual((await methods.ping()).activeRuns, []);
  } finally {
    clearInterval(keepAlive);
  }
});

test("a snapshot read that never answers reports a timeout instead of hanging", async () => {
  const controller = fakeController({ stuckBeforeSnapshot: true });
  const started = Date.now();
  await assert.rejects(
    () => build(controller, { historyBudgetMs: 150 }).history({ sessionId: "session-test" }),
    /stopped answering/,
  );
  assert.ok(Date.now() - started < 5_000, "the deadline, not the Host, ends the read");
});

test("a Host that never finishes closing still lets history answer", async () => {
  const controller = fakeController({ stuckOnReturn: true });
  const started = Date.now();
  const result = await build(controller, { historyBudgetMs: 5_000 }).history({ sessionId: "session-test" });
  assert.equal(result.sessionId, "session-test");
  assert.ok(Array.isArray(result.records));
  assert.ok(Date.now() - started < 5_000, "cleanup is bounded, the answer is not");
});

// ------------------------------------------------------------ 0.8.1 S1: trace data --

test("collectTurn records seq, at, endedAt and ok while preserving legacy fields", () => {
  const events = [
    { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
    { type: "tool/call", seq: 2, time: 1010, data: { turn: 1, callId: "c1", name: "read", arguments: { path: "a.txt" } } },
    {
      type: "tool/result",
      seq: 3,
      time: 1025,
      data: { turn: 1, callId: "c1", message: { toolCallId: "c1", content: [{ type: "text", text: "ok-body" }], isError: false } },
    },
    { type: "tool/call", seq: 4, time: 1030, data: { turn: 1, callId: "c2", name: "pwsh", arguments: { command: "exit 1" } } },
    {
      type: "tool/result",
      seq: 5,
      time: 1050,
      data: {
        turn: 1,
        callId: "c2",
        error: { code: "ENOENT", message: "missing" },
        message: { toolCallId: "c2", content: [{ type: "text", text: "failed-body" }], isError: true },
      },
    },
  ];
  const collected = collectTurn(events, 1) as unknown as CollectTurnResultLike;
  assert.equal(collected.tools.length, 2);

  const first = req(collected.tools[0], "first tool");
  const second = req(collected.tools[1], "second tool");
  assert.equal(first.callId, "c1");
  assert.equal(first.name, "read");
  assert.deepEqual(first.arguments, { path: "a.txt" });
  assert.equal(first.output, "ok-body");
  assert.equal(first.isError, undefined);
  assert.equal(first.seq, 2);
  assert.equal(first.at, 1010);
  assert.equal(first.endedAt, 1025);
  assert.ok(first.endedAt! >= first.at);
  assert.equal(first.ok, true);

  assert.equal(second.callId, "c2");
  assert.equal(second.name, "pwsh");
  assert.deepEqual(second.arguments, { command: "exit 1" });
  assert.equal(second.output, "failed-body");
  assert.equal(second.isError, true);
  assert.deepEqual(second.error, { code: "ENOENT", message: "missing" });
  assert.equal(second.seq, 4);
  assert.equal(second.at, 1030);
  assert.equal(second.endedAt, 1050);
  assert.ok(second.endedAt! >= second.at);
  assert.equal(second.ok, false);
  assert.ok(second.seq > first.seq);
  assert.ok(second.at >= first.at);
});

test("ask carries seq/at/endedAt/ok and retains error alongside legacy tool fields", async () => {
  const controller = fakeController({
    script: [
      { kind: "start", turn: 1 },
      { kind: "tool", turn: 1, callId: "c1", name: "read" },
      { kind: "toolResult", turn: 1, callId: "c1", text: "alpha", isError: false },
      { kind: "tool", turn: 1, callId: "c2", name: "bash" },
      { kind: "toolResult", turn: 1, callId: "c2", text: "boom", isError: true, error: { reason: "exit 1" } },
      { kind: "text", turn: 1, text: "done" },
      { kind: "end", turn: 1 },
    ],
  });
  const result = await build(controller).ask({ text: "run tools" });
  assert.equal(result.tools.length, 2);
  const t1 = req(result.tools[0], "t1");
  const t2 = req(result.tools[1], "t2");
  assert.ok(Number.isInteger(t1.seq) && Number.isInteger(t2.seq) && t2.seq > t1.seq);
  assert.ok(typeof t1.at === "number" && typeof t2.at === "number" && t2.at >= t1.at);
  assert.ok(typeof t1.endedAt === "number" && t1.endedAt >= t1.at);
  assert.ok(typeof t2.endedAt === "number" && t2.endedAt >= t2.at);
  assert.equal(t1.ok, true);
  assert.equal(t2.ok, false);
  assert.equal(t2.isError, true);
  assert.deepEqual(t2.error, { reason: "exit 1" });
  assert.equal(t1.callId, "c1");
  assert.equal(t1.name, "read");
  assert.deepEqual(t1.arguments, {});
  assert.equal(t1.output, "alpha");
  assert.equal(t2.output, "boom");
});

test("history filters by kinds and since while keeping omission backward compatible", async () => {
  const historical = [
    { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
    { type: "tool/call", seq: 1, time: 20, data: { turn: 1, callId: "c1", name: "read", arguments: {} } },
    {
      type: "tool/result",
      seq: 2,
      time: 30,
      data: { turn: 1, callId: "c1", message: { toolCallId: "c1", content: [{ type: "text", text: "ok" }] } },
    },
    {
      type: "assistant/message",
      seq: 3,
      time: 40,
      data: { turn: 1, message: { content: [{ type: "text", text: "reply" }] } },
    },
    { type: "turn/end", seq: 4, time: 50, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const methods = build(fakeController({ historical }));

  const baseline = await methods.history({ sessionId: "session-test" });
  assert.equal(baseline.records.length, 5);
  assert.equal(req(baseline.records[0], "records[0]").seq, 0);
  assert.equal("truncated" in baseline, false);

  const byKinds = await methods.history({ sessionId: "session-test", kinds: ["tool/call", "tool/result"] });
  assert.deepEqual(byKinds.records.map((r) => r.type), ["tool/call", "tool/result"]);

  const wildcard = await methods.history({ sessionId: "session-test", kinds: "*" });
  assert.equal(wildcard.records.length, 5);

  const bySince = await methods.history({ sessionId: "session-test", since: 2 });
  assert.deepEqual(bySince.records.map((r) => r.seq), [3, 4]);
  assert.equal(bySince.cursor, 4);
  assert.equal(bySince.turn, 1);

  const combined = await methods.history({ sessionId: "session-test", since: 1, kinds: ["tool/result", "turn/end"] });
  assert.deepEqual(combined.records.map((r) => r.type), ["tool/result", "turn/end"]);
});

test("history enforces maxChars with an explicit truncated flag and validates bad filters", async () => {
  const historical = [
    { type: "turn/start", seq: 1, time: 10, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 2,
      time: 20,
      data: { turn: 1, message: { content: [{ type: "text", text: "x".repeat(400) }] } },
    },
    { type: "turn/end", seq: 3, time: 30, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const methods = build(fakeController({ historical }));

  const capped = await methods.history({ sessionId: "session-test", maxChars: 180 });
  assert.equal(capped.truncated, true);
  assert.ok(JSON.stringify(capped.records).length <= 180);
  assert.equal(capped.records.at(-1)?.type, "turn/end");

  const singleHuge = await methods.history({
    sessionId: "session-test",
    kinds: ["assistant/message"],
    maxChars: 160,
  });
  assert.equal(singleHuge.truncated, true);
  assert.ok(JSON.stringify(singleHuge.records).length <= 160);
  assert.match(JSON.stringify(singleHuge.records), /truncated/);

  const unlimited = await methods.history({ sessionId: "session-test", maxChars: 0 });
  assert.equal(unlimited.records.length, 3);
  assert.equal("truncated" in unlimited, false);

  const withinBudget = await methods.history({ sessionId: "session-test", maxChars: 10_000 });
  assert.equal(withinBudget.truncated, false);
  assert.equal(withinBudget.records.length, 3);

  await assert.rejects(
    () => methods.history({ sessionId: "session-test", since: -1 }),
    (err: RpcErrorLike) => err.code === -32602,
  );
  await assert.rejects(
    () => methods.history({ sessionId: "session-test", kinds: "tool/call" }),
    (err: RpcErrorLike) => err.code === -32602,
  );
  await assert.rejects(
    () => methods.history({ sessionId: "session-test", maxChars: -5 }),
    (err: RpcErrorLike) => err.code === -32602,
  );
});

test("METHOD_CATALOG is single source of truth for createMethods().handlers and ping.taskCentre projection", async () => {
  assert.equal(METHOD_CATALOG.length, 34);
  const autopilot = { enabled: true, intervalMs: 5_000, maxStart: 2, maxPump: 4 };
  const autopilotStats = {
    passes: 3,
    lastPassAt: "2026-11-19T00:00:00.000Z",
    lastStarted: 1,
    lastPumped: 2,
    lastFailed: 0,
    lastError: null,
  };
  const methods = createMethods(
    {
      sessionController: fakeController({ script: happyScript }) as never,
      webServer: ORIGIN as never,
      taskCentre: {
        enabled: true,
        mode: "memory",
        ready: true,
        dbPath: null,
        seedError: null,
        startError: null,
        autopilot,
        autopilotStats,
      } as unknown as null,
    },
    resolveConfig({ tasksEnabled: true }),
    { get: () => undefined },
    { tokenSource: "env" },
  ) as unknown as MethodsTestApi;

  const catalogNames = METHOD_CATALOG.map((entry) => entry.name).sort();
  const handlerKeys = Object.keys(methods.handlers).sort();
  assert.deepEqual(handlerKeys, catalogNames);
  for (const name of catalogNames) {
    assert.equal(typeof methods.handlers[name], "function", `missing handler for ${name}`);
  }

  const discoverHandler = req(methods.handlers["dsh.discover"], "dsh.discover");
  const discovered = (await discoverHandler()) as { methods: unknown[] };
  assert.equal(discovered.methods.length, 34);
  const pingHandler = req(methods.handlers["dsh.ping"], "dsh.ping");
  const ping = (await pingHandler()) as {
    taskCentre: { autopilot: unknown; autopilotStats: unknown };
  };
  assert.deepEqual(ping.taskCentre.autopilot, autopilot);
  assert.deepEqual(ping.taskCentre.autopilotStats, autopilotStats);
});

test("MethodName, METHOD_CATALOG, createMethods().handlers, and Params contracts reject invalid keys/shapes at tsc compile time", () => {
  const repoRoot = resolve(import.meta.dirname, "..");
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    repoRoot,
  );
  // Never emit, never write build info, never touch the repo: the two probes live in memory.
  const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, declaration: false };
  const validFile = resolve(repoRoot, "src/lib/__methods_valid_probe__.mts");
  const badFile = resolve(repoRoot, "src/lib/__methods_bad_probe__.mts");

  const validSource = `
import {
  createMethods,
  METHOD_CATALOG,
  type MethodCatalogEntry,
  type MethodName,
  type PingTaskCentreProjection,
  type RpcMethodHandler,
  type TasksCancelParams,
  type TasksSubmitParams,
} from "./methods.mjs";
import { buildDispatcher } from "./http.mjs";

const catalog: readonly MethodCatalogEntry[] = METHOD_CATALOG;
const validName: MethodName = "dsh.tasks.submit";
const methods = createMethods({ sessionController: null });
const dispatch = buildDispatcher(methods);
const submitHandler: RpcMethodHandler = methods.handlers[validName];
const submitParams: TasksSubmitParams = {
  idempotencyKey: "k1",
  capabilityRevisionId: "rev-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
};
const cancelParams: TasksCancelParams = {
  taskId: "t1",
  expectedStateVersion: 1,
  idempotencyKey: "k2",
};
async function checkPing(): Promise<PingTaskCentreProjection> {
  const res = await methods.ping();
  const passes: number | undefined = res.taskCentre.autopilotStats?.passes;
  void passes;
  return res.taskCentre;
}
void catalog; void dispatch; void submitHandler; void submitParams; void cancelParams; void checkPing;
`;

  const badSource = `
import {
  createMethods,
  type MethodName,
  type RpcMethodHandler,
  type TasksCancelParams,
} from "./methods.mjs";

const badName: MethodName = "dsh.tasks.nonexistent";
const methods = createMethods({ sessionController: null });
const missingHandler = methods.handlers["dsh.doesNotExist"];
const partialMap: Record<MethodName, RpcMethodHandler> = {
  "dsh.discover": async () => ({}),
};
const badCancel: TasksCancelParams = {
  taskId: "t1",
  expectedStateVersion: "not-a-number",
  idempotencyKey: "k1",
};
void badName; void missingHandler; void partialMap; void badCancel;
`;

  const sources = new Map([
    [validFile, validSource],
    [badFile, badSource],
  ]);
  const host = ts.createCompilerHost(options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const resolved = resolve(fileName);
    const virtual = sources.get(resolved);
    if (virtual !== undefined) return ts.createSourceFile(fileName, virtual, languageVersion, true);
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) => sources.has(resolve(fileName)) || origFileExists(fileName);
  host.readFile = (fileName) => sources.get(resolve(fileName)) ?? origReadFile(fileName);
  host.writeFile = () => {
    throw new Error("the type probe must never write to disk");
  };

  const program = ts.createProgram([validFile, badFile], options, host);
  const collectDiagnostics = (rootFile: string) => {
    const sourceFile = program.getSourceFile(rootFile);
    if (!sourceFile) throw new Error(`tsc did not load the probe ${rootFile}`);
    return ts
      .getPreEmitDiagnostics(program, sourceFile)
      .filter((diagnostic) => diagnostic.file === sourceFile)
      .map((diagnostic) => ({
        code: diagnostic.code,
        text: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      }));
  };

  const validDiagnostics = collectDiagnostics(validFile);
  assert.deepEqual(
    validDiagnostics,
    [],
    `valid methods probe should compile cleanly, got: ${validDiagnostics.map((d) => `TS${d.code}:${d.text}`).join("; ")}`,
  );

  const badDiagnostics = collectDiagnostics(badFile);
  const codes = new Set(badDiagnostics.map((diagnostic) => diagnostic.code));
  const summary = badDiagnostics.map((d) => `TS${d.code}:${d.text}`).join(" | ");
  assert.ok(badDiagnostics.length >= 4, `expected >= 4 tsc errors, got ${badDiagnostics.length}: ${summary}`);
  assert.ok(codes.has(2322), `expected TS2322 for the bogus MethodName and the mistyped field: ${summary}`);
  assert.ok(
    codes.has(2339) || codes.has(7053),
    `expected TS2339/TS7053 for the unknown handler key: ${summary}`,
  );
  assert.ok(
    codes.has(2740) || codes.has(2741) || codes.has(2739),
    `expected TS2740/TS2741/TS2739 for the partial handler map: ${summary}`,
  );
  assert.ok(
    badDiagnostics.some((diagnostic) => diagnostic.text.includes("Type '\"dsh.tasks.nonexistent\"' is not assignable")),
    `expected the bogus method name type error in the diagnostics: ${summary}`,
  );
  assert.ok(
    badDiagnostics.some((diagnostic) => diagnostic.text.includes("dsh.doesNotExist")),
    `expected the unknown handler key in the diagnostics: ${summary}`,
  );
  assert.ok(
    badDiagnostics.some((diagnostic) => diagnostic.text.includes("Type 'string' is not assignable to type 'number'")),
    `expected the mistyped expectedStateVersion error in the diagnostics: ${summary}`,
  );
});
