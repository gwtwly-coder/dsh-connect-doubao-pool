import { readPoolState, readPoolCredentials } from "../index.js";
import { createPoolAdapter } from "../lib/provider/adapter.js";
import { fetchMenuModels } from "../lib/model-menu.js";
const s = readPoolState();
const c = await readPoolCredentials(s.activeId ?? s.accounts[0].id);
const { entries } = await fetchMenuModels({ credentials: c });
const adapter = createPoolAdapter({
  resolveCredentials: async () => c,
  enabledModelIds: () => undefined,
  models: async () => entries.map((e) => ({ id: e.key, name: e.name, taskMode: e.taskOnly === true, reasoning: true, rate: e.rate }))
});
const models = await adapter.listModels("doubao-pool");
for (const m of models.slice(0, 6)) console.log(m.id, "|", m.name, "|", JSON.stringify(m.badge ?? null));
const one = await adapter.resolveModel("doubao-pool", "person-glm-5-3-flash-261111");
console.log("resolveModel badge:", JSON.stringify(one.badge ?? null));
