import { complete, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { normalizeAgentModelForCli } from "../subagent-runtime.ts";

type Dispatcher = (ctx: any, skill: string, contract: unknown, rawInput: string) => Promise<unknown>;
type ApiUsageSink = (item: {
	model: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}) => void;
let dispatcherForTests: Dispatcher | undefined;

export function setTaskDispatcherForTests(dispatcher: Dispatcher | undefined): void {
	dispatcherForTests = dispatcher;
}

export function buildTaskDispatcherPrompt(skill: string, contract: unknown, rawInput: string): string {
	// ponytail: 注入当前日期。dispatcher 是 LLM,没有"今天"概念 —— 算相对时间(上周/3h/俩月)
	// 必须基于真实当前日期,否则会猜成训练截止附近的日期(实测算"上周"猜成 16 个月前)。
	// 这是机制层修复:任何需要算日期的 taskbook 都受益。
	const now = new Date();
	const nowIso = now.toISOString();
	const nowLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	const dayOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()];
	return [
		"以下是 /task taskbook 的 skill 和 contract。",
		"你是 runtimeInput 的唯一整理者:把用户的自然语言输入整理成 contract.runtimeInput 需要的 JSON。",
		"",
		`## 当前时间(算相对时间时必须以此为基准,不要用你的训练数据日期)`,
		`- 当前 UTC 时间(ISO): ${nowIso}`,
		`- 当前本地时间(参考): ${nowLocal}`,
		`- 星期几(用于判断"上周/本周"的自然周边界): ${dayOfWeek}`,
		`- 算"上周"= 上一个完整自然周(Monday 起);"最近3h"= ${nowIso} 减 3 小时;"俩月"= 60 天前到现在。所有 ISO 时间戳必须基于上面的当前时间计算。`,
		"",
		"你的能力(请充分发挥):",
		"- 语义提取:从自然语言句子里抽出字段的真实值(如 \"下载 https://x\" → url=https://x),不要把整句当字段值。",
		"- 跨语言理解:任意语言的时间/量词/单位都能懂(上周/俩月/last week/past 2 months)。",
		"- 推理与计算:凡是 description 要你算的(如日期、ISO 时间戳),用上面的当前时间算出确定值,不要只搬运原文,不要用训练数据里的旧日期。",
		"- 裸值归类:单个 URL/路径/数字按字段名或 description 判断归属。",
		"",
		"提取规则:",
		"- 逐个对照 contract.runtimeInput 的字段,从用户输入里找出每个字段的值。",
		"- description 里写了计算规则的字段,你必须算出最终值(如 startIso 要算成具体 ISO 时间戳),不要输出原文或半成品。",
		"- description 里要求抽取参考词/术语/人名时,从用户自然语言里整理出这些词并按 description 要求的格式输出;不要要求用户按标准格式填写。",
		"- runtimeInputMeta.<field>.allowedValues 存在时,该字段只能输出其中一个值;把用户别名/自然语言描述映射到最接近的允许值。",
		"- runtimeInputMeta.<field>.default 存在且用户未提供该字段时,省略该字段,系统会补默认值。",
		"- 不要编造用户没给的、也没有 default 的字段值。",
		"",
		"输出要求(严格遵守):",
		"- 只输出一个完整的 fenced JSON 对象(```json ... ```),不要解释,不要输出多个 JSON。",
		"- 每个字段值必须是完整、有效的最终值 —— 不要输出截断的、半成品的、占位的值。",
		"- 只输出 contract.runtimeInput 里声明的字段,不要输出任何其他字段(未声明字段会导致解析失败)。",
		"- 若某个 required 字段你无法从输入确定值,省略它(系统会判定为解析失败并报错,这比输出错误值好)。",
		"",
		"## skill.md",
		skill,
		"",
		"## contract.json",
		JSON.stringify(contract, null, "\t"),
		"",
		"## 用户输入",
		rawInput,
	].join("\n");
}

function parseCandidate(candidate: string): unknown | undefined {
	try {
		const value = JSON.parse(candidate);
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function extractRuntimeInputFromText(text: string): unknown | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const parsed = parseCandidate(match[1].trim());
		if (parsed) return parsed;
	}
	const trimmed = text.trim();
	const direct = parseCandidate(trimmed);
	if (direct) return direct;
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	return firstBrace >= 0 && lastBrace > firstBrace ? parseCandidate(trimmed.slice(firstBrace, lastBrace + 1)) : undefined;
}

function runtimeFields(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const value = (contract as Record<string, unknown>).runtimeInput;
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function runtimeDefaults(contract: unknown): Record<string, unknown> {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return {};
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	const defaults: Record<string, unknown> = {};
	for (const field of runtimeFields(contract)) {
		const value = (meta as Record<string, unknown>)[field];
		if (value && typeof value === "object" && !Array.isArray(value) && "default" in value) {
			defaults[field] = (value as Record<string, unknown>).default;
		}
	}
	return defaults;
}

function fieldAllowedValues(contract: unknown, field: string): string[] | undefined {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const fieldMeta = (meta as Record<string, unknown>)[field];
	if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta)) return undefined;
	const value = (fieldMeta as Record<string, unknown>).allowedValues;
	return Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")
		? value.map(String)
		: undefined;
}

function invalidAllowedFields(contract: unknown, input: unknown): string[] {
	if (!input || typeof input !== "object" || Array.isArray(input)) return [];
	return runtimeFields(contract).filter((field) => {
		if (!Object.prototype.hasOwnProperty.call(input, field)) return false;
		const allowed = fieldAllowedValues(contract, field);
		return !!allowed && !allowed.includes(String((input as Record<string, unknown>)[field]));
	});
}

function allowedFieldsValid(contract: unknown, input: unknown): boolean {
	return invalidAllowedFields(contract, input).length === 0;
}

function hasAllowedFieldValues(contract: unknown, input: unknown, fields: string[]): boolean {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	return fields.every((field) => {
		if (!Object.prototype.hasOwnProperty.call(input, field)) return false;
		const allowed = fieldAllowedValues(contract, field);
		return !allowed || allowed.includes(String((input as Record<string, unknown>)[field]));
	});
}

function objectFields(input: unknown): string[] {
	return input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input as Record<string, unknown>) : [];
}

/**
 * ponytail: 检测 dispatcher 输出里 contract 未声明的字段。
 * 场景:agent/dispatcher 传了 `maxChars=150`,但合法字段是 `maxUnitChars`。
 * 旧行为:未知字段静默流到 worker prompt 和 verify 环境,合法字段回退默认值,
 * agent 以为设了 150 实际跑 90,完全不知情 —— 框架没尽到"明显错误显式反馈"的职责。
 * 现在让 gate 硬失败,反馈里带可用字段列表,agent 看到 maxChars 报错 + 列表里有 maxUnitChars,
 * 能立刻自己改对。
 */
function unknownRuntimeFields(contract: unknown, input: unknown): string[] {
	if (!input || typeof input !== "object" || Array.isArray(input)) return [];
	const declared = new Set(runtimeFields(contract));
	return Object.keys(input as Record<string, unknown>).filter((key) => !declared.has(key));
}

/**
 * 判定 runtimeInput 字段的值是否"有效"——即 dispatcher 真的算出了有意义的东西,
 * 而不是吐了个残片/空壳。这是 dispatcher 作为"唯一参数入口"的质量底线:
 * required 字段不仅要在,还得有有效值,否则视为 dispatcher 失败(headless 抛错)。
 *
 * ponytail: 不做格式语义校验(那该由 verify 在产物层做),只判"值非空且类型合理":
 *   - string: 非空(空串/纯空白 = 无效)
 *   - number: 有限数(NaN/Infinity = 无效)
 *   - boolean: 恒有效
 *   - object/array: 非空(空对象 {}/空数组 [] = 无效)
 *   - null/undefined: 无效
 * 这样能抓住 dispatcher 输出 timeWindow:"{mode:"(合法 JSON 但值是无意义残片字符串)这类情况。
 */
function isValidRuntimeValue(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
	return false;
}

/**
 * 提取 contract 中显式声明 required:true 的 runtimeInput 字段名。
 * 保守语义:只有显式 required:true 才是门禁字段;未声明或 required:false 都不算。
 * 这保持旧 contract(无 runtimeInputMeta 或无 required 字段)的行为完全不变——
 * 不会把原本能软失败(返回部分结果)的场景变成硬失败(headless 抛错)。
 * required:true 激活了之前死字段的门禁能力,但不改变默认契约语义。
 */
function runtimeRequiredFields(contract: unknown): string[] {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return [];
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
	return fields.filter((field) => {
		const fieldMeta = (meta as Record<string, unknown>)[field];
		if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta)) return false; // 无 meta 不门禁
		return (fieldMeta as Record<string, unknown>).required === true; // 仅显式 true 才门禁
	});
}

function runtimeInputWithDefaults(contract: unknown, input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	return { ...runtimeDefaults(contract), ...input };
}

function parseScalar(value: string): string | number {
	const trimmed = value.trim();
	return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function localRuntimeInput(contract: unknown, rawInput: string): unknown | undefined {
	const direct = extractRuntimeInputFromText(rawInput);
	if (direct) return direct;
	// ponytail: 本地只接确定性结构化语法 —— field=value / field:value / JSON。
	// 这是显式语法(用户手写的结构化输入),不是对自然语言的猜测。自然语言、裸值一律
	// 交给 dispatcher(reasoningEffort=medium + 映射 prompt)。dispatcher 是唯一语义解析路径;
	// 不在本地下任何自然语言/裸值捷径 —— 那是治标不治本的老土补丁,撤掉。
	const fields = runtimeFields(contract);
	const entries: Record<string, string | number> = {};
	for (const field of fields) {
		const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = rawInput.match(new RegExp(`(?:^|[\\s,;，；])${escaped}\\s*[:=：]\\s*([^\\s,;，；]+)`, "i"));
		if (match) entries[field] = parseScalar(match[1]);
	}
	if (Object.keys(entries).length > 0) return entries;
	return undefined;
}

function inputTitle(contract: unknown, field: string): string {
	const defaults = runtimeDefaults(contract);
	return Object.hasOwn(defaults, field) ? `task input: ${field} (default: ${String(defaults[field])})` : `task input: ${field}`;
}

function inputDefault(contract: unknown, field: string): string {
	const defaults = runtimeDefaults(contract);
	return Object.hasOwn(defaults, field) ? String(defaults[field]) : field;
}

function findModel(ctx: any, modelOverride?: string): any {
	if (!modelOverride) return ctx.model;
	const normalized = normalizeAgentModelForCli(modelOverride);
	const slash = normalized?.indexOf("/") ?? -1;
	if (!normalized || slash < 0) return ctx.model;
	return ctx.modelRegistry?.find?.(normalized.slice(0, slash), normalized.slice(slash + 1)) ?? ctx.model;
}

function usageSummary(usage: Usage): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
	return {
		input: usage.input || 0,
		output: usage.output || 0,
		cacheRead: usage.cacheRead || 0,
		cacheWrite: usage.cacheWrite || 0,
		cost: usage.cost?.total || 0,
	};
}

function messageModelId(message: AssistantMessage): string {
	const model = message.model || "";
	return message.provider && model && !model.includes("/") ? `${message.provider}/${model}` : (model || message.provider || "unknown");
}

async function callDispatcher(ctx: any, skill: string, contract: unknown, rawInput: string, modelOverride?: string, onApiUsage?: ApiUsageSink): Promise<unknown | undefined> {
	if (dispatcherForTests) return await dispatcherForTests(ctx, skill, contract, rawInput);
	const model = findModel(ctx, modelOverride);
	const auth = model ? await ctx.modelRegistry?.getApiKeyAndHeaders?.(model) : undefined;
	// ponytail: dispatcher 是唯一自然语言解析路径。模型/auth 不可用是配置错误,
	// 显式抛错透传 —— 不静默退化到本地正则兜底(那会治标不治本重新长出字符串比对补丁)。
	// 这个 throw 在调用方的 .catch 之外(见 resolveRuntimeInputFromText),配置错误不会被吞。
	if (!model || !auth?.ok || !auth.apiKey) {
		throw new Error(
			"dispatcher 模型不可用,无法解析自然语言 input。请配置有效的 dispatcher model(或 contract.dispatcherModel),或改用结构化输入(field=value / JSON)。",
		);
	}
	// complete() 的运行时错误(网络/限流/超时)是临时的,catch 成 undefined 让调用方 fallback。
	let response;
	try {
		response = await complete(model, {
			messages: [{
				role: "user",
				content: [{ type: "text", text: buildTaskDispatcherPrompt(skill, contract, rawInput) }],
				timestamp: Date.now(),
			}],
		}, { apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "medium" });
	} catch {
		return undefined;
	}
	onApiUsage?.({ model: messageModelId(response), usage: usageSummary(response.usage) });
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return extractRuntimeInputFromText(text);
}

export async function resolveRuntimeInputFromText(ctx: any, skill: string, contract: unknown, rawInput: string, modelOverride?: string, headless = false, onApiUsage?: ApiUsageSink): Promise<unknown> {
	const fields = runtimeFields(contract);
	const required = runtimeRequiredFields(contract);
	// ponytail: required 门禁从"字段 key 存在"升级到"字段有有效值"。dispatcher 作为唯一参数入口,
	// 它吐出 required 字段但值是残片(如 timeWindow:"{mode:" 这种合法 JSON 但无意义字符串残片)
	// 视为解析失败,走"未能解析必填字段"分支(headless 抛错)。这把无效值的拦截点从 verify
	// (产物层)前移到 dispatcher(输入层),worker 拿不到残片就没机会现编默认值。
	const coversRequired = (input: unknown): boolean =>
		!!input && typeof input === "object" && !Array.isArray(input) &&
		required.every((field) =>
			Object.prototype.hasOwnProperty.call(input, field) &&
			isValidRuntimeValue((input as Record<string, unknown>)[field]),
		);

	// ponytail: dispatcher 部分成功时算出的有效字段值,提到外层让交互式 UI 预填复用。
	// 否则 dispatcher 算对 5 个字段、漏 1 个,落到下面的逐字段问询会全量重问,dispatcher 的
	// 成果(如算好的 ISO 时间戳)白费,用户等完 LLM 又要手填全部。预填有效值,只问漏掉的。
	let dispatcherPartial: Record<string, unknown> = {};
	if (rawInput.trim()) {
		const local = localRuntimeInput(contract, rawInput);
		const localFields = objectFields(local);
		// 不 .catch:dispatcher 配置错误(模型/auth 不可用)要透传给用户;complete() 的运行时
		// 错误已在 callDispatcher 内部 catch 成 undefined,不会到这里。
		const dispatched = await callDispatcher(ctx, skill, contract, rawInput, modelOverride, onApiUsage);
		const partial = dispatched ?? {};
		dispatcherPartial = partial as Record<string, unknown>;
		if (dispatched && coversRequired(dispatched) && allowedFieldsValid(contract, dispatched) && hasAllowedFieldValues(contract, dispatched, localFields) && unknownRuntimeFields(contract, dispatched).length === 0) return runtimeInputWithDefaults(contract, dispatched);
		if (partial && headless) {
			// ponytail: 区分"缺字段"和"字段值无效",给用户精准反馈。
			// 无效值(如 dispatcher 输出残片)和缺失一样视为解析失败 —— dispatcher 是唯一入口。
			const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(partial, field));
			const invalid = required.filter((field) =>
				Object.prototype.hasOwnProperty.call(partial, field) &&
				!isValidRuntimeValue((partial as Record<string, unknown>)[field]),
			);
			const invalidAllowed = invalidAllowedFields(contract, partial);
			const missingLocal = localFields.filter((field) => !Object.prototype.hasOwnProperty.call(partial, field));
			const unknown = unknownRuntimeFields(contract, partial);
			const detail = [
				!dispatched ? "dispatcher 无有效输出" : "",
				missing.length ? `缺失字段: ${missing.join(", ")}` : "",
				invalid.length ? `字段值无效(空值/残片): ${invalid.join(", ")}` : "",
				invalidAllowed.length ? `字段值不在允许范围: ${invalidAllowed.map((field) => `${field}=${JSON.stringify((partial as Record<string, unknown>)[field])} (allowed: ${fieldAllowedValues(contract, field)?.join("|")})`).join(", ")}` : "",
				missingLocal.length ? `dispatcher 未输出显式字段: ${missingLocal.join(", ")}` : "",
				unknown.length ? `未声明字段(不在 runtimeInput 里): ${unknown.join(", ")}(可用字段: ${fields.join(", ")})` : "",
			].filter(Boolean).join("; ");
			throw new Error(`dispatcher 未能从输入解析出有效的必填字段 —— ${detail}。请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`);
		}
	}
	if (fields.length === 0) return {};
	const defaults = runtimeDefaults(contract);
	if (headless) {
		if (fields.every((field) => Object.hasOwn(defaults, field))) return defaults;
		throw new Error(`dispatcher 未能从输入解析出 runtimeInput(字段: ${fields.join(", ")}）。请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`);
	}
	// ponytail: 交互式逐字段问询。预填优先级:dispatcher 算出的有效值 > contract 默认值。
	// 只预填"有效"值(isValidRuntimeValue),避免把 dispatcher 的残片/空值塞给用户编辑。
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const fromDispatcher = dispatcherPartial[field];
		const prefill = Object.prototype.hasOwnProperty.call(dispatcherPartial, field) && isValidRuntimeValue(fromDispatcher)
			? String(fromDispatcher)
			: inputDefault(contract, field);
		const value = await ctx.ui?.input?.(inputTitle(contract, field), prefill);
		entries.push([field, value ?? prefill]);
	}
	return Object.fromEntries(entries);
}
