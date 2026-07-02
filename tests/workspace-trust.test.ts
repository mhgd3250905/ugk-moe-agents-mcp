import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	advanceTrustPromptSelection,
	buildTrustPromptRerenderSequence,
	ensureWorkspaceTrusted,
	findWorkspaceRoot,
	isWorkspaceTrusted,
	readTrustedWorkspaces,
	trustWorkspace,
	type TrustedWorkspacesState,
} from "../bin/workspace-trust.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-workspace-trust-"));
}

function makeTempWorkspace(): string {
	const workspace = makeTempDir();
	fs.writeFileSync(path.join(workspace, "package.json"), "{}");
	return workspace;
}

test("findWorkspaceRoot prefers the nearest project marker", () => {
	const root = makeTempDir();
	const nested = path.join(root, "packages", "app");
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(path.join(root, ".git"), "gitdir: somewhere");

	assert.equal(findWorkspaceRoot(nested), root);
});

test("trustWorkspace records a normalized workspace entry", () => {
	const agentDir = makeTempDir();
	const workspace = makeTempWorkspace();
	const now = new Date("2026-06-17T00:00:00.000Z");

	trustWorkspace(workspace, agentDir, now);

	const state = readTrustedWorkspaces(agentDir);
	assert.equal(isWorkspaceTrusted(workspace, state), true);
	assert.equal(state.workspaces[path.resolve(workspace)].trustedAt, now.toISOString());
});

test("ensureWorkspaceTrusted skips prompt for trusted workspaces", async () => {
	const agentDir = makeTempDir();
	const workspace = makeTempWorkspace();
	trustWorkspace(workspace, agentDir, new Date("2026-06-17T00:00:00.000Z"));
	let prompted = false;

	const result = await ensureWorkspaceTrusted({
		cwd: workspace,
		agentDir,
		isInteractive: true,
		promptTrust: async () => {
			prompted = true;
			return false;
		},
	});

	assert.equal(result.trusted, true);
	assert.equal(result.workspaceRoot, path.resolve(workspace));
	assert.equal(prompted, false);
});

test("ensureWorkspaceTrusted records trust after interactive approval", async () => {
	const agentDir = makeTempDir();
	const workspace = makeTempWorkspace();

	const result = await ensureWorkspaceTrusted({
		cwd: workspace,
		agentDir,
		isInteractive: true,
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		promptTrust: async () => true,
	});

	const state = readTrustedWorkspaces(agentDir);
	assert.equal(result.trusted, true);
	assert.equal(isWorkspaceTrusted(workspace, state), true);
});

test("ensureWorkspaceTrusted rejects untrusted non-interactive workspaces", async () => {
	const agentDir = makeTempDir();
	const workspace = makeTempWorkspace();

	const result = await ensureWorkspaceTrusted({
		cwd: workspace,
		agentDir,
		isInteractive: false,
	});

	assert.equal(result.trusted, false);
	assert.match(result.reason ?? "", /需要先信任工作目录/);
});

test("isWorkspaceTrusted supports legacy array-shaped state", () => {
	const workspace = path.resolve(makeTempWorkspace());
	const legacyState = {
		workspaces: [workspace],
	} as unknown as TrustedWorkspacesState;

	assert.equal(isWorkspaceTrusted(workspace, legacyState), true);
});

test("advanceTrustPromptSelection supports arrow navigation and enter selection", () => {
	let state = { selected: 0 };

	state = advanceTrustPromptSelection(state, "\u001b[B");
	assert.equal(state.selected, 1);

	state = advanceTrustPromptSelection(state, "\r");
	assert.equal(state.done, true);
	assert.equal(state.approved, false);
});

test("advanceTrustPromptSelection wraps with arrow keys and cancels on escape", () => {
	let state = { selected: 0 };

	state = advanceTrustPromptSelection(state, "\u001b[A");
	assert.equal(state.selected, 1);

	state = advanceTrustPromptSelection(state, "\u001b");
	assert.equal(state.done, true);
	assert.equal(state.approved, false);
});

test("buildTrustPromptRerenderSequence clears the previous block without moving above it", () => {
	assert.equal(buildTrustPromptRerenderSequence(0), "");
	assert.equal(buildTrustPromptRerenderSequence(1), "\r\u001b[J");
	assert.equal(buildTrustPromptRerenderSequence(10), "\r\u001b[9A\u001b[J");
});
