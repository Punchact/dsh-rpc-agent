// Pure projection of a `dsh.sessions.history` payload into bounded human text
// and structured metadata, without touching `lib/methods.mjs` or I/O.

export const DEFAULT_HISTORY_KINDS = Object.freeze(["tool/call", "tool/result", "turn/end"]);

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_DETAIL_CHARS = 120;

function nonNegIntOption(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function collapseNewlines(text) {
  return String(text ?? "").replace(/\r?\n|\r/g, "⏎");
}

function capText(text, limit) {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function safeCompactJson(value) {
  if (value === undefined) return "{}";
  try {
    const out = JSON.stringify(value);
    return out === undefined ? "null" : out;
  } catch {
    return String(value ?? "");
  }
}

function joinedLengthWith(lines, extra) {
  if (lines.length === 0) return extra.length;
  return lines.join("\n").length + 1 + extra.length;
}

function normalizeKindsOption(kinds) {
  if (kinds === null || kinds === undefined) return null;
  if (kinds === "*") return "*";
  if (Array.isArray(kinds)) {
    if (kinds.length === 1 && kinds[0] === "*") return "*";
    return kinds.map((item) => String(item));
  }
  return null;
}

function extractResultText(data) {
  const message = data?.message;
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    if (Array.isArray(message.content)) {
      const parts = [];
      for (const block of message.content) {
        if (typeof block === "string") {
          parts.push(block);
        } else if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    } else if (typeof message.content === "string") {
      return message.content;
    }
    if (typeof message.text === "string") return message.text;
  }
  if (typeof data?.output === "string") return data.output;
  if (typeof data?.text === "string") return data.text;
  if (data?.error !== undefined && data?.error !== null) {
    return typeof data.error === "string" ? data.error : safeCompactJson(data.error);
  }
  return "";
}

function formatToolCallDetail(data, detailChars) {
  const name = typeof data?.name === "string" && data.name.trim().length > 0 ? data.name.trim() : "?";
  let args = data?.arguments;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        args = JSON.parse(trimmed);
      } catch {
        // Keep raw text when arguments are not valid JSON.
      }
    }
  }
  const json = args === undefined ? "{}" : safeCompactJson(args);
  return collapseNewlines(`${name} ${capText(collapseNewlines(json), detailChars)}`);
}

function formatToolResultDetail(data, callNames, detailChars) {
  const callId = data?.callId ?? data?.message?.toolCallId ?? null;
  const resolvedName = typeof callId === "string" ? callNames.get(callId) : null;
  const name =
    resolvedName || (typeof data?.name === "string" && data.name.trim().length > 0 ? data.name.trim() : "?");
  const failed =
    data?.ok === false ||
    data?.isError === true ||
    data?.message?.isError === true ||
    (data?.error !== undefined && data?.error !== null);
  const statusWord = failed ? "fail" : "ok";
  const rawText = extractResultText(data);
  const firstLine = String(rawText).trim().split(/\r?\n/, 1)[0] ?? "";
  const capped = capText(collapseNewlines(firstLine), detailChars);
  return collapseNewlines(`${name} ${statusWord} "${capped}"`);
}

function formatTurnEndDetail(data, detailChars) {
  const reason = data?.reason !== undefined ? data.reason : null;
  return collapseNewlines(`reason ${capText(collapseNewlines(safeCompactJson(reason)), detailChars)}`);
}

function formatDefaultDetail(data, detailChars) {
  const value = data !== undefined ? data : {};
  return capText(collapseNewlines(safeCompactJson(value)), detailChars);
}

function formatRecordLine(record, callNames, detailChars) {
  const seqPart = Number.isInteger(record?.seq) ? `#${record.seq}` : "#-";
  const type = typeof record?.type === "string" && record.type.length > 0 ? record.type : "unknown";
  const typeCol = type.padEnd(12, " ");
  const data = record?.data;

  let detail;
  if (type === "tool/call") {
    detail = formatToolCallDetail(data, detailChars);
  } else if (type === "tool/result") {
    detail = formatToolResultDetail(data, callNames, detailChars);
  } else if (type === "turn/end") {
    detail = formatTurnEndDetail(data, detailChars);
  } else {
    detail = formatDefaultDetail(data, detailChars);
  }

  return `${seqPart} ${typeCol} ${detail}`;
}

export function formatHistory(payload, options = {}) {
  const maxLines = nonNegIntOption(options.maxLines, DEFAULT_MAX_LINES);
  const maxChars = nonNegIntOption(options.maxChars, DEFAULT_MAX_CHARS);
  const detailChars = nonNegIntOption(options.detailChars, DEFAULT_DETAIL_CHARS);
  const since = Number.isInteger(options.since) && options.since >= 0 ? options.since : null;
  const kinds = normalizeKindsOption(options.kinds);

  const sessionId = payload?.sessionId ?? null;
  const cursor = Number.isInteger(payload?.cursor) ? payload.cursor : -1;
  const turn = Number.isInteger(payload?.turn) ? payload.turn : 0;
  const running = Boolean(payload?.running);
  const hasMore = Boolean(payload?.hasMore);
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const messageCount = Number.isInteger(payload?.messageCount) ? payload.messageCount : records.length;

  const summaryLine =
    `session ${sessionId ?? "?"} · turn ${turn} · ${running ? "running" : "idle"} · ` +
    `window ${messageCount} events (hasMore: ${hasMore ? "yes" : "no"}) · cursor ${cursor}`;

  // The payload comes from whatever plugin the endpoint is running, and a 0.7.x
  // plugin ignores `since`/`kinds`/`maxChars` (they arrived in 0.8.1) while
  // answering with the same shape. There is no version field to check, so the
  // only honest test is whether records that should have been filtered out are
  // still there.
  const ignored = [];
  if (since !== null && records.some((record) => Number.isInteger(record?.seq) && record.seq <= since)) {
    ignored.push("since");
  }
  if (kinds !== null && kinds !== "*" && records.some((record) => !kinds.includes(record?.type))) {
    ignored.push("kinds");
  }
  // A plugin that honoured the cap would have bounded the very records it sent
  // back, so a payload larger than the requested cap proves it did not.
  const requestedMaxChars =
    typeof options.requestedMaxChars === "number" && options.requestedMaxChars > 0
      ? Math.floor(options.requestedMaxChars)
      : 0;
  if (requestedMaxChars > 0 && !("truncated" in (payload ?? {})) && safeCompactJson(records).length > requestedMaxChars) {
    ignored.push("max_chars");
  }
  const honoured = ignored.length === 0;

  const filterParts = [];
  if (since !== null) filterParts.push(`since ${since}`);
  if (kinds !== null) {
    const kindsLabel = kinds === "*" ? "*" : kinds.join(",");
    filterParts.push(`kinds ${kindsLabel}`);
  }
  const header =
    filterParts.length > 0 && honoured
      ? `${summaryLine}\nfiltered: ${records.length} of ${messageCount} kept (${filterParts.join(", ")})`
      : summaryLine;

  // Claiming a filter the plugin did not apply is worse than saying nothing:
  // the caller would trust a delta that is really the whole window.
  const note = honoured
    ? null
    : `the connected plugin ignored ${ignored.join(" and ")} (it predates 0.8.1) — the records below are the unfiltered, uncapped window; upgrade the plugin or narrow the request client-side`;

  const callNames = new Map();
  for (const record of records) {
    if (record?.type !== "tool/call") continue;
    const callId = record.data?.callId;
    const name = record.data?.name;
    if (typeof callId === "string" && callId.length > 0 && typeof name === "string" && name.trim().length > 0) {
      callNames.set(callId, name.trim());
    }
  }

  const allLines = records.map((record) => formatRecordLine(record, callNames, detailChars));
  const empty = allLines.length === 0;

  const lines = [];
  let shown = 0;
  if (!empty && maxLines > 0 && maxChars > 0) {
    for (const line of allLines) {
      if (lines.length + 1 > maxLines) break;
      if (joinedLengthWith(lines, line) > maxChars) break;
      lines.push(line);
      shown += 1;
    }
  }

  let dropped = allLines.length - shown;
  if (dropped > 0) {
    const trailer = (count) => `… +${count} more (raise limit or max_chars)`;
    while (
      shown > 0 &&
      (lines.length + 1 > maxLines || joinedLengthWith(lines, trailer(dropped)) > maxChars)
    ) {
      lines.pop();
      shown -= 1;
      dropped += 1;
    }
    const finalTrailer = trailer(dropped);
    if (lines.length + 1 <= maxLines && joinedLengthWith(lines, finalTrailer) <= maxChars) {
      lines.push(finalTrailer);
    }
  }

  const structured = {
    sessionId,
    cursor,
    turn,
    running,
    hasMore,
    messageCount,
    records,
    ...(typeof payload?.truncated === "boolean" ? { truncated: payload.truncated } : {}),
    ...(honoured ? {} : { note }),
  };

  return {
    header,
    note,
    lines,
    structured,
    shown,
    dropped,
    empty,
  };
}
