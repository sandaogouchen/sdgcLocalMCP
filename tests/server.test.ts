import assert from 'node:assert';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const serverEntry = path.join(repoRoot, 'src', 'index.js');

type TextContent = { type: 'text'; text: string };

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverEntry],
    cwd: repoRoot,
  });
  const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

test('MCP list tools', async () => {
  await withClient(async client => {
    const result = await client.listTools();
    const toolNames = result.tools.map(tool => tool.name).sort();

    assert.deepStrictEqual(toolNames, ['check_command_safety', 'execute_bash']);

    const execTool = result.tools.find(tool => tool.name === 'execute_bash');
    assert.ok(execTool);
    assert.strictEqual(execTool.inputSchema.type, 'object');
    assert.strictEqual(execTool.inputSchema.additionalProperties, false);
    assert.deepStrictEqual(execTool.inputSchema.required, ['command']);
  });
});

test('call execute_bash echo hi', async () => {
  await withClient(async client => {
    const result = await client.callTool({
      name: 'execute_bash',
      arguments: { command: 'echo hi' },
    });

    assert.strictEqual(result.isError, undefined);

    const content = result.content as TextContent[];
    assert.strictEqual(content[0]?.type, 'text');

    const payload = JSON.parse(content[0].text);
    assert.strictEqual(payload.stdout.trim(), 'hi');
    assert.strictEqual(payload.exitCode, 0);
  });
});

test('unknown tool returns -32601', async () => {
  await withClient(async client => {
    await assert.rejects(client.callTool({ name: 'non_existent_cmd', arguments: {} }), err => {
      assert.ok(err instanceof McpError);
      assert.strictEqual(err.code, ErrorCode.MethodNotFound);
      return true;
    });
  });
});

test('invalid params returns -32602', async () => {
  await withClient(async client => {
    await assert.rejects(
      client.callTool({ name: 'execute_bash', arguments: { timeout: 100 } }),
      err => {
        assert.ok(err instanceof McpError);
        assert.strictEqual(err.code, ErrorCode.InvalidParams);
        return true;
      }
    );
  });
});
