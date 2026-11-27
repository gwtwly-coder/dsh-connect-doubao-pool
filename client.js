/**
 * dsh-connect-doubao-pool —— 客户端
 *
 * 一个设置页（`settings.section`）+ 它左侧导航那一格图标（`settings.section.icon`）。
 * 页面长相照 dsh-connect-workbuddy 的「账号池」：开关、勾选、批量检测、逐行操作、
 * 底部扫码/导入/导出。
 *
 * 走的是 ModuleLoader 那套运行时 require，不是 ESM——宿主只按这个形态注入客户端
 * 代码。所以下面用 React.createElement，不写 JSX（没有编译步骤）。
 */
window.__ModuleLoader__.load({
	// id 必须是包名：boot 图里的客户端模块按包名 require，写别的名字等于注册了一个没人要的模块，
	// apply 永远不会跑，界面上什么都不出现。
	id: "dsh-connect-doubao-pool",
	factory: (require) => {
		const module = { exports: {} };
		const React = require("react");
		const el = React.createElement;

		const NAMESPACE = "settings.doubaoPool";
		const SECTION_ID = "dsh-connect-doubao-pool";
		const STATE_PATH = "/plugins/doubao-pool/state";
		const ACTION_PATH = "/plugins/doubao-pool/action";
		const MODELS_PATH = "/plugins/doubao-pool/models";
		const WRITE_HEADER = "x-dsh-doubao-pool-write";
		/** 豆包插件自己的扫码登录接口：加号就是调它，然后把它写出来的登录态收进池子。 */
/** 旧的豆包插件扫码接口：现在改成自己的 `login` 动作，这两个常量只为兼容保留。 */
const UPSTREAM_AUTH_PATH = "/plugins/dsh-connect-doubao/auth";
		const STYLE_VERSION = `v${Date.now().toString(36)}`;
	const STYLE_ID = "dsh-doubao-pool-style";
		const PANEL_ID = "dsh-doubao-pool-composer-panel";
		/** 认作「我们这一行」的 provider：接管豆包插件时是 `doubao`，自建 provider 后是 `doubao-pool`。 */
		const COMPOSER_PROVIDERS = ["doubao", "doubao-pool"];
		const REFRESH_MS = 30_000;
/** 池子变了就吼一声：设置卡片和输入框读数是两个组件，不广播就各看各的旧数据。 */
const CHANGE_EVENT = "dsh-doubao-pool:changed";
function broadcastChange() {
	try {
		window.dispatchEvent(new Event(CHANGE_EVENT));
	} catch {}
}

		/**
		 * 打开「设置 → 豆包多账号」这一页。
		 *
		 * 照 WorkBuddy 的三段式（它的注释写得很清楚，这里沿用同一套选择器与预算）：
		 *   1. 通过设置外壳的 store 座位直接开：`slots.entries("sidebar.settings")[0]
		 *      .store.create().actions.openSection(sectionId)` —— 这是唯一一条「打开就是
		 *      我们这一页」的路，不依赖 DOM、不依赖文案。
		 *   2. 座位不在（宿主换了实现）就退成 DOM：点开侧边栏的设置触发按钮，等一轮
		 *      布局后按导航行文字点到我们那一行。
		 *   3. 两条都不成，交给 `pluginNavigation.openBundle(包名)` 打开插件详情页。
		 *
		 * 为什么不像别的按钮那样直接 `layout.selectPanel("settings")`：它只保证
		 * 设置面板打开，页面还停在用户上次看的那一节——用户点「设置」是想看我们的
		 * 账号池，落到「外观」上等于没跳。
		 */
		const SETTINGS_PANEL_SELECTOR = "[data-shortcut-modal=\"settings\"]";
		const SETTINGS_TRIGGER_SELECTOR = "button[aria-haspopup=\"dialog\"][aria-expanded]";
		const SETTINGS_SLOT = "sidebar.settings";
		/** 面板同帧就挂上，但导航行的文字等一次 locale 快照，所以给约 300ms 的重试预算。 */
		const RETRY_DELAYS_MS = [0, 60, 70, 80, 90];

		function defaultSchedule(run, ms) {
			try {
				window.setTimeout(run, ms);
			} catch {
				run();
			}
		}

		function buttonsIn(scope) {
			return Array.from(scope.querySelectorAll("button"));
		}

		function findSectionRow(scope, label) {
			const want = String(label ?? "").trim();
			if (want === "") return undefined;
			return buttonsIn(scope).find((button) => (button.textContent ?? "").trim() === want);
		}

		function openThroughStoreSeat(get, sectionId) {
			let slots;
			try {
				slots = get("slots");
			} catch {
				return undefined;
			}
			if (slots === undefined || typeof slots.entries !== "function") return undefined;
			let seat;
			try {
				seat = slots.entries(SETTINGS_SLOT)[0]?.store;
			} catch {
				return undefined;
			}
			if (seat === null || typeof seat !== "object") return undefined;
			if (typeof seat.create !== "function") return undefined;
			try {
				const instance = seat.create();
				const openSection = instance?.actions?.openSection;
				if (typeof openSection === "function") {
					openSection(sectionId);
					return "opened";
				}
			} catch {
				return undefined;
			}
			return undefined;
		}

		function openSettingsSection(options) {
			const doc = options.doc ?? document;
			const schedule = options.schedule ?? defaultSchedule;
			const sectionId = options.sectionId ?? SECTION_ID;
			if (typeof options.get === "function") {
				if (openThroughStoreSeat(options.get, sectionId) === "opened") return true;
			}
			try {
				if (doc.querySelector(SETTINGS_PANEL_SELECTOR) === null) {
					const collapsed = Array.from(doc.querySelectorAll(SETTINGS_TRIGGER_SELECTOR))
						.find((button) => button.getAttribute("aria-expanded") !== "true");
					if (collapsed === undefined) {
						try {
							options.onGiveUp?.();
						} catch {}
						return false;
					}
					collapsed.click();
				}
				let clicked = false;
				let remaining = RETRY_DELAYS_MS.length;
				for (const delay of RETRY_DELAYS_MS) {
					schedule(() => {
						if (clicked) return;
						remaining -= 1;
						try {
							const scope = doc.querySelector(SETTINGS_PANEL_SELECTOR) ?? doc;
							const row = findSectionRow(scope, options.label?.());
							if (row !== undefined) {
								clicked = true;
								row.click();
								return;
							}
						} catch {}
						if (remaining === 0) {
							try {
								options.onGiveUp?.();
							} catch {}
						}
					}, delay);
				}
				return true;
			} catch {
				return false;
			}
		}

		const zh = {
			"nav.label": "豆包多账号"
		};
		const en = {
			"nav.label": "Doubao Accounts"
		};

		/* ---------------------------------------------------------- 样式 */

		function ensureStyles() {
			if (typeof document === "undefined") return;
			// 按「本次加载的版本」去重：改了 CSS 之后旧 <style> 不会继续顶着，
			// 刷新一下页面就换上新样式，不用重启整个窗口。
			const existing = document.getElementById(STYLE_ID);
			if (existing !== null && existing.getAttribute("data-v") === STYLE_VERSION) return;
			if (existing !== null) existing.remove();
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.setAttribute("data-v", STYLE_VERSION);
			style.textContent = `
.dbp-root {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 2px 2px 28px;
	color: var(--dsw-alias-label-primary, #e6e8eb);
	font-size: 13px;
	line-height: 1.5;
}
.dbp-head { display: flex; flex-direction: column; gap: 4px; }
.dbp-title { font-size: 16px; font-weight: 600; letter-spacing: .01em; }
.dbp-sub { color: var(--dsw-alias-label-secondary, #9aa1ac); font-size: 12px; }
.dbp-card {
	border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.09));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.028));
	padding: 14px 16px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.dbp-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dbp-row-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dbp-label { font-weight: 560; }
.dbp-hint { color: var(--dsw-alias-label-secondary, #9aa1ac); font-size: 12px; }
.dbp-caret {
	width: 16px;
	height: 16px;
	padding: 0;
	border: 0;
	border-radius: 4px;
	background: transparent;
	color: var(--dsw-alias-label-tertiary, #8a8f98);
	font-size: 10px;
	line-height: 16px;
	cursor: pointer;
}
.dbp-caret:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); }
.dbp-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbp-card-head .dbp-count {
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	font-size: 12px;
	font-variant-numeric: tabular-nums;
}
.dbp-spacer { flex: 1 1 auto; }
.dbp-switch {
	position: relative;
	width: 38px;
	height: 22px;
	flex: 0 0 auto;
	border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.14));
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06));
	cursor: pointer;
	transition: background .16s ease, border-color .16s ease;
	padding: 0;
}
.dbp-switch-on {
	background: var(--dsw-alias-state-business-primary, #2f6bff);
	border-color: transparent;
}
.dbp-switch:disabled { opacity: .5; cursor: default; }
.dbp-switch-knob {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 16px;
	height: 16px;
	border-radius: 999px;
	background: #fff;
	transition: transform .16s ease;
}
.dbp-switch-on .dbp-switch-knob { transform: translateX(16px); }
.dbp-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 28px;
	padding: 0 10px;
	border-radius: var(--dsw-radius-sm, 7px);
	border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12));
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.05));
	color: inherit;
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
	transition: background .14s ease, border-color .14s ease, opacity .14s ease;
}
.dbp-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.1)); }
.dbp-btn:disabled { opacity: .45; cursor: default; }
.dbp-btn-primary {
	background: var(--dsw-alias-state-business-primary, #2f6bff);
	border-color: transparent;
	color: #fff;
}
.dbp-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.dbp-btn-danger { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dbp-btn-mini { height: 24px; padding: 0 8px; font-size: 11px; }
.dbp-table { display: flex; flex-direction: column; gap: 6px; }
/* 账号行：两行式卡片（照 WorkBuddy 账号池的行结构），不是表格行。 */
.dbp-arow {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 9px 10px;
	border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.08));
	border-radius: var(--dsw-radius-md, 9px);
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03));
}
.dbp-arow:hover { border-color: var(--dsw-alias-border-primary, rgba(255,255,255,.16)); }
.dbp-arow-active { border-color: var(--dsw-alias-state-business-primary, rgba(47,107,255,.75)); }
.dbp-arow-top, .dbp-arow-bottom { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dbp-arow-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.dbp-arow-dot-ok { background: var(--dsw-alias-state-success-primary, #3ecf8e); }
.dbp-arow-dot-bad { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dbp-arow-dot-idle { background: var(--dsw-alias-label-quaternary, #6b7280); }
.dbp-arow-who {
	font-size: 13px;
	color: var(--dsw-alias-label-primary, #eef1f5);
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.dbp-arow-chip {
	flex: 0 0 auto;
	padding: 0 6px;
	border-radius: 5px;
	background: rgba(255,255,255,.06);
	font-size: 11px;
	line-height: 17px;
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	white-space: nowrap;
}
.dbp-arow-chip-on {
	background: rgba(47,107,255,.18);
	color: var(--dsw-alias-state-business-primary, #6f9bff);
}
.dbp-arow-spacer { flex: 1 1 auto; }
.dbp-arow-num {
	font-size: 15px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary, #f2f4f7);
	font-variant-numeric: tabular-nums;
}
.dbp-arow-state { font-size: 12px; color: var(--dsw-alias-state-success-primary, #3ecf8e); white-space: nowrap; }
.dbp-arow-state-bad { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dbp-arow-note {
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #8a8f98);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.dbp-arow-move { display: inline-flex; flex-direction: column; gap: 0; margin-left: 2px; }
.dbp-arow-move button {
	height: 11px;
	width: 16px;
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--dsw-alias-label-tertiary, #8a8f98);
	font-size: 8px;
	line-height: 11px;
	cursor: pointer;
}
.dbp-arow-move button:disabled { opacity: .35; cursor: default; }
.dbp-acc { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dbp-check { width: 14px; height: 14px; flex: 0 0 auto; accent-color: var(--dsw-alias-state-business-primary, #2f6bff); cursor: pointer; }
.dbp-acc-text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dbp-acc-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dbp-acc-name span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbp-acc-sub { color: var(--dsw-alias-label-secondary, #9aa1ac); font-size: 11px; font-variant-numeric: tabular-nums; }
.dbp-order { color: var(--dsw-alias-label-secondary, #9aa1ac); font-size: 11px; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.dbp-move { display: inline-flex; flex-direction: column; gap: 1px; flex: 0 0 auto; }
.dbp-move button {
	width: 14px;
	height: 11px;
	padding: 0;
	line-height: 9px;
	font-size: 8px;
	border-radius: 3px;
	border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12));
	background: transparent;
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	cursor: pointer;
}
.dbp-move button:disabled { opacity: .3; cursor: default; }
.dbp-badge {
	display: inline-flex;
	align-items: center;
	height: 17px;
	padding: 0 6px;
	border-radius: 999px;
	font-size: 10px;
	font-weight: 560;
	background: var(--dsw-alias-state-business-primary, #2f6bff);
	color: #fff;
	flex: 0 0 auto;
}
.dbp-badge-soft {
	background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.1));
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12));
}
.dbp-metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dbp-metric-main { font-variant-numeric: tabular-nums; font-weight: 560; }
.dbp-metric-sub { color: var(--dsw-alias-label-secondary, #9aa1ac); font-size: 11px; }
.dbp-status { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dbp-dot { width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto; }
.dbp-dot-ok { background: var(--dsw-alias-state-success-primary, #3ecf8e); }
.dbp-dot-bad { background: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dbp-dot-idle { background: var(--dsw-alias-label-secondary, #6b7280); }
.dbp-ok { color: var(--dsw-alias-state-success-primary, #3ecf8e); }
.dbp-bad { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.dbp-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.dbp-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbp-empty {
	padding: 22px 14px;
	text-align: center;
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	font-size: 12px;
	border: 1px dashed var(--dsw-alias-border-secondary, rgba(255,255,255,.12));
	border-radius: var(--dsw-radius-md, 10px);
}
.dbp-alert {
	border-radius: var(--dsw-radius-sm, 7px);
	padding: 8px 10px;
	font-size: 12px;
	border: 1px solid transparent;
	word-break: break-word;
}
.dbp-alert-error {
	color: var(--dsw-alias-state-error-primary, #ff8080);
	background: rgba(255, 107, 107, .09);
	border-color: rgba(255, 107, 107, .28);
}
.dbp-alert-info {
	color: var(--dsw-alias-label-primary, #e6e8eb);
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.05));
	border-color: var(--dsw-alias-border-secondary, rgba(255,255,255,.1));
}
.dbp-note { color: var(--dsw-alias-label-secondary, #9aa1ac); font-size: 11px; }
.dbp-note code {
	font-size: 11px;
	padding: 1px 4px;
	border-radius: 4px;
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.07));
}
.dbp-models {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 4px 0 2px;
	/* 展开后限高滚动：清单再长也不把设置页顶长。 */
	max-height: 248px;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding-right: 2px;
}
.dbp-model-row {
	display: flex;
	align-items: baseline;
	gap: 8px;
	padding: 5px 8px;
	border-radius: var(--dsw-radius-sm, 6px);
	cursor: pointer;
	min-width: 0;
}
.dbp-model-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04)); }
.dbp-model-row input { accent-color: #2f6bff; margin: 0; flex: none; align-self: center; }
.dbp-model-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbp-model-rate {
	font-size: 11px;
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	flex: none;
}
.dbp-model-row:has(input:not(:checked)) .dbp-model-name,
.dbp-model-row:has(input:not(:checked)) .dbp-model-rate {
	color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbp-savebar {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	margin-top: 8px;
}
.dbp-savebar .dbp-hint { margin: 0; }
/* ---------------------------------------------------------------- 输入框读数
   样式逐条对齐 WorkBuddy 的 composer 读数（它自己注明这套尺寸节奏源自
   dsh-connect-trae，MIT）：读数是一行次要文字，不是按钮——静止时没有边框、
   没有底色，padding 只是点击热区；只在指针到来时给一层淡淡的 hover 底。
   字号/行高/颜色写死而不用 inherit：输入框那一行本体的字比旁边的控件大且深，
   inherit 会让读数喊得过响。label-tertiary 与 shell 自己的 ContextMeter 同级。 */
.dbp-cq {
	display: inline-flex;
	align-items: center;
	min-width: 0;
}
.dbp-cq-trigger {
	appearance: none;
	display: inline-flex;
	align-items: center;
	align-self: stretch;
	padding: 2px 6px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary, #999);
	white-space: nowrap;
	cursor: pointer;
	font-variant-numeric: tabular-nums;
}
.dbp-cq-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.dbp-cq-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #5686fe); outline-offset: 1px; }
.dbp-cq-panel {
	position: fixed;
	z-index: 60;
	width: 304px;
	max-height: min(420px, 60vh);
	overflow: auto;
	padding: 10px 0 0;
	border-radius: 14px;
	border: 1px solid rgba(255,255,255,.10);
	background: rgba(22, 24, 30, .72);
	-webkit-backdrop-filter: blur(20px) saturate(140%);
	backdrop-filter: blur(20px) saturate(140%);
	box-shadow: 0 18px 44px rgba(0, 0, 0, .34);
}
.dbp-cq-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 10px 8px;
	border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.08));
}
.dbp-cq-title {
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary, #e6e8eb);
}
.dbp-cq-actions { display: inline-flex; align-items: center; gap: 4px; }
.dbp-cq-action {
	appearance: none;
	border: 0;
	background: transparent;
	border-radius: 6px;
	padding: 2px 6px;
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-secondary, #9aa1ac);
	cursor: pointer;
}
.dbp-cq-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.dbp-cq-action:disabled { opacity: .5; cursor: default; }
.dbp-cq-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
}
.dbp-cq-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
/* 账号列表面板：一行一个号，左边打码手机号、右边剩余额度，当前用的标绿 */
.dbp-cq-table { padding: 2px 0 0; }
.dbp-cq-tr {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 7px 14px;
	cursor: pointer;
	transition: background .12s ease;
}
.dbp-cq-tr:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.dbp-cq-tr-head {
	cursor: default;
	padding: 6px 14px 7px;
	border-bottom: 1px solid rgba(255,255,255,.07);
	font-size: 12px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary, #8b9099);
}
.dbp-cq-tr-head:hover { background: transparent; }
.dbp-cq-th-right { margin-left: auto; }
.dbp-cq-tr-active .dbp-cq-name { color: var(--dsw-alias-label-primary, #f2f4f7); }
.dbp-cq-chosen {
	font-size: 11px;
	line-height: 15px;
	color: var(--dsw-alias-state-success-primary, #3ecf8e);
	white-space: nowrap;
}
.dbp-cq-who { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dbp-cq-lines { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dbp-cq-dot {
	width: 6px;
	height: 6px;
	flex: none;
	border-radius: 50%;
	background: var(--dsw-alias-label-secondary, #6b7280);
	align-self: center;
}
.dbp-cq-dot.dbp-cq-dot-ok { background: var(--dsw-alias-state-success-primary, #3ecf8e); }
.dbp-cq-dot.dbp-cq-dot-bad { background: var(--dsw-alias-state-error-primary, #f0564a); }
.dbp-cq-name {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary, #e6e8eb);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.dbp-cq-note {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary, #8a8f98);
	white-space: nowrap;
}
.dbp-cq-num {
	font-size: 13px;
	line-height: 18px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary, #eef1f5);
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.dbp-cq-current {
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-brand-primary, #5686fe);
	white-space: nowrap;
}
.dbp-cq-foot {
	margin: 6px 8px 8px;
	padding: 7px 10px;
	border-radius: 8px;
	background: rgba(255,255,255,.045);
	font-size: 11px;
	line-height: 16px;
	color: var(--dsw-alias-label-tertiary, #8a8f98);
}
@media (max-width: 720px) {
	.dbp-thead { display: none; }
	.dbp-trow { grid-template-columns: minmax(0, 1fr); gap: 6px; }
	.dbp-actions { justify-content: flex-start; }
}
`;
			document.head.appendChild(style);
		}

		/* ------------------------------------------------------ 文案与格式 */

		function formatRelative(timestamp) {
			if (typeof timestamp !== "number" || timestamp <= 0) return "从未检测";
			const delta = Date.now() - timestamp;
			if (delta < 0) return "刚刚";
			if (delta < 60_000) return "刚刚";
			if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
			if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
			return `${Math.floor(delta / 86_400_000)} 天前`;
		}

		function formatClock(timestamp) {
		if (typeof timestamp !== "number" || timestamp <= 0) return "—";
		const date = new Date(timestamp);
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}

	function formatCountdown(timestamp) {
			if (typeof timestamp !== "number" || timestamp <= 0) return "";
			const delta = timestamp - Date.now();
			if (delta <= 0) return "即将重置";
			const minutes = Math.floor(delta / 60_000);
			if (minutes < 60) return `${minutes} 分钟后重置`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后重置`;
			return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
		}

		/* ------------------------------------------------------ 和后端说话 */

		async function readJson(response) {
			const payload = await response.json().catch(() => null);
			if (!response.ok) {
				const message = typeof payload?.error === "string" && payload.error !== "" ? payload.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}

		function fetchState() {
			return fetch(STATE_PATH, {
				method: "GET",
				credentials: "same-origin",
				headers: { accept: "application/json" }
			}).then(readJson);
		}

		/** 上游 catalog 里的全部豆包模型 + 当前勾选了哪些。 */
		function fetchModels() {
			return fetch(MODELS_PATH, {
				method: "GET",
				credentials: "same-origin",
				headers: { accept: "application/json" }
			}).then(readJson);
		}

		function postAction(action, payload) {
			return fetch(ACTION_PATH, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					[WRITE_HEADER]: "1"
				},
				body: JSON.stringify({ action, ...payload })
			}).then(readJson);
		}

		/** 扫码加号走自己的 `login` 动作：浏览器扫码、cookie 直接进池子，不经过豆包插件。 */
		function upstreamLogin() {
			return postAction("login", {}).then((payload) => {
				if (payload?.ok === true) return payload;
				return { ok: false, error: payload?.error ?? "扫码登录没有完成。" };
			});
		}

		function saveDownload(download) {
			if (download === null || typeof download !== "object") return;
			try {
				const blob = new Blob([download.content ?? ""], { type: download.mime ?? "application/json" });
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = download.filename ?? "doubao-pool.json";
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				setTimeout(() => URL.revokeObjectURL(url), 4_000);
			} catch {}
		}

		/* ---------------------------------------------------------- 小组件 */

		function Switch(props) {
			return el("button", {
				type: "button",
				role: "switch",
				"aria-checked": props.checked === true ? "true" : "false",
				className: `dbp-switch${props.checked === true ? " dbp-switch-on" : ""}`,
				disabled: props.disabled === true,
				onClick: () => props.onChange?.(props.checked !== true),
				title: props.title
			}, el("span", { className: "dbp-switch-knob" }));
		}

		function Button(props) {
			const className = ["dbp-btn", props.variant === "primary" ? "dbp-btn-primary" : "", props.variant === "danger" ? "dbp-btn-danger" : "", props.mini === true ? "dbp-btn-mini" : "", props.className ?? ""]
				.filter((entry) => entry !== "")
				.join(" ");
			return el("button", {
				type: "button",
				className,
				disabled: props.disabled === true,
				onClick: props.onClick,
				title: props.title
			}, props.children);
		}

		function Alert(props) {
			if (props.text === null || props.text === void 0 || props.text === "") return null;
			return el("div", { className: `dbp-alert dbp-alert-${props.kind === "error" ? "error" : "info"}` }, props.text);
		}

		/** 额度格：主数 + 重置倒计时；读不到额度时把原因显示出来。 */
		function QuotaCell(props) {
			const quota = props.quota;
			if (quota === null || quota === void 0) {
				return el("div", { className: "dbp-metric" },
					el("span", { className: "dbp-metric-main" }, "—"),
					el("span", { className: "dbp-metric-sub" }, "未检测")
				);
			}
			if (typeof quota.error === "string" && quota.error !== "") {
				return el("div", { className: "dbp-metric" },
					el("span", { className: "dbp-metric-main dbp-bad" }, "读取失败"),
					el("span", { className: "dbp-metric-sub", title: quota.error }, quota.error.slice(0, 44))
				);
			}
			const remaining = quota.remainingPercent;
			const countdown = quota.resetUnknown === true ? (quota.startsOnUse === true ? "开始使用后计时" : "重置时间未知") : formatCountdown(quota.resetsAt);
			return el("div", { className: "dbp-metric" },
				el("span", { className: `dbp-metric-main${quota.exhausted === true ? " dbp-bad" : ""}` },
					remaining === null || remaining === void 0 ? "—" : `剩余 ${remaining}%`),
				el("span", { className: "dbp-metric-sub" }, countdown === "" ? quota.plan ?? "" : countdown)
			);
		}

		function StatusCell(props) {
			const status = props.status;
			if (status === null || status === void 0) {
				return el("div", { className: "dbp-status" },
					el("span", { className: "dbp-dot dbp-dot-idle" }),
					el("span", { className: "dbp-metric-sub" }, "未检测")
				);
			}
			const ok = status.ok === true;
			return el("div", { className: "dbp-status", title: status.detail ?? "" },
				el("span", { className: `dbp-dot ${ok ? "dbp-dot-ok" : "dbp-dot-bad"}` }),
				el("div", { className: "dbp-metric" },
					el("span", { className: `dbp-metric-main${ok ? " dbp-ok" : " dbp-bad"}` }, ok ? "可用" : "不可用"),
					el("span", { className: "dbp-metric-sub" }, `测得 ${formatRelative(props.testedAt)}`)
				)
			);
		}

		/**
		 * 输入框工具栏上的额度读数（`conversation.input.right`）。
		 *
		 * 位置与形态对齐 WorkBuddy 的 composer 读数（它为此写了一整段理由）：
		 * `input.right` 渲染在 `div.trailing` 的 `standardControls` 里，也就是**模型
		 * 选择器紧左边**；而 `input.left` 排在 `div.tools` 最末，离「完全权限」只有
		 * 8px——两个都可点，伸手去点权限会点到读数上。读数不是动作，挨着模型选择器
		 * 才不跟用户真正瞄着的控件抢。
		 *
		 * 文字也照它的形状：`标签 · 数值`，中间一个间隔点。WorkBuddy 是「积分 · 1,522」，
		 * 豆包的额度是百分比 → 「额度 · 100%」；读不到时数值位是「—」，不留空也不写
		 * 一句解释（解释在点开的面板里）。
		 *
		 * 点一下打开面板：标题 + 重新检测 + 每号一行（状态点、名称、剩余、切换）。
		 * 池子为空、或用户在设置里关掉它，就完全不渲染（返回 null，不留空位）。
		 */
		function ComposerQuota(props) {
			const [view, setView] = React.useState(null);
			const [tick, setTick] = React.useState(0);
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [anchor, setAnchor] = React.useState(null);
			const rootRef = React.useRef(null);

			// 归属判定：这一行只在「当前选中的模型属于豆包」时画。
			// 输入框那一行是 per-session 的共享行，别的 provider 被选中时门口不该挂着豆包额度；
			// 同时也让「另一个连接器插件」和我们在同一格里不打架。
			// `useProjection` 由宿主注入，拿不到就退化成「总是显示」。
			const selectedProvider = (() => {
				if (typeof props?.useProjection !== "function") return undefined;
				try {
					const projection = props.useProjection("modelSelection");
					const provider = (projection?.next ?? projection?.lastUsed)?.provider;
					return typeof provider === "string" && provider !== "" ? provider : undefined;
				} catch {
					return undefined;
				}
			})();
			const owned = selectedProvider === undefined || COMPOSER_PROVIDERS.includes(selectedProvider);

			React.useEffect(() => {
				let alive = true;
				const load = () => {
					fetchState()
						.then((next) => {
							if (alive) setView(next);
						})
						.catch(() => {});
				};
				load();
				const timer = setInterval(load, REFRESH_MS);
				const onLocalChange = () => load();
				window.addEventListener(CHANGE_EVENT, onLocalChange);
				return () => {
					alive = false;
					clearInterval(timer);
					window.removeEventListener(CHANGE_EVENT, onLocalChange);
				};
			}, [tick]);

			// 打开时按触发按钮的矩形把面板钉在它右上角；固定定位可以跳出输入框的滚动容器。
			const place = () => {
				const node = rootRef.current;
				if (node === null) return;
				const rect = node.getBoundingClientRect();
				setAnchor({
					right: Math.max(8, window.innerWidth - rect.right),
					bottom: Math.max(8, window.innerHeight - rect.top + 8)
				});
			};

			// Esc 与点空白处关闭：读数是个可选面板，不该靠再点一次同一个按钮才能关。
			React.useEffect(() => {
				if (!open) return undefined;
				const onDown = (event) => {
					const node = rootRef.current;
					if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
					const panel = document.getElementById(PANEL_ID);
					if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown, true);
				document.addEventListener("keydown", onKey, true);
				window.addEventListener("resize", place);
				return () => {
					document.removeEventListener("mousedown", onDown, true);
					document.removeEventListener("keydown", onKey, true);
					window.removeEventListener("resize", place);
				};
			}, [open]);

			if (!owned) return null;
			if (view === null) return null;
			if (view.ui !== void 0 && view.ui?.showComposer === false) return null;
			const active = view.activeAccount;
			if (active === null || active === void 0) return null;

			const quota = active.quota;
			const remaining = typeof quota?.remainingPercent === "number" ? quota.remainingPercent : null;
			const readFailed = quota !== null && quota !== void 0 && typeof quota.error === "string";
			const remainingAmount = typeof quota?.remainingAmount === "number" ? quota.remainingAmount : null;
			const value = readFailed
				? "—"
				: remainingAmount !== null
					? String(remainingAmount)
					: remaining === null
						? "—"
						: `${remaining}%`;
			const accounts = Array.isArray(view.accounts) ? view.accounts : [];

			const refreshAll = () => {
				if (busy) return;
				setBusy(true);
				postAction("test-all", {})
					.then(() => setTick((next) => next + 1))
					.catch(() => {})
					.finally(() => setBusy(false));
			};
			const switchTo = (id) => {
				if (busy) return;
				setBusy(true);
				postAction("switch", { id })
					.then((result) => {
						if (result !== null && result !== void 0 && result.ok === false) return;
						setTick((next) => next + 1);
					})
					.catch(() => {})
					.finally(() => setBusy(false));
			};

			const panel = open
				? el("div", {
					id: PANEL_ID,
					className: "dbp-cq-panel",
					role: "dialog",
					"aria-label": "豆包工作额度",
					style: anchor === null
						? { right: 16, bottom: 120 }
						: { right: `${anchor.right}px`, bottom: `${anchor.bottom}px` }
				},
					el("div", { className: "dbp-cq-head" },
						el("span", { className: "dbp-cq-title" }, "豆包工作 额度"),
						el("span", { className: "dbp-cq-actions" },
							el("button", {
								type: "button",
								className: "dbp-cq-action",
								disabled: busy,
								title: "重新检测每个账号的可用性与额度",
								onClick: refreshAll
							}, busy ? "刷新中…" : "↻  刷新"),
							typeof props?.onOpenSettings === "function"
								? el("button", {
									type: "button",
									className: "dbp-cq-action",
									onClick: () => {
										setOpen(false);
										props.onOpenSettings();
									}
								}, "⚙  设置")
								: null
						)
					),
					accounts.length === 0
						? el("p", { className: "dbp-cq-foot" }, "账号池是空的。到设置里的「豆包多账号」扫码添加一个账号。")
						: el("div", { className: "dbp-cq-table" },
							el("div", { className: "dbp-cq-tr dbp-cq-tr-head" },
								el("span", null, "账号"),
								el("span", { className: "dbp-cq-th-right" }, "额度")
							),
							accounts.map((account) => {
								const rowQuota = account.quota;
								const rowRemaining = typeof rowQuota?.remainingAmount === "number"
									? rowQuota.remainingAmount
									: typeof rowQuota?.remainingPercent === "number"
										? null
										: null;
								const rowPercent = typeof rowQuota?.remainingPercent === "number" ? rowQuota.remainingPercent : null;
								const rowOk = account.status?.ok !== false && !(rowQuota !== null && rowQuota !== void 0 && typeof rowQuota.error === "string");
								const dotClass = `dbp-cq-dot${rowOk ? (rowQuota?.exhausted === true ? " dbp-cq-dot-bad" : " dbp-cq-dot-ok") : " dbp-cq-dot-bad"}`;
								const label = account.mobile !== undefined && account.mobile !== "" ? account.mobile : account.label;
								const value = rowRemaining !== null
									? String(rowRemaining)
									: rowPercent !== null
										? `${rowPercent}%`
										: "—";
								return el("div", {
									className: `dbp-cq-tr${account.active === true ? " dbp-cq-tr-active" : ""}`,
									key: account.id,
									title: `${account.label}（第${account.order}位）${account.nickname === undefined || account.nickname === "" ? "" : ` · ${account.nickname}`}`,
									onClick: () => switchTo(account.id)
								},
									el("span", { className: "dbp-cq-who" },
										el("span", { className: dotClass }),
										el("span", { className: "dbp-cq-lines" },
											el("span", { className: "dbp-cq-name" }, label),
											account.active === true
												? el("span", { className: "dbp-cq-chosen" }, "当前选用")
												: null
										)
									),
									el("span", { className: "dbp-cq-num" }, value)
								);
							})
						),
					el("p", { className: "dbp-cq-foot" },
						`最近刷新 ${formatClock(accounts.map((account) => account.lastTestedAt).filter((at) => typeof at === "number" && at > 0).sort((a, b) => b - a)[0] ?? Date.now())}`
					)
				)
				: null;

			return el(React.Fragment, null,
				el("span", { className: "dbp-cq", ref: rootRef },
					el("button", {
						type: "button",
						className: "dbp-cq-trigger",
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						title: `${active.label}（第${active.order}位）· 点击查看全部账号`,
						onClick: () => {
							place();
							setOpen((value) => !value);
							// 打开时先按内存里的数据画，同时立刻再取一次，别让面板停在 30 秒前的旧账上。
							setTick((next) => next + 1);
						}
					}, "豆包工作 · ", value)
				),
				panel === null ? null : require("react-dom").createPortal(panel, document.body)
			);
		}

		/**
		 * 一行账号。布局照 WorkBuddy 的账号池（它的每一行是「两行式卡片」而不是表格行）：
		 *   第一行：勾选框 · 状态点 · 打码手机号 · 位置/当前使用 ······ 额度数字
		 *   第二行：可用性 + 测得时间 ······ 切换/测试/删除
		 * 表格那种四列对齐在中文长文案下会把「加入于 4 小时前」挤成两行，而两行式
		 * 卡片右侧天然留出按钮位，窄到 600px 也不用改结构。
		 */
		function AccountRow(props) {
			const account = props.account;
			const setSelected = props.setSelected;
			const status = account.status ?? null;
			const ok = status !== null && status.ok === true;
			const dotKind = status === null ? "idle" : ok ? "ok" : "bad";
			const who = account.mobile !== undefined && account.mobile !== "" ? account.mobile : account.label;
			const tested = account.lastTestedAt > 0 ? `测得 ${formatRelative(account.lastTestedAt)}` : "还没测过";
			const detail = status === null ? "未检测" : ok ? "可用" : `不可用 · ${status.detail ?? "未知原因"}`;
			const quota = account.quota ?? null;
			const remaining = typeof quota?.remainingAmount === "number"
				? String(quota.remainingAmount)
				: typeof quota?.remainingPercent === "number"
					? `${quota.remainingPercent}%`
					: "—";
			return el("div", { className: `dbp-arow${account.active === true ? " dbp-arow-active" : ""}` },
				el("div", { className: "dbp-arow-top" },
					el("input", {
						type: "checkbox",
						className: "dbp-check",
						checked: props.selected,
						onChange: (event) => setSelected(account.id, event.target.checked),
						title: "勾选后可批量检测"
					}),
					el("span", { className: `dbp-arow-dot dbp-arow-dot-${dotKind}`, title: detail }),
					el("span", { className: "dbp-arow-who", title: `${account.label}${account.nickname === undefined || account.nickname === "" ? "" : ` · ${account.nickname}`}` }, who),
					el("span", { className: "dbp-arow-chip" }, `第${account.order}位`),
					account.active === true
						? el("span", { className: "dbp-arow-chip dbp-arow-chip-on" }, "当前使用")
						: null,
					el("span", { className: "dbp-arow-spacer" }),
					el("span", { className: "dbp-arow-num" }, remaining)
				),
				el("div", { className: "dbp-arow-bottom" },
					el("span", { className: `dbp-arow-state${ok ? "" : " dbp-arow-state-bad"}` },
						ok ? "✓ 可用" : status === null ? "未检测" : "✕ 不可用"
					),
					el("span", { className: "dbp-arow-note" }, `${account.label} · ${tested}`),
					el("span", { className: "dbp-arow-spacer" }),
					el(Button, {
						mini: true,
						variant: account.active === true ? void 0 : "primary",
						disabled: account.active === true || props.busy,
						onClick: () => props.onSwitch(account.id)
					}, account.active === true ? "使用中" : "切换"),
					el(Button, { mini: true, disabled: props.busy, onClick: () => props.onTest(account.id) }, "测试"),
					el(Button, { mini: true, variant: "danger", disabled: props.busy, onClick: () => props.onDelete(account.id) }, "删除"),
					el("span", { className: "dbp-arow-move" },
						el("button", { type: "button", disabled: account.order <= 1, onClick: () => props.onMove(account.id, "up"), title: "上移" }, "▲"),
						el("button", { type: "button", disabled: account.order >= props.total, onClick: () => props.onMove(account.id, "down"), title: "下移" }, "▼")
					)
				)
			);
		}

		/* ------------------------------------------------------------ 卡片 */

		/**
		 * 「豆包模型」这一块：上游 catalog 的全部模型 + 勾选 + 一个明确的保存按钮。
		 *
		 * 为什么要在这里再放一份：豆包插件自己的卡片里勾完没有任何落盘反馈（它的
		 * settings 文件不存在时等于一个都没选，模型选择器里就一条豆包都没有）。
		 * 这里勾完点保存会打到上游的 `__save`，当场重配 adapter，刷新选择器即见。
		 */
		function DoubaoModelsCard() {
			const [payload, setPayload] = React.useState(null);
			const [models, setModels] = React.useState(null);
			const [dirty, setDirty] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [message, setMessage] = React.useState("");
			/** 默认收起：清单十几二十条，展开只保留一个限高滚动区。 */
			const [expanded, setExpanded] = React.useState(false);

			const load = React.useCallback(() => {
				fetchModels()
					.then((next) => {
						setPayload(next);
						setModels(next?.models ?? []);
						setDirty(false);
						setError("");
					})
					.catch((failure) => setError(failure?.message ?? String(failure)));
			}, []);

			React.useEffect(() => {
				load();
			}, [load]);

			const toggle = (id, checked) => {
				setModels((previous) => (previous ?? []).map((model) => (model.id === id ? { ...model, enabled: checked } : model)));
				setDirty(true);
				setMessage("");
			};

			const save = async () => {
				const ids = (models ?? []).filter((model) => model.enabled === true).map((model) => model.id);
				setBusy(true);
				setError("");
				try {
					const result = await postAction("save-models", { ids });
					setMessage(result?.message ?? "已保存");
					load();
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				} finally {
					setBusy(false);
				}
			};

			const enabledCount = (models ?? []).filter((model) => model.enabled === true).length;
			const warning = typeof payload?.warning === "string" ? payload.warning : "";
			const owned = payload?.providerOwned === true;
			const providerLabel = typeof payload?.providerName === "string" ? payload.providerName : "豆包工作（多账号）";
			const providerNote = payload === null
				? ""
				: owned === true
					? `模型目录由本插件自己的 provider ${payload?.provider ?? "doubao-pool"} 提供：装不装豆包插件、开不开，这里的豆包工作模型都照样在。`
					: `模型目录目前由「豆包」插件提供（provider ${payload?.provider ?? "doubao"}）。本插件负责账号池与切号；把豆包插件停用后，模型会自动改由本插件接管。`;
			const hint = payload !== null && owned === true
				? `勾选后点「保存并应用」，这些模型会立刻出现在输入框的模型选择器里（分组：${providerLabel}）。`
				: "勾选后点右边的「保存并应用」，这些模型就会出现在输入框的模型选择器里。不点保存不会生效。";

			const body = models === null
				? el("div", { className: "dbp-empty" }, "正在读取豆包工作模型清单…")
				: models.length === 0
					? el("div", { className: "dbp-empty" }, "没读到豆包工作模型目录。账号登录正常时这里应该有一串模型。")
					: el("div", { className: "dbp-models" },
						models.map((model) => el("label", {
							key: model.id,
							className: "dbp-model-row"
						},
							el("input", {
								type: "checkbox",
								checked: model.enabled === true,
								onChange: (event) => toggle(model.id, event.target.checked)
							}),
							el("span", { className: "dbp-model-name" }, model.name),
							model.rate?.text === void 0 ? null : el("span", { className: "dbp-model-rate" }, model.rate.text)
						))
					);

			// 清单十几二十条，全铺开会把设置页顶得老长；收起来只留标题行，展开后限高滚动。
			const collapsed = expanded === false;
			return el("div", { className: "dbp-card" },
				el("div", { className: "dbp-card-head" },
					el("button", {
						type: "button",
						className: "dbp-caret",
						"aria-expanded": expanded,
						title: expanded ? "收起模型清单" : "展开模型清单",
						onClick: () => setExpanded((value) => value === false)
					}, expanded ? "▾" : "▸"),
					el("span", { className: "dbp-label" }, "豆包工作 模型"),
					el("span", { className: "dbp-count" }, `已启用 ${enabledCount}/${(models ?? []).length}`),
					el("div", { className: "dbp-spacer" }),
					el(Button, { mini: true, onClick: () => setExpanded((value) => value === false) }, collapsed ? "展开" : "收起"),
					el(Button, { mini: true, disabled: busy, onClick: load }, "刷新清单")
				),
				collapsed
					? null
					: el(React.Fragment, null,
						el("div", { className: "dbp-hint" }, providerNote),
						el("div", { className: "dbp-hint" }, hint)
					),
				el(Alert, { kind: "error", text: error }),
				el(Alert, { kind: "info", text: message }),
				collapsed ? null : body,
				collapsed
					? null
					: el("div", { className: "dbp-savebar" },
						el(Button, {
							variant: "primary",
							disabled: busy || dirty === false,
							onClick: save
						}, busy ? "保存中…" : dirty === false ? "已保存" : "保存并应用"),
						el("span", { className: "dbp-hint" }, dirty === false
							? `当前已启用 ${enabledCount} 个模型`
							: `有未保存的修改（${enabledCount} 个已勾选）`),
						warning === "" ? null : el("span", { className: "dbp-hint dbp-bad" }, `catalog 退回内置清单：${warning}`)
					)
			);
		}

		function DoubaoPoolCard() {
			const [view, setView] = React.useState(null);
			const [error, setError] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [busy, setBusy] = React.useState("");
			const [selected, setSelected] = React.useState(() => new Set());

			React.useEffect(() => {
				ensureStyles();
				let alive = true;
				const load = () => {
					fetchState()
						.then((next) => {
							if (!alive) return;
							setView(next);
							setError("");
						})
						.catch((failure) => {
							if (alive) setError(failure?.message ?? String(failure));
						});
				};
				load();
				const timer = setInterval(load, REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);

			const run = React.useCallback(async (action, payload) => {
				setBusy(action);
				setError("");
				try {
					const result = await postAction(action, payload);
					if (result?.view !== void 0) setView(result.view);
					setNotice(result?.message ?? "");
					if (result?.download !== void 0) saveDownload(result.download);
					broadcastChange();
					return result;
				} catch (failure) {
					setError(failure?.message ?? String(failure));
					setNotice("");
					return null;
				} finally {
					setBusy("");
				}
			}, []);

			const addAccount = React.useCallback(async () => {
				setBusy("add");
				setError("");
				setNotice("正在拉起浏览器，请在打开的窗口里扫码登录豆包…");
				try {
					await upstreamLogin();
					setNotice("登录成功，正在收进账号池…");
					const result = await postAction("import-current", {});
					if (result?.view !== void 0) setView(result.view);
					setNotice(result?.message ?? "已收进账号池");
					broadcastChange();
				} catch (failure) {
					setError(failure?.message ?? String(failure));
					setNotice("");
				} finally {
					setBusy("");
				}
			}, []);

			const importFile = React.useCallback(async (file) => {
				if (file === null || file === void 0) return;
				try {
					const text = await file.text();
					await run("import", { data: text });
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				}
			}, [run]);

			const accounts = view?.accounts ?? [];
			const selectedIds = accounts.filter((account) => selected.has(account.id)).map((account) => account.id);
			const toggleSelected = (id, checked) => {
				setSelected((previous) => {
					const next = new Set(previous);
					if (checked) next.add(id);
					else next.delete(id);
					return next;
				});
			};
			const fileInputRef = React.useRef(null);

			const header = el("div", { className: "dbp-head" },
				el("div", { className: "dbp-title" }, "账号池"),
				el("div", { className: "dbp-sub" }, "把多个豆包工作账号收在这里，随时切换当前使用的那一个。切换只影响后续请求，正在进行的对话仍属于原账号。")
			);

			const switchRow = el("div", { className: "dbp-card" },
				el("div", { className: "dbp-row" },
					el("div", { className: "dbp-row-main" },
						el("span", { className: "dbp-label" }, "启用账号池"),
						view?.autoSwitch === true ? el("span", { className: "dbp-badge dbp-badge-soft" }, "自动挑号") : null
					),
					el(Switch, {
						checked: view?.enabled === true,
						disabled: view === null || busy !== "",
						onChange: (next) => run("toggle", { enabled: next })
					})
				),
				el("div", { className: "dbp-hint" }, "启用后，账号池会在当前账号失效时按顺序换到下一个可用账号；关掉它，就只用你手动选定的那个账号。"),
				el("div", { className: "dbp-row" },
					el("div", { className: "dbp-row-main" },
						el("span", { className: "dbp-label" }, "失败自动换号"),
						el("span", { className: "dbp-hint" }, "遇到 401/429/5xx 时换号，其它错误不动")
					),
					el(Switch, {
						checked: view?.autoSwitch === true,
						disabled: view === null || busy !== "",
						onChange: (next) => run("toggle", { autoSwitch: next })
					})
				),
				el("div", { className: "dbp-row" },
					el("div", { className: "dbp-row-main" },
						el("span", { className: "dbp-label" }, "输入框工具栏显示额度读数"),
						el("span", { className: "dbp-hint" }, "在模型选择器左边显示当前账号额度，点开可看全部账号并切换")
					),
					el(Switch, {
						checked: view?.ui?.showComposer !== false,
						disabled: view === null || busy !== "",
						onChange: (next) => run("toggle", { showComposer: next })
					})
				)
			);

			const toolbar = el("div", { className: "dbp-card-head" },
				el("span", { className: "dbp-label" }, "本池包含的账号"),
				el("span", { className: "dbp-count" }, `已选 ${selectedIds.length}/${accounts.length}`),
				el("div", { className: "dbp-spacer" }),
				el(Button, {
					mini: true,
					disabled: accounts.length === 0,
					onClick: () => setSelected(new Set(accounts.map((account) => account.id)))
				}, "全选"),
				el(Button, {
					mini: true,
					disabled: selectedIds.length === 0,
					onClick: () => setSelected(new Set())
				}, "全不选"),
				el(Button, {
					mini: true,
					disabled: selectedIds.length === 0 || busy !== "",
					onClick: () => run("test", { ids: selectedIds })
				}, "测试勾选的账号"),
				el(Button, {
					mini: true,
					disabled: accounts.length < 2 || busy !== "",
					onClick: () => run("auto-order", {})
				}, "自动排序"),
				el(Button, {
					mini: true,
					disabled: accounts.length < 2 || busy !== "",
					onClick: () => run("shuffle", {})
				}, "一键随机"),
				el(Button, {
					mini: true,
					disabled: accounts.length === 0 || busy !== "",
					onClick: () => run("test-all", {})
				}, "重新检测全部"),
				el(Button, {
					mini: true,
					disabled: accounts.length < 2 || busy !== "",
					title: "把同一个号被收成多份的记录并成一条",
					onClick: () => run("dedupe", {})
				}, "合并重复账号")
			);

			const table = accounts.length === 0
				? el("div", { className: "dbp-empty" }, "池子里还没有账号。点下面「扫码添加账号」，用豆包 App 扫码登录一次就会收进来。")
				: el("div", { className: "dbp-table" },
					accounts.map((account) => el(AccountRow, {
						key: account.id,
						account,
						total: accounts.length,
						selected: selected.has(account.id),
						setSelected: toggleSelected,
						busy: busy !== "",
						onMove: (id, direction) => run("reorder", { id, direction }),
						onSwitch: (id) => run("switch", { id }),
						onTest: (id) => run("test", { id }),
						onDelete: (id) => run("delete", { id })
					}))
				);

			const footer = el("div", { className: "dbp-footer" },
				el(Button, { variant: "primary", disabled: busy !== "", onClick: addAccount }, busy === "add" ? "等待扫码…" : "扫码添加账号"),
				el(Button, { disabled: accounts.length === 0 || busy !== "", onClick: () => run("export", {}) }, "导出账号"),
				el(Button, { disabled: busy !== "", onClick: () => fileInputRef.current?.click() }, "导入账号"),
				el("input", {
					ref: fileInputRef,
					type: "file",
					accept: "application/json,.json",
					style: { display: "none" },
					onChange: (event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						importFile(file);
					}
				})
			);

			const note = el("div", { className: "dbp-note" },
				"账号 cookie 用 Windows DPAPI 加密后只存在本机（",
				el("code", null, "~/.dsh/doubao-pool/"),
				"），导出文件离开这台机器就解不开。对话与模型由本插件自带的 provider（",
				el("code", null, "doubao-pool"),
				"）直接对接豆包工作，不依赖豆包插件。"
			);

			return el("div", { className: "dbp-root" },
				header,
				el(Alert, { kind: "error", text: error }),
				el(Alert, { kind: "info", text: notice }),
				switchRow,
				el(DoubaoModelsCard),
				el("div", { className: "dbp-card" }, toolbar, table, footer),
				note
			);
		}

		/** 设置左侧导航那一格图标：蓝底圆角方块 + 豆。 */
		function DoubaoPoolIcon(props) {
			const size = typeof props?.size === "number" ? props.size : 18;
			return el("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				xmlns: "http://www.w3.org/2000/svg",
				style: { display: "block", opacity: props?.active === false ? 0.75 : 1 },
				"aria-hidden": "true"
			},
				el("rect", { x: 0, y: 0, width: 24, height: 24, rx: 6, fill: "#2f6bff" }),
				el("path", {
					d: "M7 8.4h10M12 6.2v3.1M8.2 11.4h7.6v2.4a3.8 3.8 0 0 1-3.8 3.8 3.8 3.8 0 0 1-3.8-3.8v-2.4Z",
					fill: "none",
					stroke: "#fff",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			);
		}

		const name = "dsh-connect-doubao-pool";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ensureStyles();
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "doubao-pool locale");
			} catch {}
			const t = (() => {
				try {
					return ctx.locale.bind(NAMESPACE);
				} catch {
					return (key) => (key === "nav.label" ? "豆包多账号" : key);
				}
			})();

			// 设置页里的一整页。order 41：排在豆包插件（40）后面，两个插件挨着。
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register({
					name: "settings.section",
					id: SECTION_ID,
					order: 41,
					label: () => t("nav.label")
				}, DoubaoPoolCard)
			);

			// 同一 id 的图标：宿主在左侧导航里就是按 id 配对 `settings.section.icon` 的。
			ctx.slots.inject("settings.section.icon", () =>
				ctx.slots.register({
					name: "settings.section.icon",
					id: SECTION_ID,
					locale: NAMESPACE
				}, DoubaoPoolIcon)
			);

			// 输入框工具栏上的额度读数：位置与形态对齐 WorkBuddy 的 composer 读数。
			// 用 input.right（模型选择器紧左边），不用 input.left——后者贴着「完全权限」，两个都可点会互相误触。
			try {
				ctx.slots.inject("conversation.input.right", () =>
					ctx.slots.register({
						name: "conversation.input.right",
						id: `${SECTION_ID}-composer`,
						order: 4,
						// 面板右上角那个「设置」要能真的把人送到「豆包多账号」这一页。
						inject: () => ({
							onOpenSettings: () => {
								const softGet = (name) => {
									try {
										return ctx.get?.(name);
									} catch {
										return undefined;
									}
								};
								try {
									const opened = openSettingsSection({
										get: softGet,
										label: () => t("nav.label"),
										onGiveUp: () => {
											const navigation = softGet("pluginNavigation");
											if (navigation !== undefined && typeof navigation.openBundle === "function") {
												try {
													navigation.openBundle("dsh-connect-doubao-pool");
												} catch {}
											}
										}
									});
									if (opened) return;
								} catch {}
								try {
									ctx.get?.("layout")?.selectPanel?.("settings");
								} catch {}
							}
						})
					}, ComposerQuota)
				);
			} catch (error) {
				console.error("[dsh-connect-doubao-pool] composer 读数注册失败（设置页不受影响）:", error);
			}

			// 插件页（设置 → 插件 → 豆包多账号）里也来一份，key 用包名。
			// 图1 那种「插件标题 + 齿轮行」的结构就是这两个 keyed slot 撑起来的。
			try {
				ctx.slots.inject("plugins.bundle.config", () =>
					ctx.slots.register({
						name: "plugins.bundle.config",
						key: "dsh-connect-doubao-pool",
						priority: 30
					}, DoubaoPoolCard)
				);
			} catch (error) {
				console.error("[dsh-connect-doubao-pool] plugins.bundle.config 注册失败（其它入口不受影响）:", error);
			}
		}

		module.exports = {
			name,
			inject,
			apply,
			DoubaoPoolCard,
			DoubaoPoolIcon,
			ComposerQuota
		};
		return module.exports;
	}
});
