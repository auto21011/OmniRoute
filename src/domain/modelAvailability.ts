import {
  getAllModelLockouts,
  getModelLockoutInfo,
  clearModelLock,
  type ModelLockoutInfo,
} from "@omniroute/open-sse/services/accountFallback";
import { isModelExcludedByConnection } from "./connectionModelRules";

export type AvailabilityReportItem = Pick<
  ModelLockoutInfo,
  "provider" | "model" | "reason" | "remainingMs" | "failureCount"
> & {
  connectionId: string;
};

export function getAvailabilityReport(): AvailabilityReportItem[] {
  return getAllModelLockouts().map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    connectionId: entry.connectionId,
    reason: entry.reason,
    remainingMs: entry.remainingMs,
    failureCount: entry.failureCount,
  }));
}

export function clearModelUnavailability(provider: string, model: string): boolean {
  const all = getAllModelLockouts();
  const matching = all.filter((e) => e.provider === provider && e.model === model);
  if (matching.length === 0) return false;
  let cleared = false;
  for (const entry of matching) {
    if (clearModelLock(provider, entry.connectionId, model)) cleared = true;
  }
  return cleared;
}

export function clearConnectionModelUnavailability(
  provider: string,
  connectionId: string,
  model: string
): boolean {
  return clearModelLock(provider, connectionId, model);
}

export function clearConnectionAllModelUnavailability(
  provider: string,
  connectionId: string
): number {
  const all = getAllModelLockouts();
  let count = 0;
  for (const entry of all) {
    if (entry.provider === provider && entry.connectionId === connectionId) {
      if (clearModelLock(provider, connectionId, entry.model)) {
        count++;
      }
    }
  }
  return count;
}

export type LockModelAvailabilityParams = {
  provider: string;
  model: string;
  durationMs: number;
  connectionId?: string | null;
  reason?: string;
  scope?: "connection" | "provider";
};

export async function lockModelAvailability({
  provider,
  model,
  durationMs,
  connectionId,
  reason = "manual_disable",
  scope = "connection",
}: LockModelAvailabilityParams): Promise<{ lockedCount: number }> {
  const { lockModel } = await import("@omniroute/open-sse/services/accountFallback");

  if (connectionId && scope !== "provider") {
    lockModel(provider, connectionId, model, reason, durationMs);
    return { lockedCount: 1 };
  }

  let lockedCount = 0;
  try {
    const { getRawProviderConnections } = await import("@/lib/db/providers");
    const connections = await getRawProviderConnections({ provider });
    if (Array.isArray(connections) && connections.length > 0) {
      for (const conn of connections) {
        if (conn && conn.id) {
          lockModel(provider, String(conn.id), model, reason, durationMs);
          lockedCount++;
        }
      }
    }
  } catch (err) {
    console.warn("[modelAvailability] Failed to query connections for provider:", err);
  }

  // Also lock fallback empty-connection entry
  lockModel(provider, "", model, reason, durationMs);
  lockedCount++;

  return { lockedCount };
}

export function resetAllAvailability(): void {
  const all = getAllModelLockouts();
  for (const entry of all) {
    clearModelLock(entry.provider, entry.connectionId, entry.model);
  }
}

export type ModelHealthState = "ok" | "cooling" | "unknown";

export type ModelHealthConnectionLike = {
  id: string;
  providerSpecificData?: unknown;
};

export type ModelHealthItem = {
  provider: string;
  model: string;
  state: ModelHealthState;
  retryAfterMs: number | null;
  observedAt: string;
};

const NON_RETRYABLE_HEALTH_LOCKOUT_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_found_local",
]);

export function isRetryableHealthLockoutReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.length > 0
    ? !NON_RETRYABLE_HEALTH_LOCKOUT_REASONS.has(reason)
    : false;
}

/**
 * Fold per-connection lockouts into one state per model: `cooling` only when
 * every eligible connection carries a live retryable model lock, mirroring the
 * dispatch 429 `model_cooldown` rule (all eligible blocked). One blocked
 * connection out of three stays `ok`.
 */
export function foldModelHealth({
  model,
  connections,
  now,
}: {
  model: { provider: string; rawModel: string };
  connections: ModelHealthConnectionLike[];
  now: number;
}): ModelHealthItem {
  const observedAt = new Date(now).toISOString();
  const base = { provider: model.provider, model: model.rawModel, observedAt };
  const eligible = connections.filter(
    (c) =>
      c &&
      typeof c.id === "string" &&
      c.id.length > 0 &&
      !isModelExcludedByConnection(model.rawModel, c.providerSpecificData)
  );
  if (eligible.length === 0) return { ...base, state: "ok", retryAfterMs: null };
  let shortestMs: number | null = null;
  for (const connection of eligible) {
    let info: { reason: string; remainingMs: number } | null = null;
    try {
      info = getModelLockoutInfo(model.provider, connection.id, model.rawModel);
    } catch {
      return { ...base, state: "ok", retryAfterMs: null };
    }
    if (!info || !(info.remainingMs > 0) || !isRetryableHealthLockoutReason(info.reason)) {
      return { ...base, state: "ok", retryAfterMs: null };
    }
    shortestMs = shortestMs === null ? info.remainingMs : Math.min(shortestMs, info.remainingMs);
  }
  return {
    ...base,
    state: "cooling",
    retryAfterMs: shortestMs === null ? null : Math.ceil(shortestMs / 1000),
  };
}
