const DEVELOPMENT_RULE_PATTERNS = [
	["pi runtime patch", /pi runtime patch/i],
	["npm test", /\bnpm test\b/],
	["git diff --check", /\bgit diff --check\b/],
	["node_modules", /\bnode_modules\//],
	["BOM-safe", /\bBOM-safe\b/i],
];

export function findRuntimeScopeViolations(content) {
	return DEVELOPMENT_RULE_PATTERNS
		.filter(([, pattern]) => pattern.test(content))
		.map(([label]) => label);
}
