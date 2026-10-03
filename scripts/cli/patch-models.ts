#!/usr/bin/env node
/**
 * scripts/cli/patch-models.ts
 *
 * Local CLI utility to inspect, validate, test, and apply model metadata patches
 * from `config/models-patch.jsonc` to OmniRoute.
 *
 * Usage:
 *   npx tsx scripts/cli/patch-models.ts [command] [options]
 *   npm run patch:models [command]
 *
 * Commands:
 *   status | validate          Validate JSONC and print configured model patches (default)
 *   apply | sync               Apply patches to OmniRoute SQLite database (model_capabilities & syncedAvailableModels)
 *   inspect <model> [provider] Preview how a model entry will be patched
 *   check-upstream [apiKey]    Check upstream NVIDIA NIM models against local patch coverage
 *
 * Options:
 *   --file <path>              Path to custom JSONC file (default: config/models-patch.jsonc)
 *   --json                     Output status as JSON
 */

import fs from "node:fs";
import path from "node:path";
import {
  getModelPatchesFilePath,
  loadModelPatches,
  findModelPatch,
  applyModelPatchToCatalogEntry,
  getAllPatchEntries,
  syncPatchesToDatabase,
} from "../../src/lib/models/modelPatches.js";

// ANSI colors for clean CLI output
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

async function runStatus(filePath: string, asJson: boolean) {
  if (!fs.existsSync(filePath)) {
    console.error(`${RED}Error: Patch file not found at ${filePath}${RESET}`);
    console.error(`Create one at config/models-patch.jsonc to configure model metadata.`);
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  const config = loadModelPatches(filePath);
  const entries = getAllPatchEntries(config);

  if (asJson) {
    console.log(JSON.stringify(config.patches, null, 2));
    return;
  }

  console.log(`\n${BOLD}${CYAN}=== OmniRoute Model Metadata Patches ===${RESET}`);
  console.log(`${DIM}Config File:${RESET} ${filePath}`);
  console.log(`${DIM}File Size:${RESET}   ${stat.size} bytes`);
  console.log(`${DIM}Modified:${RESET}    ${stat.mtime.toLocaleString()}`);
  console.log(`${DIM}Total Rules:${RESET} ${entries.length}\n`);

  if (entries.length === 0) {
    console.log(`${YELLOW}No model patches configured in ${filePath}${RESET}`);
    return;
  }

  const byProvider: Record<string, typeof entries> = {};
  for (const entry of entries) {
    if (!byProvider[entry.provider]) byProvider[entry.provider] = [];
    byProvider[entry.provider].push(entry);
  }

  for (const [provider, items] of Object.entries(byProvider)) {
    console.log(`${BOLD}${GREEN}[Provider: ${provider}]${RESET} (${items.length} patch rules)`);
    for (const item of items) {
      const p = item.patch;
      const caps = p.capabilities || {};
      const capBadges: string[] = [];
      if (caps.vision || p.supportsVision) capBadges.push(`${GREEN}vision${RESET}`);
      if (caps.reasoning || caps.thinking || p.supportsThinking)
        capBadges.push(`${CYAN}thinking${RESET}`);
      if (caps.tool_calling || p.supportsTools) capBadges.push(`${YELLOW}tools${RESET}`);
      if (caps.structured_output) capBadges.push(`structured_output`);

      const ctx = p.context_length ?? p.contextWindow ?? p.inputTokenLimit;
      const maxOut = p.max_output_tokens ?? p.outputTokenLimit;
      const limits = [ctx ? `ctx:${ctx}` : null, maxOut ? `out:${maxOut}` : null]
        .filter(Boolean)
        .join(" ");

      const paramsCount = p.supported_parameters
        ? `${p.supported_parameters.length} params`
        : "default params";
      const name = p.name ? ` (${p.name})` : "";

      console.log(`  • ${BOLD}${item.modelPattern}${RESET}${name}`);
      console.log(`    ${DIM}Caps:${RESET}   ${capBadges.length ? capBadges.join(", ") : "none"}`);
      if (limits) console.log(`    ${DIM}Limits:${RESET} ${limits}`);
      if (p.supported_parameters) {
        console.log(`    ${DIM}Params:${RESET} ${p.supported_parameters.join(", ")}`);
      }
    }
    console.log("");
  }
}

async function runApply(filePath: string) {
  console.log(`\n${BOLD}${CYAN}=== Applying Model Patches to OmniRoute Database ===${RESET}`);
  console.log(`${DIM}Reading patches from:${RESET} ${filePath}`);

  const config = loadModelPatches(filePath);
  const result = await syncPatchesToDatabase(config);

  console.log(`\n${GREEN}✔ Successfully applied model patches to database!${RESET}`);
  console.log(`  • Model capabilities written:    ${BOLD}${result.capabilitiesCount}${RESET}`);
  console.log(
    `  • Connection catalogs updated:   ${BOLD}${result.syncedAvailableModelsUpdated}${RESET}`
  );
  console.log(
    `\n${DIM}OmniRoute /v1/models will immediately return the updated metadata.${RESET}\n`
  );
}

async function runInspect(modelId: string, provider: string | undefined, filePath: string) {
  const config = loadModelPatches(filePath);
  const prov = provider || (modelId.includes("/") ? modelId.split("/")[0] : "nvidia");
  const mod =
    modelId.includes("/") && modelId.startsWith(`${prov}/`)
      ? modelId.slice(prov.length + 1)
      : modelId;

  console.log(`\n${BOLD}${CYAN}=== Inspecting Model Patch ===${RESET}`);
  console.log(`${DIM}Provider:${RESET} ${prov}`);
  console.log(`${DIM}Model:${RESET}    ${mod}`);

  const patch = findModelPatch(prov, mod, config);
  if (!patch) {
    console.log(`\n${YELLOW}No patch rule matched for provider '${prov}', model '${mod}'.${RESET}`);
    console.log(`Add a rule to ${filePath} to customize this model.`);
    return;
  }

  console.log(`\n${GREEN}Matched Patch:${RESET}`);
  console.log(JSON.stringify(patch, null, 2));

  // Simulate catalog entry
  const dummyEntry = {
    id: `${prov}/${mod}`,
    object: "model",
    created: 1733443200,
    owned_by: prov,
    root: mod,
  };

  const enriched = applyModelPatchToCatalogEntry(dummyEntry, prov, mod, config);
  console.log(`\n${BOLD}Resulting /v1/models JSON Output:${RESET}`);
  console.log(JSON.stringify(enriched, null, 2));
  console.log("");
}

async function runCheckUpstream(apiKeyArg?: string) {
  const apiKey = apiKeyArg || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    console.error(`${RED}Error: NVIDIA API Key required.${RESET}`);
    console.log(`Usage: npx tsx scripts/cli/patch-models.ts check-upstream <apiKey>`);
    console.log(`Or set the NVIDIA_API_KEY environment variable.`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}=== Checking Live NVIDIA NIM Models vs Local Patches ===${RESET}`);
  console.log(`${DIM}Fetching models from https://integrate.api.nvidia.com/v1/models...${RESET}`);

  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
    });

    if (!res.ok) {
      console.error(`${RED}Upstream returned HTTP ${res.status}: ${res.statusText}${RESET}`);
      process.exit(1);
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const upstreamModels = (data.data || []).map((m) => m.id);
    console.log(`Found ${BOLD}${upstreamModels.length}${RESET} live models on NVIDIA NIM.\n`);

    const config = loadModelPatches();
    let coveredCount = 0;
    const missing: string[] = [];

    for (const id of upstreamModels) {
      const patch = findModelPatch("nvidia", id, config);
      if (patch && (patch.context_length || patch.capabilities || patch.supported_parameters)) {
        coveredCount++;
      } else {
        missing.push(id);
      }
    }

    const pct = Math.round((coveredCount / (upstreamModels.length || 1)) * 100);
    console.log(
      `Coverage: ${BOLD}${pct}%${RESET} (${coveredCount}/${upstreamModels.length} models have custom patches)`
    );

    if (missing.length > 0) {
      console.log(
        `\n${YELLOW}Upstream models using default/fallback metadata (${missing.length}):${RESET}`
      );
      for (const m of missing.slice(0, 20)) {
        console.log(`  - ${m}`);
      }
      if (missing.length > 20) {
        console.log(`  ... and ${missing.length - 20} more`);
      }
    }
  } catch (err) {
    console.error(
      `${RED}Failed to fetch NVIDIA models:${RESET}`,
      err instanceof Error ? err.message : err
    );
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const customFile = typeof flags.file === "string" ? flags.file : undefined;
  const targetFile = customFile
    ? path.resolve(process.cwd(), customFile)
    : getModelPatchesFilePath();

  const command = positional[0] || "status";

  switch (command.toLowerCase()) {
    case "status":
    case "validate":
    case "list":
      await runStatus(targetFile, Boolean(flags.json));
      break;

    case "apply":
    case "sync":
    case "sync-db":
      await runApply(targetFile);
      break;

    case "inspect": {
      const model = positional[1];
      if (!model) {
        console.error(`${RED}Error: model ID required for inspect.${RESET}`);
        console.log(
          `Example: npx tsx scripts/cli/patch-models.ts inspect meta/llama-3.3-70b-instruct nvidia`
        );
        process.exit(1);
      }
      const provider = positional[2];
      await runInspect(model, provider, targetFile);
      break;
    }

    case "check-upstream":
    case "nim":
      await runCheckUpstream(positional[1]);
      break;

    case "help":
    case "--help":
    case "-h":
      console.log(`
${BOLD}OmniRoute Model Patches CLI${RESET}

Commands:
  ${GREEN}status | validate${RESET}         Validate and display all configured model patches (default)
  ${GREEN}apply | sync${RESET}              Sync patches into OmniRoute SQLite database
  ${GREEN}inspect <model> [prov]${RESET}    Preview how a model is enriched
  ${GREEN}check-upstream [apiKey]${RESET}   Check live NVIDIA NIM models against local patches

Options:
  --file <path>   Use custom JSONC file (default: config/models-patch.jsonc)
  --json          Output in JSON format
`);
      break;

    default:
      console.error(`${RED}Unknown command: ${command}${RESET}`);
      console.log(`Run 'npm run patch:models help' for available commands.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
