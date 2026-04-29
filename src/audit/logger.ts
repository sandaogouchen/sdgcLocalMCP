import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AuditLogEntry, ServerConfig } from '../types/index.js';

/**
 * Concurrency-safe buffered audit logger.
 *
 * Key invariants:
 *   1. `logBuffer` reference is swapped atomically (synchronously) with `[]`
 *      before any `await`. This prevents concurrent flushes from reading the
 *      same entries or losing entries pushed during a flush.
 *   2. `flushing` acts as a mutex promise — only one `appendFile` runs at any
 *      time, so on-disk bytes never interleave.
 *   3. The inner `while` loop drains entries pushed while a flush was in
 *      progress, so no entry is ever stranded until the next interval.
 */
export class AuditLogger {
  private readonly config: ServerConfig;
  private logBuffer: AuditLogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
    if (this.config.enableAudit) {
      this.startAutoFlush();
    }
  }

  async log(entry: AuditLogEntry): Promise<void> {
    if (!this.config.enableAudit) {
      return;
    }
    this.logBuffer.push(entry);
    if (entry.safetyCheck.riskLevel === 'high' || entry.safetyCheck.riskLevel === 'critical') {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.config.enableAudit || !this.config.auditLogPath) {
      return;
    }
    // If a flush is already in progress, wait for it and return.
    // The in-progress flush's inner `while` loop will drain anything we just
    // pushed, so we do not need to re-trigger here.
    if (this.flushing) {
      await this.flushing;
      return;
    }

    this.flushing = this.doFlush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async doFlush(): Promise<void> {
    const targetPath = this.config.auditLogPath;
    if (!targetPath) {
      return;
    }
    try {
      // Drain the buffer, writing in batches. The loop re-checks `logBuffer`
      // so that entries pushed during a previous `await appendFile` within
      // this same flush cycle are also written without needing another flush.
      while (this.logBuffer.length > 0) {
        // Atomic swap (no await between these two lines) — safe on Node's
        // single-threaded event loop.
        const batch = this.logBuffer;
        this.logBuffer = [];

        await mkdir(dirname(targetPath), { recursive: true });
        const payload =
          batch
            .map(entry =>
              JSON.stringify({
                id: entry.id,
                timestamp: entry.timestamp.toISOString(),
                command: entry.command,
                exitCode: entry.result.exitCode,
                duration: entry.result.duration,
                riskLevel: entry.safetyCheck.riskLevel,
                sessionId: entry.sessionId,
              })
            )
            .join('\n') + '\n';
        await appendFile(targetPath, payload, 'utf-8');
      }
    } catch (error) {
      // Do not rethrow — audit logging must never break the main request path.
      console.error('Failed to write audit log', error);
    }
  }

  /**
   * Current number of buffered, not-yet-flushed audit entries.
   * Exposed for /health observability.
   */
  get pendingCount(): number {
    return this.logBuffer.length;
  }

  private startAutoFlush(): void {
    this.flushInterval = setInterval(() => {
      void this.flush();
    }, 30000);
  }

  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Wait for any in-flight flush, then do a final drain.
    if (this.flushing) {
      await this.flushing;
    }
    await this.flush();
  }
}
