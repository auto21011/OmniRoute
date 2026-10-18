/**
 * Provider-scoped cooldown for operator/catalog error rules with scope='provider'.
 * Cools down all active/non-terminal connections under the provider.
 */

import { getProviderConnections, updateProviderConnection } from "@/lib/db/providers";
import {
  toProviderConnection,
  type ProviderConnectionView,
} from "@/lib/db/providers/lazyConnectionView";
import { COOLDOWN_MS, RateLimitReason } from "@omniroute/open-sse/config/constants.ts";
import {
  recordModelLockoutFailure,
  type ProviderProfile,
} from "@omniroute/open-sse/services/accountFallback.ts";
import * as log from "../utils/logger";

function isTerminalConnectionStatus(connection: ProviderConnectionView): boolean {
  const status = connection.testStatus?.toLowerCase();
  return status === "credits_exhausted" || status === "banned" || status === "expired";
}

export async function applyProviderScopeCooldown(
  provider: string,
  status: number,
  fallbackResult: { cooldownMs: number; reason?: string },
  getUnavailableUntil: (ms: number) => string
): Promise<{ shouldFallback: boolean; cooldownMs: number }> {
  const providerCooldownMs =
    fallbackResult.cooldownMs > 0 ? fallbackResult.cooldownMs : COOLDOWN_MS.rateLimit;
  const unavailableUntil = getUnavailableUntil(providerCooldownMs);
  const connectionsRaw = await getProviderConnections({ provider });
  const connections: ProviderConnectionView[] = (
    Array.isArray(connectionsRaw) ? connectionsRaw : []
  )
    .map(toProviderConnection)
    .filter((connection) => connection.id.length > 0);

  for (const c of connections) {
    if (!isTerminalConnectionStatus(c)) {
      await updateProviderConnection(c.id, {
        lastErrorType: fallbackResult.reason || RateLimitReason.SERVER_ERROR,
        lastError: `Provider error rule (${provider})`,
        lastErrorAt: new Date().toISOString(),
        errorCode: status,
        rateLimitedUntil: unavailableUntil,
        testStatus: "unavailable",
      });
    }
  }

  log.info(
    "AUTH",
    `Provider-scoped cooldown for ${provider} (${connections.length} connections) — ${status} ${fallbackResult.reason} ${Math.ceil(providerCooldownMs / 1000)}s (rule scope=provider)`
  );
  return { shouldFallback: true, cooldownMs: providerCooldownMs };
}

/**
 * Provider-single-model scoped lockout for operator/catalog error rules with
 * scope='provider_single_model': locks ONE model across EVERY non-terminal
 * connection under the provider, leaving that provider's other models (and every
 * other provider) untouched. Mirrors applyProviderScopeCooldown's connection
 * fan-out, but records a per-MODEL lockout per connection instead of cooling the
 * whole connection, so each connection stays active for its other models.
 *
 * Backed by the same in-memory model-lock store as scope='model'
 * (recordModelLockoutFailure): the lock is NOT persisted to the connection row
 * and is lost on process restart — exactly like the single-model scope. When the
 * rule declares no cooldownMs, recordModelLockoutFailure applies its own
 * per-reason default (quota_exhausted → next UTC midnight), matching the
 * single-model path.
 */
export async function applyProviderSingleModelScopeLockout(args: {
  provider: string;
  model: string;
  status: number;
  fallbackResult: { cooldownMs: number; reason?: string };
  profile: ProviderProfile | null;
  maxCooldownMs?: number;
}): Promise<{ shouldFallback: boolean; cooldownMs: number }> {
  const { provider, model, status, fallbackResult, profile, maxCooldownMs } = args;
  const ruleCooldownMs = fallbackResult.cooldownMs > 0 ? fallbackResult.cooldownMs : 0;
  const reason = fallbackResult.reason || RateLimitReason.QUOTA_EXHAUSTED;
  const fallbackCooldownMs =
    ruleCooldownMs > 0 ? ruleCooldownMs : (profile?.baseCooldownMs ?? COOLDOWN_MS.rateLimit);
  const lockoutOptions =
    ruleCooldownMs > 0 ? { exactCooldownMs: ruleCooldownMs, maxCooldownMs } : { maxCooldownMs };
  const connectionsRaw = await getProviderConnections({ provider });
  const connections: ProviderConnectionView[] = (
    Array.isArray(connectionsRaw) ? connectionsRaw : []
  )
    .map(toProviderConnection)
    .filter((connection) => connection.id.length > 0);

  let appliedCooldownMs = fallbackCooldownMs;
  let lockedCount = 0;
  for (const c of connections) {
    if (isTerminalConnectionStatus(c)) continue;
    const lockout = recordModelLockoutFailure(
      provider,
      c.id,
      model,
      reason,
      status,
      fallbackCooldownMs,
      profile,
      lockoutOptions
    );
    appliedCooldownMs = lockout.cooldownMs;
    lockedCount++;
    await updateProviderConnection(c.id, {
      lastErrorType: reason,
      lastError: `Model ${model} ${reason} (provider-wide model lock)`,
      lastErrorAt: new Date().toISOString(),
      errorCode: status,
    });
  }

  // Also record wildcard lockout for unpinned combo targets
  const wildcardLockout = recordModelLockoutFailure(
    provider,
    "",
    model,
    reason,
    status,
    fallbackCooldownMs,
    profile,
    lockoutOptions
  );
  appliedCooldownMs = wildcardLockout.cooldownMs;

  log.info(
    "AUTH",
    `Provider-single-model-scoped lockout for ${provider}:${model} (${lockedCount}/${connections.length} connections + wildcard) — ${status} ${reason} ${Math.ceil(appliedCooldownMs / 1000)}s (rule scope=provider_single_model)`
  );
  return { shouldFallback: true, cooldownMs: appliedCooldownMs };
}
