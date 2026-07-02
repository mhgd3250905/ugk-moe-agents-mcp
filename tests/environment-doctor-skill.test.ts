import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../skills/ugk-environment-doctor/scripts/set_shell_path.mjs", import.meta.url));

function findRealBash(): string | undefined {
	// ponytail: 不能硬编码本机路径(原写死 E:\Application\Git\...)——在别的机器/CI 上找不到
	// 会导致两个测试恒定 SKIP,等于零覆盖。用 where/which 动态发现候选,再逐个跑 echo ok 验证。
	// 验证是必须的:Windows 上 C:\Windows\System32\bash.exe 是 WSL 入口,不是 Git Bash,会误判。
	const lister = process.platform === "win32" ? "where" : "which";
	let candidates: string[] = [];
	try {
		const out = execFileSync(lister, ["bash"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		candidates = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	} catch {
		candidates = [];
	}
	return candidates.find((candidate) => {
		try {
			const out = execFileSync(candidate, ["-c", "echo ok"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			return out.trim() === "ok";
		} catch {
			return false;
		}
	});
}

const realBash = findRealBash();

test("environment doctor shell helper verifies bash and writes shellPath", { skip: !realBash }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-env-doctor-"));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));

	const output = execFileSync(process.execPath, [scriptPath, realBash!, agentDir], { encoding: "utf8" });
	const result = JSON.parse(output);
	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));

	assert.equal(result.ok, true);
	assert.equal(result.shellPath, realBash);
	assert.equal(settings.uiLanguage, "en-US");
	assert.equal(settings.shellPath, realBash);
});

test("environment doctor shell helper refuses invalid settings JSON", { skip: !realBash }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-env-doctor-bad-json-"));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), "{bad");

	assert.throws(
		() => execFileSync(process.execPath, [scriptPath, realBash!, agentDir], { encoding: "utf8", stdio: "pipe" }),
		/settings\.json is not valid JSON/,
	);
});
