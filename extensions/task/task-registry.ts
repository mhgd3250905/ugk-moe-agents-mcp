import { listTaskbooks } from "./task-book.ts";

function inputFields(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const runtimeInput = (contract as Record<string, unknown>).runtimeInput;
	return Array.isArray(runtimeInput) ? runtimeInput.filter((item) => typeof item === "string") : [];
}

function formatInputField(contract: unknown, field: string): string {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return field;
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return field;
	const fieldMeta = (meta as Record<string, unknown>)[field];
	if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta)) return field;
	const base = "default" in fieldMeta ? `${field}=${String((fieldMeta as Record<string, unknown>).default)}` : field;
	const allowed = (fieldMeta as Record<string, unknown>).allowedValues;
	return Array.isArray(allowed) && allowed.length > 0 ? `${base}{${allowed.map(String).join("|")}}` : base;
}

function formatTaskbookLine(item: Awaited<ReturnType<typeof listTaskbooks>>[number]): string {
	const fields = inputFields(item.contract);
	const input = fields.length > 0 ? ` (input: ${fields.map((field) => formatInputField(item.contract, field)).join(", ")})` : "";
	// ponytail: 展示外部 CLI 依赖,让 agent 一眼看到"这 task 要 yt-dlp/ffmpeg"——可移植性的迁移说明书。
	const binaries = binariesLine(item.contract);
	return `- ${item.name} — ${item.description}${input}${binaries}`;
}

function binariesLine(contract: unknown): string {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return "";
	const requiredBinaries = (contract as Record<string, unknown>).requiredBinaries;
	if (!Array.isArray(requiredBinaries)) return "";
	// ponytail: 过滤规则与 task.ts 的 summarize/missing 对齐(滤空白),避免空串显示成尾随逗号。
	const names = requiredBinaries.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return names.length > 0 ? ` [needs: ${names.join(", ")}]` : "";
}

export async function buildTaskbookPrompt(cwd: string): Promise<string> {
	const items = await listTaskbooks(cwd);
	if (items.length === 0) return "";
	return [
		"## 可用 task(确定性、已机器验收的固定任务)",
		"下列 task 可用 run_task 工具复用。只有当你的任务明确匹配其中某项时才调用:",
		"",
		...items.map(formatTaskbookLine),
	].join("\n");
}
