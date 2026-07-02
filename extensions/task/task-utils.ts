const SUMMARY_KEYS = [
	"url",
	"href",
	"uri",
	"path",
	"file",
	"filePath",
	"outputPath",
	"command",
	"cmd",
	"query",
	"action",
];

const ARTIFACT_PATH_KEYS = ["path", "file", "filePath", "outputPath"];

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/(^|[|;&])\s*(sh|bash|zsh|fish|pwsh|powershell|cmd|node|python|python3|perl|ruby)\b/i,
	/\bcurl\b.*(^|\s)(-o|--output|-O|--remote-name|--upload-file|-T)(\s|=|$)/i,
	/\bcurl\b.*(^|\s)(-d|--data|--data-raw|--data-binary|-F|--form|-X|--request)(\s|=|$)/i,
];

const PLANNING_DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bunzip\b/i,
	/\btar\s+.*(-x|--extract)/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s*(install|uninstall)/i,
	/\bpip3\s*(install|uninstall)/i,
	/\buv\s+(pip\s+)?install/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bcargo\s+(install|publish)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean|restore)/i,
	/\bgit\s+branch\s+-[dD]/i,
	/\bgit\s+worktree\s+(add|remove)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bpoweroff\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bcurl\b.*(^|\s)(-o|--output|-O|--remote-name|--upload-file|-T)(\s|=|$)/i,
	/\bwget\b/i,
	/\bcurl\b.*(^|\s)(-d|--data|--data-raw|--data-binary|-F|--form|-X|--request)(\s|=|$)/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function truncate(value: string, maxLength = 240): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function stringifyCompact(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function summarizeRecord(record: Record<string, unknown>, keys: string[]): string {
	const parts: string[] = [];
	for (const key of keys) {
		const value = record[key];
		if (value === undefined || value === null || value === "") continue;
		parts.push(`${key}=${truncate(stringifyCompact(value), 160)}`);
	}
	return parts.join("; ");
}

export function summarizeToolArgs(input: unknown): string {
	const record = getRecord(input);
	if (record) {
		const focused = summarizeRecord(record, SUMMARY_KEYS);
		if (focused) return focused;
	}
	return truncate(stringifyCompact(input));
}

export function extractArtifactsFromToolInput(toolName: string, input: unknown): Array<{ path: string; kind: string }> {
	if (!/^(write|edit|bash)$/i.test(toolName)) return [];
	const record = getRecord(input);
	if (!record) return [];
	const artifacts: Array<{ path: string; kind: string }> = [];
	for (const key of ARTIFACT_PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			artifacts.push({ path: value.trim(), kind: "file" });
		}
	}
	return artifacts;
}

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
	return !isDestructive && isSafe;
}

export function isPlanningAllowedCommand(command: string): boolean {
	return !PLANNING_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}
