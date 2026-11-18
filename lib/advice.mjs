// Pure decision logic for one-shot timeout guidance on MCP tool results.

export const TIMEOUT_ADVICE =
  "this wait used the bridge budget; an outer MCP client may cut the call first " +
  "(Codex: tool_timeout_sec, 900 s by default). For long work prefer " +
  "dsh_ask({wait:false}) and then dsh_wait({session_id, since:cursor}).";

export function shouldAdviseTimeout(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const { status, timedOut, requestedMs, enabled, alreadyShown } = input;
  if (enabled === false) return false;
  if (alreadyShown === true) return false;
  if (timedOut !== true && status !== "timeout") return false;
  return Number.isInteger(requestedMs) && requestedMs >= 600000;
}
