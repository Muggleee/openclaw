/**
 * Integration test script for CodeBuddy SDK stream adapter.
 *
 * Usage:
 *   bun scripts/test-codebuddy-provider.ts
 *
 * Requires CodeBuddy CLI installed and authenticated.
 */

import type { Api, Context, Model } from "@mariozechner/pi-ai";
import {
  createCodeBuddyStreamFn,
  isCodeBuddyProvider,
} from "../src/agents/codebuddy-stream-adapter.js";

async function main() {
  console.log("=== CodeBuddy Provider Integration Test ===\n");

  // 1. Check isCodeBuddyProvider
  console.log("[1/3] isCodeBuddyProvider check...");
  console.log(`  isCodeBuddyProvider("codebuddy") = ${isCodeBuddyProvider("codebuddy")}`);
  console.log(`  isCodeBuddyProvider("anthropic") = ${isCodeBuddyProvider("anthropic")}`);
  console.log("  OK\n");

  // 2. Create streamFn (will dynamically import SDK)
  console.log("[2/3] Creating streamFn (dynamic SDK import)...");
  const streamFn = createCodeBuddyStreamFn();
  console.log(`  streamFn type: ${typeof streamFn}`);
  console.log("  OK\n");

  // 3. Send a real query
  console.log("[3/3] Sending real query via CodeBuddy SDK...");
  console.log('  Prompt: "Say hello in one sentence."\n');

  const model = {
    id: "claude-opus-4.6",
    provider: "codebuddy",
    api: "anthropic-messages",
    maxTokens: 1024,
    contextWindow: 200000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<Api>;

  const context = {
    messages: [{ role: "user", content: "Say hello in one sentence." }],
  } as Context;

  try {
    const eventStream = streamFn(model, context);

    let textOutput = "";

    for await (const event of eventStream) {
      switch (event.type) {
        case "start":
          console.log("  [event] start");
          break;
        case "text_start":
          console.log(`  [event] text_start (index=${event.contentIndex})`);
          break;
        case "text_delta":
          process.stdout.write(event.delta);
          textOutput += event.delta;
          break;
        case "text_end":
          console.log(`\n  [event] text_end (index=${event.contentIndex})`);
          break;
        case "toolcall_start":
          console.log(`  [event] toolcall_start (index=${event.contentIndex})`);
          break;
        case "toolcall_end":
          console.log(
            `  [event] toolcall_end: ${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`,
          );
          break;
        case "done":
          console.log(`  [event] done (reason=${event.reason})`);
          console.log(
            `  [usage] input=${event.message.usage.input}, output=${event.message.usage.output}, cacheRead=${event.message.usage.cacheRead}`,
          );
          break;
        case "error":
          console.error(`  [event] ERROR: ${JSON.stringify(event.error)}`);
          break;
        default:
          console.log(`  [event] ${(event as { type: string }).type}`);
      }
    }

    if (textOutput) {
      console.log(`\n  Full response: "${textOutput}"`);
      console.log("\n=== SUCCESS: CodeBuddy provider is working! ===");
    } else {
      console.error("\n=== FAIL: No text output received ===");
      process.exit(1);
    }
  } catch (err) {
    console.error("\n=== FAIL: Error during query ===");
    console.error(err);
    process.exit(1);
  }
}

await main();
