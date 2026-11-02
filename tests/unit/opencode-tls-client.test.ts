/**
 * OpenCode free-tier TLS client (9router parity).
 *
 * The gate keys on the TLS ClientHello, so the transport must present the exact cipher
 * list the upstream accepts. These tests pin the list, the session lifecycle, and the
 * response shape without loading the native wreq-js runtime.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_CIPHER_LIST,
  OpencodeTlsUnavailableError,
  __setOpencodeTlsSessionFactoryForTesting,
  opencodeTlsFetch,
  resetOpencodeTlsSession,
} from "../../open-sse/services/opencodeTlsClient.ts";

after(() => {
  __setOpencodeTlsSessionFactoryForTesting(undefined);
});

test("the cipher list is the BoringSSL list the upstream accepts, in order", () => {
  const list = OPENCODE_CIPHER_LIST.split(":");
  assert.equal(list.length, 17);
  assert.equal(list[0], "TLS_AES_128_GCM_SHA256");
  assert.equal(list[2], "TLS_CHACHA20_POLY1305_SHA256");
  assert.equal(list.at(-1), "AES256-SHA");
});

test("a missing wreq-js runtime raises OpencodeTlsUnavailableError", async () => {
  __setOpencodeTlsSessionFactoryForTesting(null);
  await assert.rejects(
    () => opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {}),
    (error: unknown) => error instanceof OpencodeTlsUnavailableError
  );
});

test("the session is built with the cipher list, reused, and replaced after reset", async () => {
  const created: Array<Record<string, unknown>> = [];
  let fetches = 0;
  __setOpencodeTlsSessionFactoryForTesting(async (options) => {
    created.push(options);
    return {
      fetch: async () => {
        fetches += 1;
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/event-stream" },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              controller.close();
            },
          }),
        };
      },
      close: () => {},
    };
  });

  const first = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  assert.equal(await first.text(), "data: {}\n\n");

  const second = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {});
  assert.equal(second.status, 200);
  assert.equal(fetches, 2);
  assert.equal(created.length, 1, "the session is reused across requests");
  assert.deepEqual(created[0], {
    emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
  });

  resetOpencodeTlsSession();
  await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {});
  assert.equal(created.length, 2, "reset drops the cached session");
});
