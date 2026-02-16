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

  it("skips tool_use blocks (tools are executed by CLI internally)", async () => {
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

    const eventTypes = events.map((e) => (e as { type: string }).type);
    // tool_use blocks should NOT produce toolcall events
    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes).not.toContain("toolcall_end");

    // stop_reason "tool_use" should map to "stop" (CLI handles the loop)
    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { reason: string }
      | undefined;
    expect(doneEvent?.reason).toBe("stop");
  });

  it("filters out tool_use blocks but keeps text in mixed content", async () => {
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

    // Text should be preserved
    const textDeltaEvent = events.find((e) => (e as { type: string }).type === "text_delta") as
      | { delta: string }
      | undefined;
    expect(textDeltaEvent?.delta).toBe("Let me read that file for you.");

    // tool_use should be filtered out
    const eventTypes = events.map((e) => (e as { type: string }).type);
    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes).not.toContain("toolcall_end");

    // stop_reason should be "stop" not "toolUse"
    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { reason: string }
      | undefined;
    expect(doneEvent?.reason).toBe("stop");
  });

  it("includes conversation history in prompt for multi-turn conversations", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "You asked about math." }]);
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
        { role: "user", content: "What is 1+1?" },
        { role: "assistant", content: [{ type: "text", text: "1+1 equals 2!" }] },
        { role: "user", content: "What did I just ask?" },
      ],
    };

    for await (const _ of streamFn(model as never, context as never)) {
      // consume
    }

    expect(mockQueryFn).toHaveBeenCalledOnce();
    const callArgs = (mockQueryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const prompt = callArgs.prompt as string;

    // Should contain conversation_history XML tag
    expect(prompt).toContain("<conversation_history>");
    expect(prompt).toContain("</conversation_history>");

    // Should contain the history as JSON
    expect(prompt).toContain('"role": "user"');
    expect(prompt).toContain('"content": "What is 1+1?"');
    expect(prompt).toContain('"role": "assistant"');
    expect(prompt).toContain('"content": "1+1 equals 2!"');

    // Should contain the current message
    expect(prompt).toContain("<current_message>");
    expect(prompt).toContain("What did I just ask?");
    expect(prompt).toContain("</current_message>");

    // Should NOT pass messages parameter to SDK
    expect(callArgs.messages).toBeUndefined();
  });

  it("sends plain prompt without history tags for single-turn conversations", async () => {
    const mockQueryFn: CodeBuddyQueryFn = vi.fn().mockImplementation(async function* () {
      yield assistantMsg([{ type: "text", text: "Hello!" }]);
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
      messages: [{ role: "user", content: "Hello" }],
    };

    for await (const _ of streamFn(model as never, context as never)) {
      // consume
    }

    const callArgs = (mockQueryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Single-turn: no history tags, just the raw prompt
    expect(callArgs.prompt).toBe("Hello");
    expect(callArgs.prompt).not.toContain("<conversation_history>");
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
    // Should NOT pass messages parameter
    expect(callArgs.messages).toBeUndefined();
  });

  it("dynamically imports SDK when no queryFn provided", async () => {
    const streamFn = createCodeBuddyStreamFn();
    expect(typeof streamFn).toBe("function");
  });
});
