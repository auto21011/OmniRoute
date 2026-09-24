"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, ConfirmModal, Input, Modal, Select } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { useNotificationStore } from "@/store/notificationStore";
import { useTranslations } from "next-intl";

export type ConfiguredErrorReason =
  | "auth_error"
  | "quota_exhausted"
  | "rate_limit_exceeded"
  | "model_capacity"
  | "server_error"
  | "unknown";

export type OperatorProviderErrorRule = {
  status: number;
  match: string;
  scope: "model" | "provider" | "connection";
  reason?: ConfiguredErrorReason;
  cooldownMs?: number;
};

export type ProviderErrorRulesMap = Record<string, OperatorProviderErrorRule[]>;

type FlatRule = {
  provider: string;
  index: number;
  rule: OperatorProviderErrorRule;
};

const COMMON_STATUS_CODES = [
  { value: "429", label: "429 - Too Many Requests / Quota" },
  { value: "400", label: "400 - Bad Request" },
  { value: "401", label: "401 - Unauthorized" },
  { value: "402", label: "402 - Payment Required / Credits" },
  { value: "403", label: "403 - Forbidden" },
  { value: "404", label: "404 - Not Found" },
  { value: "500", label: "500 - Internal Server Error" },
  { value: "502", label: "502 - Bad Gateway" },
  { value: "503", label: "503 - Service Unavailable" },
  { value: "504", label: "504 - Gateway Timeout" },
  { value: "__custom__", label: "Custom Status Code..." },
];

const COOLDOWN_PRESETS = [
  { value: "default", label: "Default / 系统默认", ms: undefined },
  { value: "60000", label: "1m (1 分钟)", ms: 60_000 },
  { value: "300000", label: "5m (5 分钟)", ms: 300_000 },
  { value: "900000", label: "15m (15 分钟)", ms: 900_000 },
  { value: "3600000", label: "1h (1 小时)", ms: 3_600_000 },
  { value: "21600000", label: "6h (6 小时)", ms: 21_600_000 },
  { value: "43200000", label: "12h (12 小时)", ms: 43_200_000 },
  { value: "86400000", label: "24h (24 小时)", ms: 86_400_000 },
  { value: "custom", label: "Custom (自定义毫秒)", ms: -1 },
];

function formatCooldown(ms?: number): string {
  if (!ms || ms <= 0) return "Default";
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export default function ProviderErrorRulesCard() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const notify = useNotificationStore();

  const [data, setData] = useState<ProviderErrorRulesMap>({});
  const [draft, setDraft] = useState<ProviderErrorRulesMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configuredProviders, setConfiguredProviders] = useState<Record<string, number>>({});

  // Modal State for Add / Edit
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<{
    provider: string;
    index: number;
  } | null>(null);

  // Form State
  const [formProviderSelect, setFormProviderSelect] = useState<string>("");
  const [formCustomProvider, setFormCustomProvider] = useState<string>("");
  const [formStatusCodeSelect, setFormStatusCodeSelect] = useState<string>("429");
  const [formCustomStatusCode, setFormCustomStatusCode] = useState<string>("429");
  const [formMatchText, setFormMatchText] = useState<string>("");
  const [formScope, setFormScope] = useState<"model" | "connection" | "provider">("model");
  const [formReason, setFormReason] = useState<ConfiguredErrorReason>("quota_exhausted");
  const [formCooldownPreset, setFormCooldownPreset] = useState<string>("default");
  const [formCustomCooldownMs, setFormCustomCooldownMs] = useState<string>("60000");

  // Confirm Delete State
  const [deleteTarget, setDeleteTarget] = useState<{
    provider: string;
    index: number;
    match: string;
  } | null>(null);

  // Load current settings and active provider connections
  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const [settingsRes, providersRes] = await Promise.allSettled([
          fetch("/api/settings", { cache: "no-store" }),
          fetch("/api/providers", { cache: "no-store" }),
        ]);

        if (settingsRes.status === "fulfilled" && settingsRes.value.ok) {
          const json = await settingsRes.value.json();
          const rules = (json?.providerErrorRules ?? {}) as ProviderErrorRulesMap;
          if (mounted) {
            setData(rules);
            setDraft(rules);
          }
        }

        if (providersRes.status === "fulfilled" && providersRes.value.ok) {
          const json = await providersRes.value.json();
          const connections: Array<{ provider?: string; name?: string; id?: string }> =
            Array.isArray(json?.connections) ? json.connections : Array.isArray(json) ? json : [];
          const counts: Record<string, number> = {};
          for (const c of connections) {
            const p = c.provider?.trim();
            if (p) {
              counts[p] = (counts[p] ?? 0) + 1;
            }
          }
          if (mounted) {
            setConfiguredProviders(counts);
          }
        }
      } catch (err) {
        if (mounted) {
          notify.error(err instanceof Error ? err.message : t("providerErrorRulesSaveFailed"));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [notify, t]);

  // Options for configured active providers in the system
  const configuredOptions = useMemo(() => {
    return Object.entries(configuredProviders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, count]) => ({
        value: provider,
        label: `${provider} (${t("providerErrorRulesConfiguredAccounts", { count })})`,
      }));
  }, [configuredProviders, t]);

  // Options for all supported system providers (excluding already configured ones)
  const catalogOptions = useMemo(() => {
    const configuredSet = new Set(Object.keys(configuredProviders));
    const seen = new Set<string>();
    const list: { value: string; label: string }[] = [];

    try {
      for (const p of Object.values(AI_PROVIDERS)) {
        const id = typeof p?.id === "string" ? p.id.trim() : "";
        if (!id || configuredSet.has(id) || seen.has(id)) continue;
        seen.add(id);
        const name = typeof p?.name === "string" ? p.name.trim() : "";
        list.push({
          value: id,
          label: name && name.toLowerCase() !== id.toLowerCase() ? `${name} (${id})` : id,
        });
      }
    } catch {
      /* fallback if registry read encounters an issue */
    }

    // Also include any providers in existing draft rules if not already in list
    for (const p of Object.keys(draft)) {
      const trimmed = p.trim();
      if (trimmed && !configuredSet.has(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
        list.push({ value: trimmed, label: trimmed });
      }
    }

    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [configuredProviders, draft]);

  // Flattened rules list for easy rendering
  const flatRules: FlatRule[] = useMemo(() => {
    const list: FlatRule[] = [];
    for (const [provider, rules] of Object.entries(draft)) {
      if (Array.isArray(rules)) {
        rules.forEach((rule, index) => {
          list.push({ provider, index, rule });
        });
      }
    }
    return list;
  }, [draft]);

  const hasChanges = useMemo(() => {
    return JSON.stringify(data) !== JSON.stringify(draft);
  }, [data, draft]);

  // Open modal for adding
  const handleOpenAdd = () => {
    setEditingTarget(null);
    const firstConfigured = Object.keys(configuredProviders)[0];
    const initial = firstConfigured || catalogOptions[0]?.value || "sensenova";
    setFormProviderSelect(initial);
    setFormCustomProvider("");
    setFormStatusCodeSelect("429");
    setFormCustomStatusCode("429");
    setFormMatchText("");
    setFormScope("model");
    setFormReason("quota_exhausted");
    setFormCooldownPreset("default");
    setFormCustomCooldownMs("60000");
    setModalOpen(true);
  };

  // Open modal for editing
  const handleOpenEdit = (target: FlatRule) => {
    setEditingTarget({ provider: target.provider, index: target.index });

    const isKnown =
      configuredProviders[target.provider] !== undefined ||
      catalogOptions.some((opt) => opt.value === target.provider);

    if (isKnown) {
      setFormProviderSelect(target.provider);
      setFormCustomProvider("");
    } else {
      setFormProviderSelect("__custom__");
      setFormCustomProvider(target.provider);
    }

    const statusStr = String(target.rule.status);
    if (COMMON_STATUS_CODES.some((opt) => opt.value === statusStr)) {
      setFormStatusCodeSelect(statusStr);
      setFormCustomStatusCode(statusStr);
    } else {
      setFormStatusCodeSelect("__custom__");
      setFormCustomStatusCode(statusStr);
    }

    setFormMatchText(target.rule.match);
    setFormScope(target.rule.scope);
    setFormReason(target.rule.reason ?? "quota_exhausted");

    if (target.rule.cooldownMs === undefined) {
      setFormCooldownPreset("default");
      setFormCustomCooldownMs("60000");
    } else {
      const matchPreset = COOLDOWN_PRESETS.find((p) => p.ms === target.rule.cooldownMs);
      if (matchPreset) {
        setFormCooldownPreset(matchPreset.value);
        setFormCustomCooldownMs(String(target.rule.cooldownMs));
      } else {
        setFormCooldownPreset("custom");
        setFormCustomCooldownMs(String(target.rule.cooldownMs));
      }
    }

    setModalOpen(true);
  };

  // Save rule from modal into local draft
  const handleSaveModalRule = () => {
    const providerKey = (
      formProviderSelect === "__custom__" ? formCustomProvider : formProviderSelect
    ).trim();

    if (!providerKey) {
      notify.error(t("providerErrorRulesProvider") + " " + tc("cannotBeEmpty"));
      return;
    }

    const statusNum =
      formStatusCodeSelect === "__custom__"
        ? Number.parseInt(formCustomStatusCode, 10)
        : Number.parseInt(formStatusCodeSelect, 10);

    if (Number.isNaN(statusNum) || statusNum < 100 || statusNum > 599) {
      notify.error(t("providerErrorRulesStatus") + " " + tc("invalidValue"));
      return;
    }

    const trimmedMatch = formMatchText.trim();
    if (!trimmedMatch) {
      notify.error(t("providerErrorRulesMatch") + " " + tc("cannotBeEmpty"));
      return;
    }

    if (trimmedMatch.length > 200) {
      notify.error(t("providerErrorRulesMatch") + " (max 200 chars)");
      return;
    }

    let cooldownMs: number | undefined;
    if (formCooldownPreset === "default") {
      cooldownMs = undefined;
    } else if (formCooldownPreset === "custom") {
      const parsed = Number.parseInt(formCustomCooldownMs, 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 86_400_000) {
        notify.error(t("providerErrorRulesCooldown") + " (0 - 86,400,000 ms)");
        return;
      }
      cooldownMs = parsed;
    } else {
      const preset = COOLDOWN_PRESETS.find((p) => p.value === formCooldownPreset);
      cooldownMs = preset?.ms;
    }

    const newRule: OperatorProviderErrorRule = {
      status: statusNum,
      match: trimmedMatch,
      scope: formScope,
      reason: formReason,
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    };

    const nextDraft: ProviderErrorRulesMap = { ...draft };

    if (editingTarget) {
      // Editing existing rule
      const { provider: oldProvider, index: oldIndex } = editingTarget;
      if (oldProvider === providerKey) {
        const arr = [...(nextDraft[oldProvider] || [])];
        arr[oldIndex] = newRule;
        nextDraft[oldProvider] = arr;
      } else {
        // Provider changed: remove from old, push to new
        const oldArr = (nextDraft[oldProvider] || []).filter((_, idx) => idx !== oldIndex);
        if (oldArr.length === 0) {
          delete nextDraft[oldProvider];
        } else {
          nextDraft[oldProvider] = oldArr;
        }
        nextDraft[providerKey] = [...(nextDraft[providerKey] || []), newRule];
      }
    } else {
      // Adding new rule
      const totalRules = Object.values(nextDraft).reduce((sum, r) => sum + r.length, 0);
      if (totalRules >= 50) {
        notify.error("providerErrorRules: at most 50 rules total");
        return;
      }
      nextDraft[providerKey] = [...(nextDraft[providerKey] || []), newRule];
    }

    setDraft(nextDraft);
    setModalOpen(false);
  };

  // Delete rule from local draft
  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    const { provider, index } = deleteTarget;
    const nextDraft: ProviderErrorRulesMap = { ...draft };
    const currentRules = nextDraft[provider] || [];
    const filtered = currentRules.filter((_, idx) => idx !== index);

    if (filtered.length === 0) {
      delete nextDraft[provider];
    } else {
      nextDraft[provider] = filtered;
    }

    setDraft(nextDraft);
    setDeleteTarget(null);
  };

  // Revert changes
  const handleCancel = () => {
    setDraft(data);
  };

  // Persist draft via PATCH /api/settings
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerErrorRules: draft }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error || `HTTP ${res.status}`);
      }

      const json = await res.json();
      const updated = (json?.providerErrorRules ?? draft) as ProviderErrorRulesMap;
      setData(updated);
      setDraft(updated);
      notify.success(t("providerErrorRulesSaveSuccess"));
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t("providerErrorRulesSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const scopeBadgeVariant = (scope: string) => {
    if (scope === "model") return "default";
    if (scope === "connection") return "warning";
    return "error";
  };

  const scopeLabel = (scope: string) => {
    if (scope === "model") return t("providerErrorRulesScopeModelBadge");
    if (scope === "connection") return t("providerErrorRulesScopeConnectionBadge");
    if (scope === "provider") return t("providerErrorRulesScopeProviderBadge");
    return scope;
  };

  const scopeHint = (scope: string) => {
    if (scope === "model") return t("providerErrorRulesScopeModelHint");
    if (scope === "connection") return t("providerErrorRulesScopeConnectionHint");
    if (scope === "provider") return t("providerErrorRulesScopeProviderHint");
    return "";
  };

  const reasonBadgeVariant = (reason?: ConfiguredErrorReason) => {
    if (reason === "quota_exhausted") return "error";
    if (reason === "rate_limit_exceeded") return "warning";
    if (reason === "auth_error") return "error";
    if (reason === "model_capacity") return "primary";
    return "default";
  };

  const reasonLabel = (reason?: ConfiguredErrorReason) => {
    switch (reason) {
      case "quota_exhausted":
        return t("providerErrorRulesReasonQuota");
      case "rate_limit_exceeded":
        return t("providerErrorRulesReasonRateLimit");
      case "auth_error":
        return t("providerErrorRulesReasonAuth");
      case "model_capacity":
        return t("providerErrorRulesReasonCapacity");
      case "server_error":
        return t("providerErrorRulesReasonServer");
      default:
        return t("providerErrorRulesReasonUnknown");
    }
  };

  return (
    <Card className="p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text-main">{t("providerErrorRules")}</h2>
            <Badge variant="default" size="sm">
              {flatRules.length} / 50
            </Badge>
          </div>
          <p className="mt-1 text-xs text-text-muted">{t("providerErrorRulesDesc")}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <>
              <Button variant="secondary" size="sm" onClick={handleCancel} disabled={saving}>
                {tc("cancel")}
              </Button>
              <Button variant="primary" size="sm" icon="save" onClick={handleSave} loading={saving}>
                {tc("save")}
              </Button>
            </>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="add"
            onClick={handleOpenAdd}
            disabled={loading || saving || flatRules.length >= 50}
          >
            {t("providerErrorRulesAdd")}
          </Button>
        </div>
      </div>

      {/* Rules Table / Empty State */}
      <div className="mt-6">
        {loading ? (
          <div className="py-8 text-center text-sm text-text-muted">{tc("loading")}...</div>
        ) : flatRules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center">
            <span className="material-symbols-outlined text-3xl text-text-muted">rule</span>
            <p className="mt-2 text-sm text-text-muted">{t("providerErrorRulesEmpty")}</p>
            <Button
              variant="secondary"
              size="sm"
              icon="add"
              className="mt-4"
              onClick={handleOpenAdd}
            >
              {t("providerErrorRulesAdd")}
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-bg-subtle/50 text-text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t("providerErrorRulesProvider")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("providerErrorRulesStatus")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("providerErrorRulesMatch")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("providerErrorRulesScope")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("providerErrorRulesReason")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("providerErrorRulesCooldown")}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{tc("actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {flatRules.map((item) => (
                  <tr key={`${item.provider}-${item.index}`} className="hover:bg-bg-subtle/50">
                    <td className="px-4 py-3 font-semibold text-text-main">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm text-text-muted">
                          dns
                        </span>
                        {item.provider}
                        {configuredProviders[item.provider] ? (
                          <span
                            className="text-[11px] font-normal text-text-muted"
                            title={t("providerErrorRulesConfiguredAccounts", {
                              count: configuredProviders[item.provider],
                            })}
                          >
                            ({configuredProviders[item.provider]})
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="warning" size="sm">
                        {item.rule.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-bg-subtle px-2 py-0.5 font-mono text-text-main">
                        &quot;{item.rule.match}&quot;
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <span title={scopeHint(item.rule.scope)}>
                        <Badge variant={scopeBadgeVariant(item.rule.scope)} size="sm">
                          {scopeLabel(item.rule.scope)}
                        </Badge>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={reasonBadgeVariant(item.rule.reason)} size="sm">
                        {reasonLabel(item.rule.reason)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {formatCooldown(item.rule.cooldownMs)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          className="rounded p-1 text-text-muted hover:bg-bg-subtle hover:text-text-main"
                          onClick={() => handleOpenEdit(item)}
                          title={tc("edit")}
                        >
                          <span className="material-symbols-outlined text-base">edit</span>
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                          onClick={() =>
                            setDeleteTarget({
                              provider: item.provider,
                              index: item.index,
                              match: item.rule.match,
                            })
                          }
                          title={tc("delete")}
                        >
                          <span className="material-symbols-outlined text-base">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingTarget ? t("providerErrorRulesEdit") : t("providerErrorRulesAdd")}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSaveModalRule}>
              {tc("confirm")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Provider Select / Input */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">
              {t("providerErrorRulesProvider")} *
            </label>
            <Select
              value={formProviderSelect}
              onChange={(e) => {
                const val = e.target.value;
                setFormProviderSelect(val);
                if (val !== "__custom__") {
                  setFormCustomProvider("");
                }
              }}
            >
              {configuredOptions.length > 0 && (
                <optgroup label={t("providerErrorRulesConfiguredGroup")}>
                  {configuredOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {catalogOptions.length > 0 && (
                <optgroup label={t("providerErrorRulesAllGroup")}>
                  {catalogOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t("providerErrorRulesCustomGroup")}>
                <option value="__custom__">{t("providerErrorRulesCustomOption")}</option>
              </optgroup>
            </Select>
            {formProviderSelect === "__custom__" && (
              <Input
                placeholder="e.g. sensenova, openai, custom-proxy-..."
                value={formCustomProvider}
                onChange={(e) => setFormCustomProvider(e.target.value)}
                className="mt-1"
                autoFocus
              />
            )}
          </div>

          {/* HTTP Status Code */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">
              {t("providerErrorRulesStatus")} *
            </label>
            <Select
              value={formStatusCodeSelect}
              onChange={(e) => setFormStatusCodeSelect(e.target.value)}
              options={COMMON_STATUS_CODES}
            />
            {formStatusCodeSelect === "__custom__" && (
              <Input
                type="number"
                min={100}
                max={599}
                placeholder="429"
                value={formCustomStatusCode}
                onChange={(e) => setFormCustomStatusCode(e.target.value)}
                className="mt-1"
              />
            )}
          </div>

          {/* Match Keyword */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">
              {t("providerErrorRulesMatch")} *
            </label>
            <Input
              placeholder={t("providerErrorRulesMatchPlaceholder")}
              value={formMatchText}
              onChange={(e) => setFormMatchText(e.target.value)}
            />
            <span className="text-[11px] text-text-muted">
              不区分大小写，当上游返回文本中包含此片段时触发。
            </span>
          </div>

          {/* Scope Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">
              {t("providerErrorRulesScope")} *
            </label>
            <Select
              value={formScope}
              onChange={(e) => setFormScope(e.target.value as "model" | "connection" | "provider")}
              options={[
                { value: "model", label: t("providerErrorRulesScopeModel") },
                { value: "connection", label: t("providerErrorRulesScopeConnection") },
                { value: "provider", label: t("providerErrorRulesScopeProvider") },
              ]}
            />
            <div className="rounded-md border border-border bg-bg-subtle p-2.5 text-xs text-text-muted leading-relaxed">
              {formScope === "model" && (
                <div>
                  <span className="font-semibold text-accent">{tc("tip") || "提示"}：</span>
                  {t("providerErrorRulesScopeModelHint")}
                </div>
              )}
              {formScope === "connection" && (
                <div>
                  <span className="font-semibold text-amber-500">{tc("tip") || "提示"}：</span>
                  {t("providerErrorRulesScopeConnectionHint")}
                </div>
              )}
              {formScope === "provider" && (
                <div>
                  <span className="font-semibold text-red-500">{tc("warning") || "警告"}：</span>
                  {t("providerErrorRulesScopeProviderHint")}
                </div>
              )}
            </div>
          </div>

          {/* Reason Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">
              {t("providerErrorRulesReason")} *
            </label>
            <Select
              value={formReason}
              onChange={(e) => setFormReason(e.target.value as ConfiguredErrorReason)}
              options={[
                { value: "quota_exhausted", label: t("providerErrorRulesReasonQuota") },
                { value: "rate_limit_exceeded", label: t("providerErrorRulesReasonRateLimit") },
                { value: "auth_error", label: t("providerErrorRulesReasonAuth") },
                { value: "model_capacity", label: t("providerErrorRulesReasonCapacity") },
                { value: "server_error", label: t("providerErrorRulesReasonServer") },
                { value: "unknown", label: t("providerErrorRulesReasonUnknown") },
              ]}
            />
          </div>

          {/* Cooldown Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-main">
              {t("providerErrorRulesCooldown")}
            </label>
            <Select
              value={formCooldownPreset}
              onChange={(e) => setFormCooldownPreset(e.target.value)}
              options={COOLDOWN_PRESETS.map((p) => ({
                value: p.value,
                label: p.label,
              }))}
            />
            {formCooldownPreset === "custom" && (
              <div className="mt-1 flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={86400000}
                  step={1000}
                  placeholder="60000"
                  value={formCustomCooldownMs}
                  onChange={(e) => setFormCustomCooldownMs(e.target.value)}
                />
                <span className="text-xs text-text-muted">ms</span>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Confirm Delete Modal */}
      {deleteTarget && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
          title={t("providerErrorRulesDelete")}
          message={`${t("providerErrorRulesConfirmDelete", { provider: deleteTarget.provider })} ("${deleteTarget.match}")`}
          confirmLabel={tc("delete")}
          cancelLabel={tc("cancel")}
          variant="danger"
        />
      )}
    </Card>
  );
}
