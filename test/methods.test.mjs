// Contract tests for the bridge logic, driven by a fake `sessionController`.
//
// These run out of process, so they pin the turn-tracking rules (subscribe →
// baseline snapshot → prompt → wait for `baseline.turn + 1`) without needing a
// live Harness. The fake mirrors the real shapes: `follow` yields a snapshot
// first and then live `{type:'event', event}` frames.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The sticky-session registry lives under `$DSH_HOME/dsh-rpc/`. A suite that
// remembered a session between runs would make "created" vs "reused" depend on
// what ran five minutes ago, so every run gets its own home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rpc-home-"));

import { resolveConfig } from "../lib/config.mjs";
import { createMethods } from "../lib/methods.mjs";
import { buildDispatcher } from "../lib/http.mjs";

// The bridge deliberately `unref()`s its timers so a bridge run never keeps the
// Host process alive. In this process those timers are the only handles, so a
// test that waits on one would see the loop drain and the run cancel itself
// (`cancelledByParent`, Linux only — Windows happens to keep other handles).
// The suite therefore holds one handle of its own for its whole lifetime.
const SUITE_KEEPALIVE = setInterval(() => {}, 60_000);
after(() => clearInterval(SUITE_KEEPALIVE));

const ORIGIN = { getOrigin: () => "http://127.0.0.1:0" };

function bus() {
  const queue = [];
  const waiters = [];
  let closed = false;
  return {
    push(item) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else queue.push(item);
    },
    next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
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
  hostCwd = "/host/resolved",
  models = null,
  stuckAfterSnapshot = false,
} = {}) {
  const events = [...historical];
  const subscribers = new Set();
  const prompts = [];
  const created = [];
  const cancelled = [];
  const inspected = [];
  const selections = [];
  let seq = events.length > 0 ? events[events.length - 1].seq : 0;

  // The real SessionController dereferences the caller signal unconditionally
  // (`signal.throwIfAborted()`), so tolerating an undefined signal here would
  // hide a genuine crash class from the suite.
  const requireSignal = (signal) => signal.throwIfAborted();

  const append = (type, data) => {
    seq += 1;
    const event = { type, seq, time: Date.now(), data };
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

    async create(request) {
      created.push(request);
      return { sessionId: "session-test", agentPreset: request.agentPreset };
    },

    async inspect(sessionId, signal) {
      requireSignal(signal);
      inspected.push(sessionId);
      return { meta: { cwd: hostCwd }, inheritedEventCount: 0, events: [] };
    },

    async list(_request, signal) {
      requireSignal(signal);
      return {
        items: [{ sessionId: "session-test", running: false, blank: false, updatedAt: 1, cwd: "/tmp" }],
      };
    },

    async modelCatalog() {
      if (models) return models;
      return { default: { provider: "p", model: "m" }, routableProviders: ["p"], groups: [], failures: [] };
    },

    async selectModel(request) {
      // The Host declares `selectModel(request)` without a signal argument, so the
      // bridge must not invent one — this fake fails loudly if it ever does.
      selections.push(request);
      const selected = { provider: request.provider, model: request.model };
      if (request.reasoningEffort !== undefined) selected.reasoningEffort = request.reasoningEffort;
      return { selected };
    },

    async cancel(request) {
      cancelled.push(request);
      return { accepted: true, sessionId: request.sessionId };
    },

    prompt(request, signal) {
      requireSignal(signal);
      prompts.push(request);
      // `scripts` gives each prompt its own turn sequence, which is what a queued
      // second run needs: it must observe its own turn, not replay the first one's.
      const steps = scripts ? (scripts[prompts.length - 1] ?? []) : script;
      void (async () => {
        // Steering joins a turn that is already running, so the Host appends the
        // message without a fresh `turn/start`; model that explicitly.
        if (steps.length > 0 && steps[0].kind !== "start") {
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
            });
          } else if (step.kind === "end") {
            append("turn/end", { turn: step.turn, reason: step.reason ?? { kind: "completed" } });
          } else if (step.kind === "rawEnd") {
            // A `turn/end` with no `reason` field at all: the union requires one,
            // but the union is a type, not a runtime guard.
            append("turn/end", { turn: step.turn });
          }
        }
      })();
      return Promise.resolve({ accepted: true });
    },

    async *follow(_request, signal) {
      const out = bus();
      const push = (frame) => out.push(frame);
      subscribers.add(push);
      const onAbort = () => out.close();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
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
          await new Promise(() => {});
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
      }
    },
  };

  return controller;
}

function build(controller, overrides = {}, services = {}) {
  return createMethods(
    { sessionController: controller, webServer: ORIGIN },
    resolveConfig(overrides),
    { get: (name) => services[name] },
    {},
  );
}

// The optional Host services the bridge reaches for through `ctx.get`. They are
// genuinely optional, so a deployment that lacks them must fail with a readable
// message rather than a TypeError.
function fakeWorkspaces({ items = [] } = {}) {
  return {
    calls: [],
    list() {
      return items;
    },
    async create(path, title) {
      this.calls.push({ path, title });
      return { id: "ws-new", path, title: title ?? path, createdAt: 1, updatedAt: 1, sessionIds: [] };
    },
  };
}

function fakePermissions({ options = [], defaultPreset = null } = {}) {
  return {
    applied: [],
    async catalog() {
      return { options, defaultOptions: {}, defaultPreset };
    },
    set(session, name) {
      this.applied.push({ sessionId: session?.id, name });
    },
  };
}

const happyScript = [
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
  assert.equal(result.tools[0].name, "bash");
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
  });
  assert.equal(controller.prompts.length, 1);
  assert.deepEqual(controller.prompts[0].content, [{ type: "text", text: "ping" }]);
  assert.equal(controller.prompts[0].mode, "queue");
  assert.equal(controller.created[0].cwd, "/tmp/work");
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
  assert.equal(controller.prompts[0].mode, "steer");
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
  assert.equal(result.records[1].type, "turn/end");
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
    (error) => error.code === -32004,
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
      (error) => {
        assert.equal(error.code, -32602);
        assert.match(error.message, /`limit` must be a positive integer/);
        return true;
      },
    );
    await assert.rejects(
      () => methods.history({ sessionId: "session-test", limit }),
      (error) => error.code === -32602,
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
  const dispatch = buildDispatcher(build(fakeController({ script: happyScript })));

  const catalog = await dispatch("dsh.discover", {});
  assert.equal(catalog.plugin, "dsh-rpc-agent");
  assert.equal(catalog.methods.some((entry) => entry.name === "dsh.sessions.ask"), true);

  await assert.rejects(() => dispatch("dsh.nope", {}), (error) => error.code === -32601);
  await assert.rejects(() => dispatch("ask", { text: "   " }), (error) => error.code === -32602);
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
    (error) => error.code === -32602 && /only apply when the session is created/.test(error.message),
  );
  await assert.rejects(
    () => methods.prompt({ sessionId: "session-test", text: "hi", agentPreset: "minimal" }),
    (error) => error.code === -32602 && /only applies when the session is created/.test(error.message),
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
  const seen = [];
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
    (error) => error.code === -32004,
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
    (error) => error.code === -32005 && /stayed busy/.test(error.message),
  );

  holder.abort();
  await first.catch(() => {});
});

test("creating a session leaves cwd to the Host when the caller names none", async () => {
  const controller = fakeController();
  const result = await build(controller).createSession({});
  assert.equal("cwd" in controller.created[0], false, "create must not override the Host default cwd");
  assert.equal(result.cwd, "/host/resolved", "the resolved cwd is read back from inspect");
  assert.deepEqual(controller.inspected, ["session-test"]);
});

test("an explicit cwd is forwarded verbatim", async () => {
  const controller = fakeController({ hostCwd: "/tmp/work" });
  const result = await build(controller).createSession({ cwd: "/tmp/work" });
  assert.equal(controller.created[0].cwd, "/tmp/work");
  assert.equal(result.cwd, "/tmp/work", "the echoed cwd is the one the Host attached");
  assert.deepEqual(controller.inspected, ["session-test"]);
});

// ------------------------------------------------------- workspaces & options --

test("a workspace is forwarded instead of a cwd, never both", async () => {
  const controller = fakeController({ hostCwd: "/home/dev/work" });
  const result = await build(controller).createSession({ workspaceId: "ws-1" });
  assert.equal(controller.created[0].workspaceId, "ws-1");
  assert.equal("cwd" in controller.created[0], false, "the Host derives the directory from the workspace");
  assert.equal(result.cwd, "/home/dev/work");
});

test("naming a workspace and a cwd together is refused", async () => {
  const controller = fakeController();
  await assert.rejects(
    () => build(controller).createSession({ workspaceId: "ws-1", cwd: "/tmp/work" }),
    (error) => error.code === -32602 && /cannot be combined/.test(error.message),
  );
  assert.equal(controller.created.length, 0, "nothing may be created when the request is contradictory");
});

test("a caller-chosen session id is refused instead of silently replaced", async () => {
  const controller = fakeController();
  await assert.rejects(
    () => build(controller).createSession({ sessionId: "session-3f2a" }),
    (error) => error.code === -32602 && /assigned by the Host/.test(error.message),
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
  assert.equal(controller.selections[0].provider, "alpha");
});

test("a bare model id offered twice names both spellings instead of guessing", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test", model: "shared" }),
    (error) => error.code === -32602 && /spell it "provider\/shared"/.test(error.message),
  );
  assert.equal(controller.selections.length, 0);
});

test("an unknown model is refused with a pointer to the catalog", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test", model: "nope" }),
    (error) => error.code === -32602 && /call dsh\.models/.test(error.message),
  );
});

test("reasoning effort alone is refused, because the Host cannot read the model back", async () => {
  const controller = fakeController({ models: twoProviderModels });
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test", reasoningEffort: "high" }),
    (error) => error.code === -32602 && /needs `model`/.test(error.message),
  );
  assert.equal(controller.selections.length, 0);
});

test("configure with nothing to configure says so", async () => {
  const controller = fakeController();
  await assert.rejects(
    () => build(controller).configure({ sessionId: "session-test" }),
    (error) => error.code === -32602 && /nothing to configure/.test(error.message),
  );
});

test("a permission preset is applied to the live session object", async () => {
  const permissions = fakePermissions({
    options: [{ value: "read-only" }, { value: "workspace-write" }],
    defaultPreset: "workspace-write",
  });
  const controller = fakeController();
  const services = { permissionPresets: permissions, sessions: { get: (id) => ({ id }) } };
  const result = await build(controller, {}, services).configure({
    sessionId: "session-test",
    permissionPreset: "read-only",
  });
  assert.equal(result.permissionPreset, "read-only");
  assert.deepEqual(permissions.applied, [{ sessionId: "session-test", name: "read-only" }]);
});

test("an unknown permission preset is refused before touching the session", async () => {
  const permissions = fakePermissions({ options: [{ value: "read-only" }] });
  const services = { permissionPresets: permissions, sessions: { get: (id) => ({ id }) } };
  await assert.rejects(
    () => build(fakeController(), {}, services).configure({ sessionId: "session-test", permissionPreset: "yolo" }),
    (error) => error.code === -32602 && /available: read-only/.test(error.message),
  );
  assert.equal(permissions.applied.length, 0);
});

test("a deployment without permissionPresets reports that instead of crashing", async () => {
  await assert.rejects(
    () => build(fakeController(), {}, {}).configure({ sessionId: "session-test", permissionPreset: "read-only" }),
    (error) => error.code === -32000 && /no permissionPresets service/.test(error.message),
  );
});

test("a sandbox refusal is reported as a fact plus the one documented escalation", async () => {
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
  assert.equal(result.sandbox.denied, true);
  assert.equal(result.sandbox.marker, "[sandbox: file access denied under workspace-write mode]");
  assert.equal(result.sandbox.source, "tool");
  assert.deepEqual(result.next.args, { session_id: "session-test", permission: "danger-full-access" });
  assert.equal(result.next.tool, "dsh_ask");
  // The refusal is not an error: the turn ran and the tool error keeps its own flag.
  assert.equal(result.tools[0].isError, true);
  assert.match(result.tools[0].output, /sandbox: file access denied/);
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

  assert.equal(result.sandbox.denied, true);
  assert.equal(result.sandbox.source, "text");
});

test("a turn's tool output is bounded even when every call is chatty", async () => {
  const noisy = "x".repeat(4000);
  const script = [{ kind: "start", turn: 1 }];
  for (let i = 0; i < 6; i += 1) {
    script.push({ kind: "tool", turn: 1, callId: `c${i}`, name: "bash" });
    script.push({ kind: "toolResult", turn: 1, callId: `c${i}`, text: noisy });
  }
  script.push({ kind: "end", turn: 1 });

  const result = await build(fakeController({ script })).ask({ text: "跑很多命令" });
  const total = result.tools.reduce((sum, tool) => sum + (tool.output?.length ?? 0), 0);

  assert.ok(total <= 20000 + 400, `tool output should stay near the budget, got ${total}`);
  assert.match(result.tools.at(-1).output, /omitted/);
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
  assert.match(catalog.options[0].cost, /writes inside the session workspace/);
  assert.match(catalog.options[1].cost, /approvals disabled/);
  assert.equal(catalog.options[2].cost, null); // unknown preset: no invented wording
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
  assert.equal(result.items[1].status, "unknown", "a failing status probe must not fail the whole listing");
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
    (error) => error.code === -32602 && /only apply when the session is created/.test(error.message),
  );
  assert.equal(controller.prompts.length, 0, "a refused request must not reach the Host");
});

test("reusing a session cannot change its agent preset", async () => {
  const controller = fakeController({ script: happyScript });
  await assert.rejects(
    () => build(controller).ask({ sessionId: "session-test", text: "go", agentPreset: "minimal" }),
    (error) => error.code === -32602 && /`agentPreset` only applies when the session is created/.test(error.message),
  );
  assert.equal(controller.prompts.length, 0, "a refused request must not reach the Host");
});

test("ask applies options and reports them alongside the turn", async () => {
  const controller = fakeController({ models: twoProviderModels, script: happyScript });
  const permissions = fakePermissions({ options: [{ value: "read-only" }] });
  const services = { permissionPresets: permissions, sessions: { get: (id) => ({ id }) } };
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
  assert.match(result.requestId, /^rpc-/);
  assert.equal(controller.prompts.length, 1, "the prompt must still be submitted");
});

test("queue and wait:false are refused together instead of silently ignoring one", async () => {
  const controller = fakeController({ script: happyScript });

  await assert.rejects(
    () => build(controller).ask({ text: "x", wait: false, queue: true }),
    (error) => error.code === -32602 && /queue.*wait: false/.test(error.message),
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
    (error) => error.code === -32004 && /already running a turn/.test(error.message),
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
  assert.equal(result.tools[0].name, "bash");
  assert.equal(result.tools[0].output, "a.txt");
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
    (error) => error.code === -32602 && /mode/.test(error.message),
  );
  await assert.rejects(
    () => methods.ask({ text: "甲", reuse: "sometimes" }),
    (error) => error.code === -32602 && /reuse/.test(error.message),
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
    (error) =>
      error.code === -32004 &&
      /already running/.test(error.message) &&
      error.data?.next?.tool === "dsh_wait" &&
      error.data?.next?.args?.session_id === "session-test",
  );
});

test("a sticky session rotates after the bridge's ask budget, and says which one it left", async () => {
  const { forgetEntry, lookupEntry, registryKey, rememberEntry } = await import("../lib/registry.mjs");
  const { ROTATE_AFTER_ASKS } = await import("../lib/registry.mjs");
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
  assert.equal(resolveConfig({}).maxWaitSliceMsRequested, undefined);

  const tooBig = resolveConfig({ maxWaitSliceMs: 900_000 });
  assert.equal(tooBig.maxWaitSliceMs, 240_000, "one response cannot wait longer than the ceiling");
  assert.equal(tooBig.maxWaitSliceMsRequested, 900_000, "the operator can still see what was asked for");

  const tooSmall = resolveConfig({ maxWaitSliceMs: 200 });
  assert.equal(tooSmall.maxWaitSliceMs, 1_000, "a slice below one second is pointless");
  assert.equal(tooSmall.maxWaitSliceMsRequested, 200);

  assert.equal(resolveConfig({ maxWaitSliceMs: 90_000 }).maxWaitSliceMsRequested, undefined);
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
  const added = [];
  const removed = [];
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") added.push(listener);
    return realAdd(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") removed.push(listener);
    return realRemove(type, listener, options);
  };

  const methods = build(fakeController({ script: happyScript }));
  const result = await methods.ask({ sessionId: "session-test", text: "go" }, { signal });
  assert.equal(result.status, "completed");
  assert.equal(added.length, 1, "the run must subscribe to the caller's signal");
  assert.ok(removed.includes(added[0]), "and let go of it when the call ends");
});
