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
let sessionPromise: Promise<OpencodeTlsSession> | null = null;

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

async function loadSession(): Promise<OpencodeTlsSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const createSession = loadCreateSession();
      if (!createSession) {
        throw new OpencodeTlsUnavailableError("wreq-js runtime is unavailable");
      }
      const session = await createSession({
        emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      });
      if (!session || typeof session.fetch !== "function") {
        throw new OpencodeTlsUnavailableError("wreq-js session is missing fetch");
      }
      return session;
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Drop the cached session so the next call builds a fresh one. */
export function resetOpencodeTlsSession(): void {
  const pending = sessionPromise;
  sessionPromise = null;
  pending?.then((session) => session.close?.()).catch(() => {});
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
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Response> {
  let session: OpencodeTlsSession;
  try {
    session = await loadSession();
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
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText ?? "",
    headers: headersToNative(res.headers),
  });
}

export const __test__ = { OPENCODE_CIPHER_LIST };
