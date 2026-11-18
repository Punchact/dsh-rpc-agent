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

/**
 * Resolve one control's declared support from whatever shape a caller wrote.
 * `dsh.agents.register` stores the whole capability card, so the authoritative
 * place is `controls.<name>.support`; older/hand-written rows used a flat
 * `<name>: "unsupported"`. Reading only the flat form silently reported a single
 * degraded control out of six (t4 finding D2).
 */
function supportOf(caps, control) {
  const card = caps?.controls?.[control];
  if (card && typeof card === "object" && typeof card.support === "string") return card.support;
  const flat = caps?.[control];
  if (typeof flat === "string") return flat;
  if (flat && typeof flat === "object" && typeof flat.support === "string") return flat.support;
  if (flat === false) return "unsupported";
  return null;
}

export function degradedFromCapabilities(capabilitiesJson) {
  const caps = parseCapabilities(capabilitiesJson);
  const degraded = [];
  for (const control of DEGRADABLE_CONTROLS) {
    if (supportOf(caps, control) === "unsupported") {
      degraded.push({ control, effect: CONTROL_DEGRADE_EFFECTS[control] });
    }
  }
  return degraded;
}

export const DEGRADED_CONTROLS = DEGRADABLE_CONTROLS;
