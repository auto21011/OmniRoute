import {
  getProviderConnectionById,
  updateProviderConnection,
  getRawProviderConnections,
} from "@/lib/db/providers";
import { clearRequestRejectedStreak } from "@omniroute/open-sse/services/requestRejectedStreak.ts";
import { getCircuitBreaker, resetAllCircuitBreakers } from "@/shared/utils/circuitBreaker";
import { connectionCircuitBreakerName } from "@omniroute/open-sse/services/connectionCircuitBreaker.ts";
import { resolveProviderId } from "@/shared/constants/providers";
import {
  clearConnectionAllModelUnavailability,
  resetAllAvailability,
} from "@/domain/modelAvailability";
import { recordProviderSuccess } from "@omniroute/open-sse/services/accountFallback.ts";
import { clearCooldownState } from "@omniroute/open-sse/services/providerCooldownTracker.ts";

export interface ReleaseConnectionOptions {
  resetBreaker?: boolean;
  clearLockouts?: boolean;
}

export interface ReleaseConnectionResult {
  ok: boolean;
  releasedCount: number;
  connectionId?: string;
  provider?: string;
}

/**
 * Release cooldown and reset failure status for a single provider connection.
 * Clears database cooldown/error fields, in-memory request rejection streak,
 * provider cooldown tracker, and optionally resets circuit breakers and model lockouts.
 */
export async function releaseSingleConnection(
  connectionId: string,
  providerHint?: string,
  options: ReleaseConnectionOptions = {}
): Promise<ReleaseConnectionResult> {
  const resetBreaker = options.resetBreaker ?? true;
  const clearLockouts = options.clearLockouts ?? true;

  let provider = providerHint;
  if (!provider) {
    try {
      const existing = await getProviderConnectionById(connectionId);
      if (existing && existing.provider) {
        provider = String(existing.provider);
      }
    } catch (err) {
      console.warn("[connectionResilience] Failed to fetch connection by id:", err);
    }
  }

  await updateProviderConnection(connectionId, {
    testStatus: "active",
    lastError: null,
    lastErrorAt: null,
    lastErrorType: null,
    lastErrorSource: null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  });

  clearRequestRejectedStreak(connectionId);

  if (provider) {
    const canonicalProvider = resolveProviderId(provider);

    if (resetBreaker) {
      // Reset connection-level circuit breaker if any
      const connBreaker = getCircuitBreaker(
        connectionCircuitBreakerName(canonicalProvider, connectionId)
      );
      connBreaker?.reset();

      // Reset provider-level circuit breaker
      const provBreaker = getCircuitBreaker(canonicalProvider);
      provBreaker?.reset();
    }

    // Reset cooldown tracker
    recordProviderSuccess(canonicalProvider, connectionId);

    if (clearLockouts) {
      clearConnectionAllModelUnavailability(provider, connectionId);
      if (canonicalProvider !== provider) {
        clearConnectionAllModelUnavailability(canonicalProvider, connectionId);
      }
    }
  }

  return {
    ok: true,
    releasedCount: 1,
    connectionId,
    provider,
  };
}

/**
 * Release cooldown and reset failure status for all connections belonging to a provider.
 */
export async function releaseProviderConnections(
  provider: string,
  options: ReleaseConnectionOptions = {}
): Promise<ReleaseConnectionResult> {
  const resetBreaker = options.resetBreaker ?? true;
  const clearLockouts = options.clearLockouts ?? true;
  const canonicalProvider = resolveProviderId(provider);

  let connections: Record<string, unknown>[] = [];
  try {
    connections = await getRawProviderConnections({ provider }, 1000, undefined, [
      "id",
      "provider",
    ]);
  } catch (err) {
    console.warn("[connectionResilience] Failed to fetch connections for provider:", err);
  }

  let count = 0;
  for (const conn of connections) {
    const id = String(conn.id ?? "");
    if (!id) continue;

    await updateProviderConnection(id, {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      lastErrorType: null,
      lastErrorSource: null,
      errorCode: null,
      rateLimitedUntil: null,
      backoffLevel: 0,
    });

    clearRequestRejectedStreak(id);
    recordProviderSuccess(canonicalProvider, id);

    if (resetBreaker) {
      const connBreaker = getCircuitBreaker(connectionCircuitBreakerName(canonicalProvider, id));
      connBreaker?.reset();
    }

    if (clearLockouts) {
      clearConnectionAllModelUnavailability(provider, id);
      if (canonicalProvider !== provider) {
        clearConnectionAllModelUnavailability(canonicalProvider, id);
      }
    }
    count++;
  }

  // Also reset whole-provider cooldown and breaker
  recordProviderSuccess(canonicalProvider, undefined);

  if (resetBreaker) {
    const provBreaker = getCircuitBreaker(canonicalProvider);
    provBreaker?.reset();
  }

  return {
    ok: true,
    releasedCount: count,
    provider,
  };
}

/**
 * Release cooldown for ALL connections across the system.
 */
export async function releaseAllConnections(
  options: ReleaseConnectionOptions = {}
): Promise<ReleaseConnectionResult> {
  const resetBreaker = options.resetBreaker ?? true;
  const clearLockouts = options.clearLockouts ?? true;

  let connections: Record<string, unknown>[] = [];
  try {
    connections = await getRawProviderConnections({}, 1000, undefined, [
      "id",
      "provider",
      "test_status",
      "rate_limited_until",
    ]);
  } catch (err) {
    console.warn("[connectionResilience] Failed to fetch all connections:", err);
  }

  let count = 0;
  for (const conn of connections) {
    const id = String(conn.id ?? "");
    if (!id) continue;

    await updateProviderConnection(id, {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      lastErrorType: null,
      lastErrorSource: null,
      errorCode: null,
      rateLimitedUntil: null,
      backoffLevel: 0,
    });

    clearRequestRejectedStreak(id);
    count++;
  }

  clearCooldownState();

  if (resetBreaker) {
    resetAllCircuitBreakers();
  }

  if (clearLockouts) {
    resetAllAvailability();
  }

  return {
    ok: true,
    releasedCount: count,
  };
}

/**
 * Reset a specific circuit breaker by name or provider.
 */
export function resetCircuitBreakerByName(name: string): boolean {
  if (!name) return false;
  const canonical = resolveProviderId(name);
  const breaker = getCircuitBreaker(canonical) ?? getCircuitBreaker(name);
  if (breaker) {
    breaker.reset();
    return true;
  }
  return false;
}
