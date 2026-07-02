import { createInterface } from "node:readline/promises";
import {
	applyUgkUpdate,
	detectUgkUpdate,
	getUgkUpdateCommandLabel,
	GITHUB_REPO_SLUG,
	readUgkUpdateState,
	shouldCheckForUgkUpdate,
	shouldPromptForUgkUpdate,
	shortRef,
	writeUgkUpdateState,
} from "./update-core.js";

const HELP_ARGS = new Set(["-h", "--help", "-v", "--version"]);
const CLI_UPDATE_CHOICES = ["update", "skip", "skip-until-next"];

export function shouldRunCliUpdatePreflight({
	argv = process.argv.slice(2),
	env = process.env,
	stdin = process.stdin,
	stdout = process.stdout,
} = {}) {
	if (env.UGK_SKIP_UPDATE_CHECK === "1") return false;
	if (!stdin?.isTTY || !stdout?.isTTY) return false;
	if (argv.some((arg) => HELP_ARGS.has(arg))) return false;
	if (argv.includes("--print")) return false;
	return true;
}

export function advanceCliUpdatePromptSelection(state, key) {
	const selected = state.selected ?? 0;
	if (key === "\u001b[A") {
		return { selected: selected === 0 ? CLI_UPDATE_CHOICES.length - 1 : selected - 1 };
	}
	if (key === "\u001b[B") {
		return { selected: selected === CLI_UPDATE_CHOICES.length - 1 ? 0 : selected + 1 };
	}
	if (key === "\r" || key === "\n") return { selected, done: true, choice: CLI_UPDATE_CHOICES[selected] };
	if (key === "\u0003" || key === "\u001b") return { selected, done: true, choice: "skip" };
	if (key === "1" || key.toLowerCase() === "y") return { selected: 0, done: true, choice: "update" };
	if (key === "2" || key.toLowerCase() === "n") return { selected: 1, done: true, choice: "skip" };
	if (key === "3") return { selected: 2, done: true, choice: "skip-until-next" };
	return { selected };
}

export function buildCliUpdatePromptRerenderSequence(linesRendered) {
	if (linesRendered <= 0) return "";
	const previousRowsAboveCursor = Math.max(0, linesRendered - 1);
	return previousRowsAboveCursor === 0 ? "\r\u001b[J" : `\r\u001b[${previousRowsAboveCursor}A\u001b[J`;
}

export function formatCliUpdatePrompt(info, commandLabel, selected = 0) {
	return [
		`✨ 发现可用更新! ${info.currentVersion} (${shortRef(info.currentRef)}) -> ${shortRef(info.latestRef)}`,
		"",
		`发布记录: https://github.com/${GITHUB_REPO_SLUG}/commits/main`,
		"",
		`${selected === 0 ? "›" : " "} 1. 立即更新(运行 \`${commandLabel}\`)`,
		`${selected === 1 ? "›" : " "} 2. 跳过本次`,
		`${selected === 2 ? "›" : " "} 3. 跳过直到下个版本`,
		"",
		"  使用 ↑/↓ 选择,Enter 确认,Esc 取消。",
	].join("\n");
}

async function promptCliUpdateChoiceLine(input, output, info, commandLabel) {
	output.write(`${formatCliUpdatePrompt(info, commandLabel)}\n`);
	const rl = createInterface({ input, output });
	try {
		const answer = (await rl.question("")).trim().toLowerCase();
		if (!answer || answer === "1" || answer === "y" || answer === "yes") return "update";
		if (answer === "2" || answer === "s" || answer === "skip" || answer === "n" || answer === "no") {
			return "skip";
		}
		if (answer === "3") return "skip-until-next";
		return "skip";
	} finally {
		rl.close();
	}
}

async function promptCliUpdateChoiceTui(input, output, info, commandLabel) {
	let state = { selected: 0 };
	let linesRendered = 0;
	const render = () => {
		output.write(buildCliUpdatePromptRerenderSequence(linesRendered));
		const text = formatCliUpdatePrompt(info, commandLabel, state.selected);
		linesRendered = text.split("\n").length;
		output.write(text);
	};

	input.setRawMode(true);
	input.resume();
	render();

	return await new Promise((resolve) => {
		const onData = (chunk) => {
			state = advanceCliUpdatePromptSelection(state, chunk.toString("utf8"));
			render();
			if (!state.done) return;
			input.off("data", onData);
			input.setRawMode(false);
			output.write("\n");
			resolve(state.choice || "skip");
		};
		input.on("data", onData);
	});
}

export async function promptCliUpdateChoice(input = process.stdin, output = process.stdout, info, commandLabel) {
	if (input.isTTY && output.isTTY && typeof input.setRawMode === "function" && info && commandLabel) {
		return promptCliUpdateChoiceTui(input, output, info, commandLabel);
	}
	return promptCliUpdateChoiceLine(input, output, info, commandLabel);
}

export async function runUgkUpdatePreflight(options = {}) {
	const stdin = options.stdin || process.stdin;
	const stdout = options.stdout || process.stdout;
	const stderr = options.stderr || process.stderr;
	if (!options.force && !shouldRunCliUpdatePreflight({ argv: options.argv, env: options.env, stdin, stdout })) {
		return { action: "continue" };
	}

	const now = (options.now || (() => new Date()))();
	const readState = options.readState || (() => readUgkUpdateState(options.agentDir));
	const writeState = options.writeState || ((state) => writeUgkUpdateState(state, options.agentDir));
	const state = readState();

	if (!shouldCheckForUgkUpdate(state, now, options.force)) return { action: "continue" };

	const info = await (options.detectUpdate || (() => detectUgkUpdate(options)))();
	const checkedState = { ...state, lastCheckedAt: now.toISOString() };
	writeState(checkedState);
	if (!info || !shouldPromptForUgkUpdate(state, info, now)) return { action: "continue" };

	const commandLabel = (options.updateCommandLabel || (() => getUgkUpdateCommandLabel(options.packageRoot)))();

	let choice;
	if (options.selectUpdateChoice) {
		stdout.write(`${formatCliUpdatePrompt(info, commandLabel)}\n`);
		choice = await options.selectUpdateChoice();
	} else {
		choice = await promptCliUpdateChoice(stdin, stdout, info, commandLabel);
	}
	if (choice === "skip") {
		stdout.write("\n已跳过本次 UGK 更新。\n");
		return { action: "continue" };
	}
	if (choice === "skip-until-next") {
		writeState({
			...checkedState,
			skippedRef: info.latestRef,
			skippedAt: now.toISOString(),
		});
		stdout.write("\n已跳过此版本更新,下个版本再提示。\n");
		return { action: "continue" };
	}

	try {
		stdout.write(`\n正在通过 \`${commandLabel}\` 更新 UGK...\n`);
		const applyUpdate = options.applyUpdate || (() => applyUgkUpdate(options.packageRoot, { stdio: "inherit" }));
		await applyUpdate();
		stdout.write("\n🎉 更新命令已成功运行,请重启 UGK。\n");
		return { action: "exit", exitCode: 0 };
	} catch (error) {
		const message = error instanceof Error ? error.message : "UGK 更新失败。";
		stderr.write(`\nUGK 更新失败: ${message}\n继续使用当前版本。\n`);
		return { action: "continue" };
	}
}
