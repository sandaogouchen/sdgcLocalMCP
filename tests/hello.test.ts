import assert from 'node:assert';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config/default.js';
import { BashExecutor } from '../src/executor/bash.js';
import { SafetyChecker } from '../src/safety/checker.js';

describe('Safety Checker', () => {
  const checker = new SafetyChecker(defaultConfig);

  it('should allow safe read commands', () => {
    const result = checker.check('ls -la', { command: 'ls -la' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.riskLevel, 'low');
  });

  it('should block dangerous commands', () => {
    const result = checker.check('rm -rf /', { command: 'rm -rf /' });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.riskLevel, 'critical');
  });

  it('should flag sudo as high risk', () => {
    const result = checker.check('sudo apt-get update', { command: 'sudo apt-get update' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.riskLevel, 'high');
    assert.strictEqual(result.requiresConfirmation, true);
  });
});

describe('Bash Executor', () => {
  const executor = new BashExecutor(defaultConfig);

  it('should execute echo command', async () => {
    const result = await executor.execute({ command: 'echo "Hello World"' });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('Hello World'));
    assert.ok(result.duration >= 0);
  });

  it('should handle non-existent command', async () => {
    const result = await executor.execute({ command: 'this_command_does_not_exist_12345' });
    assert.notStrictEqual(result.exitCode, 0);
  });
});
