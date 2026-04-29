import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ServerConfig } from '../types/index.js';

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config', 'server-config.json');

export const defaultConfig: ServerConfig = {
  maxTimeout: 300000,
  defaultTimeout: 60000,
  workingDirectory: process.cwd(),
  enableAudit: true,
  auditLogPath: path.resolve(process.cwd(), 'logs', 'audit.log'),
  blockedCommands: [
    'rm -rf /',
    'rm -rf /*',
    'mkfs',
    ':>device-sda',
    'mv / /dev/null',
    'sudo rm',
    'format',
    'del /f /s /q',
  ],
  allowedPaths: [process.cwd(), '/tmp', '/var/tmp'],
  requireConfirmationPatterns: [
    'rm -rf',
    'sudo',
    'chmod 777',
    'mkfs',
    'dd',
    '> device/',
    '>device/',
    'curl.*sh',
    'wget.*sh',
  ],
  concurrency: {
    http: 16,
    bridge: 16,
  },
  bridge: {
    enabled: false,
    host: '0.0.0.0',
    port: 3002,
    path: '/mcp',
    wsPath: '/bridge/agent',
    bearerTokens: [],
    requestTimeoutMs: 30000,
    agents: [],
    replayProtection: {
      maxSkewMs: 300000,
      nonceTtlMs: 300000,
    },
    concurrency: 16,
  },
  localAgent: {
    enabled: false,
    serverUrl: 'ws://127.0.0.1:3002/bridge/agent',
    agentId: '',
    secret: '',
    reconnectIntervalMs: 5000,
    requestTimeoutMs: 30000,
    policy: {
      allowedTools: [],
      workingDirectory: process.cwd(),
      allowEnvironment: false,
      allowedEnvironmentKeys: [],
    },
    replayProtection: {
      maxSkewMs: 300000,
      nonceTtlMs: 300000,
    },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfig(base: ServerConfig, override: Partial<ServerConfig>): ServerConfig {
  return {
    ...base,
    ...override,
    blockedCommands: override.blockedCommands ?? base.blockedCommands,
    allowedPaths: override.allowedPaths ?? base.allowedPaths,
    requireConfirmationPatterns:
      override.requireConfirmationPatterns ?? base.requireConfirmationPatterns,
    concurrency: {
      http: override.concurrency?.http ?? base.concurrency?.http ?? 16,
      bridge: override.concurrency?.bridge ?? base.concurrency?.bridge ?? 16,
    },
    bridge: override.bridge
      ? {
          ...base.bridge,
          ...override.bridge,
          agents: override.bridge.agents ?? base.bridge?.agents ?? [],
          bearerTokens: override.bridge.bearerTokens ?? base.bridge?.bearerTokens ?? [],
          replayProtection: {
            ...base.bridge?.replayProtection,
            ...override.bridge.replayProtection,
          },
          concurrency:
            override.bridge.concurrency ?? base.bridge?.concurrency ?? 16,
        }
      : base.bridge,
    localAgent: override.localAgent
      ? {
          ...base.localAgent,
          ...override.localAgent,
          policy: {
            ...base.localAgent?.policy,
            ...override.localAgent.policy,
            allowedTools:
              override.localAgent.policy?.allowedTools ?? base.localAgent?.policy.allowedTools ?? [],
            allowedEnvironmentKeys:
              override.localAgent.policy?.allowedEnvironmentKeys ??
              base.localAgent?.policy.allowedEnvironmentKeys ??
              [],
          },
          replayProtection: {
            ...base.localAgent?.replayProtection,
            ...override.localAgent.replayProtection,
          },
        }
      : base.localAgent,
  };
}

export async function loadConfig(configPath?: string): Promise<ServerConfig> {
  const resolvedPath = configPath ?? process.env.SDGC_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return { ...defaultConfig };
  }

  const raw = await readFile(resolvedPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (!isObject(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${resolvedPath}`);
  }

  return mergeConfig(defaultConfig, parsed as Partial<ServerConfig>);
}
