import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uiText } from "../shared/ui-language.ts";

export function registerDoctor(pi: ExtensionAPI): void {
	pi.registerCommand("doctor", {
		description: "Open guided UGK environment troubleshooting help",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatDoctorMigrationNotice(), "info");
		},
	});
}

function formatDoctorMigrationNotice(): string {
	return uiText(
		[
			"UGK Environment Doctor",
			"",
			"/doctor 已改为引导式环境配置 skill。请直接 ask the agent：",
			"",
			'  "帮我检查环境"',
			'  "bash unavailable / bash 不可用"',
			'  "Chrome CDP 连不上"',
			'  "MCP 配置失败"',
			'  "Node/npm 找不到"',
			'  "怎么切 API / model"',
			"",
			"我会一次只处理一个失败模块，并引导你修复后验证。",
		].join("\n"),
		[
			"UGK Environment Doctor",
			"",
			"/doctor is now guided environment help. Please ask the agent:",
			"",
			'  "check my environment"',
			'  "bash unavailable"',
			'  "Chrome CDP is not connected"',
			'  "MCP configuration failed"',
			'  "Node/npm is missing"',
			'  "how do I switch API / model"',
			"",
			"I will handle one failing module at a time and verify it after the fix.",
		].join("\n"),
	);
}

export default registerDoctor;
