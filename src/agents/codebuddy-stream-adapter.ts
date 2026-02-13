/**
 * CodeBuddy SDK Stream Adapter
 *
 * Adapts CodeBuddy Agent SDK's query() function to work with pi-ai's StreamFn interface.
 * This allows OpenClaw to use CodeBuddy SDK as a provider while maintaining compatibility
 * with the existing session management, tool execution, and compaction infrastructure.
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
  type ToolCall,
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

// Message format for CodeBuddy SDK input (Anthropic-style)
type CodeBuddyInputMessage = {
  role: "user" | "assistant";
  content: string | CodeBuddyContentBlock[];
};

// Query options for CodeBuddy SDK
type CodeBuddyQueryOptions = {
  model?: string;
  permissionMode?: "bypassPermissions" | "default";
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
};

// Query function type (to be imported from SDK)
export type CodeBuddyQueryFn = (params: {
  prompt: string;
  options?: CodeBuddyQueryOptions;
  messages?: CodeBuddyInputMessage[];
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
 * Convert context message to CodeBuddy input message format
 */
function convertContextMessageToCodeBuddy(msg: ContextMessage): CodeBuddyInputMessage | null {
  const role = msg.role as "user" | "assistant" | "system" | "tool";

  // Skip system messages - they're handled separately
  if (role === "system") {
    return null;
  }

  // Skip tool messages - they're embedded in assistant messages as tool_result
  if (role === "tool") {
    return null;
  }

  const content = msg.content;

  // Convert content to CodeBuddy format
  if (typeof content === "string") {
    return {
      role,
      content: content,
    };
  }

  if (Array.isArray(content)) {
    const blocks: CodeBuddyContentBlock[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: block.id ?? "",
          name: block.name ?? "",
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      } else if (block.type === "tool_result") {
        const toolUseId = block.tool_use_id ?? block.id ?? "";
        const blockContent = block.content;
        const resultContent =
          typeof blockContent === "string"
            ? blockContent
            : Array.isArray(blockContent)
              ? (blockContent as Array<{ type: "text"; text: string }>)
              : "";
        blocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: resultContent,
        });
      }
    }
    return {
      role,
      content: blocks.length > 0 ? blocks : "",
    };
  }

  return {
    role,
    content: "",
  };
}

/**
 * Convert pi-ai Context to CodeBuddy messages array
 */
function convertContextToCodeBuddyMessages(context: Context): CodeBuddyInputMessage[] {
  const messages = context.messages as unknown as ContextMessage[];
  const result: CodeBuddyInputMessage[] = [];

  for (const msg of messages) {
    const converted = convertContextMessageToCodeBuddy(msg);
    if (converted) {
      result.push(converted);
    }
  }

  return result;
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

  const content = lastUserMessage.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(
      (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
    );
    return textBlock?.text ?? "";
  }

  return "";
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
  content: Array<TextContent | ToolCall>,
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

/**
 * Create a StreamFn that uses CodeBuddy SDK
 *
 * This adapter transforms CodeBuddy SDK's query() output into the AssistantMessageEventStream
 * format expected by pi-ai. Tool calls are yielded as toolCall events, which allows
 * pi-coding-agent to execute them via OpenClaw's tool system.
 */
export function createCodeBuddyStreamFn(options?: { queryFn?: CodeBuddyQueryFn }): StreamFn {
  const { queryFn } = options ?? {};

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

      // Convert context to CodeBuddy format
      const messages = convertContextToCodeBuddyMessages(context);
      const prompt = extractPromptFromContext(context);
      const systemPrompt = extractSystemPrompt(context);

      // Build query options
      const queryOptions: CodeBuddyQueryOptions = {
        model: model.id,
        permissionMode: "bypassPermissions",
        systemPrompt,
        maxTokens: streamOptions?.maxTokens ?? model.maxTokens,
        temperature: streamOptions?.temperature,
      };

      // Track accumulated content for building partial messages
      const accumulatedContent: Array<TextContent | ToolCall> = [];
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
        // Pass conversation history (minus the last user message which is the prompt)
        const historyMessages = messages.slice(0, -1);
        const stream = resolvedQueryFn({
          prompt,
          options: queryOptions,
          messages: historyMessages.length > 0 ? historyMessages : undefined,
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
              } else if (block.type === "tool_use") {
                // Push toolcall_start event
                eventStream.push({
                  type: "toolcall_start",
                  contentIndex,
                  partial: createPartialMessage(accumulatedContent, currentUsage, model.id),
                });

                // Create tool call content
                const toolCall: ToolCall = {
                  type: "toolCall",
                  id: block.id,
                  name: block.name,
                  arguments: block.input,
                };
                accumulatedContent.push(toolCall);

                // Push toolcall_end event
                eventStream.push({
                  type: "toolcall_end",
                  contentIndex,
                  toolCall,
                  partial: createPartialMessage(accumulatedContent, currentUsage, model.id),
                });

                contentIndex++;
              }
              // tool_result blocks are handled by pi-coding-agent after tool execution
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

            // Determine stop reason
            const rawStopReason = resultMsg.stop_reason;
            const stopReason =
              rawStopReason === "tool_use"
                ? "toolUse"
                : rawStopReason === "max_tokens"
                  ? "length"
                  : "stop";

            // Push done event
            const finalMessage: AssistantMessage = {
              role: "assistant",
              content: accumulatedContent,
              provider: "codebuddy",
              model: model.id,
              api: "anthropic-messages",
              timestamp: Date.now(),
              stopReason,
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
