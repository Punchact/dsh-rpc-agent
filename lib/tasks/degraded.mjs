// Degraded-permission visibility (§4.2 rule 4, added 2026-11-18 "降级许可").
// A control an agent declares optional-and-unsupported does not disqualify it, but the
// caller must see the semantic consequence rather than a control that silently does nothing.

const DEGRADABLE_CONTROLS = Object.freeze(["start", "steer", "cancel", "inspect", "events", "approval"]);

const CONTROL_DEGRADE_EFFECTS = Object.freeze({
  start: "the bridge cannot start this agent; tasks stay queued until an operator starts them",
  steer: "no additional input can be delivered mid-run; input waits for the attempt to finish",
  cancel: "cancel requests never produce cancelled: they are recorded and the task moves to needs_reconcile",
  inspect: "task detail relies on the agent's own reports; the bridge cannot inspect the run independently",
  events: "progress comes only from reports; there is no adapter event stream to reconcile against",
  approval: "approvals cannot be decided through the bridge; the agent resolves them in its own UI",
});

function parseCapabilities(capabilitiesJson) {
  if (capabilitiesJson && typeof capabilitiesJson === "object") return capabilitiesJson;
  if (typeof capabilitiesJson !== "string" || capabilitiesJson.length === 0) return {};
  try {
    const parsed = JSON.parse(capabilitiesJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function degradedFromCapabilities(capabilitiesJson) {
  const caps = parseCapabilities(capabilitiesJson);
  const degraded = [];
  for (const control of DEGRADABLE_CONTROLS) {
    const value = caps?.[control];
    if (value === "unsupported" || value === false) {
      degraded.push({ control, effect: CONTROL_DEGRADE_EFFECTS[control] });
    }
  }
  return degraded;
}

export const DEGRADED_CONTROLS = DEGRADABLE_CONTROLS;
