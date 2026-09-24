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
