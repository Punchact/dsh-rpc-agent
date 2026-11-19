// Antigravity Language Server adapter (§8.1).
// Reads daemon descriptors from `%USERPROFILE%\.gemini\antigravity\daemon\hub_*.json`
// at call time and never persists or logs `csrfToken`.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { TASK_ERROR, taskError } from "../tasks/errors.mjs";
import {
  ADAPTER_FAILURE_MESSAGES,
  type AgentReport,
  type RuntimeAdapter,
  reportOf,
  sanitizeAdapterFailure,
  validateAdapter,
} from "./base.mjs";

export const DEFAULT_ANTIGRAVITY_MODEL = "MODEL_PLACEHOLDER_M525";
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_CHARS = 1_000_000;
const SERVICE_PREFIX = "exa.language_server_pb.LanguageServerService";

export interface AntigravityFsOps {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: BufferEncoding): string;
  statSync(path: string): { mtimeMs?: number };
}

export interface CreateAntigravityAdapterOptions {
  fetch?: typeof globalThis.fetch;
  daemonDir?: string;
  isPidAlive?: (pid: unknown) => boolean;
  now?: () => number;
  defaultModel?: string;
  projectId?: string;
  timeoutMs?: number;
  maxResponseChars?: number;
  fsOps?: AntigravityFsOps;
}

export interface AntigravityAdapter extends RuntimeAdapter {
  kind: "antigravity";
}

interface DaemonDescriptor {
  file: string;
  mtimeMs: number;
  pid: number;
  httpPort: number;
  httpsPort: number | null;
  lsVersion: string;
  csrfToken: string;
}

function defaultIsPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as { code?: unknown } | null)?.code === "EPERM";
  }
}

function toWorkspaceUri(rawPath: unknown): string | null {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("file://")) return trimmed;
  // Format Windows drive letter consistently as `file:///c%3A/...`
  const url = pathToFileURL(trimmed).href;
  return url.replace(/^file:\/\/\/([A-Za-z]):/, (_m, drive: string) => `file:///${drive.toLowerCase()}%3A`);
}

function parseJsonSafe(text: unknown): any {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Create an Antigravity adapter bound to local hub descriptors and `fetch`.
 */
export function createAntigravityAdapter({
  fetch = globalThis.fetch,
  daemonDir = join(os.homedir(), ".gemini", "antigravity", "daemon"),
  isPidAlive = defaultIsPidAlive,
  now = Date.now,
  defaultModel = DEFAULT_ANTIGRAVITY_MODEL,
  projectId: defaultProjectId = "",
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS,
  fsOps = { readdirSync, readFileSync, statSync } as unknown as AntigravityFsOps,
}: CreateAntigravityAdapterOptions = {}): AntigravityAdapter {
  const effectiveTimeoutMs =
    Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RPC_TIMEOUT_MS;
  const effectiveMaxChars =
    Number.isInteger(maxResponseChars) && maxResponseChars > 0
      ? maxResponseChars
      : DEFAULT_MAX_RESPONSE_CHARS;

  function findAliveDescriptor(): DaemonDescriptor {
    let entries: string[];
    try {
      entries = fsOps.readdirSync(daemonDir);
    } catch (error: unknown) {
      const msg = (error as { message?: unknown } | null)?.message ?? error;
      const err = taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        ADAPTER_FAILURE_MESSAGES.unavailable,
        { reason: "daemon_dir_unreadable" },
      );
      Object.defineProperty(err, "internalDetail", {
        value: `antigravity daemon directory unavailable (${daemonDir}): ${msg}`,
        enumerable: false,
      });
      throw err;
    }

    const candidates: DaemonDescriptor[] = [];
    for (const name of entries) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const fullPath = join(daemonDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fsOps.statSync(fullPath).mtimeMs ?? 0;
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = fsOps.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseJsonSafe(raw);
      if (!parsed || !Number.isInteger(parsed.httpPort) || typeof parsed.csrfToken !== "string" || !parsed.csrfToken) {
        continue;
      }
      if (!isPidAlive(parsed.pid)) continue;
      candidates.push({
        file: name,
        mtimeMs,
        pid: parsed.pid,
        httpPort: parsed.httpPort,
        httpsPort: parsed.httpsPort ?? null,
        lsVersion: parsed.lsVersion ?? "unknown",
        csrfToken: parsed.csrfToken,
      });
    }

    if (candidates.length === 0) {
      const err = taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        ADAPTER_FAILURE_MESSAGES.unavailable,
        { reason: "no_alive_hub" },
      );
      Object.defineProperty(err, "internalDetail", {
        value: `no alive Antigravity LanguageServer daemon descriptor found in ${daemonDir}`,
        enumerable: false,
      });
      throw err;
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.pid - a.pid);
    return candidates[0];
  }

  async function callRpc(descriptor: DaemonDescriptor, method: string, bodyObj?: Record<string, unknown>): Promise<any> {
    if (typeof fetch !== "function") {
      throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
        reason: "fetch_missing",
      });
    }
    const url = `http://127.0.0.1:${descriptor.httpPort}/${SERVICE_PREFIX}/${method}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": descriptor.csrfToken,
          Origin: "http://127.0.0.1",
        },
        body: JSON.stringify(bodyObj ?? {}),
        redirect: "error",
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } catch (error: unknown) {
      const errObj = (error && typeof error === "object" ? error : {}) as {
        name?: unknown;
        code?: unknown;
        message?: unknown;
      };
      const timedOut =
        errObj.name === "TimeoutError" || errObj.name === "AbortError" || errObj.code === "ETIMEDOUT";
      const err = taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        timedOut ? ADAPTER_FAILURE_MESSAGES.timeout : ADAPTER_FAILURE_MESSAGES.unavailable,
        { method, reason: timedOut ? "timeout" : "transport_error" },
      );
      Object.defineProperty(err, "internalDetail", {
        value: `antigravity RPC ${method} transport error: ${errObj.message ?? error}`,
        enumerable: false,
      });
      throw err;
    }

    let text: string;
    try {
      text = await res.text();
    } catch (error: unknown) {
      const msg = (error as { message?: unknown } | null)?.message ?? error;
      const err = taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.unavailable, {
        method,
        reason: "body_read_error",
      });
      Object.defineProperty(err, "internalDetail", {
        value: `antigravity RPC ${method} body read error: ${msg}`,
        enumerable: false,
      });
      throw err;
    }
    if (typeof text === "string" && text.length > effectiveMaxChars) {
      throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, ADAPTER_FAILURE_MESSAGES.rejected, {
        method,
        reason: "response_too_large",
      });
    }
    const parsed = parseJsonSafe(text);
    if (!res.ok) {
      throw taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        ADAPTER_FAILURE_MESSAGES.rejected,
        { method, httpStatus: res.status, reason: "rpc_http_error" },
      );
    }
    return parsed ?? {};
  }

  async function resolveModelEnum(
    descriptor: DaemonDescriptor,
    requestedModelId: string | null | undefined,
  ): Promise<{ model: string; warning: string | null }> {
    if (typeof requestedModelId === "string" && requestedModelId.startsWith("MODEL_PLACEHOLDER_")) {
      return { model: requestedModelId, warning: null };
    }
    let configs: any[] = [];
    try {
      const data = await callRpc(descriptor, "GetCascadeModelConfigData", {});
      configs = Array.isArray(data?.clientModelConfigs) ? data.clientModelConfigs : [];
    } catch (error: unknown) {
      const safe = sanitizeAdapterFailure(error);
      return {
        model: defaultModel,
        warning: `GetCascadeModelConfigData failed (${safe.message}); fell back to ${defaultModel}`,
      };
    }

    if (requestedModelId) {
      const target = requestedModelId.trim().toLowerCase();
      for (const entry of configs) {
        const enumVal = entry?.modelOrAlias?.model;
        if (typeof enumVal !== "string" || !enumVal) continue;
        const candidates = [
          entry?.modelId,
          entry?.modelOrAlias?.modelId,
          entry?.alias,
          entry?.label,
          enumVal,
        ]
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toLowerCase());
        if (candidates.includes(target)) {
          return { model: enumVal, warning: null };
        }
      }
      return {
        model: defaultModel,
        warning: `model "${requestedModelId}" not found in GetCascadeModelConfigData; fell back to ${defaultModel}`,
      };
    }

    return { model: defaultModel, warning: null };
  }

  function mapStatusToReport(cascadeId: string, summary: any, steps: any[]): AgentReport {
    const observedStatus: string = summary?.status ?? "CASCADE_RUN_STATUS_UNKNOWN";
    const termReason = summary?.latestExecutorTerminationReason ?? null;
    const stepCount = summary?.stepCount ?? (Array.isArray(steps) ? steps.length : 0);

    if (
      observedStatus === "CASCADE_RUN_STATUS_RUNNING" ||
      observedStatus === "CASCADE_RUN_STATUS_BUSY" ||
      observedStatus === "CASCADE_RUN_STATUS_CANCELING"
    ) {
      return reportOf("progress", {
        observedStatus,
        stepCount,
        latestExecutorTerminationReason: termReason,
        message: `${observedStatus} (${stepCount} steps)`,
        evidence: { observedStatus, stepCount, latestExecutorTerminationReason: termReason },
      });
    }

    if (observedStatus === "CASCADE_RUN_STATUS_IDLE") {
      if (termReason === "EXECUTOR_TERMINATION_REASON_USER_CANCELED") {
        return reportOf("dropped", {
          droppedBy: "cancelled",
          observedStatus,
          latestExecutorTerminationReason: termReason,
          reason: termReason,
          evidence: { observedStatus, latestExecutorTerminationReason: termReason, stepCount },
        });
      }
      return reportOf("ready", {
        observedStatus,
        latestExecutorTerminationReason: termReason,
        result: {
          cascadeId,
          stepCount,
          steps: Array.isArray(steps)
            ? steps.map((s, index) => ({ index, type: s.type, status: s.status }))
            : [],
        },
        resultValid: true,
        evidence: { observedStatus, stepCount, latestExecutorTerminationReason: termReason },
      });
    }

    if (observedStatus === "CASCADE_RUN_STATUS_ERROR" || /ERROR/i.test(observedStatus)) {
      return reportOf("failed", {
        failureClass: "runtime_error",
        observedStatus,
        reason: termReason ?? observedStatus,
        evidence: { observedStatus, latestExecutorTerminationReason: termReason, stepCount },
      });
    }

    return reportOf("blocked", {
      observedStatus,
      reason: `unrecognized Antigravity status: ${observedStatus}`,
      evidence: { observedStatus, latestExecutorTerminationReason: termReason, stepCount },
    });
  }

  const adapter: AntigravityAdapter = {
    kind: "antigravity",

    async probe() {
      const startedAt = now();
      try {
        const descriptor = findAliveDescriptor();
        await callRpc(descriptor, "GetAllCascadeTrajectories", {});
        return {
          ok: true,
          version: descriptor.lsVersion,
          httpPort: descriptor.httpPort,
          elapsedMs: Math.max(0, now() - startedAt),
          controls: {
            start: true,
            steer: true,
            cancel: true,
            inspect: true,
            events: true,
            approval: false,
          },
        };
      } catch (error: unknown) {
        return {
          ok: false,
          reason: sanitizeAdapterFailure(error).message,
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }
    },

    async start(arg1, arg2) {
      const req = arg2 ?? arg1 ?? {};
      const task = req.task ?? {};
      const agent = req.agent ?? {};
      const workspace = req.workspace ?? {};
      const summary = task.requestSummary ?? task.request_summary ?? {};
      const adapterConfig = agent.adapterConfig ?? agent.adapter_config ?? {};

      const descriptor = findAliveDescriptor();
      const cascadeId: string = req.cascadeId ?? randomUUID();

      const wsPath = req.workspacePath ?? workspace.rootPath ?? workspace.root_path ?? "";
      const wsUri = toWorkspaceUri(wsPath);
      const workspaceUris = req.workspaceUris ?? (wsUri ? [wsUri] : []);
      const projectId =
        req.projectId ??
        summary.projectId ??
        summary.input?.projectId ??
        adapterConfig.projectId ??
        defaultProjectId;
      const title =
        req.title ??
        summary.title ??
        (task.taskId ? `DSH Task ${task.taskId}` : `DSH Cascade ${cascadeId.slice(0, 8)}`);

      const startBody: Record<string, unknown> = {
        cascadeId,
        source: "CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE",
        workspaceUris,
        title,
      };
      if (typeof projectId === "string" && projectId.trim().length > 0) {
        startBody.projectEnvConfig = { projectId: projectId.trim() };
      }

      await callRpc(descriptor, "StartCascade", startBody);

      const requestedModelId =
        req.model ?? summary.model ?? summary.input?.model ?? adapterConfig.model ?? null;
      const { model, warning } = await resolveModelEnum(descriptor, requestedModelId);

      const promptText =
        req.prompt ??
        req.text ??
        summary.prompt ??
        summary.input?.prompt ??
        summary.input?.text ??
        JSON.stringify(summary.input ?? {});

      await callRpc(descriptor, "SendUserCascadeMessage", {
        cascadeId,
        items: [{ text: String(promptText) }],
        cascadeConfig: {
          plannerConfig: {
            requestedModel: { model },
          },
        },
      });

      // Locator intentionally omits csrfToken; subsequent calls resolve descriptor dynamically.
      return {
        accepted: true,
        locator: {
          kind: "antigravity",
          cascadeId,
          httpPort: descriptor.httpPort,
          lsVersion: descriptor.lsVersion,
          model,
        },
        ...(warning ? { warning } : {}),
      };
    },

    async inspect(arg1, arg2) {
      const input = arg2 ?? arg1 ?? {};
      const locator = input.locator ?? input;
      const cascadeId = locator?.cascadeId;
      if (typeof cascadeId !== "string" || !cascadeId) {
        return reportOf("blocked", {
          observedStatus: "MISSING_LOCATOR",
          reason: "locator.cascadeId is required for Antigravity inspect",
        });
      }

      const descriptor = findAliveDescriptor();
      const [allTraj, stepsResp] = await Promise.all([
        callRpc(descriptor, "GetAllCascadeTrajectories", {}),
        callRpc(descriptor, "GetCascadeTrajectorySteps", { cascadeId }),
      ]);
      const summary = allTraj?.trajectorySummaries?.[cascadeId] ?? null;
      const steps = Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
      return mapStatusToReport(cascadeId, summary, steps);
    },

    async sendInput(arg1, arg2, arg3) {
      const locator = arg3 ? arg2 : arg1?.locator ?? arg1;
      const inputObj = arg3 ?? arg2 ?? {};
      const cascadeId = locator?.cascadeId;
      const text = typeof inputObj === "string" ? inputObj : inputObj?.text ?? "";
      const descriptor = findAliveDescriptor();
      const { model } = await resolveModelEnum(descriptor, locator?.model ?? null);

      await callRpc(descriptor, "SendUserCascadeMessage", {
        cascadeId,
        items: [{ text: String(text) }],
        cascadeConfig: {
          plannerConfig: {
            requestedModel: { model },
          },
        },
      });
      return { accepted: true, cascadeId };
    },

    async cancel(arg1, arg2) {
      const input = arg2 ?? arg1 ?? {};
      const locator = input.locator ?? input;
      const cascadeId = locator?.cascadeId;
      if (typeof cascadeId !== "string" || !cascadeId) {
        throw taskError(TASK_ERROR.VALIDATION_FAILED, "locator.cascadeId is required for cancel");
      }
      const descriptor = findAliveDescriptor();
      // Always use ForceStopCascadeTree to stop parent + sub-agent tree (never CancelCascadeSteps).
      const resp = await callRpc(descriptor, "ForceStopCascadeTree", {
        conversationId: cascadeId,
      });
      const stoppedConversationIds: string[] = Array.isArray(resp?.stoppedConversationIds)
        ? resp.stoppedConversationIds
        : [];
      return {
        requestAccepted: true,
        cascadeId,
        stoppedConversationIds,
        // Only the echoed id proves the stop; a 200 alone does not.
        confirmedStopped: stoppedConversationIds.includes(cascadeId),
      };
    },

    async events(arg1, arg2, arg3) {
      const locator = arg3 !== undefined ? arg2 : arg1?.locator ?? arg1;
      const cursor = arg3 ?? arg2?.cursor ?? 0;
      const cascadeId = locator?.cascadeId;
      const descriptor = findAliveDescriptor();
      const [allTraj, stepsResp] = await Promise.all([
        callRpc(descriptor, "GetAllCascadeTrajectories", {}),
        callRpc(descriptor, "GetCascadeTrajectorySteps", { cascadeId }),
      ]);
      const summary = allTraj?.trajectorySummaries?.[cascadeId] ?? null;
      const steps: any[] = Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
      const report = mapStatusToReport(cascadeId, summary, steps);
      const startIndex = typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
      const sliced = steps.slice(startIndex).map((step, offset) => ({
        adapterEventId: `${cascadeId}:step:${startIndex + offset}:${step.status ?? ""}`,
        stepIndex: startIndex + offset,
        type: step.type,
        status: step.status,
      }));
      return {
        events: sliced,
        report,
        nextCursor: steps.length,
      };
    },

    async decideApproval(arg1, arg2, arg3) {
      const locator = arg3 ? arg2 : arg1?.locator ?? arg1;
      const decision = arg3 ?? arg2 ?? {};
      const cascadeId = locator?.cascadeId;
      const descriptor = findAliveDescriptor();
      if (!decision?.interaction) {
        return { accepted: false, unsupported: true, cascadeId };
      }
      await callRpc(descriptor, "HandleCascadeUserInteraction", {
        conversationId: cascadeId,
        interaction: decision.interaction,
      });
      return { accepted: true, cascadeId };
    },
  };

  return validateAdapter(adapter);
}
