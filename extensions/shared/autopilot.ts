/**
 * 统一 autopilot 内核 —— 所有工具级确认的总开关。
 *
 * 设计:全局单例 + 每个工具的 policy 函数在判定 requiresConfirmation 前先问它。
 * - autopilot on 时,普通工具确认一律短路为"直接放行"(requiresConfirmation=false)。
 * - destructive 工具(危险命令门 rm -rf 等)不接进来,永远走人确认 —— 这是用户硬要求。
 * - 状态只在会话内存,不落盘:关掉 ugk 就忘,符合"临时放飞"定位。
 *
 * 新工具想受 autopilot 管,在自家 policy 函数末尾加一行:
 *   if (requiresConfirmation && isAutopilotOn()) requiresConfirmation = false;
 * 一行接入,无需改本文件。
 *
 * 治不了 LLM 自发的 questionnaire 打断(③类) —— 那个靠 before_agent_start 注入 prompt,
 * 见 extensions/index.ts 的 /ugk-autopilot 命令。
 */

export interface AutopilotState {
	enabled: boolean;
}

let singleton: AutopilotState = { enabled: false };

export function createAutopilotState(initial = false): AutopilotState {
	return { enabled: initial };
}

/** 用自定义 state 替换默认单例(测试隔离用)。 */
export function installAutopilotState(state: AutopilotState): AutopilotState {
	singleton = state;
	return state;
}

export function isAutopilotOn(state: AutopilotState = singleton): boolean {
	return state.enabled;
}

export function setAutopilot(enabled: boolean, state: AutopilotState = singleton): void {
	state.enabled = enabled;
}

/**
 * autopilot on 时把"需要确认"压成"直接放行"。
 * destructive 动作不调本函数(它们根本不接 autopilot),所以这里无需区分等级。
 */
export function suppressConfirmation(requiresConfirmation: boolean, state: AutopilotState = singleton): boolean {
	return requiresConfirmation && !state.enabled;
}

/**
 * autopilot 开启时注入给 agent 的指令,治理 LLM 自发的范围类问卷(③类)。
 * 放在 before_agent_start / system prompt 里。
 */
export const AUTOPILOT_PROMPT_SNIPPET = [
	"[autopilot 已开启]",
	"对\"下几个 / 选哪个 / 要不要继续 / 范围多大\"这类可逆的范围决策,直接按最全/最激进的方案执行,不要发 questionnaire 打断用户。",
	"仅当涉及删除、消费、花钱、不可逆外部副作用时才升级问人。",
].join("\n");
