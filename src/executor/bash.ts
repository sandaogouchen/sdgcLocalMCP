import { spawn } from 'node:child_process';

import { CommandRequest, CommandResult, ServerConfig } from '../types/index.js';

export class BashExecutor {
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const requestedTimeout = request.timeout ?? this.config.defaultTimeout;
    const timeout = Math.min(requestedTimeout, this.config.maxTimeout);
    const cwd = request.workingDirectory ?? this.config.workingDirectory;
    const env = { ...process.env, ...request.env };

    const startTime = Date.now();

    return await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', request.command], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, timeout);
      }

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (error: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        reject(error);
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        const timeoutMessage = timedOut ? `Command timed out after ${timeout}ms` : '';

        resolve({
          stdout,
          stderr: [stderr, timeoutMessage, signal ? `Terminated by signal: ${signal}` : '']
            .filter(Boolean)
            .join('\n'),
          exitCode: code ?? (timedOut ? 124 : -1),
          duration,
          timestamp: new Date(),
        });
      });
    });
  }
}
