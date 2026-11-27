import { createPoolAdapter } from "../lib/provider/adapter.js";
import { readPoolCredentials, readPoolState } from "../index.js";

const state = readPoolState();
const account = state.accounts.find((e) => e.id === state.activeId) ?? state.accounts[0];
const credentials = await readPoolCredentials(account.id);
const adapter = createPoolAdapter({ resolveCredentials: () => credentials });

async function run(label, text, options = {}) {
  try {
    let out = "";
    for await (const chunk of adapter.stream({ provider: "doubao-pool", model: "0", messages: [{ role: "user", content: [{ type: "text", text }] }], ...options })) {
      if (chunk.type === "text-delta") out += chunk.text;
    }
    console.log(`${label}: OK   ${out.replace(/\s+/g, " ").slice(0, 60)}`);
  } catch (error) {
    console.log(`${label}: BLOCKED ${String(error.message).replace(/\s+/g, " ").slice(0, 110)}`);
  }
}

await run("1 你到底是谁", "你到底是谁");
await run("2 你是哪个模型", "你是哪个模型");
await run("3 豆包工作模式+你是谁", "你到底是谁", { model: "5" });
