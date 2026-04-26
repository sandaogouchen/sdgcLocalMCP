import path from 'node:path';

import { BridgeCallToolRequest, BridgeToolPolicy } from '../types/index.js';

function isSubPath(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function enforceAgentToolPolicy(
  request: BridgeCallToolRequest,
  policy: BridgeToolPolicy
): BridgeCallToolRequest {
  if (!policy.allowedTools.includes(request.name)) {
    throw new Error(`Tool not allowed by agent policy: ${request.name}`);
  }

  const args = { ...(request.arguments ?? {}) };
  const fixedWorkingDirectory = path.resolve(policy.workingDirectory);

  if ('workingDirectory' in args) {
    const requested = args.workingDirectory;
    if (typeof requested !== 'string') {
      throw new Error('workingDirectory must be a string');
    }

    const resolvedRequested = path.resolve(requested);
    if (!isSubPath(fixedWorkingDirectory, resolvedRequested)) {
      throw new Error('workingDirectory is outside agent policy root');
    }
    args.workingDirectory = resolvedRequested;
  } else {
    args.workingDirectory = fixedWorkingDirectory;
  }

  if ('env' in args) {
    if (!policy.allowEnvironment) {
      throw new Error('Environment overrides are disabled by agent policy');
    }

    const env = args.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      throw new Error('env must be an object');
    }

    const filteredEntries = Object.entries(env as Record<string, unknown>).filter(
      ([key, value]) =>
        typeof value === 'string' && (policy.allowedEnvironmentKeys ?? []).includes(key)
    );

    args.env = Object.fromEntries(filteredEntries);
  }

  return {
    ...request,
    arguments: args,
  };
}
