import http from 'node:http';

import { z } from 'zod';

import { loadConfig } from './config/default.js';
import { Semaphore } from './server/semaphore.js';
import { ToolService, redactErrorMessage } from './server/tool-service.js';

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

function parseConfigPath(argv: string[]): string | undefined {
  const idx = argv.indexOf('--config');
  if (idx === -1 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

function resolveHost(): string {
  return process.env.HOST || '0.0.0.0';
}

function resolveAdvertisedHost(host: string): string {
  if (host === '0.0.0.0') {
    return process.env.ADVERTISED_HOST || '127.0.0.1';
  }
  return process.env.ADVERTISED_HOST || host;
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

function getRequestParams(params: unknown): { name?: unknown; arguments?: unknown } {
  if (typeof params === 'object' && params !== null) {
    return params as { name?: unknown; arguments?: unknown };
  }
  return {};
}

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const toolService = new ToolService(config);

  const httpCapacity = config.concurrency?.http ?? 16;
  const httpSem = new Semaphore(httpCapacity);

  const host = resolveHost();
  const advertisedHost = resolveAdvertisedHost(host);
  const port = Number(process.env.PORT || 3001);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          ok: true,
          name: 'sdgc-bash-local-mcp-http',
          host,
          port,
          endpoint: `http://${advertisedHost}:${port}/mcp`,
          concurrency: {
            http: {
              capacity: httpSem.maxConcurrency,
              inFlight: httpSem.inFlight,
              queueDepth: httpSem.queueDepth,
            },
          },
          audit: {
            pending: toolService.getAuditPending(),
          },
        });
      }

      if (req.method === 'GET' && req.url === '/mcp') {
        return sendJson(res, 200, {
          name: 'sdgc-local-mcp',
          description: 'Local MCP HTTP endpoint',
          endpoint: `http://${advertisedHost}:${port}/mcp`,
          bindHost: host,
        });
      }

      if (req.method !== 'POST' || req.url !== '/mcp') {
        return sendJson(res, 404, {
          error: 'Not Found',
        });
      }

      const rawBody = await readBody(req);
      const payload = JsonRpcRequestSchema.parse(JSON.parse(rawBody));
      const id = payload.id ?? null;
      const params = getRequestParams(payload.params);

      switch (payload.method) {
        case 'initialize':
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: 'sdgc-bash-local-mcp',
                version: '0.1.0',
              },
            },
          });

        case 'notifications/initialized':
          if (payload.id === undefined) {
            return sendAccepted(res);
          }
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {},
          });

        case 'tools/list':
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              tools: toolService.listTools(),
            },
          });

        case 'tools/call': {
          const name = params.name;
          const args = params.arguments ?? {};

          if (!name || typeof name !== 'string') {
            return sendJson(res, 200, makeError(id, -32602, 'Invalid params: tool name is required'));
          }

          // Fail-fast concurrency gate: reject immediately when saturated so
          // clients can retry rather than pile up server-side.
          if (!httpSem.tryAcquire()) {
            return sendJson(
              res,
              503,
              makeError(
                id,
                -32000,
                `Too many concurrent tool calls on HTTP endpoint (limit ${httpSem.maxConcurrency})`
              )
            );
          }

          try {
            const result = await toolService.callTool(name, args);
            return sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(result, null, 2),
                  },
                ],
              },
            });
          } catch (error: unknown) {
            if (error instanceof z.ZodError) {
              return sendJson(res, 200, makeError(id, -32602, redactErrorMessage(error)));
            }

            if (error instanceof Error && error.message.startsWith('Unknown tool:')) {
              return sendJson(res, 200, makeError(id, -32601, error.message));
            }

            return sendJson(res, 200, makeError(id, -32603, redactErrorMessage(error)));
          } finally {
            httpSem.release();
          }
        }

        default:
          return sendJson(res, 200, makeError(id, -32601, `Method not found: ${payload.method}`));
      }
    } catch (error: unknown) {
      return sendJson(res, 400, makeError(null, -32700, redactErrorMessage(error)));
    }
  });

  server.listen(port, host, () => {
    console.log(`SDGC Local MCP HTTP server listening on ${host}:${port}`);
    console.log(`MCP endpoint: http://${advertisedHost}:${port}/mcp`);
    console.log(`HTTP concurrency limit: ${httpSem.maxConcurrency}`);
  });

  const closeServer = () => {
    server.close(() => {
      void toolService.stop().finally(() => {
        process.exit(0);
      });
    });
  };

  process.once('SIGINT', closeServer);
  process.once('SIGTERM', closeServer);
}

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
