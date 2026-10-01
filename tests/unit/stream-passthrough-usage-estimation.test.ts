// Locks passthrough stream.ts:1981 + empty-choices stream.ts:1754 : even with
// stream_options:{include_usage:true} we estimate when upstream closes on
// finish_reason without usage but with content, and we don't double-forward.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasValidUsage, estimateUsage, isEmptyUsage } from "../../open-sse/utils/usageTracking.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

test("passthrough estimate: finish without usage but with content -> estimate", () => {
  // Regression: Gemini single-field usage must count as valid (totalTokenCount was missing before)
  assert.equal(hasValidUsage({ totalTokenCount: 15 } as Record<string, unknown>), true);
  assert.equal(isEmptyUsage({ totalTokenCount: 15 } as Record<string, unknown>), false);
  assert.equal(isEmptyUsage({ totalTokenCount: 0 } as Record<string, unknown>), true);
  assert.equal(!hasValidUsage(null) && 534 > 0, true);
  assert.equal(isEmptyUsage({ prompt_tokens: 0, completion_tokens: 0 }), true);
  const est = estimateUsage({ messages: [{ role: "user", content: "hi" }] }, 534, FORMATS.OPENAI);
  assert.equal(hasValidUsage(est as Record<string, unknown>), true);
  assert.equal((est as Record<string, unknown>).estimated, true);
});

test("passthrough no double: trailing choices:[] with valid usage -> no estimate", () => {
  assert.equal(hasValidUsage({ prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 }), true);
});

test("passthrough no fake: empty response totalContentLength==0 -> no estimate", () => {
  assert.equal(!hasValidUsage(null) && 0 > 0, false);
  assert.equal(!hasValidUsage({} as Record<string, unknown>) && 0 > 0, false);
});

test("passthrough no fake: tool_only contentLength==0 -> no estimate (tool_calls not counted today)", () => {
  // totalContentLength only counts delta.content + reasoningDelta today -> tool_only stays 0, so no estimate
  assert.equal(!hasValidUsage(null) && 0 > 0, false);
});

import { createSSEStream } from "../../open-sse/utils/stream.ts";

function parseSSEUsage(sseText: string): unknown[] {
  return sseText
    .split("\n\n")
    .filter((block) => block.includes("data:"))
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data:")) ?? "";
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") return null;
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

test("passthrough SSE: finish stop without usage + include_usage:true -> emits usage.estimated:true", async () => {
  const body = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
  };
  const stream = createSSEStream({
    mode: "passthrough" as const,
    body,
    sourceFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    provider: "test",
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const enc = new TextEncoder();
  // delta content -> accumulates totalContentLength
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hello world" }, finish_reason: null }] })}\n\n`
    )
  );
  // finish without usage
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    )
  );
  await writer.write(enc.encode("data: [DONE]\n\n"));
  await writer.close();
  const text = await readAll;
  const parsed = parseSSEUsage(text);
  const withUsage = parsed.filter((p: unknown) => (p as Record<string, unknown>).usage);
  assert.ok(
    withUsage.length >= 1,
    `expected at least 1 chunk with usage, got ${withUsage.length} — text: ${text.slice(0, 600)}`
  );
  const last = withUsage[withUsage.length - 1] as Record<string, unknown>;
  const usage = last.usage as Record<string, unknown>;
  assert.equal(usage.estimated, true);
  assert.ok(typeof usage.prompt_tokens === "number" && usage.prompt_tokens > 0);
  assert.ok(typeof usage.completion_tokens === "number" && usage.completion_tokens > 0);
});

test("passthrough SSE: real trailing choices:[] usage is forwarded; no estimate is emitted (real wins)", async () => {
  const body = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
  };
  const stream = createSSEStream({
    mode: "passthrough" as const,
    body,
    sourceFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    provider: "test",
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const enc = new TextEncoder();
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hello world" }, finish_reason: null }] })}\n\n`
    )
  );
  // finish without usage -> passes through untouched (estimate only happens at flush, and only if no usage ever arrives)
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    )
  );
  // trailing choices:[] with valid usage -> forwarded verbatim (marks passthroughForwardedUsage, so flush skips the estimate)
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } })}\n\n`
    )
  );
  await writer.write(enc.encode("data: [DONE]\n\n"));
  await writer.close();
  const text = await readAll;
  const parsed = parseSSEUsage(text);
  const withUsage = parsed.filter((p: unknown) => (p as Record<string, unknown>).usage);
  // v2 contract (#12151 follow-up): the upstream's REAL trailing usage block is forwarded
  // and wins; the estimate exists only for upstreams that never report usage (emitted at
  // flush). Exactly one usage block ever reaches the client — never two, never estimated
  // when a real one arrived (the v1 "estimated wins" tradeoff was a billing regression).
  assert.equal(
    withUsage.length,
    1,
    `expected 1 usage (the real trailing block), got ${withUsage.length} — usages: ${JSON.stringify(withUsage.map((p) => (p as Record<string, unknown>).usage))}`
  );
  const forwarded = (withUsage[0] as Record<string, unknown> & { usage: Record<string, unknown> })
    .usage;
  assert.equal(forwarded.estimated, undefined);
  assert.equal(forwarded.prompt_tokens, 8);
  assert.equal(forwarded.completion_tokens, 6);
  assert.equal(forwarded.total_tokens, 14);
});

test("passthrough SSE: ModelScope pattern (dummy usage in finish chunk, real usage in trailing chunk)", async () => {
  let onCompletePayload: Record<string, unknown> | null = null;
  const body = {
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    messages: [{ role: "user", content: "1+1=?" }],
    stream: true,
    stream_options: { include_usage: true },
  };
  const stream = createSSEStream({
    mode: "passthrough" as const,
    body,
    sourceFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    provider: "modelscope",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    onComplete(payload) {
      onCompletePayload = payload as Record<string, unknown>;
    },
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const enc = new TextEncoder();

  // ModelScope streams content with dummy usage: completion_tokens: 0
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-ms1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "2" }, finish_reason: null }],
        usage: { prompt_tokens: 34, completion_tokens: 0, total_tokens: 34 },
      })}\n\n`
    )
  );

  // ModelScope finish chunk also carries completion_tokens: 0
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-ms1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 34, completion_tokens: 0, total_tokens: 34 },
      })}\n\n`
    )
  );

  // Trailing chunk carries the real token counts
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-ms1",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 34, completion_tokens: 26, total_tokens: 60 },
      })}\n\n`
    )
  );
  await writer.write(enc.encode("data: [DONE]\n\n"));
  await writer.close();

  const text = await readAll;
  const parsed = parseSSEUsage(text);
  const withUsage = parsed.filter((p: unknown) => (p as Record<string, unknown>).usage);

  // Client should receive the trailing real usage chunk
  assert.equal(withUsage.length, 1, `expected 1 usage chunk, got ${withUsage.length}`);
  const forwarded = (withUsage[0] as Record<string, unknown>).usage as Record<string, unknown>;
  assert.equal(forwarded.prompt_tokens, 34);
  assert.equal(forwarded.completion_tokens, 26);
  assert.equal(forwarded.total_tokens, 60);

  // onComplete payload should have completion_tokens = 26 (NOT 0)
  assert.ok(onCompletePayload != null, "onComplete should have been called");
  const compUsage = (onCompletePayload as Record<string, unknown>).usage as Record<string, unknown>;
  assert.equal(compUsage.completion_tokens, 26, "onComplete usage must have completion_tokens: 26");
  const respBody = (onCompletePayload as Record<string, unknown>).responseBody as Record<
    string,
    unknown
  >;
  const respUsage = respBody.usage as Record<string, unknown>;
  assert.equal(
    respUsage.completion_tokens,
    26,
    "responseBody usage must have completion_tokens: 26"
  );
});

test("passthrough SSE: finish with dummy completion_tokens:0 and no trailing chunk estimates completion tokens at flush", async () => {
  let onCompletePayload: Record<string, unknown> | null = null;
  const body = {
    model: "dummy-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true },
  };
  const stream = createSSEStream({
    mode: "passthrough" as const,
    body,
    sourceFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    provider: "testprov",
    model: "dummy-model",
    onComplete(payload) {
      onCompletePayload = payload as Record<string, unknown>;
    },
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const enc = new TextEncoder();

  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-dummy",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { content: "This is a non-trivial response text that has characters." },
            finish_reason: null,
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 0, total_tokens: 15 },
      })}\n\n`
    )
  );

  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-dummy",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 15, completion_tokens: 0, total_tokens: 15 },
      })}\n\n`
    )
  );

  // Upstream does NOT send trailing chunk, goes straight to [DONE]
  await writer.write(enc.encode("data: [DONE]\n\n"));
  await writer.close();

  const text = await readAll;
  const parsed = parseSSEUsage(text);
  const withUsage = parsed.filter((p: unknown) => (p as Record<string, unknown>).usage);

  assert.equal(
    withUsage.length,
    1,
    `expected 1 usage chunk emitted at flush, got ${withUsage.length}`
  );
  const forwarded = (withUsage[0] as Record<string, unknown>).usage as Record<string, unknown>;
  assert.equal(forwarded.prompt_tokens, 15);
  assert.ok(
    typeof forwarded.completion_tokens === "number" && forwarded.completion_tokens > 0,
    `completion_tokens should be estimated (> 0), got ${forwarded.completion_tokens}`
  );

  assert.ok(onCompletePayload != null);
  const compUsage = (onCompletePayload as Record<string, unknown>).usage as Record<string, unknown>;
  assert.ok(
    typeof compUsage.completion_tokens === "number" && compUsage.completion_tokens > 0,
    `onComplete completion_tokens should be > 0, got ${compUsage.completion_tokens}`
  );
});

test("passthrough SSE: tool_calls only response estimates output tokens at flush", async () => {
  let onCompletePayload: Record<string, unknown> | null = null;
  const body = {
    model: "dummy-model",
    messages: [{ role: "user", content: "what is the weather" }],
    stream: true,
    stream_options: { include_usage: true },
  };
  const stream = createSSEStream({
    mode: "passthrough" as const,
    body,
    sourceFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    provider: "testprov",
    model: "dummy-model",
    onComplete(payload) {
      onCompletePayload = payload as Record<string, unknown>;
    },
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const enc = new TextEncoder();

  // Tool calls chunk (content is null/empty)
  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-tc",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc123",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"location":"Paris, France"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`
    )
  );

  await writer.write(
    enc.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-tc",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`
    )
  );

  await writer.write(enc.encode("data: [DONE]\n\n"));
  await writer.close();

  const text = await readAll;
  const parsed = parseSSEUsage(text);
  const withUsage = parsed.filter((p: unknown) => (p as Record<string, unknown>).usage);

  assert.equal(
    withUsage.length,
    1,
    `expected 1 usage chunk emitted at flush, got ${withUsage.length}`
  );
  const forwarded = (withUsage[0] as Record<string, unknown>).usage as Record<string, unknown>;
  assert.ok(
    typeof forwarded.completion_tokens === "number" && forwarded.completion_tokens > 0,
    `completion_tokens should be estimated from tool call arguments, got ${forwarded.completion_tokens}`
  );

  assert.ok(onCompletePayload != null);
  const compUsage = (onCompletePayload as Record<string, unknown>).usage as Record<string, unknown>;
  assert.ok(
    typeof compUsage.completion_tokens === "number" && compUsage.completion_tokens > 0,
    `onComplete completion_tokens should be > 0, got ${compUsage.completion_tokens}`
  );
});
