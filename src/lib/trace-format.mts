// Pure projection of a turn's recorded tool calls into bounded human text
// (and, at `full`, structured JSON) without touching I/O or bridge state.

export const TRACE_LEVELS = Object.freeze(["none", "errors", "summary", "full"] as const);

export type TraceLevel = (typeof TRACE_LEVELS)[number];

export interface TraceBudget {
  readonly maxLines: number;
  readonly maxChars: number;
}

const LEVEL_BUDGETS: Readonly<Record<TraceLevel, TraceBudget>> = Object.freeze({
  none: Object.freeze({ maxLines: 0, maxChars: 0 }),
  errors: Object.freeze({ maxLines: 4, maxChars: 600 }),
  summary: Object.freeze({ maxLines: 20, maxChars: 1200 }),
  full: Object.freeze({ maxLines: 40, maxChars: 8000 }),
});

const DEFAULT_OUTPUT_CHARS = 400;
const PREVIEW_MAX_CHARS = 60;
const DETAIL_MAX_CHARS = 120;

export interface TraceToolInput {
  callId?: string | null;
  name?: string | null;
  ok?: boolean;
  isError?: boolean;
  error?: unknown;
  arguments?: unknown;
  output?: unknown;
  seq?: number | null;
  at?: number | null;
  endedAt?: number | null;
  [key: string]: unknown;
}

export interface DescribeTraceOptions {
  level?: unknown;
  now?: number;
  outputChars?: number;
  status?: string | null;
  maxLines?: number;
  maxChars?: number;
  since?: number | null;
}

export interface TraceTruncation {
  lines: boolean;
  chars: boolean;
}

export interface StructuredTraceEntry {
  index: number;
  callId: string | null;
  name: string | null;
  ok: boolean | null;
  arguments: unknown;
  output: string;
  outputTruncated: boolean;
  isError: boolean;
  error: unknown;
  seq: number | null;
  at: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
}

export interface DescribeTraceResult {
  level: TraceLevel;
  total: number;
  errors: number;
  running: number;
  since: { cursor: number; count: number } | null;
  lines: string[];
  structured: StructuredTraceEntry[] | null;
  truncated: TraceTruncation;
}

export function isTraceLevel(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return (TRACE_LEVELS as readonly string[]).includes(String(value).trim().toLowerCase());
}

export function normalizeTraceLevel(value: unknown, fallback: TraceLevel = "errors"): TraceLevel {
  if (value !== null && value !== undefined) {
    const normalized = String(value).trim().toLowerCase();
    if ((TRACE_LEVELS as readonly string[]).includes(normalized)) return normalized as TraceLevel;
  }
  return fallback;
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "" : serialized;
  } catch {
    return String(value ?? "");
  }
}

function collapseWhitespace(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function truncateWithEllipsis(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export function previewOf(args: unknown): string {
  if (args === null || args === undefined) return "";
  // The bridge stores tool arguments as the raw JSON text it received, so the
  // useful field (command/path) is only visible after parsing.
  let value: unknown = args;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") value = parsed;
      } catch {
        // not JSON: keep the raw text
      }
    }
  }
  let raw = "";
  if (typeof value === "string") {
    raw = value;
  } else if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (!Array.isArray(obj) && Object.keys(obj).length === 0) return "";
    if (typeof obj.command === "string" && obj.command.trim().length > 0) {
      raw = obj.command;
    } else if (typeof obj.path === "string" && obj.path.trim().length > 0) {
      raw = obj.path;
    } else if (typeof obj.description === "string" && obj.description.trim().length > 0) {
      raw = obj.description;
    } else {
      raw = safeStringify(obj);
    }
  } else {
    raw = String(value);
  }
  const collapsed = collapseWhitespace(raw).replace(/"/g, "'");
  return truncateWithEllipsis(collapsed, PREVIEW_MAX_CHARS);
}

function isFailedTool(tool: TraceToolInput): boolean {
  return tool.ok === false || tool.isError === true || (tool.error !== undefined && tool.error !== null);
}

function isRunningTool(tool: TraceToolInput): boolean {
  return typeof tool.endedAt !== "number" || !Number.isFinite(tool.endedAt);
}

function toolName(tool: TraceToolInput): string {
  return typeof tool.name === "string" && tool.name.trim().length > 0 ? tool.name.trim() : "tool";
}

function runningSeconds(tool: TraceToolInput, now: number): number {
  if (typeof tool.at !== "number" || !Number.isFinite(tool.at)) return 0;
  return Math.max(0, Math.round((now - tool.at) / 1000));
}

function formatDuration(at: unknown, endedAt: unknown): string | null {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof endedAt !== "number" || !Number.isFinite(endedAt)) return null;
  const ms = Math.max(0, endedAt - at);
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function detailOf(tool: TraceToolInput): string {
  const candidates: string[] = [];
  if (tool.error !== undefined && tool.error !== null) {
    candidates.push(typeof tool.error === "string" ? tool.error : safeStringify(tool.error));
  }
  if (typeof tool.output === "string" && tool.output.length > 0) {
    candidates.push(tool.output);
  }
  for (const raw of candidates) {
    const firstLine = String(raw).trim().split(/\r?\n/, 1)[0] ?? "";
    const collapsed = collapseWhitespace(firstLine);
    if (collapsed.length > 0) return truncateWithEllipsis(collapsed, DETAIL_MAX_CHARS);
  }
  return "";
}

function resolveBudget(level: TraceLevel, options: DescribeTraceOptions): TraceBudget {
  const base = LEVEL_BUDGETS[level];
  // Caller-supplied maxLines / maxChars may only tighten the level budget, never widen it.
  const maxLines =
    typeof options.maxLines === "number" && Number.isFinite(options.maxLines) && options.maxLines >= 0
      ? Math.min(base.maxLines, Math.floor(options.maxLines))
      : base.maxLines;
  const maxChars =
    typeof options.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars >= 0
      ? Math.min(base.maxChars, Math.floor(options.maxChars))
      : base.maxChars;
  return { maxLines, maxChars };
}

function joinedLengthWith(lines: readonly string[], extra: string): number {
  if (lines.length === 0) return extra.length;
  return lines.join("\n").length + 1 + extra.length;
}

// A tool without `endedAt` may be in flight, or may predate the 0.8.1 bridge that
// records `at`/`endedAt` at all. Claiming "running" for the second case would be a
// lie, so the label degrades to "unfinished" once the turn itself has finished.
function inflightSuffix(tool: TraceToolInput, now: number, turnFinished: boolean): string {
  if (!turnFinished) {
    if (typeof tool.at === "number" && Number.isFinite(tool.at)) return ` (running, ${runningSeconds(tool, now)}s)`;
    return " (running)";
  }
  const hasOutput = typeof tool.output === "string" && tool.output.length > 0;
  return hasOutput ? " (no timing)" : " (unfinished)";
}

function formatSummaryLine(tool: TraceToolInput, now: number, turnFinished: boolean): string {
  const name = toolName(tool);
  const preview = previewOf(tool.arguments);
  const failed = isFailedTool(tool);
  const running = isRunningTool(tool);
  if (failed) {
    const duration = formatDuration(tool.at, tool.endedAt);
    const timing = duration ? ` ${duration}` : inflightSuffix(tool, now, turnFinished);
    const detail = detailOf(tool);
    return `✗ ${name} "${preview}"${timing}${detail ? ` — ${detail}` : ""}`;
  }
  if (running) {
    return `… ${name} "${preview}"${inflightSuffix(tool, now, turnFinished)}`;
  }
  const duration = formatDuration(tool.at, tool.endedAt);
  return `✓ ${name} "${preview}"${duration ? ` ${duration}` : ""}`;
}

function formatFullBlock(tool: TraceToolInput, now: number, outputChars: number, turnFinished: boolean): string[] {
  const name = toolName(tool);
  const preview = previewOf(tool.arguments);
  const failed = isFailedTool(tool);
  const running = isRunningTool(tool);

  let statusPart: string;
  if (failed) {
    const duration = formatDuration(tool.at, tool.endedAt);
    statusPart = duration ? `✗ ${duration}` : `✗${inflightSuffix(tool, now, turnFinished)}`;
  } else if (running) {
    statusPart = `…${inflightSuffix(tool, now, turnFinished)}`;
  } else {
    const duration = formatDuration(tool.at, tool.endedAt);
    statusPart = duration ? `✓ ${duration}` : "✓";
  }

  const lines = [`▸ ${name} "${preview}" ${statusPart}`];
  const rawOutput = typeof tool.output === "string" ? tool.output : "";
  if (rawOutput.length === 0) {
    lines.push("  out: (no output)");
  } else {
    const capped = truncateWithEllipsis(rawOutput, outputChars);
    lines.push(`  out: ${capped.replace(/\r?\n/g, "\n  ")}`);
  }
  if (failed && tool.error !== undefined && tool.error !== null) {
    const errJson = truncateWithEllipsis(safeStringify(tool.error), outputChars);
    lines.push(`  err: ${errJson.replace(/\r?\n/g, "\n  ")}`);
  }
  return lines;
}

function fitLinesSimple(
  candidates: readonly string[],
  maxLines: number,
  maxChars: number,
): { lines: string[]; truncated: TraceTruncation } {
  const lines: string[] = [];
  const truncated: TraceTruncation = { lines: false, chars: false };
  for (const line of candidates) {
    if (lines.length + 1 > maxLines) {
      truncated.lines = true;
      break;
    }
    if (joinedLengthWith(lines, line) > maxChars) {
      truncated.chars = true;
      break;
    }
    lines.push(line);
  }
  return { lines, truncated };
}

function fitSummaryLines(
  header: string | null,
  toolLines: readonly string[],
  maxLines: number,
  maxChars: number,
): { lines: string[]; truncated: TraceTruncation } {
  const lines: string[] = [];
  const truncated: TraceTruncation = { lines: false, chars: false };
  if (maxLines <= 0 || maxChars <= 0) {
    if (header !== null || toolLines.length > 0) {
      if (maxLines <= 0) truncated.lines = true;
      if (maxChars <= 0) truncated.chars = true;
    }
    return { lines, truncated };
  }

  if (header !== null) {
    if (header.length > maxChars) {
      truncated.chars = true;
      return { lines, truncated };
    }
    lines.push(header);
  }

  let shownTools = 0;
  for (const line of toolLines) {
    if (lines.length + 1 > maxLines) {
      truncated.lines = true;
      break;
    }
    if (joinedLengthWith(lines, line) > maxChars) {
      truncated.chars = true;
      break;
    }
    lines.push(line);
    shownTools += 1;
  }

  if (shownTools < toolLines.length) {
    let dropped = toolLines.length - shownTools;
    const trailer = (count: number) => `… +${count} more (call dsh_history for the full window)`;
    while (shownTools > 0 && (lines.length + 1 > maxLines || joinedLengthWith(lines, trailer(dropped)) > maxChars)) {
      lines.pop();
      shownTools -= 1;
      dropped += 1;
    }
    const finalTrailer = trailer(dropped);
    if (lines.length + 1 <= maxLines && joinedLengthWith(lines, finalTrailer) <= maxChars) {
      lines.push(finalTrailer);
    }
  }

  return { lines, truncated };
}

interface IndexedTool {
  tool: TraceToolInput;
  index: number;
}

function buildErrorsLines(
  keptEntries: readonly IndexedTool[],
  total: number,
  errorsCount: number,
  now: number,
  maxLines: number,
  maxChars: number,
  turnFinished: boolean,
): { lines: string[]; truncated: TraceTruncation } {
  const keptFailed = keptEntries.filter((entry) => isFailedTool(entry.tool));
  const keptRunning = keptEntries.filter((entry) => isRunningTool(entry.tool));

  const candidates: string[] = [];
  if (keptFailed.length > 0) {
    candidates.push(`errors: ${errorsCount} of ${total} tool calls`);
    for (let index = keptFailed.length - 1; index >= 0 && candidates.length < 4; index -= 1) {
      const tool = keptFailed[index].tool;
      const detail = detailOf(tool);
      candidates.push(`✗ ${toolName(tool)} "${previewOf(tool.arguments)}"${detail ? ` — ${detail}` : ""}`);
    }
  } else if (!turnFinished && keptRunning.length > 0) {
    const last = keptRunning[keptRunning.length - 1].tool;
    candidates.push(`last: ${toolName(last)} "${previewOf(last.arguments)}"${inflightSuffix(last, now, turnFinished)}`);
  }

  return fitLinesSimple(candidates, maxLines, maxChars);
}

function buildFullLines(
  header: string | null,
  toolLines: readonly string[],
  keptEntries: readonly IndexedTool[],
  now: number,
  outputChars: number,
  maxLines: number,
  maxChars: number,
  turnFinished: boolean,
): { lines: string[]; truncated: TraceTruncation } {
  if (maxLines <= 0 || maxChars <= 0) {
    const hasContent = header !== null || keptEntries.length > 0;
    return {
      lines: [],
      truncated: {
        lines: hasContent && maxLines <= 0,
        chars: hasContent && maxChars <= 0,
      },
    };
  }

  const blocks = keptEntries.map((entry) => formatFullBlock(entry.tool, now, outputChars, turnFinished));
  const allCombined = [...(header !== null ? [header] : []), ...toolLines, ...blocks.flat()];
  if (allCombined.length <= maxLines && allCombined.join("\n").length <= maxChars) {
    return { lines: allCombined, truncated: { lines: false, chars: false } };
  }

  const summaryMaxLines = maxLines >= 2 ? Math.floor(maxLines / 2) : maxLines;
  const summaryMaxChars = Math.floor(maxChars / 2);
  const summaryFit = fitSummaryLines(header, toolLines, summaryMaxLines, summaryMaxChars);
  const lines = [...summaryFit.lines];
  const truncated = { ...summaryFit.truncated };

  const summaryChars = lines.length > 0 ? lines.join("\n").length : 0;
  const selectedBlocks: string[][] = [];
  let selectedLinesCount = 0;
  let selectedCharsCount = 0;

  // Newest tools win the remaining budget, then selected blocks are emitted oldest-first.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const blockChars = block.join("\n").length;
    const separator = lines.length > 0 || selectedBlocks.length > 0 ? 1 : 0;
    const nextLines = lines.length + selectedLinesCount + block.length;
    const nextChars = summaryChars + selectedCharsCount + separator + blockChars;
    if (nextLines > maxLines || nextChars > maxChars) {
      if (nextLines > maxLines) truncated.lines = true;
      if (nextChars > maxChars) truncated.chars = true;
      break;
    }
    selectedBlocks.unshift(block);
    selectedLinesCount += block.length;
    selectedCharsCount += separator + blockChars;
  }

  return {
    lines: [...lines, ...selectedBlocks.flat()],
    truncated,
  };
}

export function describeTrace(tools: unknown, options: DescribeTraceOptions = {}): DescribeTraceResult {
  const level = normalizeTraceLevel(options.level, "errors");
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const outputChars =
    typeof options.outputChars === "number" && Number.isFinite(options.outputChars) && options.outputChars >= 0
      ? Math.floor(options.outputChars)
      : DEFAULT_OUTPUT_CHARS;
  // A finished turn cannot have an in-flight tool: anything without `endedAt` predates
  // the 0.8.1 bridge (or lost its result), and must not be rendered as still running.
  const turnFinished = typeof options.status === "string" && (options.status === "completed" || options.status === "idle");
  const { maxLines, maxChars } = resolveBudget(level, options);

  const allTools = (Array.isArray(tools) ? tools : []).filter(
    (item): item is TraceToolInput => item !== null && typeof item === "object" && !Array.isArray(item),
  );
  const total = allTools.length;
  const errors = allTools.filter(isFailedTool).length;
  const running = allTools.filter(isRunningTool).length;

  const sinceCursor = options.since;
  const hasSince = typeof sinceCursor === "number" && Number.isInteger(sinceCursor) && sinceCursor >= 0;
  const indexed: IndexedTool[] = allTools.map((tool, index) => ({ tool, index }));
  const keptEntries = hasSince
    ? indexed.filter(({ tool }) => typeof tool.seq === "number" && Number.isInteger(tool.seq) && tool.seq > sinceCursor)
    : indexed;
  const since = hasSince ? { cursor: sinceCursor, count: keptEntries.length } : null;

  let lines: string[] = [];
  let truncated: TraceTruncation = { lines: false, chars: false };
  let structured: StructuredTraceEntry[] | null = null;

  if (level === "errors") {
    const built = buildErrorsLines(keptEntries, total, errors, now, maxLines, maxChars, turnFinished);
    lines = built.lines;
    truncated = built.truncated;
  } else if (level === "summary") {
    const header = hasSince ? `+${keptEntries.length} since cursor ${sinceCursor}` : null;
    const toolLines = keptEntries.map(({ tool }) => formatSummaryLine(tool, now, turnFinished));
    const built = fitSummaryLines(header, toolLines, maxLines, maxChars);
    lines = built.lines;
    truncated = built.truncated;
  } else if (level === "full") {
    const header = hasSince ? `+${keptEntries.length} since cursor ${sinceCursor}` : null;
    const toolLines = keptEntries.map(({ tool }) => formatSummaryLine(tool, now, turnFinished));
    const built = buildFullLines(header, toolLines, keptEntries, now, outputChars, maxLines, maxChars, turnFinished);
    lines = built.lines;
    truncated = built.truncated;
    structured = keptEntries.map(({ tool, index }) => {
      const rawOutput = typeof tool.output === "string" ? tool.output : "";
      const outputTruncated = rawOutput.length > outputChars;
      const output = outputTruncated ? truncateWithEllipsis(rawOutput, outputChars) : rawOutput;
      const at = typeof tool.at === "number" && Number.isFinite(tool.at) ? tool.at : null;
      const endedAt = typeof tool.endedAt === "number" && Number.isFinite(tool.endedAt) ? tool.endedAt : null;
      const elapsedMs = at !== null && endedAt !== null ? Math.max(0, endedAt - at) : null;
      return {
        index,
        callId: tool.callId ?? null,
        name: tool.name ?? null,
        ok: typeof tool.ok === "boolean" ? tool.ok : isFailedTool(tool) ? false : null,
        arguments: tool.arguments ?? null,
        output,
        outputTruncated,
        isError: tool.isError === true,
        error: tool.error ?? null,
        seq: typeof tool.seq === "number" && Number.isInteger(tool.seq) ? tool.seq : null,
        at,
        endedAt,
        elapsedMs,
      };
    });
  }

  return {
    level,
    total,
    errors,
    running,
    since,
    lines,
    structured,
    truncated,
  };
}
