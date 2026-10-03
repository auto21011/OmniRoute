"use client";

import { useState, useEffect, useCallback } from "react";
import { Button, Card, Input, Badge } from "@/shared/components";

interface MatchedRule {
  provider: string;
  modelPattern: string;
  matchType: "exact" | "leaf" | "wildcard" | "provider_default" | "global";
  patch: Record<string, unknown>;
}

interface InspectResult {
  modelId: string;
  qualifiedId: string;
  provider: string;
  matchedRule: MatchedRule | null;
  effectivePatch: Record<string, unknown> | null;
  simulatedCatalogEntry: Record<string, unknown>;
  resolvedCapabilities: Record<string, unknown>;
}

interface ModelPatchInspectorProps {
  initialModelId?: string;
  initialProvider?: string;
  onSelectForEdit?: (pattern: string) => void;
}

const QUICK_TEST_MODELS = [
  { label: "Llama 3.3 70B", id: "nvidia/meta/llama-3.3-70b-instruct", provider: "nvidia" },
  { label: "Nemotron 70B", id: "nvidia/llama-3.1-nemotron-70b-instruct", provider: "nvidia" },
  { label: "DeepSeek R1", id: "nvidia/deepseek-ai/deepseek-r1", provider: "nvidia" },
  { label: "Phi-3 Vision", id: "nvidia/microsoft/phi-3-vision-128k-instruct", provider: "nvidia" },
  { label: "Qwen 2.5 VL", id: "nvidia/qwen/qwen2.5-vl-72b-instruct", provider: "nvidia" },
];

export default function ModelPatchInspector({
  initialModelId = "nvidia/meta/llama-3.3-70b-instruct",
  initialProvider = "nvidia",
  onSelectForEdit,
}: ModelPatchInspectorProps) {
  const [modelInput, setModelInput] = useState(initialModelId);
  const [providerInput, setProviderInput] = useState(initialProvider);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [copied, setCopied] = useState(false);

  const runInspect = useCallback(async (targetModel: string, targetProvider: string) => {
    if (!targetModel.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/models/patches/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: targetModel.trim(),
          provider: targetProvider.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as InspectResult;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inspection failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialModelId) {
      const timer = window.setTimeout(() => {
        setModelInput(initialModelId);
        const prov =
          initialProvider ||
          (initialModelId.includes("/") ? initialModelId.split("/")[0] : "nvidia");
        setProviderInput(prov);
        void runInspect(initialModelId, prov);
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [initialModelId, initialProvider, runInspect]);

  const handleCopyJson = () => {
    if (!result?.simulatedCatalogEntry) return;
    void navigator.clipboard.writeText(JSON.stringify(result.simulatedCatalogEntry, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const caps = (result?.simulatedCatalogEntry?.capabilities as Record<string, unknown>) || {};
  const supportedParams = Array.isArray(result?.simulatedCatalogEntry?.supported_parameters)
    ? (result?.simulatedCatalogEntry?.supported_parameters as string[])
    : [];
  const inputModalities = Array.isArray(result?.simulatedCatalogEntry?.input_modalities)
    ? (result?.simulatedCatalogEntry?.input_modalities as string[])
    : ["text"];
  const contextLength =
    typeof result?.simulatedCatalogEntry?.context_length === "number"
      ? result.simulatedCatalogEntry.context_length
      : null;
  const maxOutput =
    typeof result?.simulatedCatalogEntry?.max_output_tokens === "number"
      ? result.simulatedCatalogEntry.max_output_tokens
      : null;

  return (
    <div className="flex flex-col gap-6">
      {/* Search & Model Selection Box */}
      <Card padding="none" className="p-5">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[20px]">
                troubleshoot
              </span>
              Live Model Metadata Inspector
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Test any model ID to preview how local JSONC patches resolve capabilities, supported
              parameters, and token limits before clients query <code>/v1/models</code>.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label="Model ID or Qualified Path"
                placeholder="e.g. nvidia/llama-3.1-nemotron-70b-instruct"
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void runInspect(modelInput, providerInput);
                  }
                }}
              />
            </div>
            <div className="w-full sm:w-48">
              <Input
                label="Provider (Optional)"
                placeholder="e.g. nvidia"
                value={providerInput}
                onChange={(e) => setProviderInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void runInspect(modelInput, providerInput);
                  }
                }}
              />
            </div>
            <Button
              variant="primary"
              icon="search"
              loading={loading}
              onClick={() => void runInspect(modelInput, providerInput)}
            >
              Inspect
            </Button>
          </div>

          {/* Quick preset chips */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50 text-xs">
            <span className="text-text-muted">Quick test:</span>
            {QUICK_TEST_MODELS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setModelInput(item.id);
                  setProviderInput(item.provider);
                  void runInspect(item.id, item.provider);
                }}
                className="px-2.5 py-1 rounded-md bg-black/5 dark:bg-white/5 hover:bg-primary/10 hover:text-primary transition-colors text-text-main text-xs font-mono"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Error state */}
      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>{error}</span>
        </div>
      )}

      {/* Results View */}
      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column: Visual Resolution & Capabilities */}
          <div className="flex flex-col gap-4">
            {/* Match Status Card */}
            <Card padding="none" className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`material-symbols-outlined text-[24px] ${
                      result.matchedRule ? "text-emerald-500" : "text-amber-500"
                    }`}
                  >
                    {result.matchedRule ? "verified" : "help"}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-main">
                        {result.matchedRule ? "Patch Rule Matched" : "No Custom Patch"}
                      </span>
                      {result.matchedRule && (
                        <Badge
                          variant={result.matchedRule.matchType === "exact" ? "success" : "info"}
                          size="sm"
                        >
                          {result.matchedRule.matchType === "exact"
                            ? "Exact Match"
                            : result.matchedRule.matchType === "leaf"
                              ? "Leaf Match"
                              : result.matchedRule.matchType === "wildcard"
                                ? "Wildcard Pattern"
                                : "Provider Default"}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5 font-mono">
                      {result.matchedRule
                        ? `Rule: ${result.matchedRule.provider} / "${result.matchedRule.modelPattern}"`
                        : "Falling back to standard heuristics and upstream defaults"}
                    </p>
                  </div>
                </div>

                {result.matchedRule && onSelectForEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="edit"
                    onClick={() => onSelectForEdit(result.matchedRule?.modelPattern || "")}
                  >
                    Edit Rule
                  </Button>
                )}
              </div>
            </Card>

            {/* Resolved Metadata Breakdown */}
            <Card padding="none" className="p-4 flex flex-col gap-4">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Effective Capabilities & Limits
              </h3>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {/* Vision */}
                <div className="p-3 rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[16px]">visibility</span>
                    <span>Vision</span>
                  </div>
                  <span
                    className={`text-sm font-semibold ${
                      caps.vision ? "text-emerald-500" : "text-text-muted"
                    }`}
                  >
                    {caps.vision ? "Supported" : "No"}
                  </span>
                </div>

                {/* Thinking / Reasoning */}
                <div className="p-3 rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[16px]">psychology</span>
                    <span>Reasoning</span>
                  </div>
                  <span
                    className={`text-sm font-semibold ${
                      caps.reasoning || caps.thinking ? "text-purple-500" : "text-text-muted"
                    }`}
                  >
                    {caps.reasoning || caps.thinking ? "Thinking Enabled" : "Standard"}
                  </span>
                </div>

                {/* Tool Calling */}
                <div className="p-3 rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[16px]">build</span>
                    <span>Tools</span>
                  </div>
                  <span
                    className={`text-sm font-semibold ${
                      caps.tool_calling ? "text-blue-500" : "text-text-muted"
                    }`}
                  >
                    {caps.tool_calling ? "Supported" : "No"}
                  </span>
                </div>

                {/* Context Window */}
                <div className="p-3 rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[16px]">format_align_left</span>
                    <span>Context Length</span>
                  </div>
                  <span className="text-sm font-semibold text-text-main font-mono">
                    {contextLength ? `${contextLength.toLocaleString()} tokens` : "Unknown"}
                  </span>
                </div>

                {/* Max Output */}
                <div className="p-3 rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[16px]">output</span>
                    <span>Max Output</span>
                  </div>
                  <span className="text-sm font-semibold text-text-main font-mono">
                    {maxOutput ? `${maxOutput.toLocaleString()} tokens` : "Default"}
                  </span>
                </div>

                {/* Modalities */}
                <div className="p-3 rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-xs text-text-muted">
                    <span className="material-symbols-outlined text-[16px]">category</span>
                    <span>Modalities</span>
                  </div>
                  <span className="text-sm font-semibold text-text-main">
                    {inputModalities.join(", ")}
                  </span>
                </div>
              </div>

              {/* Supported Parameters */}
              <div className="flex flex-col gap-2 pt-2 border-t border-border">
                <span className="text-xs font-medium text-text-muted">
                  Supported Parameters ({supportedParams.length})
                </span>
                {supportedParams.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {supportedParams.map((param) => (
                      <span
                        key={param}
                        className="px-2 py-0.5 rounded bg-black/5 dark:bg-white/5 border border-border/80 text-[11px] font-mono text-text-main"
                      >
                        {param}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-text-muted italic">
                    None declared (upstream returned bare ID)
                  </span>
                )}
              </div>
            </Card>
          </div>

          {/* Right Column: Simulated JSON Output */}
          <Card padding="none" className="overflow-hidden flex flex-col">
            <div className="p-3.5 border-b border-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-text-muted text-[18px]">
                  data_object
                </span>
                <span className="text-xs font-semibold text-text-main">
                  Simulated <code>/v1/models</code> Catalog Response
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                icon={copied ? "check" : "content_copy"}
                onClick={handleCopyJson}
              >
                {copied ? "Copied" : "Copy JSON"}
              </Button>
            </div>
            <pre className="p-4 text-xs font-mono text-text-main overflow-x-auto bg-black/5 dark:bg-black/30 flex-1 leading-relaxed">
              {JSON.stringify(result.simulatedCatalogEntry, null, 2)}
            </pre>
          </Card>
        </div>
      )}
    </div>
  );
}
