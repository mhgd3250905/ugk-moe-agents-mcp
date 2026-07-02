import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerBuiltinToolRenderers from "../extensions/builtin-tool-render.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_style: string, text: string) => text,
};

function renderText(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n").trimEnd();
}

async function withUiLanguage(language: string, fn: () => Promise<void> | void) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-render-language-"));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: language }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await fn();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

test("builtin renderer registers only bash and edit", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);

	assert.deepEqual(tools.map((tool) => tool.name), ["bash", "edit"]);
	assert.equal(tools[1].renderShell, "self");
});

test("bash renderer summarizes success and failure output", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
	const bash = tools.find((tool) => tool.name === "bash");

	const success = bash.renderResult(
		{ content: [{ type: "text", text: "one\ntwo\n" }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		{},
	);
	assert.equal(renderText(success), "完成 (2 行)");

	const failure = bash.renderResult(
		{ content: [{ type: "text", text: "bad\n\nCommand exited with code 2" }], details: {}, isError: true },
		{ expanded: false, isPartial: false },
		theme,
		{},
	);
	assert.equal(renderText(failure), "exit 2 (2 行)");
});

test("builtin renderers follow UI language", async () => {
	await withUiLanguage("en-US", () => {
		const tools: any[] = [];
		registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
		const bash = tools.find((tool) => tool.name === "bash");

		const running = bash.renderResult(
			{ content: [], details: {} },
			{ expanded: false, isPartial: true },
			theme,
			{},
		);
		assert.equal(renderText(running), "running...");

		const success = bash.renderResult(
			{ content: [{ type: "text", text: "one\n" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			{},
		);
		assert.equal(renderText(success), "done (1 lines)");
	});
});

test("bash renderer falls back to red exit when error output has no code", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
	const bash = tools.find((tool) => tool.name === "bash");

	const failure = bash.renderResult(
		{ content: [{ type: "text", text: "Command failed before exit code was known" }], details: {}, isError: true },
		{ expanded: false, isPartial: false },
		theme,
		{},
	);

	assert.equal(renderText(failure), "exit 1 (1 行)");
});

test("edit renderer summarizes diff stats", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
	const edit = tools.find((tool) => tool.name === "edit");

	const summary = edit.renderResult(
		{
			content: [{ type: "text", text: "Applied" }],
			details: { diff: "--- a/file\n+++ b/file\n-old\n+new\n+extra\n context" },
		},
		{ expanded: false, isPartial: false },
		theme,
		{},
	);

	assert.equal(renderText(summary), "+2 / -1");
});
