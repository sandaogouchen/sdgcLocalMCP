import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { WebSocketServer } from 'ws';
import { z } from 'zod';

import { requireBearerToken, resolveAgentSecret } from './auth.js';
import { attachSecurity, verifyBridgeMessage } from './protocol.js';
import { ToolService, redactErrorMessage } from '../server/tool-service.js';
import {
  BridgeErrorMessage,
  BridgeMessage,
  BridgeServerConfig,
  BridgeToolCallMessage,
  BridgeToolResultMessage,
} from '../types/index.js';

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

interface AgentConnection {
  socket: import('ws').WebSocket;
  agentId: string;
  secret: string;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function getRequestParams(params: unknown): { name?: unknown; arguments?: unknown } {
  if (typeof params === 'object' && params !== null) {
    return params as { name?: unknown; arguments?: unknown };
  }
  return {};
}

function makeError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

export class BridgePublicServer {
  private readonly httpServer: http.Server;
  private readonly wsServer: WebSocketServer;
  private readonly agents = new Map<string, AgentConnection>();

  constructor(
    private readonly config: BridgeServerConfig,
    private readonly toolService: ToolService
  ) {
    this.httpServer = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    this.wsServer = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== this.config.wsPath) {
        socket.destroy();
        return;
      }

      try {
        const requestUrl = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`);
        const agentId = requestUrl.searchParams.get('agent_id') ?? '';
        const secret = requestUrl.searchParams.get('secret') ?? '';
        const expectedSecret = resolveAgentSecret(agentId, this.config.agents);
        if (!agentId || !secret || secret !== expectedSecret) {
          throw new Error('Unauthorized agent connection');
        }

        this.wsServer.handleUpgrade(req, socket, head, ws => {
          const connection: AgentConnection = { socket: ws, agentId, secret };
          this.agents.set(agentId, connection);

          ws.on('close', () => {
            const current = this.agents.get(agentId);
            if (current?.socket === ws) {
              this.agents.delete(agentId);
            }
          });
        });
      } catch {
        socket.destroy();
      }
    });
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    await new Promise<void>(resolve => {
      this.httpServer.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.agents.values()) {
      connection.socket.close();
    }
    this.agents.clear();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          ok: true,
          bridge: true,
          agents: [...this.agents.keys()],
        });
      }

      if (req.method !== 'POST' || req.url !== this.config.path) {
        return sendJson(res, 404, { error: 'Not Found' });
      }

      requireBearerToken(req, this.config.bearerTokens);
      const payload = JsonRpcRequestSchema.parse(JSON.parse(await readBody(req)));
      const id = payload.id ?? null;
      const params = getRequestParams(payload.params);

      switch (payload.method) {
        case 'initialize':
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'sdgc-bash-bridge-mcp',
                version: '0.1.0',
              },
            },
          });
        case 'notifications/initialized':
          return sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
        case 'tools/list':
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              tools: this.toolService.listTools(),
            },
          });
        case 'tools/call': {
          const name = params.name;
          const args = params.arguments ?? {};
          if (!name || typeof name !== 'string') {
            return sendJson(res, 200, makeError(id, -32602, 'Invalid params: tool name is required'));
          }

          const agent = this.selectAgent();
          if (!agent) {
            return sendJson(res, 503, makeError(id, -32000, 'No connected bridge agent available'));
          }

          try {
            const result = await this.dispatchToolCall(agent, {
              name,
              arguments:
                typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
            });
            if (!result.ok) {
              return sendJson(res, 200, makeError(id, -32603, result.error ?? 'Bridge tool call failed'));
            }
            return sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(result.result ?? {}, null, 2),
                  },
                ],
              },
            });
          } catch (error) {
            return sendJson(res, 200, makeError(id, -32603, redactErrorMessage(error)));
          }
        }
        default:
          return sendJson(res, 200, makeError(id, -32601, `Method not found: ${payload.method}`));
      }
    } catch (error) {
      return sendJson(res, 401, makeError(null, -32603, redactErrorMessage(error)));
    }
  }

  private selectAgent(): AgentConnection | undefined {
    return this.agents.values().next().value;
  }

  private async dispatchToolCall(
    agent: AgentConnection,
    request: { name: string; arguments?: Record<string, unknown> }
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const requestId = randomUUID();
    const message: BridgeToolCallMessage = attachSecurity(agent.secret, {
      type: 'tool_call' as const,
      requestId,
      request,
    });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Bridge tool call timed out after ${this.config.requestTimeoutMs}ms`));
      }, this.config.requestTimeoutMs);

      const messageHandler = (rawData: import('ws').RawData) => {
        try {
          const payload = JSON.parse(rawData.toString()) as BridgeMessage;
          verifyBridgeMessage(
            agent.secret,
            payload,
            this.config.replayProtection,
            `public-server:${agent.agentId}`
          );

          if (payload.type === 'tool_result') {
            const toolResult = payload as BridgeToolResultMessage;
            if (toolResult.requestId !== requestId) {
              return;
            }
            cleanup();
            resolve(toolResult.response);
          } else if (payload.type === 'error') {
            const errorMessage = payload as BridgeErrorMessage;
            if (errorMessage.requestId && errorMessage.requestId !== requestId) {
              return;
            }
            cleanup();
            resolve({ ok: false, error: errorMessage.error });
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        agent.socket.off('message', messageHandler);
      };

      agent.socket.on('message', messageHandler);
      agent.socket.send(JSON.stringify(message));
    });
  }
}
