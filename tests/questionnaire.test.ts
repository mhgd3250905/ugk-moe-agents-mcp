import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerQuestionnaire from "../extensions/questionnaire.ts";

async function withUiLanguage(language: string, fn: () => Promise<void> | void) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-questionnaire-language-"));
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

function makeQuestionnaireTool() {
	let tool: any;
	registerQuestionnaire({
		registerTool(registered: any) {
			tool = registered;
		},
	} as any);
	return tool;
}

function makeCtx(mode = "tui", includeUi = true) {
	const selections: Array<{ title: string; options: string[] }> = [];
	const editorCalls: Array<{ title: string; value: string }> = [];
	return {
		selections,
		editorCalls,
		ctx: {
			mode,
			hasUI: includeUi,
			ui: includeUi ? {
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return options[0];
				},
				editor(title: string, value: string) {
					editorCalls.push({ title, value });
					return "custom answer";
				},
			} : undefined,
		},
	};
}

test("questionnaire maps duplicate labels by stable display selection", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx, selections } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => {
		selections.push({ title, options });
		return options[1];
	};

	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "scope",
					prompt: "Pick scope",
					options: [
						{ value: "first", label: "Same" },
						{ value: "second", label: "Same" },
					],
					allowOther: false,
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details.answers[0], {
		id: "scope",
		value: "second",
		label: "Same",
		wasCustom: false,
		index: 2,
	});
});

test("questionnaire does not treat a real Type something. option as custom", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx, editorCalls } = makeCtx();

	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "mode",
					prompt: "Pick mode",
					options: [{ value: "literal-other-label", label: "Type something." }],
					allowOther: true,
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details.answers[0], {
		id: "mode",
		value: "literal-other-label",
		label: "Type something.",
		wasCustom: false,
		index: 1,
	});
	assert.equal(editorCalls.length, 0);
});

test("questionnaire allowOther selection uses editor and returns custom answer", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx, selections, editorCalls } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => {
		selections.push({ title, options });
		return options.at(-1)!;
	};

	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "detail",
					prompt: "Add detail",
					options: [{ value: "preset", label: "Preset" }],
					allowOther: true,
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details.answers[0], {
		id: "detail",
		value: "custom answer",
		label: "custom answer",
		wasCustom: true,
	});
	assert.deepEqual(editorCalls, [{ title: "Add detail", value: "" }]);
});

test("questionnaire UI strings follow UI language", async () => {
	await withUiLanguage("en-US", async () => {
		const tool = makeQuestionnaireTool();
		const { ctx, selections } = makeCtx();

		await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "detail",
						prompt: "Add detail",
						options: [{ value: "preset", label: "Preset" }],
						allowOther: true,
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		assert.deepEqual(selections[0].options, ["1. Preset", "2. Type another answer."]);

		const noUi = await tool.execute(
			"call-2",
			{ questions: [{ id: "x", prompt: "X", options: [{ value: "x", label: "X" }] }] },
			undefined,
			undefined,
			makeCtx("print", false).ctx,
		);
		assert.match(noUi.content[0].text, /UI unavailable/);
	});
});

test("questionnaire works in rpc mode when extension UI is available", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx } = makeCtx("rpc");

	const result = await tool.execute(
		"call-1",
		{ questions: [{ id: "x", prompt: "X", options: [{ value: "x", label: "X" }] }] },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers[0], {
		id: "x",
		value: "x",
		label: "X",
		wasCustom: false,
		index: 1,
	});
});

test("questionnaire returns cancelled error when UI is unavailable", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx } = makeCtx("print", false);

	const result = await tool.execute(
		"call-1",
		{ questions: [{ id: "x", prompt: "X", options: [{ value: "x", label: "X" }] }] },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.cancelled, true);
	assert.match(result.content[0].text, /UI 不可用/);
});

// theme stub: passthrough, so assertions read the raw text the renderer built.
const stubTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

const sampleAnswers = [
	{ id: "scope", value: "file", label: "Single file", wasCustom: false, index: 1 },
	{ id: "detail", value: "custom answer", label: "custom answer", wasCustom: true },
];

test("renderResult collapses to a one-line summary and expands on demand", () => {
	const tool = makeQuestionnaireTool();
	const result = { content: [{ type: "text" as const, text: "..." }], details: { answers: sampleAnswers, cancelled: false } };

	const collapsed = String(tool.renderResult(result, { expanded: false, isPartial: false }, stubTheme).text);
	assert.match(collapsed, /已回答 2 个问题/);
	assert.doesNotMatch(collapsed, /scope/);

	const expanded = String(tool.renderResult(result, { expanded: true, isPartial: false }, stubTheme).text);
	assert.match(expanded, /scope: 用户选择: 1\. Single file/);
	assert.match(expanded, /detail: 用户填写: custom answer/);
});

test("renderResult follows UI language", async () => {
	await withUiLanguage("en-US", () => {
		const tool = makeQuestionnaireTool();
		const result = { content: [{ type: "text" as const, text: "..." }], details: { answers: sampleAnswers, cancelled: false } };

		const collapsed = String(tool.renderResult(result, { expanded: false, isPartial: false }, stubTheme).text);
		assert.match(collapsed, /answered 2 questions/);

		const expanded = String(tool.renderResult(result, { expanded: true, isPartial: false }, stubTheme).text);
		assert.match(expanded, /scope: user selected: 1\. Single file/);
		assert.match(expanded, /detail: user typed: custom answer/);
	});
});

test("renderResult reports cancelled state", () => {
	const tool = makeQuestionnaireTool();
	const result = {
		content: [{ type: "text" as const, text: "User cancelled the questionnaire" }],
		details: { answers: [sampleAnswers[0]], cancelled: true },
	};

	const collapsed = String(tool.renderResult(result, { expanded: false, isPartial: false }, stubTheme).text);
	assert.match(collapsed, /取消,已回答 1 个/);
});

test("renderCall shows question count and up to three labels", () => {
	const tool = makeQuestionnaireTool();
	const args = {
		questions: [
			{ id: "a", label: "Alpha", prompt: "p", options: [{ value: "x", label: "X" }] },
			{ id: "b", label: "Beta", prompt: "p", options: [{ value: "x", label: "X" }] },
			{ id: "c", prompt: "p", options: [{ value: "x", label: "X" }] },
			{ id: "d", label: "Delta", prompt: "p", options: [{ value: "x", label: "X" }] },
		],
	};

	const text = String(tool.renderCall(args, stubTheme).text);
	assert.match(text, /4 个问题/);
	assert.match(text, /Alpha, Beta, c\.\.\./);
});
