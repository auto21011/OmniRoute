/**
 * #10880 — cools down every connection sharing the failing connection's last
 * known egress IP. Best-effort and side-effect-safe by design:
 * - The failing connection C is NOT written here: the branch marks it BEFORE
 *   calling this helper (mirror of the connection-scoped agentrouter branch)
 *   — the branch returns right after, so the generic path below is never
 *   reached and opencode (passthroughModels) would otherwise get a per-model
 *   lockModel instead of a connection cooldown.
 * - Any DB failure is caught and logged — markAccountUnavailable must never
 *   fail because of the egress lookup or the sibling writes.
 * - Siblings are re-read fresh and only written when NOT terminal (T06: a
 *   banned/credits_exhausted sibling is never downgraded by an IP-level
 *   signal) and not already in cooldown.
 * - No mutex per sibling (markMutexes is per-connection): concurrent 429s may
 *   double-write, idempotent via updateProviderConnection.
 */

import { getDbInstance } from "@/lib/db/core";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/providers";
import {
  toProviderConnection,
  type ProviderConnectionView,
} from "@/lib/db/providers/lazyConnectionView";
import { getRecentEgressIpForConnection, EGRESS_IP_LOOKUP_WINDOW_MS } from "@/lib/db/proxyLogs";
import { egressBucketedLockProviders } from "@omniroute/open-sse/config/providerErrorRules.ts";
import { RateLimitReason } from "@omniroute/open-sse/config/constants.ts";
import * as log from "../utils/logger";

function isTerminalConnectionStatus(connection: ProviderConnectionView): boolean {
  const status = connection.testStatus?.toLowerCase();
  return status === "credits_exhausted" || status === "banned" || status === "expired";
}

function cooldownUntilMs(rateLimitedUntil: string | null | undefined): number {
  if (!rateLimitedUntil) return 0;
  const asNumber = Number(rateLimitedUntil);
  if (!Number.isNaN(asNumber) && asNumber > 0) return asNumber;
  const asDate = new Date(rateLimitedUntil).getTime();
  return Number.isNaN(asDate) ? 0 : asDate;
}

export async function applyEgressIpLockout(
  connectionId: string,
  provider: string,
  cooldownMs: number,
  reason: string,
  getUnavailableUntil: (ms: number) => string
): Promise<void> {
  try {
    const since = new Date(Date.now() - EGRESS_IP_LOOKUP_WINDOW_MS).toISOString();
    const recent = getRecentEgressIpForConnection(connectionId, since);
    if (!recent) {
      log.info(
        "AUTH",
        `Egress lock: no known egress IP for ${provider}:${connectionId.slice(0, 8)} — skipped`
      );
      return;
    }
    const db = getDbInstance();
    const family = egressBucketedLockProviders();
    const familyPlaceholders = family.map(() => "?").join(",");
    const siblingIds = db
      .prepare(
        `SELECT DISTINCT connection_id FROM proxy_logs
         WHERE egress_ip = ? AND timestamp >= ? AND connection_id != ?
         AND provider IN (${familyPlaceholders})`
      )
      .all(recent.egressIp, since, connectionId, ...family)
      .map((row: { connection_id: string }) => row.connection_id);
    const now = Date.now();
    let cooledCount = 0;
    for (const id of siblingIds) {
      const sibling = toProviderConnection(await getProviderConnectionById(id));
      if (!sibling.id) continue;
      if (isTerminalConnectionStatus(sibling)) continue;
      const existingUntil = cooldownUntilMs(sibling.rateLimitedUntil);
      if (existingUntil > now) continue;
      await updateProviderConnection(id, {
        lastErrorType: reason || RateLimitReason.QUOTA_EXHAUSTED,
        lastError: `Shared egress IP quota exhausted (${provider})`,
        lastErrorAt: new Date().toISOString(),
        errorCode: 429,
        rateLimitedUntil: getUnavailableUntil(cooldownMs),
        testStatus: "unavailable",
      });
      cooledCount += 1;
    }
    log.info(
      "AUTH",
      `Egress-bucketed cooldown: ${provider} ip=${recent.egressIp} connection=${connectionId.slice(0, 8)} cooled ${cooledCount} sibling(s) for ${Math.ceil(cooldownMs / 1000)}s`
    );
  } catch (err) {
    log.warn("AUTH", `Egress-bucketed lock skipped after DB error: ${(err as Error).message}`);
  }
}
