/**
 * Stage 0 闸门：宿主平台包能不能在本插件的模块上下文里解析。
 *
 * 为什么要单独探：我们自己写 adapter 需要
 *   `@deepseek-ai/dsh-llm-pi-ai`（PiAiAdapter）
 *   `@deepseek-ai/dsh-llm`（resolveRetryPolicy / createUserMessage …）
 *   `@earendil-works/pi-ai`（createProvider / openAiCompletions api）
 * 这几个包只装在 DSH 安装目录里，不在 profile 的 node_modules，也不在我们的
 * 项目目录。上游插件照样 import 它们且能跑，说明宿主自己有一套解析；这里用动态
 * import 把「我们这边也一样能解析」这件事钉成事实，解析不了就当场退道，而不是
 * 写完两千行再发现加载失败。
 */

const TARGETS = [
	"@deepseek-ai/dsh-llm-pi-ai",
	"@deepseek-ai/dsh-llm",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/api/openai-completions.lazy",
	"@deepseek-ai/schemastery"
];

let cached = null;

export async function probeHostSdk() {
	if (cached !== null) return cached;
	const report = { ok: true, modules: {} };
	for (const specifier of TARGETS) {
		try {
			const namespace = await import(specifier);
			report.modules[specifier] = {
				ok: true,
				exports: Object.keys(namespace ?? {}).slice(0, 24)
			};
		} catch (error) {
			report.ok = false;
			report.modules[specifier] = { ok: false, error: String(error?.message ?? error).slice(0, 200) };
		}
	}
	// 关键成员是否真的在：只是「能 import」不够。
	try {
		const { PiAiAdapter } = await import("@deepseek-ai/dsh-llm-pi-ai");
		report.piAiAdapter = typeof PiAiAdapter === "function";
	} catch {
		report.piAiAdapter = false;
	}
	try {
		const { createProvider } = await import("@earendil-works/pi-ai");
		report.createProvider = typeof createProvider === "function";
	} catch {
		report.createProvider = false;
	}
	cached = report;
	return report;
}
