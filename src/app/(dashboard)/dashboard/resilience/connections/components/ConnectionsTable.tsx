"use client";

import { useState, useEffect, memo } from "react";
import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import DataTable from "@/shared/components/DataTable";
import type { DataTableColumn, DataTableRow } from "@/shared/components/DataTable";
import type { ConnectionState } from "@/types/resilience";
import { formatRemaining } from "@/shared/utils/formatRemaining";
import { useNotificationStore } from "@/store/notificationStore";
import ConnectionDetail from "./ConnectionDetail";

interface ConnectionsTableProps {
  connections: ConnectionState[];
  receivedAt: number; // client fetch receive time (immune to clock skew)
  degraded: string[]; // meta.degraded from API (to show "Unknown" when breaker data absent)
  onRefresh?: () => void;
}

// Module-scoped memoized countdown cell: hoisted to avoid remount on every poll
// (useMemo with receivedAt dependency would create new type each poll -> unmount/remount)
// Ponytail: elapsed derived from tick count (pure -- no Date.now() in render), self-corrects
// on each poll when receivedAt changes and the effect resets the tick baseline.
const CountdownCell = memo(function CountdownCell({
  connection,
  receivedAt,
}: {
  connection: ConnectionState;
  receivedAt: number;
}) {
  const [tick, setTick] = useState(0); // force re-render for live countdown
  useEffect(() => {
    if (!connection.isCoolingDown) return;
    // Reset tick baseline when new data arrives so the countdown restarts from the
    // fresh cooldownRemainingMs. setTick(0) is a re-sync, not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTick(0);
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [connection.isCoolingDown, receivedAt]);
  if (!connection.isCoolingDown) return <span>-</span>;
  const elapsedMs = tick * 1000;
  return <span>{formatRemaining(Math.max(0, connection.cooldownRemainingMs - elapsedMs))}</span>;
});

export default function ConnectionsTable({
  connections,
  receivedAt,
  degraded,
  onRefresh,
}: ConnectionsTableProps) {
  const t = useTranslations("resilienceConnections");
  const notify = useNotificationStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);
  // Derive the effective selected id during render (closes detail when connection disappears)
  const effectiveSelectedId =
    selectedId && connections.some((c) => c.id === selectedId) ? selectedId : null;

  const handleClearCooldown = async (e: React.MouseEvent, connection: ConnectionState) => {
    e.stopPropagation();
    setClearingId(connection.id);
    try {
      const res = await fetch("/api/resilience/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: connection.id, provider: connection.provider }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("table.clearCooldownSuccess"));
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionsTable] Failed to clear cooldown:", err);
      notify.error(err instanceof Error ? err.message : "Failed to clear cooldown");
    } finally {
      setClearingId(null);
    }
  };

  const columns: DataTableColumn[] = [
    { key: "status", label: t("table.status") },
    { key: "provider", label: t("table.provider") },
    { key: "id", label: t("table.connectionId") },
    { key: "authType", label: t("table.authType") },
    { key: "backoffLevel", label: t("table.backoffLevel") },
    { key: "cooldown", label: t("table.cooldown") },
    { key: "lastError", label: t("table.lastError") },
    { key: "lockouts", label: t("table.lockouts") },
    { key: "actions", label: t("table.actions") },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={connections as unknown as DataTableRow[]}
        selectedId={effectiveSelectedId ?? undefined}
        onRowClick={(row) => setSelectedId(String(row.id))}
        renderCell={(row: DataTableRow, col: DataTableColumn) => {
          const r = row as unknown as ConnectionState;
          switch (col.key) {
            case "status":
              switch (r.connectionStatus) {
                case "cooling_down":
                  return (
                    <Badge variant="warning" size="sm">
                      {t("table.coolingDown")}
                    </Badge>
                  );
                case "circuit_open":
                  return (
                    <Badge variant="error" size="sm">
                      {t("table.circuitOpen")}
                    </Badge>
                  );
                case "terminal":
                  return (
                    <Badge variant="error" size="sm">
                      {t("table.terminal")}
                    </Badge>
                  );
                case "healthy":
                  // When breaker data is absent (degraded source), show "Unknown" not "Healthy"
                  if (degraded.includes("circuitBreaker") && !r.breaker) {
                    return (
                      <Badge variant="info" size="sm">
                        {t("table.unknown")}
                      </Badge>
                    );
                  }
                  return r.breaker?.state === "HALF_OPEN" ? (
                    <Badge variant="warning" size="sm">
                      {t("table.recovering")}
                    </Badge>
                  ) : r.breaker?.state === "DEGRADED" ? (
                    <Badge variant="warning" size="sm">
                      {t("table.degraded")}
                    </Badge>
                  ) : (
                    <Badge variant="success" size="sm">
                      {t("table.healthy")}
                    </Badge>
                  );
                default:
                  return (
                    <Badge variant="info" size="sm">
                      {r.connectionStatus}
                    </Badge>
                  );
              }
            case "id":
              return <span>{r.id.length > 8 ? `${r.id.slice(0, 8)}...` : r.id}</span>;
            case "cooldown":
              return <CountdownCell connection={r} receivedAt={receivedAt} />;
              {
                /* memoized: isolates 1s tick to single cell */
              }
            case "lastError":
              return <span>{r.lastErrorType ?? t("table.never")}</span>;
            case "lockouts":
              return <span>{r.lockouts.length}</span>;
            case "provider":
              return <span>{r.provider}</span>;
            case "authType":
              return <span>{r.authType}</span>;
            case "backoffLevel":
              return <span>{r.backoffLevel}</span>;
            case "actions": {
              const isDegradedOrCooling =
                r.isCoolingDown ||
                r.rateLimitedUntil != null ||
                r.connectionStatus === "cooling_down" ||
                r.connectionStatus === "terminal" ||
                (r.breaker && r.breaker.state !== "CLOSED") ||
                r.lockouts.length > 0;
              const isClearing = clearingId === r.id;
              if (!isDegradedOrCooling) return <span>-</span>;
              return (
                <button
                  type="button"
                  onClick={(e) => void handleClearCooldown(e, r)}
                  disabled={isClearing}
                  style={{
                    padding: "2px 8px",
                    fontSize: "11px",
                    fontWeight: 500,
                    borderRadius: "4px",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg-subtle, rgba(0,0,0,0.05))",
                    color: "var(--color-warning, #d97706)",
                    cursor: isClearing ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {isClearing ? t("table.clearingCooldown") : t("table.clearCooldown")}
                </button>
              );
            }
            default:
              return null;
          }
        }}
      />
      {effectiveSelectedId && (
        <ConnectionDetail
          connection={connections.find((c) => c.id === effectiveSelectedId) ?? undefined}
          receivedAt={receivedAt}
          onClose={() => setSelectedId(null)}
          onRefresh={onRefresh}
        />
      )}
    </>
  );
}
