export interface CommandRequest {
  command: string;
  timeout?: number;
  workingDirectory?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  timestamp: Date;
}

export interface SafetyCheckResult {
  allowed: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
  requiresConfirmation: boolean;
  blockedPatterns?: string[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  command: string;
  result: CommandResult;
  safetyCheck: SafetyCheckResult;
  sessionId?: string;
}

export interface BridgeAgentCredentials {
  agentId: string;
  secret: string;
}

export interface BridgeToolPolicy {
  allowedTools: string[];
  workingDirectory: string;
  allowEnvironment?: boolean;
  allowedEnvironmentKeys?: string[];
}

export interface BridgeReplayProtectionConfig {
  maxSkewMs: number;
  nonceTtlMs: number;
}

export interface BridgeServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  wsPath: string;
  bearerTokens: string[];
  requestTimeoutMs: number;
  agents: BridgeAgentCredentials[];
  replayProtection: BridgeReplayProtectionConfig;
}

export interface LocalAgentConfig {
  enabled: boolean;
  serverUrl: string;
  agentId: string;
  secret: string;
  reconnectIntervalMs: number;
  requestTimeoutMs: number;
  policy: BridgeToolPolicy;
  replayProtection: BridgeReplayProtectionConfig;
}

export interface ServerConfig {
  maxTimeout: number;
  defaultTimeout: number;
  workingDirectory: string;
  auditLogPath?: string;
  enableAudit: boolean;
  blockedCommands: string[];
  allowedPaths: string[];
  requireConfirmationPatterns: string[];
  bridge?: BridgeServerConfig;
  localAgent?: LocalAgentConfig;
}

export interface BridgeSecurityEnvelope {
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface BridgeBaseMessage {
  type: string;
  security: BridgeSecurityEnvelope;
}

export interface BridgeAgentHelloMessage extends BridgeBaseMessage {
  type: 'agent_hello';
  agentId: string;
}

export interface BridgeCallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface BridgeToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeToolCallMessage extends BridgeBaseMessage {
  type: 'tool_call';
  requestId: string;
  request: BridgeCallToolRequest;
}

export interface BridgeToolResultMessage extends BridgeBaseMessage {
  type: 'tool_result';
  requestId: string;
  response: BridgeToolResult;
}

export interface BridgeErrorMessage extends BridgeBaseMessage {
  type: 'error';
  requestId?: string;
  error: string;
}

export type BridgeMessage =
  | BridgeAgentHelloMessage
  | BridgeToolCallMessage
  | BridgeToolResultMessage
  | BridgeErrorMessage;
