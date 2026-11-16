import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { updateSettingsSchema } from "@/shared/validation/settingsSchemas";
import {
  getProviderErrorRuleMatch,
  setOperatorProviderErrorRules,
  type OperatorProviderErrorRule,
} from "../../open-sse/config/providerErrorRules.ts";

describe("settings providerErrorRules validation and behavior", () => {
  beforeEach(() => {
    setOperatorProviderErrorRules(undefined);
  });

  describe("updateSettingsSchema validation", () => {
    it("accepts valid provider error rules with full fields", () => {
      const payload = {
        providerErrorRules: {
          nvidia: [
            {
              status: 404,
              match: "model not found",
              scope: "model" as const,
              reason: "quota_exhausted" as const,
              cooldownMs: 60000,
            },
          ],
          openai: [
            {
              status: 429,
              match: "insufficient_quota",
              scope: "connection" as const,
              reason: "quota_exhausted" as const,
              cooldownMs: 300000,
            },
            {
              status: 503,
              match: "overloaded",
              scope: "provider" as const,
              reason: "server_error" as const,
            },
          ],
        },
      };

      const parsed = updateSettingsSchema.parse(payload);
      assert.ok(parsed.providerErrorRules);
      assert.equal(Object.keys(parsed.providerErrorRules).length, 2);
      assert.equal(parsed.providerErrorRules.nvidia?.length, 1);
      assert.equal(parsed.providerErrorRules.openai?.length, 2);
      assert.equal(parsed.providerErrorRules.nvidia?.[0].status, 404);
      assert.equal(parsed.providerErrorRules.nvidia?.[0].match, "model not found");
      assert.equal(parsed.providerErrorRules.nvidia?.[0].scope, "model");
      assert.equal(parsed.providerErrorRules.nvidia?.[0].reason, "quota_exhausted");
      assert.equal(parsed.providerErrorRules.nvidia?.[0].cooldownMs, 60000);
    });

    it("accepts empty object {} to clear rules", () => {
      const payload = {
        providerErrorRules: {},
      };
      const parsed = updateSettingsSchema.parse(payload);
      assert.deepEqual(parsed.providerErrorRules, {});
    });

    it("accepts rules with optional fields omitted", () => {
      const payload = {
        providerErrorRules: {
          anthropic: [
            {
              status: 529,
              match: "overloaded",
              scope: "provider" as const,
            },
          ],
        },
      };
      const parsed = updateSettingsSchema.parse(payload);
      assert.equal(parsed.providerErrorRules?.anthropic?.[0].reason, undefined);
      assert.equal(parsed.providerErrorRules?.anthropic?.[0].cooldownMs, undefined);
    });

    it("rejects empty provider name", () => {
      const payload = {
        providerErrorRules: {
          "   ": [
            {
              status: 404,
              match: "not found",
              scope: "model" as const,
            },
          ],
        },
      };
      const result = updateSettingsSchema.safeParse(payload);
      assert.equal(result.success, false);
    });

    it("rejects provider name longer than 100 characters", () => {
      const longName = "a".repeat(101);
      const payload = {
        providerErrorRules: {
          [longName]: [
            {
              status: 404,
              match: "not found",
              scope: "model" as const,
            },
          ],
        },
      };
      const result = updateSettingsSchema.safeParse(payload);
      assert.equal(result.success, false);
    });

    it("rejects invalid status code", () => {
      const belowMin = {
        providerErrorRules: {
          nvidia: [{ status: 99, match: "err", scope: "model" as const }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(belowMin).success, false);

      const aboveMax = {
        providerErrorRules: {
          nvidia: [{ status: 600, match: "err", scope: "model" as const }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(aboveMax).success, false);

      const nonInt = {
        providerErrorRules: {
          nvidia: [{ status: 404.5, match: "err", scope: "model" as const }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(nonInt).success, false);
    });

    it("rejects empty match string or match string over 200 chars", () => {
      const emptyMatch = {
        providerErrorRules: {
          nvidia: [{ status: 404, match: "", scope: "model" as const }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(emptyMatch).success, false);

      const tooLongMatch = {
        providerErrorRules: {
          nvidia: [{ status: 404, match: "a".repeat(201), scope: "model" as const }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(tooLongMatch).success, false);
    });

    it("rejects invalid scope", () => {
      const invalidScope = {
        providerErrorRules: {
          nvidia: [{ status: 404, match: "err", scope: "global" }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(invalidScope).success, false);
    });

    it("rejects invalid reason", () => {
      const invalidReason = {
        providerErrorRules: {
          nvidia: [{ status: 404, match: "err", scope: "model" as const, reason: "custom_reason" }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(invalidReason).success, false);
    });

    it("rejects negative cooldownMs or cooldownMs exceeding 24 hours", () => {
      const negativeCooldown = {
        providerErrorRules: {
          nvidia: [{ status: 404, match: "err", scope: "model" as const, cooldownMs: -1 }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(negativeCooldown).success, false);

      const excessiveCooldown = {
        providerErrorRules: {
          nvidia: [{ status: 404, match: "err", scope: "model" as const, cooldownMs: 86_400_001 }],
        },
      };
      assert.equal(updateSettingsSchema.safeParse(excessiveCooldown).success, false);
    });

    it("enforces a maximum of 50 total rules across all providers", () => {
      const rules: OperatorProviderErrorRule[] = [];
      for (let i = 0; i < 50; i++) {
        rules.push({
          status: 400 + (i % 100),
          match: `error_${i}`,
          scope: "model",
        });
      }

      // 50 rules should succeed
      const exactly50 = {
        providerErrorRules: {
          providerA: rules.slice(0, 25),
          providerB: rules.slice(25, 50),
        },
      };
      assert.equal(updateSettingsSchema.safeParse(exactly50).success, true);

      // 51 rules must fail
      const over50 = {
        providerErrorRules: {
          providerA: rules.slice(0, 25),
          providerB: rules.slice(25, 50),
          providerC: [{ status: 500, match: "one_more", scope: "provider" as const }],
        },
      };
      const result = updateSettingsSchema.safeParse(over50);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.error.issues[0].message, /at most 50 rules total/);
      }
    });
  });

  describe("UI manipulation and atomic settings flow", () => {
    it("simulates rule addition, edit, and deletion cycle", () => {
      let state: Record<string, OperatorProviderErrorRule[]> = {};

      // 1. Add rule for nvidia
      const rule1: OperatorProviderErrorRule = {
        status: 404,
        match: "model not found",
        scope: "model",
        reason: "quota_exhausted",
      };
      state = {
        ...state,
        nvidia: [...(state.nvidia ?? []), rule1],
      };
      let parsed = updateSettingsSchema.parse({ providerErrorRules: state });
      assert.equal(parsed.providerErrorRules?.nvidia?.length, 1);

      // 2. Add rule for openai
      const rule2: OperatorProviderErrorRule = {
        status: 429,
        match: "quota exceeded",
        scope: "connection",
        cooldownMs: 60000,
      };
      state = {
        ...state,
        openai: [...(state.openai ?? []), rule2],
      };
      parsed = updateSettingsSchema.parse({ providerErrorRules: state });
      assert.equal(parsed.providerErrorRules?.openai?.length, 1);

      // 3. Edit nvidia rule
      const updatedRule1: OperatorProviderErrorRule = {
        ...rule1,
        match: "resource exhausted",
        cooldownMs: 120000,
      };
      state = {
        ...state,
        nvidia: [updatedRule1],
      };
      parsed = updateSettingsSchema.parse({ providerErrorRules: state });
      assert.equal(parsed.providerErrorRules?.nvidia?.[0].match, "resource exhausted");
      assert.equal(parsed.providerErrorRules?.nvidia?.[0].cooldownMs, 120000);

      // 4. Delete nvidia rule (and prune empty provider key like UI does)
      const remainingNvidia = (state.nvidia ?? []).filter((_, idx) => idx !== 0);
      const nextDraft = { ...state };
      if (remainingNvidia.length === 0) {
        delete nextDraft.nvidia;
      } else {
        nextDraft.nvidia = remainingNvidia;
      }
      state = nextDraft;

      parsed = updateSettingsSchema.parse({ providerErrorRules: state });
      assert.equal(parsed.providerErrorRules?.nvidia, undefined);
      assert.equal(parsed.providerErrorRules?.openai?.length, 1);

      // 5. Delete openai rule -> empty state
      delete state.openai;
      parsed = updateSettingsSchema.parse({ providerErrorRules: state });
      assert.deepEqual(parsed.providerErrorRules, {});
    });

    it("integrates with setOperatorProviderErrorRules and getProviderErrorRuleMatch", () => {
      const settingsPayload = {
        providerErrorRules: {
          customai: [
            {
              status: 403,
              match: "points exhausted",
              scope: "connection" as const,
              reason: "quota_exhausted" as const,
              cooldownMs: 3600000,
            },
          ],
        },
      };

      const parsed = updateSettingsSchema.parse(settingsPayload);
      setOperatorProviderErrorRules(parsed.providerErrorRules);

      const matched = getProviderErrorRuleMatch(
        "customai",
        403,
        null,
        "Account failed: points exhausted today"
      );
      assert.ok(matched);
      assert.equal(matched.scope, "connection");
      assert.equal(matched.reason, "quota_exhausted");
      assert.equal(matched.cooldownMs, 3600000);
    });
  });
});
