import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AuditLogEntry, ServerConfig } from '../types/index.js';

export class AuditLogger {
  private readonly config: ServerConfig;
  private logBuffer: AuditLogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

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
    if (!this.config.enableAudit || this.logBuffer.length === 0 || !this.config.auditLogPath) {
      return;
    }
    try {
      await mkdir(dirname(this.config.auditLogPath), { recursive: true });
      const lines = this.logBuffer.map(entry =>
        JSON.stringify({
          id: entry.id,
          timestamp: entry.timestamp.toISOString(),
          command: entry.command,
          exitCode: entry.result.exitCode,
          duration: entry.result.duration,
          riskLevel: entry.safetyCheck.riskLevel,
          sessionId: entry.sessionId,
        })
      );
      await appendFile(this.config.auditLogPath, lines.join('\n') + '\n', 'utf-8');
      this.logBuffer = [];
    } catch (error) {
      console.error('Failed to write audit log', error);
    }
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
    await this.flush();
  }
}
