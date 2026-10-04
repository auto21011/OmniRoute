/**
 * src/lib/models/modelPatches.ts
 *
 * Local JSONC-driven model metadata patch engine.
 *
 * Enriches sparse/incomplete upstream model metadata (e.g. NVIDIA NIM / vLLM / self-hosted
 * OpenAI-compatible upstreams that only return bare model IDs) with rich capabilities
 * (vision, thinking/reasoning, tool calling, structured outputs), supported_parameters,
 * token limits (context length, max output tokens), modalities, and human-friendly names.
 *
 * Configuration is read from a local JSONC file (`config/models-patch.jsonc` by default,
 * overridable via OMNIROUTE_MODEL_PATCHES_PATH or MODEL_PATCHES_FILE).
 * In-memory cache checks file mtime for zero-restart live hot-reloading.
 */

import fs from "node:fs";
import path from "node:path";
import {
  parse as parseJsonc,
  format as formatJsonc,
  applyEdits,
  modify as modifyJsonc,
  type ParseError,
  printParseErrorCode,
} from "jsonc-parser";
import type { SyncedAvailableModel } from "@/lib/db/models/synced";

export type PatchMatchType = "exact" | "leaf" | "wildcard" | "provider_default" | "global";

export interface MatchedPatchDetail {
  provider: string;
  modelPattern: string;
  matchType: PatchMatchType;
  patch: ModelPatch;
}

export interface ModelCapabilityPatch {
  vision?: boolean;
  reasoning?: boolean;
  thinking?: boolean;
  supportsThinking?: boolean;
  tool_calling?: boolean;
  supportsTools?: boolean;
  structured_output?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  effort_tiers?: string[];
  streaming?: boolean;
  audio?: boolean;
  video?: boolean;
  [key: string]: unknown;
}

export interface ModelPatch {
  provider?: string;
  model?: string;
  model_id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  type?: string;
  subtype?: string;
  context_length?: number;
  inputTokenLimit?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  outputTokenLimit?: number;
  supported_parameters?: string[];
  supported_endpoints?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: ModelCapabilityPatch;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  [key: string]: unknown;
}

export interface ModelPatchesConfig {
  patches: Record<string, Record<string, ModelPatch>>;
  raw?: unknown;
}

export interface ModelPatchEntry {
  provider: string;
  modelPattern: string;
  patch: ModelPatch;
}

// ─── File Resolution & Hot-Reload Cache ───────────────────

let cachedConfig: ModelPatchesConfig | null = null;
let cachedFilePath: string | null = null;
let cachedMtimeMs: number = -1;

export const DEFAULT_MODEL_PATCHES_FILENAME = "config/models-patch.jsonc";
export const LOCAL_MODEL_PATCHES_FILENAME = "config/models-patch.local.jsonc";

/**
 * Resolve the active JSONC model patches file path.
 */
export function getModelPatchesFilePath(): string {
  const envPath =
    process.env.OMNIROUTE_MODEL_PATCHES_PATH ||
    process.env.MODEL_PATCHES_PATH ||
    process.env.MODEL_PATCHES_FILE;
  if (envPath && envPath.trim()) {
    return path.resolve(process.cwd(), envPath.trim());
  }

  const localPath = path.resolve(process.cwd(), LOCAL_MODEL_PATCHES_FILENAME);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  return path.resolve(process.cwd(), DEFAULT_MODEL_PATCHES_FILENAME);
}

/**
 * Reset memory cache (useful in tests).
 */
export function resetModelPatchesCache(): void {
  cachedConfig = null;
  cachedFilePath = null;
  cachedMtimeMs = -1;
}

/**
 * Normalizes varied JSONC input structures into a standardized map:
 * Record<provider, Record<modelPattern, ModelPatch>>
 */
export function normalizePatchesData(raw: unknown): Record<string, Record<string, ModelPatch>> {
  const result: Record<string, Record<string, ModelPatch>> = {};

  if (!raw || typeof raw !== "object") {
    return result;
  }

  const registerPatch = (rawProvider: string, rawModel: string, patch: ModelPatch) => {
    const provider = String(rawProvider || "")
      .trim()
      .toLowerCase();
    const model = String(rawModel || "").trim();
    if (!provider || !model) return;

    if (!result[provider]) {
      result[provider] = {};
    }
    result[provider][model] = {
      ...patch,
      provider,
      model,
    };
  };

  // Case 1: Array of patch objects: [ { provider, model, ... }, ... ]
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const patch = item as ModelPatch;
        const provider = patch.provider || "*";
        const model = patch.model || patch.model_id || "*";
        registerPatch(provider, model, patch);
      }
    }
    return result;
  }

  const obj = raw as Record<string, unknown>;

  // Case 2: Object with "models" array: { models: [ { provider, model, ... } ] }
  if (Array.isArray(obj.models)) {
    for (const item of obj.models) {
      if (item && typeof item === "object") {
        const patch = item as ModelPatch;
        const provider = patch.provider || "*";
        const model = patch.model || patch.model_id || "*";
        registerPatch(provider, model, patch);
      }
    }
  }

  // Case 3: Object with "patches": { patches: { [provider]: { [model]: patch } } }
  const sourcePatches =
    obj.patches && typeof obj.patches === "object" && !Array.isArray(obj.patches)
      ? (obj.patches as Record<string, unknown>)
      : obj;

  for (const [providerKey, modelsMap] of Object.entries(sourcePatches)) {
    if (providerKey === "models" || providerKey === "$schema" || providerKey === "description") {
      continue;
    }
    if (modelsMap && typeof modelsMap === "object" && !Array.isArray(modelsMap)) {
      for (const [modelKey, patchData] of Object.entries(modelsMap as Record<string, unknown>)) {
        if (patchData && typeof patchData === "object" && !Array.isArray(patchData)) {
          registerPatch(providerKey, modelKey, patchData as ModelPatch);
        }
      }
    }
  }

  return result;
}

/**
 * Load model patches from the given or default JSONC file.
 * Returns cached configuration if file has not changed on disk.
 */
export function loadModelPatches(customPath?: string): ModelPatchesConfig {
  const targetPath = customPath
    ? path.resolve(process.cwd(), customPath)
    : getModelPatchesFilePath();

  try {
    if (!fs.existsSync(targetPath)) {
      return { patches: {} };
    }

    const stat = fs.statSync(targetPath);
    if (cachedConfig && cachedFilePath === targetPath && cachedMtimeMs === stat.mtimeMs) {
      return cachedConfig;
    }

    const content = fs.readFileSync(targetPath, "utf-8");
    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });

    if (errors.length > 0) {
      const formattedErrors = errors
        .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
        .join(", ");
      console.warn(`[ModelPatches] JSONC parse errors in ${targetPath}: ${formattedErrors}`);
    }

    const normalized = normalizePatchesData(parsed);
    const config: ModelPatchesConfig = {
      patches: normalized,
      raw: parsed,
    };

    cachedConfig = config;
    cachedFilePath = targetPath;
    cachedMtimeMs = stat.mtimeMs;

    return config;
  } catch (err) {
    console.warn(
      `[ModelPatches] Failed to read ${targetPath}:`,
      err instanceof Error ? err.message : err
    );
    return { patches: {} };
  }
}

// ─── Pattern Matching ─────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function matchesPattern(pattern: string, text: string): boolean {
  if (pattern === "*") return true;
  if (pattern === text) return true;
  if (!pattern.includes("*")) {
    return pattern.toLowerCase() === text.toLowerCase();
  }
  const regexStr = "^" + pattern.split("*").map(escapeRegExp).join(".*") + "$";
  const regex = new RegExp(regexStr, "i");
  return regex.test(text);
}

function leafModelId(modelId: string | null | undefined): string | null {
  if (!modelId || !modelId.includes("/")) return null;
  const leaf = modelId.split("/").filter(Boolean).pop() ?? null;
  return leaf && leaf !== modelId ? leaf : null;
}

/**
 * Deep merge two patches. `specific` takes precedence over `base`.
 */
export function mergeModelPatches(base: ModelPatch, specific: ModelPatch): ModelPatch {
  const merged: ModelPatch = { ...base, ...specific };

  // Merge capabilities
  if (base.capabilities || specific.capabilities) {
    merged.capabilities = {
      ...(base.capabilities || {}),
      ...(specific.capabilities || {}),
    };
  }

  // Merge supported parameters (union of unique items)
  if (base.supported_parameters || specific.supported_parameters) {
    const params = new Set([
      ...(base.supported_parameters || []),
      ...(specific.supported_parameters || []),
    ]);
    merged.supported_parameters = Array.from(params);
  }

  // Merge input modalities
  if (specific.input_modalities) {
    merged.input_modalities = [...specific.input_modalities];
  } else if (base.input_modalities) {
    merged.input_modalities = [...base.input_modalities];
  }

  // Merge output modalities
  if (specific.output_modalities) {
    merged.output_modalities = [...specific.output_modalities];
  } else if (base.output_modalities) {
    merged.output_modalities = [...base.output_modalities];
  }

  return merged;
}

/**
 * Find the most specific model patch matching provider and modelId with match metadata.
 */
export function findModelPatchDetail(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  config?: ModelPatchesConfig
): MatchedPatchDetail | null {
  const activeConfig = config || loadModelPatches();
  const patches = activeConfig.patches;
  if (!patches || Object.keys(patches).length === 0) return null;

  const rawProvider = String(provider || "")
    .trim()
    .toLowerCase();
  const rawModel = String(modelId || "").trim();
  if (!rawModel && !rawProvider) return null;

  // Potential provider keys in patch map
  const providerCandidates = [rawProvider, "*"].filter(Boolean);

  let wildcardDetail: MatchedPatchDetail | null = null;
  let exactDetail: MatchedPatchDetail | null = null;

  for (const provKey of providerCandidates) {
    const providerMap = patches[provKey];
    if (!providerMap) continue;

    // Check for provider-level wildcard "*"
    if (providerMap["*"]) {
      wildcardDetail = {
        provider: provKey,
        modelPattern: "*",
        matchType: provKey === "*" ? "global" : "provider_default",
        patch: wildcardDetail
          ? mergeModelPatches(wildcardDetail.patch, providerMap["*"])
          : providerMap["*"],
      };
    }

    if (!rawModel) continue;

    const strippedModel =
      rawProvider && rawModel.toLowerCase().startsWith(`${rawProvider}/`)
        ? rawModel.slice(rawProvider.length + 1)
        : rawModel;
    const leaf = leafModelId(rawModel);

    // 1. Exact model match
    for (const [pattern, patch] of Object.entries(providerMap)) {
      if (pattern === "*") continue;
      if (pattern === rawModel || pattern === strippedModel) {
        exactDetail = {
          provider: provKey,
          modelPattern: pattern,
          matchType: "exact",
          patch: exactDetail ? mergeModelPatches(exactDetail.patch, patch) : patch,
        };
        break;
      }
    }

    // 2. Leaf match
    if (!exactDetail && leaf) {
      for (const [pattern, patch] of Object.entries(providerMap)) {
        if (pattern === "*") continue;
        if (pattern === leaf) {
          exactDetail = {
            provider: provKey,
            modelPattern: pattern,
            matchType: "leaf",
            patch,
          };
          break;
        }
      }
    }

    // 3. Glob / wildcard pattern match
    if (!exactDetail) {
      for (const [pattern, patch] of Object.entries(providerMap)) {
        if (pattern === "*") continue;
        if (
          matchesPattern(pattern, rawModel) ||
          matchesPattern(pattern, strippedModel) ||
          (leaf && matchesPattern(pattern, leaf))
        ) {
          exactDetail = {
            provider: provKey,
            modelPattern: pattern,
            matchType: "wildcard",
            patch,
          };
          break;
        }
      }
    }

    if (exactDetail && provKey !== "*") {
      break;
    }
  }

  if (wildcardDetail && exactDetail) {
    return {
      ...exactDetail,
      patch: mergeModelPatches(wildcardDetail.patch, exactDetail.patch),
    };
  }

  return exactDetail || wildcardDetail || null;
}

/**
 * Find the most specific model patch matching provider and modelId.
 */
export function findModelPatch(
  provider: string | null | undefined,
  modelId: string | null | undefined,
  config?: ModelPatchesConfig
): ModelPatch | null {
  const detail = findModelPatchDetail(provider, modelId, config);
  return detail ? detail.patch : null;
}

// ─── Catalog Entry Patch Application ──────────────────────

/**
 * Apply model patch to a model entry object from the catalog.
 */
export function applyModelPatchToCatalogEntry(
  entry: Record<string, unknown>,
  providerOverride?: string | null,
  modelOverride?: string | null,
  config?: ModelPatchesConfig
): Record<string, unknown> {
  if (!entry || typeof entry !== "object") return entry;

  const entryId = typeof entry.id === "string" ? entry.id : "";
  const entryOwnedBy = typeof entry.owned_by === "string" ? entry.owned_by : "";
  const entryRoot = typeof entry.root === "string" ? entry.root : "";
  const entryProvider = typeof entry.provider === "string" ? entry.provider : "";

  const resolvedProvider =
    providerOverride ||
    entryOwnedBy ||
    entryProvider ||
    (entryId.includes("/") ? entryId.split("/")[0] : null);

  const resolvedModel =
    modelOverride ||
    entryRoot ||
    (entryId.includes("/") ? entryId.split("/").slice(1).join("/") : entryId);

  const patch = findModelPatch(resolvedProvider, resolvedModel, config);
  if (!patch) return entry;

  // Clone entry to avoid mutating caller reference directly
  const patched: Record<string, unknown> = { ...entry };

  // 1. Capabilities
  const existingCaps = (
    patched.capabilities && typeof patched.capabilities === "object"
      ? (patched.capabilities as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  const nextCaps: Record<string, unknown> = { ...existingCaps };

  if (patch.capabilities && typeof patch.capabilities === "object") {
    for (const [k, v] of Object.entries(patch.capabilities)) {
      if (v !== undefined) {
        nextCaps[k] = v;
      }
    }
  }

  // Handle direct boolean shortcuts
  if (patch.supportsVision !== undefined) {
    nextCaps.vision = patch.supportsVision;
  }
  if (patch.supportsThinking !== undefined) {
    nextCaps.thinking = patch.supportsThinking;
    nextCaps.supportsThinking = patch.supportsThinking;
    nextCaps.reasoning = patch.supportsThinking;
  }
  if (patch.supportsTools !== undefined) {
    nextCaps.tool_calling = patch.supportsTools;
    nextCaps.supportsTools = patch.supportsTools;
  }

  // Keep reasoning & thinking synchronized
  if (patch.capabilities?.thinking !== undefined) {
    nextCaps.thinking = patch.capabilities.thinking;
    nextCaps.supportsThinking = patch.capabilities.thinking;
    if (patch.capabilities.reasoning === undefined) {
      nextCaps.reasoning = patch.capabilities.thinking;
    }
  }
  if (patch.capabilities?.supportsThinking !== undefined) {
    nextCaps.thinking = patch.capabilities.supportsThinking;
    nextCaps.supportsThinking = patch.capabilities.supportsThinking;
    if (patch.capabilities.reasoning === undefined) {
      nextCaps.reasoning = patch.capabilities.supportsThinking;
    }
  }
  if (patch.capabilities?.tool_calling !== undefined) {
    nextCaps.tool_calling = patch.capabilities.tool_calling;
    nextCaps.supportsTools = patch.capabilities.tool_calling;
  }

  if (Object.keys(nextCaps).length > 0) {
    patched.capabilities = nextCaps;
  }

  // 2. Supported parameters
  if (Array.isArray(patch.supported_parameters) && patch.supported_parameters.length > 0) {
    const existingParams = Array.isArray(patched.supported_parameters)
      ? (patched.supported_parameters as string[])
      : [];
    patched.supported_parameters = Array.from(
      new Set([...existingParams, ...patch.supported_parameters])
    );
  }

  // 3. Context length & limits
  const contextLength = patch.context_length ?? patch.contextWindow ?? patch.inputTokenLimit;
  if (typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0) {
    patched.context_length = contextLength;
  }

  const maxOutputTokens = patch.max_output_tokens ?? patch.outputTokenLimit;
  if (
    typeof maxOutputTokens === "number" &&
    Number.isFinite(maxOutputTokens) &&
    maxOutputTokens > 0
  ) {
    patched.max_output_tokens = maxOutputTokens;
  }

  // 4. Modalities
  if (Array.isArray(patch.input_modalities) && patch.input_modalities.length > 0) {
    patched.input_modalities = [...patch.input_modalities];
  } else if (nextCaps.vision === true) {
    const currentInputs = Array.isArray(patched.input_modalities)
      ? (patched.input_modalities as string[])
      : ["text"];
    if (!currentInputs.includes("image")) {
      patched.input_modalities = [...currentInputs, "image"];
    }
  }

  if (Array.isArray(patch.output_modalities) && patch.output_modalities.length > 0) {
    patched.output_modalities = [...patch.output_modalities];
  }

  // 5. Name, description, type
  const displayName = patch.name || patch.displayName;
  if (typeof displayName === "string" && displayName.trim()) {
    patched.name = displayName.trim();
  }
  if (typeof patch.description === "string" && patch.description.trim()) {
    patched.description = patch.description.trim();
  }
  if (typeof patch.type === "string" && patch.type.trim()) {
    patched.type = patch.type.trim();
  }
  if (Array.isArray(patch.supported_endpoints) && patch.supported_endpoints.length > 0) {
    patched.supported_endpoints = [...patch.supported_endpoints];
  }

  return patched;
}

// ─── Database Synchronization ─────────────────────────────

/**
 * List all flat patch entries for batch inspection or database syncing.
 */
export function getAllPatchEntries(config?: ModelPatchesConfig): ModelPatchEntry[] {
  const activeConfig = config || loadModelPatches();
  const entries: ModelPatchEntry[] = [];

  for (const [provider, modelMap] of Object.entries(activeConfig.patches)) {
    for (const [modelPattern, patch] of Object.entries(modelMap)) {
      entries.push({
        provider,
        modelPattern,
        patch,
      });
    }
  }

  return entries;
}

/**
 * Sync the JSONC model patches into OmniRoute's SQLite database
 * (`model_capabilities` and `syncedAvailableModels`).
 */
export async function syncPatchesToDatabase(config?: ModelPatchesConfig): Promise<{
  capabilitiesCount: number;
  syncedAvailableModelsUpdated: number;
}> {
  const activeConfig = config || loadModelPatches();
  const entries = getAllPatchEntries(activeConfig);
  if (entries.length === 0) {
    return { capabilitiesCount: 0, syncedAvailableModelsUpdated: 0 };
  }

  // Dynamically import DB modules to avoid eager initialization when only parsing
  const { upsertSyncedCapabilities } = await import("@/lib/modelsDevSync");
  const { getDbInstance } = await import("@/lib/db/core");
  const { invalidateDbCache } = await import("@/lib/db/readCache");
  const { getKeyValue } = await import("@/lib/db/models/shared");
  const { normalizeSyncedAvailableModels } = await import("@/lib/db/models/synced");
  const { persistCanonicalSyncedAvailableModels } =
    await import("@/lib/db/models/syncedAvailableModelPersistence");

  let capabilitiesCount = 0;
  let syncedAvailableModelsUpdated = 0;

  // 1. Group patches by provider for `model_capabilities` upsert
  const byProvider: Record<string, Record<string, any>> = {};

  for (const { provider, modelPattern, patch } of entries) {
    if (modelPattern.includes("*")) continue; // Skip wildcards for exact DB rows

    if (!byProvider[provider]) {
      byProvider[provider] = {};
    }

    const caps = patch.capabilities || {};
    const inputModalities = patch.input_modalities || (caps.vision ? ["text", "image"] : ["text"]);
    const outputModalities = patch.output_modalities || ["text"];

    const isVision =
      caps.vision === true || patch.supportsVision === true || inputModalities.includes("image");
    const isThinking =
      caps.thinking === true ||
      caps.supportsThinking === true ||
      caps.reasoning === true ||
      patch.supportsThinking === true;
    const isTools = caps.tool_calling === true || patch.supportsTools === true;

    byProvider[provider][modelPattern] = {
      tool_call: isTools ? true : caps.tool_calling === false ? false : null,
      reasoning: isThinking ? true : caps.reasoning === false ? false : null,
      attachment: isVision ? true : caps.attachment === false ? false : null,
      structured_output:
        caps.structured_output !== undefined ? Boolean(caps.structured_output) : null,
      temperature: caps.temperature !== undefined ? Boolean(caps.temperature) : null,
      limit_context: patch.context_length ?? patch.contextWindow ?? patch.inputTokenLimit ?? null,
      limit_input: patch.inputTokenLimit ?? patch.context_length ?? null,
      limit_output: patch.max_output_tokens ?? patch.outputTokenLimit ?? null,
      modalities_input: JSON.stringify(inputModalities),
      modalities_output: JSON.stringify(outputModalities),
      status: "active",
      family: patch.type || null,
      open_weights: null,
      interleaved_field: null,
      knowledge_cutoff: null,
      release_date: null,
      last_updated: new Date().toISOString(),
    };
  }

  for (const [provider, modelCaps] of Object.entries(byProvider)) {
    upsertSyncedCapabilities(provider, modelCaps);
    capabilitiesCount += Object.keys(modelCaps).length;
  }

  // 2. Patch existing `syncedAvailableModels` in SQLite key_value table
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels'")
    .all();

  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || !value) continue;

    try {
      const providerId = key.split(":")[0];
      const parsed = JSON.parse(value);
      const models = normalizeSyncedAvailableModels(parsed, providerId);
      let changed = false;

      const updatedModels = models.map((m: SyncedAvailableModel) => {
        const patch = findModelPatch(providerId, m.id, activeConfig);
        if (!patch) return m;

        changed = true;
        const caps = patch.capabilities || {};
        const isVision =
          caps.vision === true ||
          patch.supportsVision === true ||
          (patch.input_modalities?.includes("image") ?? false);
        const isThinking =
          caps.thinking === true ||
          caps.supportsThinking === true ||
          caps.reasoning === true ||
          patch.supportsThinking === true;
        const isTools = caps.tool_calling === true || patch.supportsTools === true;

        return {
          ...m,
          name: patch.name || patch.displayName || m.name,
          ...(isVision ? { supportsVision: true } : {}),
          ...(isThinking ? { supportsThinking: true } : {}),
          ...(isTools ? { supportsTools: true } : {}),
          ...(patch.context_length
            ? { contextWindow: patch.context_length, inputTokenLimit: patch.context_length }
            : {}),
          ...(patch.max_output_tokens ? { outputTokenLimit: patch.max_output_tokens } : {}),
          ...(Array.isArray(caps.effort_tiers)
            ? { supportedThinkingEfforts: caps.effort_tiers }
            : {}),
          ...(patch.description ? { description: patch.description } : {}),
        };
      });

      if (changed) {
        persistCanonicalSyncedAvailableModels(key, updatedModels, normalizeSyncedAvailableModels);
        syncedAvailableModelsUpdated++;
      }
    } catch {
      // Ignore parse errors on malformed legacy keys
    }
  }

  invalidateDbCache("model-capabilities");

  return {
    capabilitiesCount,
    syncedAvailableModelsUpdated,
  };
}

// ─── Web API & Management Helpers ─────────────────────────

export interface ModelPatchesFileInfo {
  filePath: string;
  exists: boolean;
  mtime: string | null;
  size: number;
  content: string;
  ruleCount: number;
  entries: ModelPatchEntry[];
}

export interface SaveModelPatchesResult {
  ok: boolean;
  error?: string;
  line?: number;
  column?: number;
  ruleCount?: number;
  mtime?: string;
}

export interface ModelInspectResult {
  modelId: string;
  qualifiedId: string;
  provider: string;
  matchedRule: MatchedPatchDetail | null;
  effectivePatch: ModelPatch | null;
  simulatedCatalogEntry: Record<string, unknown>;
  resolvedCapabilities: Record<string, unknown>;
}

/**
 * Read the current patch file info, content, and active rules.
 */
export function getModelPatchesFileInfo(customPath?: string): ModelPatchesFileInfo {
  const filePath = customPath ? path.resolve(process.cwd(), customPath) : getModelPatchesFilePath();
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      mtime: null,
      size: 0,
      content: "",
      ruleCount: 0,
      entries: [],
    };
  }

  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, "utf-8");
  const config = loadModelPatches(filePath);
  const entries = getAllPatchEntries(config);

  return {
    filePath,
    exists: true,
    mtime: stat.mtime.toISOString(),
    size: stat.size,
    content,
    ruleCount: entries.length,
    entries,
  };
}

function getLineAndColumn(text: string, offset: number): { line: number; column: number } {
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  const lines = text.slice(0, clampedOffset).split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

/**
 * Validate and save raw JSONC content to disk, then trigger hot-reload.
 */
export function saveModelPatchesContent(
  content: string,
  customPath?: string
): SaveModelPatchesResult {
  const filePath = customPath ? path.resolve(process.cwd(), customPath) : getModelPatchesFilePath();
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const firstErr = errors[0];
    const loc = getLineAndColumn(content, firstErr.offset);
    return {
      ok: false,
      error: `JSONC parse error: ${printParseErrorCode(firstErr.error)} at line ${loc.line}, column ${loc.column}`,
      line: loc.line,
      column: loc.column,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      error: "Invalid JSONC: Root must be an object or array",
    };
  }

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, "utf-8");
  resetModelPatchesCache();

  const stat = fs.statSync(filePath);
  const newConfig = loadModelPatches(filePath);
  const entries = getAllPatchEntries(newConfig);

  return {
    ok: true,
    ruleCount: entries.length,
    mtime: stat.mtime.toISOString(),
  };
}

/**
 * Formats JSONC content using jsonc-parser.
 */
export function formatModelPatchesContent(content: string): string {
  const edits = formatJsonc(content, undefined, { insertSpaces: true, tabSize: 2 });
  return applyEdits(content, edits);
}

/**
 * Upsert (create or update) a single patch entry in the JSONC file while preserving comments.
 */
export function upsertModelPatchEntry(
  provider: string,
  modelPattern: string,
  patch: ModelPatch,
  options?: {
    oldProvider?: string;
    oldModelPattern?: string;
    customPath?: string;
  }
): SaveModelPatchesResult {
  const filePath = options?.customPath
    ? path.resolve(process.cwd(), options.customPath)
    : getModelPatchesFilePath();

  let content = '{\n  "patches": {}\n}\n';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf-8");
  }

  const parsed = parseJsonc(content);
  const hasPatchesKey = Boolean(
    parsed &&
    typeof parsed === "object" &&
    "patches" in parsed &&
    parsed.patches &&
    typeof parsed.patches === "object" &&
    !Array.isArray(parsed.patches)
  );

  // If old pattern needs to be renamed/moved
  if (
    options?.oldModelPattern &&
    options?.oldProvider &&
    (options.oldModelPattern !== modelPattern || options.oldProvider !== provider)
  ) {
    const oldPath = hasPatchesKey
      ? ["patches", options.oldProvider, options.oldModelPattern]
      : [options.oldProvider, options.oldModelPattern];

    const oldParent = hasPatchesKey
      ? (parsed.patches as Record<string, unknown>)?.[options.oldProvider]
      : (parsed as Record<string, unknown>)?.[options.oldProvider];

    if (oldParent && typeof oldParent === "object" && options.oldModelPattern in oldParent) {
      const removeEdits = modifyJsonc(content, oldPath, undefined, {});
      content = applyEdits(content, removeEdits);
    }
  }

  // Clean patch fields: remove empty or undefined fields
  const cleanPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null && v !== "") {
      cleanPatch[k] = v;
    }
  }

  // Determine path for new patch
  const targetPath = hasPatchesKey ? ["patches", provider, modelPattern] : [provider, modelPattern];

  // Upsert the new patch rule
  const edits = modifyJsonc(content, targetPath, cleanPatch, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  content = applyEdits(content, edits);

  // Format cleanly
  const formatted = formatModelPatchesContent(content);

  // Save to file and reload cache
  return saveModelPatchesContent(formatted, filePath);
}

/**
 * Delete a single patch entry in the JSONC file while preserving comments.
 */
export function deleteModelPatchEntry(
  provider: string,
  modelPattern: string,
  customPath?: string
): SaveModelPatchesResult {
  const filePath = customPath ? path.resolve(process.cwd(), customPath) : getModelPatchesFilePath();

  if (!fs.existsSync(filePath)) {
    return { ok: true, ruleCount: 0 };
  }

  let content = fs.readFileSync(filePath, "utf-8");
  const parsed = parseJsonc(content);
  if (!parsed || typeof parsed !== "object") {
    return { ok: true, ruleCount: 0 };
  }

  const hasPatchesKey = Boolean(
    "patches" in parsed &&
    parsed.patches &&
    typeof parsed.patches === "object" &&
    !Array.isArray(parsed.patches)
  );

  const targetPath = hasPatchesKey ? ["patches", provider, modelPattern] : [provider, modelPattern];

  // Check if target actually exists before trying to modify
  const parentObj = hasPatchesKey
    ? (parsed.patches as Record<string, unknown>)?.[provider]
    : (parsed as Record<string, unknown>)?.[provider];

  if (!parentObj || typeof parentObj !== "object" || !(modelPattern in parentObj)) {
    const fileInfo = getModelPatchesFileInfo(filePath);
    return { ok: true, ruleCount: fileInfo.ruleCount, mtime: fileInfo.mtime ?? undefined };
  }

  const edits = modifyJsonc(content, targetPath, undefined, {});
  content = applyEdits(content, edits);

  const formatted = formatModelPatchesContent(content);
  return saveModelPatchesContent(formatted, filePath);
}

/**
 * Inspect how a model ID and provider will be patched and resolved.
 */
export async function inspectModelPatch(
  provider: string | undefined,
  modelId: string,
  config?: ModelPatchesConfig
): Promise<ModelInspectResult> {
  const activeConfig = config || loadModelPatches();
  const prov = provider || (modelId.includes("/") ? modelId.split("/")[0] : "nvidia");
  const mod =
    modelId.includes("/") && modelId.startsWith(`${prov}/`)
      ? modelId.slice(prov.length + 1)
      : modelId;

  const matchDetail = findModelPatchDetail(prov, mod, activeConfig);
  const effectivePatch = findModelPatch(prov, mod, activeConfig);

  const sampleEntry = {
    id: `${prov}/${mod}`,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: prov,
    root: mod,
  };
  const simulatedCatalogEntry = applyModelPatchToCatalogEntry(sampleEntry, prov, mod, activeConfig);

  const { getResolvedModelCapabilities } = await import("@/lib/modelCapabilities");
  const resolvedCapabilities = getResolvedModelCapabilities({ provider: prov, model: mod });

  return {
    modelId: mod,
    qualifiedId: `${prov}/${mod}`,
    provider: prov,
    matchedRule: matchDetail,
    effectivePatch,
    simulatedCatalogEntry,
    resolvedCapabilities: resolvedCapabilities as unknown as Record<string, unknown>,
  };
}

/**
 * Check upstream NVIDIA NIM models against local patch coverage.
 */
export async function checkUpstreamNimCoverage(apiKeyArg?: string): Promise<{
  totalUpstreamModels: number;
  coveredCount: number;
  coveragePercentage: number;
  coveredModels: Array<{ id: string; patchRule?: string }>;
  missingModels: string[];
}> {
  let apiKey = apiKeyArg || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;

  if (!apiKey) {
    try {
      const { getProviderConnections } = await import("@/lib/db/providers");
      const connections = await getProviderConnections();
      const nimConn = connections.find(
        (c: Record<string, unknown>) =>
          (c.providerId === "nvidia" || c.provider === "nvidia") &&
          typeof c.apiKey === "string" &&
          c.apiKey &&
          c.testStatus !== "banned"
      );
      if (nimConn && typeof nimConn.apiKey === "string") {
        apiKey = nimConn.apiKey;
      }
    } catch {
      // ignore
    }
  }

  if (!apiKey) {
    throw new Error(
      "NVIDIA API Key not provided and no active NVIDIA connection found in OmniRoute."
    );
  }

  const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!res.ok) {
    throw new Error(`NVIDIA Upstream returned HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as { data?: Array<{ id: string }> };
  const upstreamModels = (data.data || []).map((m) => m.id);

  const config = loadModelPatches();
  const coveredModels: Array<{ id: string; patchRule?: string }> = [];
  const missingModels: string[] = [];

  for (const id of upstreamModels) {
    const match = findModelPatchDetail("nvidia", id, config);
    if (match) {
      coveredModels.push({ id, patchRule: match.modelPattern });
    } else {
      missingModels.push(id);
    }
  }

  const coveredCount = coveredModels.length;
  const total = upstreamModels.length;
  const coveragePercentage = total > 0 ? Math.round((coveredCount / total) * 100) : 0;

  return {
    totalUpstreamModels: total,
    coveredCount,
    coveragePercentage,
    coveredModels,
    missingModels,
  };
}
