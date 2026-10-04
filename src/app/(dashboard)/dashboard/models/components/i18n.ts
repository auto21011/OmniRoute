import { useLocale } from "next-intl";

export interface ModelPatchesTranslations {
  // Page header & tabs
  title: string;
  catalogTitle: string;
  description: string;
  catalogDescription: string;
  tabCatalog: string;
  tabPatches: string;
  refresh: string;
  patchAction: string;
  patchActionTooltip: string;

  // View toolbar
  subtabInspector: string;
  subtabEditor: string;
  subtabRules: string;
  statusFilePath: string;
  statusRulesCount: string;
  statusLastModified: string;
  statusLiveReload: string;
  btnReload: string;
  btnSyncDb: string;
  btnSyncingDb: string;
  syncSuccess: (count: number) => string;
  syncFailed: string;
  loadFailed: (status: number) => string;
  loadingConfig: string;

  // Inspector
  inspectorTitle: string;
  inspectorDesc: string;
  testModelLabel: string;
  testModelPlaceholder: string;
  quickTestModels: string;
  btnInspect: string;
  btnInspecting: string;
  resultsTitle: string;
  matchStatus: string;
  matchedRule: string;
  matchType: string;
  matchExact: string;
  matchStripped: string;
  matchWildcard: string;
  matchProviderDefault: string;
  noMatchTitle: string;
  noMatchDesc: string;
  resolvedCapsTitle: string;
  capVision: string;
  capVisionYes: string;
  capVisionNo: string;
  capReasoning: string;
  capReasoningYes: string;
  capReasoningNo: string;
  capTools: string;
  capToolsYes: string;
  capToolsNo: string;
  contextWindow: string;
  maxOutput: string;
  supportedParams: string;
  noneSpecified: string;
  simulatedJsonTitle: string;
  tabPatchedJson: string;
  tabRawJson: string;
  btnCopyJson: string;
  btnCopied: string;

  // Editor
  editorTitle: string;
  editorBadge: string;
  editorDesc: string;
  btnFormat: string;
  btnFormatting: string;
  insertPreset: string;
  btnSave: string;
  btnSaving: string;
  syntaxValid: string;
  saveSuccess: string;
  syntaxErrorPrefix: string;
  syntaxErrorLineCol: (line: number, col: number, msg: string) => string;
  unsavedChanges: string;

  // Rules List & Upstream Coverage
  rulesTitle: string;
  rulesDesc: string;
  searchPlaceholder: string;
  filterProvider: string;
  allProviders: string;
  rulesCountUnit: (count: number) => string;
  btnInspectInTester: string;
  noMatchingRules: string;
  auditTitle: string;
  auditDesc: string;
  btnAudit: string;
  btnAuditing: string;
  nimApiKeyPlaceholder: string;
  coverageLabel: string;
  modelsCoveredUnit: (covered: number, total: number, pct: number) => string;
  unpatchedModelsTitle: string;
  btnAddPatch: string;
  allCovered: string;
}

const enTranslations: ModelPatchesTranslations = {
  title: "Model Metadata Patches",
  catalogTitle: "Model Catalog",
  description:
    "Enrich sparse upstream models with vision, thinking, context lengths, and parameters via local JSONC rules.",
  catalogDescription: "Browse model metadata and capabilities from every provider in one place.",
  tabCatalog: "Model Catalog",
  tabPatches: "Model Patches",
  refresh: "Refresh",
  patchAction: "Patch",
  patchActionTooltip: "Inspect or configure patch rules for this model",

  subtabInspector: "Inspector & Simulator",
  subtabEditor: "JSONC Editor",
  subtabRules: "Rules & Upstream Coverage",
  statusFilePath: "Path",
  statusRulesCount: "Active Rules",
  statusLastModified: "Last Modified",
  statusLiveReload: "Live Hot-Reload Active",
  btnReload: "Reload",
  btnSyncDb: "Sync to SQLite",
  btnSyncingDb: "Syncing...",
  syncSuccess: (count) => `Synced ${count} patched models to database`,
  syncFailed: "Failed to sync to database",
  loadFailed: (status) => `Failed to load patch configuration (HTTP ${status})`,
  loadingConfig: "Loading model patch configuration...",

  inspectorTitle: "Model Patch Inspector & Simulator",
  inspectorDesc:
    "Simulate how upstream models will be enriched by local JSONC patch rules and inspect resolved capabilities.",
  testModelLabel: "Test Model ID",
  testModelPlaceholder: "Enter full model ID, prefix-stripped ID, or wildcard pattern...",
  quickTestModels: "Quick Test Models",
  btnInspect: "Inspect",
  btnInspecting: "Inspecting...",
  resultsTitle: "Inspection Results",
  matchStatus: "Match Status",
  matchedRule: "Matched Rule",
  matchType: "Match Type",
  matchExact: "Exact ID",
  matchStripped: "Prefix-stripped",
  matchWildcard: "Wildcard pattern",
  matchProviderDefault: "Provider default fallback",
  noMatchTitle: "No Match",
  noMatchDesc: "No patch matched this model. Default fallback will apply.",
  resolvedCapsTitle: "Resolved Capabilities",
  capVision: "Vision / Multimodal",
  capVisionYes: "Supports Vision",
  capVisionNo: "Text Only",
  capReasoning: "Reasoning / Thinking",
  capReasoningYes: "Thinking Enabled",
  capReasoningNo: "Standard",
  capTools: "Tool / Function Calling",
  capToolsYes: "Tools Enabled",
  capToolsNo: "No Tools",
  contextWindow: "Context Window",
  maxOutput: "Max Output",
  supportedParams: "Supported Parameters",
  noneSpecified: "None specified",
  simulatedJsonTitle: "Simulated /v1/models JSON Response",
  tabPatchedJson: "Patched Catalog Entry",
  tabRawJson: "Raw Upstream Catalog Entry",
  btnCopyJson: "Copy JSON",
  btnCopied: "Copied!",

  editorTitle: "JSONC Patch Configuration Editor",
  editorBadge: "config/models-patch.jsonc",
  editorDesc:
    "Directly edit JSONC with comments. Changes are hot-reloaded automatically upon saving.",
  btnFormat: "Format",
  btnFormatting: "Formatting...",
  insertPreset: "Insert Preset Template",
  btnSave: "Save & Hot-Reload",
  btnSaving: "Saving...",
  syntaxValid: "JSONC syntax valid",
  saveSuccess: "Saved & reloaded",
  syntaxErrorPrefix: "Syntax Error",
  syntaxErrorLineCol: (line, col, msg) => `Syntax Error (line ${line}, col ${col}): ${msg}`,
  unsavedChanges: "Unsaved changes",

  rulesTitle: "Active Patch Rules Directory",
  rulesDesc: "Browse, filter, and inspect all configured patch rules.",
  searchPlaceholder: "Search pattern or model ID...",
  filterProvider: "Filter by Provider",
  allProviders: "All Providers",
  rulesCountUnit: (count) => `${count} rules`,
  btnInspectInTester: "Inspect in Tester",
  noMatchingRules: "No matching patch rules found",
  auditTitle: "NVIDIA NIM Upstream Coverage Audit",
  auditDesc: "Audit live NVIDIA NIM models against local patch rules to spot gaps.",
  btnAudit: "Audit NIM Models",
  btnAuditing: "Auditing...",
  nimApiKeyPlaceholder: "NVIDIA API Key (optional if configured in OmniRoute)",
  coverageLabel: "Coverage",
  modelsCoveredUnit: (covered, total, pct) => `${covered} / ${total} models covered (${pct}%)`,
  unpatchedModelsTitle: "Unpatched Models",
  btnAddPatch: "+ Add Patch",
  allCovered: "All upstream models are covered by patch rules!",
};

const zhTranslations: ModelPatchesTranslations = {
  title: "模型元数据补丁",
  catalogTitle: "模型目录",
  description:
    "通过本地 JSONC 规则，为上游稀疏模型补全视觉、思考推理、上下文长度和参数支持等元数据信息。",
  catalogDescription: "在一个地方集中浏览并管理所有提供商的模型元数据与能力配置。",
  tabCatalog: "模型目录",
  tabPatches: "模型补丁",
  refresh: "刷新",
  patchAction: "补丁",
  patchActionTooltip: "检查或为此模型配置补丁规则",

  subtabInspector: "补丁检查器与仿真",
  subtabEditor: "JSONC 编辑器",
  subtabRules: "规则目录与上游覆盖率",
  statusFilePath: "文件路径",
  statusRulesCount: "生效规则数",
  statusLastModified: "最近修改",
  statusLiveReload: "实时热重载已启用",
  btnReload: "刷新",
  btnSyncDb: "同步至数据库",
  btnSyncingDb: "正在同步...",
  syncSuccess: (count) => `已成功同步 ${count} 个模型补丁至 SQLite 数据库`,
  syncFailed: "同步至数据库失败",
  loadFailed: (status) => `加载补丁配置失败 (HTTP ${status})`,
  loadingConfig: "正在加载模型补丁配置...",

  inspectorTitle: "模型补丁检查与仿真模拟器",
  inspectorDesc:
    "模拟上游模型如何被本地 JSONC 补丁规则补全丰富，并实时检查解析后的最终能力标签与长度限制。",
  testModelLabel: "测试模型 ID",
  testModelPlaceholder: "输入完整模型 ID、无前缀 ID 或通配符模式...",
  quickTestModels: "快速测试模型",
  btnInspect: "检查解析",
  btnInspecting: "正在检查...",
  resultsTitle: "检查与解析结果",
  matchStatus: "匹配状态",
  matchedRule: "匹配到的规则",
  matchType: "匹配类型",
  matchExact: "精确 ID 匹配",
  matchStripped: "剥离前缀匹配",
  matchWildcard: "通配符模式匹配",
  matchProviderDefault: "提供商兜底默认规则",
  noMatchTitle: "未匹配到补丁",
  noMatchDesc: "该模型未匹配到任何补丁，将使用系统默认规则。",
  resolvedCapsTitle: "解析后的模型能力",
  capVision: "视觉 / 多模态",
  capVisionYes: "支持视觉",
  capVisionNo: "仅文本",
  capReasoning: "思考 / 推理",
  capReasoningYes: "已启用思考",
  capReasoningNo: "标准模式",
  capTools: "工具 / 函数调用",
  capToolsYes: "支持工具调用",
  capToolsNo: "不支持工具",
  contextWindow: "上下文窗口",
  maxOutput: "最大输出 Tokens",
  supportedParams: "支持的请求参数",
  noneSpecified: "未特别指定",
  simulatedJsonTitle: "模拟 /v1/models 接口返回 JSON",
  tabPatchedJson: "补丁增强后的 Catalog 条目",
  tabRawJson: "上游原始 Catalog 条目",
  btnCopyJson: "复制 JSON",
  btnCopied: "已复制！",

  editorTitle: "JSONC 模型补丁配置编辑器",
  editorBadge: "config/models-patch.jsonc",
  editorDesc:
    "直接编辑支持注释的 JSONC 配置文件，保存后将自动执行热重载，无需重启服务即可即时生效。",
  btnFormat: "格式化代码",
  btnFormatting: "正在排版...",
  insertPreset: "插入预设模板",
  btnSave: "保存并热重载",
  btnSaving: "正在保存...",
  syntaxValid: "JSONC 语法校验通过",
  saveSuccess: "已成功保存并热重载",
  syntaxErrorPrefix: "语法错误",
  syntaxErrorLineCol: (line, col, msg) => `语法错误（第 ${line} 行，第 ${col} 列）：${msg}`,
  unsavedChanges: "存在未保存的修改",

  rulesTitle: "已配置规则目录",
  rulesDesc: "浏览、按提供商筛选并快速检查当前生效的所有模型补丁规则。",
  searchPlaceholder: "搜索模式规则或模型 ID...",
  filterProvider: "按提供商筛选",
  allProviders: "全部提供商",
  rulesCountUnit: (count) => `${count} 条规则`,
  btnInspectInTester: "在检查器中测试",
  noMatchingRules: "未找到匹配的模型补丁规则",
  auditTitle: "NVIDIA NIM 上游模型覆盖度审计",
  auditDesc: "对比本地补丁规则与 NVIDIA NIM 线上模型列表，排查未覆盖模型。",
  btnAudit: "审计 NIM 模型",
  btnAuditing: "正在审计...",
  nimApiKeyPlaceholder: "NVIDIA API Key（可选，留空则使用 OmniRoute 已配置的凭据）",
  coverageLabel: "覆盖率",
  modelsCoveredUnit: (covered, total, pct) => `已覆盖 ${covered} / ${total} 个模型（${pct}%）`,
  unpatchedModelsTitle: "尚未覆盖的模型",
  btnAddPatch: "+ 添加补丁",
  allCovered: "所有上游模型均已被补丁规则覆盖！",
};

export function useModelPatchesI18n(): ModelPatchesTranslations {
  let locale = "en";
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    locale = useLocale();
  } catch {
    locale = "en";
  }
  const isZh = locale.startsWith("zh");
  return isZh ? zhTranslations : enTranslations;
}

export function isChineseLocale(): boolean {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const locale = useLocale();
    return locale.startsWith("zh");
  } catch {
    return false;
  }
}
