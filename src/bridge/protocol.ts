import crypto from 'node:crypto';

import {
  BridgeBaseMessage,
  BridgeMessage,
  BridgeReplayProtectionConfig,
  BridgeSecurityEnvelope,
} from '../types/index.js';

const nonceCache = new Map<string, number>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function withSecurityOmitted(message: BridgeBaseMessage): Record<string, unknown> {
  const { security, ...rest } = message as BridgeBaseMessage & Record<string, unknown>;
  return rest;
}

export function signBridgePayload(secret: string, payload: Record<string, unknown>): string {
  return crypto.createHmac('sha256', secret).update(stableStringify(payload)).digest('hex');
}

export function attachSecurity<T extends Record<string, unknown>>(
  secret: string,
  message: T & { type: string },
  envelope?: Partial<BridgeSecurityEnvelope>
): T & { security: BridgeSecurityEnvelope } {
  const securityBase = {
    timestamp: envelope?.timestamp ?? Date.now(),
    nonce: envelope?.nonce ?? crypto.randomUUID(),
  };
  const signature = signBridgePayload(secret, {
    ...message,
    timestamp: securityBase.timestamp,
    nonce: securityBase.nonce,
  });

  return {
    ...message,
    security: {
      ...securityBase,
      signature,
    },
  } as T & { security: BridgeSecurityEnvelope };
}

export function verifyBridgeMessage(
  secret: string,
  message: BridgeMessage,
  replayProtection: BridgeReplayProtectionConfig,
  cacheScope: string
): void {
  const now = Date.now();
  const { timestamp, nonce, signature } = message.security;

  if (Math.abs(now - timestamp) > replayProtection.maxSkewMs) {
    throw new Error('Bridge message timestamp outside allowed skew');
  }

  const cacheKey = `${cacheScope}:${nonce}`;
  const existing = nonceCache.get(cacheKey);
  if (existing && existing > now) {
    throw new Error('Bridge message nonce already used');
  }

  const expected = signBridgePayload(secret, {
    ...withSecurityOmitted(message),
    timestamp,
    nonce,
  });

  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error('Bridge message signature mismatch');
  }

  nonceCache.set(cacheKey, now + replayProtection.nonceTtlMs);
  pruneNonceCache(now);
}

function pruneNonceCache(now: number): void {
  for (const [key, expiresAt] of nonceCache.entries()) {
    if (expiresAt <= now) {
      nonceCache.delete(key);
    }
  }
}
