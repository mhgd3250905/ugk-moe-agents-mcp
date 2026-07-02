import test from "node:test";
import assert from "node:assert/strict";
import {
	checkChromeCdpPolicy,
	clearChromeCdpSessionAllow,
	createChromeCdpState,
	grantChromeCdpSessionAllow,
	persistCdpPort,
	readPersistedCdpPort,
	resolveChromeCdpPort,
	resolveChromeCdpTarget,
	resolveUgkSettingsPath,
	setChromeCdpMode,
	setChromeCdpPort,
	type ChromeCdpPortDeps,
} from "../extensions/chrome-cdp/config.ts";
import { createAutopilotState, installAutopilotState } from "../extensions/shared/autopilot.ts";

const noPersistDeps: ChromeCdpPortDeps = {
	agentDir: "/fake/agent",
	exists: () => false,
	readFile: () => "",
	writeFile: () => {},
	mkdir: () => {},
};

test("createChromeCdpState defaults to ask mode and port 9222", () => {
	const state = createChromeCdpState({}, noPersistDeps);

	assert.equal(state.mode, "ask");
	assert.equal(resolveChromeCdpPort(state, {}), 9222);
});

test("resolveChromeCdpPort respects explicit, runtime, env, then default priority", () => {
	const prev = process.env.UGK_CDP_PORT;
	const state = createChromeCdpState({ UGK_CDP_PORT: "9333" }, noPersistDeps);
	try {
		assert.equal(resolveChromeCdpPort(state, { port: 9444 }), 9444);
		setChromeCdpPort(state, 9555, noPersistDeps);
		assert.equal(resolveChromeCdpPort(state, {}), 9555);

		const envOnly = createChromeCdpState({ UGK_CDP_PORT: "9333" }, noPersistDeps);
		assert.equal(resolveChromeCdpPort(envOnly, {}), 9333);

		const invalidEnv = createChromeCdpState({ UGK_CDP_PORT: "nope" }, noPersistDeps);
		assert.equal(resolveChromeCdpPort(invalidEnv, {}), 9222);
	} finally {
		if (prev === undefined) delete process.env.UGK_CDP_PORT;
		else process.env.UGK_CDP_PORT = prev;
	}
});

test("task worker env preauthorizes chrome_cdp for the child process", () => {
	const state = createChromeCdpState({ UGK_TASK_ALLOW_CHROME_CDP: "1" }, noPersistDeps);
	const result = checkChromeCdpPolicy(state, {
		action: "tabs",
		reason: "Requires logged-in Chrome session",
		normalAccessAttempted: true,
	});

	assert.equal(result.allowed, true);
	assert.equal(result.requiresConfirmation, false);
});

test("setChromeCdpPort rejects invalid ports", () => {
	const state = createChromeCdpState({}, noPersistDeps);

	assert.throws(() => setChromeCdpPort(state, 0, noPersistDeps), /Invalid CDP port/);
	assert.throws(() => setChromeCdpPort(state, 70000, noPersistDeps), /Invalid CDP port/);
	assert.throws(() => setChromeCdpPort(state, 1.5, noPersistDeps), /Invalid CDP port/);
});

test("checkChromeCdpPolicy blocks execution when mode is off", () => {
	const state = createChromeCdpState({}, noPersistDeps);
	setChromeCdpMode(state, "off");

	const result = checkChromeCdpPolicy(state, {
		action: "tabs",
		reason: "Need logged-in Chrome session",
		normalAccessAttempted: true,
	});

	assert.equal(result.allowed, false);
	assert.equal(result.requiresConfirmation, false);
	assert.match(result.reason, /已关闭/);
});

test("checkChromeCdpPolicy allows status without confirmation", () => {
	const state = createChromeCdpState({}, noPersistDeps);

	const result = checkChromeCdpPolicy(state, {
		action: "status",
		reason: "Check whether CDP is reachable",
		normalAccessAttempted: false,
	});

	assert.equal(result.allowed, true);
	assert.equal(result.requiresConfirmation, false);
});

test("checkChromeCdpPolicy allows launch without confirmation in ask mode", () => {
	const state = createChromeCdpState({}, noPersistDeps);

	const result = checkChromeCdpPolicy(state, {
		action: "launch",
		reason: "Need to start the dedicated local Chrome CDP profile",
		normalAccessAttempted: false,
	});

	assert.equal(result.allowed, true);
	assert.equal(result.requiresConfirmation, false);
});

test("checkChromeCdpPolicy blocks non-status actions when normal access was not attempted", () => {
	const state = createChromeCdpState({}, noPersistDeps);

	const result = checkChromeCdpPolicy(state, {
		action: "navigate",
		url: "https://example.com",
		reason: "Open a public page",
		normalAccessAttempted: false,
	});

	assert.equal(result.allowed, false);
	assert.match(result.reason, /普通访问/);
});

test("checkChromeCdpPolicy requires confirmation in ask mode and allows in on mode", () => {
	const state = createChromeCdpState({}, noPersistDeps);
	const request = {
		action: "navigate",
		url: "https://private.example.com",
		reason: "Requires the user's logged-in browser session",
		normalAccessAttempted: true,
	} as const;

	assert.deepEqual(checkChromeCdpPolicy(state, request), {
		allowed: true,
		requiresConfirmation: true,
	});

	setChromeCdpMode(state, "on");
	assert.deepEqual(checkChromeCdpPolicy(state, request), {
		allowed: true,
		requiresConfirmation: false,
	});
});

test("session allow skips ask confirmation until mode changes clear it", () => {
	const state = createChromeCdpState({}, noPersistDeps);
	const request = {
		action: "tabs",
		reason: "Requires logged-in Chrome session",
		normalAccessAttempted: true,
	} as const;

	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);

	grantChromeCdpSessionAllow(state);
	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, false);

	clearChromeCdpSessionAllow(state);
	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);

	grantChromeCdpSessionAllow(state);
	setChromeCdpMode(state, "ask");
	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);

	grantChromeCdpSessionAllow(state);
	setChromeCdpMode(state, "off");
	assert.equal(state.sessionAllowed, false);
});

test("persistCdpPort writes and readPersistedCdpPort reads back", () => {
	const settingsPath = resolveUgkSettingsPath({ agentDir: "/fake/agent" });
	const files = new Map<string, string>([
		[settingsPath, JSON.stringify({ shellPath: "bash" })],
	]);
	const deps: ChromeCdpPortDeps = {
		agentDir: "/fake/agent",
		exists: (p) => files.has(p),
		readFile: (p) => files.get(p) ?? "",
		writeFile: (p, c) => files.set(p, c),
		mkdir: () => {},
	};

	persistCdpPort(9333, deps);

	assert.equal(readPersistedCdpPort(deps), 9333);
	const written = JSON.parse(files.get(settingsPath)!);
	assert.equal(written.shellPath, "bash");
	assert.equal(written.cdpPort, 9333);
});

test("readPersistedCdpPort returns undefined when settings missing or invalid", () => {
	assert.equal(readPersistedCdpPort(noPersistDeps), undefined);
	assert.equal(readPersistedCdpPort({ ...noPersistDeps, exists: () => true, readFile: () => "not json" }), undefined);
});

test("setChromeCdpPort persists to settings and syncs process.env", () => {
	const files = new Map<string, string>();
	const deps: ChromeCdpPortDeps = {
		agentDir: "/fake/agent",
		exists: (p) => files.has(p),
		readFile: (p) => files.get(p) ?? "",
		writeFile: (p, c) => files.set(p, c),
		mkdir: () => {},
	};
	const prev = process.env.UGK_CDP_PORT;
	const state = createChromeCdpState({}, noPersistDeps);
	try {
		setChromeCdpPort(state, 9444, deps);
		assert.equal(process.env.UGK_CDP_PORT, "9444");
		assert.equal(readPersistedCdpPort(deps), 9444);
	} finally {
		if (prev === undefined) delete process.env.UGK_CDP_PORT;
		else process.env.UGK_CDP_PORT = prev;
	}
});

test("createChromeCdpState restores runtimePort from persisted settings", () => {
	const settingsPath = resolveUgkSettingsPath({ agentDir: "/fake/agent" });
	const files = new Map<string, string>([[settingsPath, JSON.stringify({ cdpPort: 9555 })]]);
	const deps: ChromeCdpPortDeps = {
		agentDir: "/fake/agent",
		exists: (p) => files.has(p),
		readFile: (p) => files.get(p) ?? "",
	};
	const state = createChromeCdpState({}, deps);

	assert.equal(resolveChromeCdpPort(state, {}), 9555);
});

test("runtime port from settings takes priority over env port", () => {
	const settingsPath = resolveUgkSettingsPath({ agentDir: "/fake/agent" });
	const files = new Map<string, string>([[settingsPath, JSON.stringify({ cdpPort: 9555 })]]);
	const deps: ChromeCdpPortDeps = {
		agentDir: "/fake/agent",
		exists: (p) => files.has(p),
		readFile: (p) => files.get(p) ?? "",
	};
	const state = createChromeCdpState({ UGK_CDP_PORT: "9333" }, deps);

	assert.equal(resolveChromeCdpPort(state, {}), 9555);
});

test("createChromeCdpState reads sessionTabId from UGK_CDP_TAB_ID env", () => {
	const withTab = createChromeCdpState({ UGK_CDP_TAB_ID: "tab-xyz" }, noPersistDeps);
	assert.equal(withTab.sessionTabId, "tab-xyz");

	const withoutTab = createChromeCdpState({}, noPersistDeps);
	assert.equal(withoutTab.sessionTabId, undefined);
});

test("resolveChromeCdpTarget returns explicit target over session tab", () => {
	const state = createChromeCdpState({ UGK_CDP_TAB_ID: "session-tab" }, noPersistDeps);

	assert.equal(resolveChromeCdpTarget(state, { target: "explicit-tab" }), "explicit-tab");
});

test("resolveChromeCdpTarget falls back to session tab when no explicit target", () => {
	const state = createChromeCdpState({ UGK_CDP_TAB_ID: "session-tab" }, noPersistDeps);

	assert.equal(resolveChromeCdpTarget(state, {}), "session-tab");
});

test("resolveChromeCdpTarget returns undefined when neither target nor session tab set", () => {
	const state = createChromeCdpState({}, noPersistDeps);

	assert.equal(resolveChromeCdpTarget(state, { target: "explicit" }), "explicit");
	assert.equal(resolveChromeCdpTarget(state, {}), undefined);
});

test("autopilot on suppresses CDP confirmation in ask mode", () => {
	installAutopilotState(createAutopilotState(true));
	try {
		const state = createChromeCdpState({}, noPersistDeps);
		const request = {
			action: "navigate",
			url: "https://private.example.com",
			reason: "Requires the user's logged-in browser session",
			normalAccessAttempted: true,
		} as const;

		assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, false);
	} finally {
		installAutopilotState(createAutopilotState(false));
	}
});

test("autopilot off keeps CDP confirmation in ask mode", () => {
	installAutopilotState(createAutopilotState(false));
	const state = createChromeCdpState({}, noPersistDeps);
	const request = {
		action: "navigate",
		url: "https://private.example.com",
		reason: "Requires the user's logged-in browser session",
		normalAccessAttempted: true,
	} as const;

	assert.equal(checkChromeCdpPolicy(state, request).requiresConfirmation, true);
});

test("autopilot does not unblock CDP when mode is off", () => {
	installAutopilotState(createAutopilotState(true));
	try {
		const state = createChromeCdpState({}, noPersistDeps);
		setChromeCdpMode(state, "off");
		const result = checkChromeCdpPolicy(state, {
			action: "tabs",
			reason: "Need logged-in Chrome session",
			normalAccessAttempted: true,
		});

		assert.equal(result.allowed, false);
	} finally {
		installAutopilotState(createAutopilotState(false));
	}
});
