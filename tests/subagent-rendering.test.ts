import test from "node:test";
import assert from "node:assert/strict";
import { formatToolCall, renderSubagentResult } from "../extensions/subagent-rendering.ts";

const plainTheme = (_color: string, text: string) => text;

test("formats common subagent tool calls for collapsed rendering", () => {
	assert.equal(formatToolCall("bash", { command: "rg registerTool extensions" }, plainTheme), "$ rg registerTool extensions");
	assert.equal(formatToolCall("read", { path: "extensions/subagent.ts", offset: 10, limit: 3 }, plainTheme), "read extensions/subagent.ts:10-12");
	assert.equal(formatToolCall("grep", { pattern: "cron", path: "extensions" }, plainTheme), "grep /cron/ in extensions");
});

test("shortens home paths in rendered tool calls", () => {
	const home = process.env.USERPROFILE || process.env.HOME;
	assert.ok(home);

	const rendered = formatToolCall("ls", { path: `${home}\\AppData\\Local` }, plainTheme);
	assert.match(rendered, /^ls ~/);
});

test("keeps running collapsed subagent output to a short tail", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const messages = Array.from({ length: 20 }, (_, i) => ({
		role: "assistant",
		content: [{ type: "toolCall", name: "bash", arguments: { command: `cmd-${i}` } }],
	}));

	const component = renderSubagentResult(
		{
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						agent: "scout",
						agentSource: "user",
						task: "scan",
						exitCode: -1,
						messages,
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					},
				],
			},
		} as any,
		{ expanded: false, isPartial: true },
		theme,
	);
	const text = component.render(120).join("\n");

	assert.match(text, /cmd-19/);
	assert.doesNotMatch(text, /cmd-10/);
	assert.match(text, /\.\.\. 17 earlier items/);
});
