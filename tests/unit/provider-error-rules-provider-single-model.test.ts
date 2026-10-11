// Characterization of the `provider_single_model` lock scope: an operator rule
// declaring it locks ONE model across EVERY account under the provider (all
// connections) without touching the provider's other models. Covers the rule
// match, the in-request combo skip set, and the skip predicate.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getProviderErrorRuleMatch,
  setOperatorProviderErrorRules,
  type OperatorProviderErrorRule,
} from "../../open-sse/config/providerErrorRules.ts";
import {
  applyComboTargetExhaustion,
  type ComboExhaustionSets,
} from "../../open-sse/services/combo/targetExhaustion.ts";
import { getExhaustedTargetSkipReason } from "../../open-sse/services/combo/comboPredicates.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const PROVIDER = "acme-single-model";

function emptySets(): ComboExhaustionSets {
  return {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
    exhaustedProviderModels: new Set<string>(),
  };
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    kind: "model",
    executionKey: "ek",
    modelStr: `${PROVIDER}/m1`,
    provider: PROVIDER,
    providerId: null,
    connectionId: "conn-1",
    ...overrides,
  } as Parameters<typeof applyComboTargetExhaustion>[0];
}

const baseOpts = {
  errorText: "upstream quota exhausted",
  rawModel: "m1",
  isTokenLimitBreach: false,
  allAccountsRateLimited: false,
  requestScopedFailure: false,
  log,
  tag: "COMBO",
  exhaustedLogLevel: "info" as const,
};

describe("provider_single_model lock scope", () => {
  beforeEach(() => {
    setOperatorProviderErrorRules(undefined);
  });

  it("operator rule can declare scope provider_single_model", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      [PROVIDER]: [{ status: 429, match: "quota exhausted", scope: "provider_single_model" }],
    };
    const m = getProviderErrorRuleMatch(PROVIDER, 429, null, "upstream quota exhausted", op);
    assert.ok(m, "operator rule should match");
    assert.equal(m.scope, "provider_single_model");
  });

  it("combo target exhaustion marks provider:model, not the whole provider", () => {
    setOperatorProviderErrorRules({
      [PROVIDER]: [{ status: 429, match: "quota exhausted", scope: "provider_single_model" }],
    });
    const s = emptySets();
    const { providerExhausted } = applyComboTargetExhaustion(target(), {
      ...baseOpts,
      result: { status: 429 },
      fallbackResult: { ruleScope: "provider_single_model", reason: "quota_exhausted" },
      sets: s,
    });
    assert.equal(providerExhausted, true);
    assert.ok(s.exhaustedProviderModels?.has(`${PROVIDER}:m1`));
    assert.equal(s.exhaustedProviders.size, 0);
    assert.equal(s.exhaustedConnections.size, 0);
  });

  it("skip predicate skips the same provider:model but not a sibling model", () => {
    const providerModels = new Set([`${PROVIDER}:m1`]);
    const same = getExhaustedTargetSkipReason(
      target({ modelStr: `${PROVIDER}/m1` }),
      new Set(),
      new Set(),
      providerModels
    );
    assert.ok(same && same.includes("provider_single_model"));
    const sibling = getExhaustedTargetSkipReason(
      target({ modelStr: `${PROVIDER}/m2` }),
      new Set(),
      new Set(),
      providerModels
    );
    assert.equal(sibling, null);
  });

  it("does not add to provider:model set when the scope is not honored", () => {
    // No operator rule declared → honorsRuleLockScope() is false for this
    // provider, so the provider_single_model branch must not fire.
    const s = emptySets();
    applyComboTargetExhaustion(target(), {
      ...baseOpts,
      result: { status: 429 },
      fallbackResult: { ruleScope: "provider_single_model", reason: "quota_exhausted" },
      sets: s,
    });
    assert.equal(s.exhaustedProviderModels?.size ?? 0, 0);
  });
});
