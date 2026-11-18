// Antigravity Language Server adapter (§8.1).
// Reads daemon descriptors from `%USERPROFILE%\.gemini\antigravity\daemon\hub_*.json`
// at call time and never persists or logs `csrfToken`.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { TASK_ERROR, taskError } from "../tasks/errors.mjs";
import { reportOf, validateAdapter } from "./base.mjs";

export const DEFAULT_ANTIGRAVITY_MODEL = "MODEL_PLACEHOLDER_M525";
const SERVICE_PREFIX = "exa.language_server_pb.LanguageServerService";

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function toWorkspaceUri(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("file://")) return trimmed;
  // Format Windows drive letter consistently as `file:///c%3A/...`
  const url = pathToFileURL(trimmed).href;
  return url.replace(/^file:\/\/\/([A-Za-z]):/, (_m, drive) => `file:///${drive.toLowerCase()}%3A`);
}

function parseJsonSafe(text) {
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
  fsOps = { readdirSync, readFileSync, statSync },
} = {}) {
  function findAliveDescriptor() {
    let entries;
    try {
      entries = fsOps.readdirSync(daemonDir);
    } catch (error) {
      throw taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        `antigravity daemon directory unavailable: ${error?.message ?? error}`,
        { daemonDir, reason: "daemon_dir_unreadable" },
      );
    }

    const candidates = [];
    for (const name of entries) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const fullPath = join(daemonDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fsOps.statSync(fullPath).mtimeMs ?? 0;
      } catch {
        continue;
      }
      let raw;
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
      throw taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        "no alive Antigravity LanguageServer daemon descriptor found",
        { daemonDir, reason: "no_alive_hub" },
      );
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.pid - a.pid);
    return candidates[0];
  }

  async function callRpc(descriptor, method, bodyObj) {
    if (typeof fetch !== "function") {
      throw taskError(TASK_ERROR.ADAPTER_UNAVAILABLE, "global fetch is unavailable", {
        reason: "fetch_missing",
      });
    }
    const url = `http://127.0.0.1:${descriptor.httpPort}/${SERVICE_PREFIX}/${method}`;
    let res;
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
      });
    } catch (error) {
      throw taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        `antigravity RPC ${method} transport error: ${error?.message ?? error}`,
        { method, reason: "transport_error" },
      );
    }

    const text = await res.text();
    const parsed = parseJsonSafe(text);
    if (!res.ok) {
      throw taskError(
        TASK_ERROR.ADAPTER_UNAVAILABLE,
        `antigravity RPC ${method} returned HTTP ${res.status}`,
        { method, httpStatus: res.status, reason: "rpc_http_error" },
      );
    }
    return parsed ?? {};
  }

  async function resolveModelEnum(descriptor, requestedModelId) {
    if (typeof requestedModelId === "string" && requestedModelId.startsWith("MODEL_PLACEHOLDER_")) {
      return { model: requestedModelId, warning: null };
    }
    let configs = [];
    try {
      const data = await callRpc(descriptor, "GetCascadeModelConfigData", {});
      configs = Array.isArray(data?.clientModelConfigs) ? data.clientModelConfigs : [];
    } catch (error) {
      return {
        model: defaultModel,
        warning: `GetCascadeModelConfigData failed (${error?.message ?? error}); fell back to ${defaultModel}`,
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
          .filter((x) => typeof x === "string")
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

  function mapStatusToReport(cascadeId, summary, steps) {
    const observedStatus = summary?.status ?? "CASCADE_RUN_STATUS_UNKNOWN";
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

  const adapter = {
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
      } catch (error) {
        return {
          ok: false,
          reason: error?.message ?? String(error),
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
      const cascadeId = req.cascadeId ?? randomUUID();

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

      const startBody = {
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
      const stoppedConversationIds = Array.isArray(resp?.stoppedConversationIds)
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
      const steps = Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
      const report = mapStatusToReport(cascadeId, summary, steps);
      const startIndex = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
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
