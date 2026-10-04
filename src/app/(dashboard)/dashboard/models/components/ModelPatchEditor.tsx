"use client";

import { useState } from "react";
import Editor from "@/shared/components/MonacoEditor";
import { Button, Card, Badge } from "@/shared/components";
import { getLocalizedPatchPresets, type PatchPreset } from "./patchPresets";
import { useModelPatchesI18n, isChineseLocale } from "./i18n";

interface ModelPatchEditorProps {
  initialContent: string;
  filePath: string;
  onSaved?: () => void;
}

export default function ModelPatchEditor({
  initialContent,
  filePath,
  onSaved,
}: ModelPatchEditorProps) {
  const i18n = useModelPatchesI18n();
  const isZh = isChineseLocale();
  const presets = getLocalizedPatchPresets(isZh);

  const [content, setContent] = useState(initialContent);
  const [lastSavedContent, setLastSavedContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{
    type: "success" | "error";
    message: string;
    line?: number;
    column?: number;
  } | null>(null);
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false);

  const hasUnsavedChanges = content !== lastSavedContent;

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus(null);

    try {
      const res = await fetch("/api/models/patches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setSaveStatus({
          type: "error",
          message:
            data.line && data.column
              ? i18n.syntaxErrorLineCol(data.line, data.column, data.error || "")
              : data.error || (isZh ? "保存配置失败" : "Failed to save configuration"),
          line: data.line,
          column: data.column,
        });
        return;
      }

      setLastSavedContent(content);
      setSaveStatus({
        type: "success",
        message: isZh
          ? `已成功保存！当前已加载 ${data.ruleCount ?? ""} 条规则并完成热重载。`
          : `Saved successfully! ${data.ruleCount ?? ""} rules active and hot-reloaded.`,
      });
      onSaved?.();

      setTimeout(() => {
        setSaveStatus((prev) => (prev?.type === "success" ? null : prev));
      }, 4000);
    } catch (err) {
      setSaveStatus({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : isZh
              ? "网络异常，保存失败"
              : "Network error occurred while saving",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleFormat = async () => {
    setFormatting(true);
    setSaveStatus(null);

    try {
      const res = await fetch("/api/models/patches", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Format failed");
      }

      const data = (await res.json()) as { formatted?: string };
      if (data.formatted) {
        setContent(data.formatted);
      }
    } catch (err) {
      setSaveStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to format JSONC",
      });
    } finally {
      setFormatting(false);
    }
  };

  const handleInsertPreset = (preset: PatchPreset) => {
    setPresetDropdownOpen(false);
    try {
      // Parse current content (or use object)
      const snippetString = JSON.stringify(preset.snippet, null, 2);
      const insertText = `\n    // Preset: ${preset.name}\n    "${preset.modelPattern}": ${snippetString.replace(/\n/g, "\n    ")},\n`;

      // If the provider block exists, insert inside it; otherwise append
      const providerMarker = `"${preset.provider}": {`;
      const markerIndex = content.indexOf(providerMarker);

      if (markerIndex !== -1) {
        const insertPos = markerIndex + providerMarker.length;
        const newText = content.slice(0, insertPos) + insertText + content.slice(insertPos);
        setContent(newText);
      } else {
        // Find last closing brace
        const lastBrace = content.lastIndexOf("}");
        if (lastBrace !== -1) {
          const newBlock = `,\n  "${preset.provider}": {\n    "${preset.modelPattern}": ${snippetString.replace(/\n/g, "\n    ")}\n  }\n`;
          const newText = content.slice(0, lastBrace) + newBlock + content.slice(lastBrace);
          setContent(newText);
        } else {
          setContent(content + "\n" + snippetString);
        }
      }

      setSaveStatus({
        type: "success",
        message: isZh
          ? `已插入预设模板 "${preset.name}"。请检查后点击保存并热重载。`
          : `Inserted preset "${preset.name}". Review and click Save.`,
      });
    } catch (err) {
      setSaveStatus({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : isZh
              ? "插入预设模板失败"
              : "Failed to insert preset",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Editor Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-black/[0.03] dark:bg-white/[0.03] rounded-lg border border-border">
        <div className="flex items-center gap-2 text-xs">
          <span className="material-symbols-outlined text-[18px] text-text-muted">description</span>
          <span className="font-mono text-text-main font-medium">{filePath}</span>
          {hasUnsavedChanges && (
            <Badge variant="warning" size="sm">
              {i18n.unsavedChanges}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Preset Selector */}
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              icon="library_add"
              onClick={() => setPresetDropdownOpen(!presetDropdownOpen)}
            >
              {i18n.insertPreset}
            </Button>
            {presetDropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-80 rounded-lg border border-border bg-card shadow-lg z-20 p-1 flex flex-col gap-0.5">
                <span className="px-2 py-1 text-[11px] font-semibold text-text-muted uppercase">
                  {i18n.insertPreset}
                </span>
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleInsertPreset(preset)}
                    className="flex flex-col text-left px-2.5 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <span className="text-xs font-semibold text-text-main">{preset.name}</span>
                    <span className="text-[11px] text-text-muted truncate">
                      {preset.description}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            variant="secondary"
            size="sm"
            icon="auto_fix_high"
            loading={formatting}
            onClick={handleFormat}
          >
            {formatting ? i18n.btnFormatting : i18n.btnFormat}
          </Button>

          {hasUnsavedChanges && (
            <Button
              variant="ghost"
              size="sm"
              icon="undo"
              onClick={() => {
                setContent(lastSavedContent);
                setSaveStatus(null);
              }}
            >
              {isZh ? "放弃修改" : "Reset"}
            </Button>
          )}

          <Button
            variant="primary"
            size="sm"
            icon="save"
            loading={saving}
            disabled={!hasUnsavedChanges && !saving}
            onClick={handleSave}
          >
            {saving ? i18n.btnSaving : i18n.btnSave}
          </Button>
        </div>
      </div>

      {/* Save / Error Status Banner */}
      {saveStatus && (
        <div
          className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 ${
            saveStatus.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
              : "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">
              {saveStatus.type === "success" ? "check_circle" : "error"}
            </span>
            <span>{saveStatus.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setSaveStatus(null)}
            className="hover:opacity-75"
            aria-label="Dismiss"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}

      {/* Editor Container */}
      <Card padding="none" className="overflow-hidden border border-border">
        <Editor
          height="540px"
          defaultLanguage="json"
          value={content}
          onChange={(val) => setContent(val ?? "")}
          theme="vs-dark"
          options={{
            minimap: { enabled: true },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            formatOnPaste: true,
          }}
        />
      </Card>
    </div>
  );
}
