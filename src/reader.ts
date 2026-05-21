/**
 * SessionReader — read structured ClaudeWindow snapshots from a daemon's
 * shared-memory .mq file.
 *
 * The .mq layout (matches Python SharedStateReader):
 *   [0..4)   magic 'RCMQ'
 *   [4..8)   version uint32 BE (current = 2)
 *   [8..12)  snapshot_len uint32 BE
 *   [12..16) sequence uint32 BE
 *   [16..64) reserved
 *   [64..)   JSON snapshot
 *
 * subscribe() polls the header (cheap 16-byte read) and yields a new
 * snapshot whenever `sequence` advances.
 */

import { open, type FileHandle } from "node:fs/promises";
import { mqPath } from "./paths.js";
import { EMPTY_SNAPSHOT, type ClaudeWindow } from "./types.js";

const HEADER_SIZE = 64;
const COMPLETED_OFFSET = HEADER_SIZE;
const MAGIC = "RCMQ";

export interface SubscribeOptions {
  /** Polling interval in ms. Default 100ms. */
  intervalMs?: number;
  /** AbortSignal to stop the subscription. */
  signal?: AbortSignal;
  /** If true, yield the current snapshot immediately on subscribe. */
  emitInitial?: boolean;
}

export class SessionReader {
  readonly sessionName: string;
  readonly path: string;
  private _lastSequence = -1;

  constructor(sessionName: string, opts?: { dataDir?: string }) {
    this.sessionName = sessionName;
    this.path = mqPath(sessionName, opts?.dataDir);
  }

  /** One-shot read of the current snapshot. Returns EMPTY_SNAPSHOT on failure. */
  async read(): Promise<ClaudeWindow> {
    const result = await this._readWithSequence();
    return result.snapshot;
  }

  /** Read snapshot + the daemon's current sequence number. */
  async readWithSequence(): Promise<{ snapshot: ClaudeWindow; sequence: number }> {
    return this._readWithSequence();
  }

  /**
   * Async iterator that yields snapshots whenever the daemon writes a new one.
   * Use with `for await`. Honors `signal` for cancellation.
   */
  async *subscribe(opts: SubscribeOptions = {}): AsyncIterableIterator<ClaudeWindow> {
    const interval = opts.intervalMs ?? 100;
    const signal = opts.signal;

    if (opts.emitInitial !== false) {
      const { snapshot, sequence } = await this._readWithSequence();
      this._lastSequence = sequence;
      yield snapshot;
    }

    while (!signal?.aborted) {
      await sleep(interval, signal);
      if (signal?.aborted) return;

      let fh: FileHandle | undefined;
      try {
        fh = await open(this.path, "r");
        const header = Buffer.alloc(16);
        await fh.read(header, 0, 16, 0);
        if (header.subarray(0, 4).toString("ascii") !== MAGIC) continue;
        const version = header.readUInt32BE(4);
        if (version < 2) continue;
        const snapshotLen = header.readUInt32BE(8);
        const sequence = header.readUInt32BE(12);
        if (sequence === this._lastSequence || snapshotLen === 0) continue;

        const buf = Buffer.alloc(snapshotLen);
        await fh.read(buf, 0, snapshotLen, COMPLETED_OFFSET);
        let snap: ClaudeWindow;
        try {
          snap = JSON.parse(buf.toString("utf-8")) as ClaudeWindow;
        } catch {
          continue;
        }
        this._lastSequence = sequence;
        yield snap;
      } catch {
        // File missing / unreadable. Keep polling — daemon may not be up yet.
      } finally {
        if (fh) await fh.close().catch(() => undefined);
      }
    }
  }

  private async _readWithSequence(): Promise<{
    snapshot: ClaudeWindow;
    sequence: number;
  }> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.path, "r");
      const header = Buffer.alloc(16);
      await fh.read(header, 0, 16, 0);
      if (header.subarray(0, 4).toString("ascii") !== MAGIC) {
        return { snapshot: EMPTY_SNAPSHOT, sequence: 0 };
      }
      const version = header.readUInt32BE(4);
      if (version < 2) return { snapshot: EMPTY_SNAPSHOT, sequence: 0 };
      const snapshotLen = header.readUInt32BE(8);
      const sequence = header.readUInt32BE(12);
      if (snapshotLen === 0) return { snapshot: EMPTY_SNAPSHOT, sequence };
      const buf = Buffer.alloc(snapshotLen);
      await fh.read(buf, 0, snapshotLen, COMPLETED_OFFSET);
      const snap = JSON.parse(buf.toString("utf-8")) as ClaudeWindow;
      return { snapshot: snap, sequence };
    } catch {
      return { snapshot: EMPTY_SNAPSHOT, sequence: 0 };
    } finally {
      if (fh) await fh.close().catch(() => undefined);
    }
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
