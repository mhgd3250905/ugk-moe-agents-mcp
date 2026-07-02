import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkillPaths } from "../extensions/index.ts";

/**
 * scanSkillPaths 是 resources_discover 加载 skills/ 和 user-skills/ 的共用扫描器。
 * 这组测试验证它对两类目录都能正确发现 SKILL.md,并容错缺失目录。
 */
function makeTempSkillsRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-skill-paths-"));
}

test("scanSkillPaths finds SKILL.md in each subdirectory of a skills root", () => {
	const root = makeTempSkillsRoot();
	fs.mkdirSync(path.join(root, "foo"));
	fs.writeFileSync(path.join(root, "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
	fs.mkdirSync(path.join(root, "bar"));
	fs.writeFileSync(path.join(root, "bar", "SKILL.md"), "---\nname: bar\n---\n# Bar\n");

	const result = scanSkillPaths(root).sort();

	assert.equal(result.length, 2);
	assert.ok(result.some((p) => p.endsWith(path.join("foo", "SKILL.md"))));
	assert.ok(result.some((p) => p.endsWith(path.join("bar", "SKILL.md"))));
});

test("scanSkillPaths skips subdirectories without SKILL.md", () => {
	const root = makeTempSkillsRoot();
	fs.mkdirSync(path.join(root, "has-skill"));
	fs.writeFileSync(path.join(root, "has-skill", "SKILL.md"), "# yes");
	fs.mkdirSync(path.join(root, "no-skill"));
	fs.writeFileSync(path.join(root, "no-skill", "README.md"), "# nope");
	// 顶层散文件也不该被当成 skill
	fs.writeFileSync(path.join(root, "loose.md"), "# loose");

	const result = scanSkillPaths(root);

	assert.equal(result.length, 1);
	assert.ok(result[0].endsWith(path.join("has-skill", "SKILL.md")));
});

test("scanSkillPaths returns [] for a missing directory (no throw)", () => {
	const result = scanSkillPaths(path.join(os.tmpdir(), "ugk-does-not-exist-" + Date.now()));
	assert.deepEqual(result, []);
});

test("scanSkillPaths works identically for a user-skills directory layout", () => {
	// 模拟 user-skills/ 下的打平安装:每个 skill 一个顶层目录,带 bundled scripts
	const root = makeTempSkillsRoot();
	fs.mkdirSync(path.join(root, "bili-spider", "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, "bili-spider", "SKILL.md"), "---\nname: bili-spider\n---\n# Bili\n");
	fs.writeFileSync(path.join(root, "bili-spider", "scripts", "fetch.py"), "# script");
	fs.mkdirSync(path.join(root, "tts-concat"));
	fs.writeFileSync(path.join(root, "tts-concat", "SKILL.md"), "---\nname: tts-concat\n---\n# TTS\n");

	const result = scanSkillPaths(root).map((p) => path.basename(path.dirname(p))).sort();

	assert.deepEqual(result, ["bili-spider", "tts-concat"]);
});
