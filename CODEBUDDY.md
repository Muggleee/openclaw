# CodeBuddy 项目指南

> 本项目是 [openclaw/openclaw](https://github.com/openclaw/openclaw) 的 fork，将 AI provider 替换为 CodeBuddy SDK（`@tencent-ai/agent-sdk`）。
> 上游项目规范请同时阅读 `AGENTS.md`，其中包含构建/测试/提交/代码风格等通用约定。

## 核心原则

- **体验对齐**：保证用户体验尽可能与官方 openclaw 版本一致。
- **最小改动**：只修复因 CodeBuddy SDK 适配导致的问题（如循环、记忆丢失）。上游原有的 bug 或不完善之处（如流异常结束时 done 事件兜底缺失、assistant 消息 usage 未提取等）不在本 fork 修复范围内，等待官方上游修复后同步合入。
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

2. **对话历史通过 prompt 拼接**：由于 SDK `query()` 不接受 messages 参数，且每次 `runEmbeddedAttempt`（`src/agents/pi-embedded-runner/run/attempt.ts`）在 `while(true)` 循环内创建新的 `createCodeBuddyStreamFn()` 闭包（无法跨调用保持 session 状态），对话历史通过以下方式传递：
   - 从 `context.messages` 提取历史消息（当前用户消息之前的部分）
   - 序列化为 Anthropic Messages API 格式的 JSON
   - 用 XML 标签包裹后拼入 prompt：

     ```
     <conversation_history>
     [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]
     </conversation_history>

     <current_message>
     用户当前的消息
     </current_message>
     ```

   - 单轮对话时不添加 history 标签，直接发送原始 prompt

3. **systemPrompt 正常传递**：openclaw 的人设/系统提示通过 SDK 的 `options.systemPrompt` 参数传递，无需额外处理。

### 已知限制

- 对话历史通过 prompt 传递会增加 token 消耗（与标准 provider 的 messages API 类似，都是每次发送完整历史）
- SDK 内部工具执行对 openclaw 不可见（不会显示在 openclaw 的工具调用 UI 中）
- 闭包重建问题：无法使用 SDK 的 session 续接功能，因为 `createCodeBuddyStreamFn()` 每次调用都会被重新创建

### 上游遗留问题（不修复，等官方同步）

以下问题在 CodeBuddy 适配层初始实现（`dc74aab06`）中已存在，非本 fork 改动引入：

- **流异常结束时 done 事件可能不推送**：如果 SDK 流终止但未发送 `result` 消息，下游可能无限等待
- **assistant 消息的 usage 信息未提取**：代码中有 TODO 注释但未实现，可能导致 token 统计不准
- **每次调用都重新 import SDK**：`resolvedQueryFn` 缓存在闭包内，闭包每次重建导致缓存失效
- **模型列表硬编码**：`models-config.providers.ts` 中的 CodeBuddy 模型列表不会随 SDK 更新自动同步

## 测试

适配层测试文件：`src/agents/codebuddy-stream-adapter.test.ts`（12 个测试用例）

覆盖场景：

- 基本文本流式输出
- tool_use blocks 过滤
- 多轮对话历史拼接
- 单轮对话 prompt 直通
- systemPrompt 传递
- 错误处理

## 开发提示

- Gateway `--force` 模式会自动加载最新构建，不需要每次都重启 gateway
- 会话日志路径：`~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- 提交代码使用 `scripts/committer "<msg>" <file...>`（自动 lint + format）
- 版本号更新需先获得确认，不要自行修改
- 改代码前先给方案，经确认后再动手
