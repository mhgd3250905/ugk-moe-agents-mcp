import type { RequirementsSpec } from "./task-spec.ts";

export type TaskPhase = "planning" | "executing" | "reviewing" | "landed" | "aborted" | "done";
export type TaskPendingTransition = "execute" | "review" | "save" | "repair";

export interface TaskReviewResult {
	description: string;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
}

export interface ExecuteProcessEntry {
	kind: "tool_call" | "artifact";
	toolName?: string;
	argsSummary?: string;
	artifactPath?: string;
	timestamp: string;
}

// ponytail: 持久化的"上次 run 复盘上下文",镜像内存里的 lastTaskRunReview。
// 存 content 而非 runDir 再重建——report 是给 reviewer 的文本,存它重进直接用,
// 比从 runDir 反查产物+重建 report 简单得多(后者要 loaded taskbook + formatRunResult)。
export interface LastRunReview {
	taskbookName: string;
	content: string;
}

export interface TaskState {
	phase: TaskPhase;
	spec: RequirementsSpec | null;
	taskbookName?: string;
	taskbookScope?: "user" | "project";
	summary: string;
	retryCount: number;
	maxRetry: number;
	planQuestionnaireUsed: boolean;
	reviewQuestionnaireUsed: boolean;
	executeRunDir?: string;
	executeProcessLog: ExecuteProcessEntry[];
	reviewResult?: TaskReviewResult;
	pendingTransition?: TaskPendingTransition;
	lastRunReview?: LastRunReview;
}

export function createTaskState(): TaskState {
	return {
		phase: "aborted",
		spec: null,
		taskbookScope: undefined,
		summary: "",
		retryCount: 0,
		maxRetry: 3,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
		executeProcessLog: [],
		pendingTransition: undefined,
	};
}

export function enterPlanning(state: TaskState): TaskState {
	return {
		...state,
		phase: "planning",
		spec: null,
		taskbookName: undefined,
		taskbookScope: undefined,
		summary: "",
		retryCount: 0,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
		executeProcessLog: [],
		reviewResult: undefined,
		pendingTransition: undefined,
		lastRunReview: undefined,
	};
}

export function setTaskSpec(state: TaskState, spec: RequirementsSpec): TaskState {
	return { ...state, spec };
}

export function setPendingTransition(state: TaskState, pendingTransition: TaskPendingTransition | undefined): TaskState {
	return { ...state, pendingTransition };
}

export function setTaskbookName(state: TaskState, taskbookName: string | undefined): TaskState {
	return { ...state, taskbookName };
}

export function markPlanQuestionnaireUsed(state: TaskState): TaskState {
	if (state.phase !== "planning" || state.planQuestionnaireUsed) return state;
	return { ...state, planQuestionnaireUsed: true };
}

export function startExecuting(state: TaskState, executeRunDir?: string): TaskState {
	if (!state.planQuestionnaireUsed) throw new Error("Task planning questionnaire was not used");
	return {
		...state,
		phase: "executing",
		retryCount: 0,
		reviewQuestionnaireUsed: false,
		executeRunDir,
		executeProcessLog: [],
		pendingTransition: undefined,
	};
}

export function recordExecuteProcessEntry(state: TaskState, entry: ExecuteProcessEntry): TaskState {
	if (state.phase !== "executing") return state;
	return { ...state, executeProcessLog: [...state.executeProcessLog, entry] };
}

export function enterReviewing(state: TaskState, summary: string): TaskState {
	return {
		...state,
		phase: "reviewing",
		summary,
		reviewQuestionnaireUsed: false,
		reviewResult: undefined,
		pendingTransition: undefined,
	};
}

export function markReviewQuestionnaireUsed(state: TaskState): TaskState {
	if (state.phase !== "reviewing" || state.reviewQuestionnaireUsed) return state;
	return { ...state, reviewQuestionnaireUsed: true };
}

export function setTaskReviewResult(state: TaskState, reviewResult: TaskReviewResult): TaskState {
	return { ...state, reviewResult };
}

export function landTask(state: TaskState): TaskState {
	return { ...state, phase: "landed", pendingTransition: undefined };
}

export function abortTask(state: TaskState): TaskState {
	return {
		...state,
		phase: "aborted",
		retryCount: 0,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
		taskbookName: undefined,
		taskbookScope: undefined,
		executeProcessLog: [],
		pendingTransition: undefined,
	};
}

export function completeTask(state: TaskState): TaskState {
	return {
		...state,
		phase: "done",
		retryCount: 0,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
		taskbookName: undefined,
		taskbookScope: undefined,
		executeProcessLog: [],
		pendingTransition: undefined,
	};
}
