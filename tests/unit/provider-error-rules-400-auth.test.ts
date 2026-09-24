import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rule-400-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const { setOperatorProviderErrorRules } =
  await import("../../open-sse/config/providerErrorRules.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  setOperatorProviderErrorRules(undefined);
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  setOperatorProviderErrorRules(undefined);
});

const CUSTOM_PROVIDER = "openai-compatible-chat-3c007462-eae7-44ca-a129-f721d0004827";
const ERROR_TEXT = "Requested model deepseek-r1 is not supported";

test("markAccountUnavailable with scope='provider' 400 cools down all non-terminal connections for that provider", async () => {
  await resetStorage();

  const conn1 = await providersDb.createProviderConnection({
    provider: CUSTOM_PROVIDER,
    authType: "apikey",
    apiKey: "key-1",
    isActive: true,
    testStatus: "active",
  });

  const conn2 = await providersDb.createProviderConnection({
    provider: CUSTOM_PROVIDER,
    authType: "apikey",
    apiKey: "key-2",
    isActive: true,
    testStatus: "active",
  });

  const connBanned = await providersDb.createProviderConnection({
    provider: CUSTOM_PROVIDER,
    authType: "apikey",
    apiKey: "key-banned",
    isActive: true,
    testStatus: "banned",
  });

  setOperatorProviderErrorRules({
    [CUSTOM_PROVIDER]: [
      {
        status: 400,
        match: "not supported",
        scope: "provider",
        cooldownMs: 21600000,
      },
    ],
  });

  const result = await auth.markAccountUnavailable(
    conn1.id,
    400,
    ERROR_TEXT,
    CUSTOM_PROVIDER,
    "deepseek-r1"
  );

  // Must not be swallowed by isProviderModelUnsupported400 (which returns shouldFallback: false, cooldownMs: 0)
  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 21600000);

  // Both active connections must now be cooled down (unavailable)
  const afterConn1 = await providersDb.getProviderConnectionById(conn1.id);
  assert.equal(afterConn1.testStatus, "unavailable");
  assert.ok(afterConn1.rateLimitedUntil);

  const afterConn2 = await providersDb.getProviderConnectionById(conn2.id);
  assert.equal(afterConn2.testStatus, "unavailable");
  assert.ok(afterConn2.rateLimitedUntil);

  // Terminal connection must not have been overwritten
  const afterBanned = await providersDb.getProviderConnectionById(connBanned.id);
  assert.equal(afterBanned.testStatus, "banned");
});

test("markAccountUnavailable with scope='connection' 400 cools down only the failing connection", async () => {
  await resetStorage();

  const conn1 = await providersDb.createProviderConnection({
    provider: CUSTOM_PROVIDER,
    authType: "apikey",
    apiKey: "key-1",
    isActive: true,
    testStatus: "active",
  });

  const conn2 = await providersDb.createProviderConnection({
    provider: CUSTOM_PROVIDER,
    authType: "apikey",
    apiKey: "key-2",
    isActive: true,
    testStatus: "active",
  });

  setOperatorProviderErrorRules({
    [CUSTOM_PROVIDER]: [
      {
        status: 400,
        match: "not supported",
        scope: "connection",
        cooldownMs: 3600000,
      },
    ],
  });

  const result = await auth.markAccountUnavailable(
    conn1.id,
    400,
    ERROR_TEXT,
    CUSTOM_PROVIDER,
    "deepseek-r1"
  );

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 3600000);

  const afterConn1 = await providersDb.getProviderConnectionById(conn1.id);
  assert.equal(afterConn1.testStatus, "unavailable");
  assert.ok(afterConn1.rateLimitedUntil);

  // Sibling connection stays active
  const afterConn2 = await providersDb.getProviderConnectionById(conn2.id);
  assert.equal(afterConn2.testStatus, "active");
  assert.ok(!afterConn2.rateLimitedUntil);
});

test("markAccountUnavailable with scope='model' 400 locks the model and keeps connection active", async () => {
  await resetStorage();

  const conn1 = await providersDb.createProviderConnection({
    provider: CUSTOM_PROVIDER,
    authType: "apikey",
    apiKey: "key-1",
    isActive: true,
    testStatus: "active",
  });

  setOperatorProviderErrorRules({
    [CUSTOM_PROVIDER]: [
      {
        status: 400,
        match: "not supported",
        scope: "model",
        reason: "quota_exhausted",
        cooldownMs: 1800000,
      },
    ],
  });

  const result = await auth.markAccountUnavailable(
    conn1.id,
    400,
    ERROR_TEXT,
    CUSTOM_PROVIDER,
    "deepseek-r1"
  );

  assert.equal(result.shouldFallback, true);

  // Connection stays active
  const afterConn1 = await providersDb.getProviderConnectionById(conn1.id);
  assert.equal(afterConn1.testStatus, "active");
  assert.ok(!afterConn1.rateLimitedUntil);

  // Model lockout is recorded
  const lockout = accountFallback.getModelLockoutInfo(CUSTOM_PROVIDER, conn1.id, "deepseek-r1");
  assert.ok(lockout);
  assert.equal(lockout.reason, "quota_exhausted");
});
