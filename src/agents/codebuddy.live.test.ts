import type { Api, AssistantMessageEvent, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { createCodeBuddyStreamFn } from "./codebuddy-stream-adapter.js";

const LIVE =
  isTruthyEnvValue(process.env.CODEBUDDY_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);
const MODEL_ID = process.env.CODEBUDDY_MODEL?.trim() || "claude-opus-4.6";

const describeLive = LIVE ? describe : describe.skip;

function buildModel(id: string): Model<Api> {
  return {
    id,
    provider: "codebuddy",
    api: "anthropic-messages",
    maxTokens: 1024,
    contextWindow: 200000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<Api>;
}

function buildContext(prompt: string): Context {
  return {
    messages: [{ role: "user", content: prompt }],
  } as Context;
}

/** Collect all events from a CodeBuddy stream and detect auth failures. */
async function collectEvents(
  eventStream: AsyncIterable<AssistantMessageEvent>,
): Promise<{ events: AssistantMessageEvent[]; text: string }> {
  const events: AssistantMessageEvent[] = [];
  let text = "";
  for await (const event of eventStream) {
    events.push(event);
    if (event.type === "text_delta") {
      text += event.delta;
    }
    if (event.type === "error") {
      const errText =
        event.error?.content
          ?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("") ?? "";
      if (errText.includes("Authentication required")) {
        throw new Error("CodeBuddy CLI not authenticated — run `codebuddy /login` first");
      }
      throw new Error(`stream error: ${errText || JSON.stringify(event.error)}`);
    }
  }
  // SDK may return auth errors as normal text in a done event
  if (text.includes("Authentication required")) {
    throw new Error("CodeBuddy CLI not authenticated — run `codebuddy /login` first");
  }
  return { events, text };
}

describeLive("codebuddy live", () => {
  it("returns assistant text via SDK", async () => {
    const streamFn = createCodeBuddyStreamFn();
    const model = buildModel(MODEL_ID);
    const context = buildContext("Reply with the word ok.");
    const eventStream = streamFn(model, context);

    const { text } = await collectEvents(eventStream);
    expect(text.length).toBeGreaterThan(0);
  }, 30000);

  it("emits complete event sequence", async () => {
    const streamFn = createCodeBuddyStreamFn();
    const model = buildModel(MODEL_ID);
    const context = buildContext("Say hi.");
    const eventStream = streamFn(model, context);

    const { events } = await collectEvents(eventStream);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes[0]).toBe("start");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("text_end");
    expect(eventTypes[eventTypes.length - 1]).toBe("done");
  }, 30000);
});
