# SDGC Local MCP

一个面向本地受控命令执行场景的 MCP 服务项目，提供 stdio、HTTP 以及桥接模式三种接入方式，用于将受限 Bash 执行与命令安全检查能力暴露给支持 MCP 的客户端或平台。

## 功能概览

- **stdio MCP 服务**：兼容传统本地 MCP 客户端接入。
- **HTTP MCP 服务**：提供 `POST /mcp` 和 `GET /health`，适合需要 `serverUrl` 的平台。
- **Bridge 模式**：支持公网 Bridge Server 与本地 Agent 反向连接，解决客户端与本机不在同一网络的问题。
- **命令安全检查**：内置 `check_command_safety`，可对 Bash 命令进行风险评估。
- **受控命令执行**：内置 `execute_bash`，支持超时、工作目录约束、审计记录。
- **审计日志**：可记录执行结果和安全检查信息，便于追踪。

## 内置工具

| 工具名 | 说明 |
|---|---|
| `execute_bash` | 在受控策略下执行本地 Bash 命令。 |
| `check_command_safety` | 检查命令是否安全、风险等级以及是否需要确认。 |

## 项目结构

```text
src/
  index.ts                  # stdio 入口
  http-server.ts            # HTTP MCP 入口
  bridge/
    server-main.ts          # Bridge Server 启动入口
    agent-main.ts           # Local Agent 启动入口
    public-server.ts        # 公网 Bridge Server
    local-agent.ts          # 本地 Bridge Agent
    protocol.ts             # 桥接协议与签名
    auth.ts                 # 鉴权与防重放
    policy.ts               # Agent 侧策略限制
  server/
    mcp-server.ts           # stdio MCP 服务封装
    tool-service.ts         # 共享工具执行层
  executor/
    bash.ts                 # Bash 执行器
  safety/
    checker.ts              # 安全检查器
  audit/
    logger.ts               # 审计日志
  config/
    default.ts              # 默认配置与配置加载
  types/
    index.ts                # 类型定义
```

## 环境要求

- Node.js >= 18
- npm >= 9

## 安装依赖

```bash
npm install
```

## 构建

```bash
npm run build
```

## 运行方式

### 1. stdio 模式

```bash
npm run start
```

### 2. HTTP 模式

```bash
npm run start:http
```

默认本地健康检查：

```bash
curl http://127.0.0.1:3001/health
```

### 3. Bridge Server 模式

```bash
npm run start:bridge -- --config config/server-config.bridge.example.json
```

### 4. Local Agent 模式

```bash
npm run start:agent -- --config config/server-config.bridge.example.json
```

## 配置说明

默认配置文件路径：

```text
config/server-config.json
```

Bridge 模式示例配置文件：

```text
config/server-config.bridge.example.json
```

Bridge 模式重点配置项：

- `bridge.bearerTokens`：平台访问 `/mcp` 所需的 Bearer Token 列表
- `bridge.agents`：允许连接的 agent 列表（`agentId + secret`）
- `localAgent.policy.allowedTools`：agent 侧白名单工具
- `localAgent.policy.workingDirectory`：固定工作目录限制
- `localAgent.policy.allowEnvironment`：是否允许环境变量透传，默认建议关闭

## 安全设计

- 默认阻断高危命令模式，例如 `rm -rf /`、`mkfs`、`sudo rm` 等。
- Bridge 消息使用 HMAC-SHA256 签名。
- 使用 `timestamp + nonce` 做基础防重放。
- Agent 侧默认 deny，只允许白名单工具和固定工作目录。
- 可选启用审计日志，记录执行结果与安全判断。

## 测试与调试

```bash
npm run test
```

如果需要手动调试 HTTP MCP，可使用 `curl` 或仓库中的调试脚本。

## 典型使用场景

1. 在本机通过 MCP 调用受控 Bash 命令。
2. 给只支持 `serverUrl` 的平台提供本地 HTTP MCP 接口。
3. 通过公网 Bridge Server + 本地 Agent 的方式，把本机能力安全桥接给远端平台。

## 注意事项

- 不建议将本项目直接作为公网命令执行节点暴露。
- 若需要公网接入，优先使用 Bridge 模式，并进一步接入 HTTPS、反向代理、限流与更强鉴权。
- 生产环境建议清理 `logs/`、`dist/`、临时调试产物和测试文件后再提交。

## License

MIT
