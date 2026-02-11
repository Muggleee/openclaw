import { describe, expect, it, vi } from "vitest";
import {
  createCodeBuddyStreamFn,
  isCodeBuddyProvider,
  type CodeBuddyQueryFn,
} from "./codebuddy-stream-adapter.js";

describe("isCodeBuddyProvider", () => {
  it("returns true for 'codebuddy'", () => {
    expect(isCodeBuddyProvider("codebuddy")).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(isCodeBuddyProvider("anthropic")).toBe(false);
    expect(isCodeBuddyProvider("openai")).toBe(false);
    expect(isCodeBuddyProvider("google")).toBe(false);
    expect(isCodeBuddyProvider("")).toBe(false);
  });
});

describe("createCodeBuddyStreamFn", () => {
  // Helper: wrap content blocks in SDK's actual nested assistant message format
  function assistantMsg(content: unknown[]) {
    return {
      type: "assistant",
      uuid: "test-uuid",
      session_id: "test-session",
      message: {
        id: "test-msg-id",
        content,
        model: "claude-opus-4.6",
        role: "assistant",
        stop_reason: null,
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  it("yields text events from assistant messages", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "Hello, world!" }]);
      yield {
        type: "result",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    const events: unknown[] = [];
    for await (const event of streamFn(model as never, context as never)) {
      events.push(event);
    }

    // Should have: start, text_start, text_delta, text_end, done
    expect(events.length).toBeGreaterThanOrEqual(4);

    const textDeltaEvent = events.find((e) => (e as { type: string }).type === "text_delta") as
      | { delta: string }
      | undefined;
    expect(textDeltaEvent?.delta).toBe("Hello, world!");

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | {
          reason: string;
          message: { usage: { input: number; output: number } };
        }
      | undefined;
    expect(doneEvent?.reason).toBe("stop");
    expect(doneEvent?.message.usage.input).toBe(10);
    expect(doneEvent?.message.usage.output).toBe(5);
  });

  it("yields tool_call events from tool_use blocks", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([
        {
          type: "tool_use",
          id: "tool_123",
          name: "read_file",
          input: { path: "/test.txt" },
        },
      ]);
      yield {
        type: "result",
        stop_reason: "tool_use",
      };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      messages: [{ role: "user", content: "Read test.txt" }],
    };

    const events: unknown[] = [];
    for await (const event of streamFn(model as never, context as never)) {
      events.push(event);
    }

    const toolCallEndEvent = events.find((e) => (e as { type: string }).type === "toolcall_end") as
      | { toolCall: { name: string; id: string } }
      | undefined;
    expect(toolCallEndEvent?.toolCall.name).toBe("read_file");
    expect(toolCallEndEvent?.toolCall.id).toBe("tool_123");

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { reason: string }
      | undefined;
    expect(doneEvent?.reason).toBe("toolUse");
  });

  it("handles mixed text and tool_use content", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([
        { type: "text", text: "Let me read that file for you." },
        {
          type: "tool_use",
          id: "tool_456",
          name: "read_file",
          input: { path: "/data.json" },
        },
      ]);
      yield {
        type: "result",
        stop_reason: "tool_use",
      };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      messages: [{ role: "user", content: "Read data.json" }],
    };

    const events: unknown[] = [];
    for await (const event of streamFn(model as never, context as never)) {
      events.push(event);
    }

    const textDeltaEvent = events.find((e) => (e as { type: string }).type === "text_delta") as
      | { delta: string }
      | undefined;
    expect(textDeltaEvent?.delta).toBe("Let me read that file for you.");

    const toolCallEndEvent = events.find((e) => (e as { type: string }).type === "toolcall_end") as
      | { toolCall: { name: string } }
      | undefined;
    expect(toolCallEndEvent?.toolCall.name).toBe("read_file");
  });

  it("passes conversation history to query function", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "Response" }]);
      yield { type: "result" };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "First response" },
        { role: "user", content: "Second message" },
      ],
    };

    for await (const _ of streamFn(model as never, context as never)) {
      // consume
    }

    expect(mockQueryFn).toHaveBeenCalledOnce();
    const callArgs = (mockQueryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.prompt).toBe("Second message");
    expect(callArgs.messages).toHaveLength(2);
  });

  it("extracts system prompt from context", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "Response" }]);
      yield { type: "result" };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    };

    for await (const _ of streamFn(model as never, context as never)) {
      // consume
    }

    expect(mockQueryFn).toHaveBeenCalledOnce();
    const callArgs = (mockQueryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("handles cache usage in result", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "Response" }]);
      yield {
        type: "result",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    const events: unknown[] = [];
    for await (const event of streamFn(model as never, context as never)) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | {
          message: {
            usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
          };
        }
      | undefined;
    expect(doneEvent?.message.usage).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 80,
      cacheWrite: 20,
    });
  });

  it("skips system and other non-assistant messages", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "sess_123",
      };
      yield {
        type: "file-history-snapshot",
        id: "snap_1",
      };
      yield assistantMsg([{ type: "text", text: "Hello" }]);
      yield { type: "result" };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 8192,
    };
    const context = {
      messages: [{ role: "user", content: "Hi" }],
    };

    const events: unknown[] = [];
    for await (const event of streamFn(model as never, context as never)) {
      events.push(event);
    }

    const eventTypes = events.map((e) => (e as { type: string }).type);
    expect(eventTypes).not.toContain("system");
    expect(eventTypes).not.toContain("file-history-snapshot");
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");
  });

  it("passes model options correctly", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "Response" }]);
      yield { type: "result" };
    });

    const streamFn = createCodeBuddyStreamFn({
      queryFn: mockQueryFn,
    });

    const model = {
      id: "claude-opus-4.6",
      provider: "codebuddy",
      api: "anthropic-messages",
      maxTokens: 4096,
    };
    const context = {
      messages: [{ role: "user", content: "Hello" }],
    };
    const options = {
      temperature: 0.7,
      maxTokens: 2048,
    };

    for await (const _ of streamFn(model as never, context as never, options)) {
      // consume
    }

    expect(mockQueryFn).toHaveBeenCalledOnce();
    const callArgs = (mockQueryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.options.model).toBe("claude-opus-4.6");
    expect(callArgs.options.temperature).toBe(0.7);
    expect(callArgs.options.maxTokens).toBe(2048);
  });

  it("dynamically imports SDK when no queryFn provided", async () => {
    const streamFn = createCodeBuddyStreamFn();
    expect(typeof streamFn).toBe("function");
  });
});
