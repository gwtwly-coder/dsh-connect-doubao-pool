/**
 * 离线冒烟测试：不依赖浏览器 React，用最小 React/ReactDOM 替身执行 client.js，
 * 跑通「模块加载 → apply(ctx) 注册 slot → 首屏渲染 → fetch 状态后渲染表格」这条链路。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "client.js");
const source = readFileSync(clientPath, "utf8");

/* ---------- 极简 React 替身 ---------- */
const ELEMENT = Symbol("element");
function createElement(type, props, ...children) {
  const flat = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c === null || c === undefined || c === false || c === true) return;
    else flat.push(c);
  };
  push(children);
  return { $$element: ELEMENT, type, props: { ...(props || {}), children: flat } };
}
const pendingEffects = [];
let hookStore = [];
let hookIndex = 0;
let dirty = false;
const React = {
  createElement,
  Fragment: "Fragment",
  useState: (init) => {
    const i = hookIndex++;
    if (!(i in hookStore)) hookStore[i] = typeof init === "function" ? init() : init;
    const set = (next) => {
      const value = typeof next === "function" ? next(hookStore[i]) : next;
      if (value !== hookStore[i]) { hookStore[i] = value; dirty = true; }
    };
    return [hookStore[i], set];
  },
  useEffect: (fn) => { pendingEffects.push(fn); },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  memo: (c) => c,
  forwardRef: (fn) => fn,
  createContext: (v) => ({ Provider: "Provider", _value: v }),
  useContext: (c) => c && c._value,
};

/* ---------- 极简浏览器环境 ---------- */
const styleRegistry = new Map();
const headChildren = [];
const bodyChildren = [];
const doc = {
  head: { appendChild: (n) => { headChildren.push(n); if (n.id) styleRegistry.set(n.id, n); } },
  body: { appendChild: (n) => { bodyChildren.push(n); } },
  getElementById: (id) => styleRegistry.get(id) ?? null,
  createElement: (tag) => {
    const attrs = new Map();
    const node = {
      tag, id: "", textContent: "", href: "", download: "", rel: "",
      style: {},
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      click() { node.clicked = true; }, remove() {},
    };
    return node;
  },
};
const appended = [];
globalThis.document = doc;
globalThis.window = globalThis; // 让 window.__ModuleLoader__ 可用
globalThis.URL.createObjectURL = () => "blob:mock";

// 组件之间靠 window 自定义事件同步（设置卡片改了池子，输入框读数要跟着刷）；
// 这是浏览器才有的东西，替身补齐 addEventListener / removeEventListener / dispatchEvent。
const listeners = new Map();
globalThis.addEventListener = (type, handler) => {
	const bucket = listeners.get(type) ?? new Set();
	bucket.add(handler);
	listeners.set(type, bucket);
};
globalThis.removeEventListener = (type, handler) => {
	listeners.get(type)?.delete(handler);
};
globalThis.dispatchEvent = (event) => {
	for (const handler of listeners.get(event?.type) ?? []) handler(event);
	return true;
};
globalThis.Event = class Event {
	constructor(type) {
		this.type = type;
	}
};
globalThis.URL.revokeObjectURL = () => {};

let fetchedUrls = [];
const fixturePath = join(here, "fixture-state.json");
let fakeState;
try { fakeState = JSON.parse(readFileSync(fixturePath, "utf8").replace(/^\uFEFF/, "")); }
catch { fakeState = { ok: true, plugin: "dsh-connect-doubao-pool", enabled: true, autoSwitch: true, activeId: null, accounts: [] }; }
const fakeModels = {
  ok: true,
  source: "catalog",
  enabled: ["0", "3", "5", "9"],
  models: [
    { id: "0", name: "豆包 快速", badge: null, rate: null, enabled: true },
    { id: "3", name: "豆包 2.1 Turbo", badge: "专家", rate: null, enabled: true },
    { id: "5", name: "豆包 2.1 Pro", badge: "工作任务", rate: { text: "0.65x", kind: "ratio" }, enabled: true },
    { id: "9", name: "自动", badge: "工作任务", rate: { text: "小额免费", kind: "promo" }, enabled: true },
    { id: "person-glm-5-4", name: "GLM 5.4", badge: "工作任务", rate: { text: "新上线 0.80x", kind: "promo" }, enabled: false }
  ]
};
globalThis.fetch = async (url, opts) => {
  fetchedUrls.push({ url, opts });
  const body = String(url).includes("/models") ? fakeModels : fakeState;
  return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return body; }, async text() { return JSON.stringify(body); } };
};

/* ---------- 捕获 ModuleLoader ---------- */
let captured = null;
globalThis.__ModuleLoader__ = {
  load(entry) { captured = entry; },
};

new Function("window", "document", source)(globalThis.window, doc);
if (!captured || typeof captured.factory !== "function") {
  console.error("FAIL: __ModuleLoader__.load 未被调用");
  process.exit(1);
}

const moduleShim = { exports: {} };
const requireShim = (name) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return { jsx: createElement, jsxs: createElement, Fragment: "Fragment" };
  if (name === "react-dom") return { createPortal: (n) => n };
  throw new Error("require 未支持的模块: " + name);
};
const exported = captured.factory(requireShim) ?? moduleShim.exports;
const plugin = exported?.default && Object.keys(exported).length === 1 ? exported.default : exported;

console.log("exports keys:", Object.keys(plugin).join(","));

/* 记录 document.head 注入的 style（ensureStyles 在渲染时才跑） */
for (const [id, node] of styleRegistry) void id && node;

/* ---------- 收集 slot 注册 ---------- */
const registrations = [];
const effects = [];
const ctx = {
  effect(fn, label) { effects.push(label ?? "effect"); const d = fn(); return d; },
  get() { return undefined; },
  locale: {
    register(ns, dict) { return () => {}; },
    bind() { return (key) => key; },
  },
  slots: {
    inject(name, fn) { const r = fn(); registrations.push({ slot: name, result: r }); return r; },
    register(meta, component) { return { name: meta.name, id: meta.id, order: meta.order, label: meta.label, component }; },
  },
};

plugin.apply(ctx);
console.log("slot 注册:", registrations.map((r) => r.slot + "/" + (r.result?.id ?? "?")).join(" | "));

/* ---------- 渲染替身 ---------- */
function render(node, depth = 0) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => render(n, depth)).join("");
  if (node.$$element) {
    const { type, props } = node;
    if (typeof type === "function") {
      const out = type({ ...props, children: props.children });
      return render(out, depth + 1);
    }
    const kids = render(props.children ?? [], depth + 1);
    if (type === "svg" || depth > 0 || String(type).length <= 4) return kids;
    return kids;
  }
  return String(node);
}

const cardReg = registrations.find((r) => r.slot === "settings.section")?.result;
const iconReg = registrations.find((r) => r.slot === "settings.section.icon")?.result;

let ok = true;
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) ok = false; };

check(cardReg && cardReg.component, "settings.section 注册了组件");
check(cardReg?.order === 41, "settings.section order = 41（实际 " + cardReg?.order + "）");
check(iconReg && iconReg.component, "settings.section.icon 注册了组件");

const iconText = render(React.createElement(iconReg.component, { size: 20, active: true }));
check(iconText === "" || typeof iconText === "string", "图标组件可渲染（无异常）");

/* 首屏（loading 态） */
hookStore = [];
hookIndex = 0;
let html1;
try { html1 = render(React.createElement(cardReg.component, {})); } catch (e) { ok = false; console.log("FAIL 首屏渲染抛错:", e.stack); }
console.log("首屏文案片段:", (html1 || "").replace(/\s+/g, " ").slice(0, 200));
check((html1 || "").length > 0, "首屏渲染产出非空");

/* 跑 effect（fetch 已被替身接管），再带真实数据重渲染 */
let html2 = "";
for (let round = 0; round < 8; round += 1) {
  while (pendingEffects.length > 0) {
    const fn = pendingEffects.shift();
    try { fn(); } catch (e) { ok = false; console.log("FAIL effect 抛错:", e.message); }
  }
  await new Promise((r) => setTimeout(r, 60));
  console.log(`  [round ${round}] dirty=${dirty} accounts=${hookStore[0]?.accounts?.length ?? "-"} fetched=${fetchedUrls.length}`);
  if (!dirty) { if (round > 0) break; }
  dirty = false;
  hookIndex = 0;
  html2 = render(React.createElement(cardReg.component, {}));
}

/* 模型块是嵌套卡片：它的 effect 要等池子卡片渲染出来才注册，所以再来几轮把数据灌进去 */
for (let extra = 0; extra < 3; extra += 1) {
  while (pendingEffects.length > 0) {
    const fn = pendingEffects.shift();
    try { fn(); } catch (e) { ok = false; console.log("FAIL effect 抛错:", e.message); }
  }
  await new Promise((r) => setTimeout(r, 60));
  hookIndex = 0;
  html2 = render(React.createElement(cardReg.component, {}));
}const text2 = (html2 || "").replace(/\s+/g, " ");
console.log("数据态文案片段:", text2.slice(0, 260));
const firstLabel = fakeState?.accounts?.[0]?.label ?? "";
check(firstLabel !== "" && text2.includes(firstLabel), "数据态渲染出账号行「" + firstLabel + "」");
check(/第1位|当前使用/.test(text2), "数据态渲染出排序位次/当前使用徽章");
check(/可用/.test(text2), "数据态渲染出「可用」状态");

const getCall = fetchedUrls[0];
check(!!getCall, "组件会发起状态请求");
if (getCall) {
  check(getCall.url === "/plugins/doubao-pool/state", "请求路径 = /plugins/doubao-pool/state（实际 " + getCall.url + "）");
  check(getCall.opts?.credentials === "same-origin", "fetch 带 credentials: same-origin");
}

check(styleRegistry.size > 0, "注入样式表 " + styleRegistry.size + " 个");
const css = [...styleRegistry.values()].map((n) => n.textContent).join("\n");
check(css.includes(".dbp-switch"), "样式含开关类 .dbp-switch");
check(css.includes(".dbp-trow"), "样式含表格行类 .dbp-trow");

/* ---------- composer 读数（对齐 WorkBuddy 的位置与文字形状） ---------- */
const cqReg = registrations.find((r) => r.slot === "conversation.input.right")?.result;
check(cqReg && cqReg.component, "conversation.input.right 注册了组件");
check(cqReg?.order === 4, "conversation.input.right order = 4（实际 " + cqReg?.order + "）");
check(!registrations.some((r) => r.slot === "conversation.input.left"), "不再占用 conversation.input.left");

hookStore = [];
hookIndex = 0;
let cqHtml = "";
try { cqHtml = render(React.createElement(cqReg.component, {})); } catch (e) { ok = false; console.log("FAIL composer 首屏抛错:", e.message); }
for (let round = 0; round < 8; round += 1) {
  while (pendingEffects.length > 0) {
    const fn = pendingEffects.shift();
    try { fn(); } catch (e) { ok = false; console.log("FAIL composer effect 抛错:", e.message); }
  }
  await new Promise((r) => setTimeout(r, 60));
  dirty = false;
  hookIndex = 0;
  cqHtml = render(React.createElement(cqReg.component, {}));
  if (cqHtml.includes("额度")) break;
}
const cqText = (cqHtml || "").replace(/\s+/g, " ");
console.log("composer 读数文案:", cqText.slice(0, 120));
check(/豆包工作\s*·\s*(298|299|100%)/.test(cqText), "读数文字 = 「豆包工作 · 剩余额度」（复刻 WorkBuddy 的「积分 · 1,522」）");
check(css.includes(".dbp-cq-trigger"), "样式含 .dbp-cq-trigger");
check(!/dbp-chip/.test(css), "旧的胶囊样式 .dbp-chip 已移除");
// 回归：模型清单必须真的渲染进行内（曾漏掉 body 导致只剩标题和保存按钮）。
// 回归：模型清单曾只算不渲染（body 变量没进 return），界面上只剩标题和保存按钮。
const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");
check(/collapsed\s*\?\s*null\s*:\s*body/.test(clientSource), "模型清单 body 真的进了卡片 return（折叠时才不画）");
check(/className: "dbp-caret"/.test(clientSource), "模型块有折叠三角");
check(/max-height: 248px/.test(clientSource), "模型清单展开后限高滚动");
check(/className: "dbp-models"/.test(clientSource), "模型清单容器 dbp-models 存在");
check(
	/function openSettingsSection/.test(clientSource) && /slots\.entries\(SETTINGS_SLOT\)/.test(clientSource),
	"设置按钮走设置外壳的 store 座位（openSection），不是只开设置面板"
);
check(/onOpenSettings: \(\) =>/.test(clientSource), "composer 面板注入了 onOpenSettings");
check(
	/openBundle\("dsh-connect-doubao-pool"\)/.test(clientSource),
	"座位与导航行都失效时兜底打开插件详情页"
);

check(/已启用/.test(text2), "模型块标题带已启用计数");
check(/展开/.test(text2), "模型块默认收起，提供展开按钮");

const iconCssOwner = [...styleRegistry.keys()];
console.log("style ids:", iconCssOwner.join(","));
console.log("effects:", effects.length);

/* provider 归属判定：选中别家 provider 时这一行不该出现 */
hookStore = [];
hookIndex = 0;
const foreignHtml = render(React.createElement(cqReg.component, {
  useProjection: () => ({ next: { provider: "workbuddy" } })
}));
check((foreignHtml || "").trim() === "", "选中 workbuddy 时不渲染豆包读数");
hookStore = [];
hookIndex = 0;
const doubaoHtml = render(React.createElement(cqReg.component, {
  useProjection: () => ({ next: { provider: "doubao" } })
}));
check(typeof doubaoHtml === "string", "选中 doubao 时正常渲染（不抛错）");

console.log(ok ? "\nSMOKE OK" : "\nSMOKE FAILED");
process.exit(ok ? 0 : 1);
