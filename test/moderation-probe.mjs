import { createPoolAdapter } from "../lib/provider/adapter.js";
import { readPoolCredentials, readPoolState } from "../index.js";

const state = readPoolState();
const account = state.accounts.find((e) => e.id === state.activeId) ?? state.accounts[0];
const credentials = await readPoolCredentials(account.id);
const adapter = createPoolAdapter({ resolveCredentials: () => credentials });

const system = `你是 DeepSeek Harness 中的编码代理。你必须遵守以下系统规则：
1. 优先使用工具收集信息，不要凭空猜测。
2. 执行危险命令前必须说明影响。
3. 回复使用简体中文。
4. 你有以下工具可用：read/write/edit/bash/grep/glob。
5. 如果任务超出范围，直接说明。
`;
const tools = [{ type: "object", name: "get_weather", description: "查询城市天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

async function run(label, options) {
  try {
    let text = "";
    for await (const chunk of adapter.stream({ provider: "doubao-pool", model: "0", ...options })) {
      if (chunk.type === "text-delta") text += chunk.text;
    }
    console.log(`${label}: OK  ${text.replace(/\s+/g, " ").slice(0, 70)}`);
  } catch (error) {
    console.log(`${label}: BLOCKED  ${String(error.message).replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

const userMsg = (t) => [{ role: "user", content: [{ type: "text", text: t }] }];
await run("A 只发用户话", { messages: userMsg("你好，简单介绍一下你自己") });
await run("B 用户话+长system", { messages: userMsg("你好，简单介绍一下你自己"), system });
await run("C 用户话+工具契约", { messages: userMsg("查一下北京天气"), tools });
