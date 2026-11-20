// Executor session stickiness.
//
// A bridged executor (Codex app-server thread, Antigravity cascade) is identified
// by an id the remote side hands out. Remembering that id per (adapter, agent,
// workspace) is what turns one-off calls into a continuing conversation: the same
// agent in the same workspace comes back to the same thread instead of starting a
// new one every turn.
//
// The map lives outside the task ledger on purpose. The ledger records what a task
// did; this records "which remote conversation this agent/workspace pair is using",
// which outlives any single task and must survive a Host restart.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface StickyKey {
  /** Adapter kind — `codex`, `antigravity`. */
  kind: string;
  agentId: string;
  workspaceId: string;
}

export interface StickySessions {
  readonly enabled: boolean;
  get(key: StickyKey): string | null;
  remember(key: StickyKey, sessionId: string): void;
  forget(key: StickyKey): void;
  entries(): Record<string, string>;
}

interface StickyEntry {
  id: string;
  updatedAt: number;
}

interface StickyFile {
  version: 1;
  sessions: Record<string, StickyEntry>;
}

export const STICKY_FILE_VERSION = 1;
/** Keys are kept bounded so a long-lived install does not grow a permanent list. */
export const STICKY_MAX_ENTRIES = 200;

export function defaultStickyFile(): string {
  return join(homedir(), ".dsh", "storages", "task-center", "executor-sessions.json");
}

export function stickyKey({ kind, agentId, workspaceId }: StickyKey): string {
  return `${kind}:${agentId}:${workspaceId}`;
}

function emptyFile(): StickyFile {
  return { version: STICKY_FILE_VERSION, sessions: {} };
}

function readFile(file: string): StickyFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StickyFile>;
    const sessions: Record<string, StickyEntry> = {};
    for (const [key, entry] of Object.entries(parsed?.sessions ?? {})) {
      const value = entry as Partial<StickyEntry> | undefined;
      if (typeof value?.id === "string" && value.id.length > 0) {
        sessions[key] = { id: value.id, updatedAt: Number(value.updatedAt) || 0 };
      }
    }
    return { version: STICKY_FILE_VERSION, sessions };
  } catch {
    // A missing or unreadable map is not an error: it means "nothing remembered yet".
    return emptyFile();
  }
}

export interface StickyOptions {
  file?: string;
  enabled?: boolean;
  now?: () => number;
  logger?: { warn?: (message: string) => void };
}

export function createStickySessions({
  file = defaultStickyFile(),
  enabled = true,
  now = Date.now,
  logger = {},
}: StickyOptions = {}): StickySessions {
  let cache: StickyFile | null = null;

  const load = (): StickyFile => {
    if (!cache) cache = readFile(file);
    return cache;
  };

  const persist = (data: StickyFile): void => {
    // Best-effort: losing this map costs one new thread, never a task. Writing
    // through a temp file keeps a crash from leaving half a JSON document behind.
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (error) {
      logger.warn?.(`could not persist executor sessions (${(error as Error)?.message ?? "unknown"})`);
    }
  };

  const trim = (sessions: Record<string, StickyEntry>): Record<string, StickyEntry> => {
    const keys = Object.keys(sessions);
    if (keys.length <= STICKY_MAX_ENTRIES) return sessions;
    const ordered = keys.sort((a, b) => (sessions[b]?.updatedAt ?? 0) - (sessions[a]?.updatedAt ?? 0));
    const kept: Record<string, StickyEntry> = {};
    for (const key of ordered.slice(0, STICKY_MAX_ENTRIES)) kept[key] = sessions[key] as StickyEntry;
    return kept;
  };

  return {
    enabled,
    get(key) {
      if (!enabled) return null;
      const entry = load().sessions[stickyKey(key)];
      return typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : null;
    },
    remember(key, sessionId) {
      if (!enabled || typeof sessionId !== "string" || sessionId.length === 0) return;
      const data = load();
      data.sessions = trim({ ...data.sessions, [stickyKey(key)]: { id: sessionId, updatedAt: now() } });
      persist(data);
    },
    forget(key) {
      const data = load();
      const name = stickyKey(key);
      if (!(name in data.sessions)) return;
      const next = { ...data.sessions };
      delete next[name];
      data.sessions = next;
      persist(data);
    },
    entries() {
      const out: Record<string, string> = {};
      for (const [key, entry] of Object.entries(load().sessions)) out[key] = entry.id;
      return out;
    },
  };
}
