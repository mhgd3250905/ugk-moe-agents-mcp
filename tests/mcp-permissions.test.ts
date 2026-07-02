import test from "node:test";
import assert from "node:assert/strict";
import {
	checkMcpSpawnPolicy,
	checkMcpToolPolicy,
	clearMcpSessionAllow,
	createMcpPermissionState,
	grantMcpSessionAllow,
	isTaskMcpToolPreauthorized,
	setMcpPermissionMode,
} from "../extensions/mcp/permissions.ts";
import { createAutopilotState, installAutopilotState } from "../extensions/shared/autopilot.ts";

test("createMcpPermissionState defaults to ask mode", () => {
	const state = createMcpPermissionState();

	assert.equal(state.mode, "ask");
	assert.equal(state.sessionAllowedServers.size, 0);
});

test("setMcpPermissionMode updates mode and clears session allowed servers", () => {
	const state = createMcpPermissionState();
	grantMcpSessionAllow(state, "alpha");

	setMcpPermissionMode(state, "on");

	assert.equal(state.mode, "on");
	assert.equal(state.sessionAllowedServers.size, 0);
});

test("spawn policy allows user scope without confirmation", () => {
	const state = createMcpPermissionState();

	const result = checkMcpSpawnPolicy(
		state,
		{ serverName: "alpha", scope: "user", command: "node" },
		true,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: false });
});

test("spawn policy allows install scope without confirmation", () => {
	const state = createMcpPermissionState();

	const result = checkMcpSpawnPolicy(
		state,
		{ serverName: "packaged", scope: "install", command: "node" },
		false,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: false });
});

test("spawn policy requires confirmation for project scope in interactive mode", () => {
	const state = createMcpPermissionState();

	const result = checkMcpSpawnPolicy(
		state,
		{ serverName: "project-server", scope: "project", command: "node" },
		true,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: true });
});

test("spawn policy requires confirmation for local scope in interactive mode", () => {
	const state = createMcpPermissionState();

	const result = checkMcpSpawnPolicy(
		state,
		{ serverName: "local-server", scope: "local", command: "python" },
		true,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: true });
});

test("spawn policy fail-closes project and local scopes without UI", () => {
	const state = createMcpPermissionState();

	for (const scope of ["project", "local"] as const) {
		const result = checkMcpSpawnPolicy(
			state,
			{ serverName: `${scope}-server`, scope, command: "node" },
			false,
		);

		assert.equal(result.allowed, false);
		assert.equal(result.requiresConfirmation, false);
		assert.match(result.reason, /blocked by spawn policy/i);
		assert.match(result.reason, new RegExp(scope));
		assert.match(result.reason, new RegExp(`${scope}-server`));
	}
});

test("spawn policy allows user scope without UI", () => {
	const state = createMcpPermissionState();

	const result = checkMcpSpawnPolicy(
		state,
		{ serverName: "user-server", scope: "user", command: "node" },
		false,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: false });
});

test("tool policy blocks all tools when mode is off", () => {
	const state = createMcpPermissionState("off");

	const result = checkMcpToolPolicy(
		state,
		{ serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" },
		true,
	);

	assert.equal(result.allowed, false);
	assert.equal(result.requiresConfirmation, false);
	assert.match(result.reason, /MCP is off/);
	assert.match(result.reason, /\/mcp ask/);
	assert.match(result.reason, /\/mcp on/);
});

test("tool policy allows all tools when mode is on", () => {
	const state = createMcpPermissionState("on");

	const result = checkMcpToolPolicy(
		state,
		{ serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" },
		true,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: false });
});

test("tool policy requires confirmation in ask mode before a server is authorized", () => {
	const state = createMcpPermissionState("ask");

	const result = checkMcpToolPolicy(
		state,
		{ serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" },
		true,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: true });
});

test("task worker env can preauthorize specific registered MCP tools", () => {
	const env = { UGK_TASK_ALLOW_MCP_TOOLS: "alpha__echo,beta__search" };

	assert.equal(isTaskMcpToolPreauthorized("alpha__echo", env), true);
	assert.equal(isTaskMcpToolPreauthorized("beta__search", env), true);
	assert.equal(isTaskMcpToolPreauthorized("gamma__echo", env), false);
});

test("tool policy skips confirmation for a granted server in the same session", () => {
	const state = createMcpPermissionState("ask");
	grantMcpSessionAllow(state, "alpha");

	const result = checkMcpToolPolicy(
		state,
		{ serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" },
		true,
	);

	assert.deepEqual(result, { allowed: true, requiresConfirmation: false });
});

test("grantMcpSessionAllow only applies to the matching server", () => {
	const state = createMcpPermissionState("ask");
	grantMcpSessionAllow(state, "alpha");

	assert.equal(
		checkMcpToolPolicy(state, { serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" }, true)
			.requiresConfirmation,
		false,
	);
	assert.equal(
		checkMcpToolPolicy(state, { serverName: "beta", toolName: "echo", reason: "execute beta__echo" }, true)
			.requiresConfirmation,
		true,
	);
});

test("clearMcpSessionAllow clears one server or all servers", () => {
	const state = createMcpPermissionState("ask");
	grantMcpSessionAllow(state, "alpha");
	grantMcpSessionAllow(state, "beta");

	clearMcpSessionAllow(state, "alpha");

	assert.equal(state.sessionAllowedServers.has("alpha"), false);
	assert.equal(state.sessionAllowedServers.has("beta"), true);

	clearMcpSessionAllow(state);

	assert.equal(state.sessionAllowedServers.size, 0);
});

test("autopilot on suppresses MCP tool confirmation in ask mode", () => {
	installAutopilotState(createAutopilotState(true));
	try {
		const state = createMcpPermissionState("ask");
		const result = checkMcpToolPolicy(
			state,
			{ serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" },
			true,
		);
		assert.deepEqual(result, { allowed: true, requiresConfirmation: false });
	} finally {
		installAutopilotState(createAutopilotState(false));
	}
});

test("autopilot does not unblock MCP tools when mode is off (permission off)", () => {
	installAutopilotState(createAutopilotState(true));
	try {
		const state = createMcpPermissionState("off");
		const result = checkMcpToolPolicy(
			state,
			{ serverName: "alpha", toolName: "echo", reason: "execute alpha__echo" },
			true,
		);
		assert.equal(result.allowed, false);
	} finally {
		installAutopilotState(createAutopilotState(false));
	}
});
