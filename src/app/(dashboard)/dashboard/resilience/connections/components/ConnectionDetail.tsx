"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import type { ConnectionState } from "@/types/resilience";
import { formatRemaining } from "@/shared/utils/formatRemaining";
import { useNotificationStore } from "@/store/notificationStore";

interface ConnectionDetailProps {
  connection: ConnectionState | undefined; // undefined when connection deleted
  receivedAt: number; // client fetch receive time (immune to clock skew)
  onClose: () => void;
  onReleaseLockout?: (provider: string, model?: string, connectionId?: string) => void;
}

export default function ConnectionDetail({
  connection,
  receivedAt: _receivedAt,
  onClose,
  onReleaseLockout,
}: ConnectionDetailProps) {
  const t = useTranslations("resilienceConnections");
  const notify = useNotificationStore();
  const [tick, setTick] = useState(0); // force re-render for live countdown
  const [releasedModels, setReleasedModels] = useState<Set<string>>(new Set());
  const [releasingKey, setReleasingKey] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReleasedModels(new Set());
  }, [connection?.id]);
  useEffect(() => {
    if (!connection?.isCoolingDown) return;
    // Reset tick baseline when the connection changes so the countdown restarts from
    // the fresh cooldownRemainingMs. setTick(0) is a re-sync, not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTick(0);
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [connection?.isCoolingDown, connection?.id]);

  if (!connection) return null; // Guard: connection deleted while panel open
  const elapsedMs = tick * 1000;
  const adjustedCooldown = Math.max(0, connection.cooldownRemainingMs - elapsedMs);
  const visibleLockouts = (connection.lockouts || []).filter((l) => !releasedModels.has(l.model));

  const handleReleaseOne = async (model: string) => {
    if (!connection) return;
    setReleasingKey(model);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          model,
          connectionId: connection.id,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.releaseSuccess", { model }));
      setReleasedModels((prev) => new Set([...prev, model]));
      onReleaseLockout?.(connection.provider, model, connection.id);
    } catch (err) {
      console.error("[ConnectionDetail] Failed to release model:", err);
      notify.error(err instanceof Error ? err.message : "Failed to release model");
    } finally {
      setReleasingKey(null);
    }
  };

  const handleReleaseAll = async () => {
    if (!connection) return;
    setReleasingKey("ALL");
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          connectionId: connection.id,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.releaseAllSuccess"));
      setReleasedModels(new Set((connection.lockouts || []).map((l) => l.model)));
      onReleaseLockout?.(connection.provider, undefined, connection.id);
    } catch (err) {
      console.error("[ConnectionDetail] Failed to release all models:", err);
      notify.error(err instanceof Error ? err.message : "Failed to release all models");
    } finally {
      setReleasingKey(null);
    }
  };

  return (
    <div style={{ padding: "16px", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
      <h2>{t("detail.title")}</h2>
      <div>
        {t("detail.provider")}: {connection.provider}
      </div>
      <div>
        {t("detail.id")}: {connection.id}
      </div>
      <div>
        {t("detail.authType")}: {connection.authType}
      </div>
      <div>
        {t("detail.priority")}: {connection.priority}
      </div>
      <div>
        {t("detail.isActive")}: {connection.isActive ? t("detail.yes") : t("detail.no")}
      </div>
      <div>
        {t("detail.errorCode")}: {connection.errorCode ?? t("detail.never")}
      </div>
      <div>
        {t("detail.lastErrorAt")}: {connection.lastErrorAt ?? t("detail.never")}
      </div>
      <hr />
      <h3>{t("detail.cooldown")}</h3>
      <div>
        {t("detail.rateLimitedUntil")}: {connection.rateLimitedUntil ?? t("detail.never")}
      </div>
      <div>
        {t("detail.backoffLevel")}: {connection.backoffLevel}
      </div>
      <div>
        {t("detail.remaining")}:{" "}
        {connection.isCoolingDown ? formatRemaining(adjustedCooldown) : t("detail.never")}
      </div>
      <hr />
      <h3>{t("detail.breaker")}</h3>
      {connection.breaker ? (
        <div>
          <Badge
            variant={
              connection.breaker.state === "OPEN"
                ? "error"
                : connection.breaker.state === "HALF_OPEN"
                  ? "warning"
                  : connection.breaker.state === "DEGRADED"
                    ? "warning"
                    : "success"
            }
            size="sm"
          >
            {connection.breaker.state}
          </Badge>
          <div>
            {t("detail.failureCount")}: {connection.breaker.failureCount}
          </div>
          <div>
            {t("detail.retryAfterMs")}: {connection.breaker.retryAfterMs}
          </div>
          <div>
            {t("detail.lastFailureKind")}: {connection.breaker.lastFailureKind ?? t("detail.never")}
          </div>
        </div>
      ) : (
        <div>{t("detail.never")}</div>
      )}
      <hr />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{t("detail.lockouts")}</h3>
        {visibleLockouts.length > 1 && (
          <button
            type="button"
            onClick={() => void handleReleaseAll()}
            disabled={releasingKey === "ALL"}
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              fontWeight: 500,
              borderRadius: "4px",
              border: "1px solid rgba(245,158,11,0.4)",
              background: "rgba(245,158,11,0.15)",
              color: "var(--color-warning, #d97706)",
              cursor: releasingKey === "ALL" ? "not-allowed" : "pointer",
            }}
          >
            {releasingKey === "ALL" ? t("detail.releasing") : t("detail.releaseAll")}
          </button>
        )}
      </div>
      {visibleLockouts.length > 0 ? (
        <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
          {visibleLockouts.map((l, i) => {
            const isReleasing = releasingKey === l.model;
            return (
              <li
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "4px",
                  gap: "8px",
                }}
              >
                <span>
                  {l.model}: {l.reason} ({formatRemaining(Math.max(0, l.remainingMs - elapsedMs))})
                </span>
                <button
                  type="button"
                  onClick={() => void handleReleaseOne(l.model)}
                  disabled={isReleasing}
                  style={{
                    padding: "2px 6px",
                    fontSize: "11px",
                    borderRadius: "4px",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg-subtle, rgba(0,0,0,0.05))",
                    cursor: isReleasing ? "not-allowed" : "pointer",
                    color: "var(--color-text-main)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {isReleasing ? t("detail.releasing") : t("detail.release")}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div>{t("detail.noLockouts")}</div>
      )}
      <button type="button" onClick={onClose}>
        {t("detail.close")}
      </button>
    </div>
  );
}
