// Artifact index (§5) — verification and bounded reads.
//
// A report from a runtime is a *claim* (§5.3): the centre records an artifact only
// after it can see the bytes it names. Everything here is pure filesystem work so it
// can be unit-tested without a host, a session or an adapter.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/** Refuse to index anything larger than this; a task result is not a disk dump. */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** Default window returned by `readArtifact`, and the ceiling a caller may ask for. */
export const DEFAULT_READ_BYTES = 20_000;
export const MAX_READ_BYTES = 1_000_000;

const ARTIFACT_KINDS = new Set(["file", "diff", "log", "json", "text", "binary", "link"]);

export function isArtifactKind(value) {
  return typeof value === "string" && ARTIFACT_KINDS.has(value);
}

/** Stable id: the same bytes under the same task keep the same id across re-reports. */
export function artifactIdFor(taskId, sha256, kind) {
  return `art_${createHash("sha256").update(`${taskId}|${kind}|${sha256}`).digest("hex").slice(0, 24)}`;
}

export function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verify one claim `{kind, sourcePath, sha256?, sizeBytes?}`.
 * Returns `{ok: true, artifact}` or `{ok: false, reason}` — never throws for a bad
 * claim, because a bad claim must not abort the whole report.
 */
export function verifyArtifactClaim(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    return { ok: false, reason: "artifact_not_object" };
  }
  const kind = typeof claim.kind === "string" && claim.kind.trim() ? claim.kind.trim() : "file";
  if (!isArtifactKind(kind)) return { ok: false, reason: "artifact_kind_unknown" };
  const sourcePath = typeof claim.sourcePath === "string" ? claim.sourcePath.trim() : "";
  if (!sourcePath) return { ok: false, reason: "artifact_path_missing" };

  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    return { ok: false, reason: "artifact_unreadable" };
  }
  if (!stat.isFile()) return { ok: false, reason: "artifact_not_a_file" };
  if (stat.size > MAX_ARTIFACT_BYTES) return { ok: false, reason: "artifact_too_large" };

  let sha256;
  try {
    sha256 = sha256OfFile(sourcePath);
  } catch {
    return { ok: false, reason: "artifact_unreadable" };
  }
  if (typeof claim.sha256 === "string" && claim.sha256.trim() && claim.sha256.trim() !== sha256) {
    return { ok: false, reason: "artifact_hash_mismatch" };
  }
  if (Number.isInteger(claim.sizeBytes) && claim.sizeBytes !== stat.size) {
    return { ok: false, reason: "artifact_size_mismatch" };
  }

  return {
    ok: true,
    artifact: { kind, sizeBytes: stat.size, sha256, sourcePath, name: basename(sourcePath) },
  };
}

function decode(buf) {
  const text = buf.toString("utf8");
  // A UTF-8 decode that round-trips cleanly is text; anything else is handed back as
  // base64 so a caller never receives mojibake it cannot verify.
  if (Buffer.from(text, "utf8").equals(buf)) return { content: text, encoding: "utf8" };
  return { content: buf.toString("base64"), encoding: "base64" };
}

/** Bounded read of one recorded artifact, honouring `offset`/`length`. */
export function readArtifactWindow({ sourcePath, offset = 0, length = DEFAULT_READ_BYTES }) {
  const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const want =
    Number.isInteger(length) && length > 0 ? Math.min(length, MAX_READ_BYTES) : DEFAULT_READ_BYTES;

  let stat;
  try {
    stat = statSync(sourcePath);
  } catch {
    return { ok: false, reason: "artifact_unreadable" };
  }
  if (!stat.isFile()) return { ok: false, reason: "artifact_not_a_file" };
  if (start > stat.size) {
    return { ok: false, reason: "artifact_offset_out_of_range", sizeBytes: stat.size };
  }

  const window = stat.size - start <= want ? stat.size - start : want;
  const buf = readFileSync(sourcePath);
  const slice = buf.subarray(start, start + window);
  const decoded = decode(slice);
  return {
    ok: true,
    ...decoded,
    sizeBytes: stat.size,
    offset: start,
    bytesRead: window,
    truncated: start + window < stat.size,
  };
}
