import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTOPILOT_PROMPT_SNIPPET,
	createAutopilotState,
	installAutopilotState,
	isAutopilotOn,
	setAutopilot,
	suppressConfirmation,
} from "../extensions/shared/autopilot.ts";

// 每个测试用独立 state,避免单例串扰。
function isolatedState(enabled = false) {
	const state = createAutopilotState(enabled);
	installAutopilotState(state);
	return state;
}

test("autopilot defaults off", () => {
	isolatedState();
	assert.equal(isAutopilotOn(), false);
});

test("setAutopilot toggles the flag", () => {
	const state = isolatedState();
	setAutopilot(true);
	assert.equal(isAutopilotOn(), true);
	assert.equal(state.enabled, true);
	setAutopilot(false);
	assert.equal(isAutopilotOn(), false);
});

test("suppressConfirmation keeps confirmation when autopilot off", () => {
	isolatedState(false);
	assert.equal(suppressConfirmation(true), true);
	assert.equal(suppressConfirmation(false), false);
});

test("suppressConfirmation short-circuits to no-confirm when autopilot on", () => {
	isolatedState(true);
	assert.equal(suppressConfirmation(true), false);
	assert.equal(suppressConfirmation(false), false);
});

test("installAutopilotState isolates tests from the global singleton", () => {
	const a = installAutopilotState(createAutopilotState(true));
	const b = installAutopilotState(createAutopilotState(false));
	assert.equal(isAutopilotOn(a), true);
	assert.equal(isAutopilotOn(b), false);
});

test("AUTOPILOT_PROMPT_SNIPPET mentions irreversible/destructive carve-out", () => {
	assert.match(AUTOPILOT_PROMPT_SNIPPET, /不可逆|删除|花钱/);
	assert.match(AUTOPILOT_PROMPT_SNIPPET, /autopilot/);
});

// ponytail: self-check —— 验证 autopilot 短路的语义不变(CDP/MCP 都依赖这条契约)。
test("self-check: autopilot on always returns false from suppressConfirmation", () => {
	isolatedState(true);
	for (const input of [true, false]) {
		assert.equal(suppressConfirmation(input), false);
	}
});
