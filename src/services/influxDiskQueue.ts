import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { createReadStream } from 'fs';
import { logger } from '../utils/logger';
import { isPermanentInfluxWriteError, influxWriteErrorMessage } from '../utils/influxQueueError';

export interface InfluxDiskQueueOptions {
  queuePath: string;
  flushIntervalMs: number;
  batchMax: number;
  /** Safety cap per drain file (prevents loading gigabytes into RAM). */
  maxLinesPerFile: number;
  /** When true, fsync after every append (power-loss safe). */
  syncOnAppend: boolean;
}

/**
 * Append-only local WAL for Influx line protocol (one record per line).
 * Background flush renames queue → *.draining, batches lines to HTTP write API, retries on failure.
 */
export class InfluxDiskQueue {
  private readonly drainingPath: string;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private sender: ((lines: string[]) => Promise<void>) | null = null;

  constructor(private readonly opts: InfluxDiskQueueOptions) {
    this.drainingPath = `${opts.queuePath}.draining`;
  }

  private rejectedPath(): string {
    return `${this.opts.queuePath}.rejected`;
  }

  private async rejectLine(line: string, reason: string): Promise<void> {
    const payload = `${line}\n`;
    await fs.appendFile(this.rejectedPath(), payload, 'utf8').catch((err: unknown) => {
      logger.error('[INFLUX_QUEUE] dead-letter append failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
    logger.warn('[INFLUX_QUEUE] rejected permanently invalid line', {
      reason,
      preview: line.slice(0, 120)
    });
  }

  private async sendChunk(
    sender: (lines: string[]) => Promise<void>,
    chunk: string[]
  ): Promise<void> {
    if (chunk.length === 0) return;
    try {
      await sender(chunk);
      return;
    } catch (err: unknown) {
      if (!isPermanentInfluxWriteError(err) || chunk.length === 1) {
        throw err;
      }
    }

    // ponytail: permanent batch parse error → try line-by-line, dead-letter poison pills
    for (const line of chunk) {
      try {
        await sender([line]);
      } catch (lineErr: unknown) {
        if (isPermanentInfluxWriteError(lineErr)) {
          await this.rejectLine(line, influxWriteErrorMessage(lineErr));
          continue;
        }
        throw lineErr;
      }
    }
  }

  start(sender: (lines: string[]) => Promise<void>): void {
    this.sender = sender;
    this.timer = setInterval(() => void this.tick(), this.opts.flushIntervalMs);
    void this.tick();
    logger.info('[INFLUX_QUEUE] Disk queue started', {
      path: this.opts.queuePath,
      flushMs: this.opts.flushIntervalMs,
      batchMax: this.opts.batchMax,
      syncOnAppend: this.opts.syncOnAppend
    });
    if (this.opts.syncOnAppend) {
      logger.info('[INFLUX_QUEUE] syncOnAppend=true (fsync per append)');
    }
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Serialize appends (no interleaved writes). */
  enqueue(lineProtocol: string): Promise<void> {
    const line = lineProtocol.trim();
    if (!line) return Promise.resolve();

    const dir = path.dirname(this.opts.queuePath);
    const payload = `${line}\n`;
    const run = async (): Promise<void> => {
      await fs.mkdir(dir, { recursive: true });
      if (this.opts.syncOnAppend) {
        const handle = await fs.open(this.opts.queuePath, 'a');
        try {
          await handle.writeFile(payload, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        await fs.appendFile(this.opts.queuePath, payload, 'utf8');
      }
    };

    const p = this.chain.then(run);
    this.chain = p.catch((err: unknown) => {
      logger.error('[INFLUX_QUEUE] append failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
    return p;
  }

  async waitAppends(): Promise<void> {
    await this.chain.catch(() => {});
  }

  async flushNow(): Promise<void> {
    await this.tick();
  }

  async shutdown(finalSender: (lines: string[]) => Promise<void>): Promise<void> {
    this.stopTimer();
    await this.waitAppends();

    let rounds = 0;
    const maxRounds = 50;
    while (rounds < maxRounds) {
      rounds++;
      const target = await this.pickDrainTarget();
      if (!target) break;
      await this.drainFile(target, finalSender);
    }

    logger.info('[INFLUX_QUEUE] Shutdown flush complete');
  }

  private async tick(): Promise<void> {
    if (!this.sender || this.flushing) return;
    this.flushing = true;
    try {
      const target = await this.pickDrainTarget();
      if (target) await this.drainFile(target, this.sender);
    } finally {
      this.flushing = false;
    }
  }

  private async pickDrainTarget(): Promise<string | null> {
    const { queuePath } = this.opts;

    try {
      const stD = await fs.stat(this.drainingPath).catch(() => null);
      if (stD && stD.size > 0) return this.drainingPath;

      const stQ = await fs.stat(queuePath).catch(() => null);
      if (!stQ || stQ.size === 0) return null;

      await fs.rename(queuePath, this.drainingPath);
      return this.drainingPath;
    } catch (err: unknown) {
      logger.warn('[INFLUX_QUEUE] pickDrainTarget', {
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  private async readAllLines(filePath: string): Promise<string[]> {
    const out: string[] = [];
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) continue;
        out.push(line);
        if (out.length >= this.opts.maxLinesPerFile) {
          throw new Error(
            `Influx disk queue file exceeds maxLinesPerFile=${this.opts.maxLinesPerFile}; increase INFLUXDB_QUEUE_MAX_LINES_PER_FILE or drain manually`
          );
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    return out;
  }

  private async drainFile(absPath: string, sender: (lines: string[]) => Promise<void>): Promise<void> {
    let lines: string[] = [];
    try {
      lines = await this.readAllLines(absPath);
    } catch (err: unknown) {
      logger.error('[INFLUX_QUEUE] read draining file failed', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    if (lines.length === 0) {
      await fs.unlink(absPath).catch(() => {});
      return;
    }

    let offset = 0;
    try {
      while (offset < lines.length) {
        const chunk = lines.slice(offset, Math.min(offset + this.opts.batchMax, lines.length));
        await this.sendChunk(sender, chunk);
        offset += chunk.length;
      }
      await fs.unlink(absPath);
    } catch (err: unknown) {
      const tail = lines.slice(offset);
      try {
        if (tail.length > 0) {
          await fs.appendFile(this.opts.queuePath, tail.map((l) => `${l}\n`).join(''), 'utf8');
        }
        await fs.unlink(absPath).catch(() => {});
      } catch (restoreErr: unknown) {
        logger.error('[INFLUX_QUEUE] restore tail failed', {
          error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
        });
      }
      logger.warn('[INFLUX_QUEUE] HTTP flush failed; restored unsent lines to queue', {
        unsent: tail.length,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
