import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
	buildLanguagePromptSnippet,
	clearLanguage,
	getLanguage,
	setLanguage,
} from "../extensions/shared/language.ts";
import { resolveSettingsPath } from "../extensions/shared/settings-io.ts";

// 内存文件系统(照搬 chrome-cdp-config.test.ts 的 noPersistDeps 模式),
// 不碰真实 ~/.pi/agent/settings.json。
function memDeps(initial: Record<string, unknown> = {}) {
	const settingsPath = resolveSettingsPath({ agentDir: "/fake/agent" });
	const files = new Map<string, string>([[settingsPath, JSON.stringify(initial)]]);
	return {
		agentDir: "/fake/agent",
		exists: (p: string) => files.has(p),
		readFile: (p: string) => files.get(p) ?? "",
		writeFile: (p: string, c: string) => void files.set(p, c),
		mkdir: () => {},
		// 暴露给断言读回
		readBack: () => JSON.parse(files.get(settingsPath) ?? "{}"),
	};
}

test("getLanguage returns undefined when unset (falls back to AGENTS.md default)", () => {
	const deps = memDeps();
	assert.equal(getLanguage(deps), undefined);
});

test("setLanguage persists a free-form string and getLanguage reads it back", () => {
	const deps = memDeps();
	const set = setLanguage("English", deps);
	assert.equal(set, "English");
	assert.equal(getLanguage(deps), "English");
	assert.equal(deps.readBack().language, "English");
});

test("setLanguage preserves unrelated settings keys", () => {
	const deps = memDeps({ shellPath: "bash", cdpPort: 9333 });
	setLanguage("日本語", deps);
	const back = deps.readBack();
	assert.equal(back.shellPath, "bash");
	assert.equal(back.cdpPort, 9333);
	assert.equal(back.language, "日本語");
});

test("setLanguage with empty/whitespace clears the preference", () => {
	const deps = memDeps({ language: "English", shellPath: "bash" });
	const set = setLanguage("   ", deps);
	assert.equal(set, undefined);
	assert.equal(getLanguage(deps), undefined);
	// 清除只删 language,不动其他键
	assert.equal(deps.readBack().shellPath, "bash");
	assert.equal("language" in deps.readBack(), false);
});

test("clearLanguage removes only the language key", () => {
	const deps = memDeps({ language: "中文", shellPath: "bash" });
	clearLanguage(deps);
	assert.equal(getLanguage(deps), undefined);
	assert.equal(deps.readBack().shellPath, "bash");
});

test("clearLanguage is a no-op when language is unset", () => {
	const deps = memDeps({ shellPath: "bash" });
	clearLanguage(deps); // 不应抛错,不应动其他键
	assert.equal(deps.readBack().shellPath, "bash");
});

test("setLanguage trims surrounding whitespace before persisting", () => {
	const deps = memDeps();
	setLanguage("  English  ", deps);
	assert.equal(getLanguage(deps), "English");
});

test("getLanguage ignores non-string / blank values in settings", () => {
	const deps1 = memDeps({ language: 123 });
	assert.equal(getLanguage(deps1), undefined);
	const deps2 = memDeps({ language: "   " });
	assert.equal(getLanguage(deps2), undefined);
});

test("buildLanguagePromptSnippet returns undefined when no language set", () => {
	assert.equal(buildLanguagePromptSnippet(undefined), undefined);
	assert.equal(buildLanguagePromptSnippet(""), undefined);
	assert.equal(buildLanguagePromptSnippet("   "), undefined);
});

test("buildLanguagePromptSnippet names the language and exempts code/commands", () => {
	const snippet = buildLanguagePromptSnippet("English");
	assert.match(snippet, /English/);
	assert.match(snippet, /代码|命令|标识符|code|command/i);
});

// ponytail: self-check —— 语言偏好往返(写→读)是命令和注入的共同契约,必须稳。
test("self-check: any language written via setLanguage is readable via getLanguage", () => {
	for (const lang of ["中文", "English", "日本語", "Français", "  spaced  "]) {
		const deps = memDeps();
		const set = setLanguage(lang, deps);
		assert.equal(getLanguage(deps), set?.trim());
		assert.ok(buildLanguagePromptSnippet(set).includes(set.trim()));
	}
});
