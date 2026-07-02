import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureUgkQuietStartupDefault } from "../bin/ugk-startup-settings.js";

function makeTempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-agent-settings-"));
}

test("ensureUgkQuietStartupDefault enables quiet startup when unset", () => {
	const agentDir = makeTempAgentDir();

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.quietStartup, true);
	assert.equal(settings.theme, "ugk-geek");
});

test("ensureUgkQuietStartupDefault preserves explicit quiet startup preference", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ quietStartup: false }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.quietStartup, false);
	assert.equal(settings.theme, "ugk-geek");
});

test("ensureUgkQuietStartupDefault keeps existing settings", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "custom" }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "custom");
	assert.equal(settings.quietStartup, true);
});

test("ensureUgkQuietStartupDefault disables user global skills when unset", () => {
	const agentDir = makeTempAgentDir();

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.skills, ["!skills/**"]);
});

test("ensureUgkQuietStartupDefault preserves explicit skills preference", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["skills/**"] }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.skills, ["skills/**"]);
});

test("ensureUgkQuietStartupDefault enables clear startup screen when unset", () => {
	const agentDir = makeTempAgentDir();

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.clearStartupScreen, true);
});

test("ensureUgkQuietStartupDefault preserves explicit clear startup screen preference", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ clearStartupScreen: false }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.clearStartupScreen, false);
});

test("ensureUgkQuietStartupDefault selects ugk geek theme when unset", () => {
	const agentDir = makeTempAgentDir();

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "ugk-geek");
});

test("ensureUgkQuietStartupDefault preserves explicit theme preference", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "dark");
});
