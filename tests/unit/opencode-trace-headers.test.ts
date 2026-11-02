/**
 * The CLI's trace context on the gated inference lane.
 *
 * Captured 2026-11-03 from `opencode run` (v2.2.3): every POST to
 * `/inference/openai/v1/chat/completions` carries `b3` and `traceparent`. The gate sees a
 * request without them as non-CLI traffic, so gated requests synthesize a fresh pair.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOpencodeTraceHeaders } from "../../open-sse/utils/opencodeHeaders.ts";

test("synthesizes a B3 + W3C pair in the CLI's shape", () => {
  const headers: Record<string, string> = {};
  applyOpencodeTraceHeaders(headers);
  assert.match(headers.b3, /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  // Both headers describe the same trace and span.
  const [, trace, span] = headers.traceparent.split("-");
  assert.ok(headers.b3.startsWith(`${trace}-${span}-1-`));
});

test("each request gets a fresh trace", () => {
  const a: Record<string, string> = {};
  const b: Record<string, string> = {};
  applyOpencodeTraceHeaders(a);
  applyOpencodeTraceHeaders(b);
  assert.notEqual(a.traceparent, b.traceparent);
});

test("a caller-supplied B3 is kept", () => {
  const headers: Record<string, string> = { b3: "aa-bb-1-cc" };
  applyOpencodeTraceHeaders(headers);
  assert.equal(headers.b3, "aa-bb-1-cc");
  assert.equal(headers.traceparent, undefined);
});
