"use client";

import { useState, useEffect, useCallback } from "react";
import { Button, Card, Badge } from "@/shared/components";
import SegmentedControl from "@/shared/components/SegmentedControl";
import ModelPatchInspector from "./ModelPatchInspector";
import ModelPatchEditor from "./ModelPatchEditor";
import ModelPatchRulesList, { type PatchRuleEntry } from "./ModelPatchRulesList";
import { useModelPatchesI18n } from "./i18n";

interface PatchesFileInfo {
  filePath: string;
  exists: boolean;
  mtime: string | null;
  size: number;
  content: string;
  ruleCount: number;
  entries: PatchRuleEntry[];
}

interface ModelPatchesViewProps {
  initialSubTab?: "inspector" | "editor" | "rules";
  prefillModelId?: string;
}

export default function ModelPatchesView({
  initialSubTab = "inspector",
  prefillModelId,
}: ModelPatchesViewProps) {
  const i18n = useModelPatchesI18n();
  const [subTab, setSubTab] = useState<string>(initialSubTab);
  const [fileInfo, setFileInfo] = useState<PatchesFileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sync to DB state
  const [syncingDb, setSyncingDb] = useState(false);
  const [syncDbResult, setSyncDbResult] = useState<string | null>(null);

  // Inspector prefill state
  const [inspectTargetModel, setInspectTargetModel] = useState<string>(
    prefillModelId || "nvidia/meta/llama-3.3-70b-instruct"
  );
  const [inspectTargetProvider, setInspectTargetProvider] = useState<string>("nvidia");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/models/patches");
      if (!res.ok) {
        throw new Error(i18n.loadFailed(res.status));
      }
      const data = (await res.json()) as PatchesFileInfo;
      setFileInfo(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.loadFailed(500));
    } finally {
      setLoading(false);
    }
  }, [i18n]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const handleSyncToDb = async () => {
    setSyncingDb(true);
    setSyncDbResult(null);

    try {
      const res = await fetch("/api/models/patches/apply", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || i18n.syncFailed);
      }
      setSyncDbResult(data.message || i18n.syncSuccess(data.capabilitiesCount ?? 0));
      setTimeout(() => setSyncDbResult(null), 5000);
    } catch (err) {
      setSyncDbResult(err instanceof Error ? `Error: ${err.message}` : i18n.syncFailed);
    } finally {
      setSyncingDb(false);
    }
  };

  const handleSelectModelForInspect = (modelId: string, provider: string) => {
    setInspectTargetModel(modelId);
    setInspectTargetProvider(provider);
    setSubTab("inspector");
  };

  const handleSelectPatternForEdit = (_pattern: string) => {
    setSubTab("editor");
  };

  const subTabOptions = [
    { value: "inspector", label: i18n.subtabInspector, icon: "troubleshoot" },
    { value: "editor", label: i18n.subtabEditor, icon: "edit_note" },
    {
      value: "rules",
      label: `${i18n.subtabRules} (${fileInfo?.ruleCount ?? 0})`,
      icon: "format_list_bulleted",
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Overview & Quick Action Header */}
      <Card padding="none" className="p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[22px]">tune</span>
                {i18n.title}
              </h2>
              <Badge variant="success" size="sm" dot>
                {i18n.statusLiveReload}
              </Badge>
              {fileInfo && (
                <Badge variant="outline" size="sm">
                  {i18n.rulesCountUnit(fileInfo.ruleCount)}
                </Badge>
              )}
            </div>
            <p className="text-xs text-text-muted">{i18n.description}</p>
            <div className="flex items-center gap-3 text-xs text-text-muted mt-1 font-mono">
              <span>
                {i18n.statusFilePath}: {fileInfo?.filePath || "config/models-patch.jsonc"}
              </span>
              {fileInfo?.mtime && (
                <span>
                  {i18n.statusLastModified}: {new Date(fileInfo.mtime).toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="secondary"
              icon="database"
              loading={syncingDb}
              onClick={handleSyncToDb}
              title={i18n.btnSyncDb}
            >
              {syncingDb ? i18n.btnSyncingDb : i18n.btnSyncDb}
            </Button>
            <Button
              variant="ghost"
              icon="refresh"
              loading={loading}
              onClick={loadData}
              title={i18n.btnReload}
            >
              {i18n.btnReload}
            </Button>
          </div>
        </div>

        {/* Sync to DB Result Toast */}
        {syncDbResult && (
          <div className="mt-4 p-3 rounded-lg border border-primary/20 bg-primary/10 text-xs text-primary flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              <span>{syncDbResult}</span>
            </div>
            <button
              type="button"
              onClick={() => setSyncDbResult(null)}
              className="hover:opacity-75"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>
        )}
      </Card>

      {/* Sub Navigation */}
      <div className="flex items-center justify-between">
        <SegmentedControl
          options={subTabOptions}
          value={subTab}
          onChange={(val) => setSubTab(val)}
        />
      </div>

      {/* Loading state */}
      {loading && !fileInfo && (
        <div className="flex items-center justify-center p-12 text-sm text-text-muted">
          {i18n.loadingConfig}
        </div>
      )}

      {/* Error state */}
      {error && !fileInfo && (
        <div className="p-6 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm flex items-center justify-between">
          <span>{error}</span>
          <Button variant="secondary" size="sm" onClick={loadData}>
            Retry
          </Button>
        </div>
      )}

      {/* Main Content Area */}
      {fileInfo && (
        <div>
          {subTab === "inspector" && (
            <ModelPatchInspector
              initialModelId={inspectTargetModel}
              initialProvider={inspectTargetProvider}
              onSelectForEdit={handleSelectPatternForEdit}
            />
          )}

          {subTab === "editor" && (
            <ModelPatchEditor
              initialContent={fileInfo.content}
              filePath={fileInfo.filePath}
              onSaved={loadData}
            />
          )}

          {subTab === "rules" && (
            <ModelPatchRulesList
              entries={fileInfo.entries}
              onInspect={handleSelectModelForInspect}
              onEdit={handleSelectPatternForEdit}
            />
          )}
        </div>
      )}
    </div>
  );
}
