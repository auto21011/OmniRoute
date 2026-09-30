"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Modal from "./Modal";
import Button from "./Button";
import { useNotificationStore } from "@/store/notificationStore";

const DURATION_PRESETS = [
  { labelKey: "5m", fallback: "5m", ms: 5 * 60 * 1000 },
  { labelKey: "15m", fallback: "15m", ms: 15 * 60 * 1000 },
  { labelKey: "30m", fallback: "30m", ms: 30 * 60 * 1000 },
  { labelKey: "1h", fallback: "1h", ms: 60 * 60 * 1000 },
  { labelKey: "6h", fallback: "6h", ms: 6 * 60 * 60 * 1000 },
  { labelKey: "24h", fallback: "24h", ms: 24 * 60 * 60 * 1000 },
];

const REASON_PRESETS = [
  { key: "manual", value: "manual_disable", labelKey: "reasonManual", fallback: "Manual disable" },
  { key: "error", value: "service_error", labelKey: "reasonError", fallback: "Service error" },
  { key: "rateLimit", value: "rate_limit", labelKey: "reasonRateLimit", fallback: "Rate limited" },
  {
    key: "quality",
    value: "poor_quality",
    labelKey: "reasonQuality",
    fallback: "Poor response quality",
  },
];

export interface DisableModelModalProps {
  isOpen: boolean;
  onClose: () => void;
  provider: string;
  model: string;
  connectionId?: string | null;
  accountLabel?: string | null;
  onDisabled?: (result: { until: number; durationMs: number }) => void;
}

export default function DisableModelModal({
  isOpen,
  onClose,
  provider,
  model,
  connectionId,
  accountLabel,
  onDisabled,
}: DisableModelModalProps) {
  const t = useTranslations("requestLogger.detail");
  const notify = useNotificationStore();

  const [selectedDurationMs, setSelectedDurationMs] = useState<number>(15 * 60 * 1000);
  const [isCustomDuration, setIsCustomDuration] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("10");

  const [scope, setScope] = useState<"connection" | "provider">(
    connectionId ? "connection" : "provider"
  );
  const [reason, setReason] = useState("manual_disable");
  const [submitting, setSubmitting] = useState(false);

  const effectiveDurationMs = isCustomDuration
    ? Math.max(1, parseInt(customMinutes, 10) || 1) * 60 * 1000
    : selectedDurationMs;

  const handleSubmit = async () => {
    if (!provider || !model) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          durationMs: effectiveDurationMs,
          connectionId: scope === "connection" ? connectionId : null,
          scope,
          reason,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      notify.success(
        t.has?.("disableSuccess")
          ? t("disableSuccess", { model })
          : `Model ${model} disabled for ${Math.round(effectiveDurationMs / 60000)}m`
      );

      onDisabled?.({
        until: data.until || Date.now() + effectiveDurationMs,
        durationMs: effectiveDurationMs,
      });
      onClose();
    } catch (err) {
      console.error("[DisableModelModal] Failed to disable model:", err);
      notify.error(err instanceof Error ? err.message : "Failed to disable model");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-amber-500">pause_circle</span>
          <span>{t.has?.("disableModelTitle") ? t("disableModelTitle") : "Disable Model"}</span>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.has?.("cancel") ? t("cancel") : "Cancel"}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? t.has?.("disabling")
                ? t("disabling")
                : "Disabling..."
              : t.has?.("confirmDisable")
                ? t("confirmDisable")
                : "Confirm Disable"}
          </Button>
        </div>
      }
      size="md"
    >
      <div className="space-y-5">
        <p className="text-xs text-text-muted leading-relaxed">
          {t.has?.("disableModelDescription")
            ? t("disableModelDescription")
            : "Temporarily disable this model. Requests will automatically fall back to other available models or connections."}
        </p>

        {/* Target Info */}
        <div className="rounded-lg border border-border bg-bg-subtle p-3 flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">{t.has?.("model") ? t("model") : "Model"}:</span>
            <span className="font-mono font-bold text-text-main">{model}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted">
              {t.has?.("provider") ? t("provider") : "Provider"}:
            </span>
            <span className="font-mono uppercase font-semibold text-text-main">{provider}</span>
          </div>
          {connectionId && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted">
                {t.has?.("account") ? t("account") : "Account"}:
              </span>
              <span className="font-medium text-text-main">{accountLabel || connectionId}</span>
            </div>
          )}
        </div>

        {/* Duration Selection */}
        <div>
          <label className="block text-xs font-semibold text-text-main mb-2">
            {t.has?.("duration") ? t("duration") : "Duration"}
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {DURATION_PRESETS.map((preset) => {
              const active = !isCustomDuration && selectedDurationMs === preset.ms;
              return (
                <button
                  key={preset.ms}
                  type="button"
                  onClick={() => {
                    setSelectedDurationMs(preset.ms);
                    setIsCustomDuration(false);
                  }}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                    active
                      ? "bg-primary text-white border-primary shadow-sm"
                      : "bg-bg-subtle hover:bg-bg-surface border-border text-text-muted hover:text-text-main"
                  }`}
                >
                  {preset.fallback}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsCustomDuration(!isCustomDuration)}
              className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-all ${
                isCustomDuration
                  ? "bg-primary/20 text-primary border-primary/50"
                  : "bg-bg-subtle text-text-muted border-border hover:text-text-main"
              }`}
            >
              {t.has?.("custom") ? t("custom") : "Custom"}
            </button>
            {isCustomDuration && (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="1"
                  max="10080"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  className="w-20 px-2.5 py-1 text-xs rounded-lg border border-border bg-bg-surface text-text-main focus:outline-none focus:border-primary"
                />
                <span className="text-xs text-text-muted">
                  {t.has?.("minutes") ? t("minutes") : "min"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Scope Selection (if connectionId exists) */}
        {connectionId && (
          <div>
            <label className="block text-xs font-semibold text-text-main mb-2">
              {t.has?.("scope") ? t("scope") : "Scope"}
            </label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "connection"}
                  onChange={() => setScope("connection")}
                  className="text-primary focus:ring-primary"
                />
                <span className="text-text-main">
                  {t.has?.("scopeConnection")
                    ? t("scopeConnection", { account: accountLabel || connectionId })
                    : `Current connection only (${accountLabel || connectionId})`}
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "provider"}
                  onChange={() => setScope("provider")}
                  className="text-primary focus:ring-primary"
                />
                <span className="text-text-main">
                  {t.has?.("scopeProvider")
                    ? t("scopeProvider", { provider })
                    : `All connections for ${provider}`}
                </span>
              </label>
            </div>
          </div>
        )}

        {/* Reason */}
        <div>
          <label className="block text-xs font-semibold text-text-main mb-2">
            {t.has?.("reason") ? t("reason") : "Reason"}
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {REASON_PRESETS.map((p) => {
              const active = reason === p.value;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setReason(p.value)}
                  className={`px-2 py-1 text-[11px] rounded border transition-all ${
                    active
                      ? "bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/40 font-medium"
                      : "bg-bg-subtle text-text-muted border-border hover:text-text-main"
                  }`}
                >
                  {t.has?.(p.labelKey) ? t(p.labelKey) : p.fallback}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              t.has?.("reasonPlaceholder") ? t("reasonPlaceholder") : "Enter reason for disabling"
            }
            className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-bg-surface text-text-main focus:outline-none focus:border-primary"
          />
        </div>
      </div>
    </Modal>
  );
}
