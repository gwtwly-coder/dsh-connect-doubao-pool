/**
 * dsh-connect-doubao-pool —— 豆包多账号（账号池 + 自有 provider）
 *
 * 做什么：豆包插件（dsh-connect-doubao）本身只认一份浏览器登录态，一次只能挂
 * 一个账号。这个插件在旁边维护一个「账号池」：每个账号的 cookie 各自用 Windows
 * DPAPI 密封在 `~/.dsh/doubao-pool/<id>.dpapi`，池的元数据放在
 * `~/.dsh/doubao-pool.json`。
 *
 * 它自己就是 provider：`doubao-pool`（显示「豆包工作（多账号）」）。模型目录、豆包工作
 * SSE、工具围栏都走本包的 `lib/protocol` + `lib/provider/adapter.js`——那是从
 * dsh-connect-doubao 抄进来（MIT）后改写的自有实现，**不 import 任何宿主包**，
 * 也不 import 豆包插件。停用豆包插件，这里的模型和账号池照常工作。
 *
 * @module dsh-connect-doubao-pool
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as PROTOCOL from "./lib/protocol/index.js";
import { createPoolAdapter, resetConversations, setModelTable } from "./lib/provider/adapter.js";
import { fetchMenuModels, menuCacheInfo } from "./lib/model-menu.js";


const PLUGIN_ID = "dsh-connect-doubao-pool";
const PLUGIN_NAME = "豆包多账号";

// 我们自己的豆包 provider：模型列表挂在我们身上，不跟着豆包插件启停。
const OWN_PROVIDER_ID = "doubao-pool";
const OWN_PROVIDER_DISPLAY_NAME = "豆包工作（多账号）";

/** 只读状态：账号、池开关、上次检测结果。 */
const STATE_PATH = "/plugins/doubao-pool/state";
/** 所有写操作都走这一个 POST，action 在 body 里。 */
const ACTION_PATH = "/plugins/doubao-pool/action";
/** 写操作必须带这个头：跨站表单发不出自定义头，等于一个廉价的 CSRF 闸门。 */
const WRITE_HEADER = "x-dsh-doubao-pool-write";
/** 诊断：客户端模块图快照（排查「设置里看不到这一条」时用）。 */
const DEBUG_PATH = "/plugins/doubao-pool/debug";
/** 豆包模型清单 + 当前启用状态（读上游 catalog，不需要额外登录）。 */
const MODELS_PATH = "/plugins/doubao-pool/models";
const ACCOUNT_ENDPOINT = "https://www.doubao.com/passport/account/info/v2/";
/** 我们自己记「启用了哪些豆包模型」——不写别人的 settings 文件。 */
const OWN_MODELS_FILENAME = "doubao-pool.models.json";

/** 首次打开时的默认勾选：对话两条 + 专家 + 工作任务两条里的主力。 */
const DEFAULT_ENABLED_MODEL_IDS = ["0", "3", "5", "9"];
/** 上游实现新增模型时不必改这里：catalog 读不到才用它兜底。 */
const FALLBACK_MODELS = [
	{ id: "0", name: "豆包 快速", badge: null, rate: null },
	{ id: "3", name: "豆包 2.1 Turbo", badge: "专家", rate: null },
	{ id: "5", name: "豆包 2.1 Pro", badge: "工作任务", rate: { text: "0.65x", kind: "ratio" } },
	{ id: "9", name: "自动", badge: "工作任务", rate: { text: "小额免费", kind: "promo" } }
];
/* ------------------------------------------------------- 协议层（本地自带） */

/**
 * 协议层由本包自带的 `lib/protocol/index.js` 提供——把 dsh-connect-doubao 的豆包
 * 协议实现（MIT）抄进来后重新导出成可读名字，不 import 任何宿主包。
 *
 * 为什么不再 import 豆包插件：`link:` 安装时源码目录里没有 node_modules，兄弟包与
 * `@deepseek-ai/*` 全都解析不到（实测 ERR_MODULE_NOT_FOUND）；抄进来之后这条路
 * 彻底不需要了，豆包插件被停用也不影响我们。
 */
function upstreamModule() {
	return PROTOCOL;
}

/** 池里某个账号的凭据（解封 DPAPI 后的 `{header, pairs}`），交给 adapter 直接用。 */
async function poolCredentialsOf(id) {
	const credentials = await credentialsOf(id);
	return { ok: true, header: credentials.header, pairs: credentials.pairs };
}

/** 当前该用哪个号：activeId 优先，没有就取排序最前的一个。 */
function currentPoolAccount(state) {
	const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
	if (accounts.length === 0) return undefined;
	const active = accounts.find((account) => account.id === state.activeId);
	return active ?? accounts[0];
}

/**
 * adapter 要凭据时走这里：只读池子，不去动豆包插件那份固定登录态。
 *
 * 这样「切号」是事务性的——池子里的 activeId 一变，下一次模型请求就换号。
 */
async function resolvePoolCredentials() {
	const state = readPoolState();
	const account = currentPoolAccount(state);
	if (account === undefined) {
		throw new Error("账号池是空的。请在「豆包多账号」设置里扫码添加一个账号。");
	}
	return poolCredentialsOf(account.id);
}

/**
 * 请求级换号：上游 401/402/403/429/5xx 时把当前号标成不可用并换下一个。
 *
 * 与 `agent/request-error` 那条兜底不冲突：这条在 adapter 里先试，能在一次请求内
 * 重试；那条负责整轮重来。
 */
async function rotatePoolCredentials(error) {
	let state = readPoolState();
	const current = currentPoolAccount(state);
	if (current === undefined) return undefined;
	const target = nextCandidateAccount(state, current.id);
	if (target === undefined) return undefined;
	const detail = error?.status !== undefined ? `HTTP ${error.status}` : (error?.message ?? "request failed");
	const accounts = state.accounts.map((account) => (account.id === current.id ? { ...account, lastStatus: { ok: false, detail: String(detail).slice(0, 120) } } : account));
	state = { ...state, accounts, activeId: target.id };
	writeState(state);
	console.log(`[${PLUGIN_ID}] 请求失败（${detail}），已换号：${current.label} → ${target.label}`);
	try {
		await activateAccount(target.id);
	} catch {}
	return poolCredentialsOf(target.id);
}

/* --------------------------------------------------------------- 池文件 */

/** 导出文件的格式标记：跨机导入时用它挡住别的 JSON。 */
const EXPORT_FORMAT = "dsh-doubao-pool/v1";
const POOL_FILENAME = "doubao-pool.json";
const POOL_DIRNAME = "doubao-pool";
/** 豆包插件认的那份固定登录态（我们切号时会写它，保持两边一致）。 */
const BROWSER_CACHE_FILENAME = "doubao-credentials-browser.dpapi";

function dshHome() {
	return join(homedir(), ".dsh");
}

function poolFile() {
	return join(dshHome(), POOL_FILENAME);
}

function poolDir() {
	return join(dshHome(), POOL_DIRNAME);
}

function liveCredentialPath() {
	return join(dshHome(), BROWSER_CACHE_FILENAME);
}

function ownModelsPath() {
	return join(dshHome(), OWN_MODELS_FILENAME);
}

function accountFile(id) {
	return join(poolDir(), `${id}.dpapi`);
}

/* ----------------------------------------------------------------- DPAPI */

/**
 * DPAPI 必须由 powershell 里的 `ProtectedData` 来做：Node 没有原生实现，而
 * CryptProtectData 的结果绑定当前 Windows 用户——别的用户拿到文件也解不开。
 *
 * 脚本从 stdin 读 base64、往 stdout 写 base64，用前缀区分成败：`-EncodedCommand`
 * 下的退出码不可靠，不能拿它判断。
 */
const DPAPI_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"try {",
	"  Add-Type -AssemblyName System.Security",
	"  $mode = $env:DSH_DPAPI_MODE",
	"  $raw = [Console]::In.ReadToEnd()",
	"  $bytes = [Convert]::FromBase64String($raw.Trim())",
	"  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
	"  if ($mode -eq 'protect') {",
	"    $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)",
	"  } else {",
	"    $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)",
	"  }",
	"  [Console]::Out.Write('DSH_DPAPI_OK:' + [Convert]::ToBase64String($out))",
	"} catch {",
	"  [Console]::Out.Write('DSH_DPAPI_FAIL:' + $_.Exception.Message)",
	"}"
];

/** 只给子进程必要的环境变量：powershell 需要 SystemRoot 等，别的都不透传。 */
const CHILD_ENV_KEYS = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "OS", "PROCESSOR_ARCHITECTURE"];

function childEnv() {
	const env = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = process.env[key];
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

function powershellPath() {
	const root = process.env.SystemRoot ?? "C:\\Windows";
	return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** protect / unprotect 一次，返回字节。失败抛中文错误。 */
async function dpapi(mode, payload) {
	const script = DPAPI_SCRIPT.join("\n");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return await new Promise((resolve, reject) => {
		const child = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
			windowsHide: true,
			env: { ...childEnv(), DSH_DPAPI_MODE: mode }
		});
		const out = [];
		const err = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.on("error", (error) => reject(new Error(`调用 powershell 失败：${error?.message ?? String(error)}`)));
		child.on("close", () => {
			const text = Buffer.concat(out).toString("utf8").trim();
			const mark = text.indexOf("DSH_DPAPI_OK:");
			if (mark === -1) {
				const fail = text.indexOf("DSH_DPAPI_FAIL:");
				const reason = fail === -1 ? Buffer.concat(err).toString("utf8").trim() || text : text.slice(fail + "DSH_DPAPI_FAIL:".length);
				reject(new Error(`DPAPI ${mode} 失败：${reason.slice(0, 300) || "unknown"}`));
				return;
			}
			resolve(Buffer.from(text.slice(mark + "DSH_DPAPI_OK:".length).trim(), "base64"));
		});
		child.stdin.end(Buffer.from(payload).toString("base64"));
	});
}

/* ------------------------------------------------------------- 凭据编解码 */

/** 与豆包插件同一种 payload 形状，换号时它读得懂。 */
function serializeCredentialPayload(pairs) {
	const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
	return { savedAt: Date.now(), source: "browser", header, pairs: [...pairs.entries()] };
}

function parseCredentialPayload(plain) {
	let parsed;
	try {
		parsed = JSON.parse(Buffer.isBuffer(plain) ? plain.toString("utf8").replace(/^\uFEFF/, "") : String(plain).replace(/^\uFEFF/, ""));
	} catch {
		throw new Error("凭据内容不是合法 JSON（文件可能损坏）");
	}
	if (parsed === null || typeof parsed !== "object") throw new Error("凭据内容格式不认识");
	const entries = Array.isArray(parsed.pairs) ? parsed.pairs.filter((entry) => Array.isArray(entry) && entry.length >= 2) : [];
	if (entries.length === 0) throw new Error("凭据里没有 cookie");
	const pairs = new Map(entries.map(([name, value]) => [String(name), String(value)]));
	const header = typeof parsed.header === "string" && parsed.header !== "" ? parsed.header : [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
	return { savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(), source: typeof parsed.source === "string" ? parsed.source : "browser", header, pairs };
}

/** 把某个账号的 cookie 密封存盘（每个号一个文件，互不影响）。 */
async function sealAccount(id, pairs) {
	const sealed = await dpapi("protect", Buffer.from(JSON.stringify(serializeCredentialPayload(pairs)), "utf8"));
	mkdirSync(poolDir(), { recursive: true });
	writeFileSync(accountFile(id), sealed, { mode: 0o600 });
}

/** 解封某个账号的凭据：adapter、探活、额度都走这里。 */
async function credentialsOf(id) {
	const file = accountFile(id);
	if (!existsSync(file)) throw new Error("这个账号的凭据文件不见了（可能被手动删过）");
	const plain = await dpapi("unprotect", readFileSync(file));
	const parsed = parseCredentialPayload(plain);
	return { ok: true, header: parsed.header, pairs: parsed.pairs };
}

/* --------------------------------------------------------------- 池状态 */

function emptyState() {
	return { version: 1, enabled: true, autoSwitch: true, activeId: null, accounts: [], ui: { showComposer: true }, updatedAt: 0 };
}

/** 把磁盘上可能不完整的 JSON 归一成可用状态（字段缺失一律给默认值）。 */
function normalizeState(raw) {
	const state = emptyState();
	if (raw === null || typeof raw !== "object") return state;
	state.enabled = raw.enabled !== false;
	state.autoSwitch = raw.autoSwitch !== false;
	state.ui = { showComposer: raw?.ui?.showComposer !== false };
	const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
	state.accounts = [];
	for (const entry of accounts) {
		if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id === "") continue;
		state.accounts.push({
			id: entry.id,
			label: typeof entry.label === "string" && entry.label !== "" ? entry.label.slice(0, 40) : `豆包账号 ${state.accounts.length + 1}`,
			uid: typeof entry.uid === "string" ? entry.uid : "",
			createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
			lastTestedAt: typeof entry.lastTestedAt === "number" ? entry.lastTestedAt : 0,
			lastStatus: entry.lastStatus !== null && typeof entry.lastStatus === "object" ? { ok: entry.lastStatus.ok === true, detail: typeof entry.lastStatus.detail === "string" ? entry.lastStatus.detail.slice(0, 200) : "" } : null,
			lastQuota: entry.lastQuota !== null && typeof entry.lastQuota === "object" ? entry.lastQuota : null,
			mobile: typeof entry.mobile === "string" ? entry.mobile : "",
			nickname: typeof entry.nickname === "string" ? entry.nickname : "",
			userId: typeof entry.userId === "string" ? entry.userId : "",
			secUserId: typeof entry.secUserId === "string" ? entry.secUserId : "",
			enabled: entry.enabled !== false
		});
	}
	state.activeId = typeof raw.activeId === "string" && state.accounts.some((account) => account.id === raw.activeId) ? raw.activeId : null;
	state.updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
	return state;
}

function readState() {
	try {
		const raw = readFileSync(poolFile(), "utf8").replace(/^\uFEFF/, "");
		return normalizeState(JSON.parse(raw));
	} catch {
		return emptyState();
	}
}

/** 对外（测试 / 其他模块）读池子状态的名字。 */
function readPoolState() {
	return readState();
}

function writeState(state) {
	state.updatedAt = Date.now();
	const file = poolFile();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	return state;
}


/** 当前豆包插件认的那份登录态在不在。 */
function liveCredentialPresent() {
	try {
		return existsSync(liveCredentialPath()) && statSync(liveCredentialPath()).size > 0;
	} catch {
		return false;
	}
}

/** 把「豆包插件当前登录态」解出来（用于收进池子）。 */
async function readLiveCredentials() {
	const file = liveCredentialPath();
	if (!existsSync(file)) throw new Error("豆包插件还没有浏览器登录态。请先点「扫码添加账号」登录一次。");
	const plain = await dpapi("unprotect", readFileSync(file));
	return parseCredentialPayload(plain);
}

/** 让目标账号成为豆包插件的当前账号。 */
async function activateAccount(id) {
	const upstream = await upstreamModule();
	const credentials = await credentialsOf(id);
	upstream.saveBrowserCredentials(credentials.pairs);
	upstream.invalidateCredentialCache?.();
	upstream.invalidateQuotaCache?.();
	return credentials;
}

/* ------------------------------------------------------- 额度与状态摘要 */

/** 把豆包插件的额度对象压成一行能显示的东西。 */
function summarizeQuota(quota) {
	if (quota === null || typeof quota !== "object") return null;
	if (typeof quota.error === "string" && quota.error !== "") return { error: quota.error, fetchedAt: Date.now() };
	const windows = Array.isArray(quota.windows) ? quota.windows : [];
	const byType = (type) => windows.find((entry) => entry?.type === type);
	const primary = byType("package") ?? byType("five_hour") ?? windows[0];
	const total = typeof primary?.totalAmount === "number" ? primary.totalAmount : null;
	const used = typeof primary?.usedAmount === "number" ? primary.usedAmount : null;
	return {
		plan: typeof quota.plan === "string" ? quota.plan : null,
		planActive: quota.planActive !== false,
		exhausted: quota.exhausted === true,
		...(total === null ? {} : { totalAmount: total }),
		...(used === null ? {} : { usedAmount: used }),
		remainingAmount: total !== null && used !== null ? Math.max(0, total - used) : null,
		remainingPercent: primary !== void 0 && typeof primary.remainingPercent === "number" ? Math.round(primary.remainingPercent) : null,
		resetsAt: primary !== void 0 && typeof primary.resetsAt === "number" ? primary.resetsAt : null,
		resetUnknown: primary?.resetUnknown === true,
		startsOnUse: primary?.startsOnUse === true,
		windows: windows.map((entry) => ({
			type: String(entry?.type ?? "unknown"),
			label: typeof entry?.label === "string" ? entry.label : null,
			remainingPercent: typeof entry?.remainingPercent === "number" ? Math.round(entry.remainingPercent) : null,
			resetsAt: typeof entry?.resetsAt === "number" ? entry.resetsAt : null,
			resetUnknown: entry?.resetUnknown === true,
			startsOnUse: entry?.startsOnUse === true
		})),
		fetchedAt: typeof quota.fetchedAt === "number" ? quota.fetchedAt : Date.now()
	};
}

/**
 * 读一次账号资料，只为拿打码手机号 / 昵称 —— 面板里要像 WorkBuddy 那样一行一个号。
 * 豆包 `/passport/account/info/v2/` 返回的 `mobile` 本身就是打码的（`155******13`）。
 */
async function fetchAccountMeta(credentials) {
	const response = await fetch(PROTOCOL.buildQueryUrl(ACCOUNT_ENDPOINT, credentials.pairs.get("msToken")), {
		headers: PROTOCOL.buildHeaders(credentials, { accept: "application/json" })
	});
	if (!response.ok) return {};
	const payload = await response.json();
	const data = payload?.data ?? {};
	return {
		mobile: typeof data.mobile === "string" ? data.mobile : "",
		name: typeof data.name === "string" ? data.name : "",
		// user_id_str 是账号级身份：同一个号重新扫码一次，uid_tt 会变、user_id 不会。
		userId: String(data.user_id_str ?? data.user_id ?? ""),
		secUserId: typeof data.sec_user_id === "string" ? data.sec_user_id : ""
	};
}

/**
 * 检测一个账号：可用性 + 额度，两件事并行。
 * 任何一侧失败都记进结果，不抛——批量检测不能因为一个坏号中断。
 */
async function probeAccountById(id) {
	const upstream = await upstreamModule();
	const credentials = await credentialsOf(id);
	const [probe, quota, meta] = await Promise.all([
		Promise.resolve()
			.then(() => upstream.probeAccount?.(credentials))
			.then((result) => (result === void 0 ? { ok: true, detail: "未检查" } : result))
			.catch((error) => ({ ok: false, detail: error?.message ?? String(error) })),
		Promise.resolve()
			.then(() => upstream.fetchQuota({ credentials, force: true }))
			.catch((error) => ({ error: error?.message ?? String(error) })),
		Promise.resolve()
			.then(() => fetchAccountMeta(credentials))
			.catch(() => ({}))
	]);
	return {
		lastTestedAt: Date.now(),
		lastStatus: {
			ok: probe?.ok === true,
			detail: typeof probe?.detail === "string" ? probe.detail.slice(0, 200) : ""
		},
		lastQuota: summarizeQuota(quota),
		// 顺手把会话标识刷成当前 cookie 里的值：`uid_tt` 会随重扫码变化，
		// 只留旧值会让人以为库里的号和文件里的号不是同一个。
		...(identityOf(credentials) === "" ? {} : { uid: identityOf(credentials) }),
		...(typeof meta?.mobile === "string" && meta.mobile !== "" ? { mobile: meta.mobile } : {}),
		...(typeof meta?.name === "string" && meta.name !== "" ? { nickname: meta.name } : {}),
		...(typeof meta?.userId === "string" && meta.userId !== "" ? { userId: meta.userId } : {}),
		...(typeof meta?.secUserId === "string" && meta.secUserId !== "" ? { secUserId: meta.secUserId } : {})
	};
}

/** 账号 id：时间戳 + 随机串，排序稳定、可读。 */
function newAccountId() {
	return `acc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** 从 cookie 里猜一个身份标签，用来避免同一个号被收两遍。 */
function identityOf(credentials) {
	const pairs = credentials.pairs;
	return pairs.get("uid_tt") ?? pairs.get("uid_tt_ss") ?? pairs.get("sessionid_ss")?.slice(0, 12) ?? pairs.get("sessionid")?.slice(0, 12) ?? "";
}

/**
 * 一个账号在池子里的唯一键。
 *
 * 优先级很重要：`uid_tt` 是**登录会话**级的 cookie，同一个号重新扫一次码就会换一个，
 * 拿它当身份就会把「同一个号」收成两条（表现就是池子里躺着两行一模一样的手机号）。
 * 所以先用账号级的 `userId`（account/info 的 `user_id_str`），再退到手机号+昵称，
 * 最后才用 cookie 里的会话标识兜底。
 */
function dedupeKeyOf(account) {
	if (typeof account.userId === "string" && account.userId !== "") return `u:${account.userId}`;
	const mobile = typeof account.mobile === "string" ? account.mobile : "";
	const nickname = typeof account.nickname === "string" ? account.nickname : "";
	if (mobile !== "" && nickname !== "") return `m:${mobile}|${nickname}`;
	if (mobile !== "") return `m:${mobile}`;
	return typeof account.uid === "string" && account.uid !== "" ? `i:${account.uid}` : "";
}

/**
 * 合并池子里的重复账号（同一个号被收了两份的情况）。
 *
 * 保留加入最早的那一条（用户已经给它起过名字、排过序），但用较新那份登录态覆盖它的
 * cookie —— 后登录的那份更可能还有效。返回合并掉的条数。
 */
function mergeDuplicates(state) {
	/** 每组先定一个赢家：加入最早的那一条（用户已经给它起过名字、排过序）。 */
	const winners = new Map();
	for (const account of state.accounts) {
		const key = dedupeKeyOf(account);
		if (key === "") continue;
		const current = winners.get(key);
		if (current === undefined || (account.createdAt ?? 0) < (current.createdAt ?? 0)) winners.set(key, account);
	}
	const kept = [];
	let merged = 0;
	for (const account of state.accounts) {
		const key = dedupeKeyOf(account);
		const winner = key === "" ? undefined : winners.get(key);
		if (winner === undefined || winner === account) {
			kept.push(account);
			continue;
		}
		// 用较新那份登录态覆盖赢家的 cookie：后登录的那份更可能还有效。
		const later = (account.createdAt ?? 0) > (winner.createdAt ?? 0) ? account : winner;
		const latestTest = Math.max(winner.lastTestedAt ?? 0, account.lastTestedAt ?? 0);
		const latestQuota = (account.lastTestedAt ?? 0) >= (winner.lastTestedAt ?? 0) ? account.lastQuota : winner.lastQuota;
		winner.lastTestedAt = latestTest;
		const newerStatus = later.lastStatus ?? null;
		if (newerStatus !== null) winner.lastStatus = newerStatus;
		winner.lastQuota = latestQuota ?? winner.lastQuota ?? null;
		winner.mobile = winner.mobile || account.mobile;
		winner.nickname = winner.nickname || account.nickname;
		winner.userId = winner.userId || account.userId;
		winner.secUserId = winner.secUserId || account.secUserId;
		try {
			if (later.id !== winner.id && existsSync(accountFile(later.id))) copyFileSync(accountFile(later.id), accountFile(winner.id));
			if (account.id !== winner.id) unlinkSync(accountFile(account.id));
		} catch {}
		if (account.id === state.activeId) state.activeId = winner.id;
		merged += 1;
	}
	if (merged === 0) return 0;
	state.accounts = kept;
	if (state.activeId !== null && kept.some((account) => account.id === state.activeId) === false) {
		state.activeId = kept[0]?.id ?? null;
	}
	return merged;
}

/* -------------------------------------------------------------- 视图 */

function viewOf(state) {
	return {
		ok: true,
		plugin: PLUGIN_ID,
		enabled: state.enabled,
		autoSwitch: state.autoSwitch,
		activeId: state.activeId,
		liveCredentialPresent: liveCredentialPresent(),
		updatedAt: state.updatedAt,
		ui: state.ui,
		activeAccount: (() => {
			const active = state.accounts.find((account) => account.id === state.activeId);
			if (active === void 0) return null;
			return {
				id: active.id,
				label: active.label,
				order: state.accounts.indexOf(active) + 1,
				quota: active.lastQuota,
				mobile: active.mobile ?? "",
				nickname: active.nickname ?? "",
				status: active.lastStatus
			};
		})(),
		accounts: state.accounts.map((account, index) => ({
			id: account.id,
			label: account.label,
			uid: account.uid,
			order: index + 1,
			active: account.id === state.activeId,
			createdAt: account.createdAt,
			lastTestedAt: account.lastTestedAt,
			status: account.lastStatus,
			quota: account.lastQuota,
			mobile: account.mobile ?? "",
			nickname: account.nickname ?? "",
			userId: account.userId ?? ""
		}))
	};
}

/* ------------------------------------------------------------- 动作实现 */

function requireAccount(state, id) {
	const account = state.accounts.find((entry) => entry.id === id);
	if (account === void 0) throw new Error("这个账号不在池子里（可能已被删除）");
	return account;
}

/**
 * 把豆包插件当前的登录态收进池子。
 *
 * 收完要把「原来的当前账号」写回去：豆包插件的扫码登录会覆盖它那份固定文件，
 * 如果我不还原，扫码加号这个动作会顺手把用户正在用的账号换掉。
 */
/**
 * 把一份 cookie 归到池子里（同一个 uid 就覆盖，否则建新条目），返回账号 id。
 *
 * 「扫码加号」和「收下当前登录态」都走这里——两条路径唯一的区别是 cookie 从哪来。
 */
async function adoptAccount(state, pairs, header, payload) {
	const identity = identityOf({ ok: true, header, pairs });
	const existing = identity === "" ? void 0 : state.accounts.find((entry) => entry.uid === identity);
	const wantedLabel = typeof payload?.label === "string" && payload.label.trim() !== "" ? payload.label.trim().slice(0, 40) : "";
	if (existing !== void 0) {
		await sealAccount(existing.id, pairs);
		existing.uid = identity;
		if (wantedLabel !== "") existing.label = wantedLabel;
		return existing.id;
	}
	const accountId = newAccountId();
	await sealAccount(accountId, pairs);
	state.accounts.push({
		id: accountId,
		label: wantedLabel !== "" ? wantedLabel : `豆包账号 ${state.accounts.length + 1}`,
		uid: identity,
		createdAt: Date.now(),
		lastTestedAt: 0,
		lastStatus: null,
		lastQuota: null
	});
	return accountId;
}

async function actionImportCurrent(payload) {
	const state = readState();
	const live = await readLiveCredentials();
	const previousActiveId = state.activeId;
	const accountId = await adoptAccount(state, live.pairs, live.header, payload);

	// 新收进来的号先测一遍，用户马上就能看到它能不能用。
	const probe = await probeAccountById(accountId).catch((error) => ({
		lastTestedAt: Date.now(),
		lastStatus: { ok: false, detail: error?.message ?? String(error) },
		lastQuota: null
	}));
	Object.assign(requireAccount(state, accountId), probe);
	// 同一个号重新扫码会带来新的 uid_tt：靠 user_id 把它并回原来那条，别长出新行。
	mergeDuplicates(state);

	state.activeId = accountId;
	let restored = false;
	if (previousActiveId !== null && previousActiveId !== accountId && state.accounts.some((entry) => entry.id === previousActiveId)) {
		try {
			await activateAccount(previousActiveId);
			state.activeId = previousActiveId;
			restored = true;
		} catch {
			// 还原失败就把当前号留着：宁可池子记录新号，也不能让豆包插件处于半死状态。
		}
	}
	const saved = writeState(state);
	return { view: viewOf(saved), message: restored ? "已收进池子；当前使用账号保持不变" : "已收进池子，并切换为当前使用账号" };
}

/**
 * 扫码加号：自己拉起浏览器扫码，不再依赖豆包插件的 `/auth` 路由。
 *
 * `browserLogin()` 会把 Chromium 起在专用 user-data-dir 上，用户扫完码我们从 CDP
 * 把 cookie 捞回来，直接进池子——原来的当前账号不受影响。
 */
async function actionLogin(payload) {
	const result = await PROTOCOL.browserLogin({});
	if (result?.ok !== true) throw new Error(result?.reason ?? "浏览器登录没有完成。");
	const state = readState();
	const previousActiveId = state.activeId;
	const accountId = await adoptAccount(state, result.pairs, result.header, payload);

	const probe = await probeAccountById(accountId).catch((error) => ({
		lastTestedAt: Date.now(),
		lastStatus: { ok: false, detail: error?.message ?? String(error) },
		lastQuota: null
	}));
	Object.assign(requireAccount(state, accountId), probe);
	mergeDuplicates(state);

	// 新号只是进池子，不许把用户正在用的号踢掉。
	state.activeId = previousActiveId !== null && state.accounts.some((entry) => entry.id === previousActiveId) ? previousActiveId : accountId;
	const saved = writeState(state);
	const label = requireAccount(saved, accountId).label;
	const status = probe.lastStatus?.ok === true ? "可用" : `不可用（${probe.lastStatus?.detail ?? "未知原因"}）`;
	return { view: viewOf(saved), message: `已添加「${label}」，检测结果：${status}` };
}

async function actionSwitch(payload) {
	const state = readState();
	const account = requireAccount(state, payload?.id);
	await activateAccount(account.id);
	state.activeId = account.id;
	const saved = writeState(state);
	return { view: viewOf(saved), message: `已切换到「${account.label}」` };
}

async function actionTest(payload) {
	const state = readState();
	const targets = Array.isArray(payload?.ids) && payload.ids.length > 0 ? payload.ids.map((id) => requireAccount(state, id)) : payload?.id === void 0 ? state.accounts : [requireAccount(state, payload.id)];
	let ok = 0;
	let failed = 0;
	for (const account of targets) {
		try {
			const probe = await probeAccountById(account.id);
			Object.assign(account, probe);
			if (probe.lastStatus?.ok === true && (probe.lastQuota?.error === void 0 || probe.lastQuota === null)) ok += 1;
			else failed += 1;
		} catch (error) {
			account.lastTestedAt = Date.now();
			account.lastStatus = { ok: false, detail: error?.message ?? String(error) };
			failed += 1;
		}
	}
	const merged = mergeDuplicates(state);
	const saved = writeState(state);
	const suffix = merged > 0 ? `；顺手合并了 ${merged} 个重复账号` : "";
	return { view: viewOf(saved), message: `检测完成：${ok} 个可用${failed > 0 ? `，${failed} 个异常` : ""}${suffix}` };
}

/**
 * 合并重复账号。
 *
 * 检测、收号、导入之后都会自动跑一遍；这个动作是留给用户手动收拾旧数据的
 * （改版前用 uid_tt 当身份时会把同一个号收成两三条）。
 */
async function actionDedupe() {
	const state = readState();
	const before = state.accounts.length;
	const merged = mergeDuplicates(state);
	if (merged === 0) return { view: viewOf(state), message: "没有重复账号" };
	const saved = writeState(state);
	return { view: viewOf(saved), message: `已合并 ${merged} 个重复账号（${before} → ${saved.accounts.length}）` };
}

async function actionDelete(payload) {
	const state = readState();
	const account = requireAccount(state, payload?.id);
	state.accounts = state.accounts.filter((entry) => entry.id !== account.id);
	try {
		unlinkSync(sealedPathOf(account.id));
	} catch {}
	let message = `已删除「${account.label}」`;
	if (state.activeId === account.id) {
		state.activeId = null;
		const fallback = state.accounts[0];
		if (fallback !== void 0) {
			try {
				await activateAccount(fallback.id);
				state.activeId = fallback.id;
				message += `，已切换到「${fallback.label}」`;
			} catch {
				message += "，但没能自动切换，请在列表里手动选一个";
			}
		}
	}
	const saved = writeState(state);
	return { view: viewOf(saved), message };
}

function actionReorder(payload) {
	const state = readState();
	const account = requireAccount(state, payload?.id);
	const index = state.accounts.indexOf(account);
	const direction = payload?.direction === "down" ? 1 : -1;
	const target = index + direction;
	if (target >= 0 && target < state.accounts.length) {
		state.accounts.splice(index, 1);
		state.accounts.splice(target, 0, account);
	}
	const saved = writeState(state);
	return { view: viewOf(saved), message: "" };
}

function actionToggle(payload) {
	const state = readState();
	if (typeof payload?.enabled === "boolean") state.enabled = payload.enabled;
	if (typeof payload?.autoSwitch === "boolean") state.autoSwitch = payload.autoSwitch;
	if (typeof payload?.showComposer === "boolean") state.ui = { ...state.ui, showComposer: payload.showComposer };
	const saved = writeState(state);
	return {
		view: viewOf(saved),
		message:
			typeof payload?.enabled === "boolean"
				? payload.enabled
					? "已启用账号池"
					: "已停用账号池"
				: typeof payload?.autoSwitch === "boolean"
					? payload.autoSwitch
						? "已开启自动挑号"
						: "已关闭自动挑号"
					: typeof payload?.showComposer === "boolean"
						? payload.showComposer
							? "已在输入框工具栏显示额度读数"
							: "已隐藏输入框工具栏的额度读数"
						: ""
	};
}

function actionRelabel(payload) {
	const state = readState();
	const account = requireAccount(state, payload?.id);
	const label = typeof payload?.label === "string" ? payload.label.trim().slice(0, 40) : "";
	account.label = label === "" ? account.label : label;
	const saved = writeState(state);
	return { view: viewOf(saved), message: "" };
}

/**
 * 导出：把每个账号的 DPAPI 密封字节原样带出去。
 *
 * 故意不导明文 cookie——导出的文件只能在同一台机器、同一个 Windows 用户下解开，
 * 这样「导出备份」不会变成一份到处都能用的会话清单。
 */
function actionExport() {
	const state = readState();
	const accounts = [];
	for (const account of state.accounts) {
		const file = sealedPathOf(account.id);
		if (!existsSync(file)) continue;
		accounts.push({
			label: account.label,
			uid: account.uid,
			createdAt: account.createdAt,
			sealed: readFileSync(file).toString("base64")
		});
	}
	const content = JSON.stringify({ format: EXPORT_FORMAT, exportedAt: Date.now(), accounts }, null, 2);
	return {
		view: viewOf(state),
		message: `已导出 ${accounts.length} 个账号`,
		download: {
			filename: `doubao-pool-${new Date().toISOString().slice(0, 10)}.json`,
			mime: "application/json;charset=utf-8",
			content
		}
	};
}

async function actionImport(payload) {
	const raw = payload?.data;
	if (typeof raw !== "string" || raw.trim() === "") throw new Error("没有拿到要导入的内容");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("导入内容不是合法 JSON");
	}
	if (parsed?.format !== EXPORT_FORMAT || !Array.isArray(parsed?.accounts)) {
		throw new Error(`导入内容格式不认识：需要 ${EXPORT_FORMAT}`);
	}
	const state = readState();
	let added = 0;
	let skipped = 0;
	for (const entry of parsed.accounts) {
		if (typeof entry?.sealed !== "string" || entry.sealed === "") {
			skipped += 1;
			continue;
		}
		let sealed;
		try {
			sealed = Buffer.from(entry.sealed, "base64");
		} catch {
			skipped += 1;
			continue;
		}
		// 只有能解开的才收：解不开说明是别的机器/别的用户导出的，收进来也只是个坏号。
		let parsedPayload;
		try {
			parsedPayload = parseCredentialPayload(await dpapi("unprotect", sealed));
		} catch {
			skipped += 1;
			continue;
		}
		const identity = identityOf({ pairs: parsedPayload.pairs });
		if (identity !== "" && state.accounts.some((existing) => existing.uid === identity)) {
			skipped += 1;
			continue;
		}
		const id = newAccountId();
		mkdirSync(poolDir(), { recursive: true });
		writeFileSync(sealedPathOf(id), sealed, { mode: 0o600 });
		state.accounts.push({
			id,
			label: typeof entry.label === "string" && entry.label !== "" ? entry.label.slice(0, 40) : `豆包账号 ${state.accounts.length + 1}`,
			uid: identity,
			createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
			lastTestedAt: 0,
			lastStatus: null,
			lastQuota: null
		});
		added += 1;
	}
	// 池子原来是空的（比如刚删光又导入）：把第一个号设成当前使用，别让豆包插件挂在别人的登录态上。
	if (state.activeId === null && state.accounts.length > 0) {
		try {
			await activateAccount(state.accounts[0].id);
			state.activeId = state.accounts[0].id;
		} catch {}
	}
	const merged = mergeDuplicates(state);
	const saved = writeState(state);
	return {
		view: viewOf(saved),
		message: `导入完成：新增 ${added} 个${skipped > 0 ? `，跳过 ${skipped} 个（重复或解不开）` : ""}${merged > 0 ? `，合并 ${merged} 个重复` : ""}`
	};
}

/** 兜底：清理池目录里没有登记过的密封文件（崩溃/手滑留下的孤儿）。 */
function actionGc() {
	const state = readState();
	const known = new Set(state.accounts.map((account) => `${account.id}.dpapi`));
	let removed = 0;
	try {
		for (const name of readdirSync(poolDir())) {
			if (!name.endsWith(".dpapi") || known.has(name)) continue;
			try {
				unlinkSync(join(poolDir(), name));
				removed += 1;
			} catch {}
		}
	} catch {}
	return { view: viewOf(state), message: removed === 0 ? "没有需要清理的文件" : `清理了 ${removed} 个孤立文件` };
}

/**
 * 保存「启用哪些豆包模型」。deps 里带宿主自己的 origin：同一进程内的上游路由要
 * 走一遍 HTTP，才能触发它那边的重配逻辑（等价于用户在它的卡片里点保存）。
 */
async function actionSaveModels(payload, deps) {
	const ids = Array.isArray(payload?.ids) ? payload.ids.map((id) => String(id)) : [];
	const enabled = await saveEnabledModelIds(ids, deps?.origin ?? "");
	const message = enabled.length === 0
		? "已保存：模型选择器里不再出现豆包模型"
		: `已保存 ${enabled.length} 个豆包模型，模型选择器里现在能选到了`;
	return { enabled, provider: ownProvider()?.providerId ?? OWN_PROVIDER_ID, message };
}

/**
 * 自动排序：照 WorkBuddy 的规则挑「最该排前面」的顺序。
 *
 * 可用优先 → 额度快过期的先花（resetAt 早的靠前）→ 额度高的靠前 → 新收的靠前。
 * 只改顺序，不动当前使用账号。
 */
function actionAutoOrder() {
	const state = readState();
	const score = (account) => {
		const ok = account.lastStatus?.ok === true ? 0 : 1;
		const resets = typeof account.lastQuota?.resetsAt === "number" ? account.lastQuota.resetsAt : Number.MAX_SAFE_INTEGER;
		const remaining = typeof account.lastQuota?.remainingPercent === "number" ? -account.lastQuota.remainingPercent : 0;
		return [ok, resets, remaining, -(account.createdAt ?? 0)];
	};
	const sorted = [...state.accounts].sort((left, right) => {
		const a = score(left);
		const b = score(right);
		for (let index = 0; index < a.length; index += 1) {
			if (a[index] !== b[index]) return a[index] - b[index];
		}
		return 0;
	});
	state.accounts = sorted;
	const saved = writeState(state);
	return { view: viewOf(saved), message: "已按「可用 → 快过期 → 额度高 → 新号」重新排序" };
}

/** 一键随机：把顺序打散（WorkBuddy 的「一键随机」）。 */
function actionShuffle() {
	const state = readState();
	const shuffled = [...state.accounts];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const pick = randomBytes(2).readUInt16BE(0) % (index + 1);
		const swap = shuffled[index];
		shuffled[index] = shuffled[pick];
		shuffled[pick] = swap;
	}
	state.accounts = shuffled;
	const saved = writeState(state);
	return { view: viewOf(saved), message: "已随机打乱账号顺序" };
}

const ACTIONS = {
	"import-current": actionImportCurrent,
	login: actionLogin,
	switch: actionSwitch,
	test: actionTest,
	"test-all": async (payload) => actionTest({ ids: Array.isArray(payload?.ids) ? payload.ids : void 0 }),
	delete: actionDelete,
	reorder: actionReorder,
	"auto-order": async () => actionAutoOrder(),
	shuffle: async () => actionShuffle(),
	toggle: actionToggle,
	relabel: actionRelabel,
	"save-models": actionSaveModels,
	export: async () => actionExport(),
	import: actionImport,
	gc: async () => actionGc(),
	dedupe: async () => actionDedupe()
};

/* ---------------------------------------------------------------- 路由 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function loopbackHostHeader(req) {
	const host = req.headers.host;
	if (host === void 0 || host.trim() === "") return false;
	try {
		const { hostname } = new URL(`http://${host}`);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}

function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

/**
 * 所有路由共用的一道闸。
 *
 * 顺序有讲究：先做便宜的头部检查，被拒的请求既碰不到磁盘也碰不到凭据。
 */
function guard(req, res, options = {}) {
	if (!loopbackHostHeader(req)) {
		sendJson(res, 403, { error: "host-not-loopback" });
		return false;
	}
	if (req.headers["sec-fetch-site"] === "cross-site") {
		sendJson(res, 403, { error: "origin-not-trusted" });
		return false;
	}
	if (!loopbackOrigin(req)) {
		sendJson(res, 403, { error: "origin-not-trusted" });
		return false;
	}
	if (options.write === true && req.headers[WRITE_HEADER] === void 0) {
		sendJson(res, 403, { error: "missing-write-header" });
		return false;
	}
	return true;
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 4 * 1024 * 1024) {
				reject(new Error("body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve(void 0);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(new Error(`body 不是合法 JSON：${error.message}`));
			}
		});
		req.on("error", reject);
	});
}

function safeMessage(error) {
	return (error?.message ?? "unknown error").slice(0, 300);
}

/** webServer 自己的 origin（`http://127.0.0.1:<port>`），拿不到就空串。 */
function originOf(webServer) {
	try {
		const origin = webServer?.getOrigin?.();
		return typeof origin === "string" ? origin : "";
	} catch {
		return "";
	}
}

/**
 * 诊断用：把宿主当前的客户端模块图摊平出来（只读，不含凭据）。
 *
 * 前端半个插件不进图、或者进了图但注册失败时，从界面上什么都看不出来——
 * 这条路由就是为了让「我的包到底有没有被排进 boot 图」有个能被 curl 到的答案。
 */
function registerDebugRoute(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: DEBUG_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res)) return;
			const report = { ok: true, plugin: PLUGIN_ID, client: null, error: null };
			try {
				const service = typeof ctx.get === "function" ? ctx.get("clientModules") : void 0;
				if (service === void 0) {
					report.error = "clientModules service 未找到";
				} else {
					const graph = await service.graph();
					report.client = {
						rev: graph?.rev ?? null,
						entries: (graph?.entries ?? []).map((entry) => ({
							id: entry.id,
							url: entry.url,
							immediately: entry.immediately === true,
							inject: entry.inject ?? [],
							external: entry.external ?? [],
							mine: entry.id === PLUGIN_ID
						}))
					};
				}
			} catch (error) {
				report.error = safeMessage(error);
			}
			// 模型注册情况：判断「豆包模型有没有真的进选择器」只看这里。
			try {
				const llm = typeof ctx.get === "function" ? ctx.get("llm") : void 0;
				if (llm === void 0) {
					report.llm = { error: "llm service 未找到" };
				} else {
					const providers = await llm.listProviders();
					const wanted = [OWN_PROVIDER_ID, "doubao", "workbuddy"].filter((id) => providers.some((entry) => entry.id === id));
					const models = {};
					for (const provider of wanted) {
						try {
							models[provider] = (await llm.listModels(provider)).map((model) => model.id);
						} catch (error) {
							models[provider] = { error: safeMessage(error) };
						}
					}
					report.llm = { providers: providers.map((entry) => entry.id), models };
				report.ownProvider = { providerId: OWN_PROVIDER_ID, registered: ownProviderHandle !== null, error: ownProviderError };
		report.menu = menuCacheInfo();
				}
			} catch (error) {
				report.llm = { error: safeMessage(error) };
			}
			// Stage 0 闸门：宿主平台包能否在本插件上下文解析（自写 adapter 的前提）。
			try {
				const { probeHostSdk } = await import("./lib/probe-host-sdk.mjs");
				report.hostSdk = await probeHostSdk();
			} catch (error) {
				report.hostSdk = { ok: false, error: safeMessage(error) };
			}
			sendJson(res, 200, report);
		}
	});
}

function registerStateRoute(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: STATE_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res)) return;
			try {
				sendJson(res, 200, viewOf(readState()));
			} catch (error) {
				sendJson(res, 500, { ok: false, error: safeMessage(error) });
			}
		}
	});
}

/**
 * 我们自己记「启用了哪些豆包模型」——不写别人的 settings 文件。
 *
 * 这份文件是唯一的事实来源：provider 的 `listModels()` 同步读它，所以保存后
 * 立刻影响模型选择器。文件不存在时给默认的四条。
 */
function readEnabledModelIds() {
	try {
		const raw = readFileSync(ownModelsPath(), "utf8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed) ? parsed : parsed?.enabled;
		if (!Array.isArray(list)) return [...DEFAULT_ENABLED_MODEL_IDS];
		return list.map((id) => String(id));
	} catch {
		return [...DEFAULT_ENABLED_MODEL_IDS];
	}
}

function writeEnabledModelIds(ids) {
	const clean = ids.map((id) => String(id));
	mkdirSync(dirname(ownModelsPath()), { recursive: true });
	writeFileSync(ownModelsPath(), JSON.stringify({ enabled: clean, updatedAt: Date.now() }, undefined, 2), { mode: 0o600 });
	return clean;
}

/** 保存勾选：立刻作用到自建 provider 的内存副本，再落盘。 */
async function saveEnabledModelIds(ids, _origin) {
	const clean = writeEnabledModelIds(ids);
	ownProvider()?.setEnabledModelIds?.(clean);
	ownProvider()?.invalidate?.();
	return clean;
}

/**
 * 完整豆包模型目录：把豆包自己的模型菜单（自家 5 个 + 工作任务那套第三方模型）
 * 和静态清单合并，并顺手更新 provider 认的模型表。
 *
 * 第三方模型（`person-deepseek-v4-1-flash-261017`、`person-glm-5-4`、
 * `person-kimi-k3-1-pro-261111`、`person-qwen4-max` …）没有静态常量，只能拿池里
 * 当前账号的凭据去问豆包的模型菜单——所以这里是 async，且失败时静默回落静态清单。
 */
let catalogError = null;

async function ownCatalog(options = {}) {
	const staticEntries = PROTOCOL.doubaoCatalogEntries();
	let credentials;
	try {
		credentials = await resolvePoolCredentials();
		catalogError = null;
	} catch (error) {
		credentials = undefined;
		catalogError = safeMessage(error);
	}
	const menu = await fetchMenuModels({ credentials, force: options.force === true });
	if (menu.entries.length === 0) {
		setModelTable(staticEntries);
		return { entries: staticEntries, menuCount: 0, staticOnly: true };
	}
	const staticById = new Map(staticEntries.map((entry) => [String(entry.id), entry]));
	const merged = [];
	const seen = new Set();
	for (const item of menu.entries) {
		const key = String(item.key);
		if (seen.has(key)) continue;
		seen.add(key);
		const known = staticById.get(key);
		const badge = known?.badge ?? (item.taskOnly === true ? "工作任务" : undefined);
		merged.push({
			id: key,
			name: known?.name ?? item.name,
			...(badge === undefined ? {} : { badge }),
			rate: item.rate ?? known?.rate ?? null,
			reasoning: known?.reasoning ?? true,
			taskMode: item.taskOnly === true || known?.taskMode === true,
			...(known?.reasoningLevels === undefined ? {} : { reasoningLevels: known.reasoningLevels })
		});
	}
	for (const entry of staticEntries) {
		if (seen.has(String(entry.id))) continue;
		merged.push({ ...entry, taskMode: entry.taskMode === true, reasoning: entry.reasoning ?? true });
	}
	setModelTable(merged);
	return { entries: merged, menuCount: menu.entries.length, staticOnly: false };
}

/** 把目录条目 + 勾选状态整理成前端要的形状。 */
function modelsView(catalog, enabled) {
	const set = new Set(enabled.map((id) => String(id)));
	return catalog.map((entry) => ({
		id: entry.id,
		name: entry.name,
		badge: entry.badge,
		rate: entry.rate === null ? undefined : entry.rate,
		enabled: set.has(String(entry.id))
	}));
}

/**
 * 模型清单：自家目录 + 自己的勾选记录。
 *
 * catalog 走 `lib/protocol` 的纯函数，不依赖豆包插件；万一它抛错就退回内置的
 * 四条豆包模型，至少让用户能勾。
 */
function registerModelsRoute(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: MODELS_PATH,
		handler: async (req, res) => {
			try {
				if (req.method !== "GET") {
					sendJson(res, 405, { error: "method not allowed" });
					return;
				}
				if (!guard(req, res)) return;
				const forceRefresh = String(req.url ?? "").includes("refresh=1");
				const enabled = readEnabledModelIds();
				const provider = ownProvider();
				const meta = {
					provider: provider?.providerId ?? OWN_PROVIDER_ID,
					providerName: OWN_PROVIDER_DISPLAY_NAME,
					providerOwned: provider?.owns === true,
					registered: provider !== null
				};
				let catalog;
				let warning;
				try {
					catalog = (await ownCatalog({ force: forceRefresh })).entries;
				} catch (error) {
					catalog = FALLBACK_MODELS;
					warning = safeMessage(error);
				}
				sendJson(res, 200, {
					ok: true,
					source: catalog === FALLBACK_MODELS ? "fallback" : "own",
					...meta,
					enabled,
					models: modelsView(catalog, enabled),
					...(catalogError === null ? {} : { catalogError }),
					...(warning === undefined ? {} : { warning })
				});
			} catch (error) {
				sendJson(res, 500, { ok: false, error: safeMessage(error) });
			}
		}
	});
}

function registerActionRoute(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: ACTION_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			if (!guard(req, res, { write: true })) return;
			try {
				const body = await readJsonBody(req);
				const action = typeof body?.action === "string" ? body.action : "";
				const run = ACTIONS[action];
				if (run === void 0) {
					sendJson(res, 400, { ok: false, error: `action must be one of: ${Object.keys(ACTIONS).join(", ")}` });
					return;
				}
				const result = await run(body, { origin: originOf(ctx.webServer) });
				sendJson(res, 200, { ok: true, action, ...result });
			} catch (error) {
				sendJson(res, 500, { ok: false, errorName: error?.name ?? "unknown", error: safeMessage(error) });
			}
		}
	});
}

/* ------------------------------------------------------------ 失败自动换号 */

const ROTATION_WINDOW_MS = 10 * 60 * 1000;
const ROTATION_MAX_PER_WINDOW = 3;
const rotationLog = new Map();

/**
 * 这次模型请求的失败，值不值得换号？
 *
 * 换号是有代价的（要跑一次 DPAPI + 改豆包插件的登录态），所以只认「换个人就能成」的错：
 * 认证过期、没额度、限流、网关 5xx。请求体本身有问题（400/422）换谁都一样，不换。
 */
function isRotatableFailure(failure) {
	if (failure === null || typeof failure !== "object") return false;
	const status = failure.status;
	if (typeof status === "number") {
		if (status === 401 || status === 402 || status === 403 || status === 408 || status === 429) return true;
		if (status >= 500 && status <= 599) return true;
		if (status >= 400 && status < 500) return false;
	}
	const code = String(failure.code ?? "").toLowerCase();
	return /401|402|403|429|unauthor|forbidden|quota|rate.?limit|session.?expired|invalid.?session|server.?error|overload/.test(code);
}

function allowRotation(agentId) {
	const now = Date.now();
	const entry = rotationLog.get(agentId);
	if (entry === void 0 || now - entry.startedAt > ROTATION_WINDOW_MS) {
		rotationLog.set(agentId, { startedAt: now, count: 1 });
		return true;
	}
	if (entry.count >= ROTATION_MAX_PER_WINDOW) return false;
	entry.count += 1;
	return true;
}

/**
 * 从当前账号往后挑下一个还能用的号。
 *
 * 顺序就是池子里的顺序（用户可以上下调），跳过当前正被判定失败的那个；
 * 已知不可用的号不参与，除非整池都不行——那种情况换谁都没意义，直接放弃。
 */
function nextCandidateAccount(state, excludedId) {
	const usable = state.accounts.filter((account) => account.id !== excludedId && account.enabled !== false);
	if (usable.length === 0) return void 0;
	const healthy = usable.filter((account) => account.lastStatus?.ok !== false);
	const list = healthy.length > 0 ? healthy : usable;
	const currentIndex = state.accounts.findIndex((account) => account.id === state.activeId);
	const ordered = currentIndex < 0 ? list : [...state.accounts.slice(currentIndex + 1), ...state.accounts.slice(0, currentIndex + 1)].filter((account) => list.includes(account));
	return ordered[0] ?? list[0];
}

/**
 * 挂到 `agent/request-error` 上：豆包报「这个号不能用了」，就换成池子里的下一个号重试。
 *
 * 为什么是这个事件——它是每次模型请求失败后的 waterfall，返回 `{ kind: "retry" }`
 * 就能让 agent 用新凭据再发一次，不需要用户手动点任何东西。
 */
function installAutoSwitch(ctx) {
	ctx.on("agent/request-error", async (payload, next) => {
		try {
			const state = readState();
			if (state.enabled !== true || state.autoSwitch !== true) return next();
			if (state.accounts.length < 2) return next();
			const provider = providerId();
			const failedProvider = String(payload?.provider ?? "");
			if (provider !== "" && failedProvider !== "" && failedProvider !== provider) return next();
			if (!isRotatableFailure(payload?.failure)) return next();

			const agentId = String(payload?.agent?.id ?? "unknown");
			if (!allowRotation(agentId)) return next();

			const failingId = state.activeId;
			const target = nextCandidateAccount(state, failingId);
			if (target === void 0) return next();

			await activateAccount(target.id);
			state.activeId = target.id;
			const failing = state.accounts.find((account) => account.id === failingId);
			if (failing !== void 0) {
				failing.lastTestedAt = Date.now();
				failing.lastStatus = {
					ok: false,
					detail: `HTTP ${payload?.failure?.status ?? "?"} ${String(payload?.failure?.code ?? "").slice(0, 40)}`.trim()
				};
			}
			writeState(state);
			console.log(`[${PLUGIN_ID}] 豆包请求失败，已从「${failing?.label ?? failingId}」切到「${target.label}」并重试`);
			return { kind: "retry" };
		} catch (error) {
			console.warn(`[${PLUGIN_ID}] 自动换号失败：${error?.message ?? String(error)}`);
			return next();
		}
	});
}

let cachedProviderId;
function providerId() {
	if (cachedProviderId !== void 0) return cachedProviderId;
	try {
		cachedProviderId = String(upstreamModule().DOUBAO_PROVIDER ?? "");
	} catch {
		cachedProviderId = "";
	}
	return cachedProviderId;
}

/* ------------------------------------------------------------------ 入口 */

/** 自建 provider 的句柄（`{providerId, owns, setEnabledModelIds, invalidate}`），没建起来就是 null。 */
let ownProviderHandle = null;
/** 「豆包模型」勾选的内存副本：保存后立刻生效，不用等下次读盘。 */
let enabledModelOverride = null;
/** 注册自有 provider 时踩到的错（只用于 debug 路由显示，正常运行不该有值）。 */
let ownProviderError = null;

function ownProvider() {
	return ownProviderHandle;
}

/**
 * 我们自己的豆包工作 provider：`doubao-pool`（显示「豆包工作（多账号）」）。
 *
 * 为什么要有：豆包插件的 provider 是单账号的（id `doubao`），模型列表挂在它身上，
 * 停用它模型就没了。WorkBuddy 的做法是自己就是 provider——这里对齐它。adapter 是
 * `lib/provider/adapter.js` 里自研的那份（豆包 SSE → DSH StreamChunk），凭据从账号池
 * 现取，所以：
 *   - 不用装/开豆包插件也能有豆包模型；
 *   - 切号只改池子里的 activeId，不动别人的文件；
 *   - 401/429 之类可以在一次请求内换号重试。
 */
function registerOwnProvider(ctx) {
	ctx.inject(["llm"], (llmCtx) => {
		const llm = llmCtx.llm ?? llmCtx;
		const releases = [];
		const adapter = createPoolAdapter({
			resolveCredentials: resolvePoolCredentials,
			rotateCredentials: rotatePoolCredentials,
			enabledModelIds: () => enabledModelOverride ?? readEnabledModelIds(),
			models: async () => (await ownCatalog()).entries
		});
		ownProviderHandle = {
			providerId: OWN_PROVIDER_ID,
			owns: true,
			setEnabledModelIds: (ids) => {
				enabledModelOverride = Array.isArray(ids) ? ids.map((id) => String(id)) : null;
			},
			invalidate: () => {}
		};
		try {
			releases.push(llm.registerAdapter([OWN_PROVIDER_ID], adapter));
			// 预热模型表：模型选择器可能在任何聊天请求之前就问一次 listModels()。
			// 抓不到模型菜单就保持静态 6 条，不影响能用。
			void ownCatalog().catch(() => {});
			if (typeof llm.registerConfigurableProviders === "function") {
				releases.push(llm.registerConfigurableProviders([{
					provider: OWN_PROVIDER_ID,
					displayName: OWN_PROVIDER_DISPLAY_NAME,
					settingsNs: PLUGIN_ID,
					settingsPath: [],
					declared: false
				}]));
			}
			console.log(`[${PLUGIN_ID}] 已注册自有 provider ${OWN_PROVIDER_ID}（${OWN_PROVIDER_DISPLAY_NAME}）`);
		} catch (error) {
			ownProviderError = `${error?.message ?? String(error)}`;
			console.warn(`[${PLUGIN_ID}] 自有 provider 注册失败：${ownProviderError}`);
			ownProviderHandle = null;
		}
		const effect = typeof llmCtx.effect === "function" ? llmCtx.effect.bind(llmCtx) : ctx.effect.bind(ctx);
		effect(() => () => {
			for (const release of releases) {
				try {
					release?.();
				} catch {}
			}
			ownProviderHandle = null;
		});
	});
}

export function apply(ctx) {
	// 失败自动换号：独立于 webServer，没有路由也要生效。
	try {
		installAutoSwitch(ctx);
	} catch (error) {
		console.warn(`[${PLUGIN_ID}] 自动换号挂钩失败：${error?.message ?? String(error)}`);
	}

	// 自建 provider：模型列表跟着我们走，不受豆包插件启停影响。
	try {
		registerOwnProvider(ctx);
	} catch (error) {
		console.warn(`[${PLUGIN_ID}] 自有 provider 接线失败：${error?.message ?? String(error)}`);
	}

	// `webServer` 不写进 inject 数组：它在 Desktop 上可能永远不出现，写进去会把整个
	// 插件卡在 pending，连设置页那一条都注册不上。改成嵌套 inject，等它来了再挂路由。
	ctx.inject(["webServer"], (webCtx) => {
		const server = webCtx.webServer ?? webCtx;
		const disposers = [];
		try {
			disposers.push(registerStateRoute({ webServer: server }));
			disposers.push(registerActionRoute({ webServer: server }));
			disposers.push(registerModelsRoute({ webServer: server }));
			disposers.push(registerDebugRoute({ webServer: server, get: (name) => ctx.get(name) }));
		} catch (error) {
			console.warn(`[${PLUGIN_ID}] 路由注册失败：${error?.message ?? String(error)}`);
		}
		const effect = typeof webCtx.effect === "function" ? webCtx.effect.bind(webCtx) : ctx.effect.bind(ctx);
		effect(() => () => {
			for (const dispose of disposers) {
				try {
					dispose?.();
				} catch {}
			}
		});
	});
}

export const name = PLUGIN_ID;
export const displayName = PLUGIN_NAME;
export { STATE_PATH, ACTION_PATH, WRITE_HEADER };
export { readPoolState, viewOf as poolView };
export { mergeDuplicates as mergePoolDuplicates, dedupeKeyOf };
export { dpapi as dpapiCall, credentialsOf as readPoolCredentials, activateAccount as activatePoolAccount };
export { upstreamModule as loadUpstreamDoubao };
