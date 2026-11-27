/**
 * 协议层单测：工具围栏的生成与解析。不联网。
 *
 * 为什么单独测这一段：豆包没有原生 tool_call，工具调用是「模型按契约吐一段
 * ```doubao-tool 围栏 → 我们解析成 DSH 的 tool-call 块」。这段错了，工具会静默
 * 失效或把围栏当正文吐给用户，而真实模型不一定每次都吐围栏，靠联网测碰不到。
 */
import { buildTurns, clipTurn, fitTurns, planPrompt, sessionKeyOf } from "../lib/provider/adapter.js";
import { buildToolContract, parseToolCalls } from "../lib/protocol/index.js";

let failed = 0;
const check = (ok, label, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${detail}`}`);
	if (!ok) failed += 1;
};

const tools = [{
	type: "function",
	function: {
		name: "get_weather",
		description: "查询某个城市的实时天气",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
	}
}];

const contract = buildToolContract(tools);
check(contract.includes("get_weather"), "契约里出现工具名");
check(contract.includes("doubao-tool"), "契约里说明围栏语言标记");

const withFence = '好的，我查一下。\n\n```doubao-tool\n{"name":"get_weather","arguments":{"city":"北京"}}\n```';
const parsed = parseToolCalls(withFence, tools);
check(parsed.calls.length === 1, "解析出一个工具调用", `calls=${parsed.calls.length}`);
check(parsed.calls[0]?.name === "get_weather", "工具名正确", parsed.calls[0]?.name);
check(parsed.calls[0]?.arguments === '{"city":"北京"}', "arguments 是 JSON 字符串", parsed.calls[0]?.arguments);
check(parsed.text.trim() === "好的，我查一下。", "可见正文去掉了围栏", JSON.stringify(parsed.text));

const noFence = "今天北京晴，10℃。";
const plain = parseToolCalls(noFence, tools);
check(plain.calls.length === 0, "没有围栏时没有工具调用");
check(plain.text === noFence, "没有围栏时正文原样保留");

const unknownTool = '```doubao-tool\n{"name":"not_declared","arguments":{}}\n```';
const rejected = parseToolCalls(unknownTool, tools);
check(rejected.calls.length === 0, "未声明的工具被拒绝");
check(rejected.rejectedCalls === true, "未声明的工具置 rejectedCalls=true");
check(rejected.text.startsWith("工具调用未执行"), "被拒时正文换成告知模型的说明", JSON.stringify(rejected.text.slice(0, 12)));

const brokenJson = "```doubao-tool\n{不是 JSON}\n```";
const broken = parseToolCalls(brokenJson, tools);
check(broken.calls.length === 0, "坏 JSON 不产生调用");
check(broken.rejectedCalls === true, "坏 JSON 也走 rejectedCalls=true");

const twoCalls = '```doubao-tool\n{"name":"get_weather","arguments":{"city":"北京"}}\n```\n\n```doubao-tool\n{"name":"get_weather","arguments":{"city":"上海"}}\n```';
const multi = parseToolCalls(twoCalls, tools);
check(multi.calls.length === 2, "连续两个围栏解析出两个调用", `calls=${multi.calls.length}`);
check(new Set(multi.calls.map((call) => call.id)).size === 2, "两个调用的 id 不重复");


// ---- 会话续传：整段 transcript 重发是内容审核的主要诱因 ----
const transcript = [
	{ role: "user", content: [{ type: "text", text: "帮我看看这个仓库" }] },
	{ role: "assistant", content: [{ type: "text", text: "看哪部分？" }] },
	{ role: "user", content: [{ type: "text", text: "先读 README" }] },
];
const keyOne = sessionKeyOf(transcript);
const keyTwo = sessionKeyOf([...transcript, { role: "assistant", content: [{ type: "text", text: "好" }] }]);
check(keyOne === keyTwo, "同一段对话的第一条不变 → 会话键不变", keyOne);
check(sessionKeyOf([{ role: "user", content: [{ type: "text", text: "另一件事" }] }]) !== keyOne, "换一段对话 → 会话键不同");

const fresh = planPrompt(transcript, "SYSTEM", undefined);
check(fresh.canContinue === false && fresh.messages.length === 3, "没有会话记录 → 发完整 transcript");

const record = { conversationId: "conv-1", messageCount: 1 };
const resumed = planPrompt(transcript, "SYSTEM", record);
check(resumed.canContinue === true && resumed.conversationId === "conv-1", "有记录 → 续传");
check(resumed.messages.length === 2 && resumed.messages[0].role === "assistant", "续传只发增量（消息数 = 总数 - 已发）");
check(planPrompt(transcript, "SYSTEM", { conversationId: "conv-1", messageCount: 3 }).canContinue === false, "没有新消息 → 不续传（避免空增量）");


// ---- 审核误判后的裁短重试 ----
const longOutput = "y".repeat(6000);
const fullTurn = buildTurns([{ role: "tool", name: "bash", content: [{ type: "text", text: longOutput }] }], "");
const cutTurn = buildTurns([{ role: "tool", name: "bash", content: [{ type: "text", text: longOutput }] }], "", { compact: true });
check(fullTurn[0].length > 6000, "不裁时工具输出原样带上", String(fullTurn[0].length));
check(cutTurn[0].length < 1400, "裁短时工具输出被限制在 1200 字左右", String(cutTurn[0].length));
check(/已截断 \d+ 字/.test(cutTurn[0]), "裁短后留一句说明");


// ---- 超预算时的裁剪策略（切 provider 后整段历史一次性进来）----
const longHistory = [
  "[system] 你是 DSH 里的助手",
  "用户：请把 poc-sniffer-ui-stream-copy 项目的流复制部分做完",
];
for (let i = 0; i < 40; i += 1) longHistory.push(`[${i % 2 === 0 ? "tool" : "assistant"}] 第${i}步 ${"x".repeat(9000)}`);
const fitted = fitTurns(longHistory, "");
check(fitted.length < longHistory.length, "超预算时会丢一部分历史", `${longHistory.length} → ${fitted.length}`);
check(fitted[1].includes("poc-sniffer-ui-stream-copy"), "任务锚点（第一条 user）没有被丢掉");
check(fitted.some((turn) => turn.includes("已被省略")), "中间留了省略说明");
check(fitted[fitted.length - 1].includes("第39步"), "最近一轮保留");
const singleHuge = fitTurns(["u", "y".repeat(50000)], "");
check(singleHuge[1].includes("中间省略"), "单条过长时保头保尾", String(singleHuge[1].length));
check(clipTurn("short") === "short", "短 turn 不裁");

console.log(failed === 0 ? "\nPROTOCOL OK" : `\nPROTOCOL FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
