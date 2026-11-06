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

const NEXT_BY_CODE = {
  "-32602": "fix the arguments named in the message and call again — retrying the same call will fail the same way",
  "-32003": "call dsh_sessions() to find the real session id",
  "-32004": "the session is busy — call dsh_wait({ session_id }) to follow the running turn instead of resending the prompt",
  "-32005": "the bridge gave up waiting for a free slot — call dsh_wait({ session_id }) or retry with a larger timeout_ms",
  "-32006": "the wait was cancelled; retry once, or use a different session_id",
};

// The Host's own text goes into our body verbatim. Truncating keeps one huge
// tool result from crowding out the meta line, the note and the next step — the
// parts a caller acts on.
const MAX_BODY_CHARS = 2000;

function clampText(text) {
  if (typeof text !== "string" || text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n… (truncated ${text.length - MAX_BODY_CHARS} of ${text.length} chars; read the full turn with dsh_wait or the session history)`;
}

const DEFAULT_NEXT = "retry once; if it still fails, report the message above verbatim";

const WAIT_NEXT = "do NOT resend the prompt";

// The hint must quote a budget the bridge will actually honour, so it is a
// parameter rather than a literal: a deployment may configure another default.
const DEFAULT_WAIT_HINT_MS = 600000;

function waitCall(result, timeoutMs = DEFAULT_WAIT_HINT_MS) {
  const budget = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WAIT_HINT_MS;
  const args = [`session_id: ${JSON.stringify(result?.sessionId ?? "")}`, `timeout_ms: ${budget}`];
  if (Number.isInteger(result?.cursor) && result.cursor >= 0) args.push(`since: ${result.cursor}`);
  return `dsh_wait({ ${args.join(", ")} })`;
}

// `TurnEndCancelCause` → one clause a human can read. The Host cannot tell a
// bridge-initiated cancel from a click on the GUI's stop button, both arriving as
// `{kind:"user"}`; saying so is more useful than pretending to know.
function abortedBy(cause) {
  const kind = typeof cause?.kind === "string" ? cause.kind : null;
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
        note: `the turn was stopped by a hook${typeof cause?.reason === "string" && cause.reason ? ` (${cause.reason})` : ""}`,
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
export function describeEnd(reason) {
  const kind = typeof reason?.kind === "string" ? reason.kind : null;
  if (kind === null || kind === "completed") return null;

  if (kind === "aborted") return abortedBy(reason?.reason);

  if (kind === "blocked") {
    return {
      note: "the turn was blocked before it ran (policy or approval)",
      next: "do not resend as-is — the block reason is above; fix the policy or ask the human",
    };
  }

  if (kind === "error") {
    const failure = reason?.error ?? {};
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
      note: typeof reason?.message === "string" ? reason.message : "the wait budget expired before the turn finished",
      next: null, // the caller gets the `dsh_wait(...)` hint below
      wait: true,
    };
  }

  if (kind === "unknown") {
    return {
      note: typeof reason?.message === "string" ? reason.message : "the Host ended the turn without a reason",
      next: "treat this outcome as unverified: check dsh_sessions() before resending",
    };
  }

  return {
    note: `the Host ended the turn with reason kind "${kind}", which this bridge does not know`,
    next: "treat this outcome as unverified: check dsh_sessions() before resending, and report the kind if it keeps appearing",
  };
}

export function formatToolResult(result, options = {}) {
  const waitTimeout = Number.isInteger(options.defaultTimeoutMs) ? options.defaultTimeoutMs : DEFAULT_WAIT_HINT_MS;
  const accepted = result?.accepted === true && (result?.text ?? "") === "";
  const text = accepted
    ? "accepted: the prompt was submitted and the turn is running in the background."
    : typeof result?.text === "string" && result.text.length > 0
      ? clampText(result.text)
      : "(the Harness returned no text)";
  const status = result?.status ?? "unknown";
  const meta = [
    `outcome: ${status}${accepted ? " (accepted, not waited)" : ""}`,
    // No "?" placeholder: a handle has no turn yet, and inventing a value for
    // it is how a caller ends up waiting on the wrong one.
    Number.isInteger(result?.turn) ? `turn ${result.turn}` : null,
    result?.requestId ? `request ${result.requestId}` : null,
    typeof result?.durationMs === "number" ? `${(result.durationMs / 1000).toFixed(1)}s` : null,
    Array.isArray(result?.tools) && result.tools.length > 0 ? `${result.tools.length} tool calls` : null,
    Number.isInteger(result?.cursor) && result.cursor >= 0 ? `cursor ${result.cursor}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const reason = result?.reason ?? null;
  const end = describeEnd(reason);

  const content = [
    // First line, always: the id a caller has to keep. It used to live only in the
    // trailing meta line, which is exactly the part a truncated tool result loses —
    // and losing it is what made the caller open a new session on the next call.
    { type: "text", text: `session ${result?.sessionId ?? "?"}` },
    { type: "text", text },
    { type: "text", text: `— ${meta}` },
  ];
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
    return { content, isError: false };
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
    content.push({ type: "text", text: `next: the turn is still running — ${WAIT_NEXT}. Call ${waitCall(result, waitTimeout)} to collect it.` });
  } else if (result?.next) {
    // e.g. the sandbox escalation hint built by the bridge.
    content.push({ type: "text", text: `next: ${JSON.stringify(result.next)}` });
  }
  return { content, isError: false };
}

// `code` is the JSON-RPC error code the bridge raised (`error.code` on the
// RemoteError that `lib/client.mjs` throws). A string is accepted as an explicit
// hint so a caller-side failure can still name its own next step.
// A raw `JSON.stringify(data)` in the body reads like a stack trace and buries the
// hint. Keep only what the message does not already say, and only drop `next`
// when a table hint actually replaces it.
function detailLine(data, message, code) {
  if (data === undefined || data === null) return null;
  if (typeof data !== "object") return String(data);
  const rest = { ...data };
  if (NEXT_BY_CODE[code] !== undefined) delete rest.next; // rendered as the hint below
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

export function formatToolError(message, data, code) {
  const key = Number.isInteger(code) ? String(code) : typeof code === "string" ? code : "";
  const hint = NEXT_BY_CODE[key] ?? (/^-?\d+$/.test(key) || key === "" ? DEFAULT_NEXT : key);
  const text = [message, detailLine(data, message, key), `next: ${hint}`].filter(Boolean).join("\n");
  return { content: [{ type: "text", text }], isError: true };
}

export { DEFAULT_NEXT, NEXT_BY_CODE };
