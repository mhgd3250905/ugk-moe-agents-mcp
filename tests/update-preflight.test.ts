import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	advanceCliUpdatePromptSelection,
	buildCliUpdatePromptRerenderSequence,
	formatCliUpdatePrompt,
	promptCliUpdateChoice,
	runUgkUpdatePreflight,
	shouldRunCliUpdatePreflight,
	type CliUpdateChoice,
} from "../bin/update-preflight.js";
import type { UgkUpdateState } from "../extensions/update-check.ts";

const CURRENT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LATEST = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ttyStream(isTTY = true) {
	let text = "";
	return {
		isTTY,
		write(chunk: string) {
			text += chunk;
		},
		text: () => text,
	};
}

test("shouldRunCliUpdatePreflight only runs for interactive startup", () => {
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: {}, stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
	assert.equal(
		shouldRunCliUpdatePreflight({ argv: ["--print", "hello"], env: {}, stdin: { isTTY: true }, stdout: { isTTY: true } }),
		false,
	);
	assert.equal(
		shouldRunCliUpdatePreflight({ argv: ["--version"], env: {}, stdin: { isTTY: true }, stdout: { isTTY: true } }),
		false,
	);
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: { UGK_SKIP_UPDATE_CHECK: "1" }, stdin: { isTTY: true }, stdout: { isTTY: true } }), false);
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: {}, stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
	assert.equal(shouldRunCliUpdatePreflight({ argv: [], env: {}, stdin: { isTTY: true }, stdout: { isTTY: false } }), false);
});

test("formatCliUpdatePrompt mirrors codex-style numbered update choices", () => {
	const prompt = formatCliUpdatePrompt(
		{
			currentRef: CURRENT,
			latestRef: LATEST,
			currentVersion: "1.0.0",
			source: "github-main",
		},
		"npm install -g ugk-agent",
	);

	assert.match(prompt, /✨ 发现可用更新!/);
	assert.match(prompt, /1\.0\.0 \(aaaaaaa\) -> bbbbbbb/);
	assert.match(prompt, /1\. 立即更新\(运行 `npm install -g ugk-agent`\)/);
	assert.match(prompt, /2\. 跳过本次/);
	assert.match(prompt, /3\. 跳过直到下个版本/);
	assert.match(prompt, /使用 ↑\/↓ 选择,Enter 确认,Esc 取消/);
});

test("advanceCliUpdatePromptSelection supports arrow navigation and enter selection", () => {
	let state = { selected: 0 };

	state = advanceCliUpdatePromptSelection(state, "\u001b[B");
	assert.equal(state.selected, 1);

	state = advanceCliUpdatePromptSelection(state, "\u001b[B");
	assert.equal(state.selected, 2);

	state = advanceCliUpdatePromptSelection(state, "\r");
	assert.equal(state.done, true);
	assert.equal(state.choice, "skip-until-next");
});

test("advanceCliUpdatePromptSelection wraps, cancels, and supports numeric shortcuts", () => {
	let state = { selected: 0 };

	state = advanceCliUpdatePromptSelection(state, "\u001b[A");
	assert.equal(state.selected, 2);

	state = advanceCliUpdatePromptSelection(state, "2");
	assert.equal(state.done, true);
	assert.equal(state.choice, "skip");

	state = advanceCliUpdatePromptSelection({ selected: 1 }, "\u001b");
	assert.equal(state.done, true);
	assert.equal(state.choice, "skip");
});

test("buildCliUpdatePromptRerenderSequence clears the previous update prompt", () => {
	assert.equal(buildCliUpdatePromptRerenderSequence(0), "");
	assert.equal(buildCliUpdatePromptRerenderSequence(1), "\r\u001b[J");
	assert.equal(buildCliUpdatePromptRerenderSequence(10), "\r\u001b[9A\u001b[J");
});

test("promptCliUpdateChoice uses raw TTY arrow navigation", async () => {
	const input = new EventEmitter() as EventEmitter & {
		isTTY: boolean;
		setRawMode: (value: boolean) => void;
		resume: () => void;
	};
	const output = ttyStream();
	const rawModes: boolean[] = [];
	let resumed = false;
	input.isTTY = true;
	input.setRawMode = (value) => {
		rawModes.push(value);
	};
	input.resume = () => {
		resumed = true;
	};

	const choice = promptCliUpdateChoice(
		input as any,
		output as any,
		{ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" },
		"npm install -g ugk-agent",
	);
	queueMicrotask(() => {
		input.emit("data", Buffer.from("\u001b[B"));
		input.emit("data", Buffer.from("\r"));
	});

	assert.equal(await choice, "skip");
	assert.equal(resumed, true);
	assert.deepEqual(rawModes, [true, false]);
	assert.match(output.text(), /› 2\. 跳过本次/);
});

test("runUgkUpdatePreflight continues when no update is available", async () => {
	const output = ttyStream();
	let applied = false;
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: output as any,
		stderr: ttyStream() as any,
		readState: () => ({}),
		writeState: () => {},
		detectUpdate: async () => undefined,
		applyUpdate: async () => {
			applied = true;
			return "must not update";
		},
	});

	assert.deepEqual(result, { action: "continue" });
	assert.equal(applied, false);
	assert.equal(output.text(), "");
});

test("runUgkUpdatePreflight skip only affects the current run", async () => {
	const output = ttyStream();
	let state: UgkUpdateState = {};
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: output as any,
		stderr: ttyStream() as any,
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		detectUpdate: async () => ({ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" }),
		selectUpdateChoice: async (): Promise<CliUpdateChoice> => "skip",
		applyUpdate: async () => "must not update",
	});

	assert.deepEqual(result, { action: "continue" });
	assert.equal(state.skippedRef, undefined);
	assert.equal(state.skippedAt, undefined);
	assert.match(output.text(), /已跳过本次 UGK 更新/);
});

test("runUgkUpdatePreflight skip until next version records the latest ref", async () => {
	let state: UgkUpdateState = {};
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: ttyStream() as any,
		stderr: ttyStream() as any,
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		readState: () => state,
		writeState: (next) => {
			state = next;
		},
		detectUpdate: async () => ({ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" }),
		selectUpdateChoice: async (): Promise<CliUpdateChoice> => "skip-until-next",
		applyUpdate: async () => "must not update",
	});

	assert.deepEqual(result, { action: "continue" });
	assert.equal(state.skippedRef, LATEST);
	assert.equal(state.skippedAt, "2026-06-17T00:00:00.000Z");
});

test("runUgkUpdatePreflight updates and asks caller to exit before pi starts", async () => {
	const output = ttyStream();
	let applied = false;
	const result = await runUgkUpdatePreflight({
		force: true,
		stdout: output as any,
		stderr: ttyStream() as any,
		readState: () => ({}),
		writeState: () => {},
		detectUpdate: async () => ({ currentRef: CURRENT, latestRef: LATEST, currentVersion: "1.0.0", source: "github-main" }),
		selectUpdateChoice: async (): Promise<CliUpdateChoice> => "update",
		applyUpdate: async () => {
			applied = true;
			return "done";
		},
		updateCommandLabel: () => "npm install -g ugk-agent",
	});

	assert.deepEqual(result, { action: "exit", exitCode: 0 });
	assert.equal(applied, true);
	assert.match(output.text(), /正在通过 `npm install -g ugk-agent` 更新 UGK/);
	assert.match(output.text(), /🎉 更新命令已成功运行,请重启 UGK/);
});
