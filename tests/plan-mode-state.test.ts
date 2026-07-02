import test from "node:test";
import assert from "node:assert/strict";
import {
	completeExecution,
	createPlanModeState,
	restorePlanModeState,
	startExecution,
	togglePlanMode,
} from "../extensions/plan-mode-state.ts";

const todoItems = [{ step: 1, text: "Read files", completed: false }];

test("togglePlanMode flips planning on and resets execution state", () => {
	const initial = { planModeEnabled: false, executionMode: true, todoItems, savedTools: undefined };
	assert.deepEqual(togglePlanMode(initial), {
		planModeEnabled: true,
		executionMode: false,
		todoItems: [],
		savedTools: undefined,
	});
});

test("startExecution exits planning and keeps extracted todos", () => {
	assert.deepEqual(
		startExecution({ planModeEnabled: true, executionMode: false, todoItems, savedTools: undefined }),
		{
			planModeEnabled: false,
			executionMode: true,
			todoItems,
			savedTools: undefined,
		},
	);
});

test("completeExecution clears plan-mode progress", () => {
	assert.deepEqual(
		completeExecution({ planModeEnabled: false, executionMode: true, todoItems, savedTools: undefined }),
		createPlanModeState(),
	);
});

// S1 fix: completeExecution must preserve savedTools so the caller can still restore MCP/dynamic tools.
test("completeExecution preserves savedTools for later restore", () => {
	const savedTools = ["read", "bash", "mcp__fs__read_file"];
	const result = completeExecution({ planModeEnabled: false, executionMode: true, todoItems, savedTools });
	assert.equal(result.savedTools, savedTools);
	assert.equal(result.executionMode, false);
	assert.deepEqual(result.todoItems, []);
});

test("restorePlanModeState applies persisted state over defaults", () => {
	assert.deepEqual(
		restorePlanModeState(createPlanModeState(), {
			enabled: true,
			executing: true,
			todos: todoItems,
		}),
		{ planModeEnabled: true, executionMode: true, todoItems, savedTools: undefined },
	);
});

// S1 fix: savedTools snapshot must survive state transitions so dynamic tools (MCP) are restored.
test("togglePlanMode preserves savedTools across toggle", () => {
	const savedTools = ["read", "bash", "edit", "write", "mcp__github__search"];
	const initial = { planModeEnabled: false, executionMode: false, todoItems: [], savedTools };
	assert.deepEqual(togglePlanMode(initial), {
		planModeEnabled: true,
		executionMode: false,
		todoItems: [],
		savedTools,
	});
});

test("startExecution preserves savedTools so it can be restored after execution", () => {
	const savedTools = ["read", "bash", "mcp__fs__read_file"];
	const result = startExecution({ planModeEnabled: true, executionMode: false, todoItems, savedTools });
	assert.equal(result.savedTools, savedTools);
});

test("createPlanModeState initializes savedTools as undefined", () => {
	assert.equal(createPlanModeState().savedTools, undefined);
});
