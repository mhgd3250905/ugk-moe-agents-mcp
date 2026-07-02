import test from "node:test";
import assert from "node:assert/strict";
import registerUgkBrandUi from "../extensions/ui-brand.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ponytail: spinner 容错不变量(原 ui-titlebar.test.ts 迁移)。spinner 已并入 ui-brand,
// 验证 agent 工作期间 ctx 变 stale 不会抛未捕获异常(timer 自停)。
test("ugk title spinner stops itself if the captured extension context becomes stale", async () => {
	const handlers = new Map<string, Function>();
	let stale = false;
	const errors: Error[] = [];
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerFlag() {},
		registerCommand() {},
		getFlag() {
			return false;
		},
		getSessionName() {
			if (stale) throw new Error("ctx stale after session replacement or reload.");
			return "demo";
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			setTitle() {
				if (stale) throw new Error("ctx stale after session replacement or reload.");
			},
			notify() {},
			setHeader() {},
			setFooter() {},
		},
	};
	const onUncaught = (error: Error) => {
		errors.push(error);
	};

	process.prependListener("uncaughtException", onUncaught);
	try {
		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({}, ctx);
		await handlers.get("agent_start")!({}, ctx);
		await wait(120);
		stale = true;
		await wait(220);
	} finally {
		process.removeListener("uncaughtException", onUncaught);
		await handlers.get("session_shutdown")?.({ reason: "test" }, ctx);
	}

	assert.deepEqual(errors.map((error) => error.message), []);
});

test("ugk title spinner uses the active session cwd", async () => {
	const handlers = new Map<string, Function>();
	const titles: string[] = [];
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerFlag() {},
		registerCommand() {},
		getFlag() {
			return false;
		},
		getSessionName() {
			return "demo";
		},
	};
	const ctx = {
		cwd: "/Users/demo/projects/fallback",
		sessionManager: {
			getCwd: () => "/Users/demo/projects/active-session",
			getEntries: () => [],
		},
		ui: {
			setTitle(title: string) {
				titles.push(title);
			},
			notify() {},
			setHeader() {},
			setFooter() {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("agent_start")!({}, ctx);
	await wait(100);
	await handlers.get("agent_end")!({}, ctx);
	await handlers.get("session_shutdown")?.({ reason: "test" }, ctx);

	assert.match(titles.join("\n"), /⠋ ugk - demo - active-session/);
	assert.equal(titles.at(-1), "ugk - demo - active-session");
});
