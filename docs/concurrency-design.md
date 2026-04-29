# SDGC Local MCP 并发执行设计文档

> 版本: v1.0 · 2026-04-29 · Owner: 马远力
> 目标: 使 HTTP 模式与 Bridge 模式的 `tools/call` 能安全、正确地处理多个同时到达的请求

---

## 1. 背景与目标

### 1.1 问题陈述
当前 sdgcLocalMCP 已存在三种接入形态（stdio / HTTP / Bridge）。在"多个客户端请求同时打到同一进程"的场景下：

- **HTTP 模式** 基于 Node `http.Server` + `spawn`，事件循环天然并行，**功能上已支持并发**，但缺少：并发上限、审计日志并发安全、可观测性。
- **Bridge 模式** 使用"单 WS + 广播 message 事件 + 按 requestId 过滤"的路由方式，**并发请求 ≥ 2 时存在正确性 bug**：
  - `verifyBridgeMessage` 的全局 `nonceCache` 对同一 nonce 第二次校验必然抛 `Bridge message nonce already used`；
  - 每个 in-flight 请求都注册一个 `on('message', ...)` handler → 对方返回的 **每一条**消息会被 N 个 handler 重复 verify → 从第二个 handler 起必报 replay 错误。
- **AuditLogger** 使用内存 buffer + `this.logBuffer = []` 清空模式，`flush` 期间的 `await appendFile` 是异步窗口，窗口内新 push 的日志在清空时会**被整批丢弃**。

### 1.2 目标
1. Bridge 模式支持至少 16 并发，正确性无退化。
2. HTTP 与 Bridge **各自独立**的 in-flight 上限均为 16（超出返回 503）。
3. 审计日志在并发下不丢、不交错、不破坏 JSON 行格式。
4. 暴露 `/health` 可观测字段，便于排障。
5. 不改变现有 JSON-RPC / Bridge 线上协议，客户端零改动。

### 1.3 非目标
- 不实现 `execute_bash_batch` 聚合工具。
- 不做多 agent 负载均衡（保留单 agent 行为）。
- 不改 stdio 模式（已并发安全）。

---

## 2. 现状诊断（基于源码）

### 2.1 HTTP 模式
- 入口 `src/http-server.ts` — 每个 POST `/mcp` 独立 async handler，无阻塞。
- `ToolService.callTool` → `BashExecutor.execute` 基于 `child_process.spawn`，每次调用独立子进程。
- **结论**：本身并发安全；缺护栏与可观测性。

### 2.2 Bridge 模式（🔴 正确性缺陷）
- `src/bridge/public-server.ts::dispatchToolCall`
  - 每次调用都对 `agent.socket` 执行 `on('message', messageHandler)`。
  - 每个 handler 内都会调用 `verifyBridgeMessage(...)` 对 **所有**到达消息校验（包括不属于自己 requestId 的）。
- `src/bridge/protocol.ts::verifyBridgeMessage`
  - 使用模块级 `nonceCache: Map<string, number>`，以 `${cacheScope}:${nonce}` 为 key，命中即抛错。
  - 结果：第二个并发请求到来并注册第二个 handler 后，agent 返回的第一条合法消息会被两个 handler 分别 verify → 第二次直接抛 replay。
- `local-agent.ts::handleMessage` 是 `void`-fire-and-forget，接收端本身并发无压力；但若 `ToolService.callTool` 内 audit log 并发冲突，会污染日志。

### 2.3 AuditLogger（🔴 并发下丢日志）
```ts
// logBuffer = [a, b]
await mkdir(...)
await appendFile(..., 'a\nb\n')   // ← 这段时间内另一个 flush 也在跑
// ↑ 两个 flush 都从 logBuffer 读到了 [a, b]，两条都被写两遍
this.logBuffer = [];              // 窗口内被 push 的 c 也被一并清掉
```
- 并发写会出现：日志**重复** + **丢失** + JSON 行**字节级交错**（`appendFile` 底层每次调用独立 open/write/close，不保证相对顺序）。

---

## 3. 设计总览

```
┌─────────────────────────────────────────────────────────────┐
│                     ToolService (shared)                    │
│  ┌────────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ BashExecutor   │   │ SafetyChecker│   │ AuditLogger  │  │
│  │   (已并发安全)  │   │  (pure func) │   │ (✨ 加互斥锁) │  │
│  └────────────────┘   └──────────────┘   └──────────────┘  │
└─────────────┬───────────────────────────────┬───────────────┘
              │                               │
   ┌──────────┴──────────┐         ┌──────────┴─────────────┐
   │  HttpSemaphore(16)  │         │  BridgeSemaphore(16)   │
   │  ✨ 独立并发护栏     │         │  ✨ 独立并发护栏        │
   └──────────┬──────────┘         └──────────┬─────────────┘
              │                               │
   ┌──────────┴──────────┐         ┌──────────┴─────────────┐
   │   http-server.ts    │         │  public-server.ts      │
   │   POST /mcp         │         │  POST /mcp             │
   │                     │         │  ✨ Map<reqId,resolver>│
   └─────────────────────┘         │     单一 ws.on handler │
                                   └────────────────────────┘
```

核心四项改造：
1. **Bridge 路由重构**：`on('message')` 只在连接建立时注册 1 次，维护 `pending: Map<requestId, {resolve,reject,timer}>`。
2. **HTTP / Bridge 各自独立的并发信号量**，默认 16，配置可调。
3. **AuditLogger 加互斥锁 + 写入原子化**。
4. **/health 扩展可观测字段**。

---

## 4. 详细设计

### 4.1 Bridge 消息路由重构

#### 4.1.1 新增数据结构
```ts
// src/bridge/public-server.ts
interface PendingCall {
  resolve: (r: BridgeToolResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  agentId: string;
}

interface AgentConnection {
  socket: WebSocket;
  agentId: string;
  secret: string;
  // ✨ 每个 agent 独立的 in-flight 集合（用于断线时批量 reject）
  inflight: Set<string>;
}

private readonly pending = new Map<string, PendingCall>();
```

#### 4.1.2 连接建立时一次性注册 handler
```ts
this.wsServer.handleUpgrade(req, socket, head, ws => {
  const connection: AgentConnection = { socket: ws, agentId, secret, inflight: new Set() };
  this.agents.set(agentId, connection);

  ws.on('message', (raw) => this.routeAgentMessage(connection, raw));

  ws.on('close', () => {
    // 断线时对该 agent 所有 in-flight 统一 reject
    for (const reqId of connection.inflight) {
      const entry = this.pending.get(reqId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(reqId);
        entry.reject(new Error('Bridge agent disconnected'));
      }
    }
    connection.inflight.clear();
    if (this.agents.get(agentId)?.socket === ws) this.agents.delete(agentId);
  });
});
```

#### 4.1.3 统一路由（每条消息只 verify 一次）
```ts
private routeAgentMessage(agent: AgentConnection, raw: RawData): void {
  let msg: BridgeMessage;
  try {
    msg = JSON.parse(raw.toString()) as BridgeMessage;
    verifyBridgeMessage(agent.secret, msg, this.config.replayProtection, `public-server:${agent.agentId}`);
  } catch (e) {
    console.error('[bridge] invalid message:', (e as Error).message);
    return; // 丢弃非法消息，不影响其他 in-flight
  }

  if (msg.type !== 'tool_result' && msg.type !== 'error') return;

  const reqId = (msg as BridgeToolResultMessage | BridgeErrorMessage).requestId;
  if (!reqId) return;

  const entry = this.pending.get(reqId);
  if (!entry) return; // 已超时或被断线清理，丢弃

  clearTimeout(entry.timer);
  this.pending.delete(reqId);
  agent.inflight.delete(reqId);

  if (msg.type === 'tool_result') {
    entry.resolve((msg as BridgeToolResultMessage).response);
  } else {
    entry.resolve({ ok: false, error: (msg as BridgeErrorMessage).error });
  }
}
```

#### 4.1.4 派发改为仅 set + send
```ts
private dispatchToolCall(agent: AgentConnection, request: BridgeCallToolRequest): Promise<BridgeToolResult> {
  const requestId = randomUUID();
  const message = attachSecurity(agent.secret, {
    type: 'tool_call' as const, requestId, request,
  });

  return new Promise((resolve, reject) => {
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
      this.pending.delete(requestId);
      agent.inflight.delete(requestId);
      reject(err as Error);
    }
  });
}
```

**复杂度**：派发 O(1)，路由 O(1)，N 并发的总开销由 O(N²) 降到 O(N)。
**兼容性**：WS 线上消息格式完全不变。

---

### 4.2 HTTP / Bridge 独立并发信号量

#### 4.2.1 通用 Semaphore 实现
```ts
// src/server/semaphore.ts (new)
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly capacity: number) {
    this.available = capacity;
  }
  async acquire(): Promise<void> {
    if (this.available > 0) { this.available--; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
  get inFlight(): number { return this.capacity - this.available; }
  get pending(): number { return this.waiters.length; }
}
```

#### 4.2.2 HTTP 侧使用（tryAcquire 语义：满载直接 503，不排队）
```ts
// http-server.ts
const httpSem = new Semaphore(config.concurrency?.http ?? 16);

case 'tools/call': {
  if (httpSem.pending >= 0 && httpSem.inFlight >= (config.concurrency?.http ?? 16)) {
    return sendJson(res, 503, makeError(id, -32000, 'Too many concurrent tool calls (HTTP)'));
  }
  await httpSem.acquire();
  try {
    const result = await toolService.callTool(name, args);
    // ...
  } finally {
    httpSem.release();
  }
}
```
> 说明：采用 **fail-fast 而非排队**，防止客户端侧 timeout 后仍被执行。

#### 4.2.3 Bridge 侧使用
```ts
// public-server.ts 内新增
private readonly bridgeSem = new Semaphore(this.config.concurrency ?? 16);

// 在 'tools/call' 分支：
if (this.bridgeSem.inFlight >= (this.config.concurrency ?? 16)) {
  return sendJson(res, 503, makeError(id, -32000, 'Too many concurrent tool calls (Bridge)'));
}
await this.bridgeSem.acquire();
try { /* dispatchToolCall ... */ }
finally { this.bridgeSem.release(); }
```

#### 4.2.4 配置扩展
```ts
// types/index.ts
export interface ConcurrencyConfig {
  http: number;      // default 16
  bridge: number;    // default 16
}
export interface ServerConfig { /* ... */ concurrency?: ConcurrencyConfig; }
export interface BridgeServerConfig { /* ... */ concurrency?: number; }
```
```ts
// config/default.ts
concurrency: { http: 16, bridge: 16 }
bridge: { /* ... */ concurrency: 16 }
```

---

### 4.3 AuditLogger 并发加固

#### 4.3.1 互斥 flush + 本地快照
```ts
// audit/logger.ts
private flushing: Promise<void> | null = null;

async log(entry: AuditLogEntry): Promise<void> {
  if (!this.config.enableAudit) return;
  this.logBuffer.push(entry);
  const isCritical = entry.safetyCheck.riskLevel === 'high'
                  || entry.safetyCheck.riskLevel === 'critical';
  if (isCritical) await this.flush();
}

async flush(): Promise<void> {
  if (!this.config.enableAudit || !this.config.auditLogPath) return;
  // ✨ 串行化：若已有 flush 在跑，复用同一 Promise
  if (this.flushing) { await this.flushing; return; }
  this.flushing = (async () => {
    try {
      while (this.logBuffer.length > 0) {
        const batch = this.logBuffer;          // ① 先拿引用
        this.logBuffer = [];                   // ② 立即换新数组（同步，无 await）
        await mkdir(dirname(this.config.auditLogPath!), { recursive: true });
        const lines = batch.map(entry => JSON.stringify({
          id: entry.id, timestamp: entry.timestamp.toISOString(),
          command: entry.command, exitCode: entry.result.exitCode,
          duration: entry.result.duration, riskLevel: entry.safetyCheck.riskLevel,
          sessionId: entry.sessionId,
        })).join('\n') + '\n';
        await appendFile(this.config.auditLogPath!, lines, 'utf-8');
        // 循环条件确保这期间新 push 进来的条目也会被写出
      }
    } catch (err) {
      console.error('Failed to write audit log', err);
    } finally {
      this.flushing = null;
    }
  })();
  await this.flushing;
}
```

**正确性要点**：
- `const batch = this.logBuffer; this.logBuffer = []` 是两行**同步**代码，中间无 await，Node 单线程下原子。
- `flushing` 作为互斥锁，保证任何时刻只有一个 `appendFile` 在跑，消除字节交错。
- `while (this.logBuffer.length > 0)` 保证 flush 运行期间被 push 的新条目在当前 flush 内被顺延写出，不需要再次调度。

#### 4.3.2 单次写原子性
Node 的 `fs.appendFile` 对 ≤ PIPE_BUF（Linux 4096B）的写是原子的。超过后内核可能拆分。因此：
- 每次 flush 的 `lines` 若 > 8KB，可选分批写（每批 ≤ 4KB），本文不强制，给到 TODO。

---

### 4.4 可观测性 (`/health`)

```ts
// http-server.ts
if (req.method === 'GET' && req.url === '/health') {
  return sendJson(res, 200, {
    ok: true, name: 'sdgc-bash-local-mcp-http',
    host, port, endpoint: `http://${advertisedHost}:${port}/mcp`,
    concurrency: {
      http: { capacity: 16, inFlight: httpSem.inFlight, queueDepth: httpSem.pending },
    },
    audit: { pending: toolService.getAuditPending() },
  });
}
```

```ts
// public-server.ts /health
return sendJson(res, 200, {
  ok: true, bridge: true,
  agents: [...this.agents.keys()],
  concurrency: {
    bridge: { capacity: 16, inFlight: this.bridgeSem.inFlight, queueDepth: this.bridgeSem.pending },
  },
  pendingRequests: this.pending.size,
});
```

---

## 5. 文件级改造清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/server/semaphore.ts` | **新增** | 通用 Semaphore |
| `src/types/index.ts` | 修改 | 新增 `ConcurrencyConfig`；`ServerConfig.concurrency?`；`BridgeServerConfig.concurrency?` |
| `src/config/default.ts` | 修改 | 默认 `concurrency: { http:16, bridge:16 }`；`bridge.concurrency=16` |
| `src/audit/logger.ts` | 修改 | 加 `flushing` 互斥、循环 flush、引用快照 |
| `src/server/tool-service.ts` | 修改 | 暴露 `getAuditPending()` 便于 /health |
| `src/http-server.ts` | 修改 | 引入 `httpSem`；tools/call fail-fast 503；/health 增加字段 |
| `src/bridge/public-server.ts` | **重构** | Map 路由；单 handler；断线清理；bridgeSem；/health 增加字段 |
| `src/bridge/local-agent.ts` | 不变 | 现有 fire-and-forget 已 OK |
| `src/bridge/protocol.ts` | 不变 | 不改签名与 replay 逻辑 |
| `tests/concurrency.test.ts` | **新增** | 见 §7 |
| `docs/concurrency-design.md` | **新增** | 本文 |

---

## 6. 时序图（Bridge 并发正确路径）

```
Client A ─┐                                              
          │  POST /mcp (req A)                           
Client B ─┼─┐                                            
            │  POST /mcp (req B)                         
            │                                            
            v                                            
   ┌────────────────────┐                                
   │ BridgePublicServer │                                
   │  bridgeSem.acquire │ ── 信号量 2/16                 
   │                    │                                
   │ pending.set(ridA)  │──WS send tool_call(ridA)──┐    
   │ pending.set(ridB)  │──WS send tool_call(ridB)──┤    
   └────────────────────┘                           │    
            ▲                                       v    
            │                            ┌──────────────┐
            │                            │ LocalAgent    │
            │                            │ (fire-forget) │
            │                            │  handle A     │
            │                            │  handle B     │
            │          ◀── tool_result(ridB) ──         │
            │          ◀── tool_result(ridA) ──         │
   ┌────────┴───────────┐                └──────────────┘
   │ ws.on('message')   │  ← 全程只此一个 handler        
   │ verify 一次         │                               
   │ route by requestId │  ridA → resolveA              
   │                    │  ridB → resolveB              
   └────────────────────┘                                
```

---

## 7. 测试 Checklist

### 7.1 单测
- [ ] `Semaphore`: 容量=2 时第 3 次 acquire 阻塞，release 后被唤醒。
- [ ] `AuditLogger`: 并发 1000 次 log，最终文件行数=1000 且每行合法 JSON。
- [ ] `AuditLogger`: flush 运行期间持续 push，不丢条目。

### 7.2 集成测试
- [ ] HTTP: 并发 16 req，全部 200；第 17 个在前 16 未 release 前立即 503。
- [ ] HTTP: 并发 8 个各跑 `sleep 1`，总耗时 ≈ 1s（证明真并发）。
- [ ] Bridge: 并发 8 req，全部 200，无 `nonce already used` 错误。
- [ ] Bridge: 并发 16 req，第 17 个 503；其中一条超时不影响其他 15 条。
- [ ] Bridge: agent 中途断线，in-flight 请求全部收到 `Bridge agent disconnected`。

### 7.3 回归
- [ ] stdio 模式现有测试全绿。
- [ ] 单请求功能与原实现 100% 一致。

### 7.4 手工验证脚本
```bash
# HTTP 并发
seq 1 16 | xargs -I{} -P16 curl -sS -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{"name":"execute_bash","arguments":{"command":"sleep 1 && echo {}"}}}'

# /health 实时观察
watch -n1 'curl -sS http://127.0.0.1:3001/health | jq .concurrency'
```

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Map 路由重构引入新 bug | 保留原文件备份；新增 E2E 测试覆盖断线、超时、并发 3 个维度 |
| 信号量 fail-fast 引起前端重试风暴 | 文档约定 503 需指数退避；/health 可见当前饱和度 |
| AuditLogger 循环 flush 饥饿 | `while` 有天然退出条件（buffer 清空）；写入速率远低于产生速率才会出现，此时其实是上游问题 |

**回滚策略**：所有改造在独立 commit。bridge 路由改造与信号量可分两次合入：先合并审计日志+信号量（低风险），再合并 bridge 路由（中风险）。

---

## 9. 后续（Out-of-Scope）
- 多 agent 负载均衡（round-robin / least-inflight）
- Prometheus `/metrics` 端点
- 审计日志按 8KB 切批写（avoid PIPE_BUF）
- 全局请求 traceId 贯穿 HTTP → Bridge → Agent → AuditLog
