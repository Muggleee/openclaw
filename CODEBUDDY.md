# CodeBuddy 项目指南

> 本项目是 [openclaw/openclaw](https://github.com/openclaw/openclaw) 的 fork，将 AI provider 替换为 CodeBuddy SDK（`@tencent-ai/agent-sdk`）。
> 上游项目规范请同时阅读 `AGENTS.md`，其中包含构建/测试/提交/代码风格等通用约定。

## 核心原则

- **体验对齐**：保证用户体验尽可能与官方 openclaw 版本一致。
- **最小改动**：只修复因 CodeBuddy SDK 适配导致的问题。上游原有的 bug 或不完善之处不在本 fork 修复范围内，等待官方上游修复后同步合入。
- **不引入额外复杂度**：不为 CodeBuddy 适配层添加上游没有的功能或优化，避免维护负担和合并冲突。

## Fork 概述

- 上游仓库：https://github.com/openclaw/openclaw
- Fork 仓库：https://github.com/Muggleee/openclaw
- 核心改动：使用 CodeBuddy SDK 替换 Anthropic/OpenAI 等标准 provider
- 版本命名：`YYYY.M.D-codebuddy.N`（基于上游日期版本 + codebuddy 预发布后缀）

## CodeBuddy 适配层架构

核心文件：`src/agents/codebuddy-stream-adapter.ts`

### SDK 调用方式

CodeBuddy SDK（`@tencent-ai/agent-sdk`）的 `query()` 函数：

- 每次调用 spawn 一个新的 CLI 子进程（`codebuddy-code-flow`），通过 stdin/stdout JSON 通信
- **只接受 `prompt`（字符串）和 `options` 对象**，不接受 `messages` 数组
- SDK 内部有完整的 agentic loop：自动执行工具调用（Read/Write/Bash 等），只把最终文本结果流式返回
- `options.systemPrompt` 通过 CLI `--system-prompt` 参数传递，能正确生效

### 关键设计决策

1. **过滤 tool_use blocks**：SDK 返回的 tool_use 事件（PascalCase 工具名如 `Read`/`Write`/`Bash`）不转发给 pi-agent-core。因为这些工具已在 SDK 子进程内部执行完毕，转发会导致 pi-agent-core 因找不到工具而触发无限重试循环。`stop_reason` 为 `"tool_use"` 时映射为 `"stop"`。

2. **SDK 原生 Session 续接 + prompt fallback**：对话历史管理采用双模式设计：

   **主模式（有 sessionId）**：openclaw 的 `params.sessionId` 透传给 SDK 的 `options.sessionId`。SDK CLI 子进程将对话历史持久化到磁盘，后续 query 自动加载历史上下文。适配器只发送当前用户消息作为 prompt，无需序列化历史。

   **fallback 模式（无 sessionId）**：兼容老路径，将对话历史序列化为 JSON 拼入 prompt：
   - 从 `context.messages` 提取历史消息
   - 用 XML 标签包裹：`<conversation_history>` + `<current_message>`
   - 单轮对话时直接发送原始 prompt

3. **systemPrompt 正常传递**：openclaw 的人设/系统提示通过 SDK 的 `options.systemPrompt` 参数传递，无需额外处理。

4. **CLI 进程池预热**：首次成功 import SDK 后，通过 `connectCLI()` 异步预热 2 个 CLI 进程，将后续 query 的 ~1.5s 启动延迟降低到 ~0.5s。预热失败不影响功能。

### 已知限制

- SDK 内部工具执行对 openclaw 不可见（不会显示在 openclaw 的工具调用 UI 中）
- 闭包重建：`createCodeBuddyStreamFn()` 在每次 `runEmbeddedAttempt` 迭代中被重新创建，但由于使用 `options.sessionId` 而非闭包内状态管理 session，重建不影响 session 续接
- SDK session 存储在 CLI 侧磁盘上，openclaw 无法直接读取/清理这些数据

## 测试

适配层测试文件：`src/agents/codebuddy-stream-adapter.test.ts`（17 个测试用例）

覆盖场景：

- 基本文本流式输出
- tool_use blocks 过滤
- 多轮对话历史拼接（fallback 模式）
- 单轮对话 prompt 直通
- systemPrompt 传递
- 错误处理
- sessionId 透传给 SDK
- 有 sessionId 时只发送当前消息（不拼接历史）
- 无 sessionId 时降级为历史拼接模式
- 同一闭包内多次调用 sessionId 一致性

## 本地调试

### 启动 Dev Gateway

```bash
# 构建
pnpm build

# 启动 dev gateway（独立配置 ~/.openclaw-dev，端口 19001）
OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_RAW_STREAM=1 node dist/entry.js --dev gateway --force
```

- `--dev`：使用 `~/.openclaw-dev/` 作为独立配置/数据目录，不影响主环境
- `--force`：强制启动，即使端口已被占用
- `OPENCLAW_SKIP_CHANNELS=1`：跳过 Telegram 等 channel 启动
- `OPENCLAW_RAW_STREAM=1`：开启 raw stream 日志

启动成功后访问 http://127.0.0.1:19001/ 打开 Control UI webchat（首次连接需输入 gateway token，见 `~/.openclaw-dev/openclaw.json` 中 `gateway.auth.token`）。

### Auth Profile 配置

CodeBuddy provider 只有在 auth profile store 中存在有效凭据时才会注册（`src/agents/models-config.providers.ts:1360`）。

- auth profile store 路径：`~/.openclaw[-dev]/agents/<agent-id>/agent/auth-profiles.json`
- dev 模式下 agent id 为 `dev`，即 `~/.openclaw-dev/agents/dev/agent/auth-profiles.json`
- 主环境的 store 在 `~/.openclaw/agents/main/agent/auth-profiles.json`
- 如果 dev 环境缺少此文件，可从主环境复制：
  ```bash
  mkdir -p ~/.openclaw-dev/agents/dev/agent
  cp ~/.openclaw/agents/main/agent/auth-profiles.json ~/.openclaw-dev/agents/dev/agent/
  ```
- **缺少此文件会导致** `FailoverError: Unknown model: codebuddy/claude-opus-4.6`

### Dev 配置示例

`~/.openclaw-dev/openclaw.json` 中需要包含：

```jsonc
{
  "auth": {
    "profiles": {
      "codebuddy:default": { "provider": "codebuddy", "mode": "api_key" },
    },
  },
  "agents": {
    "defaults": {
      "model": { "primary": "codebuddy/claude-opus-4.6" },
      "models": { "codebuddy/claude-opus-4.6": {} },
    },
  },
}
```

注意：模型 ID 使用 `.`（如 `claude-opus-4.6`），不是 `-`。

### Raw Stream 日志

- 路径：`~/.openclaw-dev/logs/raw-stream.jsonl`（dev 模式）
- 每行一个 JSON 对象，包含 `ts`、`event`、`runId` 等字段
- 注意：`sessionId` 字段依赖 `ctx.params.session.id`，在某些上游代码路径中可能为 undefined 而被 `JSON.stringify` 省略，这是上游行为

### 在 Adapter 层添加调试日志

在 `codebuddy-stream-adapter.ts` 的 `queryOptions` 构建之后插入 `console.error` 即可在 gateway stdout 中看到输出：

```typescript
console.error(
  `[codebuddy-adapter] sessionId=${sessionId ?? "(none)"} prompt_mode=${sessionId ? "current_only" : "history_fallback"} model=${model.id} prompt_length=${prompt.length}`,
);
```

### 常见问题

| 现象                                          | 原因                                        | 解决                                                 |
| --------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| `FailoverError: Unknown model: codebuddy/...` | auth-profiles.json 缺失或无有效 key         | 从主环境复制 auth-profiles.json                      |
| webchat 连接后 `token_missing`                | 浏览器未输入 gateway token                  | 在 Control UI 设置中粘贴 token                       |
| launchd 自动重启旧 gateway                    | `ai.openclaw.gateway` launchd service       | `launchctl bootout gui/$(id -u)/ai.openclaw.gateway` |
| raw-stream 日志不生成                         | 未发送消息，或 `OPENCLAW_RAW_STREAM` 未设置 | 确认环境变量并通过 webchat 发送消息                  |

---

## 🚧 当前迭代：原生 Session 管理（`feature/codebuddy-native-session`）

### 目标

废弃"对话历史塞 prompt"的方案，改用 CodeBuddy SDK 原生的 session 续接能力，让 SDK 侧自行维护完整的对话上下文。

### 核心需求

1. **双轨 session 管理**
   - openclaw 继续使用自己的 session 体系（`SessionEntry`、truncation、compaction 等），管理 UI 侧的会话列表和消息展示。
   - CodeBuddy SDK 使用自己的 session（`session_id`）维护 CLI 子进程的对话历史。
   - 两边 session **一一对应、并行存在**：openclaw session ↔ codebuddy session_id，通过映射关系关联。

2. **不使用现有 cliprovider 逻辑**
   - CodeBuddy 不走 `cli-runner.ts` / `cli-backends.ts` 这套 CLI provider 路径。
   - 继续作为标准 provider 集成，走 `pi-embedded-runner` 的 `StreamFn` 接口。

3. **尽可能还原正常 provider 体验**
   - 对用户来说，CodeBuddy 的表现应与 Anthropic/OpenAI 等标准 provider 一致。
   - session 切换、新建、历史浏览等操作正常工作。
   - 消息在 openclaw UI 中正常展示（包括 assistant 回复）。

### SDK Session 能力调研（v0.3.66）

SDK 提供三种不同层级的 session 管理方式：

#### 方案 A：`query()` + `resume` 参数（轻量级，稳定 API）

```typescript
// 首次对话 — 指定 sessionId
const q1 = query({ prompt: "hello", options: { sessionId: "my-id-123" } });
for await (const msg of q1) {
  /* msg.session_id 可捕获 */
}

// 后续对话 — 用 resume 续接
const q2 = query({ prompt: "follow up", options: { resume: "my-id-123" } });
```

- `options.sessionId`：为新会话指定自定义 ID
- `options.resume`：用已有 session_id 续接（CLI 通过 `--resume` 从磁盘加载历史）
- `options.continue`：续接最近一次会话（不需要知道 ID）
- `options.forkSession`：resume 时 fork 出新分支
- 返回 `Query` 对象（AsyncGenerator），支持 `interrupt()`、`setModel()`、`setPermissionMode()`
- **进程模型**：每次 `query()` spawn 新 CLI 子进程，调用结束后退出，状态持久化在 CLI session 存储
- **无需维护长生命周期对象**，只需保存一个 string ID
- ✅ 稳定 API（正式导出）
- ✅ 无状态设计，天然兼容 openclaw 闭包重建模式
- ✅ 与现有 `StreamFn` 接口直接兼容
- ⚠️ 每次 spawn 新进程，启动开销 ~1-2s

#### 方案 B：V2 Session API（`unstable_v2_createSession` / `unstable_v2_resumeSession`）

```typescript
import {
  unstable_v2_createSession as createSession,
  unstable_v2_resumeSession as resumeSession
} from '@tencent-ai/agent-sdk';

const session = createSession({ permissionMode: 'bypassPermissions' });
session.sessionId; // 立即可用（同步属性）

await session.send("hello");
for await (const msg of session.stream()) { /* ... */ }

await session.send("follow up"); // 同一进程，无需 re-spawn
for await (const msg of session.stream()) { /* ... */ }

session.close();

// 恢复已有会话
const resumed = resumeSession("session-id-xxx", { ... });
resumed.hasPendingHistory(); // → true（可先消费历史消息）
```

- `createSession(options: SessionOptions)` → `SessionImpl`
- `resumeSession(sessionId, options: SessionOptions)` → `SessionImpl`
- `session.sessionId` — 构造即有，同步属性
- `session.send(message)` / `session.stream()` — 多轮复用同一 CLI 进程
- `session.hasPendingHistory()` — resume 后是否有待消费的历史消息
- `session.connect()` — 预热连接
- `session.close()` / `[Symbol.asyncDispose]` — 关闭释放资源
- 内建 session 锁（`acquireSessionLock`/`releaseSessionLock`），防止并发使用
- ✅ session_id 立即可用，无异步获取问题
- ✅ 多轮复用同一进程，无重复启动开销
- ✅ 更丰富的控制能力（hooks, canUseTool, model switching, plan mode callbacks）
- ⚠️ **`unstable_v2_` 前缀** — API 标记为不稳定，可能变化
- ⚠️ 需维护 `SessionImpl` 实例生命周期（与 openclaw 闭包重建模式冲突）
- ⚠️ 需管理长连接进程的异常恢复
- ⚠️ 与 `StreamFn` 接口模型不匹配，需更大架构改造

#### 方案 C：`connectCLI()` 预热 + `query()`（方案 A 的性能优化）

```typescript
import { connectCLI, query } from "@tencent-ai/agent-sdk";

// 应用启动时预热 CLI 进程池（可预热多个）
await connectCLI({ prewarmInitialize: true });
await connectCLI();

// 查询时自动从池中取预热好的 transport，减少 ~1.5s 启动延迟
const q = query({ prompt: "hello", options: { resume: "session-id" } });
```

- `connectCLI(options?)` — 预 spawn CLI 进程放入 FIFO 队列
- `clearConnectedTransport()` — 清空预热队列
- 本质是**方案 A 的延迟优化**，不改变 session 管理模型
- ✅ 将 ~1.5s CLI 启动时间从查询阶段移到预热阶段
- ⚠️ 预热的 transport 只能匹配相同 options 的 query

#### 方案对比

| 维度                | A: `query()` + resume | B: V2 Session API     | C: `connectCLI` + query |
| ------------------- | --------------------- | --------------------- | ----------------------- |
| **API 稳定性**      | ✅ 正式导出           | ⚠️ `unstable_v2_`     | ✅ 正式导出             |
| **session_id 获取** | 异步（消息中）或预设  | 同步（构造即有）      | 同方案 A                |
| **进程模型**        | 每次新进程            | 长连接单进程          | 预热进程池              |
| **闭包兼容性**      | ✅ 无状态，天然兼容   | ⚠️ 需维护实例生命周期 | ✅ 无状态               |
| **多轮延迟**        | ~1-2s/轮              | 几乎零延迟            | ~0.5s/轮                |
| **适配改动量**      | 小                    | 中-大                 | 小                      |
| **StreamFn 兼容**   | ✅ 直接兼容           | ⚠️ 需桥接适配         | ✅ 直接兼容             |
