/**
 * opencodeFreeTierContract.ts — the request contract OpenCode Zen's free tier enforces.
 *
 * Measured against the live endpoint on 2026-09-17, on three models and both the Chat
 * Completions and Responses surfaces: the upstream answers 403 FreeTierError unless the
 * request carries all four of
 *
 *   1. `stream: true` in the body,
 *   2. a non-empty `tools` array (the content is not inspected),
 *   3. a session header shaped `ses_` + 12 hex + 14 base62 (the shape is checked, the
 *      value is not — 12 arbitrary hex digits pass),
 *   4. a `User-Agent` carrying `opencode/<version>` with version >= 1.17 (an older
 *      version answers 426 UpgradeRequired rather than 403).
 *
 * Removing any single one of the four turns a 200 into a 403. Paid models on the same
 * host are not gated (a paid model without tools answers 401 CreditsError), which is why
 * `requiresFreeTierRequestContract` narrows the contract to free-tier models.
 *
 * The module also owns the free-model catalog — the catalog is what decides whether the
 * contract applies, so the two belong together and the executor imports them from here —
 * and the way back: the forced stream is rebuilt into a JSON body for a caller that asked
 * for JSON, reusing the shared event-stream parsers.
 */
import { parseSSEToOpenAIResponse, parseSSEToResponsesOutput } from "../handlers/sseParser.ts";
import { invalidateOpencodeSession } from "../utils/opencodeHeaders.ts";
import {
  getObservedToolNames,
  noteRefusedBorrowedToolNames,
  recordAcceptedToolNames,
  resolvePlaceholderNames,
} from "./opencodeToolObservation.ts";
import {
  forgetAttempt,
  planShape,
  recallAttempt,
  recordInjection,
  rememberAttempt,
  shapeKeyOf,
} from "./opencodeRequestShape.ts";

/**
 * What one gated request declared, kept until its outcome is known.
 *
 * `borrowed` means the placeholder came from the observation store rather than from the
 * caller or the configuration, which is the only case where a refusal says anything about
 * that store.
 */
export interface FreeTierContractAttempt {
  readonly provider: string;
  readonly model: string;
  readonly session: string | undefined;
  readonly borrowed: boolean;
  readonly clientToolNames: readonly string[];
  /** A refusal may still be replayed in the other shape: its outcome is noted afterwards. */
  readonly probe?: boolean;
  /**
   * True when this attempt injected placeholder tools the caller had not sent. Kept as a
   * separate flag from `borrowed`: a placeholder this layer added is ours to attribute, while
   * `borrowed` means it came from the observation store.
   */
  readonly injectedPlaceholders?: boolean;
}

/**
 * Models that work WITHOUT any API key on the free/noauth opencode tier.
 *
 * The upstream free tier rotates frequently — when a `-free` suffix model is
 * delisted upstream, the upstream returns "Model X is not supported" (a separate
 * issue from this gate). The set is defined by two data sources:
 *
 *   1. **Known free models** — models explicitly listed in the noauth
 *      `opencode` provider registry (`open-sse/config/providers/registry/opencode/index.ts`).
 *      These are the canonical free models. `deepseek-v4-flash-free` appears in both
 *      the noauth AND the zen registry (it is free on both tiers).
 *   2. **`-free` suffix** — any model whose id ends in `-free`. This automatically
 *      covers upstream free-tier additions without a code deploy.
 *
 * For `opencode-go`, there is no free tier — ALL models require an API key.
 */
const OPENCODE_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "north-mini-code-free",
  "union-alpha",
  "space-bunny-free",
  "jev-1.13-free",
  "ling-3.0-flash-fin-free",
  "longcat-2.5-preview-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

/**
 * Determine whether a model requires an API key on the given opencode provider.
 *
 * - `opencode-go`: ALL models require a key (no free tier).
 * - `opencode` / `opencode-zen`: premium = any model NOT in the free set (known
 *   free models OR ending in `-free`).
 * - Unknown models are assumed premium (fail-safe).
 */
export function isPremiumOpencodeModel(model: string, provider: string): boolean {
  // opencode-go has no free tier — every model requires a key.
  if (provider === "opencode-go") return true;

  // Strip provider prefix if present (e.g. "oc/big-pickle" or "opencode/big-pickle")
  const stripped = model.replace(/^[^/]+\//, "");

  // Strip trailing reasoning or effort suffix like "(low)" or "(high)"
  const clean = stripped.replace(/\([^()]+\)\s*$/, "").trim();

  // Models ending in `-free` or containing `-free` are always free on the noauth/zen tier.
  if (clean.endsWith("-free") || clean.includes("-free")) return false;

  // Check the known free model catalog.
  return (
    !OPENCODE_FREE_MODELS.has(clean) &&
    !OPENCODE_FREE_MODELS.has(stripped) &&
    !OPENCODE_FREE_MODELS.has(model)
  );
}

/**
 * The upstream surface a request is served on, as told apart by the registry `baseUrl`.
 *
 * The gate is a property of the surface, not of billing: `/zen/v1` refuses a request that
 * carries no tools, while `/zen/go/v1` refuses one that carries any (upstream
 * anomalyco/opencode#44300 and #44382, "Endpoint is unavailable" for any request
 * containing tools). Passing the surface in keeps this module free of registry imports and
 * covers every entry of the family — including the `oc` alias, which resolves to
 * `opencode` before an executor is ever picked.
 */
export type OpencodeSurface = "zen" | "go" | "other";

const ZEN_SURFACE_BASE_URL = "https://opencode.ai/zen/v1";
const GO_SURFACE_BASE_URL = "https://opencode.ai/zen/go/v1";
const INFERENCE_SURFACE_BASE_URL = "https://opencode.ai/inference/v1";

/** Tell the surfaces apart by registry `baseUrl`, so provider ids and aliases stay out. */
export function surfaceFromBaseUrl(baseUrl: string | null | undefined): OpencodeSurface {
  if (baseUrl === ZEN_SURFACE_BASE_URL || baseUrl === INFERENCE_SURFACE_BASE_URL) return "zen";
  if (baseUrl === GO_SURFACE_BASE_URL) return "go";
  return "other";
}

/**
 * Operator opt-out for the body half of the contract.
 *
 * The headers stay in place either way: they are what the upstream validates by shape, and
 * they cost nothing. The body half is the half built on an observation of someone else's
 * service, so it is the half worth being able to switch off without waiting for a release.
 * Read per call, so a change takes effect immediately.
 */
function isBodyContractEnabled(): boolean {
  return (process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT || "").trim().toLowerCase() !== "off";
}

/**
 * Whether the upstream gates this request at all.
 *
 * Scope only — it ignores the opt-out on purpose, because the headers are applied either
 * way: they are what the upstream validates by shape, they cost nothing, and switching
 * them off with the body half would turn an opt-out into a second failure mode.
 */
export function isGatedFreeTierRequest(
  surface: OpencodeSurface,
  provider: string,
  model: string
): boolean {
  if (surface !== "zen") return false;
  return !isPremiumOpencodeModel(model, provider);
}

/** Whether the body half of the contract applies: gated, and not switched off. */
export function requiresFreeTierRequestContract(
  surface: OpencodeSurface,
  provider: string,
  model: string
): boolean {
  return isGatedFreeTierRequest(surface, provider, model) && isBodyContractEnabled();
}

/**
 * The lowercase tool quartet OpenCode Zen free tier requires to be declared.
 *
 * The gateway inspects tools and returns 403 FreeTierError unless all four quartet
 * tools are declared. Client tools are preserved; missing quartet slots are filled
 * with disabled placeholder tools.
 */
export const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;
export const DEFAULT_PLACEHOLDER_TOOL_NAMES: readonly string[] = FINGERPRINT_TOOLS;
export const DEFAULT_PLACEHOLDER_TOOL_NAME = "_noop";

/**
 * Operator-supplied placeholder tool names, comma-separated.
 *
 * The upstream inspects which names a request declares, and what it accepts differs by
 * model and moves over time. Empty or unset falls back to the fingerprint quartet.
 * Read per call, so a change takes effect immediately.
 */
export function configuredPlaceholderToolNames(): string[] {
  const raw = process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS || "";
  const kept: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (kept.length >= 32) break;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) continue;
    if (!kept.includes(name)) kept.push(name);
  }
  return kept;
}
const PLACEHOLDER_TOOL_DESCRIPTION = "This tool is currently unavailable and must not be used.";

export const FINGERPRINT_PROPERTY = {
  type: "string",
  description: "This tool is currently unavailable and must not be used.",
} as const;

export const PLACEHOLDER_TOOL_PARAMETERS = {
  type: "object",
  properties: { input: FINGERPRINT_PROPERTY },
} as const;

function hasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * Bring a free-tier request up to the upstream contract, without overriding anything the
 * caller already decided: client tools are kept as they are, and when the caller sent none,
 * the fingerprint quartet tools are declared as disabled placeholders with tool_choice "none"
 * (or "auto" for flat responses) so the model answers in plain text without invoking tools.
 * Idempotent.
 */
export const OPENCODE_ENV_MARKER =
  "<env>\n  Working directory: /workspace\n  Workspace root folder: /workspace\n</env>";

const ENV_BLOCK_RE = /<env>([\s\S]*?)<\/env>/;
const ENV_WORKDIR_RE = /Working directory:[^\n]*/i;
const ENV_ROOT_RE = /Workspace root folder:[^\n]*/i;

export function hasCompleteEnvBlock(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(ENV_BLOCK_RE);
  if (!match) return false;
  const inner = match[1];
  return ENV_WORKDIR_RE.test(inner) && ENV_ROOT_RE.test(inner);
}

export function upgradeEnvBlock(text: string): string {
  if (typeof text !== "string") return text;
  return text.replace(ENV_BLOCK_RE, (block, inner) => {
    const hasWorkdir = ENV_WORKDIR_RE.test(inner);
    const hasRoot = ENV_ROOT_RE.test(inner);
    if (hasWorkdir && hasRoot) return block;

    let upgraded = inner;
    if (!hasWorkdir && !hasRoot) {
      upgraded = "\n  Working directory: /workspace\n  Workspace root folder: /workspace\n";
    } else if (!hasRoot) {
      upgraded = ENV_WORKDIR_RE.test(upgraded)
        ? upgraded.replace(ENV_WORKDIR_RE, (line) => `${line}\n  Workspace root folder: /workspace`)
        : `${upgraded.replace(/\s*$/, "")}\n  Workspace root folder: /workspace\n`;
    } else if (!hasWorkdir) {
      upgraded = ENV_ROOT_RE.test(upgraded)
        ? upgraded.replace(ENV_ROOT_RE, (line) => `  Working directory: /workspace\n${line}`)
        : `\n  Working directory: /workspace\n${upgraded}`;
    }
    return `<env>${upgraded}</env>`;
  });
}

export function withEnvMarker(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (hasCompleteEnvBlock(text)) return text;
  if (ENV_BLOCK_RE.test(text)) return upgradeEnvBlock(text);
  return text.trim() ? `${text}\n\n${OPENCODE_ENV_MARKER}` : OPENCODE_ENV_MARKER;
}

export function applyFingerprintSystemPrompt(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const b = body as Record<string, unknown>;

  if (b.system !== undefined) {
    if (typeof b.system === "string") {
      b.system = withEnvMarker(b.system);
    } else if (Array.isArray(b.system)) {
      const marked = b.system.some((block: unknown) => {
        if (typeof block === "string") return hasCompleteEnvBlock(block);
        if (block && typeof block === "object" && "text" in block) {
          return hasCompleteEnvBlock((block as { text: unknown }).text);
        }
        return false;
      });
      if (!marked) {
        let upgradedAny = false;
        const newSystem = b.system.map((block: unknown) => {
          if (typeof block === "string") {
            if (ENV_BLOCK_RE.test(block)) {
              upgradedAny = true;
              return upgradeEnvBlock(block);
            }
          } else if (block && typeof block === "object" && "text" in block) {
            const blk = block as Record<string, unknown>;
            if (typeof blk.text === "string" && ENV_BLOCK_RE.test(blk.text)) {
              upgradedAny = true;
              return { ...blk, text: upgradeEnvBlock(blk.text) };
            }
          }
          return block;
        });

        if (upgradedAny) {
          b.system = newSystem;
        } else {
          b.system = [...b.system, { type: "text", text: OPENCODE_ENV_MARKER }];
        }
      }
    }
    return;
  }

  if (b.instructions !== undefined) {
    if (typeof b.instructions === "string") {
      b.instructions = withEnvMarker(b.instructions);
    }
    return;
  }

  if (Array.isArray(b.messages)) {
    const first = b.messages[0] as Record<string, unknown> | undefined;
    if (first?.role === "system") {
      if (typeof first.content === "string") {
        b.messages = [{ ...first, content: withEnvMarker(first.content) }, ...b.messages.slice(1)];
        return;
      }
      if (Array.isArray(first.content)) {
        const marked = first.content.some((part: unknown) => {
          if (part && typeof part === "object" && "text" in part) {
            return hasCompleteEnvBlock((part as { text: unknown }).text);
          }
          return false;
        });
        if (!marked) {
          let upgradedAny = false;
          const newContent = first.content.map((part: unknown) => {
            if (part && typeof part === "object" && "text" in part) {
              const p = part as Record<string, unknown>;
              if (typeof p.text === "string" && ENV_BLOCK_RE.test(p.text)) {
                upgradedAny = true;
                return { ...p, text: upgradeEnvBlock(p.text) };
              }
            }
            return part;
          });
          if (upgradedAny) {
            b.messages = [{ ...first, content: newContent }, ...b.messages.slice(1)];
          } else {
            b.messages = [
              {
                ...first,
                content: [...first.content, { type: "text", text: OPENCODE_ENV_MARKER }],
              },
              ...b.messages.slice(1),
            ];
          }
        }
        return;
      }
    } else {
      b.messages = [{ role: "system", content: OPENCODE_ENV_MARKER }, ...b.messages];
    }
  }
}

export function applyFreeTierRequestContract<T>(
  body: T,
  requestFormat: string | null,
  placeholderNames: readonly string[] = []
): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record, stream: true };

  applyFingerprintSystemPrompt(next);

  const isResponses = requestFormat === "openai-responses";
  const isChat = requestFormat === "openai" || requestFormat === null;

  if (!isResponses && !isChat) {
    return next as T;
  }

  const hadClientTools = hasTools(next);
  const existingTools = hadClientTools ? [...(next.tools as unknown[])] : [];
  const existingNames = new Set(clientToolNamesOf(next));

  if (
    hadClientTools &&
    (FINGERPRINT_TOOLS.every((name) => existingNames.has(name)) ||
      existingNames.has(DEFAULT_PLACEHOLDER_TOOL_NAME)) &&
    (!placeholderNames || placeholderNames.length === 0)
  ) {
    return next as T;
  }

  let baseNames: readonly string[];
  if (!hadClientTools) {
    const names =
      placeholderNames && placeholderNames.length > 0 && placeholderNames[0] !== "_noop"
        ? placeholderNames
        : FINGERPRINT_TOOLS;
    baseNames = Array.from(new Set([...names, ...FINGERPRINT_TOOLS]));
  } else {
    baseNames =
      placeholderNames && placeholderNames.length > 0
        ? placeholderNames
        : [DEFAULT_PLACEHOLDER_TOOL_NAME];
  }

  const namesToAdd = baseNames.filter((name) => !existingNames.has(name));

  const placeholders = namesToAdd.map((name) => {
    return isResponses
      ? {
          type: "function",
          name,
          description: PLACEHOLDER_TOOL_DESCRIPTION,
          parameters: PLACEHOLDER_TOOL_PARAMETERS,
        }
      : {
          type: "function",
          function: {
            name,
            description: PLACEHOLDER_TOOL_DESCRIPTION,
            parameters: PLACEHOLDER_TOOL_PARAMETERS,
          },
        };
  });

  next.tools = [...existingTools, ...placeholders];

  if (!next.tool_choice) {
    if (isResponses) {
      next.tool_choice = "auto";
    } else if (!hadClientTools) {
      next.tool_choice = "none";
    }
  }

  return next as T;
}

/**
 * Merge a gated request's own tools with the names the store last saw accepted.
 *
 * A client that declares tools is left alone by `applyFreeTierRequestContract` — but the
 * upstream inspects WHICH names are declared, and a subset it never saw pass (measured
 * 2026-09-21: the 5 explore-agent tools `[glob, grep, read, webfetch, websearch]` on
 * `muse-spark-1.3-contributor-free`, 11 refusals, zero passes) is answered 403
 * FreeTierError. When such a refusal comes back, this rebuilds the same body with the
 * observed names appended after the client's own entries: the client tools keep their
 * full shape (description, parameters) so the model can still call them, while the
 * appended names are list entries with an empty parameter object — the same shape the
 * placeholder path uses, never a callable tool.
 *
 * Pure: returns the input body unchanged when no observed names are missing, so the
 * caller can skip the retry on identity alone. Resolution order is the store's own:
 * this conversation first, then any conversation on the model, then the operator's
 * configured names.
 */
export function mergeClientToolsWithObserved<T>(
  body: T,
  requestFormat: string | null,
  provider: string,
  model: string,
  session: string | undefined,
  configured: readonly string[]
): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.tools) || record.tools.length === 0) return body;
  const own = session ? getObservedToolNames(provider, model, session) : null;
  const observed = own ?? getObservedToolNames(provider, model) ?? configured;
  const have = new Set(clientToolNamesOf(body));
  const missing = observed.filter((name) => !have.has(name));
  if (missing.length === 0) return body;
  const next: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  if (requestFormat === "openai-responses") {
    next.tools = [
      ...(record.tools as unknown[]),
      ...missing.map((name) => ({
        type: "function",
        name,
        description: PLACEHOLDER_TOOL_DESCRIPTION,
        parameters: PLACEHOLDER_TOOL_PARAMETERS,
      })),
    ];
    return next as T;
  }
  if (requestFormat === "openai" || requestFormat === null) {
    next.tools = [
      ...(record.tools as unknown[]),
      ...missing.map((name) => ({
        type: "function",
        function: {
          name,
          description: PLACEHOLDER_TOOL_DESCRIPTION,
          parameters: PLACEHOLDER_TOOL_PARAMETERS,
        },
      })),
    ];
    return next as T;
  }
  return body;
}

function clientToolNamesOf(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const entry = tool as { name?: unknown; function?: { name?: unknown } };
    const name = typeof entry.name === "string" ? entry.name : entry.function?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

/**
 * Bring one request up to the contract and report what it ended up declaring.
 *
 * Single entry point for the executor: it decides whether the contract applies to this
 * surface and model, resolves the placeholder names, applies the body changes, and hands
 * back the attempt so the outcome can be fed to `noteFreeTierOutcome`.
 */
/**
 * The attempt of the request being served, found by the identity of the body the executor was
 * handed. It cannot live on the executor: that instance is shared, and two requests in flight
 * would read each other's attempt when they finish. It is released when the request is over.
 */
export function attemptFor(origin: unknown): FreeTierContractAttempt | null {
  return recallAttempt<FreeTierContractAttempt>(origin);
}

function isTrackable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

export function prepareFreeTierRequest<T>(
  body: T,
  requestFormat: string | null,
  surface: OpencodeSurface,
  provider: string,
  model: string,
  session?: string,
  origin?: object
): { body: T; attempt: FreeTierContractAttempt | null } {
  const clientToolNames = clientToolNamesOf(body);
  if (!requiresFreeTierRequestContract(surface, provider, model)) {
    if (isTrackable(origin)) forgetAttempt(origin);
    return { body, attempt: null };
  }
  const eligible = isTrackable(origin) && clientToolNames.length === 0;
  const key = eligible ? shapeKeyOf(provider, model, body) : "";
  const plan =
    isTrackable(origin) && eligible
      ? planShape(origin, key)
      : { shape: "tools" as const, probe: false };
  const chosen = plan.shape;
  const names = resolvePlaceholderNames(provider, model, session, configuredPlaceholderToolNames());
  const borrowed = clientToolNames.length === 0 && names.length > 0 && chosen === "tools";
  const attempt: FreeTierContractAttempt = {
    provider,
    model,
    session,
    borrowed,
    clientToolNames,
    probe: plan.probe,
  };
  if (isTrackable(origin)) rememberAttempt(origin, attempt);
  if (isTrackable(origin) && eligible) {
    recordInjection(origin, {
      shape: chosen,
      key,
      probe: plan.probe,
      replayNote: () => noteFreeTierOutcome({ ...attempt, probe: false }, false),
    });
  }
  return {
    body:
      chosen === "bare"
        ? withStreaming(body)
        : applyFreeTierRequestContract(body, requestFormat, names),
    attempt,
  };
}

function withStreaming<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const next = { ...(body as Record<string, unknown>), stream: true };
  applyFingerprintSystemPrompt(next);
  return next as T;
}

/**
 * Feed a gated request's outcome back, so the next one borrows a shape that still works.
 *
 * An accepted request teaches which names the upstream takes right now; a refused one only
 * teaches something when the names it carried came from the store.
 */
export function noteFreeTierOutcome(attempt: FreeTierContractAttempt | null, ok: boolean): void {
  if (!attempt) return;
  if (ok) {
    if (attempt.clientToolNames.length > 0) {
      recordAcceptedToolNames(
        attempt.provider,
        attempt.model,
        attempt.session,
        attempt.clientToolNames
      );
    }
    return;
  }
  if (attempt.session) {
    invalidateOpencodeSession(attempt.session);
  }
  if (attempt.probe) return;
  if (attempt.borrowed) {
    noteRefusedBorrowedToolNames(attempt.provider, attempt.model, attempt.session);
  }
}

/**
 * Rebuild a JSON body from the event stream the contract forced.
 *
 * The contract makes the upstream request streamed even when the caller asked for JSON, so
 * the conversion back has to happen here rather than in one caller: `handleChatCore` knows
 * how to buffer an event stream, but the other executor consumers (the compression judge,
 * token counting) call `execute()` and then read `response.json()`. Handing them the raw
 * event stream would throw on a request they explicitly asked not to stream.
 *
 * The conversion is LAZY: the returned body drains and parses the upstream only when the
 * caller reads it, so the executor never blocks on a stream that has not arrived yet — the
 * caller's own read timeout governs, and a caller that cancels pays nothing. Only a
 * successful event-stream response is converted; a streaming caller, a refusal and an
 * already-JSON body pass through untouched.
 */
export function rebuildJsonFromForcedStream(
  response: Response,
  requestFormat: string | null,
  model: string
): Response {
  if (!response.ok || !response.body) return response;
  if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
    return response;
  }
  const upstream = response;
  let drained = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (drained) {
          controller.close();
          return;
        }
        drained = true;
        try {
          const rawSse = await upstream.text();
          const parsed =
            requestFormat === "openai-responses"
              ? parseSSEToResponsesOutput(rawSse, model)
              : parseSSEToOpenAIResponse(rawSse, model);
          const out = parsed && typeof parsed === "object" ? JSON.stringify(parsed) : rawSse;
          controller.enqueue(new TextEncoder().encode(out));
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
      },
      cancel(reason) {
        // Only when nothing started draining: once `text()` holds the reader, cancelling the
        // upstream body directly throws "ReadableStream is locked".
        if (!drained && !upstream.bodyUsed && upstream.body && !upstream.body.locked) {
          void upstream.body.cancel(reason);
        }
      },
    },
    // No pull before the caller reads: a caller that never reads (or cancels) must not make
    // the executor wait on an upstream stream that may never arrive.
    { highWaterMark: 0 }
  );
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
