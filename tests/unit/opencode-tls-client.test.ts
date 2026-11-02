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
  OPENCODE_TLS_PROFILE,
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

test("the profile reproduces the CLI's ClientHello, not just its cipher list", () => {
  // Measured 2026-11-03: cipher list alone yields JA3 b513e31c…; the CLI presents
  // 4181203c…, which needs HTTP/1.1 ALPN, the four-curve list, and extensions 5 + 18.
  assert.deepEqual(OPENCODE_TLS_PROFILE.alpnProtocols, ["HTTP1"]);
  assert.equal(OPENCODE_TLS_PROFILE.curvesList, "X25519MLKEM768:X25519:P-256:P-384");
  assert.equal(OPENCODE_TLS_PROFILE.enableOcspStapling, true);
  assert.equal(OPENCODE_TLS_PROFILE.enableSignedCertTimestamps, true);
  assert.equal(OPENCODE_TLS_PROFILE.cipherList, OPENCODE_CIPHER_LIST);
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
    emulation: { tlsOptions: OPENCODE_TLS_PROFILE },
  });

  resetOpencodeTlsSession();
  await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {});
  assert.equal(created.length, 2, "reset drops the cached session");
});

test("the proxy is bound at session creation, one session per proxy URL", async () => {
  const created: Array<Record<string, unknown>> = [];
  __setOpencodeTlsSessionFactoryForTesting(async (options) => {
    created.push(options);
    return {
      fetch: async () => ({ status: 200, headers: {}, body: null }),
      close: () => {},
    };
  });

  await opencodeTlsFetch(
    "https://opencode.ai/inference/v1/chat/completions",
    {},
    {
      proxyUrl: "http://127.0.0.1:10808",
    }
  );
  await opencodeTlsFetch(
    "https://opencode.ai/inference/v1/chat/completions",
    {},
    {
      proxyUrl: "http://127.0.0.1:10808",
    }
  );
  await opencodeTlsFetch(
    "https://opencode.ai/inference/v1/chat/completions",
    {},
    {
      proxyUrl: "http://127.0.0.1:10809",
    }
  );
  assert.equal(created.length, 2, "one session per proxy URL");
  // `proxy` is a sibling of `emulation`: nesting it there is silently ignored.
  assert.deepEqual(created[0], {
    emulation: { tlsOptions: OPENCODE_TLS_PROFILE },
    proxy: "http://127.0.0.1:10808",
  });
  assert.equal((created[1] as { proxy?: string }).proxy, "http://127.0.0.1:10809");
});

test("a 429 drops that proxy's session so the next attempt rebuilds it", async () => {
  let created = 0;
  let status = 429;
  __setOpencodeTlsSessionFactoryForTesting(async () => {
    created += 1;
    return {
      fetch: async () => ({ status, headers: {}, body: null }),
      close: () => {},
    };
  });

  const first = await opencodeTlsFetch(
    "https://opencode.ai/inference/v1/chat/completions",
    {},
    { proxyUrl: "http://127.0.0.1:10808" }
  );
  assert.equal(first.status, 429);
  status = 200;
  const second = await opencodeTlsFetch(
    "https://opencode.ai/inference/v1/chat/completions",
    {},
    { proxyUrl: "http://127.0.0.1:10808" }
  );
  assert.equal(second.status, 200);
  assert.equal(created, 2, "the burned session was not reused");
});
