import WebSocket from 'ws';

import { attachSecurity, verifyBridgeMessage } from './protocol.js';
import {
  BridgeErrorMessage,
  BridgeMessage,
  BridgeToolCallMessage,
  LocalAgentConfig,
} from '../types/index.js';
import { ToolService } from '../server/tool-service.js';
import { enforceAgentToolPolicy } from './policy.js';

export class LocalBridgeAgent {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly config: LocalAgentConfig,
    private readonly toolService: ToolService
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private connect(): void {
    const url = new URL(this.config.serverUrl);
    url.searchParams.set('agent_id', this.config.agentId);
    url.searchParams.set('secret', this.config.secret);

    this.socket = new WebSocket(url);

    this.socket.on('open', () => {
      this.send(
        attachSecurity(this.config.secret, {
          type: 'agent_hello' as const,
          agentId: this.config.agentId,
        })
      );
    });

    this.socket.on('message', data => {
      void this.handleMessage(data.toString());
    });

    this.socket.on('close', () => {
      this.socket = null;
      if (!this.stopping) {
        this.scheduleReconnect();
      }
    });

    this.socket.on('error', error => {
      console.error('Bridge agent websocket error:', error.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectIntervalMs);
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw) as BridgeMessage;
      verifyBridgeMessage(
        this.config.secret,
        message,
        this.config.replayProtection,
        `local-agent:${this.config.agentId}`
      );
    } catch (error) {
      this.sendError(undefined, error instanceof Error ? error.message : 'Invalid bridge message');
      return;
    }

    if (message.type !== 'tool_call') {
      return;
    }

    const toolCall = message as BridgeToolCallMessage;
    try {
      const approvedRequest = enforceAgentToolPolicy(toolCall.request, this.config.policy);
      const result = await this.toolService.callTool(approvedRequest.name, approvedRequest.arguments ?? {});
      this.send(
        attachSecurity(this.config.secret, {
          type: 'tool_result' as const,
          requestId: toolCall.requestId,
          response: {
            ok: true,
            result,
          },
        })
      );
    } catch (error) {
      this.sendError(toolCall.requestId, error instanceof Error ? error.message : 'Tool execution failed');
    }
  }

  private sendError(requestId: string | undefined, error: string): void {
    const payload: BridgeErrorMessage = attachSecurity(this.config.secret, {
      type: 'error' as const,
      requestId,
      error,
    });
    this.send(payload);
  }

  private send(message: BridgeMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }
}
