// 从 src/lib/methods.mts 原样搬出：末尾的纯函数（collectTurn / projectEvent / num 等）
// 只搬不改；methods.mts 仍把这些名字 re-export，外部调用点不受影响。

// Method implementations over the Host `sessionController` service.
//
// The whole bridge rests on one observation: `sessionController.follow` is an
// AsyncIterable whose first frame is a snapshot and whose later frames are live
// events. Subscribing *before* `prompt` is admitted is what makes the result
// deterministic — we know the turn baseline first, so the turn we are waiting
// for is exactly `baseline.turn + 1` (or `baseline.turn` for a steer into a
// running turn). No polling, no racing the queue.

import { createHash, randomUUID } from "node:crypto";

// sibling-imports:begin
import {
  CollectedToolCall,
  CollectedTurnResult,
  HostServiceContextLike,
  ProjectedSessionEvent,
  SANDBOX_DENIED_MARKER,
  SandboxDenial,
  TOOL_OUTPUT_BUDGET,
  TOOL_OUTPUT_LIMIT,
  TokenUsage,
  TurnEndReason,
  WebServerLike,
} from "./types.mjs";
import {
  LoggerLike,
} from "./adapter-ops.mjs";
// sibling-imports:end

import { createDshAdapter, type DshSessionOps } from "../adapters/dsh.mjs";
import {
  CONTROL_NAMES,
  capabilityRevisionId,
  hashCard,
  normalizeCard,
  withVerified,
  type ControlName,
  type NormalizedCard,
  type VerifiedCard,
} from "../agents/card.mjs";
import { createProber, type ProbeMap, type ProbeUnknownEntry } from "../agents/probe.mjs";
import {
  formatCapabilities,
  MAX_MAX_CHARS,
  normalizeSections,
  type NormalizedCapabilitySection,
} from "../capabilities.mjs";
import { describeConfig, type DescribedConfig, type ResolvedConfig } from "../config.mjs";
import { collectFacts } from "../host-facts.mjs";
import { type RpcDispatchContext } from "../http.mjs";
import { isOwnedSession, ownSession } from "../owned.mjs";
import { CODE, RpcError, badRequest } from "../protocol.mjs";
import { ROTATE_AFTER_ASKS, lookupEntry, registryKey, rememberEntry } from "../registry.mjs";
import type { PendingApprovalPacket } from "../pending.mjs";
import { createTaskEngine, type TaskDetail, type TaskEngine, type TaskEventsResult } from "../tasks/engine.mjs";
import { createDispatcher, type Dispatcher, type PumpResult, type StartTaskResult } from "../tasks/dispatch.mjs";
import { notFoundError, validationFailed } from "../tasks/errors.mjs";
import { createPreview, type CreatePreviewResult } from "../tasks/preview.mjs";
import {
  reconcileTask as applyReconcileTask,
  type ReconcileEvidence,
  type ReconcileTaskParams,
  type ReconcileTaskResult,
} from "../tasks/reconcile.mjs";
import { openStore, type AgentRow, type CapabilityRevisionRow, type TaskStore } from "../tasks/store.mjs";
import { type TaskStatus } from "../tasks/state-machine.mjs";
import { PLUGIN_NAME, PLUGIN_VERSION, PROTOCOL_VERSION } from "../version.mjs";

// ------------------------------------------------------------------ sharing --

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Is `candidate` at or under `prefix`? Case- and separator-insensitive, because
 * the Host reports Windows paths with backslashes and callers rarely match that
 * exactly. An empty prefix matches everything; an empty candidate matches nothing
 * (a session with no directory is not "inside" the one you asked about).
 */
export function withinPath(candidate: unknown, prefix: unknown): boolean {
  const normalize = (value: unknown): string =>
    typeof value === "string" ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "";
  const inner = normalize(candidate);
  const outer = normalize(prefix);
  if (!outer) return true;
  if (!inner) return false;
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** Sort key for one `sessions.list` item; missing/unparseable times sort last. */
export function timeOfItem(item: { createdAt?: unknown; updatedAt?: unknown } | null | undefined, key = "updatedAt"): number {
  const raw = key === "createdAt" ? item?.createdAt : item?.updatedAt;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function eventOf(record: unknown): Record<string, unknown> | null {
  if (!record || typeof record !== "object") return null;
  const rec = record as Record<string, unknown>;
  if (rec.type === "event" && rec.event && typeof rec.event === "object") {
    return rec.event as Record<string, unknown>;
  }
  if (typeof rec.type === "string" && typeof rec.seq === "number") return rec;
  return null;
}

/** Fold the snapshot records into `{turn, running, events}`. */
export function summarizeRecords(records: unknown): {
  turn: number;
  running: boolean;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  let turn = 0;
  let running = false;
  if (!Array.isArray(records)) return { turn, running, events };
  for (const record of records) {
    const event = eventOf(record);
    if (!event) continue;
    events.push(event);
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === "turn/start") {
      const value = num(data?.turn);
      if (value !== undefined && value >= turn) {
        turn = value;
        running = true;
      }
    } else if (event.type === "turn/end") {
      const value = num(data?.turn);
      if (value !== undefined && value >= turn) {
        turn = value;
        running = false;
      }
    }
  }
  return { turn, running, events };
}

export function maxTurn(events: unknown): number {
  let turn = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const rec = event as { data?: { turn?: unknown } } | null | undefined;
    const value = num(rec?.data?.turn);
    if (value !== undefined && value > turn) turn = value;
  }
  return turn;
}

export function findTurnEnd(events: unknown, turn: number): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const event of Array.isArray(events) ? events : []) {
    const rec = event as Record<string, unknown> | null | undefined;
    if (rec?.type !== "turn/end") continue;
    const value = num((rec.data as { turn?: unknown } | undefined)?.turn);
    if (value === undefined || value === turn) found = rec;
  }
  return found;
}

/** Whether the turn already produced assistant output in the events seen so far. */
export function hasAnswerFor(events: unknown, turn: number): boolean {
  for (const event of Array.isArray(events) ? events : []) {
    const rec = event as { type?: unknown; data?: { turn?: unknown } } | null | undefined;
    if (rec?.type !== "assistant/message") continue;
    if (num(rec.data?.turn) === turn) return true;
  }
  return false;
}

export function statusFromReason(reason: TurnEndReason | { kind?: unknown } | null | undefined): string | null {
  const kind = reason?.kind;
  if (typeof kind === "string" && kind.length > 0) return kind;
  return null;
}

// An ending the Host never described. `TurnEndReason` is a union of `{ kind }`
// objects, so `reason` is required by the type — but the event crosses a process
// boundary as plain JSON and nothing validates the union at runtime. Reporting
// such a turn as `completed` is how a failed turn becomes a silent success.
const UNRECORDED_REASON: Readonly<TurnEndReason> = Object.freeze({
  kind: "unknown",
  message: "the Host ended the turn without a reason; treat this outcome as unverified",
});

/**
 * The reason a turn ended, or a placeholder when the Host recorded none.
 * Returns `null` only when there is no `turn/end` at all (still running).
 */
export function reasonForEnd(endEvent: Record<string, unknown> | null | undefined): TurnEndReason | null {
  if (!endEvent) return null;
  const reason = (endEvent.data as { reason?: unknown } | undefined)?.reason ?? null;
  if (
    reason !== null &&
    typeof reason === "object" &&
    typeof (reason as { kind?: unknown }).kind === "string" &&
    (reason as { kind: string }).kind.length > 0
  ) {
    return reason as TurnEndReason;
  }
  return UNRECORDED_REASON;
}

/**
 * Collect the assistant output for one turn: concatenated text blocks, an
 * optional reasoning trace, and the tool calls the turn made.
 */
export function collectTurn(events: unknown, turn: number): CollectedTurnResult {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const tools: CollectedToolCall[] = [];
  let usage: TokenUsage | null = null;
  let startedAt: number | null = null;
  let outputChars = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const rec = event as Record<string, unknown>;
    const data = (rec.data && typeof rec.data === "object" ? rec.data : undefined) as Record<string, unknown> | undefined;
    const eventTurn = num(data?.turn);
    if (eventTurn !== undefined && turn >= 0 && eventTurn !== turn) continue;

    if (rec.type === "turn/start") {
      const started = rec.time;
      if (typeof started === "number") startedAt = started;
      continue;
    }
    if (rec.type === "assistant/message") {
      const message = data?.message as Record<string, unknown> | undefined;
      const text = messageText(message);
      if (text.trim().length > 0) texts.push(text);
      const thought = messageReasoning(message);
      if (thought.trim().length > 0) reasoning.push(thought);
      const reported = data?.usage;
      if (reported && typeof reported === "object") usage = mergeUsage(usage, reported as Record<string, unknown>);
      continue;
    }
    if (rec.type === "tool/call") {
      tools.push({
        callId: (data?.callId as string | null | undefined) ?? null,
        name: (data?.name as string | null | undefined) ?? null,
        arguments: safeJson(data?.arguments) ?? null,
        seq: Number.isInteger(rec.seq) ? (rec.seq as number) : null,
        at: typeof rec.time === "number" ? rec.time : null,
      });
      continue;
    }
    if (rec.type === "tool/result") {
      // The Host keeps a tool's answer as a tool-role message: content blocks plus
      // `isError`. The sandbox writes its denial marker into that text, so this is
      // the one place a refusal can be read without guessing from prose.
      const message = data?.message as Record<string, unknown> | undefined;
      const callId = data?.callId ?? message?.toolCallId ?? null;
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
        target.endedAt = typeof rec.time === "number" ? rec.time : null;
        target.ok = message?.isError !== true && data?.error === undefined;
      }
      if (data?.error !== undefined) {
        const owner = target ?? tools[tools.length - 1];
        if (owner) {
          owner.error = safeJson(data.error);
          owner.ok = false;
        }
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
export function sandboxDenial(collected: Partial<CollectedTurnResult> | null | undefined): SandboxDenial {
  const candidates: Array<{ text: string; source: "tool" | "text" }> = [];
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

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated, ${text.length} chars)`;
}

function messageText(message: Record<string, unknown> | null | undefined): string {
  const pieces: string[] = [];
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") pieces.push(b.text);
    }
  } else if (typeof message?.text === "string") {
    pieces.push(message.text);
  }
  return pieces.join("");
}

function messageReasoning(message: Record<string, unknown> | null | undefined): string {
  const pieces: string[] = [];
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "reasoning") continue;
      if (typeof b.text === "string") pieces.push(b.text);
      else if (typeof b.reasoning === "string") pieces.push(b.reasoning);
    }
  }
  return pieces.join("");
}

function mergeUsage(total: TokenUsage | null, next: Record<string, unknown>): TokenUsage {
  const add = (a: unknown, b: unknown): number | undefined =>
    typeof a === "number" || typeof b === "number" ? ((typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0)) : undefined;
  return {
    inputTokens: add(total?.inputTokens, next.inputTokens),
    outputTokens: add(total?.outputTokens, next.outputTokens),
    totalTokens: add(total?.totalTokens, next.totalTokens),
    cacheReadTokens: add(total?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: add(total?.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: add(total?.reasoningTokens, next.reasoningTokens),
  };
}

export function projectEvent(event: unknown): ProjectedSessionEvent | null {
  if (!event || typeof event !== "object") return null;
  const rec = event as Record<string, unknown>;
  const data = safeJson(rec.data) as Record<string, unknown> | null;
  if (rec.type === "assistant/message" && data?.message && typeof data.message === "object") {
    data.message = { content: safeJson((data.message as { content?: unknown }).content) };
  }
  return {
    type: rec.type as string,
    seq: (rec.seq as number | null | undefined) ?? null,
    time: (rec.time as number | null | undefined) ?? null,
    data,
  };
}

function truncateRecordStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit))}… (truncated)`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateRecordStrings(item, limit));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateRecordStrings(v, limit);
    }
    return out;
  }
  return value;
}

export function applyMaxCharsToRecords(
  records: Array<ProjectedSessionEvent | null>,
  maxChars: number,
): { records: Array<ProjectedSessionEvent | null>; truncated: boolean } {
  if (JSON.stringify(records).length <= maxChars) {
    return { records, truncated: false };
  }
  const kept: Array<ProjectedSessionEvent | null> = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    // Loop bounds guarantee 0 <= i < records.length.
    const rec = records[i] as ProjectedSessionEvent | null;
    const candidate = [rec, ...kept];
    if (JSON.stringify(candidate).length <= maxChars) {
      kept.unshift(rec);
    } else {
      break;
    }
  }
  if (kept.length === 0 && records.length > 0) {
    const newest = records[records.length - 1];
    // Compact string leaves in the newest record so a single oversized event still surfaces.
    for (const limit of [Math.max(16, Math.floor(maxChars / 2)), 64, 16, 0]) {
      const compact = newest
        ? {
            ...newest,
            data: truncateRecordStrings(newest.data, limit),
          }
        : null;
      if (JSON.stringify([compact]).length <= maxChars) {
        kept.push(compact);
        break;
      }
    }
  }
  return { records: kept, truncated: true };
}

export function originOf(webServer: WebServerLike | null | undefined): string | null {
  try {
    return webServer?.getOrigin?.() ?? null;
  } catch {
    return null;
  }
}

export function logger(ctx: HostServiceContextLike | null | undefined): LoggerLike {
  const candidate = ctx?.logger;
  if (candidate && typeof (candidate as LoggerLike).info === "function") return candidate as LoggerLike;
  if (typeof candidate === "function") {
    try {
      const scoped = (candidate as (name: string) => unknown)("dsh-rpc");
      if (scoped && typeof (scoped as LoggerLike).info === "function") return scoped as LoggerLike;
    } catch {
      // fall through to the no-op logger
    }
  }
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

