import { createProviderConnection, getProviderConnections } from "../../src/lib/db/providers.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { applyProviderSingleModelScopeLockout } from "../../src/sse/services/providerScopeCooldown.ts";
import { isModelLocked } from "../../open-sse/services/accountFallback.ts";

const provider = "nvidia";
const model = "deepseek-ai/deepseek-v4.1-flash";
const conn1 = "conn-nvidia-1";
const conn2 = "conn-nvidia-2";

await createProviderConnection({ id: conn1, provider, name: "Key 1", apiKey: "key-1", isActive: true });
await createProviderConnection({ id: conn2, provider, name: "Key 2", apiKey: "key-2", isActive: true });

const list = await getProviderConnections({ provider });
console.log("connections:", (list || []).map((c) => c.id));

await applyProviderSingleModelScopeLockout({
  provider,
  model,
  status: 504,
  fallbackResult: { cooldownMs: 900_000, reason: "model_capacity" },
  profile: null,
  maxCooldownMs: undefined,
});

console.log("conn1 locked:", isModelLocked(provider, conn1, model));
console.log("conn2 locked:", isModelLocked(provider, conn2, model));
console.log("wildcard locked:", isModelLocked(provider, "", model));
