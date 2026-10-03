import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  normalizePatchesData,
  findModelPatch,
  findModelPatchDetail,
  applyModelPatchToCatalogEntry,
  loadModelPatches,
  resetModelPatchesCache,
  mergeModelPatches,
  getModelPatchesFileInfo,
  saveModelPatchesContent,
  formatModelPatchesContent,
  inspectModelPatch,
  type ModelPatchesConfig,
} from "@/lib/models/modelPatches";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";

describe("modelPatches engine", () => {
  let tmpDir: string;
  let tmpPatchFile: string;

  beforeEach(() => {
    resetModelPatchesCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-patches-test-"));
    tmpPatchFile = path.join(tmpDir, "models-patch.jsonc");
  });

  afterEach(() => {
    resetModelPatchesCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("parses valid JSONC with comments and trailing commas", () => {
    const jsoncContent = `
    {
      // Top level comment
      "patches": {
        /* Provider comment */
        "nvidia": {
          "meta/llama-3.3-70b-instruct": {
            "name": "Llama 3.3 70B Instruct",
            "context_length": 131072,
            "max_output_tokens": 4096,
            "supported_parameters": [
              "temperature",
              "top_p",
              "tools", // trailing comma
            ],
            "capabilities": {
              "vision": false,
              "tool_calling": true,
              "structured_output": true,
            },
          },
        },
      },
    }
    `;
    fs.writeFileSync(tmpPatchFile, jsoncContent, "utf-8");

    const config = loadModelPatches(tmpPatchFile);
    assert.ok(config.patches.nvidia);
    const patch = config.patches.nvidia["meta/llama-3.3-70b-instruct"];
    assert.ok(patch);
    assert.equal(patch.name, "Llama 3.3 70B Instruct");
    assert.equal(patch.context_length, 131072);
    assert.equal(patch.max_output_tokens, 4096);
    assert.deepEqual(patch.supported_parameters, ["temperature", "top_p", "tools"]);
    assert.equal(patch.capabilities?.vision, false);
    assert.equal(patch.capabilities?.tool_calling, true);
    assert.equal(patch.capabilities?.structured_output, true);
  });

  it("handles missing file gracefully by returning empty patches", () => {
    const config = loadModelPatches(path.join(tmpDir, "does-not-exist.jsonc"));
    assert.deepEqual(config.patches, {});
  });

  it("normalizes array of models format", () => {
    const rawArray = [
      {
        provider: "nvidia",
        model: "deepseek-ai/deepseek-r1",
        name: "DeepSeek R1",
        context_length: 131072,
        capabilities: {
          thinking: true,
          reasoning: true,
        },
      },
    ];

    const normalized = normalizePatchesData(rawArray);
    assert.ok(normalized.nvidia);
    assert.ok(normalized.nvidia["deepseek-ai/deepseek-r1"]);
    assert.equal(normalized.nvidia["deepseek-ai/deepseek-r1"].name, "DeepSeek R1");
    assert.equal(normalized.nvidia["deepseek-ai/deepseek-r1"].capabilities?.thinking, true);
  });

  it("matches model by exact id, prefix-stripped id, and leaf id", () => {
    const config: ModelPatchesConfig = {
      patches: {
        nvidia: {
          "meta/llama-3.3-70b-instruct": {
            name: "Llama 3.3 70B Instruct",
            context_length: 131072,
            capabilities: {
              tool_calling: true,
            },
          },
          "phi-3-vision-128k-instruct": {
            name: "Phi-3 Vision",
            capabilities: {
              vision: true,
            },
          },
        },
      },
    };

    // Exact model match
    const exact = findModelPatch("nvidia", "meta/llama-3.3-70b-instruct", config);
    assert.ok(exact);
    assert.equal(exact.name, "Llama 3.3 70B Instruct");

    // Provider prefix in model ID (nvidia/meta/llama-3.3-70b-instruct)
    const withPrefix = findModelPatch("nvidia", "nvidia/meta/llama-3.3-70b-instruct", config);
    assert.ok(withPrefix);
    assert.equal(withPrefix.name, "Llama 3.3 70B Instruct");

    // Leaf match (phi-3-vision-128k-instruct vs microsoft/phi-3-vision-128k-instruct)
    const leaf = findModelPatch("nvidia", "microsoft/phi-3-vision-128k-instruct", config);
    assert.ok(leaf);
    assert.equal(leaf.name, "Phi-3 Vision");
    assert.equal(leaf.capabilities?.vision, true);
  });

  it("supports wildcard patterns and provider default '*'", () => {
    const config: ModelPatchesConfig = {
      patches: {
        nvidia: {
          "*": {
            supported_parameters: ["temperature", "top_p", "stream"],
          },
          "*-vision*": {
            capabilities: {
              vision: true,
            },
          },
          "meta/llama-3.3-70b-instruct": {
            name: "Llama 3.3",
            supported_parameters: ["tools"],
          },
        },
      },
    };

    // Matches wildcard pattern *-vision*
    const visionModel = findModelPatch("nvidia", "meta/llama-3.2-11b-vision-instruct", config);
    assert.ok(visionModel);
    assert.equal(visionModel.capabilities?.vision, true);
    // Inherits provider wildcard default params
    assert.ok(visionModel.supported_parameters?.includes("temperature"));

    // Specific model merges with provider wildcard
    const specific = findModelPatch("nvidia", "meta/llama-3.3-70b-instruct", config);
    assert.ok(specific);
    assert.equal(specific.name, "Llama 3.3");
    // Contains union of parameters
    assert.ok(specific.supported_parameters?.includes("tools"));
    assert.ok(specific.supported_parameters?.includes("temperature"));
  });

  it("applies patch to catalog entry and sets capabilities, parameters, and limits", () => {
    const config: ModelPatchesConfig = {
      patches: {
        nvidia: {
          "meta/llama-3.3-70b-instruct": {
            name: "Llama 3.3 70B Instruct",
            context_length: 131072,
            max_output_tokens: 4096,
            supported_parameters: [
              "temperature",
              "top_p",
              "max_tokens",
              "stream",
              "tools",
              "tool_choice",
            ],
            capabilities: {
              vision: false,
              reasoning: false,
              tool_calling: true,
              structured_output: true,
            },
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
      },
    };

    const sparseCatalogEntry = {
      id: "nvidia/meta/llama-3.3-70b-instruct",
      object: "model",
      created: 1733443200,
      owned_by: "nvidia",
      root: "meta/llama-3.3-70b-instruct",
    };

    const enriched = applyModelPatchToCatalogEntry(
      sparseCatalogEntry,
      undefined,
      undefined,
      config
    );

    assert.equal(enriched.name, "Llama 3.3 70B Instruct");
    assert.equal(enriched.context_length, 131072);
    assert.equal(enriched.max_output_tokens, 4096);
    assert.deepEqual(enriched.input_modalities, ["text"]);
    assert.deepEqual(enriched.output_modalities, ["text"]);

    const caps = enriched.capabilities as Record<string, unknown>;
    assert.ok(caps);
    assert.equal(caps.vision, false);
    assert.equal(caps.reasoning, false);
    assert.equal(caps.tool_calling, true);
    assert.equal(caps.structured_output, true);

    const params = enriched.supported_parameters as string[];
    assert.ok(Array.isArray(params));
    assert.ok(params.includes("tools"));
    assert.ok(params.includes("temperature"));
  });

  it("automatically adds image modality when vision is patched true", () => {
    const config: ModelPatchesConfig = {
      patches: {
        nvidia: {
          "microsoft/phi-3-vision-128k-instruct": {
            capabilities: {
              vision: true,
            },
          },
        },
      },
    };

    const entry = {
      id: "nvidia/microsoft/phi-3-vision-128k-instruct",
      owned_by: "nvidia",
      input_modalities: ["text"],
    };

    const enriched = applyModelPatchToCatalogEntry(entry, undefined, undefined, config);
    const caps = enriched.capabilities as Record<string, unknown>;
    assert.equal(caps.vision, true);

    const modalities = enriched.input_modalities as string[];
    assert.ok(modalities.includes("text"));
    assert.ok(modalities.includes("image"));
  });

  it("enriches getResolvedModelCapabilities with vision and thinking", () => {
    // Write temporary config file and point environment variable to it
    const jsoncContent = JSON.stringify({
      patches: {
        nvidia: {
          "test-vendor/test-vision-model": {
            context_length: 65536,
            max_output_tokens: 8192,
            capabilities: {
              vision: true,
              thinking: false,
              tool_calling: true,
            },
          },
          "test-vendor/test-thinking-model": {
            context_length: 131072,
            max_output_tokens: 16384,
            capabilities: {
              thinking: true,
              vision: false,
              tool_calling: false,
            },
          },
        },
      },
    });

    fs.writeFileSync(tmpPatchFile, jsoncContent, "utf-8");
    process.env.OMNIROUTE_MODEL_PATCHES_PATH = tmpPatchFile;
    resetModelPatchesCache();

    try {
      const resolvedVision = getResolvedModelCapabilities({
        provider: "nvidia",
        model: "test-vendor/test-vision-model",
      });

      assert.equal(resolvedVision.supportsVision, true);
      assert.equal(resolvedVision.attachment, true);
      assert.equal(resolvedVision.supportsThinking, false);
      assert.equal(resolvedVision.toolCalling, true);
      assert.equal(resolvedVision.contextWindow, 65536);
      assert.equal(resolvedVision.maxOutputTokens, 8192);

      const resolvedThinking = getResolvedModelCapabilities({
        provider: "nvidia",
        model: "test-vendor/test-thinking-model",
      });

      assert.equal(resolvedThinking.supportsThinking, true);
      assert.equal(resolvedThinking.reasoning, true);
      assert.equal(resolvedThinking.supportsVision, false);
      assert.equal(resolvedThinking.contextWindow, 131072);
      assert.equal(resolvedThinking.maxOutputTokens, 16384);
    } finally {
      delete process.env.OMNIROUTE_MODEL_PATCHES_PATH;
      resetModelPatchesCache();
    }
  });

  it("merges base and specific patches combining parameters and overriding limits", () => {
    const base = {
      supported_parameters: ["stream", "temperature"],
      context_length: 32768,
      capabilities: { tool_calling: false, vision: false },
    };
    const specific = {
      supported_parameters: ["temperature", "tools"],
      context_length: 131072,
      capabilities: { tool_calling: true },
    };

    const merged = mergeModelPatches(base, specific);
    assert.equal(merged.context_length, 131072);
    assert.deepEqual(merged.capabilities, { tool_calling: true, vision: false });
    assert.ok(merged.supported_parameters?.includes("stream"));
    assert.ok(merged.supported_parameters?.includes("temperature"));
    assert.ok(merged.supported_parameters?.includes("tools"));
  });

  it("findModelPatchDetail accurately returns matchType and matched pattern", () => {
    const config: ModelPatchesConfig = {
      patches: {
        nvidia: {
          "meta/llama-3.3-70b-instruct": {
            context_length: 131072,
          },
          "phi-3-vision*": {
            capabilities: { vision: true },
          },
          "*": {
            supported_parameters: ["stream", "temperature"],
          },
        },
      },
    };

    const exactMatch = findModelPatchDetail("nvidia", "meta/llama-3.3-70b-instruct", config);
    assert.ok(exactMatch);
    assert.equal(exactMatch.matchType, "exact");
    assert.equal(exactMatch.modelPattern, "meta/llama-3.3-70b-instruct");
    assert.equal(exactMatch.patch.context_length, 131072);

    const wildcardMatch = findModelPatchDetail("nvidia", "microsoft/phi-3-vision-128k", config);
    assert.ok(wildcardMatch);
    assert.equal(wildcardMatch.matchType, "wildcard");
    assert.equal(wildcardMatch.patch.capabilities?.vision, true);

    const defaultMatch = findModelPatchDetail("nvidia", "some-unknown-model", config);
    assert.ok(defaultMatch);
    assert.equal(defaultMatch.matchType, "provider_default");
    assert.deepEqual(defaultMatch.patch.supported_parameters, ["stream", "temperature"]);
  });

  it("saveModelPatchesContent validates syntax, writes file and reloads cache", () => {
    const validJsonc = `// Test patch config
{
  "nvidia": {
    "test-model": {
      "context_length": 65536,
      "capabilities": { "vision": true }
    }
  }
}`;
    const result = saveModelPatchesContent(validJsonc, tmpPatchFile);
    assert.equal(result.ok, true);
    assert.equal(result.ruleCount, 1);

    const fileInfo = getModelPatchesFileInfo(tmpPatchFile);
    assert.equal(fileInfo.exists, true);
    assert.equal(fileInfo.ruleCount, 1);
    assert.ok(fileInfo.content.includes("test-model"));

    // Test syntax error rejection
    const invalidJsonc = `{ "nvidia": { "broken": [ } }`;
    const invalidResult = saveModelPatchesContent(invalidJsonc, tmpPatchFile);
    assert.equal(invalidResult.ok, false);
    assert.ok(invalidResult.error);
    assert.ok(typeof invalidResult.line === "number");
  });

  it("formatModelPatchesContent formats JSONC code preserving comments", () => {
    const unformatted = `{\n// comment\n"foo":     "bar",\n}`;
    const formatted = formatModelPatchesContent(unformatted);
    assert.ok(formatted.includes("// comment"));
    assert.ok(formatted.includes('"foo": "bar"'));
  });

  it("inspectModelPatch resolves patch, simulated catalog entry and capabilities", async () => {
    const config: ModelPatchesConfig = {
      patches: {
        nvidia: {
          "meta/llama-3.3-70b-instruct": {
            name: "Llama 3.3 70B Instruct",
            context_length: 131072,
            capabilities: {
              vision: false,
              thinking: true,
              tool_calling: true,
            },
            supported_parameters: ["tools", "temperature"],
          },
        },
      },
    };

    const inspected = await inspectModelPatch("nvidia", "meta/llama-3.3-70b-instruct", config);

    assert.equal(inspected.modelId, "meta/llama-3.3-70b-instruct");
    assert.equal(inspected.provider, "nvidia");
    assert.ok(inspected.matchedRule);
    assert.equal(inspected.matchedRule.matchType, "exact");
    assert.equal(inspected.effectivePatch?.context_length, 131072);
    assert.equal(inspected.simulatedCatalogEntry.name, "Llama 3.3 70B Instruct");
    assert.equal(inspected.simulatedCatalogEntry.context_length, 131072);
  });
});
