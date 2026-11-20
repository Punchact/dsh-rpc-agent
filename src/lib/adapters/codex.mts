// Codex App Server adapter (§8.1): newline-delimited JSON-RPC 2.0 over stdio.
// Binary discovery avoids the 0-byte WindowsApps execution alias and accepts
// injected `spawn` / `spawnSync` so tests stay completely hermetic.

import * as childProcess from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { TASK_ERROR, taskError } from "../tasks/errors.mjs";
import { createStickySessions, type StickySessions } from "./sticky.mjs";
import {
  ADAPTER_FAILURE_MESSAGES,
  type AdapterEventEntry,
  type AgentReport,
  type RuntimeAdapter,
  reportOf,
  sanitizeAdapterFailure,
  validateAdapter,
} from "./base.mjs";

const WINDOWS_APPS_ROOT = "C:\\Program Files\\WindowsApps";
export const MAX_FRAME_CHARS = 4 * 1024 * 1024;
export const MAX_EVENT_QUEUE = 500;
export const MAX_PENDING_APPROVALS = 200;
// One app-server process per live thread; each holds that thread's store lock.
const MAX_OPEN_SESSIONS = 8;
const MAX_STDERR_CHARS = 4096;

export interface CodexFsOps {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  accessSync(path: string, mode?: number): void;
  statSync?: (path: string) => { isFile?: () => boolean; size?: number };
}

export interface ResolveCodexBinaryOptions {
  explicitBinary?: string;
  homedir?: string;
  fsOps?: CodexFsOps;
}

export interface CodexBinaryCheck {
  source: "explicit" | "windowsApps" | "sandboxBin";
  path: string;
  unreadable?: boolean;
}

export interface CodexBinaryResolution {
  path: string;
  source: "explicit" | "windowsApps" | "sandboxBin";
  checked: CodexBinaryCheck[];
}

export interface CodexClientInfo {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface CodexHandshakeOptions {
  spawn: (...args: any[]) => any;
  path: string;
  clientInfo: CodexClientInfo;
  timeoutMs?: number;
}

export interface CodexHandshakeResult {
  ok: boolean;
  reason?: string;
  serverInfo?: unknown;
  stderrTail?: string;
}

export interface CreateCodexAdapterOptions {
  spawn?: (...args: any[]) => any;
  spawnSync?: (...args: any[]) => any;
  binary?: string;
  now?: () => number;
  clientInfo?: CodexClientInfo;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
  // How long `cancel()` waits for the server to report the turn as interrupted before it
  // reports `confirmedStopped: false` and lets the dispatcher escalate to a human.
  interruptConfirmMs?: number;
  // Sessions must be visible in the Codex window. `ephemeral: true` writes no rollout at
  // all, so the app can never list the thread; `serviceName`/`threadSource` are what the
  // desktop app writes for its own threads, and one of them is how it recognises a
  // session it is allowed to show.
  persistThreads?: boolean;
  // Session stickiness: one thread per (agent, workspace) so successive turns of the
  // same executor continue the same conversation instead of starting a new one.
  sticky?: StickySessions | null;
  serviceName?: string;
  threadSource?: string;
  fsOps?: CodexFsOps;
}

export interface CodexAdapter extends RuntimeAdapter {
  kind: "codex";
  /** Close every app-server process this adapter owns (releases their thread locks). */
  dispose(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface PendingApproval {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

interface CodexSession {
  child: any;
  binaryInfo: { path: string; source: string; version: string | null };
  threadId: string | null;
  readonly turnId: string | null;
  eventQueue: AdapterEventEntry[];
  /**
   * Absolute cursor of the first event that belongs to the turn now running.
   *
   * A reused session still holds the previous turn's events, and its `turn/completed` is a
   * `ready` report — reporting it again would hand the new task the old turn's result in
   * milliseconds. Everything before this cursor is another turn's history.
   */
  turnFloor: number;
  pendingApprovals: Map<string, PendingApproval>;
  droppedEvents: number;
  droppedApprovals: number;
  unknownMethods: number;
  protocolError: string | null;
  stderrTail: string;
  pushEvent(entry: AdapterEventEntry): void;
  sendNotification(method: string, params?: unknown): void;
  sendRequest(method: string, params?: Record<string, unknown>): Promise<any>;
  waitForInterrupt(turnId: string | null, timeoutMs: number): Promise<boolean>;
  close(): void;
  isClosed(): boolean;
}

/**
 * Start one turn on an already-attached thread.
 *
 * A thread is owned by a single app-server process: a second process that calls
 * `thread/resume` on it gets `thread ... already has an active writer`. So "continue the
 * previous session" means reuse the live process, not spawn a new one next to it.
 */
async function beginTurnOn(
  session: CodexSession,
  threadId: string,
  req: any,
  summary: any,
  resolved: { path: string; source: string },
  version: string | null,
) {
  const promptText =
    req.prompt ??
    req.text ??
    summary.prompt ??
    summary.input?.prompt ??
    summary.input?.text ??
    JSON.stringify(summary.input ?? {});

  // Captured before the request so anything queued while it is in flight belongs to this turn;
  // the cursor is absolute, because a trimmed queue shifts the index space.
  const floorCursor = session.droppedEvents + session.eventQueue.length;
  const turnResp = await session.sendRequest("turn/start", {
    threadId,
    input: [{ type: "text", text: String(promptText) }],
  });
  session.turnFloor = floorCursor;
  const turnId = turnResp?.turn?.id ?? turnResp?.turnId ?? null;
  if (turnId) {
    session.pushEvent({
      adapterEventId: `codex:0:turn/start`,
      report: reportOf("progress", {
        observedMethod: "turn/start",
        turnId,
        evidence: { method: "turn/start", turnId },
      }),
    });
  }

  return {
    accepted: true,
    locator: {
      kind: "codex",
      threadId,
      turnId,
      binary: resolved.path,
      binarySource: resolved.source,
      ...(version ? { version } : {}),
    },
  };
}

const ALLOWED_CODEX_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "execCommandApproval",
  "applyPatchApproval",
  "request_approval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

function isAllowedCodexMethod(method: string): boolean {
  if (ALLOWED_CODEX_METHODS.has(method)) return true;
  if (method.startsWith("item/")) return true;
  if (method.endsWith("/request_approval") || method.endsWith("/requestApproval")) return true;
  return false;
}

function defaultIsReadable(filePath: string, fsOps: CodexFsOps): boolean {
  try {
    if (!fsOps.existsSync(filePath)) return false;
    fsOps.accessSync(filePath, fsConstants.R_OK);
    // Security (SEC-1): ensure resolved candidate is a regular, non-empty file so
    // 0-byte WindowsApps execution aliases and directories are skipped.
    if (typeof fsOps.statSync === "function") {
      const st = fsOps.statSync(filePath);
      if (!st || (typeof st.isFile === "function" && !st.isFile())) return false;
      if (typeof st.size !== "number" || !Number.isFinite(st.size) || st.size <= 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a real `codex.exe` binary without touching the 0-byte WindowsApps alias.
 */
export function resolveCodexBinary({
  explicitBinary = "",
  homedir = os.homedir(),
  fsOps = { existsSync, readdirSync, accessSync, statSync } as unknown as CodexFsOps,
}: ResolveCodexBinaryOptions = {}): CodexBinaryResolution {
  const checked: CodexBinaryCheck[] = [];
  const isReadable = (p: string) => defaultIsReadable(p, fsOps);

  if (typeof explicitBinary === "string" && explicitBinary.trim().length > 0) {
    const candidate = explicitBinary.trim();
    checked.push({ source: "explicit", path: candidate });
    if (isReadable(candidate)) {
      return { path: candidate, source: "explicit", checked };
    }
  }

  // Try `C:\Program Files\WindowsApps\OpenAI.Codex_*_x64__*\app\resources\codex.exe`
  try {
    const entries = fsOps.readdirSync(WINDOWS_APPS_ROOT);
    const matching = entries
      .filter((name) => /^OpenAI\.Codex_.*_x64__.*/i.test(name))
      .sort()
      .reverse();
    for (const dir of matching) {
      const candidate = join(WINDOWS_APPS_ROOT, dir, "app", "resources", "codex.exe");
      checked.push({ source: "windowsApps", path: candidate });
      if (isReadable(candidate)) {
        return { path: candidate, source: "windowsApps", checked };
      }
    }
  } catch {
    checked.push({ source: "windowsApps", path: WINDOWS_APPS_ROOT, unreadable: true });
  }

  // Fallback to `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`
  const sandboxBin = join(homedir, ".codex", ".sandbox-bin", "codex.exe");
  checked.push({ source: "sandboxBin", path: sandboxBin });
  if (isReadable(sandboxBin)) {
    return { path: sandboxBin, source: "sandboxBin", checked };
  }

  throw taskError(
    TASK_ERROR.ADAPTER_UNAVAILABLE,
    ADAPTER_FAILURE_MESSAGES.unavailable,
    { reason: "binary_not_found" },
  );
}

/**
 * 0.9.2（复核 NOTES）：探针原来只凭「二进制在、`--version` 能跑」就给六项控制全绿——那是自证，
 * 不是证据。真正能证明的是 app-server 肯回答一次 `initialize`：短握手一次，超时即当没有这回事，
 * 进程立刻收掉，不建 thread、不发 turn、不碰工作区。
 */
async function handshakeAppServer({
  spawn,
  path,
  clientInfo,
  timeoutMs = 4_000,
}: CodexHandshakeOptions): Promise<CodexHandshakeResult> {
  let child: any;
  try {
    child = spawn(path, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      ok: false,
      reason: code && typeof code === "string" ? code : "spawn_error",
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdoutBuf = "";
    let stderrTail = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const finish = (value: Omit<CodexHandshakeResult, "stderrTail">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end?.();
      } catch {
        // the child may already be gone
      }
      try {
        child.kill?.();
      } catch {
        // nothing left to kill
      }
      resolve({ ...value, stderrTail });
    };

    const timer = setTimeout(() => finish({ ok: false, reason: "handshake_timeout" }), timeoutMs);

    child.stdout?.on?.("data", (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
      let newline: number;
      while ((newline = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, newline).trim();
        stdoutBuf = stdoutBuf.slice(newline + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id !== 1) continue;
        if (msg.error) {
          finish({
            ok: false,
            reason: typeof msg.error.message === "string" ? msg.error.message : "initialize_failed",
          });
        } else {
          finish({ ok: true, serverInfo: msg.result?.serverInfo ?? null });
        }
      }
    });
    child.stderr?.on?.("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
      stderrTail = (stderrTail + text).slice(-MAX_STDERR_CHARS);
    });
    child.on?.("error", (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      finish({ ok: false, reason: typeof code === "string" ? code : "spawn_error" });
    });
    child.on?.("exit", (code: unknown) => finish({ ok: false, reason: `exited_${String(code)}` }));

    try {
      child.stdin?.write?.(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo } })}\n`,
      );
    } catch {
      finish({ ok: false, reason: "write_failed" });
    }
  });
}

/**
 * Create a Codex App Server adapter speaking newline-delimited JSON-RPC 2.0 on stdio.
 */
export function createCodexAdapter({
  spawn = childProcess.spawn,
  spawnSync = childProcess.spawnSync,
  binary: defaultBinary = "",
  now = Date.now,
  clientInfo,
  persistThreads = true,
  sticky = createStickySessions(),
  serviceName = "codex_work_desktop",
  threadSource = "user",
  requestTimeoutMs = 5_000,
  probeTimeoutMs = 4_000,
  interruptConfirmMs = 1_500,
  fsOps = { existsSync, readdirSync, accessSync, statSync } as unknown as CodexFsOps,
}: CreateCodexAdapterOptions = {}): CodexAdapter {
  // The service name is what the desktop app writes for its own threads; defaulting it to
  // `codex_work_desktop` makes a bridged session look like one the app is willing to list.
  const resolvedClientInfo: CodexClientInfo = clientInfo ?? { name: serviceName, version: "0.9.0" };
  const sessions = new Map<string, CodexSession>();

  function attachSession(child: any, binaryInfo: { path: string; source: string; version: string | null }): CodexSession {
    let nextId = 1;
    let stdoutBuf = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const pending = new Map<string | number, PendingRequest>();
    const eventQueue: AdapterEventEntry[] = [];
    // A cancel is only real when the server says the turn stopped. `turn/interrupt` merely
    // acknowledges the request, so `cancel()` waits on these waiters for the matching
    // `turn/completed` with `status: "interrupted"` instead of claiming the stop itself.
    const interruptWaiters = new Set<{ turnId: string | null; settle: (confirmed: boolean) => void }>();
    let latestTurnId: string | null = null;
    let closed = false;
    let eventSeq = 0;

    const session: CodexSession = {
      child,
      binaryInfo,
      threadId: null,
      get turnId() {
        return latestTurnId;
      },
      eventQueue,
      turnFloor: 0,
      pendingApprovals: new Map(),
      droppedEvents: 0,
      droppedApprovals: 0,
      unknownMethods: 0,
      protocolError: null,
      stderrTail: "",

      pushEvent(entry) {
        if (eventQueue.length >= MAX_EVENT_QUEUE) {
          eventQueue.shift();
          session.droppedEvents += 1;
        }
        eventQueue.push(entry);
      },

      sendNotification(method, params) {
        const line = JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
        child.stdin.write(`${line}\n`);
      },

      sendRequest(method, params = {}) {
        if (closed) {
          return Promise.reject(
            taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
              method,
              reason: "session_closed",
            }),
          );
        }
        const id = nextId;
        nextId += 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.timeout, {
                method,
                reason: "timeout",
              }),
            );
          }, requestTimeoutMs);
          // Deliberately not unref'd: a caller is awaiting this promise, and an unref'd timer
          // lets the event loop drain first, which surfaces as "Promise resolution is still
          // pending" instead of the timeout this code means to report.

          pending.set(id, { resolve, reject, timer, method });
          const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
          child.stdin.write(`${line}\n`);
        });
      },

      waitForInterrupt(turnId: string | null, timeoutMs: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
          const waiter = {
            turnId,
            settle: (confirmed: boolean) => {
              clearTimeout(timer);
              interruptWaiters.delete(waiter);
              resolve(confirmed);
            },
          };
          const timer = setTimeout(() => waiter.settle(false), Math.max(1, Math.floor(timeoutMs)));
          // Same reason as the request timeout: cancel() awaits this, so the timer must keep
          // the loop alive long enough to answer "did not confirm" instead of vanishing.
          interruptWaiters.add(waiter);
        });
      },

      close() {
        if (closed) return;
        closed = true;
        try {
          stdoutDecoder.end();
        } catch {
          // ignore
        }
        try {
          stderrDecoder.end();
        } catch {
          // ignore
        }
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(
            taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
              reason: "session_closed",
            }),
          );
        }
        pending.clear();
        try {
          child.kill?.();
        } catch {
          // best effort
        }
      },

      isClosed() {
        return closed;
      },
    };

    const failProtocol = (reasonCode: string) => {
      if (session.protocolError) return;
      session.protocolError = reasonCode;
      stdoutBuf = "";
      eventSeq += 1;
      session.pushEvent({
        adapterEventId: `codex:${eventSeq}:protocol_error`,
        report: reportOf("failed", {
          failureClass: "protocol_error",
          reason: ADAPTER_FAILURE_MESSAGES.rejected,
          evidence: { protocolError: true, code: reasonCode },
        }),
      });
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
            reason: "protocol_error",
          }),
        );
      }
      pending.clear();
      session.close();
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        failProtocol("invalid_frame");
        return;
      }
      if ("jsonrpc" in msg && msg.jsonrpc !== "2.0") {
        failProtocol("invalid_frame");
        return;
      }

      const hasId = "id" in msg && msg.id !== undefined;
      if (hasId && typeof msg.id !== "string" && !(typeof msg.id === "number" && Number.isFinite(msg.id))) {
        failProtocol("invalid_frame_id");
        return;
      }
      if ("params" in msg && msg.params !== undefined && (msg.params === null || typeof msg.params !== "object")) {
        failProtocol("invalid_params");
        return;
      }

      // Response to a pending client request
      if (hasId && msg.method === undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(
            taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.rejected, {
              method: entry.method,
              reason: "rpc_error",
            }),
          );
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }

      if ("method" in msg && msg.method !== undefined) {
        if (typeof msg.method !== "string" || msg.method.length === 0) {
          failProtocol("unsupported_method");
          return;
        }
        if (!isAllowedCodexMethod(msg.method)) {
          if (hasId) {
            failProtocol("unsupported_method");
          } else {
            session.unknownMethods += 1;
          }
          return;
        }
      }

      // Server-initiated approval request
      if (hasId && typeof msg.method === "string") {
        eventSeq += 1;
        const approvalId = String(msg.id);
        if (!session.pendingApprovals.has(approvalId) && session.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
          const oldestKey = session.pendingApprovals.keys().next().value;
          if (oldestKey !== undefined) {
            session.pendingApprovals.delete(oldestKey);
            session.droppedApprovals += 1;
          }
        }
        session.pendingApprovals.set(approvalId, { id: msg.id, method: msg.method, params: msg.params ?? {} });
        session.pushEvent({
          adapterEventId: `codex:${eventSeq}:${msg.method}`,
          report: reportOf("waiting", {
            observedMethod: msg.method,
            attention: {
              questionId: approvalId,
              kind: "approval",
              prompt: msg.params?.command || msg.params?.reason || `${msg.method} requires approval`,
              scope: msg.params ?? {},
            },
            evidence: { method: msg.method, serverRequestId: msg.id },
          }),
        });
        return;
      }

      // Notification
      if (typeof msg.method === "string") {
        eventSeq += 1;
        const params = msg.params ?? {};
        if (msg.method === "turn/started") {
          if (params.turn?.id) latestTurnId = params.turn.id;
          session.pushEvent({
            adapterEventId: `codex:${eventSeq}:turn/started`,
            report: reportOf("progress", {
              observedMethod: "turn/started",
              turnId: params.turn?.id ?? latestTurnId,
              evidence: { method: "turn/started", turnId: params.turn?.id ?? latestTurnId },
            }),
          });
        } else if (msg.method === "turn/completed") {
          const turn = params.turn ?? {};
          const status = turn.status ?? "completed";
          if (status === "interrupted") {
            // This is the only honest confirmation of a stop: settle the waiters so a
            // pending `cancel()` can report `confirmedStopped: true`.
            for (const waiter of [...interruptWaiters]) {
              if (waiter.turnId === null || waiter.turnId === (turn.id ?? latestTurnId)) waiter.settle(true);
            }
          }
          let report: AgentReport;
          if (status === "interrupted") {
            report = reportOf("dropped", {
              droppedBy: "cancelled",
              observedStatus: status,
              turnId: turn.id ?? latestTurnId,
              evidence: { method: "turn/completed", status, turnId: turn.id ?? latestTurnId },
            });
          } else if (status === "failed") {
            report = reportOf("failed", {
              failureClass: "runtime_error",
              observedStatus: status,
              reason: ADAPTER_FAILURE_MESSAGES.rejected,
              evidence: { method: "turn/completed", status },
            });
          } else {
            report = reportOf("ready", {
              observedStatus: status,
              result: { threadId: session.threadId, turnId: turn.id ?? latestTurnId, turn },
              resultValid: true,
              evidence: { method: "turn/completed", status, turnId: turn.id ?? latestTurnId },
            });
          }
          session.pushEvent({
            adapterEventId: `codex:${eventSeq}:turn/completed`,
            report,
          });
        } else if (msg.method.startsWith("item/")) {
          session.pushEvent({
            adapterEventId: `codex:${eventSeq}:${msg.method}`,
            report: reportOf("progress", {
              observedMethod: msg.method,
              item: params.item ?? params,
              evidence: { method: msg.method },
            }),
          });
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (closed || session.protocolError) return;
      stdoutBuf += Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk);
      if (stdoutBuf.length > MAX_FRAME_CHARS) {
        failProtocol("frame_exceeds_limit");
        return;
      }
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (closed || session.protocolError) break;
        handleLine(line);
      }
    });

    // Drain stderr into a bounded tail buffer so pipe backpressure cannot stall codex,
    // without printing or persisting stderr text into the task ledger.
    child.stderr?.on?.("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk);
      const combined = session.stderrTail + text;
      session.stderrTail =
        combined.length > MAX_STDERR_CHARS ? combined.slice(combined.length - MAX_STDERR_CHARS) : combined;
    });

    child.on?.("error", () => {
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
            reason: "spawn_error",
          }),
        );
      }
      pending.clear();
    });

    child.on?.("exit", (code: unknown, signal: unknown) => {
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
            reason: "process_exited",
            ...(Number.isInteger(code) ? { exitCode: code } : {}),
            ...(typeof signal === "string" && signal ? { signal } : {}),
          }),
        );
      }
      pending.clear();
    });

    return session;
  }

  const adapter: CodexAdapter = {
    kind: "codex",

    async probe() {
      const startedAt = now();
      // Security (SEC-1): ignore any caller-supplied binary; only trusted plugin config or built-in discovery applies.
      const explicit = typeof defaultBinary === "string" ? defaultBinary.trim() : "";
      let resolved: CodexBinaryResolution;
      try {
        resolved = resolveCodexBinary({ explicitBinary: explicit, fsOps });
      } catch (error: unknown) {
        return {
          ok: false,
          reason: sanitizeAdapterFailure(error).message,
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }

      let version: string | null = null;
      if (typeof spawnSync === "function") {
        try {
          const out = spawnSync(resolved.path, ["--version"], { encoding: "utf8", timeout: 3_000 });
          if (out?.status === 0 && typeof out.stdout === "string") {
            version = out.stdout.trim();
          }
        } catch {
          version = null;
        }
      }

      const handshake: CodexHandshakeResult =
        typeof spawn === "function"
          ? await handshakeAppServer({ spawn, path: resolved.path, clientInfo: resolvedClientInfo, timeoutMs: probeTimeoutMs })
          : { ok: false, reason: "no_spawn" };

      if (!handshake.ok) {
        return {
          ok: false,
          binary: resolved.path,
          source: resolved.source,
          version,
          reason: handshake.reason,
          ...(handshake.stderrTail ? { stderrTail: handshake.stderrTail } : {}),
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }

      return {
        ok: true,
        binary: resolved.path,
        source: resolved.source,
        version,
        handshake: "initialize",
        serverInfo: handshake.serverInfo ?? null,
        elapsedMs: Math.max(0, now() - startedAt),
        // 握手只证明「它按我们说的协议应答」。approval 另算：codex 的审批语义我们从未在真机
        // 验过，这里给 false，让能力卡如实停在未证实，而不是跟着二进制一起变绿。
        controls: {
          start: true,
          steer: true,
          cancel: true,
          inspect: true,
          events: true,
          approval: false,
        },
      };
    },

    async start(arg1, arg2) {
      const req = arg2 ?? arg1 ?? {};
      const task = req.task ?? {};
      const agent = req.agent ?? {};
      const workspace = req.workspace ?? {};
      const summary = task.requestSummary ?? task.request_summary ?? {};
      const adapterConfig = agent.adapterConfig ?? agent.adapter_config ?? {};

      // Security (SEC-1): executable selection MUST come exclusively from trusted plugin config
      // (`tasksAdapters.codex.binary` -> `defaultBinary`) or built-in discovery; never honor
      // `req.binary` or RPC-registered `agent.adapterConfig.binary`.
      const explicit = typeof defaultBinary === "string" ? defaultBinary.trim() : "";
      const resolved = explicit
        ? { path: explicit, source: "explicit" }
        : resolveCodexBinary({ fsOps });

      let version: string | null = null;
      if (typeof spawnSync === "function") {
        try {
          const v = spawnSync(resolved.path, ["--version"], { encoding: "utf8", timeout: 3_000 });
          if (v?.status === 0 && typeof v.stdout === "string") version = v.stdout.trim();
        } catch {
          version = null;
        }
      }

      // Which session does this agent+workspace already own? If its app-server is still
      // running, the thread lives there and a second process must not try to take it.
      const stickyKey = {
        kind: "codex",
        agentId: String(agent.agentId ?? ""),
        workspaceId: String(workspace.workspaceId ?? workspace.workspace_id ?? workspace.rootPath ?? workspace.root_path ?? ""),
      };
      const stickyUsable = stickyKey.agentId.length > 0 && stickyKey.workspaceId.length > 0;
      const rememberedEarly = stickyUsable && sticky ? sticky.get(stickyKey) : null;
      const liveSession = rememberedEarly ? sessions.get(rememberedEarly) : null;
      if (liveSession && !liveSession.isClosed() && liveSession.threadId) {
        return await beginTurnOn(liveSession, liveSession.threadId, req, summary, resolved, version);
      }

      let child: any;
      try {
        child = spawn(resolved.path, ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error: unknown) {
        const code = (error as { code?: unknown } | null)?.code;
        throw taskError(
          TASK_ERROR.ADAPTER_UNAVAILABLE,
          ADAPTER_FAILURE_MESSAGES.unavailable,
          { reason: code && typeof code === "string" ? code : "spawn_error" },
        );
      }

      const session = attachSession(child, { ...resolved, version });

      try {
        await session.sendRequest("initialize", { clientInfo: resolvedClientInfo });
        session.sendNotification("initialized");

        const cwd = req.cwd ?? workspace.rootPath ?? workspace.root_path ?? process.cwd();
        const model = req.model ?? summary.model ?? adapterConfig.model ?? undefined;
        // Session stickiness: if this agent already has a thread in this workspace, continue
        // it. `thread/resume` fails when the thread was archived or removed, and that failure
        // is a normal outcome rather than an error — fall through to a fresh thread.
        // (`stickyKey`/`stickyUsable` are computed before the spawn: a live session for the
        // remembered thread is reused there instead of being fought over.)
        let threadId: string | null = null;
        let resumed = false;
        if (stickyUsable && sticky) {
          const remembered = sticky.get(stickyKey);
          if (remembered) {
            try {
              const resumedResp = await session.sendRequest("thread/resume", { threadId: remembered });
              const resumedId = resumedResp?.thread?.id ?? resumedResp?.threadId ?? remembered;
              if (typeof resumedId === "string" && resumedId.length > 0) {
                threadId = resumedId;
                resumed = true;
                session.threadId = resumedId;
              }
            } catch {
              sticky.forget(stickyKey);
            }
          }
        }
        // An `ephemeral: true` thread is never written to `~/.codex/sessions`, so the
        // desktop app cannot list it. Persistent threads record the rollout plus a row in
        // `state_5.sqlite`, together with the service name the app uses for its own work.
        if (!threadId) {
          const threadResp = await session.sendRequest("thread/start", {
            cwd,
            ...(model ? { model } : {}),
            threadSource,
            ...(persistThreads ? {} : { ephemeral: true }),
          });
          const created = threadResp?.thread?.id ?? threadResp?.threadId;
          threadId = typeof created === "string" && created.length > 0 ? created : null;
        }
        if (stickyUsable && sticky && threadId && !resumed) sticky.remember(stickyKey, threadId);
        if (!threadId) {
          throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
            reason: "missing_thread_id",
          });
        }
        session.threadId = threadId;
        sessions.set(threadId, session);
        // Keep the pool bounded: an idle process is a lock on its thread, not a free resource.
        while (sessions.size > MAX_OPEN_SESSIONS) {
          const oldest = sessions.keys().next();
          if (oldest.done) break;
          sessions.get(oldest.value)?.close();
          sessions.delete(oldest.value);
        }

        return await beginTurnOn(session, threadId, req, summary, resolved, version);
      } catch (error) {
        session.close();
        throw error;
      }
    },

    async inspect(arg1, arg2) {
      const input = arg2 ?? arg1 ?? {};
      const locator = input.locator ?? input;
      const threadId = locator?.threadId;
      const session = threadId ? sessions.get(threadId) : null;
      if (!session) {
        return reportOf("blocked", {
          observedStatus: "SESSION_NOT_ATTACHED",
          reason: `codex session not attached for thread ${threadId}`,
          evidence: { threadId },
        });
      }
      // Only this turn's events may answer for this task; the previous turn's completion is
      // still in the queue when a live session is reused.
      const fromFloor = Math.max(0, session.turnFloor - session.droppedEvents);
      const own = session.eventQueue.slice(fromFloor);
      if (own.length > 0) {
        // own.length > 0 checked immediately above.
        return (own[own.length - 1] as AdapterEventEntry).report!;
      }
      return reportOf("progress", {
        observedStatus: "inProgress",
        turnId: session.turnId ?? locator?.turnId ?? null,
        evidence: { threadId, turnId: session.turnId ?? locator?.turnId ?? null },
      });
    },

    async sendInput(arg1, arg2, arg3) {
      const locator = arg3 ? arg2 : arg1?.locator ?? arg1;
      const inputObj = arg3 ?? arg2 ?? {};
      const threadId = locator?.threadId;
      const session = threadId ? sessions.get(threadId) : null;
      if (!session) {
        throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
          reason: "session_not_attached",
        });
      }
      const text = typeof inputObj === "string" ? inputObj : inputObj?.text ?? "";
      const expectedTurnId = inputObj?.expectedTurnId ?? session.turnId ?? locator?.turnId;
      const resp = await session.sendRequest("turn/steer", {
        threadId,
        ...(expectedTurnId ? { expectedTurnId } : {}),
        input: [{ type: "text", text: String(text) }],
      });
      return { accepted: true, threadId, turnId: resp?.turnId ?? expectedTurnId ?? null };
    },

    async cancel(arg1, arg2) {
      const input = arg2 ?? arg1 ?? {};
      const locator = input.locator ?? input;
      const threadId = locator?.threadId;
      const session = threadId ? sessions.get(threadId) : null;
      if (!session) {
        throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
          reason: "session_not_attached",
        });
      }
      const turnId = input.turnId ?? session.turnId ?? locator?.turnId;
      await session.sendRequest("turn/interrupt", {
        threadId,
        ...(turnId ? { turnId } : {}),
      });
      // `turn/interrupt` only acknowledges the request. The stop is real when the server
      // reports the turn as interrupted, so wait a bounded moment for that notification
      // instead of either lying (`true`) or giving up immediately (`false`, which makes the
      // dispatcher escalate every cancel to a human).
      const confirmedStopped = await session.waitForInterrupt(turnId ?? null, interruptConfirmMs);
      return { requestAccepted: true, confirmedStopped, threadId, turnId: turnId ?? null };
    },

    async events(arg1, arg2, arg3) {
      let locator: any;
      let cursor: any;
      if (arg3 !== undefined) {
        locator = arg2?.locator ?? arg2;
        cursor = arg3;
      } else if (typeof arg2 === "number") {
        locator = arg1?.locator ?? arg1;
        cursor = arg2;
      } else {
        locator = arg1?.locator ?? arg1;
        cursor = arg2?.cursor ?? arg1?.cursor ?? 0;
      }
      const threadId = locator?.threadId;
      const session = threadId ? sessions.get(threadId) : null;
      if (!session) {
        return { events: [], nextCursor: cursor, droppedEvents: 0, droppedApprovals: 0 };
      }
      const rawCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
      // A fresh attempt asks from 0, but a reused session still holds earlier turns; replaying
      // them would let the previous `turn/completed` answer for this task.
      const cursorAtLeastFloor = Math.max(rawCursor, session.turnFloor);
      const offset = Math.max(0, cursorAtLeastFloor - session.droppedEvents);
      const sliced = session.eventQueue.slice(offset);
      return {
        events: sliced,
        nextCursor: session.droppedEvents + session.eventQueue.length,
        droppedEvents: session.droppedEvents,
        droppedApprovals: session.droppedApprovals,
        unknownMethods: session.unknownMethods,
        ...(session.protocolError ? { protocolError: session.protocolError } : {}),
      };
    },

    async decideApproval(arg1, arg2, arg3) {
      const locator = arg3 ? arg2 : arg1?.locator ?? arg1;
      const decision = arg3 ?? arg2 ?? {};
      const threadId = locator?.threadId;
      const session = threadId ? sessions.get(threadId) : null;
      if (!session) {
        throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
          reason: "session_not_attached",
        });
      }
      const approvalId = String(decision.approvalId ?? "");
      const pendingReq = session.pendingApprovals.get(approvalId);
      if (!pendingReq) {
        return { accepted: false, reason: "approval_not_found" };
      }
      session.pendingApprovals.delete(approvalId);
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: pendingReq.id,
        result: { decision: decision.decision === "allow-once" ? "accept" : "decline" },
      });
      session.child.stdin.write(`${line}\n`);
      return { accepted: true, threadId, approvalId };
    },

    /**
     * Release every app-server process this adapter owns. A thread's store lock lives in its
     * process, so leaving them running keeps those threads un-resumable for everyone else.
     */
    async dispose() {
      for (const [threadId, session] of sessions) {
        session.close();
        sessions.delete(threadId);
      }
    },
  };

  return validateAdapter(adapter);
}
