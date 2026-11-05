// Contract tests for the bridge logic, driven by a fake `sessionController`.
//
// These run out of process, so they pin the turn-tracking rules (subscribe →
// baseline snapshot → prompt → wait for `baseline.turn + 1`) without needing a
// live Harness. The fake mirrors the real shapes: `follow` yields a snapshot
// first and then live `{type:'event', event}` frames.

import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../lib/config.mjs";
import { createMethods } from "../lib/methods.mjs";
import { buildDispatcher } from "../lib/http.mjs";

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

function fakeController({ script = [], historical = [], hostCwd = "/host/resolved", models = null } = {}) {
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
      void (async () => {
        // Steering joins a turn that is already running, so the Host appends the
        // message without a fresh `turn/start`; model that explicitly.
        if (script.length > 0 && script[0].kind !== "start") {
          append("user/message", {
            role: "user",
            content: [{ type: "text", text: "…" }],
            source: { kind: "user", rpcId: request.requestId },
          });
        }
        for (const step of script) {
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
          } else if (step.kind === "end") {
            append("turn/end", { turn: step.turn, reason: step.reason ?? { kind: "completed" } });
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
  assert.deepEqual(result.items[0], {
    sessionId: "session-test",
    running: false,
    blank: false,
    agentAvailable: true,
    updatedAt: 1,
    cwd: "/tmp",
    agentPreset: null,
    origin: null,
    parentSessionId: null,
  });
});

test("dispatcher rejects unknown methods and exposes the catalog", async () => {
  const dispatch = buildDispatcher(build(fakeController({ script: happyScript })));

  const catalog = await dispatch("dsh.discover", {});
  assert.equal(catalog.plugin, "dsh-rpc");
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


