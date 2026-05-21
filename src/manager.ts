/**
 * SessionManager — spawn / list / kill agent-remote-core processes.
 *
 * Thin wrapper around the `agent-remote-core` CLI. The daemon binary
 * must be on PATH (install with `uv tool install agent-remote-core`
 * or `pip install agent-remote-core`).
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { socketPath } from "./paths.js";

const execFileP = promisify(execFile);

export interface StartOptions {
  /** "claude" or "codex". Default "claude". */
  cliType?: "claude" | "codex";
  /** cwd to inherit when spawning the daemon. */
  cwd?: string;
  /** Extra env vars. */
  env?: NodeJS.ProcessEnv;
  /** Args forwarded to the inner CLI (e.g. ["--model", "claude-opus-4-7"]). */
  cliArgs?: string[];
  /** Override the daemon binary name. Default "agent-remote-core". */
  daemonBin?: string;
  /** Detach the daemon so it survives this process. Default true. */
  detached?: boolean;
}

export interface MirrorOptions {
  /** Daemon session name. Default = tmux target. */
  name?: string;
  cliType?: "claude" | "codex";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  daemonBin?: string;
  detached?: boolean;
}

export interface SessionInfo {
  name: string;
  pid: number;
  cli_type: string;
  tmux: boolean;
}

export class SessionManager {
  private readonly daemonBin: string;
  private readonly dataDir?: string;

  constructor(opts?: { daemonBin?: string; dataDir?: string }) {
    this.daemonBin = opts?.daemonBin ?? "agent-remote-core";
    this.dataDir = opts?.dataDir;
  }

  /** Start a fresh PTY-backed session. Returns once the socket exists. */
  async start(name: string, opts: StartOptions = {}): Promise<void> {
    const args = [...this._globalArgs(), "start", name, "--cli-type", opts.cliType ?? "claude"];
    if (opts.cliArgs?.length) args.push("--", ...opts.cliArgs);
    await this._spawnDetached(args, opts);
    await this._waitForSocket(name);
  }

  /** Mirror an existing tmux session. */
  async mirror(tmuxTarget: string, opts: MirrorOptions = {}): Promise<string> {
    const args = [...this._globalArgs(), "mirror", tmuxTarget, "--cli-type", opts.cliType ?? "claude"];
    if (opts.name) args.push("--name", opts.name);
    const sessionName = opts.name ?? tmuxTarget;
    await this._spawnDetached(args, opts);
    await this._waitForSocket(sessionName);
    return sessionName;
  }

  /** Check if a session's socket is alive. */
  exists(name: string): boolean {
    return existsSync(socketPath(name, this.dataDir));
  }

  /** List active sessions (parses `daemon list --json`). */
  async list(): Promise<SessionInfo[]> {
    try {
      const { stdout } = await execFileP(this.daemonBin, [...this._globalArgs(), "list", "--json"]);
      return JSON.parse(stdout.trim()) as SessionInfo[];
    } catch {
      return [];
    }
  }

  private _globalArgs(): string[] {
    return this.dataDir ? ["--data-dir", this.dataDir] : [];
  }

  /** Stop a session. */
  async kill(name: string): Promise<void> {
    await execFileP(this.daemonBin, [...this._globalArgs(), "kill", name]).catch(() => undefined);
  }

  /** Get socket / mq paths for a session. */
  async paths(name: string): Promise<{ socket: string; mq: string; pid_file: string; active: boolean }> {
    const { stdout } = await execFileP(this.daemonBin, [...this._globalArgs(), "paths", name]);
    return JSON.parse(stdout.trim());
  }

  private async _spawnDetached(args: string[], opts: StartOptions | MirrorOptions): Promise<ChildProcess> {
    const bin = opts.daemonBin ?? this.daemonBin;
    const detached = opts.detached ?? true;
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached,
      stdio: detached ? "ignore" : "inherit",
    });
    if (detached) proc.unref();
    return proc;
  }

  private async _waitForSocket(name: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    const target = socketPath(name, this.dataDir);
    while (Date.now() - start < timeoutMs) {
      if (existsSync(target)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for daemon socket: ${target}`);
  }
}
