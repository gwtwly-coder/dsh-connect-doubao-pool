/**
 * 会话续传冒烟：连发两轮，验证第二轮走的是「接着上一段会话发增量」而不是重发整段。
 * 会真的打一次豆包接口，所以只在手动跑。
 */
import { createPoolAdapter } from "../lib/provider/adapter.js";
import { readPoolCredentials, readPoolState } from "../index.js";

const state = readPoolState();
const account = state.accounts.find((entry) => entry.id === state.activeId) ?? state.accounts[0];
if (account === undefined) {
	console.log("没有账号");
	process.exit(1);
}
const credentials = await readPoolCredentials(account.id);
const adapter = createPoolAdapter({ resolveCredentials: () => credentials });

async function turn(messages, label) {
	const started = Date.now();
	let text = "";
	let finish = null;
	for await (const chunk of adapter.stream({
		provider: "doubao-pool",
		model: process.argv[2] ?? "0",
		messages,
	})) {
		if (chunk.type === "text-delta") text += chunk.text;
		if (chunk.type === "finish") finish = chunk.reason;
	}
	console.log(`${label}  ${Date.now() - started}ms  finish=${JSON.stringify(finish)}`);
	console.log(`  ${text.replace(/\s+/g, " ").slice(0, 160)}`);
	return text;
}

const first = [{ role: "user", content: [{ type: "text", text: "记住这个数字：7319。只回两个字：收到。" }] }];
await turn(first, "第 1 轮");
const second = [...first,
	{ role: "assistant", content: [{ type: "text", text: "收到" }] },
	{ role: "user", content: [{ type: "text", text: "刚才那个数字是多少？只回数字。" }] }];
const answer = await turn(second, "第 2 轮（续传）");
console.log(/7319/.test(answer) ? "CONTINUATION OK" : "CONTINUATION 没记住（会话可能没接上）");
