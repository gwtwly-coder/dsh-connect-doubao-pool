import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
// src/doubao-catalog.ts
/**
* Doubao model catalog.
*
* Doubao DOES let the caller pick a model. The choice travels in the request
* body at TWO mirrored locations, and upstream ignores the request if only one
* is written:
*
*   option.model_config.model_item_key       ← numeric or slug
*   option.aggregate_params.model_item_key   ← same value, same body
*
* Every id below was read off a real request the desktop app sent, not inferred.
* They are NOT interchangeable with numbers that appear elsewhere in the body:
* `aggregate_params.mode_id` is also often "3", but it means the 对话/工作 mode
* switch, NOT the Turbo model. The two are named apart throughout this codebase
* precisely because the collision is easy to fall into.
*
* ⚠️ ENCODING IS MIXED. `seed-lite-7b` is a string slug; `3`, `5` and `9` are
* numeric enum values. They travel as JSON strings either way and MUST be
* forwarded verbatim — never parsed to a number, or the slug is lost.
*
* 推理强度 (reasoning effort) is a separate axis. It travels as
* `reasoning_effort` (mirrored like the model) and, redundantly, as
* `need_deep_think = 10000 + level` plus `ext.use_deep_think`. See
* {@link DOUBAO_REASONING_LEVELS} for which levels are verified.
*
* @module dsh-connect-doubao/catalog
*/
/** Provider route id this bundle owns. */
const DOUBAO_PROVIDER = "doubao";
/** Shown in the DSH model picker. */
const DOUBAO_PROVIDER_DISPLAY_NAME = "豆包（Doubao）";
/**
* How much context a Doubao conversation holds, in tokens.
*
* NOT 256k. Doubao's real ceiling is on the request BODY: 262,144 UTF-8 bytes,
* measured 2026-11-22 (262,144 ASCII characters pass, 262,145 fail). The
* server answers an oversized body with 710020202 "common invalid param", not
* with a context-length error, so a window that merely *looks* like 256k
* silently breaks the host's compaction: it would let history grow to a
* threshold of ~158k tokens — roughly 475 KB of Chinese — and every request
* past the byte wall fails with no way back.
*
* The estimator prices whitespace at 0.25 tokens/char, i.e. the worst case is
* 4 UTF-8 bytes per token. The host's default compaction trigger for this
* window is `min(W × 0.8, W − O − 65536)` = 54,272 tokens, i.e. 217,088 bytes
* in the worst case — under the 262,144-byte wall with room for the tool
* contract. A smaller window is NOT safe: at 64k the default headroom alone
* (65,536) exceeds `W − O`, the compaction policy fails to resolve, and no
* automatic compaction runs at all.
*
* The shim's own byte-budget fitter is the backstop when this still overflows.
*/
const DOUBAO_CONTEXT_WINDOW = 128e3;
/**
* Output ceiling, in tokens.
*
* Deliberately modest: the compaction trigger is `W − O − headroom`, so a
* large reservation here would shrink the usable input window for no gain —
* Doubao's subscription quota, not this number, is the real bound on replies.
*/
const DOUBAO_MAX_TOKENS = 8192;
/**
* `option.agent_mode` / `ext.agent_mode`.
*
* VERIFIED AGAINST A CDP-CAPTURED REQUEST (2026-10-22, 对话 mode):
*
*   agent_mode 2  →  普通对话
*   agent_mode 1  →  「工作任务」 (every turn is handed to `Agent-GeneralTask`)
*
* The previous revision of this constant said 1 for chat and carried a comment
* claiming work mode sends 2 — BOTH were backwards, and sending 1 is exactly
* what made every request from this plugin look like a work task.
*
* Task mode used to end in `710010702` because the executing runtime was the
* desktop app's CUA process. Since 0.4.1 the plugin answers the server's
* `tool_local` commands over HTTP instead, so task turns complete.
*/
const CHAT_AGENT_MODE = 2;
/** 「工作任务」 mode. Requires the `tool_local` responder — see `doubao-upstream.ts`. */
const TASK_AGENT_MODE = 1;
/**
* Which machine runs a 「工作任务」.
*
* Read off the desktop client's own enum (`ai-views` bundle, module 941658):
*
*   RuntimeType_Cloud_VM  = 1   → 「工作任务 · 云电脑」: ByteDance's VM executes
*   RuntimeType_Local_PC  = 2   → 「工作任务 · 本地电脑」: THIS machine executes
*
* The plugin uses 2 on purpose: the cloud VM's artefacts are unreachable from an
* external client, whereas the local runtime is this very machine — the same one
* the Harness already executes tools on.
*/
const TASK_RUNTIME_CLOUD_VM = 1;
const TASK_RUNTIME_LOCAL_PC = 2;
/**
* Sandbox authorisation level.
*
* `2` is what the client sends with its 「全部允许」 authorisation setting (read
* off the same captured task request). The cloud uses it to decide how freely it
* may plan file and command actions inside the declared workspace.
*/
const TASK_SANDBOX_AUTH_ALLOW_ALL = 2;
const DOUBAO_REASONING_LEVELS = [
	{
		id: "low",
		name: "低",
		level: 3,
		verified: true
	},
	{
		id: "mid",
		name: "中",
		level: 4,
		verified: true
	},
	{
		id: "high",
		name: "高",
		level: 5,
		verified: true
	},
	{
		id: "xhigh",
		name: "极高",
		level: 6,
		verified: false
	},
	{
		id: "max",
		name: "最高",
		level: 7,
		verified: false
	}
];
/** The level used when a request names none. Verified on the wire. */
const DEFAULT_REASONING_LEVEL_ID = "high";
/** Reasoning level for an id, falling back to the default. */
function findReasoningLevel(id) {
	const known = DOUBAO_REASONING_LEVELS.find((level) => level.id === id);
	if (known !== void 0) return known;
	if (id !== void 0 && /^\d{1,3}$/.test(id)) {
		const ordinal = Number(id);
		const named = DOUBAO_REASONING_LEVELS.find((level) => level.level === ordinal);
		if (named !== void 0) return named;
		return {
			id,
			name: String(ordinal),
			level: ordinal,
			verified: false
		};
	}
	return DOUBAO_REASONING_LEVELS.find((level) => level.id === DEFAULT_REASONING_LEVEL_ID);
}
/** The catalog entry for a wire ordinal, or undefined for one it does not know. */
function reasoningLevelOf(ordinal) {
	if (ordinal === void 0) return void 0;
	return DOUBAO_REASONING_LEVELS.find((level) => level.level === ordinal);
}
/**
* The wire spelling of an ordinal.
*
* `model_extra_params.reasoning_effort` for 2.1 Lite is a STRING in the captured
* request, and that string is the level's name-id, not its number. An ordinal
* with no catalog entry falls back to its own decimal form, so a level Doubao
* adds later still travels instead of snapping back to 高.
*/
function levelIdOf(ordinal) {
	return reasoningLevelOf(ordinal)?.id ?? String(ordinal);
}
/**
* `need_deep_think` / `ext.use_deep_think` — the 深度思考 switch.
*
* CDP-captured 2026-10-23, the same conversation sent with the switch OFF and ON:
*
*   off →  option.need_deep_think: 0   ext.use_deep_think: "0"
*   on  →  option.need_deep_think: 3   ext.use_deep_think: "3"
*
* `3` is what the switch sends — NOT `10000 + reasoning_effort`. That shape
* (10005 at 高) was this plugin's own invention, and sending it produced no
* thinking at all: every frame still carried `block_type: 10000` and the reply
* agent was `pc_general_nocot_agent` (no-CoT).
*
* The two axes are independent: effort still travels as `reasoning_effort`
* 3/4/5, while this flag only says whether the model may think before answering.
*/
const DEEP_THINK_OFF = 0;
const DEEP_THINK_ON = 3;
/** `need_deep_think` value for the switch state. */
function needDeepThinkValue(deepThink) {
	return deepThink ? 3 : 0;
}
/**
* Doubao's skill table, transcribed verbatim from the client bundle
* (`{FreeChat:0, SkillWrite:2, SkillImageGen:3, …}`), not inferred.
*
* `skill_id` is the decimal string of `skill_type`; the two are ALWAYS the same
* number, which is why a plain turn carries `{"skill_id":"0","skill_type":0}`.
* On the wire it is a JSON STRING inside `ext.input_skill`.
*
* There is no separate HTTP endpoint for text-to-image in the client — the only
* generation URL is `/creativity/canvas/exec`, which is the image EDITOR
* (cutout / outpaint / layer split). So a skill turn must go through
* `/chat/completion`, and it does: verified 2026-11-02, `skill_type: 3` returns
* real `rc_gen_image/*.jpeg` artefacts from Seedream 5.0.
*/
const DOUBAO_SKILLS = {
	freeChat: 0,
	write: 2,
	imageGen: 3,
	search: 4,
	translate: 5,
	read: 6,
	webpage: 7,
	deepSearch: 8,
	musicGen: 9,
	edu: 11,
	codeInterpreter: 13,
	codeAssistant: 16,
	videoGeneration: 17,
	aiPPT: 18
};
/** The `ext.input_skill` JSON string for a skill; undefined means plain chat. */
function inputSkillOf(skill) {
	if (skill === void 0 || skill === "freeChat") return void 0;
	const type = DOUBAO_SKILLS[skill];
	return JSON.stringify({
		skill_id: String(type),
		skill_type: type,
		variables: {}
	});
}
/**
* `block_type` of a creation (image-generation) block.
*
* Shape, from a captured stream:
*   content.creation_block.creations[] = {
*     type: 1,                       // 1 = image
*     id: "<task id>",
*     image: { key, status, image_ori{url,width,height}, image_preview{…}, image_thumb{…} }
*   }
*/
const CREATION_BLOCK_TYPE = 2074;
/**
* DSH-side alias for "generate an image".
*
* NOT a Doubao `model_item_key` — Doubao has no model by this name. Selecting it
* makes the shim send an ordinary chat turn with `input_skill: imageGen`, and
* Doubao answers with Seedream. Keeping it in the catalog is what puts 生图 in
* DSH's model picker without inventing a second UI.
*/
const DOUBAO_IMAGE_MODEL_ID = "image-gen";
/**
* IMAGEGEN_LABEL_OVERLAY: 生图版本名以插件根目录的 image-models.json 为准，
* 该文件由 doubao_imagemodels.py --sync 从服务端 get_item_conf 生成。
*/
function imageModelLabelFromOverlay() {
	try {
		const url = new URL("../image-models.json", import.meta.url);
		const parsed = JSON.parse(readFileSync(url, "utf8"));
		return typeof parsed.label === "string" && parsed.label !== "" ? parsed.label : void 0;
	} catch {
		return;
	}
}
const DOUBAO_IMAGE_MODEL_NAME = imageModelLabelFromOverlay() ?? "豆包 生图（Seedream 5.5）";
/** The chat model a skill turn rides on: the app's own default. */
const SKILL_CARRIER_MODEL_ID = "0";
/**
* The entries DSH may offer.
*
* WHY THESE ENTRIES. Doubao groups models by MODE, and the model list is per-mode:
*
*   对话       → 豆包 快速 (0), 豆包 2.1 Turbo·专家 (3)
*   工作任务   → 自动 (9), 2.1 Lite (seed-lite-7b), 2.1 Pro (5), Turbo (3)
*
* The 「工作任务」 group (`seed-lite-7b`, `5`, `9`) runs through `Agent-GeneralTask`
* (`mode_id: "3"`, `agent_mode: 1`) and requires Doubao's separate local runtime.
* The plugin satisfies that runtime's own bookkeeping (session dirs, board,
* trajectory log) locally and bridges the real filesystem commands it dispatches
* onto the DSH tools this request declared, so DSH executes them under the
* session's permissions. Unmappable operations fail explicitly instead of being
* reported complete.
*
* MEASURED, 2026-10-22: `model_item_key` is forwarded verbatim (the server stores
* it on the message), but in 对话 mode it does NOT change what answers —
* 0 / 3 / 5 / seed-lite-7b AND a deliberately bogus key all returned answers of
* indistinguishable length and latency (12.3–14.0 s). So this list is honest
* about what the PICKER can offer; it does not claim per-key routing.
*
* 「豆包 快速」 leads because it is the app's own chat-mode default, so an
* unconfigured install reproduces the app rather than something that merely
* happens to work.
*/
const DOUBAO_MODELS = [
	{
		id: "0",
		name: "豆包 快速",
		reasoning: false
	},
	{
		id: "3",
		name: "豆包 2.1 Turbo",
		badge: "专家",
		reasoning: true
	},
	{
		id: "seed-lite-7b",
		name: "豆包 2.1 Lite",
		badge: "工作任务",
		reasoning: true,
		taskMode: true
	},
	{
		id: "5",
		name: "豆包 2.1 Pro",
		badge: "工作任务",
		reasoning: true,
		taskMode: true
	},
	{
		id: "9",
		name: "自动",
		badge: "工作任务",
		reasoning: true,
		taskMode: true
	},
	{
		id: DOUBAO_IMAGE_MODEL_ID,
		name: DOUBAO_IMAGE_MODEL_NAME,
		reasoning: true
	}
];
/** True when `id` is a 「工作任务」-mode model (`seed-lite-7b`, `5`, `9`). */
function isTaskModel(id) {
	if (id === void 0) return false;
	return DOUBAO_MODELS.some((model) => model.id === id && model.taskMode === true);
}
/**
* Entries that exist in the desktop app but are deliberately NOT offered here.
*
* Kept as data rather than a comment so the README and any future UI can state
* the reason from one place — and so re-adding one is a deliberate act that has
* to confront this note.
*/
const DOUBAO_UNAVAILABLE_MODELS = [{
	id: "4",
	name: "豆包 2.1 Turbo（即将下线）",
	reason: "客户端已用「即将下线」标注，不引导用户选择"
}];
/**
* The model used when a request names none.
*
* 「豆包 快速」 is the app's own chat-mode default — `menuConfV2`'s
* `default_select_mode_map.chat` points at it — so leaving it unnamed here
* reproduces what the desktop app would have done. Spelled out rather than
* taken from `DOUBAO_MODELS[0]`, so reordering the list cannot silently change
* which model an unconfigured session gets.
*/
const DOUBAO_DEFAULT_MODEL_ID = "0";
/**
* Catalog entry for a model id, falling back to {@link DOUBAO_DEFAULT_MODEL_ID}.
*
* An id the catalog does not know resolves to the default rather than throwing:
* a stale id in a saved session should degrade to a working model, not break
* the request. `describeRequestedModel` in the shim is what surfaces the miss.
*/
function findDoubaoModel(id) {
	if (id === void 0) return DOUBAO_MODELS.find((model) => model.id === "0");
	const known = DOUBAO_MODELS.find((model) => model.id === id);
	if (known !== void 0) return known;
	return {
		id,
		name: id,
		reasoning: true
	};
}
/** True when the key is a catalog entry this release knows by name. */
function isKnownModelId(id) {
	return id !== void 0 && DOUBAO_MODELS.some((model) => model.id === id);
}
/**
* Model ids measured to never think, whatever the 深度思考 switch says.
*
* 「豆包 快速」 is served by a no-CoT agent: with the switch ON and effort 高 the
* reply still came back `thinking: false` and the frames carried no 10040
* container, while the identical request on 2.1 Pro flipped to `thinking: true`.
* Discovered catalogs come from the client's own menu dump, which marks every
* entry as reasoning-capable, so this set has to be applied AFTER discovery —
* otherwise the picker would keep advertising a control that does nothing.
*/
const NO_THINKING_MODEL_IDS = /* @__PURE__ */ new Set(["0"]);
/** Whether a model can think, by measurement rather than by menu declaration. */
function supportsReasoning(id) {
	return !NO_THINKING_MODEL_IDS.has(id);
}
/**
* Publish the catalog as pi-ai model descriptors.
*
* `models` defaults to the static list but is normally the DISCOVERED one — the
* caller passes whatever the client cache currently reports, so a model Doubao
* ships appears without a plugin release.
*/
function discoverDoubaoModels(models = DOUBAO_MODELS) {
	return models.map((model) => ({
		id: model.id,
		name: model.badge === void 0 ? model.name : `${model.name} · ${model.badge}`,
		contextWindow: DOUBAO_CONTEXT_WINDOW,
		maxTokens: DOUBAO_MAX_TOKENS,
		inputModalities: ["text"],
		reasoning: model.reasoning
	}));
}
/**
* Narrow the catalog to the ids the user has ticked.
*
* Selecting an entry now genuinely selects a model, so this is a real
* restriction — but it still only decides WHICH ENTRIES APPEAR IN DSH's MODEL
* PICKER; the per-request choice is made by the DSH session, not here.
*
* `undefined` (never configured) serves the whole catalog: a first-run install
* must show its models. Ids that no longer exist are dropped.
*
* A model DISCOVERED after the user last saved is kept even when it is not in
* their tick list — otherwise a new Doubao release would be invisible until the
* user thought to reopen the card and re-save, which is exactly the staleness
* this path exists to remove.
*/
function enabledModelsOf(enabledIds, models = DOUBAO_MODELS) {
	if (enabledIds === void 0 || enabledIds.length === 0) return [...models];
	const wanted = new Set(enabledIds);
	const known = new Set(DOUBAO_MODELS.map((model) => model.id));
	return models.filter((model) => wanted.has(model.id) || !known.has(model.id));
}
function doubaoCatalogEntries(models = DOUBAO_MODELS) {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		badge: model.badge ?? null,
		rate: model.rate ?? null,
		reasoningLevels: model.reasoning ? model.reasoningOptions !== void 0 && model.reasoningOptions.length > 0 ? model.reasoningOptions.map((option) => ({
			id: levelIdOf(option.level),
			name: option.name,
			level: option.level,
			verified: reasoningLevelOf(option.level)?.verified ?? false
		})) : DOUBAO_REASONING_LEVELS.filter((level) => level.verified).map((level) => ({
			id: level.id,
			name: level.name,
			level: level.level,
			verified: level.verified
		})) : []
	}));
}
// src/doubao-profile.ts
/**
* Where the Doubao app keeps its Chromium profile.
*
* The app installs wherever the user wants (`E:\Doubao` is normal), but its
* profile normally lands under `%LOCALAPPDATA%\Doubao\User Data`. Plenty of
* people move it — the installer offers a "data directory" choice, and some
* move it after the fact to keep C: small. A hardcoded `AppData` path then
* fails with "profile not found" on an otherwise perfectly working install.
*
* Strategies, most explicit first:
*
*   0. the directory the user picked in the settings card — stored in this
*      plugin's own settings file and applied through {@link setProfileOverride}
*   1. `DSH_DOUBAO_PROFILE`  — escape hatch, for scripted setups.
*   2. AppData candidates    — the default layout, and free (four `existsSync`)
*   3. process command line  — `Doubao.exe --user-data-dir=…`, authoritative
*                              but costs a `powershell.exe` (≈0.8 s), so it is
*                              only consulted once the cheap paths miss
*   4. bounded scan          — depth-4 walk of every fixed drive for a
*                              `User Data\Default\Network\Cookies`, time-boxed
*
* Order is cheapest-first rather than strongest-first on purpose: the common
* case must not pay 0.8 s on every cold start.
*
* The result is a LIST, not a single path, because a stale leftover profile can
* shadow the live one — someone who copied rather than moved leaves an empty
* jar in AppData. `loadDoubaoCredentials` walks the list and keeps the first
* profile that actually decrypts into a usable session.
*
* @module dsh-connect-doubao/profile
*/
/** Env var a user can set to point at their profile (the folder holding `Default`). */
const PROFILE_ENV = "DSH_DOUBAO_PROFILE";
/**
* The directory the user picked in the settings card, if any.
*
* Module-level because the card's choice has to reach every caller of
* `loadDoubaoCredentials` (quota, shim, upstream) without threading a parameter
* through four layers. `apply` seeds it once at startup from the settings file
* and re-seeds it whenever the card saves a new path.
*/
let manualOverride;
/**
* Point the resolver at a user-chosen directory.
*
* Call with `undefined` to go back to automatic detection. Invalid paths are
* ignored here rather than stored, so a folder that was later deleted or
* renamed falls back to detection instead of breaking sign-in outright.
*/
function setProfileOverride(raw) {
	if (raw === void 0) {
		manualOverride = void 0;
		return;
	}
	manualOverride = resolveUserProvided(raw);
}
/** A directory is a profile only if the cookie jar is really there. */
function looksLikeProfile(dir) {
	return existsSync(join(dir, "Default", "Network", "Cookies"));
}
/**
* Resolve one user-supplied path.
*
* Accepts either the `User Data` directory itself or its parent (`E:\Doubao`),
* because both are reasonable readings of "where my data is".
*/
function resolveUserProvided(raw) {
	const trimmed = raw.trim().replace(/^"|"$/g, "");
	if (trimmed === "") return void 0;
	if (looksLikeProfile(trimmed)) return trimmed;
	const nested = join(trimmed, "User Data");
	if (looksLikeProfile(nested)) return nested;
}
/**
* Pull `--user-data-dir=` out of one command line.
*
* The argument arrives in two shapes and both occur in real Doubao output:
*
*   --user-data-dir=C:\path\to\User Data        (cut at whitespace)
*   "--user-data-dir=C:\path with space"        (quoted as a whole)
*
* An empty value is treated as absent: `--user-data-dir=""` means "use the
* Chromium default", not "the current directory".
*/
function extractUserDataDir(commandLine) {
	const at = commandLine.indexOf("--user-data-dir=");
	if (at < 0) return void 0;
	const start = at + 16;
	let value;
	if (commandLine[start] === "\"") {
		const end = commandLine.indexOf("\"", start + 1);
		if (end < 0) return void 0;
		value = commandLine.slice(start + 1, end);
	} else if (commandLine[at - 1] === "\"") {
		const end = commandLine.indexOf("\"", start);
		if (end < 0) return void 0;
		value = commandLine.slice(start, end);
	} else {
		const end = commandLine.indexOf(" ", start);
		value = end < 0 ? commandLine.slice(start) : commandLine.slice(start, end);
	}
	const cleaned = value.trim();
	return cleaned === "" ? void 0 : cleaned;
}
/**
* Read the live client's `--user-data-dir`, if the client is running.
*
* `Get-CimInstance` rather than `Get-Process`: the latter only exposes
* `CommandLine` on PowerShell 7, and Windows still ships 5.1.
*/
function probeProcessCommandLines() {
	const script = "Get-CimInstance Win32_Process -Filter \"Name='Doubao.exe'\" | ForEach-Object { $_.CommandLine }";
	try {
		const result = spawnSync("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			encoding: "utf8",
			timeout: 8e3,
			windowsHide: true
		});
		if (result.status !== 0 || typeof result.stdout !== "string") return [];
		return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}
/** Default AppData candidates: the documented layout, plus every user profile. */
function defaultAppDataBases(env) {
	const candidates = [env.LOCALAPPDATA, env.APPDATA].filter((entry) => typeof entry === "string" && entry !== "").map((base) => join(base, "Doubao", "User Data"));
	const usersRoot = "C:\\Users";
	if (existsSync(usersRoot)) try {
		for (const user of readdirSync(usersRoot)) candidates.push(join(usersRoot, user, "AppData", "Local", "Doubao", "User Data"));
	} catch {}
	return candidates;
}
/** Directories that never contain a Doubao profile and are expensive to walk. */
const SCAN_SKIP = /* @__PURE__ */ new Set([
	"windows",
	"windows.old",
	"$recycle.bin",
	"system volume information",
	"node_modules",
	".git",
	"programdata",
	"recovery",
	"perflogs",
	"msocache"
]);
/** Every existing fixed-drive root, `C:\` style. */
function defaultScanRoots() {
	const roots = [];
	for (let code = 65; code <= 90; code += 1) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (existsSync(root)) roots.push(root);
	}
	return roots;
}
/**
* Bounded breadth-first search for a `User Data\Default\Network\Cookies`.
*
* Depth 4 covers `D:\Doubao\User Data` (2) and `D:\Apps\Doubao\User Data` (3)
* with slack, and a directory-name check keeps it from examining every file.
* The clock check runs per directory so a sprawling D: cannot stall startup.
*/
function scanForProfiles(roots, budgetMs, now) {
	const deadline = now() + budgetMs;
	const found = [];
	const seen = /* @__PURE__ */ new Set();
	const queue = roots.map((root) => ({
		dir: root,
		depth: 0
	}));
	while (queue.length > 0) {
		if (now() > deadline) break;
		const item = queue.shift();
		if (item === void 0) break;
		let entries;
		try {
			entries = readdirSync(item.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const name = entry.name.toLowerCase();
			if (SCAN_SKIP.has(name)) continue;
			const child = join(item.dir, entry.name);
			const key = child.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			if (looksLikeProfile(child)) {
				found.push({
					dir: child,
					source: "scan"
				});
				continue;
			}
			if (item.depth + 1 < 4) queue.push({
				dir: child,
				depth: item.depth + 1
			});
		}
	}
	return found;
}
/**
* Every plausible profile, best first.
*
* Deduplicated case-insensitively (Windows paths are case-insensitive, and the
* process probe and scan can easily report the same directory). A later source
* never overrides an earlier one, so `env` always wins.
*/
function listDoubaoProfiles(deps = {}) {
	if ((deps.platform ?? process.platform) !== "win32") return [];
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (dir, source) => {
		if (dir === void 0) return;
		const key = dir.toLowerCase().replace(/[\\/]+$/, "");
		if (seen.has(key)) return;
		seen.add(key);
		out.push({
			dir,
			source
		});
	};
	const manual = deps.manual ?? manualOverride;
	if (manual !== void 0) push(resolveUserProvided(manual), "manual");
	const override = env[PROFILE_ENV];
	if (typeof override === "string") push(resolveUserProvided(override), "env");
	for (const base of deps.appDataBases ?? defaultAppDataBases(env)) if (looksLikeProfile(base)) push(base, "appdata");
	const lines = deps.processCommandLines ? deps.processCommandLines() : probeProcessCommandLines();
	for (const line of lines) {
		const dir = extractUserDataDir(line);
		if (dir !== void 0 && looksLikeProfile(dir)) push(dir, "process");
	}
	if (out.length === 0) {
		const roots = deps.scanRoots ?? defaultScanRoots();
		for (const hit of scanForProfiles(roots, deps.scanBudgetMs ?? 1500, now)) push(hit.dir, hit.source);
	}
	return out;
}
/** Best guess for the profile directory, or `undefined`. */
function findDoubaoUserDataDir(deps = {}) {
	return listDoubaoProfiles(deps)[0]?.dir;
}
/** Where the profile was found and how — what `doctor` prints. */
function describeProfileLocation(deps = {}) {
	const profile = listDoubaoProfiles(deps)[0];
	return profile === void 0 ? "<not found>" : `${profile.dir} (via ${profile.source})`;
}
// src/doubao-auth.ts
/**
* Doubao credentials — the sealed browser session, and the DPAPI helper under it.
*
* WHY THERE IS ONLY ONE SOURCE
*
* This module used to decrypt the desktop client's cookie jar: read the DPAPI
* master key out of `<User Data>\Local State`, open
* `<User Data>\Default\Network\Cookies` as SQLite, AES-GCM each `v10` value and
* strip Chrome's host-binding prefix. It was removed, not merely deprecated,
* because of a defect that no amount of care could fix from outside the app:
*
*   the client holds `Default\Network\Cookies` with an EXCLUSIVE lock while it
*   runs, and this plugin exists precisely for an account whose app IS running.
*   So the live read failed in the normal case, the code fell back to a 12-hour
*   sealed copy, and once the server rotated the session every request was
*   rejected upstream — with a local state that still looked "signed in", and
*   therefore no local explanation for the user.
*
* The browser sign-in in `./doubao-auth-browser.ts` has neither of those
* failure modes: it captures the cookies over CDP from a throwaway Chromium
* profile, so there is no lock to lose, and what this module seals is exactly
* what was just captured, so there is no stale copy to prefer. One source also
* means one account: no fallback can silently serve whoever else happened to be
* signed in somewhere on this machine.
*
* SECURITY: cookie values live in this process's memory and in one file sealed
* with Windows DPAPI (current-user scope), which no other Windows account and no
* other machine can open. Nothing here is logged, and nothing leaves except the
* outbound request's `Cookie:` header.
*
* @module dsh-connect-doubao/auth
*/
/**
* How long a loaded session stays in the process cache.
*
* Not a security boundary: DPAPI unprotect costs a PowerShell child process, and
* every upstream call wants the header, so the cache is what keeps a chat turn
* from spawning one process per request. Doubao rotates its own cookies
* server-side; the first rejected request is the accurate expiry signal.
*/
const CREDENTIAL_TTL_MS = 6e5;
/**
* Core cookie names Doubao actually requires to authenticate an account.
*
* `browserLogin()` still waits briefly for the full 9-cookie jar below so
* anti-bot and expiry cookies (`sid_guard`, `ttwid`, `s_v_web_id`, ...) are
* captured whenever issued, while `loadBrowserCredentials()` will not discard an
* otherwise working session merely because an auxiliary tracking cookie was
* blocked or delayed on a user's machine.
*/
const CORE_AUTH_COOKIE_NAMES = [
	"sessionid",
	"sessionid_ss",
	"sid_tt",
	"uid_tt"
];
/**
* Full cookie set Doubao's web/client stack normally sets.
* Verified in M1/M2: this exact set authenticated while the app was closed.
*/
const REQUIRED_COOKIE_NAMES = [
	"sessionid",
	"sessionid_ss",
	"sid_tt",
	"sid_guard",
	"uid_tt",
	"ttwid",
	"odin_tt",
	"passport_csrf_token",
	"s_v_web_id"
];
/**
* Absolute path to Windows PowerShell, or the bare name as a last resort.
*
* Resolving through PATH means a planted `powershell.exe` earlier in the search
* order receives this call's input on stdin — which is a session cookie or the
* DPAPI master key. The system copy lives at a fixed location, so ask for it.
*/
function powershellPath() {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	const direct = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(direct) ? direct : "powershell.exe";
}
/**
* The environment handed to the DPAPI helper.
*
* An explicit allow-list rather than a spread of the host environment: that
* environment carries every API key this DSH install has, and none of them has
* any business in a process whose only job is one crypt32 call.
*/
function dpapiChildEnv() {
	const env = {};
	for (const name of [
		"SystemRoot",
		"windir",
		"SystemDrive",
		"ComSpec",
		"PATH",
		"PATHEXT",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"APPDATA",
		"LOCALAPPDATA",
		"HOMEDRIVE",
		"HOMEPATH",
		"OS",
		"PROCESSOR_ARCHITECTURE"
	]) {
		const value = process.env[name];
		if (value !== void 0) env[name] = value;
	}
	if (env.SystemRoot === void 0 && env.windir !== void 0) env.SystemRoot = env.windir;
	return env;
}
const DPAPI_OK_PREFIX = "DSH_DPAPI_OK:";
const BASE64_OUTPUT = /^[A-Za-z0-9+/]+={0,2}$/;
var DpapiBlobRejectedError = class extends Error {
	constructor() {
		super("Windows DPAPI rejected the blob (CryptUnprotectData returned false)");
	}
};
function parseDpapiStdout(result) {
	if (result.error !== void 0) throw new Error(`Windows DPAPI helper failed to start: ${result.error.message}`);
	const stdout = result.stdout ?? "";
	if (stdout.trim() === "") {
		const stderr = result.stderr ?? "";
		throw new Error(`Windows DPAPI helper produced no output (status=${result.status}, stdout=${JSON.stringify(stdout.slice(0, 120))}, stderr=${JSON.stringify(stderr.slice(-400))})`);
	}
	for (const line of stdout.split(/\r?\n/).reverse()) {
		const candidate = line.trim();
		if (!candidate || candidate.startsWith("#") || candidate.startsWith("<")) continue;
		if (candidate === "DPAPI_CALL_FAILED") throw new DpapiBlobRejectedError();
		const payload = candidate.startsWith(DPAPI_OK_PREFIX) ? candidate.slice(13) : candidate;
		if (!BASE64_OUTPUT.test(payload) || payload.length % 4 !== 0) continue;
		const decoded = Buffer.from(payload, "base64");
		if (decoded.length > 0) return decoded;
	}
	const stderr = result.stderr ?? "";
	throw new Error(`DPAPI helper returned no usable output (status=${result.status}, stderr=${JSON.stringify(stderr.slice(-300))})`);
}
/**
* Primary DPAPI path using the signed built-in .NET `System.Security` assembly
* via `-EncodedCommand`: avoids `csc.exe` runtime compilation and temp `.ps1`
* files, which antivirus / ConstrainedLanguage / AllSigned GPOs often block.
*/
function dpapiCallProtectedData(mode, blob) {
	const ps = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		"Add-Type -AssemblyName System.Security",
		"$in = [Console]::In.ReadToEnd()",
		"$bytes = [System.Convert]::FromBase64String($in.Trim())",
		"$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
		"try {",
		`  $out = [System.Security.Cryptography.ProtectedData]::${mode === "protect" ? "Protect" : "Unprotect"}($bytes, $null, $scope)`,
		"} catch [System.Security.Cryptography.CryptographicException] {",
		"  [Console]::Out.Write('DPAPI_CALL_FAILED')",
		"  exit 3",
		"}",
		`[Console]::Out.Write('${DPAPI_OK_PREFIX}' + [System.Convert]::ToBase64String($out))`
	].join("\r\n");
	const encoded = Buffer.from(ps, "utf16le").toString("base64");
	return parseDpapiStdout(spawnSync(powershellPath(), [
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		encoded
	], {
		encoding: "utf8",
		maxBuffer: 1 << 24,
		windowsHide: true,
		input: blob.toString("base64"),
		env: dpapiChildEnv()
	}));
}
/**
* Fallback DPAPI path calling `crypt32.dll` directly via P/Invoke in a temp script.
* Used only if `System.Security.Cryptography.ProtectedData` could not be loaded.
*/
function dpapiCallNative(mode, blob) {
	const script = [
		"param([string]$Mode = \"unprotect\")",
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = \"SilentlyContinue\"",
		"$cs = 'using System; using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential)] public struct DshDataBlob { public int cbData; public IntPtr pbData; } public static class DshCrypt { [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptUnprotectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); [DllImport(\"crypt32.dll\", SetLastError = true)] public static extern bool CryptProtectData(ref DshDataBlob pDataIn, IntPtr szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DshDataBlob pDataOut); }'",
		"Add-Type -TypeDefinition $cs",
		"$in = [Console]::In.ReadToEnd()",
		"$bytes = [System.Convert]::FromBase64String($in.Trim())",
		"$len = [int]$bytes.Length",
		"$mem = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)",
		"[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $mem, $len)",
		"$inBlob = New-Object DshDataBlob",
		"$inBlob.cbData = $len",
		"$inBlob.pbData = $mem",
		"$outBlob = New-Object DshDataBlob",
		"if ($Mode -eq 'protect') {",
		"  $ok = [DshCrypt]::CryptProtectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"} else {",
		"  $ok = [DshCrypt]::CryptUnprotectData([ref]$inBlob, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, 1, [ref]$outBlob)",
		"}",
		"if (-not $ok) { [Console]::Out.Write('DPAPI_CALL_FAILED'); exit 3 }",
		"$res = New-Object byte[] $outBlob.cbData",
		"[Runtime.InteropServices.Marshal]::Copy($outBlob.pbData, $res, 0, $outBlob.cbData)",
		`[Console]::Out.Write('${DPAPI_OK_PREFIX}' + [System.Convert]::ToBase64String($res))`,
		""
	].join("\r\n");
	const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-dpapi-"));
	const scriptPath = join(scratch, "unprotect.ps1");
	try {
		writeFileSync(scriptPath, script, "utf8");
		return parseDpapiStdout(spawnSync(powershellPath(), [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			mode
		], {
			encoding: "utf8",
			maxBuffer: 1 << 24,
			windowsHide: true,
			input: blob.toString("base64"),
			env: dpapiChildEnv()
		}));
	} finally {
		rmSync(scratch, {
			recursive: true,
			force: true
		});
	}
}
/**
* Call CryptProtectData / CryptUnprotectData via a short-lived PowerShell child.
*
* Node has no built-in DPAPI binding and the plugin must not pull in a native
* addon, so we shell out to the Windows Data Protection API. The payload travels
* over stdin and stdout and never touches disk.
*/
function dpapiCall(mode, blob) {
	try {
		return dpapiCallProtectedData(mode, blob);
	} catch (error) {
		if (error instanceof DpapiBlobRejectedError) throw error;
		return dpapiCallNative(mode, blob);
	}
}
/**
* Where the one usable session lives.
*
* The file name keeps the `-browser` suffix it was introduced with so an
* existing sealed session survives the upgrade that removed the client path.
*
* There is no TTL here, on purpose: the session lives ~30 days server-side and
* the FIRST rejected request is the accurate expiry signal. A clock on top of
* that could only invent failures for a session that still works.
*/
const BROWSER_CACHE_FILENAME = "doubao-credentials-browser.dpapi";
function browserCachePath() {
	return join(homedir(), ".dsh", BROWSER_CACHE_FILENAME);
}
/** Seal browser-harvested cookies to disk. Throws on a DPAPI failure. */
function saveBrowserCredentials(pairs) {
	const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
	const payload = JSON.stringify({
		savedAt: Date.now(),
		source: "browser",
		header,
		pairs: [...pairs.entries()]
	});
	const sealed = dpapiCall("protect", Buffer.from(payload, "utf8"));
	mkdirSync(dirname(browserCachePath()), { recursive: true });
	writeFileSync(browserCachePath(), sealed, { mode: 384 });
}
/** Read the sealed browser session along with a failure diagnosis when unusable. */
function readBrowserCredentials() {
	let sealed;
	try {
		sealed = readFileSync(browserCachePath());
	} catch (error) {
		if (error?.code === "ENOENT") return {
			ok: false,
			kind: "missing",
			reason: "还没有浏览器登录态。请在豆包卡片里点「重新登录」扫码一次。"
		};
		return {
			ok: false,
			kind: "dpapi",
			reason: `本机保存的会话无法读取（${error?.message ?? String(error)}），请重新登录一次。`
		};
	}
	let parsed;
	try {
		const json = dpapiCall("unprotect", sealed).toString("utf8");
		parsed = JSON.parse(json);
	} catch (error) {
		return {
			ok: false,
			kind: "dpapi",
			reason: `本机保存的会话无法解密（${error?.message ?? String(error)}），请重新登录一次。`
		};
	}
	if (typeof parsed.header !== "string" || !Array.isArray(parsed.pairs)) return {
		ok: false,
		kind: "dpapi",
		reason: "本机保存的会话格式损坏（无法解密），请重新登录一次。"
	};
	const pairs = /* @__PURE__ */ new Map();
	for (const entry of parsed.pairs) {
		if (!Array.isArray(entry) || entry.length !== 2) continue;
		const [name, value] = entry;
		if (typeof name === "string" && typeof value === "string" && name !== "") pairs.set(name, value);
	}
	const missingCore = CORE_AUTH_COOKIE_NAMES.filter((name) => !pairs.get(name));
	if (missingCore.length > 0) return {
		ok: false,
		kind: "incomplete",
		reason: `登录态不完整（缺少 ${missingCore.join(", ")}），请在豆包卡片里点「重新登录」重新扫码。`
	};
	return {
		ok: true,
		credentials: {
			ok: true,
			header: parsed.header,
			pairs
		}
	};
}
/** Read the sealed browser session, or `undefined` when absent/unusable. */
function loadBrowserCredentials() {
	const result = readBrowserCredentials();
	return result.ok ? result.credentials : void 0;
}
/** True when a sealed browser session exists on disk. */
function hasBrowserCredentials() {
	return loadBrowserCredentials() !== void 0;
}
/** Drop the sealed session (a re-login always overwrites it). */
function clearBrowserCredentials() {
	try {
		unlinkSync(browserCachePath());
	} catch {}
}
const DPAPI_FAILURE_CACHE_TTL_MS = 15e3;
let cached$1;
/**
* The session this plugin runs on: the sealed browser sign-in, or a failure that
* tells the user what to do about it.
*
* Cached in process memory for `CREDENTIAL_TTL_MS` because the read costs a
* PowerShell child process. A failure is reported as `{ ok: false, reason }`
* rather than thrown so the provider can surface an actionable message instead
* of a stack trace; the login route drops this cache, so a fresh scan is visible
* immediately. Missing-file (`ENOENT`) reads are cheap and never cached, so a
* CLI sign-in is picked up immediately without a restart.
*/
function loadDoubaoCredentials(options = {}) {
	const now = Date.now();
	if (!options.force && cached$1 !== void 0 && now - cached$1.at < cached$1.ttlMs) return cached$1.credentials;
	const read = readBrowserCredentials();
	const credentials = read.ok ? read.credentials : {
		ok: false,
		reason: read.reason,
		header: "",
		pairs: /* @__PURE__ */ new Map()
	};
	if (read.ok) cached$1 = {
		at: now,
		credentials,
		ttlMs: CREDENTIAL_TTL_MS
	};
	else if (read.kind === "dpapi") cached$1 = {
		at: now,
		credentials,
		ttlMs: DPAPI_FAILURE_CACHE_TTL_MS
	};
	else cached$1 = void 0;
	return credentials;
}
/** Drop the in-memory cache. Used by tests and by explicit user refresh. */
function invalidateCredentialCache() {
	cached$1 = void 0;
}
/**
* Revoke the sealed session on disk as well.
*
* Called when the server refuses the session. Replacing it needs a fresh QR
* scan, so keeping the file would only make every later request fail the same
* way while the card still showed a signed-in account — the user's fix
* (「重新登录」) would then look like it had no effect. Deleting it makes the
* next request say "log in", which is the truth.
*/
function clearCredentialCache() {
	cached$1 = void 0;
	clearBrowserCredentials();
}
// src/doubao-auth-browser.ts
/**
* Browser-based sign-in for the Doubao plugin.
*
* WHY THIS EXISTS
*
* This is the ONLY way the plugin obtains a session. It used to be the fallback
* for machines without the desktop app, while the primary path decrypted the
* app's own cookie jar; that primary path is gone (see `./doubao-auth.ts` for
* why) because the running app locks its cookie database exclusively — which is
* exactly the state this plugin is meant to run in.
*
* Doubao's passport endpoints are plain HTTPS + a `sessionid` cookie, and
* `a_bogus`/`msToken` are NOT verified for the account/quota calls this plugin
* makes — measured 2026-11-07: a request with a deliberately corrupted `a_bogus`
* still answered 200, and only the cookie mattered. So a single interactive
* sign-in in a real Chromium is enough, with no app and no signature algorithm.
*
* HOW
*
* Spawn Chrome/Edge against a DEDICATED profile under `~/.dsh` and drive it over
* the DevTools protocol. `Storage.getCookies` is browser-scoped, so one call
* returns every cookie for every context — no target attach, no page reload.
* The profile persists between logins, so the second run usually finds the
* session still valid and needs no scan at all.
*
* SECURITY: the returned pairs are the user's live session. They are handed to
* `doubao-auth.ts`, which seals them with DPAPI before anything touches disk.
* Nothing here logs a value.
*
* @module dsh-connect-doubao/auth-browser
*/
/** Domains whose cookies belong to Doubao (the passport jar spans several). */
const DOUBAO_DOMAIN = /(^|\.)(doubao|bytedance|zijieapi)\.com$/i;
/** Where the dedicated Chromium profile lives. Persisted on purpose. */
function browserProfileDir() {
	return join(homedir(), ".dsh", "doubao-browser-profile");
}
const DEFAULT_DEBUG_PORT = 9333;
/** Host page for the sign-in. `/chat` is the page that actually mints the jar. */
const LOGIN_URL = "https://www.doubao.com/chat/";
/** Candidate Chrome/Edge binary locations, covering both system and per-user installs. */
function browserCandidates(env = process.env) {
	const roots = [
		env.LOCALAPPDATA,
		env.ProgramFiles,
		env["ProgramFiles(x86)"],
		env.ProgramW6432,
		"C:\\Program Files",
		"C:\\Program Files (x86)"
	].filter((value) => typeof value === "string" && value.trim() !== "");
	const suffixes = [[
		"Google",
		"Chrome",
		"Application",
		"chrome.exe"
	], [
		"Microsoft",
		"Edge",
		"Application",
		"msedge.exe"
	]];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const root of roots) for (const parts of suffixes) {
		const candidate = win32.join(root, ...parts);
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}
function registryBrowserLookup() {
	if (process.platform !== "win32") return void 0;
	for (const key of [
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
		"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
		"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe"
	]) try {
		const res = spawnSync("reg", [
			"query",
			key,
			"/ve"
		], {
			encoding: "utf8",
			timeout: 1500,
			windowsHide: true
		});
		if (res.status !== 0 || typeof res.stdout !== "string") continue;
		for (const line of res.stdout.split(/\r?\n/)) {
			const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i.exec(line.trim());
			if (!match) continue;
			const candidate = match[1].trim().replace(/^"|"$/g, "");
			if (candidate !== "" && existsSync(candidate)) return candidate;
		}
	} catch {}
}
/** Find an installed Chromium binary, or undefined. */
function findBrowser() {
	for (const candidate of browserCandidates()) if (existsSync(candidate)) return candidate;
	return registryBrowserLookup();
}
function sleep$1(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
async function allocateDebugPort() {
	return await new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.on("error", () => resolve(DEFAULT_DEBUG_PORT));
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : DEFAULT_DEBUG_PORT;
			server.close(() => resolve(port > 0 ? port : DEFAULT_DEBUG_PORT));
		});
	});
}
async function probeDevtools(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2e3) });
		if (response.ok) {
			const body = await response.json();
			if (typeof body.webSocketDebuggerUrl === "string") return body.webSocketDebuggerUrl;
		}
	} catch {}
}
/** Poll `http://127.0.0.1:<port>/json/version` until it answers or the browser exits. */
async function waitForDevtools(port, deadline, isChildExited) {
	while (Date.now() < deadline) {
		const wsUrl = await probeDevtools(port);
		if (wsUrl !== void 0) return {
			wsUrl,
			port,
			attachedExisting: false
		};
		if (isChildExited()) {
			const existing = await probeDevtools(DEFAULT_DEBUG_PORT);
			if (existing !== void 0) return {
				wsUrl: existing,
				port: DEFAULT_DEBUG_PORT,
				attachedExisting: true
			};
			return;
		}
		await sleep$1(300);
	}
}
function openSocket(url) {
	const Ctor = globalThis.WebSocket;
	return Ctor === void 0 ? void 0 : new Ctor(url);
}
/** Run a single browser-level CDP command and return its `result` payload. */
async function cdpCommand(wsUrl, method, params = {}, timeoutMs = 15e3) {
	const socket = openSocket(wsUrl);
	if (socket === void 0) throw new Error("this Node build has no global WebSocket");
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			try {
				socket.close();
			} catch {}
			reject(/* @__PURE__ */ new Error(`CDP timeout while running ${method}`));
		}, timeoutMs);
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({
				id: 1,
				method,
				params
			}));
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("CDP socket error"));
		});
		socket.addEventListener("message", (event) => {
			const data = event.data;
			if (typeof data !== "string") return;
			let message;
			try {
				message = JSON.parse(data);
			} catch {
				return;
			}
			if (message.id !== 1) return;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {}
			if (message.error !== void 0) {
				reject(new Error(String(message.error.message ?? "CDP error")));
				return;
			}
			resolve(message.result ?? {});
		});
	});
}
/**
* One `Storage.getCookies` round-trip.
*
* Browser-scoped on purpose: the page target may still be navigating, and
* attaching to it would race the sign-in redirect chain.
*/
async function readCookies(wsUrl, timeoutMs = 15e3) {
	const cookies = (await cdpCommand(wsUrl, "Storage.getCookies", {}, timeoutMs)).cookies;
	return Array.isArray(cookies) ? cookies : [];
}
async function clearCookiesAndReload(wsUrl, port) {
	await cdpCommand(wsUrl, "Storage.clearCookies", {}).catch(() => {});
	const pageWs = await chatTarget(port);
	if (pageWs !== void 0) await cdpCommand(pageWs, "Page.navigate", { url: LOGIN_URL }, 5e3).catch(() => {});
}
async function verifySessionOnline(header) {
	try {
		const response = await fetch("https://www.doubao.com/passport/account/info/v2/?aid=497858&device_platform=web", {
			method: "GET",
			headers: {
				cookie: header,
				Referer: LOGIN_URL,
				accept: "application/json, text/plain, */*"
			},
			signal: AbortSignal.timeout(5e3)
		});
		if (response.status === 401 || response.status === 403) return "rejected";
		if (!response.ok) return "unknown";
		const payload = await response.json();
		if (typeof payload.data?.name === "string" && payload.data.name !== "") return "valid";
		return "rejected";
	} catch {
		return "unknown";
	}
}
/** Pick the Doubao cookies into `name → value`. */
function pickPairs(cookies) {
	const pairs = /* @__PURE__ */ new Map();
	for (const cookie of cookies) {
		const name = cookie.name;
		const value = cookie.value;
		const domain = cookie.domain;
		if (typeof name !== "string" || typeof value !== "string" || value === "") continue;
		if (typeof domain !== "string" || !DOUBAO_DOMAIN.test(domain.replace(/^\./, ""))) continue;
		if (!pairs.has(name)) pairs.set(name, value);
	}
	return pairs;
}
function buildCookieHeader(pairs) {
	return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
/** Kill a spawned browser including its renderer children. */
function terminate(child) {
	if (child.pid === void 0) return;
	try {
		spawnSync("taskkill", [
			"/PID",
			String(child.pid),
			"/T",
			"/F"
		], { stdio: "ignore" });
	} catch {
		try {
			child.kill();
		} catch {}
	}
}
/**
* Run one interactive sign-in and return the harvested cookies.
*
* The caller decides where the credentials go; this function never writes them
* anywhere. A browser window stays open for the whole budget, so the user can
* finish a QR scan or an SMS code at their own pace.
*/
async function browserLogin(options = {}) {
	const say = options.onProgress ?? (() => {});
	const exe = findBrowser();
	if (exe === void 0) return {
		ok: false,
		reason: "没找到 Chrome 或 Edge。浏览器扫码登录需要一个 Chromium 内核的浏览器。"
	};
	const timeoutMs = options.timeoutMs ?? 3e5;
	const deadline = Date.now() + timeoutMs;
	const profile = browserProfileDir();
	mkdirSync(profile, { recursive: true });
	const port = await allocateDebugPort();
	let childExited = false;
	let spawnError;
	const child = spawn(exe, [
		`--remote-debugging-port=${String(port)}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		LOGIN_URL
	], {
		stdio: "ignore",
		detached: false
	});
	child.once("exit", () => {
		childExited = true;
	});
	child.once("error", (error) => {
		spawnError = error;
		childExited = true;
	});
	let attachedExisting = false;
	try {
		say("已打开浏览器，请在弹出的窗口里扫码或短信登录…");
		const attached = await waitForDevtools(port, Math.min(deadline, Date.now() + 2e4), () => childExited);
		if (attached === void 0) {
			if (spawnError !== void 0) return {
				ok: false,
				reason: `无法启动登录浏览器：${spawnError.message}`
			};
			if (childExited) return {
				ok: false,
				reason: "登录浏览器启动后立即退出（可能已有同配置窗口占用，请关闭后再试）。"
			};
			return {
				ok: false,
				reason: `浏览器调试端口 ${String(port)} 没起来（可能被安全软件拦截或端口被占用）。`
			};
		}
		const wsUrl = attached.wsUrl;
		const activePort = attached.port;
		attachedExisting = attached.attachedExisting;
		let lastNote = 0;
		let checkedInitial = false;
		let preferredWaitStartedAt;
		while (Date.now() < deadline) {
			if (!attachedExisting && childExited) return {
				ok: false,
				reason: "浏览器窗口已关闭，登录未完成。"
			};
			let cookies = [];
			try {
				cookies = await readCookies(wsUrl);
			} catch (error) {
				if (!attachedExisting && childExited) return {
					ok: false,
					reason: "浏览器窗口已关闭，登录未完成。"
				};
				say(`读取登录态失败，重试中：${error.message}`);
				await sleep$1(1500);
				continue;
			}
			let pairs = pickPairs(cookies);
			if (!checkedInitial) {
				checkedInitial = true;
				if (pairs.get("sessionid") !== void 0) {
					if ((CORE_AUTH_COOKIE_NAMES.filter((name) => !pairs.get(name)).length > 0 ? "rejected" : await verifySessionOnline(buildCookieHeader(pairs))) === "rejected") {
						say("检测到旧登录态已失效，已清理，请在窗口里重新扫码登录…");
						await clearCookiesAndReload(wsUrl, activePort);
						await sleep$1(1200);
						continue;
					}
				}
			}
			if (pairs.get("sessionid") !== void 0) {
				const missingCore = CORE_AUTH_COOKIE_NAMES.filter((name) => !pairs.get(name));
				if (missingCore.length > 0) {
					say(`登录已开始，等待核心 cookie 补齐（缺 ${missingCore.join(", ")}）…`);
					await sleep$1(1e3);
					continue;
				}
				const missingPreferred = REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name));
				if (missingPreferred.length > 0) {
					preferredWaitStartedAt ??= Date.now();
					if (Date.now() - preferredWaitStartedAt < Math.min(6e3, Math.max(0, deadline - Date.now() - 2e3))) {
						say(`登录已开始，等待辅助 cookie 补齐（缺 ${missingPreferred.join(", ")}）…`);
						await sleep$1(500);
						continue;
					}
				}
				say(`已取到登录态（${String(pairs.size)} 条 cookie）`);
				const fingerprint = await captureFingerprintFromPort(activePort, Math.min(8e3, Math.max(1e3, deadline - Date.now())));
				if (fingerprint !== void 0) try {
					writeBrowserFingerprint(fingerprint);
					say("已记录网页身份（UA / Referer / aid / device_id）");
				} catch {}
				try {
					const refreshed = pickPairs(await readCookies(wsUrl, 5e3));
					if (CORE_AUTH_COOKIE_NAMES.every((name) => refreshed.get(name))) pairs = refreshed;
				} catch {}
				const header = buildCookieHeader(pairs);
				return {
					ok: true,
					pairs,
					header,
					...fingerprint === void 0 ? {} : { fingerprint: "captured" }
				};
			}
			if (Date.now() - lastNote > 1e4) {
				lastNote = Date.now();
				say(`… 等待扫码（已看到 ${String(cookies.length)} 条浏览器 cookie）`);
			}
			await sleep$1(2e3);
		}
		return {
			ok: false,
			reason: "等待登录超时。扫码完成后请重试。"
		};
	} finally {
		if (!attachedExisting && !childExited) terminate(child);
	}
}
/**
* Params that must never be frozen into a config file.
*
* `msToken` / `a_bogus` are per-request signatures and `web_tab_id` is minted
* by the client on every call — persisting any of them would replay a stale
* value on every future request.
*/
const VOLATILE_QUERY = /* @__PURE__ */ new Set([
	"mstoken",
	"ms_token",
	"a_bogus",
	"x-bogus",
	"_signature",
	"web_tab_id"
]);
/** Drop per-request/secret params, keep the stable identity. */
function sanitizeFingerprintQuery(input) {
	const entries = typeof input === "string" ? [...new URLSearchParams(input).entries()] : input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input);
	const out = {};
	for (const [rawKey, value] of entries) {
		const key = rawKey.trim();
		if (key === "" || value === "") continue;
		if (VOLATILE_QUERY.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}
/**
* Build a fingerprint from ONE observed request, or undefined when the request
* is not a Doubao app call we can trust (other host, no aid, no user agent).
*/
function fingerprintFromRequest(url, headers) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return;
	}
	if (parsed.hostname !== "www.doubao.com") return void 0;
	const query = sanitizeFingerprintQuery(parsed.searchParams);
	if (query.aid === void 0) return void 0;
	const userAgent = headers["User-Agent"] ?? headers["user-agent"] ?? "";
	if (userAgent === "") return void 0;
	const referer = headers.Referer ?? headers.referer ?? `${parsed.origin}/chat/`;
	const secChUa = headers["sec-ch-ua"] ?? headers["Sec-CH-UA"];
	return {
		userAgent,
		referer,
		...secChUa === void 0 ? {} : { secChUa },
		query
	};
}
/** Where the captured identity lives. The upstream client reads this file. */
function browserFingerprintPath() {
	return join(homedir(), ".dsh", "doubao-browser-fingerprint.json");
}
/** Persist the fingerprint where the upstream client reads it. No credentials. */
function writeBrowserFingerprint(fingerprint) {
	const path = browserFingerprintPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(fingerprint, null, 2) + "\n", "utf8");
	return path;
}
/** Read the captured identity back, or undefined when none is usable. */
function readBrowserFingerprint() {
	try {
		const parsed = JSON.parse(readFileSync(browserFingerprintPath(), "utf8"));
		const query = parsed.query;
		if (typeof parsed.userAgent !== "string" || typeof parsed.referer !== "string") return void 0;
		if (query === void 0 || typeof query !== "object" || Array.isArray(query)) return void 0;
		const pairs = Object.entries(query).filter((entry) => typeof entry[1] === "string");
		return {
			userAgent: parsed.userAgent,
			referer: parsed.referer,
			...typeof parsed.secChUa === "string" ? { secChUa: parsed.secChUa } : {},
			query: Object.fromEntries(pairs)
		};
	} catch {
		return;
	}
}
/**
* Best-effort capture from whatever devtools browser is listening on `port`.
*
* Never throws: a capture failure leaves the caller's session valid and only
* degrades the request identity back to the desktop one. Exported so the login
* flow and the CLI share one implementation (and one test).
*/
async function captureFingerprintFromPort(port, timeoutMs = 8e3) {
	try {
		const budget = Math.max(1e3, timeoutMs);
		const wsUrl = await waitForChatTarget(port, Date.now() + Math.min(budget, 5e3));
		if (wsUrl === void 0) return void 0;
		return await readFingerprint(wsUrl, Date.now() + budget);
	} catch {
		return;
	}
}
async function chatTarget(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, { signal: AbortSignal.timeout(1500) });
		if (!response.ok) return void 0;
		const page = (await response.json()).find((target) => target.type === "page" && typeof target.url === "string" && target.url.includes("doubao.com"));
		return typeof page?.webSocketDebuggerUrl === "string" ? page.webSocketDebuggerUrl : void 0;
	} catch {
		return;
	}
}
async function waitForChatTarget(port, deadline) {
	while (Date.now() < deadline) {
		const socketUrl = await chatTarget(port);
		if (socketUrl !== void 0) return socketUrl;
		await sleep$1(400);
	}
}
/**
* Watch ONE real app request on the page and read its identity.
*
* Nothing is typed and no turn is sent: the page is reloaded so it re-issues
* the requests it makes on its own, and the first call carrying `aid` is the
* sample. A reload costs no inference quota.
*/
async function readFingerprint(wsUrl, deadline) {
	const socket = openSocket(wsUrl);
	if (socket === void 0) throw new Error("this Node build has no global WebSocket");
	let id = 0;
	const call = (method, params = {}) => {
		id += 1;
		socket.send(JSON.stringify({
			id,
			method,
			params
		}));
	};
	return await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (run) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {}
			run();
		};
		const timer = setTimeout(() => {
			finish(() => reject(/* @__PURE__ */ new Error("等待官方页面的请求超时")));
		}, Math.max(1e3, deadline - Date.now()));
		socket.addEventListener("error", () => {
			finish(() => reject(/* @__PURE__ */ new Error("CDP socket error")));
		});
		socket.addEventListener("open", () => {
			call("Network.enable");
			setTimeout(() => {
				if (!settled) call("Page.reload", { ignoreCache: false });
			}, 600);
		});
		socket.addEventListener("message", (event) => {
			const data = event.data;
			if (typeof data !== "string") return;
			let message;
			try {
				message = JSON.parse(data);
			} catch {
				return;
			}
			if (message.method !== "Network.requestWillBeSent") return;
			const request = message.params?.request;
			if (request === void 0 || typeof request.url !== "string") return;
			const headers = request.headers;
			if (headers === void 0) return;
			const fingerprint = fingerprintFromRequest(request.url, headers);
			if (fingerprint === void 0) return;
			finish(() => resolve(fingerprint));
		});
	});
}
/**
* Capture the official page's request identity.
*
* Attaches to an already-open debugging browser first; otherwise opens the same
* dedicated profile the QR login uses and closes it afterwards. The profile
* keeps its device ids across runs, so repeated captures stay consistent.
*/
async function captureBrowserFingerprint(options = {}) {
	const say = options.onProgress ?? (() => {});
	const port = options.port ?? 9333;
	const budget = options.timeoutMs ?? 3e4;
	const deadline = Date.now() + budget;
	let spawned;
	let wsUrl = await chatTarget(port);
	if (wsUrl === void 0) {
		const exe = findBrowser();
		if (exe === void 0) return {
			ok: false,
			reason: "没找到 Chrome 或 Edge。"
		};
		const profile = browserProfileDir();
		mkdirSync(profile, { recursive: true });
		spawned = spawn(exe, [
			`--remote-debugging-port=${String(port)}`,
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			LOGIN_URL
		], {
			stdio: "ignore",
			detached: false
		});
		say("已打开官方页面，正在读取它自己的请求身份…");
		wsUrl = await waitForChatTarget(port, Math.min(deadline, Date.now() + 2e4));
	} else say("已连接到正在运行的官方页面，正在读取它的请求身份…");
	if (wsUrl === void 0) {
		if (spawned !== void 0) terminate(spawned);
		return {
			ok: false,
			reason: `调试端口 ${String(port)} 上没找到豆包页面（可能被占用或浏览器没起来）。`
		};
	}
	try {
		return {
			ok: true,
			fingerprint: await readFingerprint(wsUrl, Math.min(deadline, Date.now() + 2e4))
		};
	} catch (error) {
		return {
			ok: false,
			reason: error.message
		};
	} finally {
		if (spawned !== void 0) terminate(spawned);
	}
}
// src/doubao-browser-relay.ts
/**
* Official-browser request relay.
*
* The QR login proves the account to Doubao, but it does not make a Node fetch
* look like the official web client. This module deliberately does NOT build a
* chat request or reproduce a_bogus: it asks the official page to send the turn
* itself, then reads the response stream that page produced.
*
* Current scope: ordinary chat. Task mode keeps its existing local-tool path.
* The official page chooses its own model and signs the request. IO.read drains
* the resulting CDP body stream until the terminal SSE event; the existing SSE
* parser still handles every frame afterwards.
*/
const DEFAULT_PORT = 9333;
const DEFAULT_TIMEOUT_MS = 12e4;
const CHAT_URL = "https://www.doubao.com/chat/";
function config() {
	try {
		const path = join(homedir(), ".dsh", "doubao-browser-relay.json");
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}
/**
* Whether the official page could serve a turn at all right now.
*
* A Chromium alone is not enough: an empty profile opens a signed-out page, and
* every relayed turn would end in a login wall instead of a reply. The cookie
* database is the cheap on-disk evidence that this profile has signed in at
* least once (Chrome keeps it under Default/Network since v96, Default before).
*/
function browserRelayAvailable() {
	try {
		if (findBrowser() === void 0) return false;
		const root = browserProfileDir();
		return existsSync(join(root, "Default", "Network", "Cookies")) || existsSync(join(root, "Default", "Cookies"));
	} catch {
		return false;
	}
}
/** Open the official page so a human can clear the challenge. Returns its URL. */
async function openOfficialChat(port) {
	return (await ensureChatTarget(port ?? config().port ?? DEFAULT_PORT)).url ?? CHAT_URL;
}
/** Read per request so the user can switch the relay without rebuilding. */
function browserRelayEnabled() {
	if (process.env.DSH_DOUBAO_BROWSER_RELAY === "0") return false;
	if (process.env.DSH_DOUBAO_BROWSER_RELAY === "1") return true;
	return config().enabled === true;
}
var Cdp = class Cdp {
	socket;
	nextId = 0;
	pending = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Map();
	constructor(socket) {
		this.socket = socket;
		socket.addEventListener("message", (raw) => {
			const data = raw.data;
			if (typeof data !== "string") return;
			let message;
			try {
				message = JSON.parse(data);
			} catch {
				return;
			}
			if (message.id !== void 0) {
				const pending = this.pending.get(message.id);
				if (pending === void 0) return;
				this.pending.delete(message.id);
				if (message.error !== void 0) pending.reject(new Error(message.error.message ?? "CDP error"));
				else pending.resolve(message.result ?? {});
				return;
			}
			if (message.method === void 0) return;
			for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
		});
		socket.addEventListener("error", () => {
			for (const pending of this.pending.values()) pending.reject(/* @__PURE__ */ new Error("CDP socket error"));
			this.pending.clear();
		});
	}
	static async open(url) {
		const socket = openSocket(url);
		if (socket === void 0) throw new Error("this Node build has no global WebSocket");
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(/* @__PURE__ */ new Error("cannot connect to the official browser over CDP")));
		});
		return new Cdp(socket);
	}
	call(method, params = {}) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject
			});
			this.socket.send(JSON.stringify({
				id,
				method,
				params
			}));
		});
	}
	on(method, listener) {
		const listeners = this.listeners.get(method) ?? /* @__PURE__ */ new Set();
		listeners.add(listener);
		this.listeners.set(method, listeners);
		return () => {
			listeners.delete(listener);
		};
	}
	close() {
		this.socket.close();
	}
};
let browserProcess;
let relayQueue = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function debug(message) {
	if (process.env.DSH_DOUBAO_RELAY_DEBUG !== "1") return;
	try {
		appendFileSync(join(homedir(), ".dsh", "doubao-relay-debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`);
	} catch {}
}
async function listTargets(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
	if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
	return await response.json();
}
async function ensureChatTarget(port) {
	const find = async () => {
		return (await listTargets(port)).find((target) => target.type === "page" && target.url?.includes("doubao.com"));
	};
	try {
		const existing = await find();
		if (existing?.webSocketDebuggerUrl) return existing;
	} catch {}
	if (browserProcess === void 0) {
		const executable = findBrowser();
		if (executable === void 0) throw new Error("找不到 Chrome 或 Edge，无法启动官方浏览器");
		browserProcess = spawn(executable, [
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${browserProfileDir()}`,
			"--no-first-run",
			"--no-default-browser-check",
			CHAT_URL
		], { stdio: "ignore" });
		browserProcess.unref();
	}
	const deadline = Date.now() + 2e4;
	while (Date.now() < deadline) {
		try {
			const target = await find();
			if (target?.webSocketDebuggerUrl) return target;
		} catch {}
		await sleep(400);
	}
	throw new Error("官方浏览器调试端口未就绪；如果扫码浏览器已打开，请先关闭它再重试");
}
async function waitForComposer(cdp, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await cdp.call("Runtime.evaluate", {
			expression: `(() => {
        const el = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]')
        if (!el) return false
        el.focus()
        return true
      })()`,
			returnByValue: true
		})).result?.value === true) return;
		await sleep(400);
	}
	throw new Error("官方页面没有找到对话输入框");
}
/** Submit through the page's own composer and capture the response it creates. */
async function relayOnce(prompt, options) {
	const cfg = config();
	const port = options.port ?? cfg.port ?? DEFAULT_PORT;
	const timeoutMs = options.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const target = await ensureChatTarget(port);
	if (!target.webSocketDebuggerUrl) throw new Error("官方页面没有 CDP 地址");
	const cdp = await Cdp.open(target.webSocketDebuggerUrl);
	let timer;
	let abortListener;
	try {
		await cdp.call("Page.enable");
		return await new Promise((resolve, reject) => {
			let settled = false;
			let requestId;
			let streamHandle;
			let status = 200;
			let statusText = "";
			let headers = {};
			const chunks = [];
			let terminalTail = "";
			const complete = () => {
				if (settled) return;
				settled = true;
				debug(`complete status=${status} chunks=${chunks.length}`);
				resolve(new Response(Buffer.concat(chunks), {
					status,
					statusText,
					headers
				}));
			};
			const fail = (error) => {
				if (settled) return;
				settled = true;
				debug(`fail ${error.message}`);
				reject(error);
			};
			cdp.on("Fetch.requestPaused", (params) => {
				if (requestId !== void 0) return;
				requestId = String(params.requestId ?? "");
				status = typeof params.responseStatusCode === "number" ? params.responseStatusCode : 200;
				statusText = typeof params.responseStatusText === "string" ? params.responseStatusText : "";
				const rawHeaders = params.responseHeaders;
				if (Array.isArray(rawHeaders)) {
					for (const header of rawHeaders) if (header && typeof header.name === "string" && typeof header.value === "string") headers[header.name] = header.value;
				} else if (rawHeaders && typeof rawHeaders === "object") headers = rawHeaders;
				debug(`paused request=${requestId} status=${status}`);
				(async () => {
					try {
						const result = await cdp.call("Fetch.takeResponseBodyAsStream", { requestId });
						streamHandle = typeof result.stream === "string" ? result.stream : void 0;
						debug(`take stream=${String(result.stream ?? "(none)")}`);
						if (streamHandle === void 0) throw new Error("CDP returned no response stream handle");
						while (true) {
							const chunk = await cdp.call("IO.read", {
								handle: streamHandle,
								size: 65536
							});
							const encoded = chunk.base64Encoded === true;
							const data = typeof chunk.data === "string" ? chunk.data : "";
							const bytes = Buffer.from(data, encoded ? "base64" : "utf8");
							chunks.push(bytes);
							terminalTail = (terminalTail + bytes.toString("utf8")).slice(-500);
							const terminal = chunk.eof === true || /event:\s*(?:SSE_REPLY_END|STREAM_ERROR)/.test(terminalTail);
							debug(`chunk bytes=${bytes.length} eof=${String(chunk.eof === true)} terminal=${terminal}`);
							if (terminal) {
								await cdp.call("IO.close", { handle: streamHandle }).catch(() => {});
								complete();
								break;
							}
						}
					} catch (error) {
						fail(error);
					}
				})();
			});
			cdp.on("Network.loadingFailed", (params) => {
				if (String(params.requestId ?? "") !== requestId) return;
				fail(/* @__PURE__ */ new Error(`官方浏览器请求失败：${String(params.errorText ?? "unknown")}`));
			});
			cdp.call("Fetch.enable", { patterns: [{
				urlPattern: "*://www.doubao.com/chat/completion*",
				requestStage: "Response"
			}] }).catch((error) => fail(error));
			timer = setTimeout(() => fail(/* @__PURE__ */ new Error("官方浏览器回复超时")), timeoutMs);
			if (options.signal !== void 0) {
				abortListener = () => {
					const error = /* @__PURE__ */ new Error("The operation was aborted");
					error.name = "AbortError";
					fail(error);
				};
				options.signal.addEventListener("abort", abortListener, { once: true });
			}
			(async () => {
				try {
					const location = await cdp.call("Runtime.evaluate", {
						expression: "location.href",
						returnByValue: true
					}).catch(() => void 0);
					if (!String((location?.result)?.value ?? "").startsWith(CHAT_URL)) await cdp.call("Page.navigate", { url: CHAT_URL });
					await waitForComposer(cdp, Math.min(timeoutMs, 2e4));
					await cdp.call("Input.insertText", { text: prompt });
					for (const type of ["keyDown", "keyUp"]) await cdp.call("Input.dispatchKeyEvent", {
						type,
						key: "Enter",
						code: "Enter",
						windowsVirtualKeyCode: 13,
						nativeVirtualKeyCode: 13,
						text: type === "keyDown" ? "\r" : ""
					});
				} catch (error) {
					fail(error);
				}
			})();
		});
	} finally {
		if (timer !== void 0) clearTimeout(timer);
		if (abortListener !== void 0 && options.signal !== void 0) options.signal.removeEventListener("abort", abortListener);
		cdp.close();
	}
}
/** Serialize turns: one official page must never submit two turns at once. */
function browserRelayChat(prompt, options = {}) {
	const run = relayQueue.then(() => relayOnce(prompt, options), () => relayOnce(prompt, options));
	relayQueue = run.catch(() => {});
	return run;
}
// src/doubao-tools.ts
/** The fence the model is told to use, and that we parse back. */
const TOOL_FENCE_LANGUAGE = "doubao-tool";
const FENCE_RE = new RegExp(`^\\s*\`\`\`\\s*${TOOL_FENCE_LANGUAGE}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\`\\s*`, "m");
const JSON_FENCE_RE = /(?:^|\r?\n)\s*```\s*json\s*\r?\n([\s\S]*?)\r?\n\s*```\s*/gi;
/**
* Render the tool contract appended to the prompt.
*
* MEASURED, and the reason this reads like a rulebook rather than a suggestion
* (2026-11-02, same task, same model, only the wording changed):
*
*   polite wording  → 0/2 tool calls, and the model answered 「已完成修改：…」
*                     while touching nothing. That is the worst outcome
*                     available: the user believes the file changed.
*   hard wording    → 2/2 tool calls (read first, then edit).
*
* So the rules forbid the failure modes explicitly instead of implying them:
* "never claim completion without a [tool result]", "do not paste code for the
* user to apply themselves", and "your first reply must be a call". A simulation
* has no protocol to fall back on — the prompt is the only enforcement there is,
* and a soft prompt measurably produces the hallucination.
*/
function buildToolContract(tools) {
	if (tools.filter((tool) => tool.type === "function").map((tool) => tool.function?.name).filter((name) => typeof name === "string" && name !== "").length === 0) return "";
	return [
		"",
		"",
		"你是执行型助手，只能通过本次 DSH 请求明确列出的工具操作当前工作区。可用工具：",
		...tools.filter((tool) => tool.type === "function" && typeof tool.function?.name === "string").map((tool) => {
			const fn = tool.function;
			const schema = fn?.parameters === void 0 ? "" : ` — 参数: ${JSON.stringify(fn.parameters)}`;
			const desc = fn?.description === void 0 ? "" : ` — ${fn.description}`;
			return `- ${fn?.name}${desc}${schema}`;
		}),
		"",
		"需要调用工具时，可先用一句话告诉用户当前要做的步骤，然后输出一个代码围栏，语言标记为 doubao-tool，围栏内放恰好一个 JSON 对象：{\"name\":\"<工具名>\",\"arguments\":{...}}。",
		"只调用上面的工具名，不要伪造工具或绕过 DSH 权限。执行结果会以 [tool result] 开头的消息回给你，然后你继续推进。",
		"向用户显示简短进度与操作结果，不输出隐藏的逐步思维链。",
		"",
		"硬性规则：",
		"- 需要文件操作时，先用一句简短进度说明，再调用工具；不要长篇计划或贴代码让用户手工执行。",
		"- 严禁在回复里声称「已完成」「已修改」——除非你真的执行了工具调用并收到 [tool result]。没有结果就等于没做。",
		"- 不要把修改后的代码贴给用户让他自己粘贴；直接调用工具去改。",
		"- 一次只调用一个工具；JSON 必须严格合法（双引号、无注释、无尾逗号）。",
		"- 不要重复刚刚已经做过的调用。",
		"- 每次修改文件之后，先重新读取该文件，再决定下一步；不要凭记忆连续拼接多次改动。",
		"- 全部完成后，用下列格式说明你做了什么（不要只说「已修改」）：",
		"  **改了哪个文件** → 具体改了什么（哪个函数/哪一行），为什么这么改。",
		"  报告新增/删除行数时，必须引用工具结果中的 diff 或统计；没有数据就明确写「工具未提供」，不能估算。",
		"  如果有多处改动，逐条列出。"
	].join("\n");
}
/**
* Split a model reply into tool calls and the text the user should see.
*
* The fence is REMOVED from the visible text: a tool call is not prose, and
* leaving it in would show the user JSON they never asked to read.
*
* Malformed JSON inside a fence is dropped rather than thrown — the caller still
* has the remaining text, and a hard failure here would turn a half-good answer
* into an error.
*/
function parseToolCalls(text, declaredTools, makeId = (i) => "call_" + Date.now() + "_" + i) {
	const calls = [];
	let rejectedCalls = false;
	let rest = text;
	for (;;) {
		const match = FENCE_RE.exec(rest);
		if (match === null) break;
		const raw = (match[1] ?? "").trim();
		rest = (rest.slice(0, match.index) + rest.slice(match.index + match[0].length)).trim();
		const parsed = parseCallJsonList(raw, false, declaredTools);
		rejectedCalls ||= parsed.rejected;
		for (const call of parsed.calls) calls.push({
			id: makeId(calls.length),
			...call
		});
	}
	if (calls.length === 0 && rest.includes("```")) rest = rest.replace(JSON_FENCE_RE, (fullMatch, body) => {
		const parsed = parseCallJsonList((body ?? "").trim(), true, declaredTools);
		if (parsed.calls.length === 0 && !parsed.rejected) return fullMatch;
		rejectedCalls ||= parsed.rejected;
		for (const call of parsed.calls) calls.push({
			id: makeId(calls.length),
			...call
		});
		return "";
	}).trim();
	const cleanText = rejectedCalls ? [rest, "工具调用未执行：调用未在本次 DSH 工具列表中，或参数不符合声明。"].filter(Boolean).join("\n\n") : rest;
	return {
		calls: dedupeCalls(calls),
		text: cleanText,
		rejectedCalls
	};
}
/** Parse one fence body and enforce the current request's tool allow-list. */
function parseCallJsonList(raw, strictKeys, declaredTools) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return {
			calls: [],
			rejected: !strictKeys
		};
	}
	const items = Array.isArray(value) ? value : [value];
	const calls = [];
	let rejected = false;
	for (const item of items) {
		const single = parseSingleCallObject(item, strictKeys);
		if (single === void 0) {
			rejected ||= !strictKeys;
			continue;
		}
		const declared = declaredTools.find((tool) => tool.type === "function" && tool.function?.name === single.name);
		if (declared === void 0) {
			rejected = true;
			continue;
		}
		let args;
		try {
			args = JSON.parse(single.arguments);
		} catch {
			rejected = true;
			continue;
		}
		if (!isJsonObject(args) || !matchesDeclaredSchema(declared.function?.parameters, args)) {
			rejected = true;
			continue;
		}
		calls.push({
			name: single.name,
			arguments: JSON.stringify(args)
		});
	}
	return {
		calls,
		rejected
	};
}
function parseSingleCallObject(value, strictKeys = false) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const outer = value;
	const record = outer.function !== null && typeof outer.function === "object" && !Array.isArray(outer.function) ? outer.function : outer;
	if (strictKeys && !("name" in record && ("arguments" in record || "params" in record))) return;
	const name = record.name ?? record.tool ?? record.function;
	if (typeof name !== "string" || name === "") return void 0;
	const args = record.arguments ?? record.params ?? record.input ?? {};
	let parsedArgs = args;
	if (typeof args === "string") try {
		parsedArgs = JSON.parse(args);
	} catch {
		return;
	}
	if (!isJsonObject(parsedArgs)) return void 0;
	return {
		name,
		arguments: JSON.stringify(parsedArgs)
	};
}
function isJsonObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
* Validate the common JSON-Schema subset used for tool parameters. DSH remains
* the final execution/permission gate; this prevents the model bridge from
* handing an undeclared function or obviously invalid object to that gate.
*/
function matchesDeclaredSchema(schema, value, depth = 0) {
	if (schema === void 0) return isJsonObject(value);
	if (depth > 24) return false;
	const typeMatches = (type) => {
		if (typeof type !== "string") return true;
		switch (type) {
			case "object": return isJsonObject(value);
			case "array": return Array.isArray(value);
			case "string": return typeof value === "string";
			case "number": return typeof value === "number" && Number.isFinite(value);
			case "integer": return typeof value === "number" && Number.isInteger(value);
			case "boolean": return typeof value === "boolean";
			case "null": return value === null;
			default: return false;
		}
	};
	const type = schema.type;
	if (Array.isArray(type) ? !type.some(typeMatches) : !typeMatches(type)) return false;
	if ("const" in schema && !jsonDeepEqual(value, schema.const)) return false;
	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonDeepEqual(value, candidate))) return false;
	if (isJsonObject(value)) {
		const properties = isJsonObject(schema.properties) ? schema.properties : {};
		if ((Array.isArray(schema.required) ? schema.required : []).some((key) => typeof key !== "string" || !(key in value))) return false;
		if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) return false;
		if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) return false;
		for (const [key, child] of Object.entries(value)) if (key in properties) {
			const childSchema = properties[key];
			if (isJsonObject(childSchema) && !matchesDeclaredSchema(childSchema, child, depth + 1)) return false;
		} else if (schema.additionalProperties === false) return false;
		else if (isJsonObject(schema.additionalProperties) && !matchesDeclaredSchema(schema.additionalProperties, child, depth + 1)) return false;
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
		if (isJsonObject(schema.items) && value.some((item) => !matchesDeclaredSchema(schema.items, item, depth + 1))) return false;
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) return false;
		if (typeof schema.maximum === "number" && value > schema.maximum) return false;
		if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
		if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
	}
	if (Array.isArray(schema.allOf) && !schema.allOf.every((part) => !isJsonObject(part) || matchesDeclaredSchema(part, value, depth + 1))) return false;
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => isJsonObject(part) && matchesDeclaredSchema(part, value, depth + 1))) return false;
	if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part) => isJsonObject(part) && matchesDeclaredSchema(part, value, depth + 1)).length !== 1) return false;
	return true;
}
function jsonDeepEqual(left, right) {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => jsonDeepEqual(value, right[index]));
	if (isJsonObject(left) && isJsonObject(right)) {
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonDeepEqual(left[key], right[key]));
	}
	return false;
}
/**
* Drop calls repeated within the same reply.
*
* The model occasionally emits the same call twice in one turn; executing it
* twice is at best wasteful and at worst destructive (a second write of the
* same file with different content).
*/
/**
* Build a `run_code` program that performs the task's filesystem operations.
*
* Only the operations the mapper already understands reach this function, and
* every path has passed `normalizePath` (relative, no traversal), so the program
* it emits cannot touch anything outside the session workspace. Returns
* `undefined` when the operations cannot be expressed — the caller then falls
* through to the per-tool branches or refuses the turn.
*/
function buildRunCodeProgram(operations, normalizePath, types) {
	const lines = [];
	for (const operation of operations) {
		const type = operation.type;
		const path = normalizePath(operation.path);
		if (path === void 0) return void 0;
		const quoted = JSON.stringify(path);
		if (type === "ensure_dir") lines.push("  await fs.mkdir(" + quoted + ", { recursive: true })");
		else if (type === "ensure_file") {
			lines.push("  await fs.mkdir(path.dirname(" + quoted + "), { recursive: true })");
			lines.push("  await fs.appendFile(" + quoted + ", '')");
		} else if (type === "write_file" || type === "write") {
			if (typeof operation.content !== "string") return void 0;
			if (operation.mode !== void 0 && operation.mode !== "replace" && operation.mode !== "append") return void 0;
			lines.push("  await fs.mkdir(path.dirname(" + quoted + "), { recursive: true })");
			const verb = operation.mode === "append" ? "appendFile" : "writeFile";
			lines.push("  await fs." + verb + "(" + quoted + ", " + JSON.stringify(operation.content) + ", 'utf8')");
		} else if (type === "append_file") {
			if (typeof operation.content !== "string") return void 0;
			lines.push("  await fs.mkdir(path.dirname(" + quoted + "), { recursive: true })");
			lines.push("  await fs.appendFile(" + quoted + ", " + JSON.stringify(operation.content) + ", 'utf8')");
		} else return void 0;
	}
	if (lines.length === 0) return void 0;
	return [
		"const fs = await import(\"node:fs/promises\")",
		"const path = await import(\"node:path\")",
		"await (async () => {",
		...lines,
		"})()",
		"return { ok: true, performed: " + JSON.stringify(operations.map((operation) => String(operation.type) + " " + String(operation.path))) + " }"
	].join("\n");
}
/**
* Convert a conservative subset of task-local filesystem operations into
* functions declared by this DSH request. This helper never accesses disk.
*/
function taskWorkspaceOperationsToDshCalls(input, declaredTools) {
	if (!isJsonObject(input) || !Array.isArray(input.operations) || input.operations.length === 0) return {
		calls: [],
		reason: "任务操作格式无效或为空。"
	};
	if (input.operations.length > 64) return {
		calls: [],
		reason: "单次任务操作数量超过桥接上限。"
	};
	const operations = input.operations.filter(isJsonObject);
	if (operations.length !== input.operations.length) return {
		calls: [],
		reason: "任务操作包含无效项目。"
	};
	const normalizePath = (value) => {
		if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes(String.fromCharCode(0))) return void 0;
		const slashes = value.split(String.fromCharCode(92)).join("/");
		if (slashes.startsWith("/") || /^[A-Za-z]:/.test(slashes)) return void 0;
		const parts = slashes.split("/").filter((part) => part !== "" && part !== ".");
		if (parts.length === 0 || parts.some((part) => part === "..")) return void 0;
		return parts.join("/");
	};
	const q = String.fromCharCode(39);
	const shellQuote = (value) => q + value.split(q).join("'\\''") + q;
	const allowed = (names) => declaredTools.filter((tool) => tool.type === "function" && names.includes(tool.function?.name ?? ""));
	const validate = (tool, args) => {
		const name = tool.function?.name;
		if (!name) return void 0;
		return parseToolCalls(String.fromCharCode(96).repeat(3) + "doubao-tool\n" + JSON.stringify({
			name,
			arguments: args
		}) + String.fromCharCode(10) + String.fromCharCode(96).repeat(3), declaredTools).calls[0];
	};
	const types = operations.map((operation) => operation.type);
	/**
	* PTC turns declare ONE tool: `run_code`. A task turn still dispatches plain
	* filesystem commands, so without this branch every such turn would have to be
	* refused — which is exactly what LOCAL_EXECUTION_UNAVAILABLE was reporting.
	* The program is built from the operations, never from model-supplied text, so
	* the same allow-list and path normalisation above still govern it.
	*/
	const runCodeTool = allowed(["run_code"])[0];
	if (runCodeTool !== void 0) {
		const code = buildRunCodeProgram(operations, normalizePath, types);
		if (code !== void 0) {
			const props = isJsonObject(runCodeTool.function?.parameters?.properties) ? runCodeTool.function.parameters.properties : {};
			const args = { code };
			if ("description" in props) args.description = "在当前 DSH 工作区执行工作任务下发的文件操作";
			const call = validate(runCodeTool, args);
			if (call) return { calls: [call] };
		}
	}
	if (types.every((type) => type === "ensure_dir" || type === "ensure_file")) {
		const commands = [];
		for (const operation of operations) {
			const path = normalizePath(operation.path);
			if (!path) return {
				calls: [],
				reason: "目录/文件路径不是相对工作区路径。"
			};
			if (operation.type === "ensure_dir") commands.push("mkdir -p -- " + shellQuote(path));
			else {
				const slashAt = path.lastIndexOf("/");
				const parent = slashAt < 0 ? "" : path.slice(0, slashAt);
				if (parent) commands.push("mkdir -p -- " + shellQuote(parent));
				commands.push("touch -- " + shellQuote(path));
			}
		}
		const command = commands.join(" && ");
		if (command.length > 16e3) return {
			calls: [],
			reason: "目录/文件初始化超过桥接上限。"
		};
		for (const tool of allowed([
			"ops_bash",
			"bash",
			"run_command",
			"shell",
			"execute_command",
			"terminal"
		])) {
			const props = isJsonObject(tool.function?.parameters?.properties) ? tool.function.parameters.properties : {};
			const args = { ["command" in props ? "command" : "cmd" in props ? "cmd" : "command"]: command };
			if ("description" in props) args.description = "在当前 DSH 工作区创建任务所需目录或空文件";
			const call = validate(tool, args);
			if (call) return { calls: [call] };
		}
		return {
			calls: [],
			reason: "当前 DSH 请求没有声明 Bash 工作区工具。"
		};
	}
	if (operations.length === 1 && (types[0] === "write_file" || types[0] === "write")) {
		const operation = operations[0];
		const path = normalizePath(operation.path);
		if (!path || typeof operation.content !== "string") return {
			calls: [],
			reason: "写文件路径或内容格式无效。"
		};
		if (operation.mode !== void 0 && operation.mode !== "replace") return {
			calls: [],
			reason: "当前桥接只支持 replace 写入模式。"
		};
		for (const tool of allowed([
			"write_file",
			"write",
			"ops_write_file",
			"create_file"
		])) {
			const props = isJsonObject(tool.function?.parameters?.properties) ? tool.function.parameters.properties : {};
			const args = {
				["file_path" in props || tool.function?.name === "write" ? "file_path" : "path"]: path,
				content: operation.content
			};
			if ("mode" in props && operation.mode !== void 0) args.mode = operation.mode;
			if ("revision" in props && operation.revision !== void 0) args.revision = operation.revision;
			const call = validate(tool, args);
			if (call) return { calls: [call] };
		}
		return {
			calls: [],
			reason: "当前 DSH 请求没有声明兼容的写文件工具。"
		};
	}
	if (operations.length === 1 && types[0] === "append_file") {
		const operation = operations[0];
		const path = normalizePath(operation.path);
		if (!path || typeof operation.content !== "string") return {
			calls: [],
			reason: "追加文件路径或内容格式无效。"
		};
		for (const tool of allowed([
			"append_file",
			"edit_file",
			"write_file"
		])) {
			const props = isJsonObject(tool.function?.parameters?.properties) ? tool.function.parameters.properties : {};
			if (!("append" in props) && !("mode" in props) && tool.function?.name !== "append_file") continue;
			const args = {
				["file_path" in props || tool.function?.name === "edit_file" ? "file_path" : "path"]: path,
				content: operation.content
			};
			if ("append" in props) args.append = true;
			else if ("mode" in props) args.mode = "append";
			const call = validate(tool, args);
			if (call) return { calls: [call] };
		}
		return {
			calls: [],
			reason: "当前 DSH 请求没有声明支持追加语义的写文件工具。"
		};
	}
	return {
		calls: [],
		reason: "这组工作任务操作不属于已支持的安全映射。"
	};
}
function dedupeCalls(calls) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const call of calls) {
		const key = `${call.name}\u0000${call.arguments}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(call);
	}
	return out;
}
/**
* Fold a tool result into the flattened prompt.
*
* Doubao's endpoint takes one text block, so the OpenAI `role: "tool"` message
* has to become text. The `[tool result]` prefix is what the contract above
* promises, and it is what the probe measured against.
*/
function toolResultAsText(name, content) {
	const body = typeof content === "string" ? content : JSON.stringify(content ?? "");
	return `[tool result] ${name === void 0 ? "" : `${name}: `}${body}`;
}
// src/doubao-upstream.ts
/**
* Doubao upstream client.
*
* Endpoint: POST https://www.doubao.com/chat/completion
*
* Three request details decide whether the call succeeds or is challenged with
* a slider CAPTCHA (verified in M2 — getting any of them wrong silently turns a
* working session into `710022004 rate limited`):
*
*   1. User-Agent must carry the `SamanthaDoubao/<version>` suffix.
*   2. Referer must be the `chrome://doubao-chat/` scheme, NOT an https URL.
*   3. sec-ch-ua must use the real client-hints brand string.
*
* No `a_bogus` signature is required; the server accepts a cookie-authenticated
* request without it.
*
* The response is a ByteDance-specific streaming variant, NOT standard SSE.
* Frames are three lines — `id:`, `event:`, `data:` — followed by a blank
* line, so a generic `data:`-only SSE parser silently drops everything.
*/
const CHAT_ENDPOINT = "https://www.doubao.com/chat/completion";
const QUOTA_ENDPOINT = "https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/";
const ACCOUNT_ENDPOINT = "https://www.doubao.com/passport/account/info/v2/";
const TOOL_LOCAL_ACK_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/msg/ack";
const TOOL_LOCAL_UPLOAD_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/upload_command_result";
const TOOL_LOCAL_COMPLETE_ENDPOINT = "https://www.doubao.com/alice/office/tool_local/msg/complete";
const ACTION_BAR_BRIEF_LIST_ENDPOINT = "https://www.doubao.com/alice/slot/action_bar_v3/brief_list";
/**
* Client version strings. These are the desktop app build this was last
* verified against (M9), and they MOVE with every Doubao release — a newer app
* sends different values here and a very old one will eventually stop being
* accepted. Re-check them whenever Doubao auto-updates; the risk-control layer
* compares them against the session it sees.
*/
const DOUBAO_VERSION = "2.31.4";
const RUNTIME_VERSION = "3.39.0";
/**
* Frozen, non-secret client identity.
*
* These are constant across Doubao sessions and are NOT credentials. Keeping
* them fixed is what makes an external request look like the same install to
* the risk-control layer.
*/
const CLIENT_PARAMS = {
	aid: "582478",
	real_aid: "582478",
	version_code: "20800",
	pc_version: DOUBAO_VERSION,
	device_id: "2697515174213273",
	tea_uuid: "2697515174213273",
	web_id: "7677868049198630415",
	fp: "verify_2697515174213273",
	chromium_version: "147.0.7727.149",
	runtime_version: RUNTIME_VERSION,
	channel: "win",
	language: "zh",
	region: "CN",
	sys_region: "CN",
	tz_name: "Asia/Shanghai",
	pkg_type: "release_version",
	client_platform: "pc_client",
	device_platform: "web",
	doubao_device_platform: "desktop",
	web_platform: "desktop",
	samantha_web: "1",
	"use-olympus-account": "1"
};
let cachedBrowserFingerprint;
/** Warn at most once per process about a missing web identity. */
let warnedMissingFingerprint = false;
function browserFingerprint() {
	if (cachedBrowserFingerprint !== void 0) return cachedBrowserFingerprint;
	try {
		const path = join(homedir(), ".dsh", "doubao-browser-fingerprint.json");
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		cachedBrowserFingerprint = parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		cachedBrowserFingerprint = null;
	}
	return cachedBrowserFingerprint;
}
function clientParam(name) {
	return browserFingerprint()?.query?.[name] ?? CLIENT_PARAMS[name];
}
/** The default Doubao assistant; content routing means the model is chosen server-side. */
const DEFAULT_BOT_ID = "7338286299411103781";
/** Headers that make an external request indistinguishable from the app's. */
function buildHeaders(credentials, extra = {}, fingerprint = browserFingerprint()) {
	return {
		"User-Agent": fingerprint?.userAgent ?? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4`,
		Referer: fingerprint?.referer ?? "chrome://doubao-chat/",
		accept: "*/*",
		"accept-language": "zh-CN,zh;q=0.9",
		"sec-ch-ua": fingerprint?.secChUa ?? "\"Chromium\";v=\"147\", \"Not.A/Brand\";v=\"8\"",
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": "\"Windows\"",
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "same-origin",
		"agw-js-conv": "str",
		"x-flow-trace": `${randomUUID().replace(/-/g, "")}-${randomUUID().replace(/-/g, "")}-01`,
		"last-event-id": "undefined",
		cookie: applyRenewals(credentials.header),
		...extra
	};
}
function buildQueryUrl(endpoint, msToken, fingerprint = browserFingerprint()) {
	const base = fingerprint?.query ?? CLIENT_PARAMS;
	const params = new URLSearchParams({
		...base,
		web_tab_id: randomUUID()
	});
	if (msToken) params.set("msToken", msToken);
	return `${endpoint}?${params.toString()}`;
}
var DoubaoUpstreamError = class extends Error {
	code;
	rateLimited;
	httpStatus;
	transport;
	truncated;
	kindHint;
	local;
	constructor(message, code, rateLimited = false, meta = {}) {
		super(message);
		this.code = code;
		this.rateLimited = rateLimited;
		this.name = "DoubaoUpstreamError";
		this.httpStatus = meta.httpStatus;
		this.transport = meta.transport === true;
		this.truncated = meta.truncated === true;
		this.kindHint = meta.kind;
		this.local = meta.local === true;
	}
};
/**
* Stable-per-process id that rides along as `client_env_id`.
*
* The client generates one per app environment; ours is per host process so a
* restart looks like a new environment, which is exactly what it is.
*/
const CLIENT_ENV_ID = randomUUID();
/** Whether a request asks for local-PC task mode. Default: OFF — see below. */
function taskModeEnabled(options) {
	if (options.taskMode !== void 0) return options.taskMode;
	if (isTaskModel(options.modelKey)) return true;
	const flag = process.env.DSH_DOUBAO_TASK;
	return flag === void 0 ? false : /^(1|true|on|yes)$/i.test(flag.trim());
}
/** The directory this machine declares to the task runtime. */
function taskWorkspaceOf(options) {
	return options.workspace ?? process.env.DSH_DOUBAO_WORKSPACE ?? process.cwd();
}
/**
* Build `ext.general_task_param` — the field that makes a turn a 工作任务.
*
* Transcribed field-for-field from a real 「工作任务 · 本地电脑」 request the
* desktop client sent on 2026-09-15 (recovered from the app's own IndexedDB
* message store), then reduced to what is portable:
*
*   thread_local_message_id  the local message id being submitted
*   client_option            the workspace and the sandbox/authorisation policy
*   runtime_type             2 — Local_PC; the cloud VM would be 1
*   agent_task_param         the same facts again, device-side
*   agent_task_param_change  all false: nothing is being switched mid-thread
*
* Paths are computed from THIS machine rather than copied, because the cloud
* plans against them: a workspace that does not exist here would make the task
* fail inside the runtime instead of at submit time. `local_device_id` and
* `local_app_id` reuse the frozen client identity already in {@link CLIENT_PARAMS}
* — the captured request carries the same two values, so they are the same
* install identity and not per-request state.
*/
function buildGeneralTaskParam(localMessageId, workspace, prompt) {
	const userData = findDoubaoUserDataDir();
	const agentWorkspace = userData === void 0 ? join(tmpdir(), "dsh-doubao-agent-workspace") : join(userData, "Default", ".doubao", "agent_mode", "workspace");
	return {
		thread_local_message_id: [localMessageId],
		client_option: {
			shared_folder_path: [workspace, agentWorkspace],
			enable_sandbox: true,
			os: process.platform === "win32" ? "Windows" : process.platform,
			client_env_id: CLIENT_ENV_ID,
			sandbox_id: `route-${randomUUID()}`,
			workspace,
			agent_workspace: {
				agent_workspace: agentWorkspace,
				local_skill_paths: [join(homedir(), "Doubao", "skills"), join(homedir(), ".agents", "skills")]
			},
			sandbox_auth_type: 2
		},
		runtime_type: 2,
		need_modify_conversation: false,
		agent_task_param: {
			runtime_type: 2,
			device_name: hostname(),
			workspace,
			local_device_id: clientParam("device_id"),
			local_app_id: clientParam("aid"),
			sandbox_auth_type: 2
		},
		agent_task_param_change: {
			runtime_changed: false,
			device_changed: false,
			sandbox_auth_type_changed: false
		},
		...prompt !== void 0 ? { task_input_json: JSON.stringify({
			text: prompt,
			files: [],
			skills: []
		}) } : {}
	};
}
/**
* Build the request body Doubao's chat endpoint expects.
*
* The model and the reasoning effort are each written at TWO locations, because
* that is what the app does and what upstream reads. Writing only one is
* silently ignored — the request succeeds and the answer comes from whatever
* the server last used.
*
* `general_task_param` is deliberately absent: it carries the desktop app's
* local sandbox and workspace paths, none of which apply to an external client,
* and the endpoint has been observed answering correctly without it.
*/
/**
* Add the 「生成图片：」 prefix that Doubao's image skill requires.
*
* The desktop app gets this for free: its `chat_ability.ability_param` carries
* `reply_message_format: "生成图片：%s"`, which rewrites the outgoing text before
* the request leaves. An external client has no such hook, so the same rewrite
* happens here. Without it the server treats the turn as ordinary chat and
* answers with prose instead of drawing.
*
* Deliberately ONLY the prefix: appending extra instructions makes Doubao read
* them as part of the subject and drop the picture entirely (measured).
*/
function withImagePrefix(prompt, options = {}) {
	if (!(options.skill === "imageGen" || options.modelKey === "image-gen")) return prompt;
	if (/^\s*(生成图片|生成一张|画一张|画个|绘制)/.test(prompt)) return prompt;
	return `生成图片：${prompt}`;
}
function buildChatBody(prompt, options = {}) {
	prompt = withImagePrefix(prompt, options);
	const model = findDoubaoModel(options.modelKey);
	const level = findReasoningLevel(options.reasoningLevel);
	const task = taskModeEnabled(options);
	const taskModelSelected = isTaskModel(model.id) || options.taskMode === true;
	/**
	* Deep-thinking toggle, for probing only.
	*
	* The captured ordinary turn sends `need_deep_think: 0`; the client's 深度思考
	* switch is what turns this on, and the value it sends there has NOT been
	* captured yet. `DSH_DOUBAO_DEEP_THINK=1` reproduces the old 10000+level shape
	* so the resulting stream can be inspected.
	*
	* In 「工作任务」 mode (`seed-lite-7b`, `5`, `9`), captured requests send `10001`.
	*/
	const deepThink = options.deepThink === true || options.deepThink === void 0 && process.env.DSH_DOUBAO_DEEP_THINK === "1";
	const needDeepThink = taskModelSelected && options.deepThink === void 0 ? 10001 : needDeepThinkValue(deepThink);
	/**
	* 2 = 普通对话, 1 = 「工作任务」.
	*
	* CDP-captured from the running client on 2026-10-22. This constant was the
	* bug: the plugin sent 1 for chat, so the server answered every turn as a work
	* task — `Agent-GeneralTask`, then `710010702` because the task runtime used
	* to be the desktop app's own CUA process. Task turns now complete through the
	* `tool_local` responder, which is why `TASK_AGENT_MODE` is safe to send.
	*/
	const agentMode = options.agentMode ?? (task ? 1 : 2);
	const localMessageId = randomUUID();
	/**
	* Mode id the model picker groups by. The captured chat request carries "1" in
	* BOTH `conversation_init_ext` and `aggregate_params`, whereas 「工作任务」
	* models (`seed-lite-7b`, `5`, `9`) carry "3".
	*/
	const modeId = (process.env.DSH_DOUBAO_MODE_ID ?? "").trim() || (task ? "3" : "1");
	const taskParam = task ? buildGeneralTaskParam(localMessageId, taskWorkspaceOf(options), taskModelSelected ? prompt : void 0) : { server_do_compare: true };
	const modelExtraParams = taskModelSelected ? {
		input_token_limit: "256k",
		...model.id === "seed-lite-7b" ? { reasoning_effort: levelIdOf(level.level) } : {}
	} : {};
	return {
		messages: [{
			local_message_id: localMessageId,
			message_status: 0,
			content_block: [{
				block_type: 1e4,
				block_id: randomUUID(),
				parent_id: "",
				meta_info: [],
				append_fields: [],
				content: {
					text_block: {
						text: prompt,
						icon_url: "",
						icon_url_dark: "",
						summary: ""
					},
					pc_event_block: ""
				}
			}]
		}],
		option: {
			send_message_scene: "",
			create_time_ms: Date.now(),
			collect_id: "",
			is_audio: false,
			answer_with_suggest: false,
			agent_mode: agentMode,
			tts_switch: false,
			need_deep_think: needDeepThink,
			click_clear_context: false,
			from_suggest: false,
			is_regen: false,
			is_replace: false,
			is_from_click_option: false,
			is_from_click_softlink: false,
			disable_sse_cache: false,
			select_text_action: "",
			is_select_text: false,
			resend_for_regen: false,
			scene_type: 0,
			unique_key: randomUUID(),
			start_seq: 0,
			need_create_conversation: options.continueConversation !== true,
			conversation_init_option: { need_ack_conversation: true },
			...taskModelSelected && options.continueConversation !== true ? { conversation_mode: 2 } : {},
			conversation_init_ext: {
				model_item_key: model.id,
				reasoning_effort: String(level.level),
				mode_id: modeId
			},
			regen_query_id: [],
			edit_query_id: [],
			regen_instruction: "",
			no_replace_for_regen: false,
			message_from: 0,
			shared_app_name: "",
			shared_app_id: "",
			sse_recv_event_options: { support_chunk_delta: true },
			support_lazy_fetch_stream: true,
			is_ai_playground: false,
			is_old_user: true,
			general_task_param: taskParam,
			recovery_option: {
				is_recovery: false,
				req_create_time_sec: Math.floor(Date.now() / 1e3),
				append_sse_event_scene: 0
			},
			message_storage_type: 0,
			related_deleted_message_ids: {},
			connector_info_list: [],
			model_config: {
				model_item_key: model.id,
				model_extra_params: modelExtraParams,
				reasoning_effort: level.level
			},
			aggregate_params: {
				mention_skill_list: "[]",
				mention_plugin_list: "[]",
				mention_ext: "[{}]",
				conversation_mode: taskModelSelected && options.continueConversation !== true ? "2" : deepThink ? "1" : "",
				mode_id: modeId,
				model_item_key: model.id,
				agent_mode: String(agentMode),
				reasoning_effort: String(level.level),
				provider_id: ""
			}
		},
		client_meta: {
			local_conversation_id: `local_${randomUUID()}`,
			conversation_id: options.conversationId ?? "",
			bot_id: DEFAULT_BOT_ID,
			last_section_id: "",
			last_message_index: null,
			local_permissions: [
				{
					permission_name: "ACCESS_COARSE_LOCATION",
					status: 1
				},
				{
					permission_name: "ACCESS_FINE_LOCATION",
					status: 1
				},
				{
					permission_name: "ACCESS_BACKGROUND_LOCATION",
					status: 1
				}
			]
		},
		user_context: [],
		ext: {
			agent_mode: String(agentMode),
			use_deep_think: String(needDeepThink),
			sub_conv_firstmet_type: "1",
			general_task_param: JSON.stringify(taskParam),
			collection_id: "",
			is_finish: "1",
			conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
			commerce_credit_config_enable: "0",
			...(() => {
				const encoded = inputSkillOf(options.skill);
				return encoded === void 0 ? {} : { input_skill: encoded };
			})()
		}
	};
}
/**
* Parse ByteDance's three-line streaming frames out of a decoded text buffer.
*
* A frame is `id:` then `event:` then `data:` then a blank line. Standard SSE
* also permits comment lines (`:`), so those are skipped. Returns the frames
* plus whatever tail did not yet form a complete frame.
*/
function parseFrames(buffer) {
	const frames = [];
	let rest = buffer;
	while (true) {
		const boundary = rest.search(/\r?\n\r?\n/);
		if (boundary < 0) break;
		const block = rest.slice(0, boundary);
		rest = rest.slice(boundary).replace(/^\r?\n\r?\n/, "");
		const frame = { data: "" };
		const dataLines = [];
		for (const line of block.split(/\r?\n/)) {
			if (!line || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "id") frame.id = value;
			else if (field === "event") frame.event = value;
			else if (field === "data") dataLines.push(value);
		}
		if (dataLines.length > 0 || frame.event) {
			frame.data = dataLines.join("\n");
			frames.push(frame);
		}
	}
	return {
		frames,
		rest
	};
}
/**
* Collect answer text and thinking text, separated by block ownership.
*
* A deep-think reply carries a `block_type: 10040` container (the visible
* 「正在思考 / 已完成思考」 shell) and then streams the reasoning as ordinary
* `block_type: 10000` blocks whose `parent_id` is that container's id. The shell
* and its children both point at `Deep_Think.png`, but `parent_id` is the
* reliable discriminator, so it is what this uses.
*
* Treating every `text` as answer text — what the previous revision did — mixes
* the model's private reasoning into the reply the user sees.
*/
const PLACEHOLDER_THINKING_TITLE_RE = /^(?:正在思考(?:中)?|思考中|已(?:完成)?(?:深度)?思考(?:\s*[（(].*[)）])?|深度思考(?:中)?|思考完成|正在(?:生成图片|生图)|已完成(?:图片生成|生图)|thinking|thought)(?:[.。…]+)?$/i;
function nonPlaceholderTitle(raw) {
	if (typeof raw !== "string") return void 0;
	const trimmed = raw.trim();
	if (trimmed === "" || PLACEHOLDER_THINKING_TITLE_RE.test(trimmed)) return void 0;
	return trimmed;
}
function trailingNewlineCount(text, fallback = 0) {
	if (text === "") return fallback;
	if (/(?:\r?\n){2}$/.test(text)) return 2;
	if (/\r?\n$/.test(text)) return 1;
	return 0;
}
function createBlockCollectState() {
	return {
		thinkingIds: /* @__PURE__ */ new Set(),
		lastTitles: /* @__PURE__ */ new Map(),
		seenTitles: /* @__PURE__ */ new Set(),
		lastSummaries: /* @__PURE__ */ new Map(),
		hasFullThinkingText: false,
		sawThinkingBlock: false,
		hasEmittedThinking: false,
		trailingNewlines: 2
	};
}
function pushThinkingPiece(state, into, piece, discrete) {
	if (piece === "") return;
	if (!discrete) {
		into.thinking.push(piece);
		state.hasEmittedThinking = true;
		state.trailingNewlines = trailingNewlineCount(piece, state.trailingNewlines ?? 0);
		return;
	}
	const nl = state.trailingNewlines ?? 0;
	const out = `${!state.hasEmittedThinking ? "" : nl >= 2 ? "" : nl === 1 ? "\n" : "\n\n"}${piece}`;
	into.thinking.push(out);
	state.hasEmittedThinking = true;
	state.trailingNewlines = trailingNewlineCount(out, nl);
}
function collectBlocks(node, into, thinkingIdsOrState, depth = 0) {
	const state = thinkingIdsOrState instanceof Set ? { thinkingIds: thinkingIdsOrState } : thinkingIdsOrState;
	const thinkingIds = state.thinkingIds;
	if (Array.isArray(node)) {
		for (const item of node) collectBlocks(item, into, state, depth);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node;
	const blockType = record.block_type;
	if (typeof blockType === "number") {
		const blockId = typeof record.block_id === "string" && record.block_id !== "" ? record.block_id : void 0;
		const parentId = typeof record.parent_id === "string" ? record.parent_id : "";
		const isThinking = blockType === THINKING_BLOCK_TYPE || parentId !== "" && thinkingIds.has(parentId);
		if (blockType === THINKING_BLOCK_TYPE) {
			if (blockId !== void 0) thinkingIds.add(blockId);
		}
		if (blockType === 2074) {
			state.activeTarget = "answer";
			if (into.images !== void 0) {
				const creations = record.content?.creation_block?.creations;
				if (Array.isArray(creations)) for (const raw of creations) {
					const image = toDoubaoImage(raw);
					if (image !== void 0) into.images.push(image);
				}
			}
		}
		const content = record.content;
		const thinkingBlock = content?.thinking_block;
		const text = content?.text_block?.text;
		const summary = content?.text_block?.summary;
		if (isThinking) {
			if (thinkingBlock !== void 0 && typeof thinkingBlock === "object" && thinkingBlock !== null && thinkingBlock.empty_disable_click !== true) {
				const isSummaryStyle = thinkingBlock.cot_ui_style === "summary";
				if (!state.hasFullThinkingText || isSummaryStyle) {
					const title = nonPlaceholderTitle(thinkingBlock.finish_title) ?? nonPlaceholderTitle(thinkingBlock.unfold_streaming_title) ?? nonPlaceholderTitle(thinkingBlock.streaming_title);
					if (title !== void 0) {
						state.sawThinkingBlock = true;
						state.seenTitles ??= /* @__PURE__ */ new Set();
						state.lastTitles ??= /* @__PURE__ */ new Map();
						const titleKey = blockId ?? "__thinking_title__";
						if (!state.seenTitles.has(title) && state.lastTitles.get(titleKey) !== title) {
							state.seenTitles.add(title);
							state.lastTitles.set(titleKey, title);
							pushThinkingPiece(state, into, `${title}\n\n`, true);
						}
					}
				}
			}
			if (typeof text === "string" && text !== "") {
				state.hasFullThinkingText = true;
				state.sawThinkingBlock = true;
				pushThinkingPiece(state, into, text, false);
			} else if (typeof summary === "string" && summary.trim() !== "") {
				const trimmedSummary = summary.trim();
				if (!PLACEHOLDER_THINKING_TITLE_RE.test(trimmedSummary)) {
					state.sawThinkingBlock = true;
					state.seenTitles ??= /* @__PURE__ */ new Set();
					state.lastSummaries ??= /* @__PURE__ */ new Map();
					const summaryKey = blockId ?? (parentId !== "" ? `${parentId}:summary` : "__thinking_summary__");
					const prev = state.lastSummaries.get(summaryKey) ?? "";
					if (prev === "" && state.seenTitles.has(trimmedSummary)) state.lastSummaries.set(summaryKey, summary);
					else if (summary !== prev) {
						state.lastSummaries.set(summaryKey, summary);
						if (prev !== "" && summary.startsWith(prev)) pushThinkingPiece(state, into, summary.slice(prev.length), false);
						else {
							state.seenTitles.add(trimmedSummary);
							pushThinkingPiece(state, into, summary, true);
						}
					}
				}
			}
			if (typeof text === "string" && text !== "" && record.is_finish !== true) state.activeTarget = "thinking";
			else if (blockType !== THINKING_BLOCK_TYPE && record.is_finish !== true) state.activeTarget = "thinking";
			else if (blockType === THINKING_BLOCK_TYPE && state.activeTarget === void 0 && record.is_finish !== true) state.activeTarget = "thinking";
		} else {
			if (typeof text === "string" && text !== "") into.answer.push(text);
			if (content?.text_block !== void 0) state.activeTarget = "answer";
		}
	} else if (typeof record.text === "string" && record.text !== "" && !("content_block" in record) && !("message" in record) && (typeof record.id === "string" || depth === 0 && !("block_type" in record) && !("icon_url" in record))) {
		if (typeof record.id === "string" ? thinkingIds.has(record.id) : state.activeTarget === "thinking") {
			state.sawThinkingBlock = true;
			pushThinkingPiece(state, into, record.text, false);
		} else into.answer.push(record.text);
		return;
	}
	for (const value of Object.values(record)) collectBlocks(value, into, state, depth + 1);
}
/**
* Turn one `creations[]` entry into an image, or undefined when it carries no
* usable URL yet (the placeholder stage).
*
* URL preference is original → preview → thumb: `image_ori` is the full-
* resolution artefact, the others are watermarked/derivative variants the app
* uses for lists and thumbnails.
*/
function toDoubaoImage(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const creation = raw;
	const image = creation.image;
	if (image === void 0) return void 0;
	const pick = (key) => {
		const value = image[key];
		if (typeof value !== "object" || value === null) return void 0;
		const url = value.url;
		if (typeof url !== "string" || url === "") return void 0;
		return value;
	};
	const best = pick("image_ori_raw") ?? pick("image_ori") ?? pick("image_preview") ?? pick("image_thumb");
	if (best === void 0) return void 0;
	const taskId = typeof creation.id === "string" ? creation.id : typeof creation.id === "number" ? String(creation.id) : void 0;
	const out = { url: best.url };
	if (taskId !== void 0) out.taskId = taskId;
	if (typeof image.key === "string") out.key = image.key;
	if (typeof best.width === "number") out.width = best.width;
	if (typeof best.height === "number") out.height = best.height;
	return out;
}
/** Read the model identifier the server actually used for a reply. */
function extractModel(payload) {
	const seen = /* @__PURE__ */ new Set();
	const walk = (node) => {
		if (node === null || typeof node !== "object") return void 0;
		if (Array.isArray(node)) {
			for (const item of node) {
				const found = walk(item);
				if (found) return found;
			}
			return;
		}
		const record = node;
		for (const key of [
			"model",
			"model_name",
			"model_id",
			"llm_model_type",
			"model_type"
		]) {
			const value = record[key];
			if (typeof value === "string" && value && !seen.has(value)) {
				seen.add(value);
				return value;
			}
			if (typeof value === "number" && value) {
				const text = String(value);
				if (!seen.has(text)) {
					seen.add(text);
					return text;
				}
			}
		}
		for (const value of Object.values(record)) {
			const found = walk(value);
			if (found) return found;
		}
	};
	return walk(payload);
}
/** True when the reply came from a reasoning-capable model. */
function extractThinking(payload) {
	const record = payload;
	const ext = record?.message?.ext ?? record?.ext;
	if (ext && typeof ext === "object") {
		const useDeepThink = ext.use_deep_think;
		if (useDeepThink === "1" || useDeepThink === 1) return true;
		if (typeof useDeepThink === "string" && useDeepThink !== "" && useDeepThink !== "0") return true;
	}
	return false;
}
/**
* Local workspace HTTP responder for 「工作任务」 (`Agent-GeneralTask`) turns.
*
* When a task-mode turn starts with `option.unique_key = <U>`, the server's
* `Agent-GeneralTask` dispatches sequential local workspace commands with
* deterministic IDs: `${uniqueKey}:${device_id}:${aid}:message:${seq}` for
* `seq = 0, 1, 2, ...`.
*
* CRITICAL: `POST /alice/office/tool_local/msg/ack` MUST be called with a
* SINGLE `msg_id` (`{ msg_ids: [msgId] }`). If `msg_ids` contains any `seq`
* that has not been created on the server yet, the entire `msg/ack` batch fails
* with `710010702`. Polling one `seq` at a time and replying to `cmd_call`
* (`command: 6003`, e.g. `local.workspace.apply`) via `upload_command_result`
* + `msg/complete` until `agent_finished` (`command: 6004`) satisfies the server
* runtime without requiring the Doubao desktop CUA process.
*/
function unsupportedLocalTaskResult(inputObj, reason) {
	const error = reason ?? "本插件不会执行豆包任务通道发来的本地命令；请通过 DSH 声明的工作区工具执行。";
	const operations = Array.isArray(inputObj.operations) ? inputObj.operations : [];
	return {
		request_id: typeof inputObj.request_id === "string" ? inputObj.request_id : "",
		status: "error",
		error_code: "LOCAL_EXECUTION_UNAVAILABLE",
		error_msg: error,
		results: operations.map((entry) => {
			const op = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
			return {
				...typeof op.sequence === "number" || typeof op.sequence === "string" ? { sequence: op.sequence } : {},
				...typeof op.id === "string" ? { id: op.id } : {},
				...typeof op.type === "string" ? { type: op.type } : {},
				...typeof op.path === "string" ? { path: op.path } : {},
				status: "error",
				error_msg: error
			};
		})
	};
}
/**
* Perform a task runtime's own workspace bookkeeping (session dirs, board,
* trajectory log) inside the workspace this turn declared.
*
* Only `ensure_dir`, `ensure_file` and appends to files under the session
* prefix are honoured; every path is resolved under the root and rejected if it
* escapes it, so a crafted `..` cannot write outside the workspace. Anything
* unrecognised fails rather than being silently reported as done.
*/
/**
* Whether a `cmd_call` is the task runtime's own workspace bookkeeping.
*
* Judged by what the command touches, not by an exhaustive name list: the
* runtime names these per target (init_agent_workspace,
* append_workspace_trajectory_memory, write_workspace_board,
* write_workspace_assignment_main, …) and a list silently misses the next one —
* which is what turned a finished turn into a redispatch loop. A command is
* bookkeeping when every path it writes stays inside the runtime's own
* `.sessions/` prefix; anything reaching a real workspace path is real work and
* must go through the DSH tool bridge instead.
*/
function isTaskBookkeeping(commandName, input) {
	const operations = Array.isArray(input.operations) ? input.operations : [];
	if (operations.length === 0) return false;
	if (!operations.every((operation) => {
		if (operation === null || typeof operation !== "object" || Array.isArray(operation)) return false;
		const path = operation.path;
		if (typeof path !== "string") return false;
		const normalized = path.split(String.fromCharCode(92)).join("/");
		return normalized === ".sessions" || normalized.startsWith(".sessions/");
	})) return false;
	return commandName.startsWith("init_agent_workspace") || commandName.startsWith("append_workspace_trajectory_memory") || commandName.startsWith("write_workspace_") || commandName.includes("_workspace_");
}
async function applyTaskBookkeeping(input, workspaceRoot) {
	const root = workspaceRoot ?? process.env.DSH_DOUBAO_WORKSPACE ?? process.cwd();
	const operations = Array.isArray(input.operations) ? input.operations : [];
	if (operations.length === 0) return {
		ok: true,
		message: "no operations"
	};
	const resolveInside = (value) => {
		if (typeof value !== "string" || value === "" || value.includes(String.fromCharCode(0))) return void 0;
		const normalized = value.split(String.fromCharCode(92)).join("/");
		if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return void 0;
		if (normalized.split("/").some((part) => part === "..")) return void 0;
		const absolute = join(root, normalized);
		const relative$1 = relative(root, absolute);
		if (relative$1.startsWith("..") || isAbsolute(relative$1)) return void 0;
		return absolute;
	};
	try {
		for (const entry of operations) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return {
				ok: false,
				message: "invalid operation entry"
			};
			const operation = entry;
			const target = resolveInside(operation.path);
			if (target === void 0) return {
				ok: false,
				message: "path outside workspace"
			};
			const type = operation.type;
			if (type === "ensure_dir") await mkdir(target, { recursive: true });
			else if (type === "ensure_file") {
				await mkdir(dirname(target), { recursive: true });
				await appendFile(target, "");
			} else if (type === "write_file" || type === "append_file") {
				if (typeof operation.content !== "string") return {
					ok: false,
					message: "missing content"
				};
				await mkdir(dirname(target), { recursive: true });
				if (type === "append_file" || operation.mode === "append") await appendFile(target, operation.content, "utf8");
				else await writeFile(target, operation.content, "utf8");
			} else return {
				ok: false,
				message: "unsupported bookkeeping operation"
			};
		}
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : "bookkeeping failed"
		};
	}
	return {
		ok: true,
		message: "ok"
	};
}
async function runToolLocalResponder(uniqueKey, credentials, isStreamDone, signal, declaredTools, onToolCalls) {
	let localOperationRejected = false;
	const msToken = credentials.pairs.get("msToken");
	const postToolJson = async (endpoint, payload) => {
		const url = buildQueryUrl(endpoint, msToken);
		const headers = buildHeaders(credentials, {
			"content-type": "application/json",
			accept: "application/json, text/plain, */*"
		});
		delete headers["last-event-id"];
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			...signal ? { signal } : {}
		});
		absorbSetCookies(res.headers);
		const text = await res.text();
		if (!res.ok) throw new Error(`Doubao task endpoint failed with HTTP ${res.status}`);
		return JSON.parse(text);
	};
	let seq = 0;
	let postStreamPolls = 0;
	while (!signal?.aborted) {
		if (isStreamDone()) {
			if (seq === 0 || postStreamPolls >= 8) break;
			postStreamPolls += 1;
		}
		const msgId = `${uniqueKey}:${clientParam("device_id")}:${clientParam("aid")}:message:${seq}`;
		let ack;
		try {
			ack = await postToolJson(TOOL_LOCAL_ACK_ENDPOINT, { msg_ids: [msgId] });
		} catch {
			return localOperationRejected;
		}
		const msg = ack?.code === 0 ? ack?.data?.msgs?.[0] : void 0;
		if (msg !== void 0) {
			const cmdCall = msg?.body?.cmd_call;
			const agentFinished = msg?.body?.agent_finished;
			if (cmdCall !== void 0) {
				let inputObj = {};
				try {
					inputObj = JSON.parse(cmdCall.input ?? "{}");
				} catch {
					inputObj = {};
				}
				if (isTaskBookkeeping(String(cmdCall.id ?? ""), inputObj)) {
					const outcome = await applyTaskBookkeeping(inputObj);
					try {
						if ((await postToolJson("https://www.doubao.com/alice/office/tool_local/upload_command_result", {
							device_id: clientParam("device_id"),
							command_result: {
								id: cmdCall.id,
								code: outcome.ok ? 0 : 1,
								message: outcome.message
							},
							workspace_apply_response: {
								request_id: inputObj.request_id,
								status: outcome.ok ? "success" : "failed",
								...outcome.ok ? {} : {
									error_code: "WORKSPACE_BOOKKEEPING_FAILED",
									error_message: outcome.message
								},
								operation_results: (Array.isArray(inputObj.operations) ? inputObj.operations : []).map((operation, operation_index) => ({
									operation_index,
									...typeof operation.path === "string" ? { path: operation.path } : {},
									status: outcome.ok ? "success" : "failed",
									...outcome.ok ? {} : {
										error_code: "WORKSPACE_BOOKKEEPING_FAILED",
										error_message: outcome.message
									}
								})),
								workspace_ready: outcome.ok
							}
						}))?.code !== 0) return localOperationRejected;
						if ((await postToolJson("https://www.doubao.com/alice/office/tool_local/msg/complete", { msg_id: msgId }))?.code !== 0) return localOperationRejected;
					} catch {
						return localOperationRejected;
					}
					seq += 1;
					continue;
				}
				localOperationRejected = true;
				const mapped = taskWorkspaceOperationsToDshCalls(inputObj, declaredTools);
				const handoffReason = mapped.reason ?? "操作已作为 DSH 工具调用转交；等待宿主执行结果。";
				if (mapped.calls.length === 0) {
					const line = "[task] command=" + String(cmdCall.id ?? "") + " operations=" + JSON.stringify(inputObj.operations ?? []) + " declared=" + JSON.stringify(declaredTools.map((tool) => tool.function?.name ?? "")) + " reason=" + (mapped.reason ?? "(none)") + "\n";
					process.stderr.write(line);
					try {
						appendFileSync(join(homedir(), ".dsh", "doubao-task.log"), line);
					} catch {}
				}
				unsupportedLocalTaskResult(inputObj, handoffReason);
				try {
					if ((await postToolJson("https://www.doubao.com/alice/office/tool_local/upload_command_result", {
						device_id: clientParam("device_id"),
						command_result: {
							id: cmdCall.id,
							code: 1,
							message: handoffReason
						},
						workspace_apply_response: {
							request_id: inputObj.request_id,
							status: "failed",
							error_code: mapped.calls.length > 0 ? "DSH_TOOL_HANDOFF" : "DSH_TOOL_UNAVAILABLE",
							error_message: handoffReason,
							operation_results: (Array.isArray(inputObj.operations) ? inputObj.operations : []).map((operation, operation_index) => ({
								operation_index,
								...typeof operation.path === "string" ? { path: operation.path } : {},
								status: "failed",
								error_code: mapped.calls.length > 0 ? "DSH_TOOL_HANDOFF" : "DSH_TOOL_UNAVAILABLE",
								error_message: handoffReason
							})),
							workspace_ready: false
						}
					}))?.code !== 0) return localOperationRejected;
					if ((await postToolJson("https://www.doubao.com/alice/office/tool_local/msg/complete", { msg_id: msgId }))?.code !== 0) return localOperationRejected;
				} catch {
					return localOperationRejected;
				}
				if (mapped.calls.length > 0) {
					onToolCalls(mapped.calls);
					return true;
				}
				seq += 1;
				continue;
			}
			if (agentFinished !== void 0) return localOperationRejected;
			seq += 1;
			continue;
		}
		await new Promise((resolve) => setTimeout(resolve, 180));
	}
	return localOperationRejected;
}
/**
* One attempt, no fallback. Split out so {@link streamChat} can retry a
* task-mode call as plain chat when the task runtime is not attached.
*/
async function streamOnce(prompt, options = {}) {
	const credentials = options.credentials ?? loadDoubaoCredentials();
	if (!credentials.ok) throw new DoubaoUpstreamError(credentials.reason ?? "Doubao credentials unavailable.", void 0, false, { kind: "session_dead" });
	const missing = CORE_AUTH_COOKIE_NAMES.filter((name) => !credentials.pairs.get(name));
	if (missing.length > 0) throw new DoubaoUpstreamError(`Doubao session cookies missing: ${missing.join(", ")}`, void 0, false, { kind: "session_dead" });
	const msToken = credentials.pairs.get("msToken");
	const isTask = taskModeEnabled(options);
	const identity = browserFingerprint();
	if (!isTask && identity === null && !warnedMissingFingerprint) {
		warnedMissingFingerprint = true;
		process.stderr.write("[identity] no web fingerprint; sending with the desktop identity — run: dsh-connect-doubao-doctor --fingerprint\n");
	}
	const url = buildQueryUrl(CHAT_ENDPOINT, msToken, identity);
	const headers = buildHeaders(credentials, { "content-type": "application/json" }, identity);
	const bodyObj = buildChatBody(prompt, options);
	const uniqueKey = bodyObj.option.unique_key;
	const body = JSON.stringify(bodyObj);
	const useBrowserRelay = !isTask && options.skill === void 0 && options.modelKey !== "image-gen" && (options.forceRelay === true || browserRelayEnabled());
	let response;
	try {
		response = useBrowserRelay ? await browserRelayChat(prompt, { ...options.signal ? { signal: options.signal } : {} }) : await fetch(url, {
			method: "POST",
			headers,
			body,
			...options.signal ? { signal: options.signal } : {}
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new DoubaoUpstreamError(useBrowserRelay ? `官方浏览器转发失败：${error.message}` : `Doubao request did not reach the server: ${error.message}`, void 0, false, { transport: true });
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new DoubaoUpstreamError(`Doubao chat request failed with HTTP ${response.status}. ${detail.slice(0, 200)}`, void 0, false, { httpStatus: response.status });
	}
	absorbSetCookies(response.headers);
	let streamDone = false;
	let taskToolCalls = [];
	let localOperationRejected = false;
	const responderPromise = isTask ? runToolLocalResponder(uniqueKey, credentials, () => streamDone, options.signal, options.declaredTools ?? [], (calls) => {
		taskToolCalls = calls;
	}).then((rejected) => {
		localOperationRejected = rejected;
	}).catch(() => {}) : Promise.resolve();
	let result;
	let streamError;
	try {
		result = await consumeStream(response, options.callbacks, { harvestNotifyText: isTask });
	} catch (error) {
		streamError = error;
	} finally {
		streamDone = true;
		await responderPromise;
	}
	if (localOperationRejected && taskToolCalls.length === 0) throw new DoubaoUpstreamError("LOCAL_EXECUTION_UNAVAILABLE: Doubao task mode requested a local operation, but this plugin did not execute it through DSH tools.", void 0, false, { kind: "upstream" });
	if (streamError !== void 0) throw streamError;
	if (result === void 0) throw new Error("Doubao stream ended without a result");
	return taskToolCalls.length > 0 ? {
		...result,
		toolCalls: taskToolCalls
	} : result;
}
/**
* Conservative direct-Node request controls.
*
* These are deliberately NOT official Doubao limits. They exist to stop the
* plugin itself from looking like an automation loop: one request at a time, a
* quiet gap between attempts, and a persistent circuit breaker after 710022004.
*/
/**
* 8s was chosen while the direct path still presented the DESKTOP identity with
* web cookies, i.e. while every request was a candidate for a slider challenge.
* With the captured web identity a plain turn costs ~1.7-4s of upstream time, so
* the old gap made any second request in the same turn (title, summary, retry)
* wait up to 8 seconds for no protection it still needed. 2s stays serialized and
* slower than a human typing a follow-up.
*/
const DEFAULT_NODE_INTERVAL_MS = 2e3;
const DEFAULT_RISK_COOLDOWN_MS = 36e5;
let nodeQueue = Promise.resolve();
let lastNodeAttemptAt = 0;
function envDuration(name, fallback) {
	const raw = process.env[name];
	if (raw === void 0 || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function riskStatePath() {
	return process.env.DSH_DOUBAO_RISK_STATE_PATH ?? join(homedir(), ".dsh", "doubao-risk-circuit.json");
}
function readRiskState() {
	try {
		return JSON.parse(readFileSync(riskStatePath(), "utf8"));
	} catch {
		return;
	}
}
function remainingRiskCooldown() {
	const until = readRiskState()?.until;
	return typeof until === "number" ? Math.max(0, until - Date.now()) : 0;
}
function enforceRiskCircuit() {
	const remaining = remainingRiskCooldown();
	if (remaining <= 0) return;
	const minutes = Math.max(1, Math.ceil(remaining / 6e4));
	process.stderr.write(`[circuit] blocked; ${minutes}m remaining\n`);
	throw new DoubaoUpstreamError(`豆包风控冷却中，约 ${minutes} 分钟后再试。本次没有向上游发送请求。`, CODE_RATE_LIMITED, true, {
		kind: "rate_limited",
		local: true
	});
}
function openRiskCircuit(error) {
	if (!(error instanceof DoubaoUpstreamError) || error.code !== CODE_RATE_LIMITED) return;
	const cooldownMs = envDuration("DSH_DOUBAO_RISK_COOLDOWN_MS", DEFAULT_RISK_COOLDOWN_MS);
	if (cooldownMs <= 0) return;
	const path = riskStatePath();
	const until = Date.now() + cooldownMs;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({
		until,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}), "utf8");
	process.stderr.write(`[circuit] opened for ${Math.ceil(cooldownMs / 6e4)}m after 710022004\n`);
}
/** Milliseconds left on the local risk cooldown (0 when it is not open). */
function riskCircuitRemainingMs() {
	return remainingRiskCooldown();
}
/** Clear the local cooldown once a human has cleared the challenge upstream. */
function clearRiskCircuit() {
	const path = riskStatePath();
	const state = readRiskState();
	if (state?.until === void 0 || state.until <= 0) return;
	writeFileSync(path, JSON.stringify({
		until: 0,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}), "utf8");
}
function delay(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const finish = () => {
			if (signal !== void 0) signal.removeEventListener("abort", aborted);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const aborted = () => {
			clearTimeout(timer);
			const error = /* @__PURE__ */ new Error("The operation was aborted");
			error.name = "AbortError";
			reject(error);
		};
		if (signal?.aborted === true) {
			aborted();
			return;
		}
		signal?.addEventListener("abort", aborted, { once: true });
	});
}
async function runNodeCall(call, signal) {
	const execute = async () => {
		enforceRiskCircuit();
		const interval = envDuration("DSH_DOUBAO_MIN_INTERVAL_MS", DEFAULT_NODE_INTERVAL_MS);
		const waitMs = Math.max(0, lastNodeAttemptAt + interval - Date.now());
		if (waitMs > 0) {
			process.stderr.write(`[throttle] waiting ${waitMs}ms before the next Node request\n`);
			await delay(waitMs, signal);
		}
		enforceRiskCircuit();
		lastNodeAttemptAt = Date.now();
		try {
			const result = await call();
			clearRiskCircuit();
			return result;
		} catch (error) {
			openRiskCircuit(error);
			throw error;
		}
	};
	const run = nodeQueue.then(execute, execute);
	nodeQueue = run.catch(() => {});
	return run;
}
/**
* Stream one completion and return the assembled reply.
*
* Rejects with `DoubaoUpstreamError` when the server answers with a business
* error frame — notably `710022004 rate limited`, which is risk control asking
* for a slider CAPTCHA rather than an authentication failure.
*
* TASK MODE FALLBACK. Since 0.4.1 a task-mode turn is served by the
* `tool_local` responder above, so it normally completes. This is now a
* last-resort net: if the responder cannot satisfy the runtime (upstream change,
* network failure), the server answers with `710010702 system error` instead of
* a reply (verified: the stream still names `Agent-GeneralTask`, so the mode
* itself was accepted). Rather than hand that placeholder to the user, the call
* is retried ONCE as plain chat — and only when the failed attempt emitted no
* text, so a fallback can never duplicate a partially streamed answer.
*/
async function streamChat(prompt, options = {}) {
	let emittedText = false;
	const wrapped = {
		onText: (delta) => {
			if (delta) emittedText = true;
			options.callbacks?.onText?.(delta);
		},
		onThinking: (delta) => options.callbacks?.onThinking?.(delta),
		onEvent: (event) => options.callbacks?.onEvent?.(event)
	};
	const wanted = taskModeEnabled(options);
	const call = (taskMode, forceRelay = false) => {
		const useRelay = !taskMode && options.skill === void 0 && options.modelKey !== "image-gen" && (forceRelay || browserRelayEnabled());
		const execute = () => useRelay ? streamOnce(prompt, {
			...options,
			callbacks: wrapped,
			taskMode,
			forceRelay
		}) : streamOnce(prompt, {
			...options,
			callbacks: wrapped,
			taskMode
		});
		return useRelay ? execute() : runNodeCall(execute, options.signal);
	};
	/**
	* A risk challenge is recoverable WITHOUT a human when the official page can
	* answer instead: the page signs its own requests with the browser's real TLS
	* and JS fingerprint, which is the one thing the direct path cannot imitate.
	* Measured 2026-11-26: the direct path was refused while the very same account
	* answered normally through the page.
	*
	* Never replays a turn that already streamed text, so an answer cannot be
	* duplicated, and never when the user explicitly forced the direct path.
	*/
	const rescueThroughOfficialPage = async (error) => {
		if (!(error instanceof DoubaoUpstreamError && !error.local && (error.code === CODE_RATE_LIMITED || error.rateLimited) && !emittedText && !taskModeEnabled(options) && options.skill === void 0 && options.modelKey !== "image-gen" && process.env.DSH_DOUBAO_BROWSER_RELAY === void 0 && !browserRelayEnabled() && browserRelayAvailable())) throw error;
		process.stderr.write("[risk] 710022004 on the direct path; retrying this turn through the official page\n");
		try {
			const result = await call(false, true);
			clearRiskCircuit();
			process.stderr.write("[risk] the official page answered; direct requests resume on the next turn\n");
			return result;
		} catch (relayError) {
			throw isRiskChallengeFailure(relayError) ? new DoubaoUpstreamError("豆包风控在两条路径上都要求验证（插件直连与官方页面都被要求过滑块），这是账号级风控，只能由人完成验证。运行 dsh-connect-doubao-doctor --verify 打开官方页面过滑块，再 --resume 解除本地冷却。", CODE_RATE_LIMITED, true, { kind: "rate_limited" }) : error;
		}
	};
	try {
		return await call(wanted);
	} catch (error) {
		const taskRuntimeMissing = error instanceof DoubaoUpstreamError && (error.code === CODE_TASK_RUNTIME_UNAVAILABLE || /agent_err_real_answer/.test(error.message));
		if (!wanted || !taskRuntimeMissing || emittedText) return await rescueThroughOfficialPage(error);
		try {
			return await call(false);
		} catch (plainError) {
			return await rescueThroughOfficialPage(plainError);
		}
	}
}
const renewals = /* @__PURE__ */ new Map();
/**
* Drop every rotated cookie this module has absorbed.
*
* MUST be called together with `invalidateCredentialCache()`. The two caches
* hold halves of one credential: the auth cache holds what was decrypted from
* disk, and `renewals` holds what the server rotated onto us afterwards
* (`x-ms-token`, `bd_sso_hi3jfd`). Clearing one without the other leaves the
* stale half behind — after a credential refresh the freshly-read cookies
* would immediately be overwritten by values from the previous session, and
* the user would be told to sign in again for no real reason.
*/
function invalidateRenewals() {
	renewals.clear();
}
/** Record rotated cookies (`x-ms-token`, `bd_sso_hi3jfd`) for the next request. */
function absorbSetCookies(headers) {
	const msToken = headers.get("x-ms-token");
	if (msToken) renewals.set("msToken", msToken);
	const setCookie = headers.get("set-cookie");
	if (!setCookie) return;
	for (const part of setCookie.split(/,\s*(?=[A-Za-z0-9_-]+=)/)) {
		const [pair] = part.split(";");
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (name && value) renewals.set(name, value);
	}
}
/** Cookie header with any rotated values overlaid. Values never leave memory. */
function applyRenewals(header) {
	if (renewals.size === 0) return header;
	const pairs = /* @__PURE__ */ new Map();
	for (const part of header.split(/;\s*/)) {
		const eq = part.indexOf("=");
		if (eq > 0) pairs.set(part.slice(0, eq).trim(), part.slice(eq + 1));
	}
	for (const [name, value] of renewals) pairs.set(name, value);
	return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function consumeStream(response, callbacks, options = {}) {
	const reader = response.body?.getReader();
	if (!reader) throw new DoubaoUpstreamError("Doubao returned an empty response body.");
	const decoder = new TextDecoder();
	let buffer = "";
	const texts = [];
	/** Text carried by STREAM_MSG_NOTIFY instead of by chunk deltas. */
	const notifyTexts = [];
	/** Generated images, in arrival order (may repeat a task while it streams). */
	const images = [];
	/** Private reasoning (deep-think turns), kept out of the answer. */
	const reasoningParts = [];
	/** Shared per-stream state across `10040` / `10000` / `CHUNK_DELTA` frames. */
	const blockState = createBlockCollectState();
	let conversationId;
	let messageId;
	let model;
	let thinking = false;
	let lastEventId;
	let ended = false;
	/**
	* Every event name seen, in arrival order (deduped).
	*
	* Task mode answers with a richer event vocabulary than chat, so an empty
	* completion is usually "the text lives in an event we do not harvest yet"
	* rather than "the server said nothing". Naming the events turns an opaque
	* failure into a next step.
	*/
	function toFiniteNumber(value) {
		if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : void 0;
		}
	}
	function parseJsonObject(value) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
		if (typeof value !== "string" || value.trim() === "") return void 0;
		try {
			const parsed = JSON.parse(value);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {}
	}
	function parseContextWindowUsage(raw) {
		const obj = parseJsonObject(raw);
		if (obj === void 0) return void 0;
		const systemPrompt = toFiniteNumber(obj.system_prompt);
		const messages = toFiniteNumber(obj.messages);
		const skills = toFiniteNumber(obj.skills);
		const tools = toFiniteNumber(obj.tools);
		const totalWindowSize = toFiniteNumber(obj.total_window_size);
		if (systemPrompt === void 0 && messages === void 0 && skills === void 0 && tools === void 0 && totalWindowSize === void 0) return;
		const s = Math.max(0, systemPrompt ?? 0);
		const m = Math.max(0, messages ?? 0);
		const k = Math.max(0, skills ?? 0);
		const t = Math.max(0, tools ?? 0);
		return {
			systemPrompt: s,
			messages: m,
			skills: k,
			tools: t,
			totalWindowSize: Math.max(0, totalWindowSize ?? 0),
			totalUsed: s + m + k + t
		};
	}
	function collectTelemetryFromExt(ext, target) {
		const record = parseJsonObject(ext);
		if (record === void 0) return;
		const contextWindow = parseContextWindowUsage(record.context_window_usage);
		if (contextWindow !== void 0) target.contextWindowUsage = contextWindow;
		const teaCost = parseJsonObject(record.tea_tags_time_cost);
		if (teaCost !== void 0) {
			const ack = toFiniteNumber(teaCost.ack_cost_time);
			if (ack !== void 0 && ack >= 0) target.ackCostMs = ack;
			const firstPacket = toFiniteNumber(teaCost.first_packet_cost_time);
			if (firstPacket !== void 0 && firstPacket >= 0) target.firstPacketCostMs = firstPacket;
		}
		const finishTime = toFiniteNumber(record.finish_time_ms);
		if (finishTime !== void 0 && finishTime >= 0) target.finishTimeMs = finishTime;
		if (typeof record.finish_reason_chat === "string" && record.finish_reason_chat !== "") target.finishReasonChat = record.finish_reason_chat;
	}
	function collectTelemetry(payload, target) {
		if (payload === null || typeof payload !== "object") return;
		const record = payload;
		collectTelemetryFromExt(record.ext, target);
		collectTelemetryFromExt(record.content?.ext, target);
		collectTelemetryFromExt(record.message?.ext, target);
		if (Array.isArray(record.patch_op)) for (const op of record.patch_op) collectTelemetryFromExt(op?.patch_value?.ext, target);
	}
	const events = /* @__PURE__ */ new Set();
	/** The agent that served this turn, when the server names one. */
	let intentionAgent;
	/** Server-side timing & context window telemetry harvested across SSE frames. */
	const telemetry = {};
	/**
	* `expose_reason` of a task turn whose runtime was unreachable.
	*
	* Recorded instead of surfacing its placeholder text (「出了点问题，请稍后重试。」),
	* which reads like a transient glitch and hides the actual cause.
	*/
	let taskAgentError;
	const handle = (frame) => {
		const name = frame.event ?? "";
		if (name) events.add(name);
		if (process.env.DSH_DOUBAO_DEBUG_FRAMES === "1" && frame.data) process.stderr.write(`[frame ${name || "(none)"}] ${frame.data.slice(0, 1500)}\n`);
		if (name && callbacks?.onEvent) callbacks.onEvent(name);
		if (frame.id) lastEventId = frame.id;
		if (!frame.data) return;
		let payload;
		try {
			payload = JSON.parse(frame.data);
		} catch {
			return;
		}
		collectTelemetry(payload, telemetry);
		if (name === "STREAM_ERROR") {
			const record = payload;
			const code = record.error_code;
			const message = record.error_msg ?? "unknown stream error";
			const rateLimited = code === 710022004 || /rate limit/i.test(message);
			if (isContentModerationNotice(message)) throw new DoubaoUpstreamError(`豆包内容审核拦截了这条消息：${message}`, code, false, { kind: "content_blocked" });
			throw new DoubaoUpstreamError(rateLimited ? "豆包请求触发风控（710022004）。请停止重试并等待风控缓解；如果豆包网页出现人机验证，请完成验证。插件无法绕过风控。" : `Doubao stream error ${code ?? "?"}: ${message}`, code, rateLimited);
		}
		if (name === "SSE_ACK") {
			const ack = payload;
			conversationId = ack.ack_client_meta?.conversation_id ?? conversationId;
			messageId = ack.query_list?.[0]?.question_id ?? messageId;
			return;
		}
		if (name === "FULL_MSG_NOTIFY" || name === "STREAM_MSG_NOTIFY") {
			const record = payload;
			messageId = record.message?.message_id ?? messageId;
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			const ext = record.content?.ext ?? record.message?.ext ?? record.ext;
			if (ext !== void 0 && ext !== null && typeof ext === "object") {
				const agent = ext.intention_agent_name;
				if (typeof agent === "string" && agent !== "") intentionAgent = agent;
				const reason = ext.expose_reason;
				if (typeof reason === "string" && /agent_err_real_answer/.test(reason)) taskAgentError = reason;
			}
			if (name === "STREAM_MSG_NOTIFY") {
				thinking = thinking || extractThinking(payload);
				const acc = {
					answer: [],
					thinking: [],
					images
				};
				collectBlocks(record.content?.content_block, acc, blockState);
				const joinedAccThinking = acc.thinking.join("");
				const priorThinking = reasoningParts.join("");
				if (!(joinedAccThinking !== "" && priorThinking !== "" && joinedAccThinking === priorThinking)) for (const piece of acc.thinking) {
					if (!piece) continue;
					reasoningParts.push(piece);
					if (callbacks?.onThinking) callbacks.onThinking(piece);
				}
				for (const piece of acc.answer) {
					if (!piece) continue;
					notifyTexts.push(piece);
					if (callbacks?.onText) callbacks.onText(piece);
				}
			}
			return;
		}
		if (name === "STREAM_CHUNK" || name === "CHUNK_DELTA") {
			model = model ?? extractModel(payload);
			thinking = thinking || extractThinking(payload);
			const acc = {
				answer: [],
				thinking: [],
				images
			};
			collectBlocks(payload, acc, blockState);
			for (const piece of acc.thinking) {
				if (!piece) continue;
				reasoningParts.push(piece);
				if (callbacks?.onThinking) callbacks.onThinking(piece);
			}
			for (const text of acc.answer) {
				if (!text) continue;
				if (callbacks?.onText) callbacks.onText(text);
				texts.push(text);
			}
			return;
		}
		if (name === "SSE_REPLY_END") ended = true;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { frames, rest } = parseFrames(buffer);
			buffer = rest;
			for (const frame of frames) handle(frame);
			if (ended) break;
		}
		const tail = decoder.decode();
		if (tail) {
			const { frames, rest } = parseFrames(buffer + tail);
			buffer = rest;
			for (const frame of frames) handle(frame);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const chunkText = texts.join("");
	const text = stripPromptEcho(assembleReplyText(notifyTexts.join(""), chunkText));
	if (taskAgentError !== void 0) throw new DoubaoUpstreamError(`Doubao accepted the task but its executing runtime was unreachable (${taskAgentError}). The 「工作任务」 runtime is attached by the desktop client; without it the agent has nowhere to run.`, CODE_TASK_RUNTIME_UNAVAILABLE);
	if (!ended) {
		const received = texts.join("").length + notifyTexts.join("").length;
		throw new DoubaoUpstreamError(`Doubao closed the stream before the reply finished${received > 0 ? ` after ${received} characters` : ""}; the answer is incomplete. Retry the turn.`, void 0, false, { truncated: true });
	}
	if (isContentModerationNotice(text)) throw new DoubaoUpstreamError(`豆包内容审核拦截了这条消息：${text}`, void 0, false, { kind: "content_blocked" });
	const uniqueImages = [...new Map(images.map((image) => [image.url, image])).values()];
	if (!text && uniqueImages.length === 0) {
		const seen = [...events];
		throw new DoubaoUpstreamError(`Doubao returned an empty completion${lastEventId ? ` (last event id ${lastEventId})` : ""}${seen.length > 0 ? `; events seen: ${seen.join(", ")}` : "; no events at all"}.`);
	}
	return {
		text,
		...model !== void 0 ? { model } : {},
		...conversationId !== void 0 ? { conversationId } : {},
		...messageId !== void 0 ? { messageId } : {},
		...reasoningParts.length > 0 ? { reasoningText: reasoningParts.join("") } : {},
		...intentionAgent !== void 0 ? { intentionAgent } : {},
		...Object.keys(telemetry).length > 0 ? { telemetry } : {},
		images: uniqueImages,
		thinking: thinking || blockState.sawThinkingBlock === true || reasoningParts.length > 0
	};
}
/**
* Join the two halves of a reply.
*
* The opening of every answer arrives in STREAM_MSG_NOTIFY and the remainder as
* patch deltas in STREAM_CHUNK. Reading only the chunks swallowed the first
* character of EVERY reply — 「1+1等于2。」 came back as 「+1等于2。」, 「我是豆包」
* as 「是豆包」 — and nothing failed loudly, which is exactly why it survived.
*
* A cumulative chunk stream (one that re-sends what was already delivered)
* already starts with the notification text; that case is detected rather than
* concatenated twice. Exported so the rule can be tested without a live stream.
*/
function assembleReplyText(notifyText, chunkText) {
	if (notifyText === "") return chunkText;
	if (chunkText === "") return notifyText;
	return chunkText.startsWith(notifyText) ? chunkText : notifyText + chunkText;
}
/**
* Remove the echoed user prompt from the front of the assembled text.
*
* Doubao's first chunk replays the inbound message; keeping it would make every
* reply appear to start with the user's own words.
*/
function stripPromptEcho(raw) {
	return raw.trimStart();
}
/**
* Collect a complete reply. Convenience wrapper over `streamChat` for callers
* that do not need incremental deltas.
*/
async function chat(prompt, options = {}) {
	return streamChat(prompt, options);
}
/** The server's business code for "this session is not valid". */
const CODE_SESSION_DEAD = 710012001;
/** The server's business code for a risk-control slider challenge. */
const CODE_RATE_LIMITED = 710022004;
/**
* `block_type` of the deep-think container.
*
* A 深度思考 turn opens one `10040` block (the 「正在思考 / 已完成思考」 shell) and
* then streams the reasoning as `10000` blocks whose `parent_id` is its id.
* Captured 2026-10-23.
*/
const THINKING_BLOCK_TYPE = 10040;
/**
* The server's business code when a 「工作任务」 was accepted but its executing
* runtime could not be reached (`expose_reason: agent_err_real_answer`).
*
* This is the signature of "the mode is right, the local runtime is not
* attached" — the desktop client's CUA runtime registers itself; an external
* client has nothing to register, so the agent has nowhere to run.
*/
const CODE_TASK_RUNTIME_UNAVAILABLE = 710010702;
/**
* The server's business code for "common invalid param".
*
* Observed on a CONTINUATION turn whose remembered `conversation_id` the
* server no longer accepts (the thread expired or was deleted upstream): the id
* is the only parameter that differs from a fresh-conversation request, and the
* same request then fails identically on every retry.
*/
const CODE_INVALID_PARAM = 710020202;
/**
* Whether the upstream rejected the request parameters outright.
*
* Callers that were continuing a remembered conversation should drop the id
* after this failure — keeping it would repeat the same rejection for the rest
* of the session TTL instead of opening a fresh thread.
*/
function isInvalidParamFailure(error) {
	return error instanceof DoubaoUpstreamError && error.code === CODE_INVALID_PARAM;
}
/**
* Map one upstream error onto its class.
*
* Order matters: the explicit evidence (code, hint, HTTP status) is consulted
* before the generic `upstream` bucket, and the old catch-all was wrong — every
* unrecognised failure was reported as `network`, i.e. "check your connection",
* for HTTP 400s and business errors that a retry cannot fix.
*/
function classifyDoubaoFailure(error) {
	if (error.kindHint !== void 0) return error.kindHint;
	if (error.rateLimited || error.code === CODE_RATE_LIMITED) return "rate_limited";
	if (error.code === CODE_TASK_RUNTIME_UNAVAILABLE) return "task_runtime_unavailable";
	if (error.code === CODE_SESSION_DEAD) return "session_dead";
	if (error.httpStatus === 401 || error.httpStatus === 403) return "session_dead";
	if (error.httpStatus === 429) return "quota_exhausted";
	if (error.transport) return "network";
	return "upstream";
}
/**
* Whether the host should retry this failure.
*
* Deliberately narrow. Re-sending a turn costs quota AND opens a server-side
* thread, so only a failure that provably never produced an answer qualifies:
* a transport error before any bytes, or a 5xx. A truncated stream is NOT
* retryable here — the retry would be a fresh conversation that silently
* abandons the half-received one, so the user is told instead.
*/
function isRetryableFailure(error) {
	if (!(error instanceof DoubaoUpstreamError)) return false;
	if (error.transport) return true;
	if (error.httpStatus !== void 0) return error.httpStatus >= 500;
	return false;
}
/**
* User-facing text per class.
*
* The slider wording matters: it is the one failure the user can actually fix,
* and the only place they can fix it is the Doubao desktop client — retrying
* from the Harness will never clear it.
*/
const DOUBAO_ERROR_HINTS = {
	rate_limited: "豆包请求触发风控（710022004）—— 这是人机验证（滑块），不是普通限流，插件不会也无法绕过。先对齐网页身份（多数情况就是它引起的）：dsh-connect-doubao-doctor --fingerprint，再 --resume 解除本地冷却；仍被要求验证时用 --verify 打开官方页面人工过滑块；想彻底避开就用 --relay on 让对话请求走真实浏览器。",
	quota_exhausted: "豆包额度已用尽。请等待额度窗口重置，或在豆包客户端查看「订阅与额度管理」。",
	session_dead: "豆包登录态失效。请在豆包客户端重新登录，然后重试。",
	network: "连接豆包失败（网络或超时）。请检查网络后重试。",
	task_runtime_unavailable: "豆包把这个账号路由到了「工作任务」代理，而该任务的执行运行时只存在于豆包客户端进程里，外部客户端接不上。请打开豆包客户端，把输入框上方的开关切回「对话」，然后重试；需要多步执行的话，交给 DSH 自己的工具来做。",
	upstream: "豆包返回了错误响应（不是网络问题，重试通常无效）。",
	content_blocked: "豆包的内容审核拦截了这条消息 —— 不是网络、额度或滑块风控的问题。插件不会也无法绕过内容审核。请换一种表达、或把问题拆小后重试；如果是误判，在豆包客户端长按该条消息 →「反馈与举报」。反复触发可能导致账号被限制。",
	context_overflow: "这次请求的内容超过了豆包单次请求上限（256 KiB 的 UTF-8 文本，约 26 万 ASCII 字符）。请压缩上下文或缩短单条消息后重试；DSH 通常会自动压缩并重发。"
};
/**
* Whether a text is Doubao's content-moderation notice rather than an answer.
*
* Deliberately narrow: a model that EXPLAINS the notice (a user asking
* 「这句提示是什么意思」) quotes it inside a normal reply, and turning that reply
* into an error would be worse than showing it. Both a head that names the
* message as violating and the appeal hint are required, and the text must be
* short — the real notice is one sentence.
*/
function isContentModerationNotice(text) {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed.length > 200) return false;
	const flagged = /涉嫌违反|违反[^。！？\n]{0,6}使用规范/.test(trimmed);
	const appeal = /反馈与举报/.test(trimmed);
	const instruction = /长按|本条消息|该内容|这条消息/.test(trimmed);
	return flagged && appeal && instruction;
}
/** Build a user-facing message for a Doubao failure. */
/**
* Whether a failure is the server's slider challenge itself.
*
* Excludes the local cooldown: a turn the plugin refused never reached the
* network, so it has nothing to recover and must not look like a challenge.
*/
function isRiskChallengeFailure(error) {
	if (!(error instanceof DoubaoUpstreamError)) return false;
	if (error.local) return false;
	return error.code === CODE_RATE_LIMITED || error.rateLimited;
}
function describeDoubaoFailure(error) {
	if (error instanceof DoubaoUpstreamError) {
		if (error.local) return `${error.message}（如果已经在官方页面完成过人机验证，运行 dsh-connect-doubao-doctor --resume 立即解除本地冷却。）`;
		return `${DOUBAO_ERROR_HINTS[classifyDoubaoFailure(error)]}（${error.message}）`;
	}
	return `豆包请求失败：${error?.message ?? String(error)}`;
}
/** Quick reachability probe that does not consume any inference quota. */
async function probeAccount(credentials) {
	if (!credentials.ok) return {
		ok: false,
		detail: credentials.reason ?? "no credentials"
	};
	const url = buildQueryUrl(ACCOUNT_ENDPOINT);
	const headers = buildHeaders(credentials);
	delete headers["content-type"];
	delete headers["last-event-id"];
	try {
		const response = await fetch(url, {
			method: "GET",
			headers
		});
		const payload = await response.json();
		if (!response.ok) return {
			ok: false,
			detail: `HTTP ${response.status}`
		};
		if (payload.data?.name) return {
			ok: true,
			detail: "signed in"
		};
		return {
			ok: false,
			detail: "session rejected by server"
		};
	} catch (error) {
		return {
			ok: false,
			detail: error.message
		};
	}
}
// src/doubao-quota.ts
/**
* Doubao quota.
*
* Doubao does NOT expose rate-limit headers on the chat endpoint — there is no
* `x-ratelimit-*` and no `x-event-states-limit`. The authoritative source is a
* separate summary endpoint that the desktop app calls on launch.
*
* It reports `window_limit_groups[].window_limits[]`, where each entry is one
* rolling consumption window:
*
*   window_type 4 -> package points   (the ONE main allowance since the 2026-11
*                                     repricing: 「标准套餐 已用 449/9,000」, i.e.
*                                     package credits. Reported in
*                                     `window_limit_section` with `item_type: 1`
*                                     and formatted amounts.)
*   window_type 3 -> bonus quota      (a promotional grant from
*                                     `incentive_quota_section`, with an expiry
*                                     but no start: 「活动赠送额度」)
*
* LEGACY — no longer returned by the live endpoint as of 2026-11, kept so an
* older reading (or a rollback) still maps instead of vanishing:
*
*   window_type 1 -> 5-hour limit   (verified: end_time - start_time = 18e6 ms)
*   window_type 2 -> weekly quota    (verified: end_time - start_time = 604.8e6 ms)
*
* Doubao replaced the rolling 5-hour/week windows with a single package-credit
* allowance; an account that still reports the old types maps them as before,
* and one that reports neither simply has no such row.
*/
/** Quota results are cached briefly so a chatty session does not hammer the API. */
const QUOTA_TTL_MS = 3e5;
/**
* Parse one of the server's amount fields.
*
* They arrive as formatted strings ("2,100"), and they are the only source of a
* percentage for the plans that omit `used_percent`. Returns undefined rather
* than NaN so callers can tell "no data" from "zero".
*/
function parseAmount(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value !== "string") return void 0;
	const digits = value.replace(/[^0-9.]/g, "");
	if (digits === "") return void 0;
	const parsed = Number(digits);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function mapWindowType(value) {
	if (value === 4) return "package";
	if (value === 1) return "five_hour";
	if (value === 2) return "weekly";
	if (value === 3) return "incentive";
}
/**
* Convert one server window into the shape the UI consumes.
*
* Three shapes are observed:
*
* - both timestamps present: a rolling window with a real reset instant;
* - both zero: the window has not started yet (Doubao renders
*   「开始使用后计时」); the reset instant is unknown and MUST NOT be invented;
* - only `end_time`: a promotional grant with an expiry but no start.
*
* Reconstructing a missing start from the nominal window length used to make
* the card count down to a moment the server never sent — off by up to a week.
*/
function normalizeWindow(raw, label) {
	const type = raw.window_type === void 0 ? void 0 : mapWindowType(raw.window_type);
	if (!type) return void 0;
	const start = raw.start_time ?? 0;
	const end = raw.end_time ?? 0;
	const usedAmount = parseAmount(raw.used_amount);
	const totalAmount = parseAmount(raw.total_amount);
	const fromAmounts = usedAmount !== void 0 && totalAmount !== void 0 && totalAmount > 0 ? Math.min(100, Math.max(0, usedAmount / totalAmount * 100)) : void 0;
	const used = typeof raw.used_percent === "number" ? raw.used_percent : fromAmounts ?? 0;
	const base = {
		type,
		windowType: raw.window_type,
		usedPercent: used,
		remainingPercent: Math.max(0, 100 - used),
		...label === void 0 || label === "" ? {} : { label },
		...usedAmount === void 0 ? {} : { usedAmount },
		...totalAmount === void 0 ? {} : { totalAmount }
	};
	if (end <= 0) return {
		...base,
		resetsAt: 0,
		startedAt: 0,
		windowMs: 0,
		resetUnknown: true,
		startsOnUse: true
	};
	return {
		...base,
		...start <= 0 ? { startsOnUse: true } : {},
		resetsAt: end,
		startedAt: start > 0 ? start : 0,
		windowMs: start > 0 && end > start ? end - start : 0
	};
}
/**
* How long a FAILED reading is reused.
*
* The quota endpoint is consulted before every chat turn, and a failure used to
* be forgotten immediately — so an outage cost every single turn another round
* trip that was going to fail the same way, on the request's critical path. The
* window is short enough that a recovery is invisible (a turn later) and long
* enough to stop that fan-out.
*/
const QUOTA_FAILURE_TTL_MS = 3e4;
/**
* Remember a failed reading, and return it.
*
* One helper because all three failure exits (no credentials, HTTP error,
* thrown) must go through it: a failure that skips the memo is exactly the bug
* this exists to prevent.
*/
function rememberFailure(quota) {
	cachedFailure = quota;
	cachedFailureAt = Date.now();
	return quota;
}
/**
* Only report the account as exhausted when all active quota entitlements say
* so: an exhausted promotional bonus must not block turns while the main
* window still has headroom.
*/
function evaluateQuotaExhausted(data) {
	const hasActiveGroups = (section) => Boolean(section?.window_limit_groups?.some((g) => (g.window_limits?.length ?? 0) > 0));
	const windowExhausted = data?.window_limit_section?.usage_exhausted;
	const enterpriseExhausted = data?.enterprise_window_limit_section?.usage_exhausted;
	const incentiveExhausted = data?.incentive_quota_section?.usage_exhausted;
	const activeFlags = [];
	if (typeof windowExhausted === "boolean") activeFlags.push(windowExhausted);
	if (typeof enterpriseExhausted === "boolean" && hasActiveGroups(data?.enterprise_window_limit_section)) activeFlags.push(enterpriseExhausted);
	if (typeof incentiveExhausted === "boolean" && hasActiveGroups(data?.incentive_quota_section)) activeFlags.push(incentiveExhausted);
	const fallbackFlags = [
		windowExhausted,
		enterpriseExhausted,
		incentiveExhausted
	].filter((flag) => typeof flag === "boolean");
	const flags = activeFlags.length > 0 ? activeFlags : fallbackFlags;
	return flags.length > 0 && flags.every(Boolean);
}
const QUOTA_REQUEST_TIMEOUT_MS = 15e3;
function combineSignals(a, b) {
	if (a === void 0) return b;
	if (b === void 0) return a;
	const anyFn = AbortSignal.any;
	return typeof anyFn === "function" ? anyFn([a, b]) : a;
}
async function fetchQuota(options = {}) {
	const now = Date.now();
	const useCache = options.credentials === void 0;
	if (useCache && !options.force && cached && now - cached.fetchedAt < 3e5) return cached;
	if (useCache && !options.force && cachedFailure !== void 0 && now - cachedFailureAt < QUOTA_FAILURE_TTL_MS) return cachedFailure;
	const fail = (quota) => useCache ? rememberFailure(quota) : quota;
	const credentials = options.credentials ?? loadDoubaoCredentials();
	if (!credentials.ok) return fail({
		exhausted: false,
		windows: [],
		fetchedAt: now,
		error: credentials.reason ?? "还没有浏览器登录态。请在豆包卡片里点「重新登录」扫码一次。"
	});
	try {
		const timeoutSignal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS) : void 0;
		const signal = combineSignals(options.signal, timeoutSignal);
		const response = await fetch(buildQueryUrl(QUOTA_ENDPOINT, credentials.pairs.get("msToken")), {
			method: "POST",
			headers: buildHeaders(credentials, { "content-type": "application/json" }),
			body: JSON.stringify({ product_line: "membership" }),
			...signal === void 0 ? {} : { signal }
		});
		if (!response.ok) return fail({
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: response.status === 401 || response.status === 403 ? `HTTP ${response.status} (session rejected)` : `HTTP ${response.status}`
		});
		const payload = await response.json();
		if (typeof payload.code === "number" && payload.code !== 0) {
			const msg = typeof payload.msg === "string" && payload.msg !== "" ? payload.msg : typeof payload.message === "string" ? payload.message : "";
			return fail({
				exhausted: false,
				windows: [],
				fetchedAt: now,
				error: payload.code === 710012001 ? `Doubao session rejected (710012001)${msg ? `: ${msg}` : ""}` : payload.code === 710022004 ? `Doubao risk challenge (710022004)${msg ? `: ${msg}` : ""}` : `Doubao quota error ${payload.code}${msg ? `: ${msg}` : ""}`
			});
		}
		if (payload.data === void 0 || payload.data === null || typeof payload.data !== "object") return fail({
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: "Doubao quota response missing data"
		});
		const sections = [payload.data.window_limit_section, payload.data.incentive_quota_section];
		const windows = [];
		for (const section of sections) for (const group of section?.window_limit_groups ?? []) for (const limit of group.window_limits ?? []) {
			const normalized = normalizeWindow(limit, group.feature_group_name);
			if (normalized) windows.push(normalized);
		}
		const quota = {
			exhausted: evaluateQuotaExhausted(payload.data),
			windows,
			fetchedAt: now
		};
		const plan = payload.data.current_subscription?.display?.short_name;
		if (plan) quota.plan = plan;
		if (payload.data.member_info?.hasActiveSubscription !== void 0) quota.planActive = payload.data.member_info.hasActiveSubscription;
		if (useCache) {
			cached = quota;
			cachedFailure = void 0;
		}
		return quota;
	} catch (error) {
		return fail({
			exhausted: false,
			windows: [],
			fetchedAt: now,
			error: error.message
		});
	}
}
let cached;
/** The last FAILED reading, reused for {@link QUOTA_FAILURE_TTL_MS}. */
let cachedFailure;
let cachedFailureAt = 0;
/** Drop the cached reading so the next call hits the server. */
function invalidateQuotaCache() {
	cached = void 0;
	cachedFailure = void 0;
	cachedFailureAt = 0;
}
/** Convenience lookup for a specific window. */
function findWindow(quota, type) {
	return quota.windows.find((window) => window.type === type);
}
/**
* Milliseconds until a window resets, clamped at zero.
* Drives the countdown the user asked for.
*/
function millisUntilReset(window, now = Date.now()) {
	if (window.resetUnknown === true) return 0;
	return Math.max(0, window.resetsAt - now);
}
/** Human-readable duration, e.g. `4h 12m`. */
function formatDuration(ms) {
	const total = Math.floor(ms / 1e3);
	const days = Math.floor(total / 86400);
	const hours = Math.floor(total % 86400 / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	const parts = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (!days && !hours && seconds) parts.push(`${seconds}s`);
	return parts.join(" ") || "0s";
}
export { parseToolCalls as $, findReasoningLevel as $t, classifyDoubaoFailure as A, DEEP_THINK_ON as At, isRiskChallengeFailure as B, DOUBAO_REASONING_LEVELS as Bt, applyTaskBookkeeping as C, listDoubaoProfiles as Ct, buildHeaders as D, CHAT_AGENT_MODE as Dt, buildGeneralTaskParam as E, setProfileOverride as Et, extractModel as F, DOUBAO_IMAGE_MODEL_NAME as Ft, streamChat as G, TASK_AGENT_MODE as Gt, parseFrames as H, DOUBAO_UNAVAILABLE_MODELS as Ht, invalidateRenewals as I, DOUBAO_MAX_TOKENS as It, unsupportedLocalTaskResult as J, TASK_SANDBOX_AUTH_ALLOW_ALL as Jt, taskModeEnabled as K, TASK_RUNTIME_CLOUD_VM as Kt, isContentModerationNotice as L, DOUBAO_MODELS as Lt, collectBlocks as M, DOUBAO_CONTEXT_WINDOW as Mt, createBlockCollectState as N, DOUBAO_DEFAULT_MODEL_ID as Nt, buildQueryUrl as O, CREATION_BLOCK_TYPE as Ot, describeDoubaoFailure as P, DOUBAO_IMAGE_MODEL_ID as Pt, dedupeCalls as Q, findDoubaoModel as Qt, isInvalidParamFailure as R, DOUBAO_PROVIDER as Rt, applyRenewals as S, findDoubaoUserDataDir as St, buildChatBody as T, resolveUserProvided as Tt, probeAccount as U, NO_THINKING_MODEL_IDS as Ut, isTaskBookkeeping as V, DOUBAO_SKILLS as Vt, riskCircuitRemainingMs as W, SKILL_CARRIER_MODEL_ID as Wt, TOOL_FENCE_LANGUAGE as X, doubaoCatalogEntries as Xt, withImagePrefix as Y, discoverDoubaoModels as Yt, buildToolContract as Z, enabledModelsOf as Zt, QUOTA_ENDPOINT as _, loadDoubaoCredentials as _t, formatDuration as a, reasoningLevelOf as an, browserLogin as at, TOOL_LOCAL_COMPLETE_ENDPOINT as b, describeProfileLocation as bt, normalizeWindow as c, writeBrowserFingerprint as ct, CHAT_ENDPOINT as d, REQUIRED_COOKIE_NAMES as dt, inputSkillOf as en, taskWorkspaceOperationsToDshCalls as et, CLIENT_PARAMS as f, clearBrowserCredentials as ft, DoubaoUpstreamError as g, loadBrowserCredentials as gt, DOUBAO_VERSION as h, invalidateCredentialCache as ht, findWindow as i, needDeepThinkValue as in, openOfficialChat as it, clearRiskCircuit as j, DEFAULT_REASONING_LEVEL_ID as jt, chat as k, DEEP_THINK_OFF as kt, ACCOUNT_ENDPOINT as l, CORE_AUTH_COOKIE_NAMES as lt, DOUBAO_ERROR_HINTS as m, hasBrowserCredentials as mt, evaluateQuotaExhausted as n, isTaskModel as nn, browserRelayAvailable as nt, invalidateQuotaCache as o, supportsReasoning as on, captureBrowserFingerprint as ot, DEFAULT_BOT_ID as p, clearCredentialCache as pt, taskWorkspaceOf as q, TASK_RUNTIME_LOCAL_PC as qt, fetchQuota as r, levelIdOf as rn, browserRelayEnabled as rt, millisUntilReset as s, readBrowserFingerprint as st, QUOTA_TTL_MS as t, isKnownModelId as tn, toolResultAsText as tt, ACTION_BAR_BRIEF_LIST_ENDPOINT as u, CREDENTIAL_TTL_MS as ut, RUNTIME_VERSION as v, saveBrowserCredentials as vt, assembleReplyText as w, looksLikeProfile as wt, TOOL_LOCAL_UPLOAD_ENDPOINT as x, extractUserDataDir as xt, TOOL_LOCAL_ACK_ENDPOINT as y, PROFILE_ENV as yt, isRetryableFailure as z, DOUBAO_PROVIDER_DISPLAY_NAME as zt };
