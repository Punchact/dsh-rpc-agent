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

const NEXT_BY_CODE = {
  "-32003": "call dsh_sessions() to find the real session id",
  "-32004": "call dsh_wait({ session_id }) to follow the running turn, or pass queue:true to wait for the slot",
  "-32005": "the bridge gave up waiting for a free slot — call dsh_wait({ session_id }) or retry with a larger timeout_ms",
  "-32006": "the wait was cancelled; retry once, or use a different session_id",
};

const DEFAULT_NEXT = "retry once; if it still fails, report the message above verbatim";

export function formatToolResult(result) {
  const accepted = result?.accepted === true && (result?.text ?? "") === "";
  const text = accepted
    ? "accepted: the prompt was submitted and the turn is running in the background."
    : typeof result?.text === "string" && result.text.length > 0
      ? result.text
      : "(the Harness returned no text)";
  const status = result?.status ?? "unknown";
  const meta = [
    `outcome: ${status}${accepted ? " (accepted, not waited)" : ""}`,
    `session ${result?.sessionId ?? "?"}`,
    `turn ${result?.turn ?? "?"}`,
    result?.requestId ? `request ${result.requestId}` : null,
    typeof result?.durationMs === "number" ? `${(result.durationMs / 1000).toFixed(1)}s` : null,
    Array.isArray(result?.tools) && result.tools.length > 0 ? `${result.tools.length} tool calls` : null,
    Number.isInteger(result?.cursor) && result.cursor >= 0 ? `cursor ${result.cursor}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const content = [
    { type: "text", text },
    { type: "text", text: `— ${meta}` },
  ];
  if (result?.reason) content.push({ type: "text", text: `reason: ${JSON.stringify(result.reason)}` });

  // The bridge says "still running" with its own flags. Guessing it from the
  // status string is what made 31 of 34 turns in the field look like failures.
  if (accepted || result?.timedOut === true || result?.partial === true) {
    const args = [`session_id: ${JSON.stringify(result?.sessionId ?? "")}`, "timeout_ms: 600000"];
    if (Number.isInteger(result?.cursor) && result.cursor >= 0) args.push(`since: ${result.cursor}`);
    content.push({
      type: "text",
      text:
        `next: the turn is still running — do NOT resend the prompt. ` +
        `Call dsh_wait({ ${args.join(", ")} }) to collect it.`,
    });
  } else if (result?.next) {
    // e.g. the sandbox escalation hint built by the bridge.
    content.push({ type: "text", text: `next: ${JSON.stringify(result.next)}` });
  }
  return { content, isError: false };
}

export function formatToolError(message, data, next) {
  const code = next === undefined || next === null ? "" : String(next);
  const hint = NEXT_BY_CODE[code] ?? (/^-?\d+$/.test(code) || code === "" ? DEFAULT_NEXT : code);
  const text = [message, data === undefined ? null : JSON.stringify(data), `next: ${hint}`].filter(Boolean).join("\n");
  return { content: [{ type: "text", text }], isError: true };
}

export { DEFAULT_NEXT, NEXT_BY_CODE };
