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
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "./version.mjs";

const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_WAIT_RECORDS = 500;

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
    name: "dsh.sessions.list",
    summary: "List Harness sessions visible to the Host, newest first as the Host orders them.",
    params: { limit: "number (default 50)" },
    returns: "{ total, items: SessionSummary[] }",
  },
  {
    name: "dsh.sessions.create",
    summary: "Create a blank session without prompting it.",
    params: { cwd: "string (optional)", agentPreset: "string (optional)" },
    returns: "{ sessionId, agentPreset, cwd }",
  },
  {
    name: "dsh.sessions.ask",
    summary:
      "Create (or reuse) a session, submit one prompt, and wait for that turn to finish. Returns the assistant text plus tool calls, usage and the turn-end reason.",
    params: {
      text: "string (required)",
      sessionId: "string (optional; omit to create a fresh session)",
      cwd: "string (optional)",
      agentPreset: "string (optional)",
      mode: "'queue' | 'steer' (default 'queue')",
      timeoutMs: "number (default 600000, max 3600000)",
    },
    returns:
      "{ sessionId, turn, status, reason, text, reasoning?, tools[], usage?, durationMs, timedOut, created }",
  },
  {
    name: "dsh.sessions.prompt",
    summary: "Submit a prompt without waiting for the turn to finish (fire and forget).",
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
   * Create a session.
   *
   * The Host resolves its own project directory when the request names no
   * `cwd` (`workspace?.path ?? request.cwd ?? this.defaultCwd`), so this never
   * substitutes `process.cwd()`: that is the Harness profile directory, not a
   * workspace the user chose. The resolved directory is read back from the Host
   * instead of being guessed, because `create` returns only an id.
   */
  async function createSession(params = {}) {
    const cwd = optionalString(params.cwd, "cwd") || config.defaultCwd;
    const preset = optionalString(params.agentPreset, "agentPreset") || config.defaultAgentPreset;
    const request = {};
    if (cwd) request.cwd = cwd;
    if (preset) request.agentPreset = preset;
    const value = await controller().create(request);
    const sessionId = value?.sessionId;
    return {
      sessionId,
      agentPreset: value?.agentPreset ?? (preset || null),
      cwd: await inspectCwd(sessionId),
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
   * Open the follow stream, optionally admit a prompt, and consume events until
   * the target turn ends. Returns a plain result object; `onEvent` receives the
   * kept events for live progress.
   */
  async function drive(sessionId, options = {}) {
    const {
      text = null,
      mode = "queue",
      timeoutMs,
      onEvent = null,
      maxRecords = 128,
      signal = null,
    } = options;

    if (runs.size >= config.maxSessions) {
      throw new RpcError(CODE.busy, `too many concurrent bridge runs (limit ${config.maxSessions})`);
    }

    const deadlineMs = clampTimeout(timeoutMs);
    const ac = new AbortController();
    const runId = `run-${randomUUID()}`;
    const startedAt = Date.now();

    // Turn attribution is only sound while this bridge owns the only prompt in
    // flight on the session. A second prompting run would compute the same
    // `baseline + 1` target and could return the first run's answer, so it is
    // refused rather than silently mis-attributed. Waiting runs (`text === null`)
    // may still attach to a session another caller is driving.
    if (text !== null) {
      const holder = prompting.get(sessionId);
      if (holder !== undefined && holder !== runId) {
        throw new RpcError(
          CODE.busy,
          `session ${sessionId} already has a bridge run waiting for its turn; use dsh.sessions.wait, or a different sessionId`,
          { sessionId },
        );
      }
      prompting.set(sessionId, runId);
    }

    runs.set(runId, { sessionId, startedAt, prompt: text !== null });

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
    const keep = (event) => {
      if (!event || typeof event !== "object") return;
      kept.push(event);
      if (kept.length > 4000) kept.splice(0, kept.length - 4000);
    };

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
      let cursor = -1;
      const first = await iterator.next();
      if (!first.done && first.value?.type === "snapshot") {
        const snapshot = first.value;
        const summary = summarizeRecords(snapshot.records);
        baselineTurn = summary.turn;
        baselineRunning = summary.running;
        cursor = typeof snapshot.cursor === "number" ? snapshot.cursor : -1;
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

      // 2. Admit the prompt (or pick the turn already in flight).
      let targetTurn = null;
      let requestId = null;
      if (text !== null) {
        requestId = `rpc-${randomUUID()}`;
        await controller().prompt(
          {
            requestId,
            sessionId,
            mode,
            content: [{ type: "text", text }],
          },
          ac.signal,
        );
        targetTurn = mode === "steer" && baselineRunning ? baselineTurn : baselineTurn + 1;
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
          events: kept,
          endEvent: lastEnd,
          status: lastEnd
            ? statusFromReason(lastEnd.data?.reason) ?? "completed"
            : baselineTurn > 0
              ? "completed"
              : "idle",
          timedOut: false,
          requestId: null,
          created: false,
          cursor,
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
        events: kept,
        endEvent,
        status: timedOut ? "timeout" : null,
        timedOut,
        requestId,
        created: false,
        cursor,
      });
    } catch (error) {
      if (timedOut) {
        return finalize({
          sessionId,
          startedAt,
          turn: null,
          events: kept,
          endEvent: null,
          status: "timeout",
          timedOut: true,
          requestId: null,
          created: false,
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      // Registered per run, not per session: two waits may legitimately attach to
      // one session, and a session-keyed entry would let them overwrite each other
      // (undercounting `activeRuns` and letting the concurrency cap drift).
      runs.delete(runId);
      if (prompting.get(sessionId) === runId) prompting.delete(sessionId);
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

  function finalize({ sessionId, startedAt, turn, events, endEvent, status, timedOut, requestId, created, cursor }) {
    const effectiveTurn = turn ?? maxTurn(events);
    const collected = collectTurn(events, effectiveTurn);
    const reason = endEvent?.data?.reason ?? null;
    const resolvedStatus = status ?? statusFromReason(reason) ?? (endEvent ? "completed" : "unknown");
    return {
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
      tools: collected.tools,
      usage: collected.usage ?? undefined,
      durationMs: Date.now() - startedAt,
      timedOut,
      requestId,
      created,
      cursor: cursor ?? -1,
      turnStartedAt: collected.startedAt ?? null,
    };
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

    async listSessions(params = {}) {
      const limit = optionalLimit(params.limit, { fallback: 50 });
      const value = await controller().list({}, IDLE_SIGNAL);
      const items = Array.isArray(value?.items) ? value.items : [];
      return {
        total: items.length,
        items: items.slice(0, limit).map((item) => ({
          sessionId: item.sessionId,
          running: Boolean(item.running),
          blank: Boolean(item.blank),
          agentAvailable: item.agentAvailable !== false,
          updatedAt: item.updatedAt ?? null,
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
      const mode = params.mode === "steer" ? "steer" : "queue";
      let sessionId = optionalString(params.sessionId, "sessionId");
      let created = false;
      let resolvedCwd = null;
      if (!sessionId) {
        const session = await createSession(params);
        sessionId = session.sessionId;
        resolvedCwd = session.cwd;
        created = true;
      }
      const { onEvent, signal } = internalContext(context);
      const result = await drive(sessionId, {
        text,
        mode,
        timeoutMs: params.timeoutMs,
        onEvent,
        signal,
      });
      log.info?.(`[dsh-rpc] ask ${sessionId} -> ${result.status} in ${result.durationMs}ms`);
      return { ...result, created, cwd: resolvedCwd };
    },

    async prompt(params = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const text = requireText(params.text, "text");
      const mode = params.mode === "steer" ? "steer" : "queue";
      const requestId = `rpc-${randomUUID()}`;
      await controller().prompt({ requestId, sessionId, mode, content: [{ type: "text", text }] }, IDLE_SIGNAL);
      return { accepted: true, sessionId, requestId, mode };
    },

    async wait(params = {}, context = {}) {
      const sessionId = requireSessionId(params.sessionId);
      const { onEvent, signal } = internalContext(context);
      return drive(sessionId, { text: null, timeoutMs: params.timeoutMs, onEvent, signal });
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
    if (event.type === "tool/result" && event.data?.error !== undefined) {
      const last = tools[tools.length - 1];
      if (last && last.callId === (event.data?.callId ?? last.callId)) {
        last.error = safeJson(event.data.error);
      }
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
