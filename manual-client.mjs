import { spawn } from 'node:child_process';
import { once } from 'node:events';

const child = spawn('node', ['dist/src/index.js'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

child.stdout.on('data', chunk => {
  stdout += chunk;
});

child.stderr.on('data', chunk => {
  stderr += chunk;
});

child.on('error', error => {
  console.error('child process error:', error);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function drainMessages() {
  const messages = [];

  while (true) {
    const idx = stdout.indexOf('\n');
    if (idx === -1) break;

    const line = stdout.slice(0, idx).replace(/\r$/, '');
    stdout = stdout.slice(idx + 1);

    if (!line.trim()) continue;
    messages.push(JSON.parse(line));
  }

  return messages;
}

async function waitForMessage(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = drainMessages();
    const hit = messages.find(predicate);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out. stderr=${stderr} stdout_buffer=${stdout}`);
}

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'manual-client', version: '0.1.0' },
    },
  });

  const initResp = await waitForMessage(msg => msg.id === 1);

  send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });

  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  const listResp = await waitForMessage(msg => msg.id === 2);

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'execute_bash',
      arguments: { command: 'echo hi' },
    },
  });

  const callResp = await waitForMessage(msg => msg.id === 3, 12000);

  console.log(JSON.stringify({ initResp, listResp, callResp, stderr }, null, 2));
} finally {
  child.kill('SIGTERM');
  try {
    await once(child, 'exit');
  } catch {}
}
