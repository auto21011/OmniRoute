"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import type { ConnectionState } from "@/types/resilience";
import { formatRemaining } from "@/shared/utils/formatRemaining";
import { useNotificationStore } from "@/store/notificationStore";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { resolveProviderId, getProviderById } from "@/shared/constants/providers";

const DURATION_PRESETS = [
  { labelKey: "duration5m", ms: 5 * 60 * 1000 },
  { labelKey: "duration15m", ms: 15 * 60 * 1000 },
  { labelKey: "duration30m", ms: 30 * 60 * 1000 },
  { labelKey: "duration1h", ms: 60 * 60 * 1000 },
  { labelKey: "duration6h", ms: 6 * 60 * 1000 },
  { labelKey: "duration24h", ms: 24 * 60 * 1000 },
] as const;

interface ConnectionDetailProps {
  connection: ConnectionState | undefined; // undefined when connection deleted
  receivedAt: number; // client fetch receive time (immune to clock skew)
  onClose: () => void;
  onReleaseLockout?: (provider: string, model?: string, connectionId?: string) => void;
  onRefresh?: () => void;
}

export default function ConnectionDetail({
  connection,
  receivedAt: _receivedAt,
  onClose,
  onReleaseLockout,
  onRefresh,
}: ConnectionDetailProps) {
  const t = useTranslations("resilienceConnections");
  const notify = useNotificationStore();
  const [tick, setTick] = useState(0); // force re-render for live countdown
  const [releasedModels, setReleasedModels] = useState<Set<string>>(new Set());
  const [releasingKey, setReleasingKey] = useState<string | null>(null);
  const [isClearingCooldown, setIsClearingCooldown] = useState(false);
  const [isResettingBreaker, setIsResettingBreaker] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  // Model lockout creation
  const [isAddingLockout, setIsAddingLockout] = useState(false);
  const [lockoutModel, setLockoutModel] = useState("");
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [customModelText, setCustomModelText] = useState("");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [lockoutDuration, setLockoutDuration] = useState(5 * 60 * 1000);
  const [lockoutScope, setLockoutScope] = useState<"connection" | "provider">("connection");
  const [isSubmittingLockout, setIsSubmittingLockout] = useState(false);

  // Manual connection cooldown
  const [isSettingCooldown, setIsSettingCooldown] = useState(false);
  const [cooldownDuration, setCooldownDuration] = useState(5 * 60 * 1000);
  const [isSubmittingCooldown, setIsSubmittingCooldown] = useState(false);

  // Manual breaker trip
  const [isTrippingBreaker, setIsTrippingBreaker] = useState(false);

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

  useEffect(() => {
    if (!connection?.provider || typeof window === "undefined") {
      return;
    }
    if (process.env.NODE_ENV === "test" && !(globalThis as any).__TEST_ENABLE_MODEL_FETCH__) {
      const registryModels = getModelsByProviderId(connection.provider) || [];
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAvailableModels(registryModels.map((m) => ({ id: m.id, name: m.name || m.id })));
      setIsLoadingModels(false);
      return;
    }

    let cancelled = false;
    const providerId = connection.provider;
    const connectionId = connection.id;

    async function loadModels() {
      setIsLoadingModels(true);
      try {
        const [metaRes, syncRes, liveRes] = await Promise.allSettled([
          fetch(`/api/provider-models?provider=${encodeURIComponent(providerId)}`, {
            cache: "no-store",
          }),
          fetch(`/api/synced-available-models?provider=${encodeURIComponent(providerId)}`, {
            cache: "no-store",
          }),
          connectionId
            ? fetch(
                `/api/providers/${encodeURIComponent(connectionId)}/models?excludeHidden=true&chatOnly=true`,
                { cache: "no-store" }
              )
            : Promise.reject(new Error("No connection ID")),
        ]);

        if (cancelled) return;

        // 1. Gather all hidden model IDs for this provider
        const hiddenModelIds = new Set<string>();
        let customModelsList: Array<{
          id: string;
          name?: string;
          source?: string;
          isHidden?: boolean;
        }> = [];

        if (metaRes.status === "fulfilled" && metaRes.value.ok) {
          const metaData = await metaRes.value.json().catch(() => null);
          if (metaData) {
            // Check hiddenModelsByProvider
            if (
              metaData.hiddenModelsByProvider &&
              typeof metaData.hiddenModelsByProvider === "object"
            ) {
              const keysToCheck = [
                providerId,
                resolveProviderId(providerId),
                (PROVIDER_ID_TO_ALIAS as Record<string, string>)[providerId],
              ].filter((k): k is string => Boolean(k));
              for (const key of keysToCheck) {
                const list = metaData.hiddenModelsByProvider[key];
                if (Array.isArray(list)) {
                  for (const id of list) {
                    if (typeof id === "string" && id.trim()) hiddenModelIds.add(id.trim());
                  }
                }
              }
            }

            // Check modelCompatOverrides (id or modelId, isHidden or hiddenModalities.chat)
            if (Array.isArray(metaData.modelCompatOverrides)) {
              for (const o of metaData.modelCompatOverrides) {
                if (!o) continue;
                const mid =
                  typeof o.id === "string"
                    ? o.id.trim()
                    : typeof o.modelId === "string"
                      ? o.modelId.trim()
                      : "";
                if (!mid) continue;
                if (o.isHidden === true || o.hiddenModalities?.chat === true) {
                  hiddenModelIds.add(mid);
                }
              }
            }

            // Check custom models (id or modelId, isHidden or hiddenModalities.chat)
            if (Array.isArray(metaData.models)) {
              customModelsList = metaData.models;
              for (const m of metaData.models) {
                if (!m) continue;
                const mid =
                  typeof m.id === "string"
                    ? m.id.trim()
                    : typeof m.modelId === "string"
                      ? m.modelId.trim()
                      : "";
                if (!mid) continue;
                if (m.isHidden === true || m.hiddenModalities?.chat === true) {
                  hiddenModelIds.add(mid);
                }
              }
            }
          }
        }

        // 2. Determine candidate models
        const candidateMap = new Map<string, { id: string; name?: string }>();

        // Prefer liveRes if it returned an array of models
        if (liveRes.status === "fulfilled" && liveRes.value.ok) {
          const liveData = await liveRes.value.json().catch(() => null);
          if (liveData && Array.isArray(liveData.models)) {
            for (const m of liveData.models) {
              const id = String(m?.id || m?.modelId || m?.name || "").trim();
              if (id) {
                candidateMap.set(id, {
                  id,
                  name: String(m?.name || m?.id || id).trim(),
                });
              }
            }
          }
        }

        // Add synced models
        if (syncRes.status === "fulfilled" && syncRes.value.ok) {
          const syncData = await syncRes.value.json().catch(() => null);
          if (syncData && Array.isArray(syncData.models)) {
            for (const m of syncData.models) {
              const id = String(m?.id || m?.name || "").trim();
              if (id && !candidateMap.has(id)) {
                candidateMap.set(id, {
                  id,
                  name: String(m?.name || m?.id || id).trim(),
                });
              }
            }
          }
        }

        // Add custom models
        for (const cm of customModelsList) {
          if (cm?.id && typeof cm.id === "string") {
            const id = cm.id.trim();
            if (id && !candidateMap.has(id)) {
              candidateMap.set(id, {
                id,
                name: cm.name ? cm.name.trim() : id,
              });
            }
          }
        }

        // Add registry models
        const registryModels = getModelsByProviderId(providerId) || [];
        for (const rm of registryModels) {
          if (rm?.id && typeof rm.id === "string") {
            const id = rm.id.trim();
            if (id && !candidateMap.has(id)) {
              candidateMap.set(id, {
                id,
                name: rm.name ? rm.name.trim() : id,
              });
            }
          }
        }

        // 3. Filter out hidden models
        const filteredMap = new Map<string, { id: string; name?: string }>();
        for (const [id, m] of candidateMap.entries()) {
          if (hiddenModelIds.has(id)) continue;
          filteredMap.set(id, m);
        }

        // 4. Also keep any existing connection lockouts visible if not explicitly hidden
        for (const l of connection?.lockouts || []) {
          if (l?.model && typeof l.model === "string") {
            const id = l.model.trim();
            if (id && !hiddenModelIds.has(id) && !filteredMap.has(id)) {
              filteredMap.set(id, { id, name: id });
            }
          }
        }

        if (!cancelled) {
          setAvailableModels(Array.from(filteredMap.values()));
          setIsLoadingModels(false);
        }
      } catch (err) {
        console.warn("[ConnectionDetail] Failed to load provider models:", err);
        if (!cancelled) {
          setIsLoadingModels(false);
        }
      }
    }

    loadModels();
    return () => {
      cancelled = true;
    };
  }, [connection?.provider, connection?.id, connection?.lockouts]);

  useEffect(() => {
    if (!isLoadingModels && isAddingLockout && !isCustomModel && availableModels.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsCustomModel(true);
    }
  }, [isLoadingModels, isAddingLockout, isCustomModel, availableModels.length]);

  const effectiveModel = isCustomModel ? customModelText.trim() : lockoutModel.trim();

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

  const handleClearCooldown = async () => {
    if (!connection) return;
    setIsClearingCooldown(true);
    try {
      const res = await fetch("/api/resilience/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          provider: connection.provider,
          resetBreaker: false,
          clearLockouts: false,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.clearCooldownSuccess"));
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionDetail] Failed to clear cooldown:", err);
      notify.error(err instanceof Error ? err.message : "Failed to clear cooldown");
    } finally {
      setIsClearingCooldown(false);
    }
  };

  const handleResetBreaker = async () => {
    if (!connection) return;
    setIsResettingBreaker(true);
    try {
      const res = await fetch("/api/resilience/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset_breaker",
          breakerName: connection.provider,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.resetBreakerSuccess"));
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionDetail] Failed to reset breaker:", err);
      notify.error(err instanceof Error ? err.message : "Failed to reset breaker");
    } finally {
      setIsResettingBreaker(false);
    }
  };

  const handleRestoreConnection = async () => {
    if (!connection) return;
    setIsRestoring(true);
    try {
      const res = await fetch("/api/resilience/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          provider: connection.provider,
          resetBreaker: true,
          clearLockouts: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.restoreSuccess"));
      setReleasedModels(new Set((connection.lockouts || []).map((l) => l.model)));
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionDetail] Failed to restore connection:", err);
      notify.error(err instanceof Error ? err.message : "Failed to restore connection");
    } finally {
      setIsRestoring(false);
    }
  };

  const handleDisableModel = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetModel = effectiveModel;
    if (!connection || !targetModel) return;
    setIsSubmittingLockout(true);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          model: targetModel,
          durationMs: lockoutDuration,
          connectionId: lockoutScope === "connection" ? connection.id : undefined,
          scope: lockoutScope,
          reason: "manual_disable",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.disableSuccess", { model: targetModel }));
      setIsAddingLockout(false);
      setLockoutModel("");
      setIsCustomModel(false);
      setCustomModelText("");
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionDetail] Failed to disable model:", err);
      notify.error(err instanceof Error ? err.message : "Failed to disable model");
    } finally {
      setIsSubmittingLockout(false);
    }
  };

  const handleManualCooldown = async () => {
    if (!connection) return;
    setIsSubmittingCooldown(true);
    try {
      const res = await fetch("/api/resilience/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_cooldown",
          connectionId: connection.id,
          durationMs: cooldownDuration,
          reason: "manual_cooldown",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.setCooldownSuccess"));
      setIsSettingCooldown(false);
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionDetail] Failed to set cooldown:", err);
      notify.error(err instanceof Error ? err.message : "Failed to set cooldown");
    } finally {
      setIsSubmittingCooldown(false);
    }
  };

  const handleTripBreaker = async () => {
    if (!connection) return;
    setIsTrippingBreaker(true);
    try {
      const res = await fetch("/api/resilience/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "trip_breaker",
          breakerName: connection.provider,
          reason: "manual_trip",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      }
      notify.success(t("detail.tripBreakerSuccess"));
      onRefresh?.();
    } catch (err) {
      console.error("[ConnectionDetail] Failed to trip breaker:", err);
      notify.error(err instanceof Error ? err.message : "Failed to trip breaker");
    } finally {
      setIsTrippingBreaker(false);
    }
  };

  const isDegraded =
    connection.isCoolingDown ||
    connection.rateLimitedUntil != null ||
    connection.connectionStatus !== "healthy" ||
    (connection.breaker && connection.breaker.state !== "CLOSED") ||
    visibleLockouts.length > 0;

  return (
    <div style={{ padding: "16px", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <h2 style={{ margin: 0 }}>{t("detail.title")}</h2>
        {isDegraded && (
          <button
            type="button"
            onClick={() => void handleRestoreConnection()}
            disabled={isRestoring}
            style={{
              padding: "4px 12px",
              fontSize: "12px",
              fontWeight: 500,
              borderRadius: "6px",
              border: "1px solid var(--color-primary, #6366f1)",
              background: "rgba(99,102,241,0.15)",
              color: "var(--color-primary, #6366f1)",
              cursor: isRestoring ? "not-allowed" : "pointer",
            }}
          >
            {isRestoring ? t("detail.restoring") : t("detail.restoreConnection")}
          </button>
        )}
      </div>
      <div>
        {t("detail.provider")}:{" "}
        {(() => {
          const builtinName = getProviderById(connection.provider)?.name;
          const displayLabel = connection.name ?? builtinName ?? connection.provider;
          const showTooltip = displayLabel !== connection.provider;
          return showTooltip ? (
            <strong title={connection.provider} style={{ cursor: "help" }}>
              {displayLabel}
            </strong>
          ) : (
            <strong>{displayLabel}</strong>
          );
        })()}
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{t("detail.cooldown")}</h3>
        <div style={{ display: "flex", gap: "6px" }}>
          {connection.isCoolingDown ||
          connection.rateLimitedUntil != null ||
          connection.testStatus === "unavailable" ? (
            <button
              type="button"
              onClick={() => void handleClearCooldown()}
              disabled={isClearingCooldown}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "1px solid rgba(245,158,11,0.4)",
                background: "rgba(245,158,11,0.15)",
                color: "var(--color-warning, #d97706)",
                cursor: isClearingCooldown ? "not-allowed" : "pointer",
              }}
            >
              {isClearingCooldown ? t("detail.clearingCooldown") : t("detail.clearCooldown")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIsSettingCooldown(!isSettingCooldown)}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg-subtle, rgba(0,0,0,0.05))",
                color: "var(--color-text-main)",
                cursor: "pointer",
              }}
            >
              {isSettingCooldown ? t("detail.cancel") : `+ ${t("detail.manualCooldown")}`}
            </button>
          )}
        </div>
      </div>
      {isSettingCooldown && (
        <div
          style={{
            margin: "8px 0",
            padding: "10px",
            borderRadius: "6px",
            background: "var(--color-bg-subtle, rgba(0,0,0,0.03))",
            border: "1px solid var(--color-border)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", color: "var(--color-text-muted)" }}>
              {t("detail.duration")}:
            </span>
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {DURATION_PRESETS.map((d) => (
                <button
                  key={d.ms}
                  type="button"
                  onClick={() => setCooldownDuration(d.ms)}
                  style={{
                    padding: "2px 8px",
                    fontSize: "11px",
                    borderRadius: "4px",
                    border:
                      cooldownDuration === d.ms
                        ? "1px solid var(--color-primary, #6366f1)"
                        : "1px solid var(--color-border)",
                    background: cooldownDuration === d.ms ? "rgba(99,102,241,0.15)" : "transparent",
                    color:
                      cooldownDuration === d.ms
                        ? "var(--color-primary, #6366f1)"
                        : "var(--color-text-main)",
                    cursor: "pointer",
                  }}
                >
                  {t(`detail.${d.labelKey}`)}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setIsSettingCooldown(false)}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                borderRadius: "4px",
                border: "1px solid var(--color-border)",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              {t("detail.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleManualCooldown()}
              disabled={isSubmittingCooldown}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "1px solid var(--color-warning, #d97706)",
                background: "rgba(245,158,11,0.15)",
                color: "var(--color-warning, #d97706)",
                cursor: isSubmittingCooldown ? "not-allowed" : "pointer",
              }}
            >
              {isSubmittingCooldown ? "..." : t("detail.confirmCooldown")}
            </button>
          </div>
        </div>
      )}
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{t("detail.breaker")}</h3>
        <div style={{ display: "flex", gap: "6px" }}>
          {connection.breaker && connection.breaker.state !== "CLOSED" ? (
            <button
              type="button"
              onClick={() => void handleResetBreaker()}
              disabled={isResettingBreaker}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "1px solid rgba(239,68,68,0.4)",
                background: "rgba(239,68,68,0.15)",
                color: "var(--color-error, #ef4444)",
                cursor: isResettingBreaker ? "not-allowed" : "pointer",
              }}
            >
              {isResettingBreaker ? t("detail.resettingBreaker") : t("detail.resetBreaker")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleTripBreaker()}
              disabled={isTrippingBreaker}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "1px solid rgba(239,68,68,0.4)",
                background: "rgba(239,68,68,0.1)",
                color: "var(--color-error, #ef4444)",
                cursor: isTrippingBreaker ? "not-allowed" : "pointer",
              }}
            >
              {isTrippingBreaker ? "..." : t("detail.manualTrip")}
            </button>
          )}
        </div>
      </div>
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
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            onClick={() =>
              setIsAddingLockout((prev) => {
                const next = !prev;
                if (next) {
                  setLockoutModel("");
                  setIsCustomModel(availableModels.length === 0);
                  setCustomModelText("");
                }
                return next;
              })
            }
            style={{
              padding: "2px 8px",
              fontSize: "11px",
              fontWeight: 500,
              borderRadius: "4px",
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-subtle, rgba(0,0,0,0.05))",
              color: "var(--color-text-main)",
              cursor: "pointer",
            }}
          >
            {isAddingLockout ? t("detail.cancel") : `+ ${t("detail.disableModel")}`}
          </button>
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
      </div>

      {isAddingLockout && (
        <form
          onSubmit={(e) => void handleDisableModel(e)}
          style={{
            margin: "8px 0",
            padding: "10px",
            borderRadius: "6px",
            background: "var(--color-bg-subtle, rgba(0,0,0,0.03))",
            border: "1px solid var(--color-border)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div>
            <label
              style={{
                fontSize: "11px",
                color: "var(--color-text-muted)",
                display: "block",
                marginBottom: "4px",
              }}
            >
              {t("detail.selectModel")}
            </label>
            <select
              value={isCustomModel ? "__custom__" : lockoutModel}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "__custom__") {
                  setIsCustomModel(true);
                  setLockoutModel("");
                } else {
                  setIsCustomModel(false);
                  setLockoutModel(val);
                }
              }}
              disabled={isLoadingModels}
              style={{
                width: "100%",
                padding: "4px 8px",
                fontSize: "12px",
                borderRadius: "4px",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg, #fff)",
                color: "var(--color-text-main)",
                boxSizing: "border-box",
              }}
            >
              <option value="">
                {isLoadingModels ? "..." : t("detail.selectModelPlaceholder")}
              </option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
                </option>
              ))}
              <option value="__custom__">{t("detail.customModelOption")}</option>
            </select>
            {isCustomModel && (
              <div style={{ marginTop: "6px" }}>
                <input
                  type="text"
                  required
                  value={customModelText}
                  onChange={(e) => setCustomModelText(e.target.value)}
                  placeholder={t("detail.customModelPlaceholder")}
                  style={{
                    width: "100%",
                    padding: "4px 8px",
                    fontSize: "12px",
                    borderRadius: "4px",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg, #fff)",
                    color: "var(--color-text-main)",
                    boxSizing: "border-box",
                  }}
                  autoFocus
                />
              </div>
            )}
          </div>
          <div>
            <label
              style={{
                fontSize: "11px",
                color: "var(--color-text-muted)",
                display: "block",
                marginBottom: "4px",
              }}
            >
              {t("detail.scope")}
            </label>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                type="button"
                onClick={() => setLockoutScope("connection")}
                style={{
                  padding: "2px 8px",
                  fontSize: "11px",
                  borderRadius: "4px",
                  border:
                    lockoutScope === "connection"
                      ? "1px solid var(--color-primary, #6366f1)"
                      : "1px solid var(--color-border)",
                  background:
                    lockoutScope === "connection" ? "rgba(99,102,241,0.15)" : "transparent",
                  color:
                    lockoutScope === "connection"
                      ? "var(--color-primary, #6366f1)"
                      : "var(--color-text-main)",
                  cursor: "pointer",
                }}
              >
                {t("detail.scopeConnection")}
              </button>
              <button
                type="button"
                onClick={() => setLockoutScope("provider")}
                style={{
                  padding: "2px 8px",
                  fontSize: "11px",
                  borderRadius: "4px",
                  border:
                    lockoutScope === "provider"
                      ? "1px solid var(--color-primary, #6366f1)"
                      : "1px solid var(--color-border)",
                  background: lockoutScope === "provider" ? "rgba(99,102,241,0.15)" : "transparent",
                  color:
                    lockoutScope === "provider"
                      ? "var(--color-primary, #6366f1)"
                      : "var(--color-text-main)",
                  cursor: "pointer",
                }}
              >
                {t("detail.scopeProvider")}
              </button>
            </div>
          </div>
          <div>
            <label
              style={{
                fontSize: "11px",
                color: "var(--color-text-muted)",
                display: "block",
                marginBottom: "4px",
              }}
            >
              {t("detail.duration")}
            </label>
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {DURATION_PRESETS.map((d) => (
                <button
                  key={d.ms}
                  type="button"
                  onClick={() => setLockoutDuration(d.ms)}
                  style={{
                    padding: "2px 8px",
                    fontSize: "11px",
                    borderRadius: "4px",
                    border:
                      lockoutDuration === d.ms
                        ? "1px solid var(--color-primary, #6366f1)"
                        : "1px solid var(--color-border)",
                    background: lockoutDuration === d.ms ? "rgba(99,102,241,0.15)" : "transparent",
                    color:
                      lockoutDuration === d.ms
                        ? "var(--color-primary, #6366f1)"
                        : "var(--color-text-main)",
                    cursor: "pointer",
                  }}
                >
                  {t(`detail.${d.labelKey}`)}
                </button>
              ))}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: "6px",
              justifyContent: "flex-end",
              marginTop: "4px",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setIsAddingLockout(false);
                setLockoutModel("");
                setIsCustomModel(false);
                setCustomModelText("");
              }}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                borderRadius: "4px",
                border: "1px solid var(--color-border)",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              {t("detail.cancel")}
            </button>
            <button
              type="submit"
              disabled={isSubmittingLockout || !effectiveModel}
              style={{
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "4px",
                border: "1px solid rgba(245,158,11,0.4)",
                background: "rgba(245,158,11,0.15)",
                color: "var(--color-warning, #d97706)",
                cursor: isSubmittingLockout || !effectiveModel ? "not-allowed" : "pointer",
              }}
            >
              {isSubmittingLockout ? "..." : t("detail.confirm")}
            </button>
          </div>
        </form>
      )}

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
