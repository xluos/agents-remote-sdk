/**
 * Path helpers — match the Python utils/session.py convention exactly.
 *
 * Long session names get hashed to keep the on-disk filename under
 * AF_UNIX's 104-byte path limit; we replicate that hashing so the SDK
 * can address sessions the daemon created.
 *
 * Namespace isolation: every path helper accepts an optional `dataDir`
 * so apps embedding the SDK (agentara, third-party TUIs) can keep
 * their sessions out of the default `/tmp/remote-claude/` directory
 * that agent-remote's own Feishu bridge scans.
 *
 * Resolution order matches the daemon CLI:
 *   explicit dataDir arg  >  AGENT_REMOTE_CORE_DATA_DIR env  >  default
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_SOCKET_DIR = "/tmp/remote-claude";

/** Resolve the runtime directory the daemon writes to. */
export function resolveDataDir(dataDir?: string): string {
  if (dataDir) return dataDir;
  return process.env.AGENT_REMOTE_CORE_DATA_DIR ?? DEFAULT_SOCKET_DIR;
}

/** Where the daemon places per-session socket / pid / mq files (default). */
export const SOCKET_DIR = DEFAULT_SOCKET_DIR;

/** User data dir (logs, bindings). Matches Python USER_DATA_DIR. */
export function userDataDir(): string {
  const home = process.env.HOME ?? tmpdir();
  return join(home, ".remote-claude");
}

/**
 * Mirror `_safe_filename(name)` from utils/session.py. The daemon hashes
 * the session name with MD5 unconditionally — every name length, every
 * character set, always 32 hex chars. We must do the exact same thing so
 * the SDK addresses the same files the daemon writes.
 */
export function safeFilename(name: string): string {
  return createHash("md5").update(name, "utf-8").digest("hex");
}

export function socketPath(name: string, dataDir?: string): string {
  return join(resolveDataDir(dataDir), `${safeFilename(name)}.sock`);
}

export function mqPath(name: string, dataDir?: string): string {
  return join(resolveDataDir(dataDir), `${safeFilename(name)}.mq`);
}

export function pidPath(name: string, dataDir?: string): string {
  return join(resolveDataDir(dataDir), `${safeFilename(name)}.pid`);
}

export function nameFilePath(name: string, dataDir?: string): string {
  return join(resolveDataDir(dataDir), `${safeFilename(name)}.name`);
}
