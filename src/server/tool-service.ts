import { randomUUID } from 'node:crypto';

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { AuditLogger } from '../audit/logger.js';
import { BashExecutor } from '../executor/bash.js';
import { SafetyChecker } from '../safety/checker.js';
import { CommandRequest, ServerConfig } from '../types/index.js';

export const executeBashSchema = z
  .object({
    command: z.string().min(1),
    timeout: z.number().int().positive().optional(),
    workingDirectory: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

export const checkCommandSafetySchema = z
  .object({
    command: z.string().min(1),
    timeout: z.number().int().positive().optional(),
    workingDirectory: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

export const executeBashInputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1 },
    timeout: { type: 'number' },
    workingDirectory: { type: 'string', minLength: 1 },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

export const checkCommandSafetyInputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1 },
    timeout: { type: 'number' },
    workingDirectory: { type: 'string', minLength: 1 },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

export function redactErrorMessage(error: unknown): string {
  if (error instanceof McpError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown internal error';
}

export class ToolService {
  private readonly executor: BashExecutor;
  private readonly checker: SafetyChecker;
  private readonly auditLogger: AuditLogger;

  constructor(private readonly config: ServerConfig) {
    this.executor = new BashExecutor(config);
    this.checker = new SafetyChecker(config);
    this.auditLogger = new AuditLogger(config);
  }

  listTools() {
    return [
      {
        name: 'execute_bash',
        description: 'Execute a bash command locally with timeout and audit logging.',
        inputSchema: executeBashInputSchema,
      },
      {
        name: 'check_command_safety',
        description: 'Check whether a bash command is safe to run under current policy.',
        inputSchema: checkCommandSafetyInputSchema,
      },
    ];
  }

  async callTool(name: string, rawArgs: unknown) {
    switch (name) {
      case 'execute_bash':
        return await this.handleExecuteBash(executeBashSchema.parse(rawArgs ?? {}));
      case 'check_command_safety':
        return this.handleCheckCommandSafety(checkCommandSafetySchema.parse(rawArgs ?? {}));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  getConfig(): ServerConfig {
    return this.config;
  }

  /** Expose audit buffer size for /health observability. */
  getAuditPending(): number {
    return this.auditLogger.pendingCount;
  }

  async stop(): Promise<void> {
    await this.auditLogger.stop();
  }

  private async handleExecuteBash(input: CommandRequest) {
    const safetyCheck = this.checker.check(input.command, input);
    if (!safetyCheck.allowed) {
      throw new Error(safetyCheck.reason);
    }

    const result = await this.executor.execute(input);

    await this.auditLogger.log({
      id: randomUUID(),
      timestamp: new Date(),
      command: input.command,
      result,
      safetyCheck,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: result.duration,
      timestamp: result.timestamp.toISOString(),
      safetyCheck,
    };
  }

  private handleCheckCommandSafety(input: CommandRequest) {
    return this.checker.check(input.command, input);
  }
}
