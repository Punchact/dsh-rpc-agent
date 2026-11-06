// Method implementations over the Host `sessionController` service.
//
// The whole bridge rests on one observation: `sessionController.follow` is an
// AsyncIterable whose first frame is a snapshot and whose later frames are live
// events. Subscribing *before* `prompt` is admitted is what makes the result
// deterministic — we know the turn baseline first, so the turn we are waiting
// for is exactly `baseline.turn + 1` (or `baseline.turn` for a steer into a
// running turn). No polling, no racing the queue.

import { randomUUID } from "node:crypto";

import { describeConfig } from "./config.mjs";
import { CODE, RpcError, badRequest } from "./protocol.mjs";
import { ROTATE_AFTER_ASKS, lookupEntry, registryKey, rememberEntry } from "./registry.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_WAIT_RECORDS = 500;

// `dsh_ask`'s `mode`. `turn` is this bridge's own rule ("only into an idle
// session") and never reaches the Host — see `drive()`.
const ASK_MODES = ["turn", "steer", "queue"];
// `reuse`. `auto` = sticky lookup, `never` = always a new session, `latest` =
// ignore the stored mapping and take the most recently updated session for the
// key's scope.
const REUSE_MODES = ["auto", "never", "latest"];

// A tool's output is carried back so a sandbox refusal can be recognised, but
// one chatty command must not turn a result into megabytes of JSON.
const TOOL_OUTPUT_LIMIT = 4000;

// Per-tool truncation alone is not a bound: a turn with a hundred tool calls
// would still ship 400 KB into the caller's context. The turn gets one budget.
const TOOL_OUTPUT_BUDGET = 20000;

// The sandbox appends a fixed sentence to a refused tool call. Matching that
// exact prefix — rather than words like "denied" or "permission" — is what keeps
// the escalation hint from firing on ordinary error text.
const SANDBOX_DENIED_MARKER = "[sandbox: file access denied";

// The only mode that is strictly wider than `workspace-write` (the default
// preset): the Host's sandbox ladder is closed, and every preset that grants
// more than the workspace is this one.
const ESCALATION_PRESET = "danger-full-access";

// What a preset costs, in the caller's own terms. A deployment may declare its
// own names, so anything unrecognised keeps `cost: null` instead of a guess.
const PRESET_COST = {
  "read-only": "read-only sandbox: every write fails, and there is no approval path",
  "workspace-write": "writes inside the session workspace; leaving it requires approval",
  "danger-full-access":
    "full disk access with approvals disabled — nothing else restricts this turn, so it is the last resort after a denial",
  auto: "deployment-defined automatic posture; ask the operator what it expands to",
};

/** Self-description served by `dsh.discover`, so a caller never has to guess. */
const METHOD_CATALOG = [
  {
    name: "dsh.discover",
    summary: "Return this method catalog.",
    params: {},
    returns: "{ methods: MethodDescriptor[] }",
  },
  {
    name: "dsh.ping",
    summary: "Liveness, version, mounted path, config projection and active runs.",
    params: {},
    returns: "{ ok, plugin, version, protocol, origin, config, state, activeRuns }",
  },
  {
    name: "dsh.models",
    summary: "List routable providers and models for this profile.",
    params: {},
    returns: "{ default, routableProviders, groups, failures }",
  },
  {
    name: "dsh.workspaces.list",
    summary:
      "List the durable workspaces the Host shows in its sidebar, in display order, with the directory each one owns.",
    params: {},
    returns: "{ total, items: [{ id, title, path, status, sessions, createdAt, updatedAt }] }",
  },
  {
    name: "dsh.workspaces.create",
    summary: "Register an existing directory as a workspace (idempotent for the same canonical path).",
    params: { path: "string (required, absolute)", title: "string (optional)" },
    returns: "{ id, title, path }",
  },
  {
    name: "dsh.permissions.catalog",
    summary:
      "List the permission presets this deployment exposes, each expanding to a sandbox mode and an approval policy.",
    params: {},
    returns: "{ defaultPreset, options: [{ value, name, description? }], defaultOptions }",
  },
  {
    name: "dsh.sessions.configure",
    summary:
      "Retune an existing session: model, reasoning effort, permission preset. Applies to that session's next turn.",
    params: {
      sessionId: "string (required)",
      model: "'provider/model' or bare model id (optional)",
      reasoningEffort: "string (optional)",
      permissionPreset: "string (optional)",
    },
    returns: "{ sessionId, selected: { provider, model, reasoningEffort? }?, permissionPreset? }",
  },
  {
    name: "dsh.sessions.list",
    summary: "List Harness sessions visible to the Host, newest first as the Host orders them.",
    params: { limit: "number (default 50)" },
    returns: "{ total, items: SessionSummary[] }",
  },
  {
    name: "dsh.sessions.create",
    summary: "Create a blank session without prompting it.",
    params: {
      workspaceId: "string (optional; exclusive with cwd)",
      cwd: "string (optional)",
      agentPreset: "string (optional)",
      model: "string (optional)",
      reasoningEffort: "string (optional)",
      permissionPreset: "string (optional)",
    },
    returns: "{ sessionId, agentPreset, cwd }",
  },
  {
    name: "dsh.sessions.ask",
    summary:
      "Create (or reuse) a session, apply optional model/permission settings, submit one prompt, and wait for that turn to finish. Returns the assistant text plus tool calls, usage and the turn-end reason.",
    params: {
      text: "string (required)",
      sessionId: "string (optional; omit to create a fresh session)",
      workspaceId: "string (optional; exclusive with cwd, new sessions only)",
      cwd: "string (optional)",
      agentPreset: "string (optional)",
      model: "string (optional)",
      reasoningEffort: "string (optional)",
      permissionPreset: "string (optional)",
      mode: "'queue' | 'steer' (default 'queue')",
      queue: "boolean (default false; true waits for the session when another run is prompting it)",
      timeoutMs: "number (default 600000, max 3600000)",
    },
    returns:
      "{ sessionId, turn, status, reason, text, reasoning?, tools[], usage?, durationMs, timedOut, created }",
  },
  {
    name: "dsh.sessions.prompt",
    summary:
      "Submit a prompt without waiting for the turn to finish (fire and forget). Does not reserve the session, so a concurrent ask may still claim the turn — follow it with dsh.sessions.wait if the result matters.",
    params: { sessionId: "string (required)", text: "string (required)", mode: "'queue' | 'steer'" },
    returns: "{ accepted, sessionId, requestId, mode }",
  },
  {
    name: "dsh.sessions.wait",
    summary: "Wait for the turn already running on a session and return its result.",
    params: { sessionId: "string (required)", timeoutMs: "number (optional)" },
    returns: "same shape as dsh.sessions.ask",
  },
  {
    name: "dsh.sessions.cancel",
    summary: "Cancel the in-flight turn of a session.",
    params: { sessionId: "string (required)" },
    returns: "{ accepted, sessionId }",
  },
  {
    name: "dsh.sessions.history",
    summary: "Read the recent event window of a session without activating its agent.",
    params: { sessionId: "string (required)", limit: "number (default 40, max 500)" },
    returns: "{ sessionId, cursor, turn, running, records[] }",
  },
];

export function createMethods({ sessionController, webServer }, config, ctx, state) {
  const runs = new Map();
  /** sessionId → runId of the run that owns prompting on that session. */
  const prompting = new Map();
  const log = logger(ctx);

  // Host Remote methods dereference the caller signal unconditionally
  // (`signal.throwIfAborted()` in @deepseek-ai/dsh-api-session-controller), so
  // even one-shot calls must hand over a real AbortSignal rather than undefined.
  const IDLE_SIGNAL = new AbortController().signal;

  const controller = () => {
    if (!sessionController) {
      throw new RpcError(CODE.internal, "sessionController service is unavailable");
    }
    return sessionController;
  };

  // ---------------------------------------------------------------- helpers --

  function clampTimeout(value) {
    const requested = Number.isInteger(value) ? value : config.defaultTimeoutMs;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requested));
  }

  function requireText(value, key) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw badRequest(`\`${key}\` must be a non-empty string`);
    }
    return value;
  }

  function optionalString(value, key) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw badRequest(`\`${key}\` must be a string`);
    return value.trim();
  }

  function requireSessionId(value, key = "sessionId") {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw badRequest(`\`${key}\` must be a non-empty session id`);
    }
    return value.trim();
  }

  /**
   * `limit` is a positive integer or absent. Coercing a fractional or negative
   * value into "1 row" hides a caller's bug and looks like a different result
   * set, so a bad value is rejected the same way a bad `sessionId` is.
   */
  function optionalLimit(value, { max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value) || value < 1) {
      throw badRequest("`limit` must be a positive integer");
    }
    return Math.min(value, max);
  }

  /**
   * One of `allowed`, or the default when absent. Anything else is refused: a
   * typo in `mode` must not silently fall back to a different concurrency rule.
   */
  function optionalChoice(value, allowed, fallback, key) {
    const text = optionalString(value, key);
    if (!text) return fallback;
    if (!allowed.includes(text)) {
      throw badRequest(`\`${key}\` must be one of ${allowed.map((one) => `"${one}"`).join(", ")}; got "${text}"`);
    }
    return text;
  }

  /**
   * Where a new session should live: a registered workspace, or a directory.
   *
   * The Host rejects `workspaceId` + `cwd` together, so the rule is enforced here
   * first with a message a caller can act on. `config.defaultCwd` is a fallback for
   * the directory case only — it must not collide with a workspace the caller named.
   */
  function createTarget(params = {}) {
    const workspaceId = optionalString(params.workspaceId, "workspaceId");
    const explicitCwd = optionalString(params.cwd, "cwd");
    if (workspaceId && explicitCwd) {
      throw badRequest("`workspaceId` and `cwd` cannot be combined; name one of them");
    }
    return { workspaceId, cwd: workspaceId ? "" : explicitCwd || config.defaultCwd };
  }

  /**
   * Create a session.
   *
   * The Host resolves its own project directory when the request names no `cwd`
   * (`workspace?.path ?? request.cwd ?? this.defaultCwd`), so this never
   * substitutes `process.cwd()`: that is the Harness profile directory, not a
   * workspace the user chose. The resolved directory is read back from the Host
   * instead of being guessed, because `create` returns only an id.
   *
   * A `workspaceId` makes the Host attach the session to that workspace
   * (`workspace.attachSession`), which is what puts it under that workspace in the
   * sidebar — a plain `cwd` only sets the directory.
   */
  async function createSession(params = {}) {
    // Session ids are the Host's to assign. Accepting one here and then quietly
    // returning a different id would read like the request had been honoured — the
    // one failure mode a caller cannot detect from the reply.
    if (optionalString(params.sessionId, "sessionId")) {
      throw badRequest(
        "`sessionId` is assigned by the Host: drop it to create a new session, or pass it to dsh.sessions.ask to continue an existing one",
      );
    }
    const { workspaceId, cwd } = createTarget(params);
    const preset = optionalString(params.agentPreset, "agentPreset") || config.defaultAgentPreset;
    const request = {};
    if (workspaceId) request.workspaceId = workspaceId;
    if (cwd) request.cwd = cwd;
    if (preset) request.agentPreset = preset;
    const value = await controller().create(request);
    const sessionId = value?.sessionId;
    const applied = await applySessionOptions(sessionId, params);
    return {
      sessionId,
      agentPreset: value?.agentPreset ?? (preset || null),
      cwd: await inspectCwd(sessionId),
      ...applied,
    };
  }

  /** Read back the directory the Host attached to a session, without activating it. */
  async function inspectCwd(sessionId) {
    if (!sessionId) return null;
    try {
      const inspection = await controller().inspect(sessionId, IDLE_SIGNAL);
      const cwd = inspection?.meta?.cwd;
      return typeof cwd === "string" ? cwd : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------- model, effort, permission --

  /**
   * A bare model id is accepted when exactly one provider offers it; `provider/id`
   * always works. Ambiguity is reported with the spellings that would resolve it,
   * because picking one silently would send the caller's turn to a different
   * provider than the one they had in mind.
   */
  async function resolveModel(model) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
    }
    const catalog = await controller().modelCatalog();
    const hits = [];
    for (const group of catalog?.groups ?? []) {
      for (const entry of group.models ?? []) {
        if (entry?.id === model) hits.push({ provider: group.id, model: entry.id });
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      throw badRequest(`unknown model "${model}"; call dsh.models for the routable ids`);
    }
    throw badRequest(
      `model "${model}" is offered by ${hits.map((hit) => hit.provider).join(", ")}; spell it "provider/${model}"`,
    );
  }

  /**
   * Model and permission belong to the Session, not to the create request, so they
   * are installed right after creation (or before the next prompt) through the
   * Host's own setters — the bridge invents no knobs of its own.
   *
   * `selectModel` also saves the choice as the profile default in the background.
   * That is the Host's own behaviour for a model switch, and it means a caller who
   * sets a model here changes what the next GUI session starts with. Documented
   * rather than hidden.
   */
  async function applySessionOptions(sessionId, params = {}) {
    const applied = {};
    const model = optionalString(params.model, "model");
    const effort = optionalString(params.reasoningEffort, "reasoningEffort");
    const permissionPreset = optionalString(params.permissionPreset, "permissionPreset");

    if (model) {
      const target = await resolveModel(model);
      const value = await controller().selectModel({
        sessionId,
        provider: target.provider,
        model: target.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      applied.selected = value?.selected ?? { ...target, ...(effort ? { reasoningEffort: effort } : {}) };
    } else if (effort) {
      // The Host setter takes a full selection; without a model there is nothing
      // to attach the effort to, and reading the session's current model back is
      // not exposed. Refuse with the reason instead of guessing.
      throw badRequest("`reasoningEffort` needs `model` in the same request");
    }

    if (permissionPreset) {
      applied.permissionPreset = await applyPermissionPreset(sessionId, permissionPreset);
    }
    return applied;
  }

  function permissionPresets() {
    const service = ctx.get?.("permissionPresets");
    if (!service) {
      throw new RpcError(
        CODE.server,
        "this Harness deployment exposes no permissionPresets service, so `permissionPreset` cannot be applied",
      );
    }
    return service;
  }

  /** The Host's preset setter wants the live Session object, not an id. */
  async function liveSession(sessionId) {
    const sessions = ctx.get?.("sessions");
    const known = sessions?.get?.(sessionId);
    if (known) return known;
    // A cold Session has no live object until something admits it. `resolveAgent`
    // is the same admission path `prompt` uses, so the preset lands on the Session
    // the next turn will actually run in.
    await controller().resolveAgent(sessionId).then((result) => {
      if (result?.error) throw result.error;
    });
    const resumed = ctx.get?.("sessions")?.get?.(sessionId);
    if (!resumed) {
      throw new RpcError(CODE.server, `session ${sessionId} is still not live after resuming`);
    }
    return resumed;
  }

  async function applyPermissionPreset(sessionId, name) {
    const service = permissionPresets();
    // `catalog` is declared as a plain method, but it is a Remote-eligible call:
    // awaiting covers both a synchronous return and a promise without caring.
    const catalog = await service.catalog?.();
    const known = (catalog?.options ?? []).map((option) => option.value);
    if (known.length > 0 && !known.includes(name)) {
      throw badRequest(
        `unknown permission preset "${name}"; available: ${known.join(", ")} — after a sandbox denial, ` +
          `"${ESCALATION_PRESET}" is the one documented escalation`,
      );
    }
    const session = await liveSession(sessionId);
    service.set(session, name);
    return name;
  }

  /**
   * Internal call options (progress callback, abort signal) travel on a separate
   * channel from user params, so a JSON-RPC caller cannot inject them by naming
   * them in `params`.
   */
  function internalContext(context) {
    return {
      onEvent: typeof context?.onEvent === "function" ? context.onEvent : null,
      signal: context?.signal instanceof AbortSignal ? context.signal : null,
    };
  }

  // ------------------------------------------------------------------ drive --

  /**
   * Resolve when `done` settles, or fail once the caller's remaining budget runs
   * out. Used while waiting for another run to release a session, so that a stuck
   * holder cannot turn into a hung caller: the waiter's own deadline still governs.
   */
  function settleOrDeadline(done, remainingMs, signal, sessionId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      };
      const timer = setTimeout(
        () =>
          finish(
            reject,
            new RpcError(
              CODE.timeout,
              `session ${sessionId} stayed busy for the whole ${remainingMs}ms wait; the run holding it never finished`,
              { sessionId },
            ),
          ),
        remainingMs,
      );
      timer.unref?.();
      const onAbort = () =>
        finish(reject, new RpcError(CODE.cancelled, "waiting for the session was cancelled", { sessionId }));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      done.then(() => finish(resolve), () => finish(resolve));
    });
  }

  /**
   * Take the prompting slot for a session, waiting for whoever holds it.
   *
   * Attribution needs one prompting run per session at a time, so a second prompt
   * is refused by default. `queue: true` opts into waiting instead — in arrival
   * order, bounded by the waiter's own deadline.
   *
   * Taking is fused with waiting on purpose. A separate "wait, then install" pair
   * lets two waiters wake on the same release, both observe an empty slot, and
   * both install themselves — the double-prompt state this whole mechanism exists
   * to prevent. Here the check and the install happen in one synchronous turn, so
   * a second waiter always sees the first one's slot and keeps waiting.
   */
  async function takePromptSlot(sessionId, deadlineAt, signal, runId) {
    for (;;) {
      const holder = prompting.get(sessionId);
      if (holder === undefined) {
        const slot = { runId, done: null, finish: null };
        slot.done = new Promise((resolve) => {
          slot.finish = resolve;
        });
        prompting.set(sessionId, slot);
        return slot;
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw new RpcError(CODE.timeout, `session ${sessionId} is still busy; gave up waiting for its turn`, {
          sessionId,
        });
      }
      await settleOrDeadline(holder.done, remaining, signal, sessionId);
    }
  }

  /**
   * Open the follow stream, optionally admit a prompt, and consume events until
   * the target turn ends. Returns a plain result object; `onEvent` receives the
   * kept events for live progress.
   */
  async function drive(sessionId, options = {}) {
    const {
      text = null,
      mode = "queue",
      queue = false,
      timeoutMs,
      onEvent = null,
      maxRecords = 128,
      signal = null,
      since = null,
    } = options;

    // The Host understands two modes (`steer` / `queue`). `turn` is this
    // bridge's own rule — decided from the live baseline below — so it is
    // translated here and never forwarded.
    const hostMode = mode === "steer" ? "steer" : "queue";

    // `since` is a caller's previous cursor: return only what is newer. Absent or
    // malformed values mean "everything this run collected", never an error — a
    // stale cursor must not break a wait.
    const sinceCursor = Number.isInteger(since) && since >= 0 ? since : null;

    if (runs.size >= config.maxSessions) {
      throw new RpcError(CODE.busy, `too many concurrent bridge runs (limit ${config.maxSessions})`);
    }

    const deadlineMs = clampTimeout(timeoutMs);
    const ac = new AbortController();
    const runId = `run-${randomUUID()}`;
    const startedAt = Date.now();
    const deadlineAt = startedAt + deadlineMs;

    // Turn attribution is only sound while this bridge owns the only prompt in
    // flight on the session. A second prompting run would compute the same
    // `baseline + 1` target and could return the first run's answer, so it either
    // waits for the slot (`queue: true`) or is refused. Waiting runs
    // (`text === null`) may attach to a session another caller is driving.
    //
    // The registry entry is written before waiting so a queued run is visible in
    // `ping` instead of looking like it never arrived.
    let slot = null;
    runs.set(runId, { sessionId, startedAt, prompt: text !== null, state: text === null ? "running" : "queued" });
    try {
      if (text !== null) {
        // Refuse before waiting: the busy message names the three ways out, and a
        // caller who did not opt into queueing should not wait at all.
        if (!queue && prompting.has(sessionId)) {
          throw new RpcError(
            CODE.busy,
            `session ${sessionId} already has a bridge run waiting for its turn; pass \`queue: true\` to wait for it, use dsh.sessions.wait, or pick a different sessionId`,
            { sessionId },
          );
        }
        slot = await takePromptSlot(sessionId, deadlineAt, signal, runId);
        runs.get(runId).state = "running";
      }
    } catch (error) {
      runs.delete(runId);
      throw error;
    }

    let timer = null;
    let iterator = null;
    let timedOut = false;

    const abortWithTimeout = () => {
      timedOut = true;
      ac.abort(Object.assign(new Error("dsh-rpc: timed out"), { name: "TimeoutError" }));
    };

    // Only turn-scoped events are retained: a long session would otherwise grow
    // the buffer without bound, and everything else is irrelevant to the result.
    const kept = [];
    // The cursor is the highest event sequence this run has seen. It is tracked
    // here rather than derived from `kept` because `kept` is capped and `since`
    // must stay monotonic even when old events are dropped.
    let cursor = -1;
    const keep = (event) => {
      if (!event || typeof event !== "object") return;
      const seq = num(event.seq);
      if (seq !== undefined) cursor = Math.max(cursor, seq);
      kept.push(event);
      if (kept.length > 4000) kept.splice(0, kept.length - 4000);
    };

    // Everything `finalize` sees: the whole turn unless the caller asked for a
    // delta. Status, turn and tools keep describing the turn; only the text is
    // narrowed to what happened after `since` — which is why `finalize` also
    // receives the unfiltered `kept` (see `allEvents`): a delta must not hide a
    // tool call it did not include, or the caller reads `tools: []` next to a
    // text that says "I ran the tests".
    const resultEvents = () =>
      sinceCursor === null ? kept : kept.filter((event) => (num(event.seq) ?? -1) > sinceCursor);
    const wholeEvents = () => (sinceCursor === null ? null : kept);

    try {
      // A caller that disconnects mid-stream should stop the wait, not leave a
      // dangling iterator holding the session's event pump open. This lives
      // inside the try on purpose: anything that can throw after the registries
      // above are written must still reach the cleanup in `finally`, otherwise a
      // session stays permanently booked as busy.
      if (signal) {
        if (signal.aborted) ac.abort(signal.reason);
        else signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
      }

      timer = setTimeout(abortWithTimeout, deadlineMs);
      // Unref on purpose: a pending bridge call must never be the reason the Host
      // process stays alive. Consequence for tests — anything that awaits this
      // deadline while nothing else holds the loop must keep its own timer alive,
      // otherwise the process exits before the deadline fires.
      if (typeof timer.unref === "function") timer.unref();

      const followRequest = {
        address: { kind: "session", sessionId },
        maxMessages: Math.min(MAX_WAIT_RECORDS, Math.max(1, maxRecords)),
      };
      iterator = controller().follow(followRequest, ac.signal)[Symbol.asyncIterator]();

      // 1. Baseline snapshot.
      let baselineTurn = 0;
      let baselineRunning = false;
      const first = await iterator.next();
      if (!first.done && first.value?.type === "snapshot") {
        const snapshot = first.value;
        const summary = summarizeRecords(snapshot.records);
        baselineTurn = summary.turn;
        baselineRunning = summary.running;
        if (typeof snapshot.cursor === "number") cursor = Math.max(cursor, snapshot.cursor);
        for (const event of summary.events) keep(event);
        onEvent?.({ type: "snapshot", cursor, turn: baselineTurn, running: baselineRunning, records: summary.events });
      } else if (!first.done && first.value?.type === "event") {
        const event = first.value.event;
        keep(event);
        if (event.type === "turn/start") {
          baselineTurn = num(event.data?.turn) ?? 0;
          baselineRunning = true;
        } else if (event.type === "turn/end") {
          baselineTurn = num(event.data?.turn) ?? 0;
          baselineRunning = false;
        }
        onEvent?.({ type: "event", event });
      }

      // 1.5 `turn` (the default mode): only into an idle session.
      //
      // Judged here, after the baseline, because "is this session running?" is the
      // Host's answer. The bridge's own slot bookkeeping (`prompting`) only sees
      // prompts this process admitted — and the case that created four sessions in
      // the field was exactly a session kept running by a previous, timed-out ask.
      // Refusing here is what turns "silently appended a follow-up message" into a
      // message the caller can act on.
      //
      // `prompting` is deliberately not consulted: this run already holds the slot
      // by now, so it would always match. A second bridge run is refused earlier,
      // before the slot is taken.
      if (text !== null && mode === "turn" && !queue && baselineRunning) {
        throw new RpcError(
          CODE.busy,
          `session ${sessionId} is already running turn ${baselineTurn}; ` +
            'pass mode:"steer" to inject into the running turn, mode:"queue" to wait for it, ' +
            "or dsh_wait({ session_id }) to collect it",
          { sessionId, turn: baselineTurn, next: { tool: "dsh_wait", args: { session_id: sessionId } } },
        );
      }

      // 2. Admit the prompt (or pick the turn already in flight).
      let targetTurn = null;
      let requestId = null;
      if (text !== null) {
        requestId = `rpc-${randomUUID()}`;
        await controller().prompt(
          {
            requestId,
            sessionId,
            mode: hostMode,
            content: [{ type: "text", text }],
          },
          ac.signal,
        );
        targetTurn = hostMode === "steer" && baselineRunning ? baselineTurn : baselineTurn + 1;
        if (targetTurn < 1) targetTurn = 1;
      } else if (!baselineRunning) {
        // Nothing to wait for: report the last completed turn straight away. The
        // status still comes from that turn's own end reason, so an aborted or
        // failed last turn is not misreported as a clean completion.
        const lastEnd = findTurnEnd(kept, baselineTurn);
        return finalize({
          sessionId,
          startedAt,
          turn: baselineTurn,
          // `since` narrows the events the caller sees even when there was
          // nothing to wait for: `dsh_wait({ since })` on an idle session is how
          // a caller polls for progress without replaying the whole turn.
          events: resultEvents(),
          allEvents: wholeEvents(),
          endEvent: lastEnd,
          status: lastEnd
            ? statusFromReason(reasonForEnd(lastEnd)) ?? "unknown"
            : baselineTurn > 0
              ? "completed"
              : "idle",
          timedOut: false,
          requestId: null,
          created: false,
          cursor,
          since: sinceCursor,
        });
      } else {
        targetTurn = baselineTurn;
      }

      // 3. Consume until the target turn ends. The baseline prediction above is
      // only a guess: the event stream is authoritative. Our own prompt's
      // `user/message` carries the requestId just sent, and the Host appends it
      // inside the turn that actually consumed it, which pins the target even when
      // another request (the GUI, another agent) queued ahead of us.
      let endEvent = null;
      // A steered prompt joins the turn already in flight, so that turn is the
      // most recent start we know about even if no new `turn/start` follows.
      let lastStartTurn = baselineRunning ? baselineTurn : null;
      let attributed = false;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const frame = next.value;
        if (!frame) continue;

        if (frame.type === "assistant-stream") {
          onEvent?.({ type: "assistant-stream", frame: frame.frame });
          continue;
        }
        if (frame.type !== "event") continue;

        const event = frame.event;
        if (event.type === "turn/start") {
          const turn = num(event.data?.turn);
          if (turn !== undefined) {
            lastStartTurn = turn;
            // Before attribution, a single-step drift means the prompt was admitted
            // one turn later than predicted. A bigger jump would risk reporting
            // someone else's turn as this call's answer, so it is left to the
            // deadline instead of being adopted silently.
            if (
              !attributed &&
              targetTurn !== null &&
              turn === targetTurn + 1 &&
              !hasAnswerFor(kept, targetTurn)
            ) {
              targetTurn = turn;
            }
          }
        } else if (event.type === "user/message" && !attributed && requestId !== null) {
          if (event.data?.source?.rpcId === requestId) {
            const turn = lastStartTurn ?? targetTurn;
            if (turn !== undefined && turn !== null) targetTurn = turn;
            attributed = true;
          }
        }
        keep(event);
        onEvent?.({ type: "event", event });

        if (event.type === "turn/end") {
          const turn = num(event.data?.turn);
          if (turn !== undefined && targetTurn !== null && turn < targetTurn) continue;
          // A prompting run must not accept a turn it never saw its own prompt
          // inside: that turn belongs to whoever typed first (the GUI, another
          // agent). Attribution is the gate, so a turn that ends before our
          // `user/message` shows up is somebody else's.
          if (requestId !== null && !attributed) continue;
          endEvent = event;
          break;
        }
      }

      // An aborted follow stream may simply end instead of throwing, so the
      // deadline is authoritative here rather than the iterator's exit reason.
      return finalize({
        sessionId,
        startedAt,
        turn: targetTurn ?? baselineTurn,
        events: resultEvents(),
        allEvents: wholeEvents(),
        endEvent,
        status: timedOut ? "timeout" : null,
        timedOut,
        requestId,
        created: false,
        cursor,
        since: sinceCursor,
      });
    } catch (error) {
      if (timedOut) {
        return finalize({
          sessionId,
          startedAt,
          turn: maxTurn(kept) || null,
          events: resultEvents(),
          allEvents: wholeEvents(),
          endEvent: null,
          status: "timeout",
          timedOut: true,
          requestId: null,
          created: false,
          cursor,
          since: sinceCursor,
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      // Registered per run, not per session: two waits may legitimately attach to
      // one session, and a session-keyed entry would let them overwrite each other
      // (undercounting `activeRuns` and letting the concurrency cap drift).
      runs.delete(runId);
      if (prompting.get(sessionId)?.runId === runId) prompting.delete(sessionId);
      // Wake whoever is queued behind this run — including a run that is failing,
      // since the slot is free either way.
      slot?.finish();
      if (iterator && typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch {
          // The stream may already be torn down by the abort; disposing twice is
          // not an error worth surfacing to the caller.
        }
      }
    }
  }

  /**
   * Submit a prompt without waiting for the turn: the caller gets a handle and
   * collects the answer later with `wait`/`history`. This is the shape an outer
   * agent needs when its own tool-call budget is shorter than the work.
   *
   * `guard` is what separates the two callers: `ask({wait:false})` refuses a
   * session already running a turn (the caller asked for *this* prompt's answer,
   * and silently joining another turn would hand back somebody else's work),
   * while `dsh.sessions.prompt` has always been a pure fire-and-forget and keeps
   * that behaviour. One body, one place to change, one explicit difference.
   *
   * Deliberately does NOT take the `prompting` slot: that map tracks *bridge
   * runs waiting for a turn*, and there is nothing to wait for here. The
   * consequence is a millisecond-wide window in which two calls on one session
   * can both pass the busy check; `list()` is the cheapest honest check
   * available and 0.5.0's sticky-session registry will close it.
   */
  async function submitPrompt(sessionId, text, mode, extra, { guard = true } = {}) {
    const { items = [] } = (await controller().list({}, IDLE_SIGNAL)) ?? {};
    const listed = items.find((item) => item.sessionId === sessionId);
    if (guard && listed?.running && mode !== "steer") {
      throw new RpcError(
        CODE.busy,
        `session ${sessionId} is already running a turn; pass wait:true to follow it, mode:"steer" to join it, or a different sessionId`,
        { sessionId, next: { tool: "dsh_wait", args: { session_id: sessionId } } },
      );
    }
    const requestId = `rpc-${randomUUID()}`;
    // Same translation as `drive()`: the Host only knows steer/queue.
    const hostMode = mode === "steer" ? "steer" : "queue";
    await controller().prompt({ requestId, sessionId, mode: hostMode, content: [{ type: "text", text }] }, IDLE_SIGNAL);
    // `list()` items carry neither a turn number nor a cursor, and no event has
    // been seen yet: report `turn: null` rather than a guess and omit `cursor`
    // instead of inventing one. The first `wait` learns both from the stream,
    // and a caller that only wants the new turn needs no `since` for that.
    return {
      sessionId,
      requestId,
      mode,
      status: "running",
      turn: null,
      text: "",
      accepted: true,
      created: false,
      ...extra,
    };
  }

  const startOnly = (sessionId, text, mode, extra) => submitPrompt(sessionId, text, mode, extra);

  function finalize({ sessionId, startedAt, turn, events, allEvents = null, endEvent, status, timedOut, requestId, created, cursor, since = null }) {
    const effectiveTurn = turn ?? maxTurn(allEvents ?? events);
    const collected = collectTurn(events, effectiveTurn);
    // A delta answer still has to describe the whole turn: `tools`/`usage`/
    // `sandbox` come from the unfiltered events, only the prose is narrowed.
    const whole = allEvents ? collectTurn(allEvents, effectiveTurn) : collected;
    // A wait that expires has no `turn/end` to quote, and leaving `reason` null
    // was half the reason a live turn looked like a silent failure: the caller
    // got "timeout" with nothing else. The turn genuinely has not ended, so say
    // exactly that. `status` is already passed explicitly on those paths, so this
    // reason never feeds `statusFromReason()`.
    // A `turn/end` that carries no reason used to fall through to `"completed"`:
    // the union says the field is required, but a union is a type, not a runtime
    // guard. An ending nobody recorded is unverified, not successful.
    const reason =
      reasonForEnd(endEvent) ??
      (timedOut
        ? { kind: "timeout", message: "the turn had not finished when the wait budget expired; it keeps running" }
        : null);
    const resolvedStatus = status ?? statusFromReason(reason) ?? (endEvent ? "completed" : "unknown");
    const sandbox = sandboxDenial(whole);
    const result = {
      sessionId,
      turn: effectiveTurn,
      status: resolvedStatus,
      reason: reason ? safeJson(reason) : null,
      // The stream can close before `turn/end` arrives (Host teardown, a dropped
      // subscription). The text collected so far is then a prefix, not an answer —
      // say so instead of letting a truncated reply look complete.
      partial: endEvent === null && !timedOut && resolvedStatus === "unknown",
      text: collected.text,
      reasoning: collected.reasoning || undefined,
      tools: whole.tools,
      usage: whole.usage ?? undefined,
      durationMs: Date.now() - startedAt,
      timedOut,
      requestId,
      created,
      cursor: cursor ?? -1,
      turnStartedAt: whole.startedAt ?? null,
    };
    // Echo the cursor the caller asked to start from, so a delta result is
    // self-describing: `since` < the events below <= `cursor`.
    if (since !== null) result.since = since;
    if (sandbox.denied) {
      // A sandbox refusal is not an error: the turn ran, the agent answered, and
      // one specific action was blocked. The bridge reports it as a fact plus the
      // one documented way out, instead of leaving the caller to guess between
      // "retry the same thing" and "start over somewhere else".
      result.sandbox = sandbox;
      result.next = {
        tool: "dsh_ask",
        reason:
          "The turn was blocked by the DSH sandbox. The documented escalation is a single retry with full access, in this same session.",
        args: { session_id: sessionId, permission: ESCALATION_PRESET },
      };
    }
    return result;
  }

  // ---------------------------------------------------------------- methods --

  return {
    context: { runs },

    async discover() {
      return {
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        protocol: PROTOCOL_VERSION,
        transport: {
          rpc: `${config.path} (POST, JSON-RPC 2.0)`,
          stream: `${config.path}/stream (POST, application/x-ndjson)`,
          health: `${config.path}/health (GET, unauthenticated)`,
          auth: "Authorization: Bearer <token> (or X-DSH-RPC-Token)",
        },
        methods: METHOD_CATALOG,
      };
    },

    async ping() {
      return {
        ok: true,
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        protocol: PROTOCOL_VERSION,
        origin: originOf(webServer),
        pid: process.pid,
        node: process.version,
        uptimeMs: Math.round(process.uptime() * 1000),
        config: describeConfig(config),
        state: {
          tokenSource: state?.tokenSource ?? "unknown",
          tokenPath: state?.tokenPath ?? null,
          endpointPath: state?.endpointPath ?? null,
        },
        activeRuns: [...runs.entries()].map(([runId, run]) => ({
          sessionId: run.sessionId,
          runId,
          prompt: run.prompt,
          state: run.state,
          ageMs: Date.now() - run.startedAt,
        })),
      };
    },

    async models() {
      const catalog = await controller().modelCatalog();
      return {
        default: catalog?.default ?? null,
        routableProviders: catalog?.routableProviders ?? [],
        groups: catalog?.groups ?? [],
        failures: catalog?.failures ?? [],
      };
    },

    /**
     * The workspaces the Host shows in its sidebar. Only `list()` is a pure
     * projection; `status()` touches the filesystem, so a workspace whose
     * directory vanished reports `missing-dir` instead of failing the whole call.
     */
    async listWorkspaces() {
      const registry = ctx.get?.("workspaceRegistry");
      if (!registry) {
        throw new RpcError(
          CODE.server,
          "this Harness deployment exposes no workspaceRegistry service, so workspaces cannot be listed",
        );
      }
      const items = [];
      for (const workspace of registry.list()) {
        let status = "unknown";
        try {
          status = await workspace.status();
        } catch {
          status = "unknown";
        }
        items.push({
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
          status,
          sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
          createdAt: workspace.createdAt ?? null,
          updatedAt: workspace.updatedAt ?? null,
        });
      }
      return { total: items.length, items };
    },

    /**
     * Register a directory as a workspace. The registry canonicalizes through
     * `fs.realpath` and reuses an existing record for the same canonical path, so
     * this is safe to call before every session a caller wants to pin somewhere.
     */
    async createWorkspace(params = {}) {
      const path = requireText(params.path, "path");
      const title = optionalString(params.title, "title");
      const registry = ctx.get?.("workspaceRegistry");
      if (!registry) {
        throw new RpcError(
          CODE.server,
          "this Harness deployment exposes no workspaceRegistry service, so workspaces cannot be created",
        );
      }
      const workspace = await registry.create(path, title || undefined);
      return { id: workspace.id, title: workspace.title, path: workspace.path };
    },

    /**
     * The permission postures this deployment offers. Each preset is a sandbox
     * mode plus an approval policy; a caller picks one by name rather than
     * inventing knob combinations the deployment never declared.
     */
    async permissionCatalog() {
      const service = permissionPresets();
      const catalog = (await service.catalog?.()) ?? {};
      return {
        defaultPreset: catalog.defaultPreset ?? null,
        options: (Array.isArray(catalog.options) ? catalog.options : []).map((option) => ({
          value: option.value,
          name: option.name,
          description: option.description ?? null,
          // `description` comes from the deployment and is frequently null; the
          // cost sentence is the bridge's own, so a caller can tell the presets
          // apart even when the deployment declared none.
          cost: PRESET_COST[option.value] ?? null,
        })),
        defaultOptions: (Array.isArray(catalog.defaultOptions) ? catalog.defaultOptions : []).map(
          (option) => option.value,
        ),
      };
    },

    async configure(params = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const applied = await applySessionOptions(sessionId, params);
      if (Object.keys(applied).length === 0) {
        throw badRequest("nothing to configure: pass `model`, `reasoningEffort` or `permissionPreset`");
      }
      return { sessionId, ...applied };
    },

    async listSessions(params = {}) {
      const limit = optionalLimit(params.limit, { fallback: 50 });
      const cwd = optionalString(params.cwd, "cwd");
      const sort = optionalChoice(params.sort, ["updatedAt", "createdAt"], "updatedAt", "sort");
      const value = await controller().list({}, IDLE_SIGNAL);
      const all = Array.isArray(value?.items) ? value.items : [];
      // `cwd` is a prefix: a caller looking for "the sessions under this project"
      // should not have to enumerate every subdirectory it ever ran in.
      const scoped = cwd ? all.filter((item) => withinPath(item?.cwd, cwd)) : all;
      const sorted = [...scoped].sort((a, b) => timeOfItem(b, sort) - timeOfItem(a, sort));
      return {
        total: sorted.length,
        sort,
        cwd: cwd ?? null,
        items: sorted.slice(0, limit).map((item) => ({
          sessionId: item.sessionId,
          running: Boolean(item.running),
          blank: Boolean(item.blank),
          agentAvailable: item.agentAvailable !== false,
          updatedAt: item.updatedAt ?? null,
          createdAt: item.createdAt ?? null,
          cwd: item.cwd ?? null,
          agentPreset: item.projections?.agentPreset ?? null,
          origin: item.origin ?? null,
          parentSessionId: item.parentSessionId ?? null,
        })),
      };
    },

    async createSession(params = {}) {
      return createSession(params);
    },

    async ask(params = {}, context = {}) {
      const text = requireText(params.text, "text");
      const mode = optionalChoice(params.mode, ASK_MODES, "turn", "mode");
      const reuse = optionalChoice(params.reuse, REUSE_MODES, "auto", "reuse");
      const project = optionalString(params.project, "project");
      const namespace = optionalString(params.namespace, "namespace");
      let sessionId = optionalString(params.sessionId, "sessionId");
      let created = false;
      let reused = false;
      let rotated = false;
      let previousSessionId = null;
      let resolvedCwd = null;
      let applied = {};
      let stickyKey = null;
      if (!sessionId) {
        const { workspaceId, cwd } = createTarget(params);
        // A workspace is a better scope than its directory when both exist: two
        // checkouts of one workspace should land in one session.
        stickyKey = reuse === "never" ? null : registryKey({ namespace, project, cwd: workspaceId ? `workspace:${workspaceId}` : cwd });
        const entry = stickyKey ? await lookupEntry(stickyKey) : null;
        // "Does this session still exist, and is it still empty?" is the Host's
        // answer, not the registry's: a session can be deleted between calls.
        const listed = entry ? (await controller().list({}, IDLE_SIGNAL))?.items?.find((item) => item?.sessionId === entry.sessionId) : null;
        if (listed && !listed.blank) {
          if (Number.isInteger(entry.asks) && entry.asks >= ROTATE_AFTER_ASKS) {
            // Long-lived sticky sessions become a context bill: this one has
            // already carried `ROTATE_AFTER_ASKS` turns from this bridge. Start a
            // fresh session and hand the old id back so nothing is lost track of.
            rotated = true;
            previousSessionId = entry.sessionId;
          } else {
            sessionId = entry.sessionId;
            reused = true;
            resolvedCwd = listed.cwd ?? entry.cwd ?? null;
          }
        }
        if (!sessionId) {
          const session = await createSession(params);
          sessionId = session.sessionId;
          resolvedCwd = session.cwd;
          created = true;
          applied = { ...(session.selected ? { selected: session.selected } : {}), ...(session.permissionPreset ? { permissionPreset: session.permissionPreset } : {}) };
        }
      } else {
        // Where a session lives, and which preset it started with, are fixed at
        // creation; naming either now would be a request this method cannot honour,
        // so it is refused instead of ignored.
        if (optionalString(params.workspaceId, "workspaceId") || optionalString(params.cwd, "cwd")) {
          throw badRequest(
            "`workspaceId` and `cwd` only apply when the session is created; drop `sessionId` to start a new one in that location",
          );
        }
        if (optionalString(params.agentPreset, "agentPreset")) {
          throw badRequest(
            "`agentPreset` only applies when the session is created; drop `sessionId` to start a new one with that preset",
          );
        }
        applied = await applySessionOptions(sessionId, params);
        // An explicit id becomes a sticky decision only when the caller also names
        // the scope (`project`): the directory of an existing session may be
        // unrelated to what the caller is working on, and guessing it would enroll
        // the session into the wrong bucket.
        if (reuse !== "never" && project) {
          stickyKey = registryKey({ namespace, project, cwd: null });
        }
      }
      const remember = async () => {
        if (!stickyKey) return;
        await rememberEntry(stickyKey, {
          sessionId,
          project: project ?? null,
          cwd: resolvedCwd,
          previousSessionId: rotated ? previousSessionId : null,
        }).catch(() => {
          // Losing the shortcut must never fail the call: the session is already
          // created and the answer is already on its way.
        });
      };
      const { onEvent, signal } = internalContext(context);
      const extra = {
        created,
        cwd: resolvedCwd,
        ...(reused ? { reused: true } : {}),
        ...(rotated ? { rotated: true, previousSessionId } : {}),
        ...applied,
      };
      // Non-blocking shape: hand back a handle in milliseconds. The RPC default
      // stays `wait: true` — a protocol method keeps its shape across minor
      // versions; the *MCP tool* is where 0.5.0 flips the default to the handle,
      // because that is the surface an outer agent's tool budget applies to.
      if (params.wait === false) {
        // `queue` means "wait for the session to free its turn"; with `wait:false`
        // nothing waits, so honouring it would be a lie and ignoring it would be
        // a silent no-op. Refuse, and let the caller pick one of the two.
        if (params.queue === true || mode === "queue") {
          throw badRequest("`queue` has no meaning with `wait: false`: nothing is waited for; use wait:true, or mode:\"steer\"");
        }
        const handle = await startOnly(sessionId, text, mode, extra);
        await remember();
        log.info?.(`[dsh-rpc] ask ${sessionId} -> accepted without waiting (${handle.requestId})`);
        return handle;
      }
      const result = await drive(sessionId, {
        text,
        mode,
        queue: params.queue === true,
        timeoutMs: params.timeoutMs,
        onEvent,
        signal,
      });
      await remember();
      log.info?.(`[dsh-rpc] ask ${sessionId} -> ${result.status} in ${result.durationMs}ms`);
      return { ...result, ...extra };
    },

    async prompt(params = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const text = requireText(params.text, "text");
      const mode = optionalChoice(params.mode, ASK_MODES, "queue", "mode");
      // `guard: false` keeps the documented fire-and-forget behaviour: `prompt`
      // has never refused a busy session, and this release is not the place to
      // change that. The code path is shared so the two cannot drift.
      const handle = await submitPrompt(sessionId, text, mode, {}, { guard: false });
      return { accepted: true, sessionId, requestId: handle.requestId, mode };
    },


    async wait(params = {}, context = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const { onEvent, signal } = internalContext(context);
      // `since` narrows the answer to what happened after the caller's last
      // cursor; the turn, status and tool list still describe the whole turn.
      return drive(sessionId, { text: null, timeoutMs: params.timeoutMs, since: params.since, onEvent, signal });
    },

    async cancel(params = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const value = await controller().cancel({ sessionId });
      return { accepted: value?.accepted !== false, sessionId };
    },

    async history(params = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const limit = optionalLimit(params.limit, { max: MAX_WAIT_RECORDS, fallback: 40 });
      const ac = new AbortController();
      const iterator = controller().follow(
        {
          address: { kind: "session", sessionId },
          maxMessages: limit,
        },
        ac.signal,
      )[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        if (first.done || first.value?.type !== "snapshot") {
          return { sessionId, cursor: -1, records: [] };
        }
        const snapshot = first.value;
        const summary = summarizeRecords(snapshot.records);
        return {
          sessionId,
          cursor: snapshot.cursor ?? -1,
          turn: summary.turn,
          running: summary.running,
          messageCount: Array.isArray(snapshot.records) ? snapshot.records.length : 0,
          hasMore: Boolean(snapshot.hasMore),
          records: summary.events.map(projectEvent),
        };
      } finally {
        try {
          await iterator.return();
        } catch {
          // ignore: snapshot-only read
        }
      }
    },
  };
}

// ------------------------------------------------------------------ sharing --

export function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Is `candidate` at or under `prefix`? Case- and separator-insensitive, because
 * the Host reports Windows paths with backslashes and callers rarely match that
 * exactly. An empty prefix matches everything; an empty candidate matches nothing
 * (a session with no directory is not "inside" the one you asked about).
 */
export function withinPath(candidate, prefix) {
  const normalize = (value) =>
    typeof value === "string" ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "";
  const inner = normalize(candidate);
  const outer = normalize(prefix);
  if (!outer) return true;
  if (!inner) return false;
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** Sort key for one `sessions.list` item; missing/unparseable times sort last. */
export function timeOfItem(item, key = "updatedAt") {
  const raw = key === "createdAt" ? item?.createdAt : item?.updatedAt;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function eventOf(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type === "event" && record.event && typeof record.event === "object") return record.event;
  if (typeof record.type === "string" && typeof record.seq === "number") return record;
  return null;
}

/** Fold the snapshot records into `{turn, running, events}`. */
export function summarizeRecords(records) {
  const events = [];
  let turn = 0;
  let running = false;
  if (!Array.isArray(records)) return { turn, running, events };
  for (const record of records) {
    const event = eventOf(record);
    if (!event) continue;
    events.push(event);
    if (event.type === "turn/start") {
      const value = num(event.data?.turn);
      if (value !== undefined && value >= turn) {
        turn = value;
        running = true;
      }
    } else if (event.type === "turn/end") {
      const value = num(event.data?.turn);
      if (value !== undefined && value >= turn) {
        turn = value;
        running = false;
      }
    }
  }
  return { turn, running, events };
}

export function maxTurn(events) {
  let turn = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const value = num(event?.data?.turn);
    if (value !== undefined && value > turn) turn = value;
  }
  return turn;
}

export function findTurnEnd(events, turn) {
  let found = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "turn/end") continue;
    const value = num(event.data?.turn);
    if (value === undefined || value === turn) found = event;
  }
  return found;
}

/** Whether the turn already produced assistant output in the events seen so far. */
export function hasAnswerFor(events, turn) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "assistant/message") continue;
    if (num(event.data?.turn) === turn) return true;
  }
  return false;
}

export function statusFromReason(reason) {
  const kind = reason?.kind;
  if (typeof kind === "string" && kind.length > 0) return kind;
  return null;
}

// An ending the Host never described. `TurnEndReason` is a union of `{ kind }`
// objects, so `reason` is required by the type — but the event crosses a process
// boundary as plain JSON and nothing validates the union at runtime. Reporting
// such a turn as `completed` is how a failed turn becomes a silent success.
const UNRECORDED_REASON = Object.freeze({
  kind: "unknown",
  message: "the Host ended the turn without a reason; treat this outcome as unverified",
});

/**
 * The reason a turn ended, or a placeholder when the Host recorded none.
 * Returns `null` only when there is no `turn/end` at all (still running).
 */
export function reasonForEnd(endEvent) {
  if (!endEvent) return null;
  const reason = endEvent.data?.reason ?? null;
  if (reason !== null && typeof reason === "object" && typeof reason.kind === "string" && reason.kind.length > 0) {
    return reason;
  }
  return UNRECORDED_REASON;
}

/**
 * Collect the assistant output for one turn: concatenated text blocks, an
 * optional reasoning trace, and the tool calls the turn made.
 */
export function collectTurn(events, turn) {
  const texts = [];
  const reasoning = [];
  const tools = [];
  let usage = null;
  let startedAt = null;
  let outputChars = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const eventTurn = num(event.data?.turn);
    if (eventTurn !== undefined && turn >= 0 && eventTurn !== turn) continue;

    if (event.type === "turn/start") {
      const started = event.time;
      if (typeof started === "number") startedAt = started;
      continue;
    }
    if (event.type === "assistant/message") {
      const message = event.data?.message;
      const text = messageText(message);
      if (text.trim().length > 0) texts.push(text);
      const thought = messageReasoning(message);
      if (thought.trim().length > 0) reasoning.push(thought);
      const reported = event.data?.usage;
      if (reported && typeof reported === "object") usage = mergeUsage(usage, reported);
      continue;
    }
    if (event.type === "tool/call") {
      tools.push({
        callId: event.data?.callId ?? null,
        name: event.data?.name ?? null,
        arguments: safeJson(event.data?.arguments) ?? null,
      });
      continue;
    }
    if (event.type === "tool/result") {
      // The Host keeps a tool's answer as a tool-role message: content blocks plus
      // `isError`. The sandbox writes its denial marker into that text, so this is
      // the one place a refusal can be read without guessing from prose.
      const message = event.data?.message;
      const callId = event.data?.callId ?? message?.toolCallId ?? null;
      const target = callId
        ? tools.findLast((tool) => tool.callId === callId)
        : tools[tools.length - 1];
      const output = messageText(message);
      if (target) {
        if (output.length > 0) {
          const room = Math.min(TOOL_OUTPUT_LIMIT, TOOL_OUTPUT_BUDGET - outputChars);
          if (room <= 0) {
            target.output = `… (omitted, ${output.length} chars: this turn's tool-output budget of ${TOOL_OUTPUT_BUDGET} is spent)`;
          } else {
            target.output = truncateText(output, room);
            outputChars += target.output.length;
          }
        }
        if (message?.isError === true) target.isError = true;
      }
      if (event.data?.error !== undefined) {
        const owner = target ?? tools[tools.length - 1];
        if (owner) owner.error = safeJson(event.data.error);
      }
      continue;
    }
  }

  return {
    text: texts.join("\n\n"),
    reasoning: reasoning.join("\n\n"),
    tools,
    usage,
    startedAt,
  };
}

/**
 * Read a sandbox refusal out of a finished turn.
 *
 * A refusal is never inferred from the assistant's prose: the Host writes a
 * fixed marker into the refused tool's output, and only that marker counts.
 * Both the tool output and the collected text are scanned so the check still
 * works on turns whose tool results the Host did not surface.
 */
export function sandboxDenial(collected) {
  const candidates = [];
  for (const tool of collected?.tools ?? []) {
    if (typeof tool?.output === "string") candidates.push({ text: tool.output, source: "tool" });
    if (tool?.error !== undefined && tool?.error !== null) {
      candidates.push({
        text: typeof tool.error === "string" ? tool.error : JSON.stringify(tool.error),
        source: "tool",
      });
    }
  }
  // The agent's own reply is the weaker source: it usually restates the refusal,
  // but it can also quote the marker while writing about it. `source` lets the
  // caller weigh that instead of the bridge pretending both are equal.
  if (typeof collected?.text === "string") candidates.push({ text: collected.text, source: "text" });

  for (const { text, source } of candidates) {
    const at = text.indexOf(SANDBOX_DENIED_MARKER);
    if (at === -1) continue;
    const rest = text.slice(at, at + 160);
    const close = rest.indexOf("]");
    return { denied: true, marker: (close === -1 ? rest : rest.slice(0, close + 1)).trim(), source };
  }
  return { denied: false };
}

function truncateText(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated, ${text.length} chars)`;
}

function messageText(message) {
  const pieces = [];
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") pieces.push(block.text);
    }
  } else if (typeof message?.text === "string") {
    pieces.push(message.text);
  }
  return pieces.join("");
}

function messageReasoning(message) {
  const pieces = [];
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "reasoning") continue;
      if (typeof block.text === "string") pieces.push(block.text);
      else if (typeof block.reasoning === "string") pieces.push(block.reasoning);
    }
  }
  return pieces.join("");
}

function mergeUsage(total, next) {
  const add = (a, b) => (typeof a === "number" || typeof b === "number" ? (a ?? 0) + (b ?? 0) : undefined);
  return {
    inputTokens: add(total?.inputTokens, next.inputTokens),
    outputTokens: add(total?.outputTokens, next.outputTokens),
    totalTokens: add(total?.totalTokens, next.totalTokens),
    cacheReadTokens: add(total?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: add(total?.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: add(total?.reasoningTokens, next.reasoningTokens),
  };
}

export function projectEvent(event) {
  if (!event || typeof event !== "object") return null;
  const data = safeJson(event.data);
  if (event.type === "assistant/message" && data?.message) {
    data.message = { content: safeJson(data.message.content) };
  }
  return {
    type: event.type,
    seq: event.seq ?? null,
    time: event.time ?? null,
    data,
  };
}

function originOf(webServer) {
  try {
    return webServer?.getOrigin?.() ?? null;
  } catch {
    return null;
  }
}

function logger(ctx) {
  const candidate = ctx?.logger;
  if (candidate && typeof candidate.info === "function") return candidate;
  if (typeof candidate === "function") {
    try {
      const scoped = candidate("dsh-rpc");
      if (scoped && typeof scoped.info === "function") return scoped;
    } catch {
      // fall through to the no-op logger
    }
  }
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}
