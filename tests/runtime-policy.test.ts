import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Editor } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { applyUgkRuntimePolicy, installUgkEditorBorderGlyphPatch } from "../bin/ugk-runtime-policy.js";

const PINNED_PI_VERSION = "0.79.4";
const PI_DEPENDENCIES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

function readJson(path: string): any {
	return JSON.parse(fs.readFileSync(path, "utf8"));
}

test("package pins every pi runtime dependency to the UGK-owned version", () => {
	const pkg = readJson("package.json");

	for (const dependency of PI_DEPENDENCIES) {
		assert.equal(pkg.dependencies[dependency], PINNED_PI_VERSION);
	}
});

test("package does not include playwright as a runtime dependency", () => {
	const pkg = readJson("package.json");

	assert.equal(pkg.dependencies.playwright, undefined);
});

test("default test script excludes slow MCP stdio integration tests", () => {
	const pkg = readJson("package.json");

	assert.equal(fs.existsSync("tests/mcp-client.test.ts"), false);
	assert.equal(fs.existsSync("tests/mcp-registry.test.ts"), false);
	assert.equal(fs.existsSync("tests/mcp-extension.test.ts"), false);
	assert.equal(fs.existsSync("tests/mcp-exit-timing.test.ts"), false);
	assert.equal(fs.existsSync("tests/integration/mcp-client.test.ts"), true);
	assert.equal(fs.existsSync("tests/integration/mcp-registry.test.ts"), true);
	assert.equal(fs.existsSync("tests/integration/mcp-extension.test.ts"), true);
	assert.equal(fs.existsSync("tests/integration/mcp-exit-timing.test.ts"), true);
	assert.equal(pkg.scripts.test, 'node --test "tests/*.test.ts"');
	assert.equal(pkg.scripts["test:integration"], 'node --test "tests/integration/*.test.ts"');
});

test("applyUgkRuntimePolicy disables pi-owned update surfaces", () => {
	const env = {
		PI_SKIP_VERSION_CHECK: "0",
		PI_TELEMETRY: "1",
	};

	applyUgkRuntimePolicy(env);

	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
});

test("applyUgkRuntimePolicy softens editor border glyphs", () => {
	const editor = new Editor(
		{ terminal: { rows: 24 }, requestRender() {} } as any,
		{ borderColor: (text: string) => text, selectList: {} as any },
	);
	editor.setText("keep ─ typed");

	applyUgkRuntimePolicy({});

	const lines = editor.render(12);

	assert.equal(lines[0], "╌".repeat(12));
	assert.equal(lines.at(-1), "╌".repeat(12));
	assert.match(lines.join("\n"), /keep ─/);
});

test("applyUgkRuntimePolicy softens coding-agent custom editor border glyphs", () => {
	installUgkEditorBorderGlyphPatch(CustomEditor);
	const editor = new CustomEditor(
		{ terminal: { rows: 24 }, requestRender() {} } as any,
		{ borderColor: (text: string) => text, selectList: {} as any },
		{ matches: () => false } as any,
	);

	const lines = editor.render(12);

	assert.equal(lines[0], "╌".repeat(12));
	assert.equal(lines.at(-1), "╌".repeat(12));
});
