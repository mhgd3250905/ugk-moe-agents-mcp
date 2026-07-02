import {
	createBashTool,
	createEditTool,
	type BashToolDetails,
	type EditToolDetails,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readSettingsJson } from "./shared/settings-io.ts";
import { uiText } from "./shared/ui-language.ts";

/**
 * 从 settings.json 读取 shellPath(BOM-safe)。
 *
 * 为什么需要这步:覆盖式重注册 bash 时,pi 不会自动注入 shellPath(原生注册
 * 走 agent-session 内部的 settingsManager,扩展层拿不到)。如果直接
 * createBashTool(cwd) 不传 shellPath,Windows 上会 fallback 到系统 bash(WSL),
 * 导致 bash 工具走 WSL 而非配置的 Git Bash。这里自己读 settings 拿 shellPath。
 */
function resolveShellPath(): string | undefined {
	const settings = readSettingsJson();
	const shellPath = settings?.shellPath;
	return typeof shellPath === "string" && shellPath.trim() ? shellPath : undefined;
}

/**
 * 从 settings.json 读取 shellCommandPrefix(BOM-safe)。
 *
 * pi 原生注册 bash 时会注入 commandPrefix(来自 settingsManager.getShellCommandPrefix,
 * 如 "shopt -s expand_aliases")。覆盖式重注册同样拿不到这个隐式注入,需要自己补回,
 * 否则用户配置的命令前缀在扩展 bash 下不生效,与原生 bash 行为不一致。
 */
function resolveShellCommandPrefix(): string | undefined {
	const settings = readSettingsJson();
	const commandPrefix = settings?.shellCommandPrefix;
	return typeof commandPrefix === "string" && commandPrefix.trim() ? commandPrefix : undefined;
}

export default function registerBuiltinToolRenderers(pi: ExtensionAPI): void {
	const bashTool = createBashTool(process.cwd());
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: bashTool.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const shellPath = resolveShellPath();
			const commandPrefix = resolveShellCommandPrefix();
			// 必须显式传 shellPath(否则 Windows fallback 到 WSL)和 commandPrefix
			// (否则用户配置的命令前缀不生效),补回 pi 原生的隐式注入。
			const options: { shellPath?: string; commandPrefix?: string } = {};
			if (shellPath) options.shellPath = shellPath;
			if (commandPrefix) options.commandPrefix = commandPrefix;
			return createBashTool(cwd, options).execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const command = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", command);
			if (args.timeout) text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", uiText("运行中...", "running...")), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const exitMatch = output.match(/exited with code (\d+)/);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : result.isError ? 1 : null;
			const outputLines = output.split("\n");
			const lineCount = outputLines.filter((line) => line.trim()).length;

			let text = exitCode === null
				? theme.fg("success", uiText("完成", "done"))
				: theme.fg("error", `exit ${exitCode}`);
			text += theme.fg("dim", ` (${lineCount} ${uiText("行", "lines")})`);
			if (details?.truncation?.truncated) text += theme.fg("warning", ` [${uiText("已截断", "truncated")}]`);

			if (expanded) {
				for (const line of outputLines.slice(0, 20)) text += `\n${theme.fg("dim", line)}`;
				if (outputLines.length > 20) text += `\n${theme.fg("muted", uiText("... 更多输出", "... more output"))}`;
			}

			return new Text(text, 0, 0);
		},
	});

	const editTool = createEditTool(process.cwd());
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createEditTool(ctx?.cwd ?? process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", uiText("编辑中...", "editing...")), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}
			if (!details?.diff) return new Text(theme.fg("success", uiText("已应用", "applied")), 0, 0);

			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) text += `\n${theme.fg("success", line)}`;
					else if (line.startsWith("-") && !line.startsWith("---")) text += `\n${theme.fg("error", line)}`;
					else text += `\n${theme.fg("dim", line)}`;
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", uiText(`... 还有 ${diffLines.length - 30} 行 diff`, `... ${diffLines.length - 30} more diff lines`))}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
