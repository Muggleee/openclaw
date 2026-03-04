/**
 * CodeBuddy SDK Stream Adapter
 *
 * Adapts CodeBuddy Agent SDK's query() function to work with pi-ai's StreamFn interface.
 * This allows OpenClaw to use CodeBuddy SDK as a provider while maintaining compatibility
 * with the existing session management, tool execution, and compaction infrastructure.
 *
 * Session management: When a sessionId is provided, the adapter uses the SDK's native
 * session continuation (via `options.sessionId`). The SDK CLI process persists session
 * history to disk, so subsequent queries with the same sessionId automatically have
 * access to prior conversation context — no need to serialize history into the prompt.
 *
 * When no sessionId is provided, falls back to the legacy behavior of serializing
 * conversation history into the prompt text.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
} from "@mariozechner/pi-ai";

// Types for CodeBuddy SDK messages
// These match the SDK's output format which is similar to Anthropic's API
type CodeBuddyTextBlock = {
  type: "text";
  text: string;
};

type CodeBuddyToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type CodeBuddyToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
};

type CodeBuddyContentBlock = CodeBuddyTextBlock | CodeBuddyToolUseBlock | CodeBuddyToolResultBlock;

// Actual message structure returned by CodeBuddy SDK (nested in .message)
type CodeBuddyInnerMessage = {
  id?: string;
  content: CodeBuddyContentBlock[];
  model?: string;
  role?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  type?: string;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: unknown;
    server_tool_use?: unknown;
    service_tier?: unknown;
  };
};

type CodeBuddyAssistantMessage = {
  type: "assistant";
  uuid?: string;
  session_id?: string;
  message: CodeBuddyInnerMessage;
  parent_tool_use_id?: string | null;
};

type CodeBuddyResultMessage = {
  type: "result";
  is_error?: boolean;
  errors?: string[];
  subtype?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type CodeBuddySystemMessage = {
  type: "system";
  subtype?: string;
  session_id?: string;
};

// Catch-all for message types we want to skip (e.g. "file-history-snapshot")
type CodeBuddyOtherMessage = {
  type: string;
  [key: string]: unknown;
};

type CodeBuddyMessage =
  | CodeBuddyAssistantMessage
  | CodeBuddyResultMessage
  | CodeBuddySystemMessage
  | CodeBuddyOtherMessage;

// Query options for CodeBuddy SDK
type CodeBuddyQueryOptions = {
  model?: string;
  permissionMode?: "bypassPermissions" | "default";
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  resume?: string;
};

// Query function type (to be imported from SDK)
// Note: SDK's query() only uses prompt + options. It does NOT accept a messages parameter.
// With sessionId/resume, the SDK CLI process maintains conversation history on disk,
// so history does not need to be serialized into the prompt.
export type CodeBuddyQueryFn = (params: {
  prompt: string;
  options?: CodeBuddyQueryOptions;
}) => AsyncIterable<CodeBuddyMessage>;

// Type for message content which could be string or array
type MessageContent =
  | string
  | Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
    }>;

// Type for messages in context
interface ContextMessage {
  role: string;
  content?: MessageContent;
}

/**
 * Check if a provider string identifies CodeBuddy
 */
export function isCodeBuddyProvider(provider: string): boolean {
  return provider === "codebuddy";
}

/**
 * Extract text content from a message's content field
 */
function extractTextFromContent(content: MessageContent | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("");
  }

  return "";
}

/**
 * Extract the prompt text from the last user message in the context
 */
function extractPromptFromContext(context: Context): string {
  const messages = context.messages as unknown as ContextMessage[];
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) {
    return "";
  }

  return extractTextFromContent(lastUserMessage.content);
}

/**
 * Build the prompt with conversation history prepended.
 * Used as a fallback when no sessionId is provided (legacy mode).
 *
 * Serializes prior messages (everything except the last user message) into
 * Anthropic Messages API JSON format wrapped in XML tags, so the model
 * can naturally understand the conversation context.
 *
 * Format:
 * <conversation_history>
 * [{"role":"user","content":"..."},  {"role":"assistant","content":"..."}]
 * </conversation_history>
 *
 * <current_message>
 * actual user prompt
 * </current_message>
 */
function buildPromptWithHistory(context: Context): string {
  const messages = context.messages as unknown as ContextMessage[];
  const currentPrompt = extractPromptFromContext(context);

  // Find the last user message index to separate history from current
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // No history (only one message or none), return prompt as-is
  if (lastUserIdx <= 0) {
    return currentPrompt;
  }

  // Build history from messages before the last user message
  const historyMessages = messages.slice(0, lastUserIdx);
  const serialized: Array<{ role: string; content: string }> = [];

  for (const msg of historyMessages) {
    if (msg.role === "user" || msg.role === "assistant") {
      const text = extractTextFromContent(msg.content);
      if (text) {
        serialized.push({ role: msg.role, content: text });
      }
    }
  }

  // No meaningful history to include
  if (serialized.length === 0) {
    return currentPrompt;
  }

  const historyJson = JSON.stringify(serialized, null, 2);
  return `<conversation_history>\n${historyJson}\n</conversation_history>\n\n<current_message>\n${currentPrompt}\n</current_message>`;
}

/**
 * Extract system prompt from context
 */
function extractSystemPrompt(context: Context): string | undefined {
  const system = context.systemPrompt;
  if (typeof system === "string") {
    return system;
  }
  return undefined;
}

/**
 * Create a default usage object
 */
function createDefaultUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Create a partial AssistantMessage for events
 */
function createPartialMessage(
  content: Array<TextContent>,
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  },
  modelId?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    provider: "codebuddy",
    model: modelId ?? "",
    api: "anthropic-messages",
    timestamp: Date.now(),
    stopReason: "stop",
    usage: usage ?? createDefaultUsage(),
  };
}

// Module-level flag: triggers CLI prewarming once after first successful SDK import.
let prewarmTriggered = false;

/**
 * Prewarm CodeBuddy CLI process pool.
 * Call at app startup or lazily after first SDK import to reduce query latency.
 */
export async function prewarmCodeBuddyCLI(count = 2): Promise<void> {
  try {
    const { connectCLI } = await import("@tencent-ai/agent-sdk");
    await Promise.all(Array.from({ length: count }, () => connectCLI()));
  } catch {
    // SDK not installed or prewarming failed — non-fatal, queries still work
  }
}

/**
 * Create a StreamFn that uses CodeBuddy SDK
 *
 * This adapter transforms CodeBuddy SDK's query() output into the AssistantMessageEventStream
 * format expected by pi-ai.
 *
 * IMPORTANT: The CodeBuddy SDK spawns a CLI child process that runs its own agentic loop
 * internally, including tool execution. The tool_use blocks in the SDK's assistant messages
 * are intermediate artifacts from that internal loop — the tools have already been executed
 * by the CLI process. We must NOT forward these as toolCall events to pi-agent-core, as
 * that would cause pi-agent-core to attempt execution in OpenClaw's tool registry (which
 * doesn't have matching tools), leading to "Tool not found" errors and infinite retry loops.
 *
 * Session management:
 * - When `sessionId` is provided, passes it to SDK via `options.sessionId`. The SDK CLI
 *   process persists conversation history to disk, so only the current user message is
 *   sent as the prompt (no history serialization needed).
 * - When `sessionId` is NOT provided, falls back to legacy behavior: serializes the full
 *   conversation history into the prompt text wrapped in XML tags.
 */
export function createCodeBuddyStreamFn(options?: {
  queryFn?: CodeBuddyQueryFn;
  sessionId?: string;
}): StreamFn {
  const { queryFn, sessionId } = options ?? {};

  // The actual query function - either injected for testing or dynamically imported
  let resolvedQueryFn: CodeBuddyQueryFn | null = queryFn ?? null;

  return (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => {
    // Create the event stream that pi-ai expects
    const eventStream = createAssistantMessageEventStream();

    // Start async processing
    void (async () => {
      // Dynamically import the SDK if not provided (allows for testing with mocks)
      if (!resolvedQueryFn) {
        try {
          const sdk = await import("@tencent-ai/agent-sdk");
          resolvedQueryFn = sdk.query as unknown as CodeBuddyQueryFn;

          // Lazily trigger CLI prewarming on first successful import
          if (!prewarmTriggered) {
            prewarmTriggered = true;
            void prewarmCodeBuddyCLI(2);
          }
        } catch {
          const errorMessage: AssistantMessage = createPartialMessage([
            {
              type: "text",
              text: "CodeBuddy SDK not found. Install it with: pnpm add @tencent-ai/agent-sdk",
            },
          ]);
          eventStream.push({
            type: "error",
            reason: "error",
            error: errorMessage,
          });
          eventStream.end();
          return;
        }
      }

      // Build prompt: with sessionId, SDK manages history on disk — only send current message.
      // Without sessionId, fall back to serializing full history into the prompt (legacy mode).
      const prompt = sessionId
        ? extractPromptFromContext(context)
        : buildPromptWithHistory(context);
      const systemPrompt = extractSystemPrompt(context);

      // Build query options.
      // When sessionId is set, the SDK CLI process creates or resumes a session with that ID.
      // The CLI persists conversation history to its own session storage, so the SDK
      // automatically has access to prior turns without us serializing them.
      const queryOptions: CodeBuddyQueryOptions = {
        model: model.id,
        permissionMode: "bypassPermissions",
        systemPrompt,
        maxTokens: streamOptions?.maxTokens ?? model.maxTokens,
        temperature: streamOptions?.temperature,
        ...(sessionId ? { sessionId } : {}),
      };

      // Track accumulated content for building partial messages
      const accumulatedContent: Array<TextContent> = [];
      let contentIndex = 0;
      let currentUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      try {
        // Call CodeBuddy SDK query()
        const stream = resolvedQueryFn({
          prompt,
          options: queryOptions,
        });

        // Push start event
        eventStream.push({
          type: "start",
          partial: createPartialMessage([], currentUsage, model.id),
        });

        // Transform CodeBuddy messages to AssistantMessageEvents
        for await (const message of stream) {
          if (message.type === "assistant" && "message" in message) {
            const inner = (message as CodeBuddyAssistantMessage).message;
            if (!inner?.content) {
              continue;
            }

            for (const block of inner.content) {
              if (block.type === "text") {
                // Push text_start event
                eventStream.push({
                  type: "text_start",
                  contentIndex,
                  partial: createPartialMessage(accumulatedContent, currentUsage, model.id),
                });

                // Push text_delta event with full text (simulating streaming)
                eventStream.push({
                  type: "text_delta",
                  contentIndex,
                  delta: block.text,
                  partial: createPartialMessage(accumulatedContent, currentUsage, model.id),
                });

                // Add to accumulated content
                const textContent: TextContent = { type: "text", text: block.text };
                accumulatedContent.push(textContent);

                // Push text_end event
                eventStream.push({
                  type: "text_end",
                  contentIndex,
                  content: block.text,
                  partial: createPartialMessage(accumulatedContent, currentUsage, model.id),
                });

                contentIndex++;
              }
              // tool_use and tool_result blocks are intentionally skipped.
              // The CodeBuddy CLI child process runs its own agentic loop and
              // executes tools internally. These blocks are intermediate artifacts
              // from that loop and must not be forwarded to pi-agent-core.
            }
          } else if (message.type === "result") {
            const resultMsg = message as CodeBuddyResultMessage;
            // Update usage from result
            if (resultMsg.usage) {
              currentUsage = {
                input: resultMsg.usage.input_tokens ?? 0,
                output: resultMsg.usage.output_tokens ?? 0,
                cacheRead: resultMsg.usage.cache_read_input_tokens ?? 0,
                cacheWrite: resultMsg.usage.cache_creation_input_tokens ?? 0,
                totalTokens:
                  (resultMsg.usage.input_tokens ?? 0) + (resultMsg.usage.output_tokens ?? 0),
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              };
            }

            // Also check usage from the last assistant message's inner usage
            // (SDK may put usage there instead of in result)

            // Determine stop reason.
            // The SDK's CLI child process handles the full agentic loop internally,
            // so "tool_use" stop reasons are intermediate — the CLI continues until
            // it reaches a final "end_turn". We map everything except "max_tokens" to "stop".
            const rawStopReason = resultMsg.stop_reason;
            const stopReason = rawStopReason === "max_tokens" ? "length" : "stop";

            // Push done event
            const finalMessage: AssistantMessage = {
              role: "assistant",
              content: accumulatedContent,
              provider: "codebuddy",
              model: model.id,
              api: "anthropic-messages",
              timestamp: Date.now(),
              stopReason: stopReason,
              usage: currentUsage,
            };

            eventStream.push({
              type: "done",
              reason: stopReason,
              message: finalMessage,
            });
          }
          // system messages are informational, skip them
        }
      } catch (err) {
        // Push error event
        const errorMessage: AssistantMessage = createPartialMessage(
          [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          undefined,
          model.id,
        );
        eventStream.push({
          type: "error",
          reason: "error",
          error: errorMessage,
        });
      } finally {
        eventStream.end();
      }
    })();

    return eventStream;
  };
}
