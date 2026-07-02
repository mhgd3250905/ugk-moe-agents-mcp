/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	completeExecution,
	createPlanModeState,
	restorePlanModeState,
	startExecution,
	togglePlanMode as togglePlanModeState,
} from "./plan-mode-state.ts";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./plan-mode-utils.ts";
import { uiText } from "./shared/ui-language.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
// Fallback when no snapshot is available (e.g. getActiveTools unavailable).
// Prefer restoring the captured snapshot so dynamically registered tools survive.
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

function getActiveToolsSafely(pi: ExtensionAPI): string[] | undefined {
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : undefined;
}

/**
 * Restore the saved snapshot, or fall back to NORMAL_MODE_TOOLS if none captured.
 * @param clearSnapshot when false (e.g. entering execution), keep savedTools so a later
 *   completeExecution can restore again. Defaults to true (final exit/cleanup).
 */
function restoreActiveTools(
	pi: ExtensionAPI,
	state: { savedTools: string[] | undefined },
	clearSnapshot = true,
): void {
	pi.setActiveTools(state.savedTools ?? NORMAL_MODE_TOOLS);
	if (clearSnapshot) {
		state.savedTools = undefined;
	}
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let state = createPlanModeState();

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (state.executionMode && state.todoItems.length > 0) {
			const completed = state.todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${state.todoItems.length}`));
		} else if (state.planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (state.executionMode && state.todoItems.length > 0) {
			const lines = state.todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		const wasEnabled = state.planModeEnabled;
		state = togglePlanModeState(state);

		if (state.planModeEnabled) {
			// Capture current active tools so we can restore them (incl. MCP/dynamic) on exit.
			state.savedTools = getActiveToolsSafely(pi);
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(uiText(`Plan mode 已开启。可用工具: ${PLAN_MODE_TOOLS.join(", ")}`, `Plan mode enabled. Available tools: ${PLAN_MODE_TOOLS.join(", ")}`));
		} else {
			// Only restore if we were previously enabled (avoid clobbering on double-toggle edge cases).
			if (wasEnabled) {
				restoreActiveTools(pi, state);
			}
			ctx.ui.notify(uiText("Plan mode 已关闭。完整工具访问已恢复。", "Plan mode disabled. Full tool access restored."));
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: state.planModeEnabled,
			todos: state.todoItems,
			executing: state.executionMode,
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (state.todoItems.length === 0) {
				ctx.ui.notify(uiText("暂无 todo。请先用 /plan 创建计划。", "No todos yet. Use /plan to create a plan first."), "info");
				return;
			}
			const list = state.todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(uiText(`计划进度:\n${list}`, `Plan progress:\n${list}`), "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!state.planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: uiText(
					`Plan mode:命令已拦截(不在只读白名单内)。请先用 /plan 关闭 plan mode。\n命令: ${command}`,
					`Plan mode: command blocked (not in the read-only allowlist). Run /plan first to leave plan mode.\nCommand: ${command}`,
				),
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (state.planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (state.planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (state.executionMode && state.todoItems.length > 0) {
			const remaining = state.todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!state.executionMode || state.todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, state.todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (state.executionMode && state.todoItems.length > 0) {
			if (state.todoItems.every((t) => t.completed)) {
				const completedList = state.todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: uiText(`**计划已完成!** ✓\n\n${completedList}`, `**Plan complete!** ✓\n\n${completedList}`), display: true },
					{ triggerTurn: false },
				);
				state = completeExecution(state);
				restoreActiveTools(pi, state);
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!state.planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				state = { ...state, todoItems: extracted };
			}
		}

		// Show plan steps and prompt for next action
		if (state.todoItems.length > 0) {
			const todoListText = state.todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: uiText(`**计划步骤(${state.todoItems.length}):**\n\n${todoListText}`, `**Plan steps (${state.todoItems.length}):**\n\n${todoListText}`),
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const options = uiText(
			[state.todoItems.length > 0 ? "执行计划(跟踪进度)" : "执行计划", "留在 plan mode", "细化计划"],
			[state.todoItems.length > 0 ? "Execute plan (track progress)" : "Execute plan", "Stay in plan mode", "Refine plan"],
		);
		const choice = await ctx.ui.select(uiText("Plan mode - 下一步?", "Plan mode - next step?"), options);

		if (choice === options[0] || choice?.startsWith("执行计划")) {
			state = startExecution(state);
			// Restore tools for execution but keep the snapshot so completeExecution can restore again.
			restoreActiveTools(pi, state, false);
			updateStatus(ctx);

			const execMessage =
				state.todoItems.length > 0
					? uiText(`执行计划。先做: ${state.todoItems[0].text}`, `Execute the plan. Start with: ${state.todoItems[0].text}`)
					: uiText("执行刚才创建的计划。", "Execute the plan just created.");
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === options[2] || choice === "细化计划") {
			const refinement = await ctx.ui.editor(uiText("细化计划:", "Refine plan:"), "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			state = { ...state, planModeEnabled: true };
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

		state = restorePlanModeState(state, planModeEntry?.data);

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && state.executionMode && state.todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, state.todoItems);
		}

		if (state.planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
