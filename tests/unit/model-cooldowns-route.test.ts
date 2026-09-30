import test from "node:test";
import assert from "node:assert/strict";
import {
  getAvailabilityReport,
  clearModelUnavailability,
  clearConnectionModelUnavailability,
  clearConnectionAllModelUnavailability,
  lockModelAvailability,
  resetAllAvailability,
} from "../../src/domain/modelAvailability.ts";
import { lockModel, clearModelLock } from "@omniroute/open-sse/services/accountFallback";

const TEST_CONN = "test-conn-001";

function seed(provider: string, model: string, cooldownMs = 60_000) {
  lockModel(provider, TEST_CONN, model, "quota_exhausted", cooldownMs, {});
}

function cleanup(provider: string, model: string) {
  clearModelLock(provider, TEST_CONN, model);
}

test("getAvailabilityReport: returns empty array when no lockouts", () => {
  const report = getAvailabilityReport();
  const forProvider = report.filter((e) => e.provider === "test-empty-provider");
  assert.equal(forProvider.length, 0);
});

test("getAvailabilityReport: returns active lockout with positive remainingMs", () => {
  seed("test-prov", "test-model");
  try {
    const report = getAvailabilityReport();
    const entry = report.find((e) => e.provider === "test-prov" && e.model === "test-model");
    assert.ok(entry, "lockout should appear in report");
    assert.ok(entry.remainingMs > 0, "remainingMs should be positive");
  } finally {
    cleanup("test-prov", "test-model");
  }
});

test("clearModelUnavailability: removes matching lockout and returns true", () => {
  seed("prov-clear", "model-clear");
  const removed = clearModelUnavailability("prov-clear", "model-clear");
  assert.equal(removed, true);
  const report = getAvailabilityReport();
  const stillThere = report.find((e) => e.provider === "prov-clear" && e.model === "model-clear");
  assert.equal(stillThere, undefined);
});

test("clearModelUnavailability: returns false when no matching lockout", () => {
  const removed = clearModelUnavailability("nonexistent-prov", "nonexistent-model");
  assert.equal(removed, false);
});

test("clearConnectionModelUnavailability: removes only specific connection lockout", () => {
  lockModel("prov-conn-test", "conn-1", "model-test", "manual_disable", 60_000);
  lockModel("prov-conn-test", "conn-2", "model-test", "manual_disable", 60_000);

  const removed1 = clearConnectionModelUnavailability("prov-conn-test", "conn-1", "model-test");
  assert.equal(removed1, true);

  const report = getAvailabilityReport();
  const conn1Entry = report.find(
    (e) => e.provider === "prov-conn-test" && e.connectionId === "conn-1"
  );
  const conn2Entry = report.find(
    (e) => e.provider === "prov-conn-test" && e.connectionId === "conn-2"
  );
  assert.equal(conn1Entry, undefined);
  assert.ok(conn2Entry, "conn-2 lockout should still exist");

  clearConnectionModelUnavailability("prov-conn-test", "conn-2", "model-test");
});

test("clearConnectionAllModelUnavailability: removes all lockouts for specific connection", () => {
  lockModel("prov-all-test", "conn-all", "model-1", "manual_disable", 60_000);
  lockModel("prov-all-test", "conn-all", "model-2", "manual_disable", 60_000);
  lockModel("prov-all-test", "conn-other", "model-1", "manual_disable", 60_000);

  const clearedCount = clearConnectionAllModelUnavailability("prov-all-test", "conn-all");
  assert.equal(clearedCount, 2);

  const report = getAvailabilityReport();
  const connAllEntries = report.filter(
    (e) => e.provider === "prov-all-test" && e.connectionId === "conn-all"
  );
  const connOtherEntries = report.filter(
    (e) => e.provider === "prov-all-test" && e.connectionId === "conn-other"
  );
  assert.equal(connAllEntries.length, 0);
  assert.equal(connOtherEntries.length, 1);

  clearModelUnavailability("prov-all-test", "model-1");
});

test("lockModelAvailability: locks for specific connection when specified", async () => {
  const res = await lockModelAvailability({
    provider: "test-lock-prov",
    model: "test-lock-model",
    durationMs: 30_000,
    connectionId: "conn-spec-1",
    reason: "manual_disable",
  });
  assert.equal(res.lockedCount, 1);

  const report = getAvailabilityReport();
  const entry = report.find(
    (e) =>
      e.provider === "test-lock-prov" &&
      e.model === "test-lock-model" &&
      e.connectionId === "conn-spec-1"
  );
  assert.ok(entry, "should find locked entry");
  assert.equal(entry.reason, "manual_disable");
  assert.ok(entry.remainingMs > 0);

  clearConnectionModelUnavailability("test-lock-prov", "conn-spec-1", "test-lock-model");
});

test("lockModelAvailability: locks with provider scope", async () => {
  const res = await lockModelAvailability({
    provider: "test-lock-provider-scope",
    model: "test-model-p",
    durationMs: 45_000,
    scope: "provider",
    reason: "quality_degraded",
  });
  assert.ok(res.lockedCount >= 1);

  const report = getAvailabilityReport();
  const entry = report.find(
    (e) => e.provider === "test-lock-provider-scope" && e.model === "test-model-p"
  );
  assert.ok(entry, "should find locked entry");
  assert.equal(entry.reason, "quality_degraded");

  clearModelUnavailability("test-lock-provider-scope", "test-model-p");
});

test("resetAllAvailability: clears all seeded lockouts", () => {
  seed("reset-prov-a", "reset-model-a");
  seed("reset-prov-b", "reset-model-b");
  resetAllAvailability();
  const report = getAvailabilityReport();
  const a = report.find((e) => e.provider === "reset-prov-a");
  const b = report.find((e) => e.provider === "reset-prov-b");
  assert.equal(a, undefined);
  assert.equal(b, undefined);
});
