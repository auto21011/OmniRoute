"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { ConnectionState } from "@/types/resilience";
import { formatRemaining } from "@/shared/utils/formatRemaining";
import { useNotificationStore } from "@/store/notificationStore";

export interface LockedModelItem {
  provider: string;
  model: string;
  connectionId?: string;
  reason: string;
  remainingMs: number;
}

interface LockedModelsCardProps {
  connections?: ConnectionState[];
  onRelease?: () => void;
}

function extractFromConnections(connections: ConnectionState[]): LockedModelItem[] {
  const extracted: LockedModelItem[] = [];
  for (const c of connections) {
    for (const l of c.lockouts || []) {
      extracted.push({
        provider: c.provider,
        model: l.model,
        connectionId: c.id,
        reason: l.reason,
        remainingMs: l.remainingMs,
      });
    }
  }
  return extracted;
}

export default function LockedModelsCard({ connections = [], onRelease }: LockedModelsCardProps) {
  const t = useTranslations("resilienceConnections");
  const notify = useNotificationStore();

  const [items, setItems] = useState<LockedModelItem[]>(() => extractFromConnections(connections));
  const [loading, setLoading] = useState(false);
  const [releasingKey, setReleasingKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 1s live countdown tick
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTick(0);
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [items]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", { cache: "no-store" });
      if (res?.ok) {
        const json = await res.json();
        if (Array.isArray(json?.items)) {
          setItems(
            json.items.map((i: any) => ({
              provider: i.provider,
              model: i.model,
              connectionId: i.connectionId,
              reason: i.reason,
              remainingMs: i.remainingMs,
            }))
          );
          return;
        }
      }
      setItems(extractFromConnections(connections));
    } catch {
      setItems(extractFromConnections(connections));
    } finally {
      setLoading(false);
    }
  }, [connections]);

  useEffect(() => {
    let active = true;
    const fetchRemote = async () => {
      try {
        const res = await fetch("/api/resilience/model-cooldowns", { cache: "no-store" });
        if (!active) return;
        if (res?.ok) {
          const json = await res.json();
          if (Array.isArray(json?.items)) {
            setItems(
              json.items.map((i: any) => ({
                provider: i.provider,
                model: i.model,
                connectionId: i.connectionId,
                reason: i.reason,
                remainingMs: i.remainingMs,
              }))
            );
            return;
          }
        }
        setItems(extractFromConnections(connections));
      } catch {
        if (active) {
          setItems(extractFromConnections(connections));
        }
      }
    };
    void fetchRemote();
    return () => {
      active = false;
    };
  }, [connections]);

  const handleReleaseOne = async (item: LockedModelItem) => {
    const key = `${item.provider}::${item.connectionId || ""}::${item.model}`;
    setReleasingKey(key);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: item.provider,
          model: item.model,
          connectionId: item.connectionId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      notify.success(t("lockedModelsCard.releaseSuccess", { model: item.model }));

      // Remove immediately from UI
      setItems((prev) =>
        prev.filter(
          (i) =>
            !(
              i.provider === item.provider &&
              i.model === item.model &&
              (i.connectionId || "") === (item.connectionId || "")
            )
        )
      );

      onRelease?.();
    } catch (err) {
      console.error("[LockedModelsCard] Failed to release model:", err);
      notify.error(err instanceof Error ? err.message : "Failed to release model");
    } finally {
      setReleasingKey(null);
    }
  };

  const handleReleaseAll = async () => {
    setReleasingKey("ALL");
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      notify.success(t("lockedModelsCard.releaseAllSuccess"));

      setItems([]);
      onRelease?.();
    } catch (err) {
      console.error("[LockedModelsCard] Failed to release all models:", err);
      notify.error(err instanceof Error ? err.message : "Failed to release all models");
    } finally {
      setReleasingKey(null);
    }
  };

  const elapsedMs = tick * 1000;

  return (
    <div
      style={{
        padding: "16px",
        borderRadius: "8px",
        border: "1px solid var(--color-border)",
        background: "var(--color-bg-primary, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>
            {t("lockedModelsCard.title")}
          </h3>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: "12px",
              color: "var(--color-text-muted)",
              maxWidth: "600px",
            }}
          >
            {t("lockedModelsCard.description")}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            style={{
              padding: "4px 10px",
              fontSize: "12px",
              borderRadius: "6px",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-subtle, rgba(0,0,0,0.05))",
              cursor: loading ? "not-allowed" : "pointer",
              color: "var(--color-text-main)",
            }}
          >
            {t("lockedModelsCard.refresh")}
          </button>
          <button
            type="button"
            onClick={handleReleaseAll}
            disabled={items.length === 0 || releasingKey === "ALL"}
            style={{
              padding: "4px 12px",
              fontSize: "12px",
              fontWeight: 500,
              borderRadius: "6px",
              border: "1px solid rgba(245,158,11,0.4)",
              background: "rgba(245,158,11,0.15)",
              color: "var(--color-warning, #d97706)",
              cursor: items.length === 0 || releasingKey === "ALL" ? "not-allowed" : "pointer",
              opacity: items.length === 0 ? 0.5 : 1,
            }}
          >
            {releasingKey === "ALL" ? "..." : t("lockedModelsCard.releaseAll")}
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div
          style={{
            padding: "16px",
            textAlign: "center",
            fontSize: "13px",
            color: "var(--color-text-muted)",
            background: "var(--color-bg-subtle, rgba(0,0,0,0.02))",
            borderRadius: "6px",
          }}
        >
          {t("lockedModelsCard.empty")}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "12px",
              textAlign: "left",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--color-border)",
                  color: "var(--color-text-muted)",
                }}
              >
                <th style={{ padding: "8px 6px" }}>{t("lockedModelsCard.colProvider")}</th>
                <th style={{ padding: "8px 6px" }}>{t("lockedModelsCard.colModel")}</th>
                <th style={{ padding: "8px 6px" }}>{t("lockedModelsCard.colConnection")}</th>
                <th style={{ padding: "8px 6px" }}>{t("lockedModelsCard.colReason")}</th>
                <th style={{ padding: "8px 6px" }}>{t("lockedModelsCard.colRemaining")}</th>
                <th style={{ padding: "8px 6px", textAlign: "right" }}>
                  {t("lockedModelsCard.colActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const key = `${item.provider}::${item.connectionId || ""}::${item.model}`;
                const remaining = Math.max(0, item.remainingMs - elapsedMs);
                const isReleasing = releasingKey === key;
                return (
                  <tr
                    key={`${key}-${index}`}
                    style={{
                      borderBottom: "1px solid var(--color-border)",
                    }}
                  >
                    <td style={{ padding: "8px 6px", fontWeight: 600 }}>{item.provider}</td>
                    <td
                      style={{
                        padding: "8px 6px",
                        fontFamily: "monospace",
                        color: "var(--color-primary, #6366f1)",
                      }}
                    >
                      {item.model}
                    </td>
                    <td style={{ padding: "8px 6px", color: "var(--color-text-muted)" }}>
                      {item.connectionId
                        ? item.connectionId.length > 12
                          ? `${item.connectionId.slice(0, 12)}...`
                          : item.connectionId
                        : t("lockedModelsCard.allConnections")}
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          background:
                            item.reason === "manual_disable"
                              ? "rgba(245,158,11,0.15)"
                              : "rgba(239,68,68,0.15)",
                          color:
                            item.reason === "manual_disable"
                              ? "var(--color-warning, #d97706)"
                              : "var(--color-error, #ef4444)",
                        }}
                      >
                        {item.reason}
                      </span>
                    </td>
                    <td style={{ padding: "8px 6px", fontFamily: "monospace" }}>
                      {formatRemaining(remaining)}
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "right" }}>
                      <button
                        type="button"
                        onClick={() => void handleReleaseOne(item)}
                        disabled={isReleasing}
                        style={{
                          padding: "3px 8px",
                          fontSize: "11px",
                          fontWeight: 500,
                          borderRadius: "4px",
                          border: "1px solid var(--color-border)",
                          background: "var(--color-bg-subtle, rgba(0,0,0,0.05))",
                          cursor: isReleasing ? "not-allowed" : "pointer",
                          color: "var(--color-text-main)",
                        }}
                      >
                        {isReleasing ? "..." : t("lockedModelsCard.release")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
