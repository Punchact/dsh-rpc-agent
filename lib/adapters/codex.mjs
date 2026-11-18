// Codex App Server adapter (§8.1): newline-delimited JSON-RPC 2.0 over stdio.
// Binary discovery avoids the 0-byte WindowsApps execution alias and accepts
// injected `spawn` / `spawnSync` so tests stay completely hermetic.

import * as childProcess from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { TASK_ERROR, taskError } from "../tasks/errors.mjs";
import { ADAPTER_FAILURE_MESSAGES, reportOf, sanitizeAdapterFailure, validateAdapter } from "./base.mjs";

const WINDOWS_APPS_ROOT = "C:\\Program Files\\WindowsApps";
export const MAX_FRAME_CHARS = 4 * 1024 * 1024;
export const MAX_EVENT_QUEUE = 500;
const MAX_STDERR_CHARS = 4096;

function defaultIsReadable(filePath, fsOps) {
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
  fsOps = { existsSync, readdirSync, accessSync, statSync },
} = {}) {
  const checked = [];
  const isReadable = (p) => defaultIsReadable(p, fsOps);

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
 * Create a Codex App Server adapter speaking newline-delimited JSON-RPC 2.0 on stdio.
 */
export function createCodexAdapter({
  spawn = childProcess.spawn,
  spawnSync = childProcess.spawnSync,
  binary: defaultBinary = "",
  now = Date.now,
  clientInfo = { name: "dsh-task-hub", version: "0.9.0" },
  requestTimeoutMs = 5_000,
  fsOps = { existsSync, readdirSync, accessSync, statSync },
} = {}) {
  const sessions = new Map();

  function attachSession(child, binaryInfo) {
    let nextId = 1;
    let stdoutBuf = "";
    const pending = new Map();
    const eventQueue = [];
    let latestTurnId = null;
    let closed = false;
    let eventSeq = 0;

    const session = {
      child,
      binaryInfo,
      threadId: null,
      get turnId() {
        return latestTurnId;
      },
      eventQueue,
      pendingApprovals: new Map(),
      droppedEvents: 0,
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
          if (typeof timer.unref === "function") timer.unref();

          pending.set(id, { resolve, reject, timer, method });
          const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
          child.stdin.write(`${line}\n`);
        });
      },

      close() {
        if (closed) return;
        closed = true;
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
    };

    const failProtocol = (reasonCode) => {
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

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        return;
      }

      // Response to a pending client request
      if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
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

      // Server-initiated approval request
      if (msg.id !== undefined && typeof msg.method === "string") {
        eventSeq += 1;
        const approvalId = String(msg.id);
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
          let report;
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

    child.stdout.on("data", (chunk) => {
      if (closed || session.protocolError) return;
      stdoutBuf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
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
    child.stderr?.on?.("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
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

    child.on?.("exit", (code, signal) => {
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

  const adapter = {
    kind: "codex",

    async probe() {
      const startedAt = now();
      // Security (SEC-1): ignore any caller-supplied binary; only trusted plugin config or built-in discovery applies.
      const explicit = typeof defaultBinary === "string" ? defaultBinary.trim() : "";
      let resolved;
      try {
        resolved = resolveCodexBinary({ explicitBinary: explicit, fsOps });
      } catch (error) {
        return {
          ok: false,
          reason: sanitizeAdapterFailure(error).message,
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }

      let version = null;
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

      return {
        ok: true,
        binary: resolved.path,
        source: resolved.source,
        version,
        elapsedMs: Math.max(0, now() - startedAt),
        controls: {
          start: true,
          steer: true,
          cancel: true,
          inspect: true,
          events: true,
          approval: true,
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

      let version = null;
      if (typeof spawnSync === "function") {
        try {
          const v = spawnSync(resolved.path, ["--version"], { encoding: "utf8", timeout: 3_000 });
          if (v?.status === 0 && typeof v.stdout === "string") version = v.stdout.trim();
        } catch {
          version = null;
        }
      }

      let child;
      try {
        child = spawn(resolved.path, ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        throw taskError(
          TASK_ERROR.ADAPTER_UNAVAILABLE,
          ADAPTER_FAILURE_MESSAGES.unavailable,
          { reason: error?.code && typeof error.code === "string" ? error.code : "spawn_error" },
        );
      }

      const session = attachSession(child, { ...resolved, version });

      try {
        await session.sendRequest("initialize", { clientInfo });
        session.sendNotification("initialized");

        const cwd = req.cwd ?? workspace.rootPath ?? workspace.root_path ?? process.cwd();
        const model = req.model ?? summary.model ?? adapterConfig.model ?? undefined;
        const threadResp = await session.sendRequest("thread/start", {
          cwd,
          ...(model ? { model } : {}),
          ephemeral: true,
        });
        const threadId = threadResp?.thread?.id ?? threadResp?.threadId;
        if (!threadId) {
          throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
            reason: "missing_thread_id",
          });
        }
        session.threadId = threadId;
        sessions.set(threadId, session);

        const promptText =
          req.prompt ??
          req.text ??
          summary.prompt ??
          summary.input?.prompt ??
          summary.input?.text ??
          JSON.stringify(summary.input ?? {});

        const turnResp = await session.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: String(promptText) }],
        });
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
      if (session.eventQueue.length > 0) {
        return session.eventQueue[session.eventQueue.length - 1].report;
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
      // `turn/interrupt` only acknowledges the request: the stop is confirmed when the
      // server reports the turn as interrupted, so never claim it here.
      return { requestAccepted: true, confirmedStopped: false, threadId, turnId: turnId ?? null };
    },

    async events(arg1, arg2, arg3) {
      let locator;
      let cursor;
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
        return { events: [], nextCursor: cursor, droppedEvents: 0 };
      }
      const rawCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
      const offset = Math.max(0, rawCursor - session.droppedEvents);
      const sliced = session.eventQueue.slice(offset);
      return {
        events: sliced,
        nextCursor: session.droppedEvents + session.eventQueue.length,
        droppedEvents: session.droppedEvents,
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
  };

  return validateAdapter(adapter);
}
