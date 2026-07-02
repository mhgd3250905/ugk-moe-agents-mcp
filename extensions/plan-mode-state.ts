import type { TodoItem } from "./plan-mode-utils.ts";

export interface PlanModeState {
	planModeEnabled: boolean;
	executionMode: boolean;
	todoItems: TodoItem[];
	/**
	 * Snapshot of active tool names captured when entering plan mode.
	 * Restored on exit so dynamically registered tools (e.g. MCP tools)
	 * are not lost. Undefined before first entry or after restore.
	 */
	savedTools: string[] | undefined;
}

export interface PersistedPlanModeState {
	enabled?: boolean;
	todos?: TodoItem[];
	executing?: boolean;
}

export function createPlanModeState(): PlanModeState {
	return {
		planModeEnabled: false,
		executionMode: false,
		todoItems: [],
		savedTools: undefined,
	};
}

export function togglePlanMode(state: PlanModeState): PlanModeState {
	return {
		planModeEnabled: !state.planModeEnabled,
		executionMode: false,
		todoItems: [],
		savedTools: state.savedTools,
	};
}

export function startExecution(state: PlanModeState): PlanModeState {
	return {
		planModeEnabled: false,
		executionMode: state.todoItems.length > 0,
		todoItems: state.todoItems,
		savedTools: state.savedTools,
	};
}

export function completeExecution(state: PlanModeState): PlanModeState {
	// Keep savedTools so the caller can restore the pre-plan tool set (incl. MCP/dynamic).
	// Without this, the S1 fix is incomplete: completing an execution would fall back to
	// NORMAL_MODE_TOOLS and lose dynamically registered tools.
	return {
		planModeEnabled: false,
		executionMode: false,
		todoItems: [],
		savedTools: state.savedTools,
	};
}

export function restorePlanModeState(state: PlanModeState, persisted?: PersistedPlanModeState): PlanModeState {
	if (!persisted) return state;
	return {
		planModeEnabled: persisted.enabled ?? state.planModeEnabled,
		todoItems: persisted.todos ?? state.todoItems,
		executionMode: persisted.executing ?? state.executionMode,
		// savedTools is runtime-only (not persisted); keep whatever the live state held.
		savedTools: state.savedTools,
	};
}
