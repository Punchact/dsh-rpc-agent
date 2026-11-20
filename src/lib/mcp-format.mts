// How a bridge result becomes an MCP tool result.
//
// This lives outside `bin/dsh-rpc-mcp.mjs` for one reason: the rule below is the
// difference between "the caller retries" and "the caller waits", and a rule that
// important has to be testable without spawning a stdio server.
//
// The rule: a tool result is never an error just because the work is unfinished.
// `status` is a free-form string chosen by the Host — `statusFromReason()` in
// `lib/methods.mjs` returns `reason.kind` verbatim — so it can be neither
// whitelisted into "terminal" nor compared against "completed" to decide
// `isError`. What the caller needs instead is the text, what happened
// (`outcome:`), and — when the turn is still going — the one call that collects
// it. Only a failed *call* is an error, and that is `formatToolError()`.
//
// Second rule, added after auditing the Host's `TurnEndReasonMap`: every end
// reason gets a human sentence and, when there is one, a next step. A terminal
// outcome that says only `aborted` teaches the caller nothing, and "unknown" is
// not a euphemism for "completed" — it means nobody knows, and the caller has to
// check before doing anything.

import {
  describeTrace,
  normalizeTraceLevel,
  type DescribeTraceResult,
  type StructuredTraceEntry,
  type TraceLevel,
} from "./trace-format.mjs";

export const NEXT_BY_CODE = {
  "-32602": "fix the arguments named in the message and call again — retrying the same call will fail the same way",
  "-32003": "call dsh_sessions() to find the real session id",
  "-32004": "the session is busy — call dsh_wait({ session_id }) to follow the running turn instead of resending the prompt",
  "-32005": "the bridge gave up waiting for a free slot — call dsh_wait({ session_id }) or retry with a larger timeout_ms",
  "-32006": "the wait was cancelled; retry once, or use a different session_id",
  EBADPORT: "the Harness bound a fetch-blocked port — restart the Harness on another port, or pass --url / set DSH_RPC_URL",
  // 0.9.3 复核第三轮：字符串码现在会原样透出去，只把码抄一遍等于没给下一步。
  ECONNREFUSED: "nothing answered on that port — run `dsh-rpc health`, and check that the Harness actually started",
  ECONNRESET: "the connection dropped mid-request — run `dsh-rpc health`; if it repeats, the Harness log has the reason",
  EPIPE: "the Harness closed the connection while the request was in flight — run `dsh-rpc health` before retrying",
  ETIMEDOUT: "the request outlived its budget — run `dsh-rpc health`, then retry with a larger timeout_ms",
  UND_ERR_SOCKET: "the socket closed before the response arrived — run `dsh-rpc health` before retrying",
  UND_ERR_CONNECT_TIMEOUT: "the connection never opened — run `dsh-rpc health`, and check for a proxy between you and the Harness",
} as const satisfies Readonly<Record<string, string>>;

export type KnownNextCode = keyof typeof NEXT_BY_CODE;

export const DEFAULT_NEXT = "retry once; if it still fails, report the message above verbatim";

const WAIT_NEXT = "do NOT resend the prompt";

// The hint must quote a budget the bridge will actually honour, so it is a
// parameter rather than a literal: a deployment may configure another default.
const DEFAULT_WAIT_HINT_MS = 600000;
const DEFAULT_MAX_RESULT_CHARS = 20000;

export interface McpTextBlock {
  type: "text";
  text: string;
}

export interface McpToolResult<T = Record<string, unknown>> {
  content: McpTextBlock[];
  isError: boolean;
  structuredContent?: T;
}

export interface EndDescription {
  note: string;
  next: string | null;
  wait?: boolean;
}

export interface PendingEscalationSummary {
  approvalId?: string;
  escalation?: unknown;
  toolName?: string;
  argv?: string;
  [key: string]: unknown;
}

export interface FormatToolResultInput {
  sessionId?: string | null;
  turn?: number | null;
  requestId?: string | null;
  status?: string;
  accepted?: boolean;
  text?: string | null | undefined;
  durationMs?: number;
  cursor?: number | null;
  sliceMs?: number;
  requestedMs?: number;
  timedOut?: boolean;
  partial?: boolean;
  tools?: unknown[] | undefined;
  reason?: { kind?: string; reason?: unknown; error?: { code?: unknown; message?: unknown }; message?: unknown } | null;
  pendingApproval?: PendingEscalationSummary | null;
  next?: unknown;
  [key: string]: unknown;
}

export interface FormatToolResultOptions {
  defaultTimeoutMs?: number;
  trace?: unknown;
  since?: number | null;
  advice?: string | null;
  maxResultChars?: number;
}

export interface StructuredTurnToolOutcome {
  sessionId?: string | null;
  turn?: number | null;
  outcome: string;
  cursor?: number | null;
  sliceMs?: number;
  requestedMs?: number;
  tools: StructuredTraceEntry[];
}

export interface TaskDegradedEntry {
  control?: string;
  effect?: string;
  [key: string]: unknown;
}

export interface TaskAttentionEntry {
  kind?: string;
  questionId?: string;
  prompt?: string;
  options?: unknown[];
  [key: string]: unknown;
}

export interface TaskApprovalEntry {
  approvalId?: string;
  attemptId?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface TaskPreviewCandidate {
  agentId?: string;
  included?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface TaskProjection {
  taskId?: string | null | undefined;
  previewId?: string | null;
  status?: string | null;
  phase?: string | null;
  stateVersion?: number | null;
  agentId?: string | null;
  workspaceId?: string | null;
  capabilityRevisionId?: string | null;
  selectionReason?: string | null;
  candidates?: TaskPreviewCandidate[];
  expiresAt?: string | null;
  notice?: string | null;
  result?: unknown;
  resultValid?: boolean | null;
  error?: unknown;
  degraded?: TaskDegradedEntry[];
  pending?: {
    attention?: TaskAttentionEntry[];
    approvals?: TaskApprovalEntry[];
  } | null;
  deduplicated?: boolean;
  requestAccepted?: boolean;
  [key: string]: unknown;
}

export interface TaskDetailLinesResult {
  isPreview: boolean;
  degraded: TaskDegradedEntry[];
  attention: TaskAttentionEntry[];
  approvals: TaskApprovalEntry[];
  unvalidated: boolean;
  lines: string[];
}

/**
 * Cap only the turn prose block (`content[1]`) so `session + prose + meta`
 * stay within `maxResultChars` before appending the truncation marker.
 */
export function capText<T extends McpTextBlock[]>(content: T, maxResultChars = DEFAULT_MAX_RESULT_CHARS): T {
  if (!Array.isArray(content) || content.length < 3) return content;
  if (!Number.isInteger(maxResultChars) || maxResultChars <= 0) return content;
  const sessionText = content[0]?.text;
  const bodyText = content[1]?.text;
  const metaText = content[2]?.text;
  if (typeof sessionText !== "string" || typeof bodyText !== "string" || typeof metaText !== "string") {
    return content;
  }
  if (sessionText.length + bodyText.length + metaText.length <= maxResultChars) return content;

  let end = Math.max(0, maxResultChars - sessionText.length - metaText.length);
  if (end > bodyText.length) end = bodyText.length;
  // Never split a CRLF pair or a UTF-16 surrogate pair at the boundary.
  if (end > 0 && end < bodyText.length && bodyText.charCodeAt(end - 1) === 0x0d && bodyText.charCodeAt(end) === 0x0a) {
    end -= 1;
  }
  if (end > 0 && end < bodyText.length) {
    const hi = bodyText.charCodeAt(end - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) end -= 1;
  }
  const kept = bodyText.slice(0, end).replace(/[ \t\r\n]+$/, "");
  const marker = `\n… (turn text truncated at ${maxResultChars} chars; raise config.maxResultChars to lift the cap)`;
  // content.length >= 3 and content[1]?.text are checked above.
  const bodyBlock = content[1] as McpTextBlock;
  const cappedBlock: McpTextBlock = { ...bodyBlock, text: `${kept}${marker}` };
  if (Object.isFrozen(content)) {
    const copy = content.slice() as T;
    copy[1] = cappedBlock;
    return copy;
  }
  content[1] = cappedBlock;
  return content;
}

function waitCall(result: FormatToolResultInput | null | undefined, timeoutMs = DEFAULT_WAIT_HINT_MS): string {
  const budget = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_HINT_MS;
  const args = [`session_id: ${JSON.stringify(result?.sessionId ?? "")}`, `timeout_ms: ${budget}`];
  if (typeof result?.cursor === "number" && Number.isInteger(result.cursor) && result.cursor >= 0) {
    args.push(`since: ${result.cursor}`);
  }
  return `dsh_wait({ ${args.join(", ")} })`;
}

// `TurnEndCancelCause` → one clause a human can read. The Host cannot tell a
// bridge-initiated cancel from a click on the GUI's stop button, both arriving as
// `{kind:"user"}`; saying so is more useful than pretending to know.
function abortedBy(cause: unknown): EndDescription {
  const rec = cause && typeof cause === "object" ? (cause as { kind?: unknown; reason?: unknown }) : null;
  const kind = typeof rec?.kind === "string" ? rec.kind : null;
  switch (kind) {
    case "user":
      return {
        note: "the turn was stopped (cause: user — the Host cannot tell a bridge cancel from someone pressing stop)",
        next: "do not resend blindly: ask the human whether to continue, then resend with the same session_id",
      };
    case "legacy":
      return {
        note: "the turn was stopped (cause: legacy — the Host did not record who)",
        next: "ask the human whether to continue, then resend with the same session_id",
      };
    case "parent":
      return {
        note: "the turn was cancelled by its parent turn",
        next: "the parent decides whether to continue; resend with the same session_id only if it says so",
      };
    case "hook":
      return {
        note: `the turn was stopped by a hook${typeof rec?.reason === "string" && rec.reason ? ` (${rec.reason})` : ""}`,
        next: "a hook decided to stop it — check that hook's rule before retrying",
      };
    case "disposed":
      return {
        note: "the Host shut the session down mid-turn",
        next: "the session is gone: create a new one and resend there",
      };
    default:
      return {
        note: `the turn was stopped (cause: ${kind ?? "unrecorded"})`,
        next: "ask the human whether to continue, then resend with the same session_id",
      };
  }
}

// Every known `TurnEndReasonMap` variant, plus the two placeholders this bridge
// creates itself (`timeout` while waiting, `unknown` when the Host sent no reason
// at all). `TurnEndReasonMap` is merge-extensible, so an unrecognised kind is
// normal and must degrade to "unverified", never to "completed".
export function describeEnd(reason: unknown): EndDescription | null {
  const rec =
    reason && typeof reason === "object"
      ? (reason as {
          kind?: unknown;
          reason?: unknown;
          error?: { code?: unknown; message?: unknown };
          message?: unknown;
        })
      : null;
  const kind = typeof rec?.kind === "string" ? rec.kind : null;
  if (kind === null || kind === "completed") return null;

  if (kind === "aborted") return abortedBy(rec?.reason);

  if (kind === "blocked") {
    return {
      note: "the turn was blocked before it ran (policy or approval)",
      next: "do not resend as-is — the block reason is above; fix the policy or ask the human",
    };
  }

  if (kind === "error") {
    const failure = rec?.error ?? {};
    const detail = [failure.code, failure.message].filter((part) => typeof part === "string" && part.length > 0);
    return {
      note: `the turn ended on a model/provider error${detail.length > 0 ? `: ${detail.join(" — ")}` : ""}`,
      next: "this is not a tool failure; resending the same prompt usually fails the same way — change the request or the model first",
    };
  }

  if (kind === "max-tokens") {
    return {
      note: "the turn hit the model's output limit; the answer is cut off",
      next: "ask for the remainder or split the task — resending the same prompt truncates again",
    };
  }

  if (kind === "interrupted") {
    return {
      note: "the turn was interrupted before it finished",
      next: "resend once with the same session_id to continue",
    };
  }

  if (kind === "forked") {
    return {
      note: "the session was forked mid-turn; this turn ends at the fork",
      next: "continue in the new fork — do not resend in this session",
    };
  }

  if (kind === "refusal") {
    return {
      note: "the model refused this request",
      next: "resending the same prompt will be refused again — change the request",
    };
  }

  if (kind === "timeout") {
    return {
      note: typeof rec?.message === "string" ? rec.message : "the wait budget expired before the turn finished",
      next: null, // the caller gets the `dsh_wait(...)` hint below
      wait: true,
    };
  }

  if (kind === "unknown") {
    return {
      note: typeof rec?.message === "string" ? rec.message : "the Host ended the turn without a reason",
      next: "treat this outcome as unverified: check dsh_sessions() before resending",
    };
  }

  return {
    note: `the Host ended the turn with reason kind "${kind}", which this bridge does not know`,
    next: "treat this outcome as unverified: check dsh_sessions() before resending, and report the kind if it keeps appearing",
  };
}

function finishToolResult(
  content: McpTextBlock[],
  result: FormatToolResultInput | null | undefined,
  status: string,
  level: TraceLevel,
  trace: DescribeTraceResult,
  options: FormatToolResultOptions = {},
): McpToolResult<StructuredTurnToolOutcome> {
  if (typeof options.advice === "string" && options.advice.length > 0) {
    content.push({ type: "text", text: `advice: ${options.advice}` });
  }
  const maxResultChars =
    typeof options.maxResultChars === "number" &&
    Number.isInteger(options.maxResultChars) &&
    options.maxResultChars >= 0
      ? options.maxResultChars
      : DEFAULT_MAX_RESULT_CHARS;
  const finalContent = capText(content, maxResultChars);
  const outcome: McpToolResult<StructuredTurnToolOutcome> = { content: finalContent, isError: false };
  if (level === "full" && trace.structured !== null) {
    outcome.structuredContent = {
      ...(result?.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
      ...(result?.turn !== undefined ? { turn: result.turn } : {}),
      outcome: status,
      ...(result?.cursor !== undefined ? { cursor: result.cursor } : {}),
      ...(result?.sliceMs !== undefined ? { sliceMs: result.sliceMs } : {}),
      ...(result?.requestedMs !== undefined ? { requestedMs: result.requestedMs } : {}),
      tools: trace.structured,
    };
  }
  return outcome;
}

export function formatToolResult(
  result: FormatToolResultInput | null | undefined,
  options: FormatToolResultOptions = {},
): McpToolResult<StructuredTurnToolOutcome> {
  const waitTimeout =
    typeof options.defaultTimeoutMs === "number" && Number.isInteger(options.defaultTimeoutMs)
      ? options.defaultTimeoutMs
      : DEFAULT_WAIT_HINT_MS;
  const level = normalizeTraceLevel(options.trace, "errors");
  const trace = describeTrace(result?.tools ?? [], {
    level,
    status: result?.status,
    since: typeof options.since === "number" && Number.isInteger(options.since) ? options.since : null,
  });
  const accepted = result?.accepted === true && (result?.text ?? "") === "";
  const text = accepted
    ? "accepted: the prompt was submitted and the turn is running in the background."
    : typeof result?.text === "string" && result.text.length > 0
      ? result.text
      : "(the Harness returned no text)";
  const status = result?.status ?? "unknown";
  const toolsSummary =
    trace.total > 0
      ? level !== "none" && trace.errors > 0
        ? `${trace.total} tool calls (${trace.errors} errors)`
        : `${trace.total} tool calls`
      : null;
  const meta = [
    `outcome: ${status}${accepted ? " (accepted, not waited)" : ""}`,
    // No "?" placeholder: a handle has no turn yet, and inventing a value for
    // it is how a caller ends up waiting on the wrong one.
    Number.isInteger(result?.turn) ? `turn ${result?.turn}` : null,
    result?.requestId ? `request ${result.requestId}` : null,
    typeof result?.durationMs === "number" ? `${(result.durationMs / 1000).toFixed(1)}s` : null,
    toolsSummary,
    typeof result?.cursor === "number" && Number.isInteger(result.cursor) && result.cursor >= 0
      ? `cursor ${result.cursor}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const reason = result?.reason ?? null;
  const end = describeEnd(reason);

  const content: McpTextBlock[] = [
    // First line, always: the id a caller has to keep. It used to live only in the
    // trailing meta line, which is exactly the part a truncated tool result loses —
    // and losing it is what made the caller open a new session on the next call.
    { type: "text", text: `session ${result?.sessionId ?? "?"}` },
    { type: "text", text },
    { type: "text", text: `— ${meta}` },
  ];
  if (trace.lines.length > 0) content.push({ type: "text", text: `trace:\n${trace.lines.join("\n")}` });
  if (end?.note) content.push({ type: "text", text: `note: ${end.note}` });
  // `{kind:"completed"}` adds nothing on top of `outcome: completed`; the line
  // exists for the endings that need explaining.
  // Judge the reason by its own kind, not by the status string: `status` is the
  // Host's free-form string (see the note at the top of this file), and comparing
  // it with "completed" is exactly what we tell callers not to do. Today both
  // agree; a Host that adds a `completed` variant must not make the line vanish.
  if (reason && reason?.kind !== "completed") {
    content.push({ type: "text", text: `reason: ${JSON.stringify(reason)}` });
  }

  // A turn held on an approval is neither finished nor failing: it is waiting for
  // the caller. Say what it is waiting for, and that the answer is theirs to give.
  if (result?.status === "waiting-approval" && result?.pendingApproval) {
    const pending = result.pendingApproval;
    content.push({
      type: "text",
      text: `approval: ${pending.approvalId} asks to widen this session to ${pending.escalation} for ${pending.toolName}`,
    });
    if (typeof pending.argv === "string" && pending.argv.length > 0) {
      content.push({ type: "text", text: `command: ${pending.argv}` });
    }
    content.push({
      type: "text",
      text:
        `next: answer it with dsh_approvals_resolve({ approval_id: "${pending.approvalId}", decision: "allow-once" | "reject" }) ` +
        `— dsh_approvals_pending re-reads the whole packet. The turn is still running; ${WAIT_NEXT} after answering, call ${waitCall(result, waitTimeout)}.`,
    });
    return finishToolResult(content, result, status, level, trace, options);
  }

  // The bridge says "still running" with its own flags. Guessing it from the
  // status string is what made 31 of 34 turns in the field look like failures.
  if (accepted || result?.timedOut === true) {
    content.push({
      type: "text",
      text: `next: the turn is still running — ${WAIT_NEXT}. Call ${waitCall(result, waitTimeout)} to collect it.`,
    });
  } else if (result?.partial === true) {
    // `partial` only means "the stream ended without a turn/end event". That is
    // not the same as "still running": the Host may have died with it. Say both.
    content.push({
      type: "text",
      text:
        `next: the stream ended without a turn/end event — the turn may still be running, or it may have died with the Host. ` +
        `${WAIT_NEXT} — first check dsh_sessions() for this session; if it is still running, call ${waitCall(result, waitTimeout)}.`,
    });
  } else if (end?.next) {
    content.push({ type: "text", text: `next: ${end.next}` });
  } else if (end?.wait === true) {
    content.push({
      type: "text",
      text: `next: the turn is still running — ${WAIT_NEXT}. Call ${waitCall(result, waitTimeout)} to collect it.`,
    });
  } else if (result?.next) {
    // e.g. the sandbox escalation hint built by the bridge.
    content.push({ type: "text", text: `next: ${JSON.stringify(result.next)}` });
  }
  return finishToolResult(content, result, status, level, trace, options);
}

// `code` is the JSON-RPC error code the bridge raised (`error.code` on the
// RemoteError that `lib/client.mjs` throws). A string is accepted as an explicit
// hint so a caller-side failure can still name its own next step.
// A raw `JSON.stringify(data)` in the body reads like a stack trace and buries the
// hint. Keep only what the message does not already say, and only drop `next`
// when a table hint actually replaces it.
function detailLine(data: unknown, message: string, code: string): string | null {
  if (data === undefined || data === null) return null;
  if (typeof data !== "object") return String(data);
  const rest: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  const nextLookup = NEXT_BY_CODE as Readonly<Record<string, string | undefined>>;
  if (nextLookup[code] !== undefined) delete rest.next; // rendered as the hint below
  // Drop any scalar the message already states. It used to cover only
  // `sessionId`, so `turn: 7` was reprinted as `data: {"turn":7}` right after a
  // message that already said "turn 7".
  for (const key of Object.keys(rest)) {
    const value = rest[key];
    const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
    if (scalar && message.includes(String(value))) delete rest[key];
  }
  return Object.keys(rest).length > 0 ? `data: ${JSON.stringify(rest)}` : null;
}

export function formatToolError(
  message: string,
  data?: unknown,
  code?: number | string | null,
): McpToolResult {
  const key = typeof code === "number" && Number.isInteger(code) ? String(code) : typeof code === "string" ? code : "";
  const nextLookup = NEXT_BY_CODE as Readonly<Record<string, string | undefined>>;
  const hint = nextLookup[key] ?? (/^-?\d+$/.test(key) || key === "" ? DEFAULT_NEXT : key);
  const text = [message, detailLine(data, message, key), `next: ${hint}`].filter(Boolean).join("\n");
  return { content: [{ type: "text", text }], isError: true };
}

export function formatTaskListLine(item: TaskProjection): string {
  const tags: string[] = [];
  if (item.resultValid === false) tags.push("unvalidated");
  else if (item.resultValid === true) tags.push("resultValid=true");
  const degraded = Array.isArray(item.degraded) ? item.degraded : [];
  if (degraded.length > 0) tags.push(`degraded(${degraded.map((d) => d?.control ?? "?").join(",")})`);
  const attCount = Array.isArray(item.pending?.attention) ? item.pending.attention.length : 0;
  if (attCount > 0) tags.push(`attention=${attCount}`);
  const appCount = Array.isArray(item.pending?.approvals) ? item.pending.approvals.length : 0;
  if (appCount > 0) tags.push(`approvals=${appCount}`);
  const suffix = tags.length > 0 ? ` [${tags.join(" · ")}]` : "";
  return `task ${item.taskId ?? "?"} · ${item.status ?? "unknown"} · ${item.phase ?? "unknown"}${suffix}`;
}

export function formatTaskDetailLines(task: TaskProjection | null | undefined): TaskDetailLinesResult {
  const isPreview = !task?.taskId && Boolean(task?.previewId);
  const degraded = Array.isArray(task?.degraded) ? task.degraded : [];
  const attention = Array.isArray(task?.pending?.attention) ? task.pending.attention : [];
  const approvals = Array.isArray(task?.pending?.approvals) ? task.pending.approvals : [];
  const unvalidated = task?.resultValid === false;
  const lines: string[] = [];

  if (isPreview) {
    if (task?.workspaceId) lines.push(`workspace: ${task.workspaceId}`);
    if (task?.capabilityRevisionId) lines.push(`capability: ${task.capabilityRevisionId}`);
    if (task?.selectionReason) lines.push(`selection: ${task.selectionReason}`);
    if (Array.isArray(task?.candidates) && task.candidates.length > 0) {
      lines.push(
        `candidates (${task.candidates.length}): ${task.candidates
          .map((c) => (c?.included ? `${c.agentId}(selected)` : `${c?.agentId ?? "?"}(excluded:${c?.reason ?? "?"})`))
          .join(", ")}`,
      );
    }
  } else {
    if (task?.agentId) lines.push(`agent: ${task.agentId}`);
    if (task?.workspaceId) lines.push(`workspace: ${task.workspaceId}`);
  }

  if (task?.notice) lines.push(`notice: ${task.notice}`);
  if (degraded.length > 0) {
    lines.push(
      `degraded (${degraded.length}): ${degraded
        .map((d) => (d?.effect ? `${d.control} — ${d.effect}` : String(d?.control ?? d)))
        .join("; ")}`,
    );
  }
  if (attention.length > 0) {
    lines.push(
      `pending attention (${attention.length}): ${attention
        .map((a) => {
          const head = `[${a?.kind ?? "input"} ${a?.questionId ?? "?"}]`;
          const prompt = a?.prompt ? ` ${a.prompt}` : "";
          const opts =
            Array.isArray(a?.options) && a.options.length > 0 ? ` (options: ${a.options.join(" | ")})` : "";
          return `${head}${prompt}${opts}`;
        })
        .join("; ")}`,
    );
  }
  if (approvals.length > 0) {
    lines.push(
      `pending approvals (${approvals.length}): ${approvals
        .map((ap) => `[${ap?.approvalId ?? "?"}${ap?.attemptId ? `@${ap.attemptId}` : ""}]${ap?.summary ? ` ${ap.summary}` : ""}`)
        .join("; ")}`,
    );
  }
  if (task?.result !== undefined && task?.result !== null) {
    lines.push(
      `result: ${JSON.stringify(task.result)}${unvalidated ? " (unvalidated: failed schema validation)" : ""}`,
    );
  } else if (unvalidated) {
    lines.push("result: (none) (unvalidated: the executor reported ready without a validated result)");
  }
  if (task?.error) lines.push(`error: ${JSON.stringify(task.error)}`);

  return { isPreview, degraded, attention, approvals, unvalidated, lines };
}

export function formatTaskSummary<T extends TaskProjection>(
  task: T,
  maxResultChars = DEFAULT_MAX_RESULT_CHARS,
): McpToolResult<T> {
  const { isPreview, degraded, attention, approvals, unvalidated, lines } = formatTaskDetailLines(task);
  const header = isPreview
    ? `preview ${task.previewId} · ${task.agentId ?? "unknown"} · expires ${task.expiresAt ?? "?"}`
    : `task ${task?.taskId ?? "?"} · ${task?.status ?? "unknown"} · ${task?.phase ?? "unknown"}`;
  const meta = [
    task?.stateVersion !== undefined && task?.stateVersion !== null
      ? `v${task.stateVersion}`
      : isPreview
        ? "preview"
        : "v?",
    unvalidated ? "unvalidated" : null,
    degraded.length > 0 ? `degraded=${degraded.length}` : null,
    attention.length > 0 ? `attention=${attention.length}` : null,
    approvals.length > 0 ? `approvals=${approvals.length}` : null,
    task?.deduplicated ? "deduplicated" : null,
    task?.requestAccepted ? "requestAccepted" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const content = capText(
    [
      { type: "text", text: header },
      { type: "text", text: lines.length > 0 ? lines.join("\n") : "(no details)" },
      { type: "text", text: `— ${meta}` },
    ],
    maxResultChars,
  );
  return {
    content,
    isError: false,
    structuredContent: task,
  };
}
