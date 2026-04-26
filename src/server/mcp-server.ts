import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadConfig } from '../config/default.js';
import { ToolService, redactErrorMessage } from './tool-service.js';

export class BashMcpServer {
  private readonly server: Server;
  private toolService!: ToolService;
  private transport: StdioServerTransport | null = null;
  private stopping = false;
  private readonly signalHandlers: Partial<Record<NodeJS.Signals, () => void>> = {};

  private constructor() {
    this.server = new Server(
      {
        name: 'sdgc-bash-local-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  }

  static async create(configPath?: string): Promise<BashMcpServer> {
    const config = await loadConfig(configPath);
    const instance = new BashMcpServer();
    instance.toolService = new ToolService(config);
    instance.registerHandlers();
    return instance;
  }

  async start(): Promise<void> {
    this.transport = new StdioServerTransport();
    this.registerProcessHandlers();
    await this.server.connect(this.transport);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;

    this.unregisterProcessHandlers();
    await this.toolService.stop();
    await this.server.close();
    this.transport = null;
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolService.listTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const toolName = request.params.name;
      const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

      try {
        const result = await this.toolService.callTool(toolName, rawArgs);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        if (error instanceof McpError) {
          throw error;
        }
        if (error instanceof z.ZodError) {
          throw new McpError(ErrorCode.InvalidParams, redactErrorMessage(error));
        }
        if (error instanceof Error && error.message.startsWith('Unknown tool:')) {
          throw new McpError(ErrorCode.MethodNotFound, error.message);
        }

        console.error(`Tool call failed for ${toolName}:`, error instanceof Error ? error.message : error);
        throw new McpError(ErrorCode.InternalError, redactErrorMessage(error));
      }
    });
  }

  private registerProcessHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
        void this.stop().finally(() => {
          process.exit(0);
        });
      };

      this.signalHandlers[signal] = handler;
      process.once(signal, handler);
    }
  }

  private unregisterProcessHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = this.signalHandlers[signal];
      if (handler) {
        process.removeListener(signal, handler);
        delete this.signalHandlers[signal];
      }
    }
  }
}
