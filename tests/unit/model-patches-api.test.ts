import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";
import { resetModelPatchesCache } from "@/lib/models/modelPatches";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-patches-api-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = process.env.JWT_SECRET || "model-patches-api-jwt";

const patchFilePath = path.join(TEST_DATA_DIR, "models-patch.jsonc");
process.env.OMNIROUTE_MODEL_PATCHES_PATH = patchFilePath;

const patchesRoute = await import("../../src/app/api/models/patches/route.ts");
const inspectRoute = await import("../../src/app/api/models/patches/inspect/route.ts");
const applyRoute = await import("../../src/app/api/models/patches/apply/route.ts");
const entryRoute = await import("../../src/app/api/models/patches/entry/route.ts");

test.beforeEach(() => {
  resetModelPatchesCache();
  fs.writeFileSync(
    patchFilePath,
    `// Initial test configuration
{
  "nvidia": {
    "test-model": {
      "name": "Test Model",
      "context_length": 65536,
      "capabilities": {
        "vision": true,
        "thinking": true
      },
      "supported_parameters": ["tools", "temperature"]
    }
  }
}`
  );
});

test.after(() => {
  resetModelPatchesCache();
  delete process.env.OMNIROUTE_MODEL_PATCHES_PATH;
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

interface ApiResponse {
  exists?: boolean;
  ruleCount?: number;
  content?: string;
  entries?: Array<{ modelPattern?: string }>;
  success?: boolean;
  error?: string;
  line?: number;
  column?: number;
  formatted?: string;
  modelId?: string;
  provider?: string;
  matchedRule?: { matchType?: string };
  effectivePatch?: { context_length?: number };
  simulatedCatalogEntry?: {
    name?: string;
    context_length?: number;
    capabilities?: { vision?: boolean };
    supported_parameters?: string[];
  };
  capabilitiesCount?: number;
}

test("GET /api/models/patches returns file info and content", async () => {
  const req = await makeManagementSessionRequest("http://localhost/api/models/patches");
  const res = await patchesRoute.GET(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.exists, true);
  assert.equal(data.ruleCount, 1);
  assert.ok(data.content?.includes("test-model"));
  assert.equal(data.entries?.length, 1);
  assert.equal(data.entries?.[0]?.modelPattern, "test-model");
});

test("POST /api/models/patches saves valid JSONC and hot-reloads", async () => {
  const newContent = `// Updated configuration
{
  "nvidia": {
    "updated-model": {
      "context_length": 131072,
      "capabilities": { "vision": false }
    }
  }
}`;

  const req = await makeManagementSessionRequest("http://localhost/api/models/patches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: newContent }),
  });
  const res = await patchesRoute.POST(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.success, true);
  assert.equal(data.ruleCount, 1);

  // Verify on disk
  const onDisk = fs.readFileSync(patchFilePath, "utf-8");
  assert.ok(onDisk.includes("updated-model"));
});

test("POST /api/models/patches rejects invalid JSONC with line and column", async () => {
  const invalidContent = `{ "nvidia": { "broken": [ } }`;

  const req = await makeManagementSessionRequest("http://localhost/api/models/patches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: invalidContent }),
  });
  const res = await patchesRoute.POST(req);
  assert.equal(res.status, 400);

  const data = (await res.json()) as ApiResponse;
  assert.ok(data.error);
  assert.ok(typeof data.line === "number");
  assert.ok(typeof data.column === "number");
});

test("PUT /api/models/patches formats unformatted JSONC", async () => {
  const unformatted = `{\n"nvidia":    {\n"m": {\n"context_length":  1000\n}\n}\n}`;

  const req = await makeManagementSessionRequest("http://localhost/api/models/patches", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: unformatted }),
  });
  const res = await patchesRoute.PUT(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.success, true);
  assert.ok(data.formatted?.includes('"context_length": 1000'));
});

test("POST /api/models/patches/inspect inspects patch resolution for model", async () => {
  const req = await makeManagementSessionRequest("http://localhost/api/models/patches/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: "nvidia/test-model", provider: "nvidia" }),
  });
  const res = await inspectRoute.POST(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.modelId, "test-model");
  assert.equal(data.provider, "nvidia");
  assert.ok(data.matchedRule);
  assert.equal(data.matchedRule?.matchType, "exact");
  assert.equal(data.effectivePatch?.context_length, 65536);
  assert.equal(data.simulatedCatalogEntry?.name, "Test Model");
  assert.equal(data.simulatedCatalogEntry?.context_length, 65536);
  assert.equal(data.simulatedCatalogEntry?.capabilities?.vision, true);
  assert.ok(data.simulatedCatalogEntry?.supported_parameters?.includes("tools"));
});

test("POST /api/models/patches/apply syncs patches to SQLite", async () => {
  const req = await makeManagementSessionRequest("http://localhost/api/models/patches/apply", {
    method: "POST",
  });
  const res = await applyRoute.POST(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.success, true);
  assert.ok(typeof data.capabilitiesCount === "number");
});

test("POST /api/models/patches/entry creates and updates patch rule entry", async () => {
  const req = await makeManagementSessionRequest("http://localhost/api/models/patches/entry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "nvidia",
      modelPattern: "new-custom-model",
      patch: {
        name: "New Custom Model",
        context_length: 131072,
        capabilities: { vision: true, thinking: true },
        supported_parameters: ["tools", "temperature"],
      },
    }),
  });
  const res = await entryRoute.POST(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.success, true);

  const fileContent = fs.readFileSync(patchFilePath, "utf-8");
  assert.ok(fileContent.includes("new-custom-model"));
  assert.ok(fileContent.includes("New Custom Model"));
  assert.ok(fileContent.includes("// Initial test configuration")); // comments preserved
});

test("DELETE /api/models/patches/entry deletes patch rule entry", async () => {
  const req = await makeManagementSessionRequest("http://localhost/api/models/patches/entry", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "nvidia",
      modelPattern: "test-model",
    }),
  });
  const res = await entryRoute.DELETE(req);
  assert.equal(res.status, 200);

  const data = (await res.json()) as ApiResponse;
  assert.equal(data.success, true);

  const fileContent = fs.readFileSync(patchFilePath, "utf-8");
  assert.ok(!fileContent.includes('"test-model"'));
  assert.ok(fileContent.includes("// Initial test configuration")); // comments preserved
});
