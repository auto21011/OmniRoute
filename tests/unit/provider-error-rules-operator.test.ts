import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getProviderErrorRuleMatch,
  setOperatorProviderErrorRules,
  resolveRuleMatchBody,
  honorsRuleLockScope,
  type OperatorProviderErrorRule,
} from "../../open-sse/config/providerErrorRules.ts";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import {
  applyComboTargetExhaustion,
  type ComboExhaustionSets,
} from "../../open-sse/services/combo/targetExhaustion.ts";

describe("operator error rules", () => {
  beforeEach(() => {
    // Isolate each test from the settings-backed cache.
    setOperatorProviderErrorRules(undefined);
  });

  it("operator rule overrides the catalog registry for a provider", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      nvidia: [{ status: 404, match: "Not found for account", scope: "model", cooldownMs: 1000 }],
    };
    const m = getProviderErrorRuleMatch("nvidia", 404, null, "Not found for account id 123", op);
    assert.ok(m, "operator rule should match");
    assert.equal(m.scope, "model");
    assert.equal(m.cooldownMs, 1000);
  });

  it("operator rule wins even when a catalog rule would also match", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      openrouter: [{ status: 402, match: "credits exhausted", scope: "model" }],
    };
    const m = getProviderErrorRuleMatch("openrouter", 402, null, "credits exhausted on key", op);
    assert.ok(m);
    // Catalog rule for openrouter/402 uses scope "connection"; the operator
    // override must take precedence.
    assert.equal(m.scope, "model");
  });

  it("operator can reclassify a 401 before the global permanent rule", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      acme: [
        { status: 401, match: "transient quota", scope: "connection", reason: "quota_exhausted" },
      ],
    };
    const m = getProviderErrorRuleMatch("acme", 401, null, "transient quota — retry shortly", op);
    assert.ok(m);
    assert.equal(m.scope, "connection");
    assert.equal(m.reason, "quota_exhausted");
  });

  it("unknown provider with no operator rule returns null (no throw)", () => {
    const m = getProviderErrorRuleMatch("unknown-provider", 402, null, "anything");
    assert.equal(m, null);
  });

  it("substring match is case-insensitive", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      nvidia: [{ status: 404, match: "NOT FOUND", scope: "model" }],
    };
    const m = getProviderErrorRuleMatch("nvidia", 404, null, "Body says Not Found Here", op);
    assert.ok(m);
    assert.equal(m.scope, "model");
  });

  it("status must match before the substring is considered", () => {
    const op: Record<string, OperatorProviderErrorRule[]> = {
      nvidia: [{ status: 404, match: "not found", scope: "model" }],
    };
    // 500 with the same body text must NOT match a 404 rule.
    const m = getProviderErrorRuleMatch("nvidia", 500, null, "not found for account", op);
    assert.equal(m, null);
  });

  it("without an operator override the catalog registry is intact", () => {
    const m = getProviderErrorRuleMatch("openrouter", 402, null, "credits exhausted on key");
    assert.ok(m);
    assert.equal(m.scope, "connection");
    assert.equal(m.cooldownMs, 2 * 60 * 1000);
  });

  it("reads the settings-backed cache via setOperatorProviderErrorRules", () => {
    setOperatorProviderErrorRules({
      nvidia: [{ status: 404, match: "Not found", scope: "model" }],
    });
    const m = getProviderErrorRuleMatch("nvidia", 404, null, "Not found for account");
    assert.ok(m);
    assert.equal(m.scope, "model");
    // Provider key lookup is case-insensitive.
    const m2 = getProviderErrorRuleMatch("NVIDIA", 404, null, "Not found here");
    assert.ok(m2);
    assert.equal(m2.scope, "model");
  });

  // Regression coverage for #11104's original gap: an operator rule for any
  // provider outside the built-in FULL_TEXT_RULE_PROVIDERS/
  // HONORS_RULE_LOCK_SCOPE_PROVIDERS allowlists was silently text-blind (only
  // {code,type} reached the matcher) and had its declared scope dropped by the
  // persistence layer. Declaring an operator rule for a provider must be
  // sufficient by itself — no separate allowlist entry required.
  describe("operator rule bypasses the built-in allowlists", () => {
    it("resolveRuleMatchBody hands the full error text once an operator rule exists for the provider", () => {
      setOperatorProviderErrorRules({
        acme: [{ status: 404, match: "model withdrawn", scope: "model" }],
      });
      const body = resolveRuleMatchBody("acme", { code: "not_found" }, "Model withdrawn upstream");
      assert.equal(body, "Model withdrawn upstream");
    });

    it("resolveRuleMatchBody keeps returning the structured error for a provider with no operator rule", () => {
      const body = resolveRuleMatchBody("acme", { code: "not_found" }, "Model withdrawn upstream");
      assert.deepEqual(body, { code: "not_found" });
    });

    it("honorsRuleLockScope is true once an operator rule exists for the provider", () => {
      assert.equal(honorsRuleLockScope("acme"), false);
      setOperatorProviderErrorRules({
        acme: [{ status: 404, match: "model withdrawn", scope: "model" }],
      });
      assert.equal(honorsRuleLockScope("acme"), true);
    });

    it("an operator rule for a non-allowlisted provider matches on raw body text end to end", () => {
      setOperatorProviderErrorRules({
        acme: [{ status: 404, match: "model withdrawn", scope: "model" }],
      });
      const body = resolveRuleMatchBody(
        "acme",
        { code: "not_found" },
        "Error: model withdrawn upstream"
      );
      const m = getProviderErrorRuleMatch("acme", 404, null, body);
      assert.ok(m, "operator rule should match once resolveRuleMatchBody hands it the raw text");
      assert.equal(m.scope, "model");
    });
  });

  describe("HTTP 400 operator rules priority over built-in patterns", () => {
    const customProvider = "openai-compatible-chat-3c007462-eae7-44ca-a129-f721d0004827";
    const errorMsg = "Requested model deepseek-r1 is not supported";

    it("operator rule for 400 with scope='provider' takes precedence over MODEL_ACCESS_DENIED_PATTERNS", () => {
      setOperatorProviderErrorRules({
        [customProvider]: [
          {
            status: 400,
            match: "not supported",
            scope: "provider",
            reason: "quota_exhausted",
            cooldownMs: 21600000,
          },
        ],
      });

      const result = checkFallbackError(400, errorMsg, 0, "deepseek-r1", customProvider);
      assert.equal(result.shouldFallback, true);
      assert.equal(result.reason, "quota_exhausted");
      assert.equal(result.ruleScope, "provider");
      assert.equal(result.cooldownMs, 21600000);
      assert.equal(result.configuredCooldownMs, 21600000);
    });

    it("operator rule for 400 with scope='connection' takes precedence over zero-cooldown 400", () => {
      setOperatorProviderErrorRules({
        [customProvider]: [
          {
            status: 400,
            match: "not supported",
            scope: "connection",
            reason: "quota_exhausted",
            cooldownMs: 3600000,
          },
        ],
      });

      const result = checkFallbackError(400, errorMsg, 0, "deepseek-r1", customProvider);
      assert.equal(result.shouldFallback, true);
      assert.equal(result.reason, "quota_exhausted");
      assert.equal(result.ruleScope, "connection");
      assert.equal(result.cooldownMs, 3600000);
    });

    it("without operator rule, 400 with 'not supported' falls back to zero-cooldown MODEL_CAPACITY", () => {
      const result = checkFallbackError(400, errorMsg, 0, "deepseek-r1", customProvider);
      assert.equal(result.shouldFallback, true);
      assert.equal(result.reason, "model_capacity");
      assert.equal(result.cooldownMs, 0);
      assert.equal(result.ruleScope, undefined);
    });

    it("combo target exhaustion: ruleScope='provider' adds provider to exhaustedProviders", () => {
      const sets: ComboExhaustionSets = {
        exhaustedProviders: new Set<string>(),
        exhaustedConnections: new Set<string>(),
        transientRateLimitedProviders: new Set<string>(),
      };

      setOperatorProviderErrorRules({
        [customProvider]: [
          {
            status: 400,
            match: "not supported",
            scope: "provider",
            cooldownMs: 21600000,
          },
        ],
      });

      const fallbackResult = checkFallbackError(400, errorMsg, 0, "deepseek-r1", customProvider);
      assert.equal(fallbackResult.ruleScope, "provider");

      const exhausted = applyComboTargetExhaustion(
        { provider: customProvider, connectionId: "conn-123", model: "deepseek-r1" },
        {
          result: { status: 400 },
          fallbackResult,
          errorText: errorMsg,
          rawModel: "deepseek-r1",
          isTokenLimitBreach: false,
          allAccountsRateLimited: false,
          requestScopedFailure: false,
          sets,
          log: { info: () => {}, debug: () => {} },
          tag: "COMBO",
          exhaustedLogLevel: "info",
        }
      );

      assert.equal(exhausted, true);
      assert.ok(
        sets.exhaustedProviders.has(customProvider),
        "provider must be added to exhaustedProviders"
      );
    });

    it("combo target exhaustion: ruleScope='connection' adds connection to exhaustedConnections", () => {
      const sets: ComboExhaustionSets = {
        exhaustedProviders: new Set<string>(),
        exhaustedConnections: new Set<string>(),
        transientRateLimitedProviders: new Set<string>(),
      };

      setOperatorProviderErrorRules({
        [customProvider]: [
          {
            status: 400,
            match: "not supported",
            scope: "connection",
            cooldownMs: 3600000,
          },
        ],
      });

      const fallbackResult = checkFallbackError(400, errorMsg, 0, "deepseek-r1", customProvider);
      assert.equal(fallbackResult.ruleScope, "connection");

      const exhausted = applyComboTargetExhaustion(
        { provider: customProvider, connectionId: "conn-123", model: "deepseek-r1" },
        {
          result: { status: 400 },
          fallbackResult,
          errorText: errorMsg,
          rawModel: "deepseek-r1",
          isTokenLimitBreach: false,
          allAccountsRateLimited: false,
          requestScopedFailure: false,
          sets,
          log: { info: () => {}, debug: () => {} },
          tag: "COMBO",
          exhaustedLogLevel: "info",
        }
      );

      assert.equal(exhausted, true);
      assert.ok(sets.exhaustedConnections.has(`${customProvider}:conn-123`));
      assert.ok(!sets.exhaustedProviders.has(customProvider));
    });
  });
});
