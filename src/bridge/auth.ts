import { IncomingMessage } from 'node:http';

import { BridgeAgentCredentials } from '../types/index.js';

export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');
  if (!scheme || !value || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return value.trim();
}

export function requireBearerToken(req: IncomingMessage, allowedTokens: string[]): void {
  if (!allowedTokens.length) {
    throw new Error('Bridge bearer token list is empty');
  }

  const token = extractBearerToken(req);
  if (!token || !allowedTokens.includes(token)) {
    throw new Error('Unauthorized bearer token');
  }
}

export function resolveAgentSecret(agentId: string, agents: BridgeAgentCredentials[]): string {
  const agent = agents.find(item => item.agentId === agentId);
  if (!agent) {
    throw new Error(`Unknown agent_id: ${agentId}`);
  }
  return agent.secret;
}
