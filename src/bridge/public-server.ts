import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';

import { requireBearerToken, resolveAgentSecret } from './auth.js';
import { attachSecurity, verifyBridgeMessage } from './protocol.js';
import { Semaphore } from '../server/semaphore.js';
import { ToolService, redactErrorMessage } from '../server/tool-service.js';
import {
  BridgeErrorMessage,
  BridgeMessage,
  BridgeServerConfig,
  BridgeToolCallMessage,
  BridgeToolResult,
  BridgeToolResultMessage,
} from '../types/index.js';

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

interface AgentConnection {
  socket: WebSocket;
  agentId: string;
  secret: string;
  /** In-flight requestIds owned by this agent, used for bulk reject on disconnect. */
  inflight: Set<string>;
}

interface PendingCall {
  resolve: (r: BridgeToolResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendAccepted(res: http.ServerResponse): void {
  res.writeHead(202);
  res.end();
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
  /** Single source of truth for request → resolver routing. O(1) dispatch + O(1) route. */
  private readonly pending = new Map<string, PendingCall>();
  private readonly bridgeSem: Semaphore;

  constructor(
    private readonly config: BridgeServerConfig,
    private readonly toolService: ToolService
  ) {
    this.bridgeSem = new Semaphore(config.concurrency ?? 16);

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
          const connection: AgentConnection = {
            socket: ws,
            agentId,
            secret,
            inflight: new Set(),
          };
          this.agents.set(agentId, connection);

          // ✨ Register exactly ONE message handler per connection.
          // Previous implementation registered N handlers (one per in-flight
          // request), which caused every incoming message to be verified N
          // times against a shared nonce cache, triggering spurious
          // "nonce already used" errors under concurrency.
          ws.on('message', (raw: RawData) => this.routeAgentMessage(connection, raw));

          ws.on('close', () => {
            // Bulk-reject all in-flight requests owned by this agent so that
            // callers don't wait for the full requestTimeoutMs.
            for (const reqId of connection.inflight) {
              const entry = this.pending.get(reqId);
              if (entry) {
                clearTimeout(entry.timer);
                this.pending.delete(reqId);
                entry.reject(new Error('Bridge agent disconnected'));
              }
            }
            connection.inflight.clear();

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

    // Reject any stragglers to release their callers.
    for (const [reqId, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Bridge server stopping'));
      this.pending.delete(reqId);
    }

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

  /**
   * Single per-connection message router. Verifies signature/nonce exactly
   * once, then looks up the pending resolver by requestId.
   */
  private routeAgentMessage(agent: AgentConnection, raw: RawData): void {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw.toString()) as BridgeMessage;
      verifyBridgeMessage(
        agent.secret,
        message,
        this.config.replayProtection,
        `public-server:${agent.agentId}`
      );
    } catch (err) {
      // Do NOT tear down the whole channel for a bad single frame; just log.
      console.error(
        `[bridge] invalid message from agent=${agent.agentId}:`,
        err instanceof Error ? err.message : err
      );
      return;
    }

    if (message.type !== 'tool_result' && message.type !== 'error') {
      return;
    }

    const requestId =
      message.type === 'tool_result'
        ? (message as BridgeToolResultMessage).requestId
        : (message as BridgeErrorMessage).requestId;

    if (!requestId) {
      return;
    }

    const entry = this.pending.get(requestId);
    if (!entry) {
      // Request may have already timed out or the agent disconnected and
      // reconnected. Safe to drop.
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    agent.inflight.delete(requestId);

    if (message.type === 'tool_result') {
      entry.resolve((message as BridgeToolResultMessage).response);
    } else {
      entry.resolve({ ok: false, error: (message as BridgeErrorMessage).error });
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          ok: true,
          bridge: true,
          agents: [...this.agents.keys()],
          concurrency: {
            bridge: {
              capacity: this.bridgeSem.maxConcurrency,
              inFlight: this.bridgeSem.inFlight,
              queueDepth: this.bridgeSem.queueDepth,
            },
          },
          pendingRequests: this.pending.size,
          audit: {
            pending: this.toolService.getAuditPending(),
          },
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
          if (payload.id === undefined) {
            return sendAccepted(res);
          }
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

          // Fail-fast concurrency gate, matches HTTP transport semantics.
          if (!this.bridgeSem.tryAcquire()) {
            return sendJson(
              res,
              503,
              makeError(
                id,
                -32000,
                `Too many concurrent tool calls on Bridge endpoint (limit ${this.bridgeSem.maxConcurrency})`
              )
            );
          }

          try {
            const agent = this.selectAgent();
            if (!agent) {
              return sendJson(res, 503, makeError(id, -32000, 'No connected bridge agent available'));
            }

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
          } finally {
            this.bridgeSem.release();
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

  /**
   * Dispatch a tool call to an agent. Unlike the old implementation, this
   * does NOT register a per-request message listener — routing is done by
   * the connection-level handler via `this.pending`.
   */
  private dispatchToolCall(
    agent: AgentConnection,
    request: { name: string; arguments?: Record<string, unknown> }
  ): Promise<BridgeToolResult> {
    const requestId = randomUUID();
    const message: BridgeToolCallMessage = attachSecurity(agent.secret, {
      type: 'tool_call' as const,
      requestId,
      request,
    });

    return new Promise<BridgeToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          agent.inflight.delete(requestId);
          reject(new Error(`Bridge tool call timed out after ${this.config.requestTimeoutMs}ms`));
        }
      }, this.config.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer, agentId: agent.agentId });
      agent.inflight.add(requestId);

      try {
        agent.socket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        if (this.pending.delete(requestId)) {
          agent.inflight.delete(requestId);
        }
        reject(err instanceof Error ? err : new Error('Failed to send bridge message'));
      }
    });
  }
}
