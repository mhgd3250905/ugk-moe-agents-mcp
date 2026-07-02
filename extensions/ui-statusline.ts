/**
 * Status Line Extension(本地化版)
 *
 * 来源:examples/extensions/status-line.ts,改动:中文状态文案。
 * 底部状态条显示回合进度:
 *   进行中: ● 第 3 轮...
 *   完成:   ✓ 第 3 轮完成
 *
 * 用 ctx.ui.setStatus(),与 footer 共存(setStatus 是 footer 内的一个槽位)。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnCount = 0;

	pi.on("session_start", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("turn-progress", theme.fg("success", "✅") + theme.fg("dim", " 就绪"));
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		const theme = ctx.ui.theme;
		const spinner = theme.fg("accent", "●");
		const text = theme.fg("dim", ` 第 ${turnCount} 轮...`);
		ctx.ui.setStatus("turn-progress", spinner + text);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		const check = theme.fg("success", "✓");
		const text = theme.fg("dim", ` 第 ${turnCount} 轮完成`);
		ctx.ui.setStatus("turn-progress", check + text);
	});
}
