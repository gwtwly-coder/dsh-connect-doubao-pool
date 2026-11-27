/**
 * 自研豆包 adapter：把豆包 SSE 直接翻成 DSH 的 StreamChunk。
 *
 * 为什么不复用上游：上游走 `@earendil-works/pi-ai` + `@deepseek-ai/dsh-llm-pi-ai`，
 * 这两个包只有在「真安装进 profile 的插件」里才解析得到；本插件是 `link:` 安装，
 * 静态 import 直接 ERR_MODULE_NOT_FOUND（见 project 里的调试记录）。
 * 所以这里只用 dsh-llm 的**契约形状**（鸭子类型），不 import 任何宿主包。
 *
 * 契约（`@deepseek-ai/dsh-llm/src/index.ts` LlmAdapter）：
 *   - 必须：`stream(options): AsyncIterable<StreamChunk>`
 *   - 可选：`providerInfo` / `listModels` / `resolveModel` / `prepareCall` /
 *     `providerRetryPolicy` / `imageRequestPricing` / `imageRequestTarget`
 *   `registerAdapter` 只用 `providerInfo()` 校验（id 必须等于 provider、name 非空），
 *   没有 instanceof 检查。
 */
import { createHash } from "node:crypto";

import {
  DOUBAO_CONTEXT_WINDOW,
  DOUBAO_IMAGE_MODEL_ID,
  DOUBAO_MAX_TOKENS,
  DOUBAO_MODELS,
  DOUBAO_REASONING_LEVELS,
  buildToolContract,
  discoverDoubaoModels,
  doubaoCatalogEntries,
  // enabledModelsOf 不再用：勾选过滤自己实现，规则更直白
  findDoubaoModel,
  parseToolCalls,
  streamChat,
  toolResultAsText,
} from "../protocol/index.js";

/** provider 路由键：与豆包插件自己的 `doubao` 并存，互不打架。 */
export const PROVIDER_ID = "doubao-pool";
/** 模型选择器里显示的名字。 */
export const PROVIDER_NAME = "豆包工作（多账号）";

/** 豆包服务端按 UTF-8 字节卡请求体，不是 token。 */
const PROMPT_BYTE_BUDGET = 211808;
const TOOL_FENCE = "```";
const TOOL_FENCE_HEAD = "```doubao";

const IMAGE_MODEL_ID = DOUBAO_IMAGE_MODEL_ID;

function isImageModel(modelId) {
  return modelId === IMAGE_MODEL_ID;
}

/** 一条消息的可见文本（reasoning 不进 prompt，豆包不接受历史思考内容）。 */
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[图片]");
    else if (block.type === "file") parts.push("[文件]");
  }
  return parts.join("\n").trim();
}

function toolCallsOfContent(content) {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || block.type !== "tool-call") continue;
    let parsedArguments;
    try {
      parsedArguments = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments;
    } catch {
      parsedArguments = block.arguments;
    }
    calls.push({ id: block.id, name: block.name, arguments: parsedArguments ?? {} });
  }
  return calls;
}

function toolCallFence(call) {
  return `${TOOL_FENCE}doubao-tool\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n${TOOL_FENCE}`;
}

/**
 * 把 DSH 的消息数组拼成豆包要的那一段扁平 prompt。
 *
 * 规则照抄上游 shim 的 `buildPrompt`（那是它跑通的格式）：
 *   - tool 结果 → `toolResultAsText(name, text)`
 *   - 带 tool-call 的 assistant → 正文 + ```doubao-tool 围栏，整段前缀 `[assistant] `
 *   - 其余 → user 原样，其它角色前缀 `[role] `
 *   - turns 之间用两个换行连接
 */
const COMPACT_TURN_CHARS = 1200;

/** 把一条 turn 裁短：审核误判重试时用来去掉「一整段工具输出」这种长文本。 */
function compactTurn(text) {
  const value = String(text ?? "");
  if (value.length <= COMPACT_TURN_CHARS) return value;
  return `${value.slice(0, COMPACT_TURN_CHARS)}\n…（内容过长，已截断 ${value.length - COMPACT_TURN_CHARS} 字）`;
}

export function buildTurns(messages, system, options = {}) {
  const compact = options.compact === true;
  const turns = [];
  if (typeof system === "string" && system.trim() !== "") {
    const prompt = system.trim();
    turns.push(`[system] ${compact ? compactTurn(prompt) : prompt}`);
  }
  for (const message of messages ?? []) {
    if (message === null || typeof message !== "object") continue;
    const text = textOfContent(message.content);
    const role = message.role ?? "user";
    if (role === "tool") {
      if (text !== "") turns.push(toolResultAsText(message.name ?? "tool", compact ? compactTurn(text) : text));
      continue;
    }
    if (role === "assistant") {
      const calls = toolCallsOfContent(message.content);
      if (calls.length > 0) {
        const fenced = calls.map(toolCallFence).join("\n\n");
        const trimmed = text.trim();
        turns.push(`[assistant] ${trimmed === "" ? fenced : `${trimmed}\n\n${fenced}`}`);
        continue;
      }
      // 历史里的 assistant 空消息（只有 reasoning）直接跳过。
      if (text !== "") turns.push(`[assistant] ${compact ? compactTurn(text) : text}`);
      continue;
    }
    if (text === "") continue;
    const visible = compact ? compactTurn(text) : text;
    turns.push(role === "user" ? visible : `[${role}] ${visible}`);
  }
  return turns;
}

/** 超字节上限时从**最旧**的 turn 开始丢，但永远保住最后一条（那是要回答的问题）。 */
function fitTurns(turns, contractText) {
  const budget = PROMPT_BYTE_BUDGET - Buffer.byteLength(contractText, "utf8");
  const bytesOf = (list) => Buffer.byteLength(list.join("\n\n"), "utf8");
  if (bytesOf(turns) <= budget) return turns;
  const kept = [...turns];
  while (kept.length > 1 && bytesOf(kept) > budget) kept.shift();
  if (bytesOf(kept) > budget) {
    // 单条就超了：只能硬截最后一条的尾部——保住开头（通常含问题）。
    const last = kept[kept.length - 1];
    let slice = last;
    while (slice.length > 256 && Buffer.byteLength(slice, "utf8") > budget) {
      slice = slice.slice(0, Math.floor(slice.length * 0.9));
    }
    kept[kept.length - 1] = slice;
  }
  return kept;
}

/** DSH 的 tools（ToolSchema[]）→ 豆包契约用的 OpenAI 形状。 */
function openAiToolsOf(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object" || typeof tool.name !== "string") continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return out;
}

/**
 * 当前认的模型表。
 *
 * 静态的 `DOUBAO_MODELS` 只有豆包自家 5 个模型；第三方模型（person-*）只能从豆包
 * 的模型菜单里问出来，那份清单由 `index.js` 拉到之后通过 {@link setModelTable}
 * 灌进来。`stream` 要用它判断这个模型是不是工作任务的（taskMode）。
 */
let modelTable = DOUBAO_MODELS;

/**
 * 用一份新模型表替换静态表（来自豆包模型菜单）。
 * @param {Array<{id:string,name?:string,taskMode?:boolean,reasoning?:boolean}>} models
 */
export function setModelTable(models) {
  if (!Array.isArray(models) || models.length === 0) return false;
  modelTable = models;
  return true;
}

/** 豆包把内容审核的拒绝放在 STREAM_ERROR 里，core 已经标成 kind="content_blocked"。 */
function isContentBlocked(error) {
  if (error?.kind === "content_blocked") return true;
  return /内容审核|使用规范|content moderation|community_guidelines/i.test(String(error?.message ?? ""));
}

/**
 * 会话续传用的记录表。
 *
 * 豆包网页版每发一条消息只把**新那条**发上去，其余靠 `conversation_id` 挂在同一段
 * 会话里。我们早期每轮都把整段 transcript（system 提示 + 全部历史 + 工具契约）
 * 压成一条 user 文本重发，内容审核看到的是「一大段指令」，比正常聊天更容易判
 * 「涉嫌违反使用规范」。这里按会话记下 conversation_id 和已发到第几条消息，
 * 下一轮只发增量。
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_LIMIT = 256;
const conversations = new Map();

/**
 * 会话稳定键：DSH 每轮都传完整 transcript，第一条 user 消息永远不变，
 * 拿它的哈希当键就能跨轮认出「这是同一个会话」。
 */
export function sessionKeyOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((message) => message?.role === "user");
  const seed = first === undefined ? JSON.stringify(list.slice(0, 1)) : JSON.stringify(first.content ?? "");
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/**
 * 决定这一轮发什么。
 *
 * 能续传就发 `messages.slice(record.messageCount)`（上一轮的回答之后的部分），
 * 并且不再重发 system——system 已经在原会话的第一轮里说过了，重复发既浪费
 * 又容易被审核盯上。
 *
 * @param {Array} messages 宿主给的完整 transcript
 * @param {string|undefined} system 系统提示
 * @param {{conversationId?:string,messageCount?:number}|undefined} record
 */
export function planPrompt(messages, system, record) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const count = typeof record?.messageCount === "number" ? record.messageCount : 0;
  const canContinue =
    record !== undefined &&
    typeof record.conversationId === "string" &&
    record.conversationId !== "" &&
    total > count;
  const slice = canContinue ? list.slice(count) : list;
  return {
    canContinue,
    total,
    system,
    conversationId: canContinue ? record.conversationId : undefined,
    messages: slice.length > 0 ? slice : list,
  };
}

/** 这一轮发成功后记账：下一轮从 `plan.total` 之后接着发。 */
function rememberConversation(key, plan, result) {
  const conversationId = typeof result?.conversationId === "string" ? result.conversationId : "";
  if (conversationId === "") {
    conversations.delete(key);
    return;
  }
  conversations.set(key, {
    conversationId,
    messageCount: plan.total,
    updatedAt: Date.now(),
  });
  if (conversations.size > SESSION_LIMIT) {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [entryKey, entry] of conversations) {
      if (conversations.size <= SESSION_LIMIT) break;
      if (entry.updatedAt < cutoff || conversations.size > SESSION_LIMIT) conversations.delete(entryKey);
    }
  }
}

/** 换号之后旧会话不属于新账号了，直接清空。 */
export function resetConversations() {
  conversations.clear();
}

function reasoningInfoOf(model) {
  const table = modelTable.find((entry) => entry.id === model.id);
  if (table === undefined || table.reasoning !== true) return undefined;
  const verified = DOUBAO_REASONING_LEVELS.filter((level) => level.verified === true);
  if (verified.length === 0) return undefined;
  return {
    efforts: verified.map((level) => ({ id: level.id, name: level.name })),
    defaultEffort: "mid",
  };
}

/** 豆包模型菜单给的倍率，做选择器里模型名后面那个小标签。 */
function badgeOf(model) {
  const text = typeof model?.rate?.text === "string" ? model.rate.text.trim() : "";
  if (text === "") return undefined;
  return { text: { zh: text, en: text }, tone: model.rate.kind === "promo" ? "info" : "neutral" };
}

function modelInfoOf(provider, model) {
  const name = typeof model?.name === "string" && model.name !== "" ? model.name : model.id;
  const badge = badgeOf(model);
  return { provider, id: model.id, name, ...(badge === undefined ? {} : { badge }) };
}

/**
 * 造一个只服务 `doubao-pool` 这一个 provider 的 adapter。
 *
 * @param {object} deps
 * @param {() => Promise<{header:string, pairs:Map<string,string>}>} deps.resolveCredentials
 *   取「当前使用账号」的凭据（池子里的号，不依赖豆包插件）。
 * @param {() => Promise<{header:string, pairs:Map<string,string>}|undefined>} [deps.rotateCredentials]
 *   请求级失败时换下一个可用号；返回 undefined 表示没有可换的号。
 * @param {() => string[]|undefined} [deps.enabledModelIds]
 *   用户在「豆包模型」里勾选的模型；undefined/空 = 全部。
 * @param {(error:unknown) => void} [deps.onRotate]
 */
export function createPoolAdapter(deps) {
  if (deps === null || typeof deps !== "object") throw new Error("createPoolAdapter 需要 deps");
  const { resolveCredentials, rotateCredentials, enabledModelIds = () => undefined, models: modelsProvider, onRotate } = deps;
  if (typeof resolveCredentials !== "function") throw new Error("createPoolAdapter 需要 resolveCredentials");

  function visibleModels(catalog) {
    const source = catalog ?? modelTable;
    let ids;
    try {
      ids = enabledModelIds();
    } catch {
      ids = undefined;
    }
    // 严格按勾选过滤：勾了什么就只给什么，不勾＝全给。
    if (!Array.isArray(ids) || ids.length === 0) return [...source];
    const keep = new Set(ids.map((id) => String(id)));
    return source.filter((model) => keep.has(String(model.id)));
  }

  /** 流式把豆包的 onText/onThinking 回调转成 async 队列。 */
  function createSignalQueue() {
    const buffer = [];
    let wake = undefined;
    let closed = false;
    const push = (item) => {
      buffer.push(item);
      if (wake !== undefined) {
        const resolve = wake;
        wake = undefined;
        resolve();
      }
    };
    return {
      push,
      pushText(text) {
        if (typeof text === "string" && text !== "") push({ kind: "text", text });
      },
      pushThinking(text) {
        if (typeof text === "string" && text !== "") push({ kind: "thinking", text });
      },
      close() {
        closed = true;
        if (wake !== undefined) {
          const resolve = wake;
          wake = undefined;
          resolve();
        }
      },
      async *drain() {
        for (;;) {
          if (buffer.length > 0) {
            yield buffer.shift();
            continue;
          }
          if (closed) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      },
    };
  }

  /**
   * 一次尝试：把豆包的增量一路 yield 出去。
   *
   * 工具围栏的难点在于围栏是**文本流里冒出来的**：我们先把可能开头的 ``` 扣住
   * （最多 3 个反引号），一旦确认后面跟的是 doubao-tool 围栏就停止吐字，
   * 收尾时用 `parseToolCalls` 把围栏摘掉、剩下的才是可见正文。
   */
  async function* attempt(options, credentials, control = {}) {
    const modelId = typeof options.model === "string" && options.model !== "" ? options.model : "0";
    const model = modelTable.find((entry) => entry.id === modelId) ?? { id: modelId };
    const tools = openAiToolsOf(options.tools);
    const contractText = tools.length > 0 ? buildToolContract(tools) : "";
    // 能接上一轮会话就只发增量：豆包网页版就是这么发的（每轮只带新消息）。
    // 整段 transcript（含 system 与历史）重新塞进一条 user 消息，内容审核看到的
    // 是一大坨「指令 + 记录」，比正常聊天更容易被判违规；接着原会话发就没这问题。
    const sessionKey = sessionKeyOf(options.messages);
    const plan = planPrompt(options.messages, control.fresh === true ? undefined : conversations.get(sessionKey));
    const turns = fitTurns(buildTurns(plan.messages, plan.canContinue ? undefined : options.system, { compact: control.compact === true }), contractText);
    const prompt = turns.join("\n\n");
    const reasoningEffort = typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined;

    const queue = createSignalQueue();
    let textSoFar = "";
    let reasoningSoFar = "";
    let textIndex = 0;
    let reasoningIndex = 0;
    let textOpen = false;
    let reasoningOpen = false;
    let nextIndex = 0;
    let emittedAny = false;

    const ensureReasoning = function* () {
      if (reasoningOpen) return;
      reasoningIndex = nextIndex++;
      reasoningOpen = true;
      yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
    };
    const ensureText = function* () {
      if (textOpen) return;
      textIndex = nextIndex++;
      textOpen = true;
      yield { type: "block-start", index: textIndex, blockType: "text" };
    };

    /** 已经吐出去、但还扣在手里的潜在围栏前缀。 */
    let held = "";
    let fenced = false;

    function* feedText(chunk) {
      if (fenced) {
        textSoFar += chunk;
        return;
      }
      held += chunk;
      const fenceAt = held.indexOf(TOOL_FENCE);
      if (fenceAt !== -1) {
        const head = held.slice(0, fenceAt);
        held = held.slice(fenceAt);
        if (head !== "") {
          yield* ensureText();
          textSoFar += head;
          yield { type: "text-delta", index: textIndex, text: head };
        }
        fenced = true;
        return;
      }
      // 扣住尾部可能是半个围栏的部分（0~2 个反引号）。
      const keep = held.endsWith("``") ? 2 : held.endsWith("`") ? 1 : 0;
      const out = keep === 0 ? held : held.slice(0, held.length - keep);
      held = keep === 0 ? "" : held.slice(held.length - keep);
      if (out !== "") {
        yield* ensureText();
        textSoFar += out;
        yield { type: "text-delta", index: textIndex, text: out };
      }
    }

    const streaming = streamChat(prompt, {
      credentials,
      modelKey: modelId,
      ...(reasoningEffort !== undefined ? { reasoningLevel: reasoningEffort } : {}),
      ...(model.taskMode === true ? { taskMode: true } : {}),
      ...(tools.length > 0 ? { declaredTools: tools } : {}),
      ...(plan.canContinue ? { continueConversation: true, conversationId: plan.conversationId } : {}),
      callbacks: {
        onText: (chunk) => queue.pushText(chunk),
        onThinking: (chunk) => queue.pushThinking(chunk),
      },
      signal: options.signal,
    });

    // 上游结束时把结果（或失败）塞进队列，消费端只从一个地方取——避免两个
    // Promise 抢同一个 drain 生成器导致丢唤醒。
    void streaming.then(
      (value) => queue.push({ kind: "end", value }),
      (error) => queue.push({ kind: "error", error }),
    );

    let result;
    for await (const item of queue.drain()) {
      if (item.kind === "end") {
        result = item.value ?? {};
        break;
      }
      if (item.kind === "error") {
        // 内容审核拦截：多半是这一轮里某段长长的工具输出/文件内容被判违规。
        // 把每条 turn 裁到 1200 字再试一次；再拦就是内容本身，交给用户换通道。
        if (emittedAny === false && control.compact !== true && isContentBlocked(item.error)) {
          yield* attempt(options, credentials, { ...control, compact: true });
          return;
        }
        // 上一轮的 conversation_id 过期了（网页端删了会话、换号、超时）——把记录丢掉，
        // 这一轮用完整 transcript 重来一次。已经吐过字就不重试，不能把答案说两遍。
        if (plan.canContinue && emittedAny === false) {
          conversations.delete(sessionKey);
          yield* attempt(options, credentials, { fresh: true });
          return;
        }
        throw item.error;
      }
      if (item.kind === "thinking") {
        for (const chunk of ensureReasoning()) yield chunk;
        reasoningSoFar += item.text;
        emittedAny = true;
        yield { type: "reasoning-delta", index: reasoningIndex, text: item.text };
      } else {
        for (const chunk of feedText(item.text)) {
          emittedAny = true;
          yield chunk;
        }
      }
    }

    rememberConversation(sessionKey, plan, result);

    let finalText = `${textSoFar}${held}`;
    let calls = [];
    if (tools.length > 0) {
      const source = typeof result.text === "string" && result.text !== "" ? result.text : finalText;
      const parsed = parseToolCalls(source, tools);
      calls = Array.isArray(parsed.calls) ? parsed.calls : [];
      if (typeof parsed.text === "string") finalText = parsed.text;
    }
    if (finalText !== textSoFar) {
      const rest = finalText.startsWith(textSoFar) ? finalText.slice(textSoFar.length) : "";
      if (rest !== "") {
        for (const chunk of ensureText()) yield chunk;
        yield { type: "text-delta", index: textIndex, text: rest };
        textSoFar = finalText;
      } else if (!finalText.startsWith(textSoFar)) {
        // 上游文本与已吐出的不一致（罕见）：只承认已吐出的部分，别让 block-end 对不上。
        finalText = textSoFar;
      }
    }
    if (reasoningOpen) {
      yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningSoFar } };
    }
    if (textOpen) {
      yield { type: "block-end", index: textIndex, block: { type: "text", text: finalText } };
    }
    for (const call of calls) {
      const index = nextIndex++;
      const argsText = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: argsText };
      yield { type: "block-end", index, block: { type: "tool-call", id: call.id, name: call.name, arguments: argsText } };
    }
    if (calls.length > 0) yield { type: "finish", reason: { kind: "tool-calls" } };
    else yield { type: "finish", reason: { kind: "stop" } };
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_NAME };
    },

    // 宿主 `registerAdapter()` 会直接调用下面这几个方法（不是继承来的默认实现），
    // 少一个就报 "adapter.xxx is not a function"。我们只实现必需的，其余照契约
    // 返回「不声明」。
    providerRetryPolicy() {
      return undefined;
    },

    imageRequestPricing() {
      return undefined;
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes };
    },

    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: (options) => this.stream(options),
      };
    },

    async listModels(provider) {
      // 别信任 module 级的表：它可能还是「静态 6 条」的版本（模型菜单要先发一次
      // HTTP 才拿到第三方模型）。模型选择器只会问一次，问到的就得是全的。
      let catalog = modelTable;
      if (typeof modelsProvider === "function") {
        try {
          const fresh = await modelsProvider();
          if (Array.isArray(fresh) && fresh.length > 0) {
            catalog = fresh;
            setModelTable(fresh);
          }
        } catch {
          catalog = modelTable;
        }
      }
      return visibleModels(catalog).map((model) => modelInfoOf(provider, model));
    },

    async resolveModel(provider, model) {
      const table = modelTable.find((entry) => entry.id === model);
      const info = modelInfoOf(provider, table ?? { id: model });
      const reasoning = reasoningInfoOf({ id: model, ...(table ?? {}) });
      return {
        ...info,
        description: "豆包多账号池提供的模型",
        inputModalities: ["text"],
        context: { contextWindow: DOUBAO_CONTEXT_WINDOW },
        defaultMaxTokens: DOUBAO_MAX_TOKENS,
        ...(reasoning !== undefined ? { reasoning } : {}),
      };
    },

    async *stream(options) {
      let credentials = await resolveCredentials();
      let attemptNo = 0;
      for (;;) {
        attemptNo += 1;
        try {
          yield* attempt(options, credentials);
          return;
        } catch (error) {
          if (options.signal?.aborted === true) throw error;
          const canRetry = attemptNo === 1 && typeof rotateCredentials === "function";
          if (!canRetry) throw error;
          const next = await rotateCredentials(error);
          if (next === undefined || next === null) throw error;
          onRotate?.(error);
          credentials = next;
        }
      }
    },
  };
}

/** 曲目/目录：给设置卡片和 debug 路由用。 */
export function catalogEntries() {
  return doubaoCatalogEntries();
}

export { discoverDoubaoModels };
