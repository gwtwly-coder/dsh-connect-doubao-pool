/**
 * 豆包「模型菜单」的解析与拉取。
 *
 * 为什么需要它：豆包账号能用到的模型不止自家那 5 个——工作任务那套还接了第三方
 * 模型（person-deepseek-v4-1-flash-261017、person-glm-5-4、
 * person-kimi-k3-1-pro-261111、person-qwen4-max …）。这份清单没有静态常量，
 * 只能问豆包自己：POST /alice/slot/action_bar_v3/brief_list 的返回里带着每个
 * 模型的 key、显示名、倍率和工作任务标记。
 *
 * 解析函数搬自 dsh-connect-doubao 的同名实现（MIT，见 NOTICE.md），拉取那一步是我
 * 们自己写的：凭据从账号池里取，不碰豆包插件写的固定文件。
 */
import {
  ACTION_BAR_BRIEF_LIST_ENDPOINT,
  DEFAULT_BOT_ID,
  buildHeaders,
  buildQueryUrl
} from "./protocol/index.js";

function looksLikeModelKey(value) {
	return /^[\w.-]{1,64}$/.test(value);
}

function looksLikeModelName(value) {
	if (value.length < 2 || value.length > 40) return false;
	if (!/[\u4e00-\u9fa5A-Za-z]/.test(value)) return false;
	return !/^[a-z_]+$/.test(value) && !value.includes("http");
}

function rateOf(tagList) {
	if (!Array.isArray(tagList)) return void 0;
	for (const tag of tagList) {
		const text = typeof tag?.text === "string" ? tag.text.trim() : "";
		if (text === "") continue;
		return {
			text,
			kind: /^[\d.]+x$/i.test(text) ? "ratio" : "promo"
		};
	}
}

function reasoningOptionsOf(config) {
	const options = config?.option_list;
	if (!Array.isArray(options)) return void 0;
	const out = [];
	for (const option of options) {
		const level = typeof option?.level === "number" ? option.level : void 0;
		const name = typeof option?.name === "string" ? option.name : void 0;
		if (level === void 0 || name === void 0 || name === "") continue;
		if (out.some((known) => known.level === level)) continue;
		out.push({
			level,
			name
		});
	}
	return out.length === 0 ? void 0 : out;
}

function parseMenuItems(items) {
	if (!Array.isArray(items)) return [];
	const out = [];
	for (const item of items) {
		const key = typeof item?.model_item_key === "string" ? item.model_item_key : void 0;
		const name = typeof item?.name === "string" ? item.name : void 0;
		if (key === void 0 || name === void 0) continue;
		if (!looksLikeModelKey(key) || !looksLikeModelName(name)) continue;
		if (out.some((known) => known.key === key)) continue;
		const mode = typeof item.default_mode === "string" ? item.default_mode : void 0;
		const rate = rateOf(item.tag_list);
		const reasoningOptions = reasoningOptionsOf(item.reasoning_effort_config);
		out.push({
			key,
			name,
			taskOnly: name.startsWith("工作任务") || mode === "3",
			...mode === void 0 ? {} : { mode },
			...rate === void 0 ? {} : { rate },
			...reasoningOptions === void 0 ? {} : { reasoningOptions }
		});
	}
	return out;
}

function parseBriefListResponse(payload) {
	const entries = payload?.data?.entry_list;
	if (!Array.isArray(entries)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const ordered = [...entries.filter((entry) => entry?.action_bar_key === "coco_deep_thinking"), ...entries.filter((entry) => entry?.action_bar_key !== "coco_deep_thinking")];
	for (const entry of ordered) {
		const items = entry?.active_switch_conf?.menu_conf_v2?.model_list?.item_list ?? entry?.active_switch_conf?.menu_conf?.item_list;
		for (const parsed of parseMenuItems(items)) if (!seen.has(parsed.key)) {
			seen.add(parsed.key);
			out.push(parsed);
		}
	}
	return out;
}

const MENU_TTL_MS = 6e5;
let menuCache = { at: 0, entries: [], failed: false, error: "", status: 0 };

/**
 * 拉一次豆包模型菜单。失败不抛，返回空数组——调用方回落到静态清单。
 */
export async function fetchMenuModels(options = {}) {
  const now = Date.now();
  if (options.force !== true && menuCache.entries.length > 0 && now - menuCache.at < MENU_TTL_MS) {
    return { entries: menuCache.entries, cached: true };
  }
  const credentials = options.credentials;
  if (credentials === void 0 || credentials.ok === false || typeof credentials.header !== "string") {
    menuCache.error =
      credentials === void 0
        ? "没有可用凭据"
        : credentials.ok === false
          ? "凭据不可用：" + String(credentials.reason ?? "")
          : "凭据里没有 cookie header";
    return { entries: menuCache.entries, cached: true };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const url = buildQueryUrl(ACTION_BAR_BRIEF_LIST_ENDPOINT, credentials.pairs?.get?.("msToken"));
    const response = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(credentials, { "content-type": "application/json" }),
      body: JSON.stringify({ language_code: "zh", bot_id: DEFAULT_BOT_ID })
    });
    if (!response.ok) {
      menuCache.failed = true;
      return { entries: menuCache.entries, cached: true };
    }
    const entries = parseBriefListResponse(await response.json());
    if (entries.length > 0) menuCache = { at: Date.now(), entries, failed: false };
    return { entries: menuCache.entries, cached: entries.length === 0 };
  } catch {
    menuCache.failed = true;
    return { entries: menuCache.entries, cached: true };
  }
}

export function menuCacheInfo() {
  return { fetchedAt: menuCache.at, count: menuCache.entries.length, failed: menuCache.failed, status: menuCache.status, error: menuCache.error };
}

export { parseBriefListResponse, parseMenuItems };
