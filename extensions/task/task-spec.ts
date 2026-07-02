export interface RequirementsSpec {
	goal: string;
	hardConstraints: string[];
	acceptance: string[];
	forbidden: string[];
	context: string;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeSpec(value: unknown): RequirementsSpec | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.goal !== "string" || record.goal.trim().length === 0) return undefined;
	if (!isStringArray(record.hardConstraints) || record.hardConstraints.length === 0) return undefined;
	if (!isStringArray(record.acceptance) || record.acceptance.length === 0) return undefined;
	if (record.forbidden !== undefined && !isStringArray(record.forbidden)) return undefined;
	if (record.context !== undefined && typeof record.context !== "string") return undefined;
	return {
		goal: record.goal.trim(),
		hardConstraints: record.hardConstraints,
		acceptance: record.acceptance,
		forbidden: record.forbidden ?? [],
		context: record.context ?? "",
	};
}

function parseCandidate(candidate: string): RequirementsSpec | undefined {
	try {
		return normalizeSpec(JSON.parse(candidate));
	} catch {
		return undefined;
	}
}

export function extractRequirementsSpec(text: string): RequirementsSpec | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const spec = parseCandidate(match[1].trim());
		if (spec) return spec;
	}
	const trimmed = text.trim();
	const direct = parseCandidate(trimmed);
	if (direct) return direct;
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	return firstBrace >= 0 && lastBrace > firstBrace
		? parseCandidate(trimmed.slice(firstBrace, lastBrace + 1))
		: undefined;
}

export function formatRequirementsSpec(spec: RequirementsSpec): string {
	return JSON.stringify(spec, null, "\t");
}

export function isRequirementsSpec(value: unknown): value is RequirementsSpec {
	return normalizeSpec(value) !== undefined;
}
