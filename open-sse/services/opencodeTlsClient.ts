/**
 * TLS-impersonating HTTP client for opencode.ai's free tier (ported from 9router).
 *
 * The free gate keys on the TLS ClientHello, not on headers: a request that passes from
 * the OpenCode CLI is refused with 429 FreeUsageLimitError when the same body/headers ride
 * Node's OpenSSL fingerprint, and passes again once the cipher list matches (measured
 * 2026-10-26 on one process, one egress IP, three transports: node fetch/https/http2 all
 * 429, Bun's BoringSSL fetch 200). JA4's cipher hash identifies the list, so the match is
 * on the cipher-list hash and nothing else — reordering the same list still passes.
 *
 * wreq-js is a native runtime dependency loaded lazily (same loader pattern as
 * utils/tlsClient.ts). When it is unavailable the caller keeps its native fetch and stays
 * subject to the gate rather than failing the request here — see `opencodeTlsFetch`'s
 * OpencodeTlsUnavailableError, which the executor treats as fail-open.
 */
import * as nodeModule from "node:module";

// Same anchor as utils/tlsClient.ts (#12491): the standalone Docker runtime re-lays-out
// files at a different depth, so an import.meta.url-relative resolution can miss.
const runtimeRequire = nodeModule.createRequire(process.argv[1] || process.cwd());

/** The BoringSSL/Chrome-family cipher list the upstream accepts, in Bun's order. */
export const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

/**
 * The full ClientHello the OpenCode CLI presents, not just its cipher list. Measured
 * 2026-11-03 by capturing the CLI's own handshake (`opencode run` through a redirecting
 * CONNECT proxy) and replaying candidate wreq-js profiles against a ClientHello sniffer:
 * the cipher list alone leaves three extensions and one key-exchange group off, which
 * yields a different JA3 (b513e31c…) than the CLI (4181203c…). Adding the ALPN, curve
 * list, OCSP-staple and SCT extensions reproduces the CLI's JA3 byte for byte.
 */
export const OPENCODE_TLS_PROFILE = {
  cipherList: OPENCODE_CIPHER_LIST,
  // The CLI speaks HTTP/1.1 to this endpoint; advertising h2 changes the handshake.
  alpnProtocols: ["HTTP1"] as const,
  curvesList: "X25519MLKEM768:X25519:P-256:P-384",
  // Extension 5 (status_request) and 18 (signed_certificate_timestamp).
  enableOcspStapling: true,
  enableSignedCertTimestamps: true,
};

const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpencodeTlsResponseLike {
  status: number;
  statusText?: string;
  headers?:
    | Headers
    | Record<string, string | string[]>
    | (Iterable<[string, string]> & {
        forEach?: (cb: (value: string, key: string) => void) => void;
      });
  body: ReadableStream<Uint8Array> | null;
}

export interface OpencodeTlsSession {
  fetch: (url: string, options?: Record<string, unknown>) => Promise<OpencodeTlsResponseLike>;
  close?: () => Promise<void> | void;
}

type CreateSessionFn = (options: Record<string, unknown>) => Promise<OpencodeTlsSession>;

export class OpencodeTlsUnavailableError extends Error {
  override name = "OpencodeTlsUnavailableError";
}

let sessionFactoryOverride: CreateSessionFn | null | undefined;

/**
 * Sessions are cached per egress proxy: wreq-js binds the proxy at session creation and
 * rejects a per-request override ("Session proxy cannot be changed after creation"), so a
 * proxy pool needs one session per member. The empty key is direct egress.
 */
const sessions = new Map<string, Promise<OpencodeTlsSession>>();

function loadCreateSession(): CreateSessionFn | null {
  if (sessionFactoryOverride !== undefined) return sessionFactoryOverride;
  try {
    const loaded = Reflect.apply(runtimeRequire, undefined, ["wreq-js"]) as {
      createSession?: CreateSessionFn;
    };
    return typeof loaded.createSession === "function" ? loaded.createSession : null;
  } catch {
    return null;
  }
}

/**
 * Test seam: replace the wreq-js loader (a factory, or `null` to simulate a missing
 * runtime). `undefined` restores the real loader.
 */
export function __setOpencodeTlsSessionFactoryForTesting(
  factory: CreateSessionFn | null | undefined
): void {
  sessionFactoryOverride = factory;
  resetOpencodeTlsSession();
}

async function loadSession(proxyUrl?: string): Promise<OpencodeTlsSession> {
  const key = proxyUrl ?? "";
  const cached = sessions.get(key);
  if (cached) return cached;
  const created = (async () => {
    const createSession = loadCreateSession();
    if (!createSession) {
      throw new OpencodeTlsUnavailableError("wreq-js runtime is unavailable");
    }
    // `proxy` is a sibling of `emulation` in CreateSessionOptions — nesting it inside
    // `emulation` is silently ignored and the request leaks out on the direct IP.
    const session = await createSession({
      emulation: { tlsOptions: OPENCODE_TLS_PROFILE },
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
    if (!session || typeof session.fetch !== "function") {
      throw new OpencodeTlsUnavailableError("wreq-js session is missing fetch");
    }
    return session;
  })().catch((error) => {
    sessions.delete(key);
    throw error;
  });
  sessions.set(key, created);
  return created;
}

/**
 * Drop a cached session so the next call builds a fresh one — the escape hatch for a
 * burned egress IP behind a rotating proxy. Closes the old session after a grace period
 * so a response body still being read is not cut off.
 */
export function resetOpencodeTlsSession(proxyUrl?: string): void {
  // No argument drops every session (the test seam and a full reset); a proxy URL drops
  // only that member's session.
  const keys = proxyUrl === undefined ? [...sessions.keys()] : [proxyUrl];
  for (const key of keys) dropSession(key);
}

function dropSession(key: string): void {
  const pending = sessions.get(key);
  if (!pending) return;
  sessions.delete(key);
  pending
    .then((session) => {
      const timer = setTimeout(() => {
        try {
          void session.close?.();
        } catch {
          // best effort
        }
      }, 60_000);
      timer.unref?.();
    })
    .catch(() => {});
}

function headersToNative(raw: OpencodeTlsResponseLike["headers"]): Headers {
  const headers = new Headers();
  if (!raw) return headers;
  if (raw instanceof Headers) return raw;
  const withForEach = raw as { forEach?: (cb: (value: string, key: string) => void) => void };
  if (typeof withForEach.forEach === "function") {
    withForEach.forEach((value, key) => headers.set(key, String(value)));
    return headers;
  }
  if (Symbol.iterator in (raw as object)) {
    for (const [key, value] of raw as Iterable<[string, string]>) {
      headers.set(key, String(value));
    }
    return headers;
  }
  for (const [key, value] of Object.entries(raw as Record<string, string | string[]>)) {
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so downstream
 * `.body` / `.text()` / `.json()` consumers keep working unchanged; streaming is
 * preserved (the live ReadableStream is handed over, never buffered).
 */
export async function opencodeTlsFetch(
  url: string,
  init: RequestInit = {},
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    proxyUrl,
  }: { signal?: AbortSignal; timeoutMs?: number; proxyUrl?: string } = {}
): Promise<Response> {
  let session: OpencodeTlsSession;
  try {
    session = await loadSession(proxyUrl);
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"})`
    );
  }

  const options: Record<string, unknown> = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  // A 429 on this lane means the egress IP's free pool is spent; drop the cached session
  // so the next attempt rebuilds through whatever proxy the pool selects next.
  if (res.status === 429) resetOpencodeTlsSession(proxyUrl);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText ?? "",
    headers: headersToNative(res.headers),
  });
}

export const __test__ = { OPENCODE_CIPHER_LIST };
