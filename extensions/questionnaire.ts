import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { uiText } from "./shared/ui-language.ts";

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	allowOther?: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

type DisplaySelection =
	| { kind: "option"; option: QuestionOption; index: number }
	| { kind: "other" };

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(Type.String({ description: "Short label for this question" })),
	prompt: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow free-form answer, default true" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(message: string) {
	return {
		content: [{ type: "text", text: message }],
		details: { answers: [], cancelled: true },
	};
}

export default function registerQuestionnaire(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description: "Ask the user one or more clarifying questions with fixed choices and optional free-form answers.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI || !ctx.ui?.select || !ctx.ui?.editor) {
				return errorResult(uiText("错误:UI 不可用(当前为非交互模式)", "Error: UI unavailable (current mode is non-interactive)"));
			}
			if (!Array.isArray(params.questions) || params.questions.length === 0) {
				return errorResult(uiText("错误:没有提供问题", "Error: no questions provided"));
			}

			const answers: Answer[] = [];
			for (const question of params.questions as Question[]) {
				const displaySelections = new Map<string, DisplaySelection>();
				const options = question.options.map((option, i) => {
					const display = `${i + 1}. ${option.label}`;
					displaySelections.set(display, { kind: "option", option, index: i + 1 });
					return display;
				});
				// 强制每题都有「填写其他答案」—— LLM 不可控,工具层兜底。
				// 即使 question.allowOther === false 也照加(用户原则:必须有这个其他回答)。
				const display = `${question.options.length + 1}. ${uiText("填写其他答案。", "Type another answer.")}`;
				displaySelections.set(display, { kind: "other" });
				options.push(display);

				const choice = await ctx.ui.select(question.prompt, options);
				if (!choice) {
					return {
						content: [{ type: "text", text: "User cancelled the questionnaire" }],
						details: { answers, cancelled: true },
					};
				}

				const selection = displaySelections.get(choice);
				if (selection?.kind === "other") {
					const written = await ctx.ui.editor(question.prompt, "");
					const label = written?.trim() || "(no response)";
					answers.push({ id: question.id, value: label, label, wasCustom: true });
					continue;
				}

				if (selection?.kind !== "option") {
					return errorResult(uiText("错误:无效的问卷选择", "Error: invalid questionnaire selection"));
				}

				const { option, index } = selection;
				answers.push({
					id: question.id,
					value: option.value,
					label: option.label,
					wasCustom: false,
					index,
				});
			}

			return {
				content: [
					{
						type: "text",
						text: answers.map(formatAnswerLine).join("\n"),
					},
				],
				details: { answers, cancelled: false },
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args?.questions) ? args.questions : [];
			const count = questions.length;
			const labels = questions
				.map((q: Question) => q.label || q.id)
				.filter(Boolean)
				.slice(0, 3)
				.join(", ");
			let text = theme.fg("toolTitle", theme.bold(`questionnaire  ${count} ${uiText("个问题", "questions")}`));
			if (labels) text += theme.fg("dim", ` (${labels}${count > 3 ? "..." : ""})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", uiText("提问中...", "asking...")), 0, 0);

			const details = result.details as { answers?: Answer[]; cancelled?: boolean } | undefined;
			const answers = details?.answers ?? [];
			const cancelled = details?.cancelled === true;

			if (cancelled) {
				let text = theme.fg("warning", uiText(`✗ 取消,已回答 ${answers.length} 个`, `✗ cancelled, ${answers.length} answered`));
				if (expanded && answers.length > 0) {
					text += "\n" + answers.map(formatAnswerLine).join("\n");
				}
				return new Text(text, 0, 0);
			}

			let text = theme.fg("success", uiText(`✓ 已回答 ${answers.length} 个问题`, `✓ answered ${answers.length} questions`));
			if (expanded && answers.length > 0) {
				text += "\n" + answers.map(formatAnswerLine).join("\n");
			}
			return new Text(text, 0, 0);
		},
	});
}

function formatAnswerLine(answer: Answer): string {
	return answer.wasCustom
		? `${answer.id}: ${uiText("用户填写", "user typed")}: ${answer.label}`
		: `${answer.id}: ${uiText("用户选择", "user selected")}: ${answer.index}. ${answer.label}`;
}
