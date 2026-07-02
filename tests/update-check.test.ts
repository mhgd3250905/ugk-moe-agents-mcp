import test from "node:test";
import assert from "node:assert/strict";
import {
	detectUgkUpdate,
	formatUgkUpdateNotice,
	getPackageInstallCommand,
	getGlobalPackageInstallCommand,
	getUgkUpdateCommandLabel,
	registerUgkUpdate,
	shouldCheckForUgkUpdate,
	shouldPromptForUgkUpdate,
	type UgkUpdateState,
} from "../extensions/update-check.ts";

const CURRENT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LATEST = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("detectUgkUpdate reports a GitHub main update when refs differ", async () => {
	const update = await detectUgkUpdate({
		getCurrentRef: async () => CURRENT,
		getLatestRef: async () => LATEST,
		getCurrentVersion: () => "1.0.0",
	});

	assert.deepEqual(update, {
		currentRef: CURRENT,
		latestRef: LATEST,
		currentVersion: "1.0.0",
		source: "github-main",
	});
});

test("detectUgkUpdate returns undefined when refs match or cannot be read", async () => {
	assert.equal(
		await detectUgkUpdate({
			getCurrentRef: async () => CURRENT,
			getLatestRef: async () => CURRENT,
			getCurrentVersion: () => "1.0.0",
		}),
		undefined,
	);

	assert.equal(
		await detectUgkUpdate({
			getCurrentRef: async () => undefined,
			getLatestRef: async () => LATEST,
			getCurrentVersion: () => "1.0.0",
		}),
		undefined,
	);
});

test("detectUgkUpdate does not report an update when local ref already contains latest main", async () => {
	assert.equal(
		await detectUgkUpdate({
			getCurrentRef: async () => CURRENT,
			getLatestRef: async () => LATEST,
			getCurrentVersion: () => "1.0.0",
			isLatestAncestorOfCurrent: async (currentRef, latestRef) => {
				assert.equal(currentRef, CURRENT);
				assert.equal(latestRef, LATEST);
				return true;
			},
		}),
		undefined,
	);
});

test("shouldCheckForUgkUpdate always allows startup checks unless force rules apply elsewhere", () => {
	const now = new Date("2026-06-17T00:00:00.000Z");

	assert.equal(shouldCheckForUgkUpdate({}, now), true);
	assert.equal(shouldCheckForUgkUpdate({ lastCheckedAt: "2026-06-16T23:00:00.000Z" }, now), true);
	assert.equal(shouldCheckForUgkUpdate({ lastCheckedAt: "2026-06-15T23:00:00.000Z" }, now), true);
	assert.equal(shouldCheckForUgkUpdate({ lastCheckedAt: "2026-06-16T23:00:00.000Z" }, now, true), true);
});

test("shouldPromptForUgkUpdate suppresses a skipped ref until latest ref changes", () => {
	const now = new Date("2026-06-17T00:00:00.000Z");
	const info = { currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" as const };

	assert.equal(shouldPromptForUgkUpdate({}, info, now), true);
	assert.equal(
		shouldPromptForUgkUpdate({ skippedRef: LATEST, skippedAt: "2026-06-16T23:00:00.000Z" }, info, now),
		false,
	);
	assert.equal(
		shouldPromptForUgkUpdate({ skippedRef: LATEST, skippedAt: "2026-06-15T23:00:00.000Z" }, info, now),
		false,
	);
	assert.equal(shouldPromptForUgkUpdate({ skippedRef: CURRENT, skippedAt: now.toISOString() }, info, now), true);
});

test("formatUgkUpdateNotice presents UGK-only wording", () => {
	const notice = formatUgkUpdateNotice({
		currentRef: CURRENT,
		latestRef: LATEST,
		currentVersion: "1.0.0",
		source: "github-main",
	});

	assert.match(notice, /UGK 有新版本可用/);
	assert.match(notice, /当前版本: 1\.0\.0 \(aaaaaaa\)/);
	assert.match(notice, /最新版本: bbbbbbb/);
	assert.doesNotMatch(notice, /pi/i);
	assert.doesNotMatch(notice, /github/i);
	assert.doesNotMatch(notice, /npm/i);
});

test("getPackageInstallCommand runs npm through cmd.exe on Windows", () => {
	assert.deepEqual(getPackageInstallCommand("win32"), {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", "npm", "install"],
	});
	assert.deepEqual(getPackageInstallCommand("linux"), {
		command: "npm",
		args: ["install"],
	});
	assert.deepEqual(getPackageInstallCommand("darwin"), {
		command: "npm",
		args: ["install"],
	});
});

test("getGlobalPackageInstallCommand installs ugk-agent globally", () => {
	assert.deepEqual(getGlobalPackageInstallCommand("win32"), {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", "npm", "install", "-g", "ugk-agent"],
	});
	assert.deepEqual(getGlobalPackageInstallCommand("linux"), {
		command: "npm",
		args: ["install", "-g", "ugk-agent"],
	});
});

test("getUgkUpdateCommandLabel describes git and npm install modes", () => {
	assert.equal(getUgkUpdateCommandLabel("C:\\repo", true), "git pull --rebase origin main && npm install");
	assert.equal(getUgkUpdateCommandLabel("C:\\repo", false), "npm install -g ugk-agent");
});

test("/update prompts and applies update when user selects now", async () => {
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		on() {},
	};
	const notifications: string[] = [];
	let applied = false;
	let state: UgkUpdateState = {};

	registerUgkUpdate(pi as any, {
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		getCurrentRef: async () => CURRENT,
		getLatestRef: async () => LATEST,
		getCurrentVersion: () => "1.0.0",
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		applyUpdate: async () => {
			applied = true;
			return "UGK 已更新完成。请重启 ugk 使用新版本。";
		},
	});

	await commands.get("update")!.handler("", {
		hasUI: true,
		ui: {
			select: async () => "现在更新",
			notify: (message: string) => notifications.push(message),
		},
	});

	assert.equal(applied, true);
	assert.match(notifications.join("\n"), /正在更新 UGK/);
	assert.match(notifications.join("\n"), /UGK 已更新完成/);
});

test("/update skip current run does not record skipped ref", async () => {
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		on() {},
	};
	let state: UgkUpdateState = {};

	registerUgkUpdate(pi as any, {
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		getCurrentRef: async () => CURRENT,
		getLatestRef: async () => LATEST,
		getCurrentVersion: () => "1.0.0",
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		applyUpdate: async () => {
			throw new Error("must not update");
		},
	});

	await commands.get("update")!.handler("", {
		hasUI: true,
		ui: {
			select: async () => "跳过本次",
			notify: () => {},
		},
	});

	assert.equal(state.skippedRef, undefined);
	assert.equal(state.skippedAt, undefined);
});

test("/update records skipped ref when user skips until next version", async () => {
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		on() {},
	};
	let state: UgkUpdateState = {};

	registerUgkUpdate(pi as any, {
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		getCurrentRef: async () => CURRENT,
		getLatestRef: async () => LATEST,
		getCurrentVersion: () => "1.0.0",
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		applyUpdate: async () => {
			throw new Error("must not update");
		},
	});

	await commands.get("update")!.handler("", {
		hasUI: true,
		ui: {
			select: async () => "跳过到下个版本",
			notify: () => {},
		},
	});

	assert.equal(state.skippedRef, LATEST);
	assert.equal(state.skippedAt, "2026-06-17T00:00:00.000Z");
});

test("/update cancel does not record skipped ref", async () => {
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		on() {},
	};
	let state: UgkUpdateState = {};
	let applied = false;

	registerUgkUpdate(pi as any, {
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		getCurrentRef: async () => CURRENT,
		getLatestRef: async () => LATEST,
		getCurrentVersion: () => "1.0.0",
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		applyUpdate: async () => {
			applied = true;
			return "must not update";
		},
	});

	await commands.get("update")!.handler("", {
		hasUI: true,
		ui: {
			select: async () => undefined,
			notify: () => {},
		},
	});

	assert.equal(applied, false);
	assert.equal(state.skippedRef, undefined);
	assert.equal(state.skippedAt, undefined);
});
