/**
 * 真实链路冒烟：用账号池里的号，跑一次豆包对话，把 DSH StreamChunk 打出来。
 *
 * 这条测试不经过 DSH 宿主——它验证的是「凭据 → 豆包 SSE → StreamChunk」这一段，
 * 也就是自研 adapter 的全部价值所在。
 *
 * 用法：node test/stream.test.mjs ["提问"]
 */
import { readPoolCredentials, readPoolState } from "../index.js";
import { createPoolAdapter } from "../lib/provider/adapter.js";

const question = process.argv[2] ?? "用一句话介绍你自己。";
const withTools = process.argv.includes("--tools");

const state = readPoolState();
const account = state.accounts.find((entry) => entry.id === state.activeId) ?? state.accounts[0];
if (account === undefined) {
	console.error("账号池是空的：先在设置里扫码添加一个账号，再跑这条测试。");
	process.exit(1);
}

const credentials = await readPoolCredentials(account.id);
console.log(`用账号：${account.label}（cookie ${credentials.pairs.size} 个）`);

const adapter = createPoolAdapter({
	resolveCredentials: async () => credentials,
	enabledModelIds: () => ["0", "3", "5", "9"]
});

const chunks = [];
const startedAt = Date.now();
const tools = withTools ? [{
	name: "get_weather",
	description: "查询某个城市的实时天气",
	parameters: { type: "object", properties: { city: { type: "string", description: "城市名" } }, required: ["city"] }
}] : undefined;

for await (const chunk of adapter.stream({
	provider: "doubao-pool",
	model: "0",
	messages: [{ role: "user", content: [{ type: "text", text: question }] }],
	...(tools !== undefined ? { tools } : {})
})) {
	chunks.push(chunk);
}
const elapsed = Date.now() - startedAt;

const text = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text).join("");
const reasoning = chunks.filter((chunk) => chunk.type === "reasoning-delta").map((chunk) => chunk.text).join("");
const finish = chunks.find((chunk) => chunk.type === "finish");
const blocks = chunks.filter((chunk) => chunk.type === "block-end").map((chunk) => chunk.block?.type);

console.log("\n--- 结构 ---");
console.log("chunk 种类：" + [...new Set(chunks.map((chunk) => chunk.type))].join(", "));
console.log("闭合的块：" + blocks.join(", "));
console.log("finish：" + JSON.stringify(finish?.reason));
console.log(`耗时：${elapsed}ms`);
console.log("\n--- 正文 ---");
console.log(text || "（空）");
if (reasoning !== "") console.log(`\n--- 思考（前 200 字）---\n${reasoning.slice(0, 200)}`);

const ok = text.trim() !== "" && finish?.reason?.kind === "stop";
console.log(ok ? "\nSTREAM OK" : "\nSTREAM FAILED");
process.exitCode = ok ? 0 : 1;
