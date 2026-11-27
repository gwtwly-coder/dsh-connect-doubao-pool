import { readPoolState, readPoolCredentials } from "../index.js";
import { createPoolAdapter, setModelTable } from "../lib/provider/adapter.js";
import { fetchMenuModels } from "../lib/model-menu.js";
const state = readPoolState();
const id = state.activeId ?? state.accounts[0]?.id;
const credentials = await readPoolCredentials(id);
const { entries } = await fetchMenuModels({ credentials, force: true });
setModelTable(entries.map((e) => ({ id: e.key, name: e.name, taskMode: e.taskOnly === true, reasoning: true })));
const adapter = createPoolAdapter({ resolveCredentials: async () => credentials, enabledModelIds: () => undefined });
const models = await adapter.listModels("doubao-pool");
console.log("listModels:", models.length);
const target = "person-glm-5-3-flash-261111";
let text = "";
let finish;
for await (const chunk of adapter.stream({ provider: "doubao-pool", model: target, messages: [{ role: "user", content: [{ type: "text", text: "用一句话说明你是什么模型" }] }] })) {
  if (chunk.type === "text-delta") text += chunk.text;
  if (chunk.type === "finish") finish = chunk.reason;
}
console.log("model:", target, "finish:", JSON.stringify(finish));
console.log("text:", text.trim().slice(0, 120));
console.log(text.trim() !== "" && finish?.kind === "stop" ? "THIRD-PARTY STREAM OK" : "THIRD-PARTY STREAM FAIL");
