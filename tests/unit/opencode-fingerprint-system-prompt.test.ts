import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_ENV_MARKER,
  hasCompleteEnvBlock,
  upgradeEnvBlock,
  applyFingerprintSystemPrompt,
  applyFreeTierRequestContract,
} from "../../open-sse/executors/opencodeFreeTierContract.ts";
import { parseResetCountdownMs } from "../../open-sse/config/providerErrorRules.ts";
import { getProviderErrorRuleMatch } from "../../open-sse/config/providerErrorRules.ts";
import { invalidateOpencodeSession } from "../../open-sse/utils/opencodeHeaders.ts";

test("hasCompleteEnvBlock identifies complete and incomplete blocks", () => {
  assert.equal(hasCompleteEnvBlock(OPENCODE_ENV_MARKER), true);
  assert.equal(hasCompleteEnvBlock("<env>\n  Working directory: /workspace\n</env>"), false);
  assert.equal(hasCompleteEnvBlock("<env>\n  Workspace root folder: /workspace\n</env>"), false);
  assert.equal(hasCompleteEnvBlock("just text"), false);
});

test("upgradeEnvBlock completes partial blocks idempotently", () => {
  const partial = "<env>\n  Working directory: /workspace\n</env>";
  const upgraded = upgradeEnvBlock(partial);
  assert.equal(hasCompleteEnvBlock(upgraded), true);
  assert.match(upgraded, /Working directory: \/workspace/);
  assert.match(upgraded, /Workspace root folder: \/workspace/);
  // Idempotent
  assert.equal(upgradeEnvBlock(upgraded), upgraded);
});

test("applyFingerprintSystemPrompt upgrades Anthropic system string", () => {
  const body: Record<string, unknown> = {
    system: "You are an assistant.\n<env>\n  Working directory: /workspace\n</env>",
  };
  applyFingerprintSystemPrompt(body);
  assert.equal(hasCompleteEnvBlock(body.system), true);
  assert.match(String(body.system), /You are an assistant\./);
  assert.match(String(body.system), /Workspace root folder: \/workspace/);

  // Idempotent
  const first = body.system;
  applyFingerprintSystemPrompt(body);
  assert.equal(body.system, first);
});

test("applyFingerprintSystemPrompt upgrades Anthropic system block array", () => {
  const body: Record<string, unknown> = {
    system: [
      { type: "text", text: "You are an assistant." },
      { type: "text", text: "<env>\n  Working directory: /workspace\n</env>" },
    ],
  };
  applyFingerprintSystemPrompt(body);
  const sys = body.system as Array<{ text: string }>;
  assert.equal(hasCompleteEnvBlock(sys[1].text), true);
  assert.equal(sys.length, 2);

  // Idempotent
  applyFingerprintSystemPrompt(body);
  assert.equal((body.system as unknown[]).length, 2);
});

test("applyFingerprintSystemPrompt prepends system message to OpenAI messages", () => {
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: "hello" }],
  };
  applyFingerprintSystemPrompt(body);
  const msgs = body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, OPENCODE_ENV_MARKER);
  assert.equal(msgs[1].role, "user");

  // Idempotent
  applyFingerprintSystemPrompt(body);
  assert.equal((body.messages as unknown[]).length, 2);
});

test("applyFingerprintSystemPrompt upgrades existing OpenAI system message", () => {
  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "hello" },
    ],
  };
  applyFingerprintSystemPrompt(body);
  const msgs = body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /Be concise\./);
  assert.match(msgs[0].content, /Workspace root folder: \/workspace/);

  // Idempotent
  const first = msgs[0].content;
  applyFingerprintSystemPrompt(body);
  assert.equal((body.messages as Array<{ content: string }>)[0].content, first);
});

test("applyFingerprintSystemPrompt upgrades Responses API instructions", () => {
  const body: Record<string, unknown> = {
    instructions: "Base instruction.",
  };
  applyFingerprintSystemPrompt(body);
  assert.match(String(body.instructions), /Base instruction\./);
  assert.match(String(body.instructions), /Workspace root folder: \/workspace/);

  // Idempotent
  const first = body.instructions;
  applyFingerprintSystemPrompt(body);
  assert.equal(body.instructions, first);
});

test("parseResetCountdownMs parses days, composite reset after, and minutes", () => {
  assert.equal(parseResetCountdownMs("resets in 13 days"), 13 * 86_400_000);
  assert.equal(parseResetCountdownMs("reset after 4m 33s"), 4 * 60_000 + 33 * 1_000);
  assert.equal(parseResetCountdownMs("reset after 30s"), 30 * 1_000);
  assert.equal(parseResetCountdownMs("resets in 5 minutes"), 5 * 60_000);
  assert.equal(parseResetCountdownMs("unrelated text"), null);
});

test("opencode-quota-exhausted-body matches FreeUsageLimitError on 429", () => {
  const body = {
    type: "error",
    error: {
      type: "FreeUsageLimitError",
      message:
        "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go (reset after 4m 33s)",
    },
  };
  const match = getProviderErrorRuleMatch("opencode", 429, {}, body);
  assert.ok(match, "should match error rule");
  assert.equal(match.reason, "quota_exhausted");
  assert.equal(match.scope, "connection");
  assert.equal(match.cooldownMs, 4 * 60_000 + 33 * 1_000);
});

test("invalidateOpencodeSession clears session cache without throwing", () => {
  invalidateOpencodeSession("test-seed");
  invalidateOpencodeSession();
  assert.ok(true);
});

test("applyFreeTierRequestContract injects fingerprint even when client tools trigger early return", () => {
  const requestWithClientTools = {
    model: "deepseek-v4.1-flash-free",
    messages: [
      {
        role: "system",
        content: "You are an AI agent powered by DeepSeek Harness.",
      },
      {
        role: "user",
        content: "hello",
      },
    ],
    tools: [
      { type: "function", function: { name: "bash" } },
      { type: "function", function: { name: "glob" } },
      { type: "function", function: { name: "grep" } },
      { type: "function", function: { name: "read" } },
    ],
  };

  const modified = applyFreeTierRequestContract(requestWithClientTools, "openai", []) as Record<
    string,
    unknown
  >;
  const messages = modified.messages as Array<Record<string, unknown>>;
  assert.ok(messages[0].content);
  assert.match(String(messages[0].content), /<env>/);
  assert.match(String(messages[0].content), /Workspace root folder: \/workspace/);
});
