/**
 * SessionWriter — send input bytes to a daemon over its Unix socket.
 *
 * Supports the same closed-loop option navigation the daemon's flagship
 * consumer (the Feishu bridge) uses: send ↓/↑ arrow keys, poll the
 * shared-memory snapshot to check the cursor position, then send Enter.
 *
 * Connection is lazy — first send() opens the socket, subsequent sends
 * reuse it. Call close() to release when done.
 */

import { Socket } from "node:net";
import { encodeInput, encodeResize, newClientId } from "./protocol.js";
import { SessionReader } from "./reader.js";
import { socketPath } from "./paths.js";

export interface SendOptionOpts {
  /** Total options count, used to cap the navigation step count. */
  total?: number;
  /** Max nav steps. Defaults to max(total, 10). */
  maxSteps?: number;
  /** Per-step poll interval in ms. Default 80. */
  stepIntervalMs?: number;
  /** If true, navigate to target but DON'T send Enter (for free-input options). */
  navigateOnly?: boolean;
  /** AbortSignal. */
  signal?: AbortSignal;
}

export class SessionWriter {
  readonly sessionName: string;
  readonly path: string;
  readonly clientId: string;
  private _socket?: Socket;
  private _connectPromise?: Promise<void>;
  private _reader?: SessionReader;
  private _dataDir?: string;

  constructor(sessionName: string, opts?: { clientId?: string; dataDir?: string }) {
    this.sessionName = sessionName;
    this.path = socketPath(sessionName, opts?.dataDir);
    this.clientId = opts?.clientId ?? newClientId();
    this._dataDir = opts?.dataDir;
  }

  /** Send raw bytes to the daemon's PTY (or tmux send-keys in mirror mode). */
  async sendRaw(data: Uint8Array): Promise<void> {
    const sock = await this._connect();
    return new Promise((resolve, reject) => {
      sock.write(encodeInput(data, this.clientId), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Send a UTF-8 text fragment. */
  async sendText(text: string): Promise<void> {
    return this.sendRaw(Buffer.from(text, "utf-8"));
  }

  /** Send Enter (CR — what claude/codex expect to submit). */
  async sendEnter(): Promise<void> {
    return this.sendRaw(Buffer.from([0x0d]));
  }

  /** Send ESC. */
  async sendEsc(): Promise<void> {
    return this.sendRaw(Buffer.from([0x1b]));
  }

  /** Send arrow key. */
  async sendArrow(dir: "up" | "down" | "left" | "right"): Promise<void> {
    const seqs = {
      up:    Buffer.from([0x1b, 0x5b, 0x41]),
      down:  Buffer.from([0x1b, 0x5b, 0x42]),
      right: Buffer.from([0x1b, 0x5b, 0x43]),
      left:  Buffer.from([0x1b, 0x5b, 0x44]),
    } as const;
    return this.sendRaw(seqs[dir]);
  }

  /** Tell the daemon to resize the PTY. No-op in mirror mode. */
  async resize(cols: number, rows: number): Promise<void> {
    const sock = await this._connect();
    return new Promise((resolve, reject) => {
      sock.write(encodeResize(cols, rows), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Closed-loop option selection: navigate the ❯ cursor to `target`, then
   * press Enter. Polls the daemon's snapshot between every step to confirm
   * the cursor actually moved — this is needed because, when there are many
   * options, some overflow past the divider and number-key input no longer
   * works at all.
   *
   * Ports the logic from lark_client/lark_handler.py:handle_option_select.
   */
  async sendOption(target: string, opts: SendOptionOpts = {}): Promise<void> {
    const reader = this._getReader();
    const maxSteps = opts.maxSteps ?? Math.max(opts.total ?? 10, 10);
    const interval = opts.stepIntervalMs ?? 80;
    const signal = opts.signal;

    // Snapshot initial option_block.block_id to abort if the CLI moves to a
    // different prompt mid-navigation.
    const initialSnap = await reader.read();
    const initialBlockId = initialSnap.option_block?.block_id ?? "";
    if (!initialSnap.option_block) {
      throw new Error("No active option_block; nothing to select");
    }

    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) throw new Error("aborted");

      let current = "";
      // Blink-frame retry: ❯ may temporarily disappear from the snapshot
      for (let retry = 0; retry < 6; retry++) {
        const snap = await reader.read();
        const ob = snap.option_block;
        if (!ob) return; // CLI advanced on its own; nothing to do
        if (ob.block_id && initialBlockId && ob.block_id !== initialBlockId) {
          throw new Error("option_block changed mid-navigation; aborting");
        }
        current = ob.selected_value ?? "";
        if (current) break;
        await sleep(80, signal);
      }

      if (current === target) {
        if (opts.navigateOnly) return;
        await this.sendEnter();
        return;
      }

      // Decide direction
      const cur = parseInt(current, 10);
      const tgt = parseInt(target, 10);
      if (Number.isFinite(cur) && Number.isFinite(tgt)) {
        await this.sendArrow(cur < tgt ? "down" : "up");
      } else {
        await this.sendArrow("down");
      }

      await sleep(interval, signal);
    }
    throw new Error(`sendOption: max ${maxSteps} steps exceeded`);
  }

  /** Close socket. SessionWriter can be reused (reconnects on next send). */
  close(): void {
    if (this._socket) {
      this._socket.destroy();
      this._socket = undefined;
      this._connectPromise = undefined;
    }
  }

  private _getReader(): SessionReader {
    if (!this._reader) this._reader = new SessionReader(this.sessionName, { dataDir: this._dataDir });
    return this._reader;
  }

  private _connect(): Promise<Socket> {
    if (this._socket && !this._socket.destroyed) {
      return Promise.resolve(this._socket);
    }
    if (this._connectPromise) {
      return this._connectPromise.then(() => this._socket!);
    }
    this._connectPromise = new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.removeAllListeners("error");
        this._socket = sock;
        // Keep error/close handlers so we drop the cached socket on disconnect
        sock.on("error", () => this.close());
        sock.on("close", () => { this._socket = undefined; });
        resolve();
      });
      sock.connect(this.path);
    });
    return this._connectPromise.then(() => this._socket!);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
