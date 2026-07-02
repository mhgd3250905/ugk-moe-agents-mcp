import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyUgkUpdate,
	detectUgkUpdate,
	formatUgkUpdateNotice,
	readUgkUpdateState,
	shouldCheckForUgkUpdate,
	shouldPromptForUgkUpdate,
	writeUgkUpdateState,
} from "../bin/update-core.js";

export {
	applyGlobalNpmUpdate,
	applyLocalGitUpdate,
	applyUgkUpdate,
	detectUgkUpdate,
	formatUgkUpdateNotice,
	getGithubMainRef,
	getGlobalPackageInstallCommand,
	getLocalGitRef,
	getPackageInstallCommand,
	getUgkUpdateCommandLabel,
	isGitAncestor,
	isGitCheckout,
	readPackageVersion,
	readUgkUpdateState,
	shouldCheckForUgkUpdate,
	shouldPromptForUgkUpdate,
	shortRef,
	writeUgkUpdateState,
} from "../bin/update-core.js";

export interface UgkUpdateState {
	lastCheckedAt?: string;
	skippedRef?: string;
	skippedAt?: string;
}

export interface UgkUpdateInfo {
	currentRef: string;
	latestRef: string;
	currentVersion: string;
	source: "github-main";
}

export interface UgkUpdateDeps {
	now?: () => Date;
	packageRoot?: string;
	agentDir?: string;
	getCurrentRef?: () => Promise<string | undefined>;
	getLatestRef?: () => Promise<string | undefined>;
	isLatestAncestorOfCurrent?: (currentRef: string, latestRef: string) => Promise<boolean>;
	getCurrentVersion?: () => string;
	readState?: () => UgkUpdateState;
	writeState?: (state: UgkUpdateState) => void;
	applyUpdate?: () => Promise<string>;
}

export interface UgkCommandSpec {
	command: string;
	args: string[];
}

const UPDATE_NOW = "现在更新";
const SKIP_ONCE = "跳过本次";
const SKIP_UNTIL_NEXT = "跳过到下个版本";

async function promptAndMaybeUpdate(
	ctx: any,
	info: UgkUpdateInfo,
	deps: UgkUpdateDeps,
	state: UgkUpdateState,
): Promise<void> {
	if (!ctx.hasUI || !ctx.ui?.select) {
		ctx.ui?.notify?.(formatUgkUpdateNotice(info), "info");
		return;
	}

	const choice = await ctx.ui.select(formatUgkUpdateNotice(info), [UPDATE_NOW, SKIP_ONCE, SKIP_UNTIL_NEXT]);
	if (choice === SKIP_ONCE) {
		ctx.ui.notify("已跳过本次 UGK 更新提示。", "info");
		return;
	}
	if (choice === SKIP_UNTIL_NEXT) {
		(deps.writeState || ((next) => writeUgkUpdateState(next, deps.agentDir)))({
			...state,
			skippedRef: info.latestRef,
			skippedAt: (deps.now || (() => new Date()))().toISOString(),
		});
		ctx.ui.notify("已跳过该版本 UGK 更新提示。", "info");
		return;
	}
	if (choice !== UPDATE_NOW) return;

	try {
		ctx.ui.notify("正在更新 UGK...", "info");
		const result = await (deps.applyUpdate || (() => applyUgkUpdate(deps.packageRoot)))();
		ctx.ui.notify(result, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : "UGK 更新失败。", "warning");
	}
}

async function checkAndPrompt(ctx: any, deps: UgkUpdateDeps = {}, force = false): Promise<void> {
	const now = (deps.now || (() => new Date()))();
	const readState = deps.readState || (() => readUgkUpdateState(deps.agentDir));
	const writeState = deps.writeState || ((state) => writeUgkUpdateState(state, deps.agentDir));
	const state = readState();

	if (!shouldCheckForUgkUpdate(state, now, force)) return;

	const info = await detectUgkUpdate(deps);
	const checkedState = { ...state, lastCheckedAt: now.toISOString() };
	writeState(checkedState);
	if (!info) {
		if (force) ctx.ui.notify("UGK 已是最新版本。", "info");
		return;
	}
	if (!force && !shouldPromptForUgkUpdate(state, info, now)) return;

	await promptAndMaybeUpdate(ctx, info, deps, checkedState);
}

export function registerUgkUpdate(pi: ExtensionAPI, deps: UgkUpdateDeps = {}): void {
	pi.registerCommand("update", {
		description: "检查并更新 UGK",
		handler: async (_args, ctx) => {
			await checkAndPrompt(ctx, deps, true);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		void checkAndPrompt(ctx, deps, false).catch(() => undefined);
	});
}

