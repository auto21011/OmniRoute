import {
  getAllModelLockouts,
  clearModelLock,
  type ModelLockoutInfo,
} from "@omniroute/open-sse/services/accountFallback";

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
