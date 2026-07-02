import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const skillCreatorPath = new URL("../skills/skill-creator/SKILL.md", import.meta.url);
const skillCreatorLicensePath = new URL("../skills/skill-creator/LICENSE.txt", import.meta.url);
const mcpGuidePath = new URL("../skills/mcp-guide/SKILL.md", import.meta.url);
const mcpConfigureScriptPath = new URL("../skills/mcp-guide/scripts/configure_mcp.py", import.meta.url);
const bashGuidePath = new URL("../skills/bash-guide/SKILL.md", import.meta.url);
const chromeCdpGuidePath = new URL("../skills/chrome-cdp-guide/SKILL.md", import.meta.url);
const environmentDoctorPath = new URL("../skills/ugk-environment-doctor/SKILL.md", import.meta.url);
const taskInstallGuidePath = new URL("../skills/task-install-guide/SKILL.md", import.meta.url);
const environmentDoctorRefs = [
	"windows-shell.md",
	"chrome-cdp.md",
	"mcp.md",
	"node-npm.md",
	"api-models.md",
].map((name) => new URL(`../skills/ugk-environment-doctor/references/${name}`, import.meta.url));
const environmentDoctorShellScript = new URL("../skills/ugk-environment-doctor/scripts/set_shell_path.mjs", import.meta.url);

test("bundles Anthropic skill creator as a preinstalled skill", () => {
	const skill = fs.readFileSync(skillCreatorPath, "utf8");
	const license = fs.readFileSync(skillCreatorLicensePath, "utf8");

	assert.match(skill, /^---\s*\nname: skill-creator/m);
	assert.match(skill, /description: Create new skills, modify and improve existing skills/);
	assert.match(license, /Apache License\s+Version 2\.0/);
});

test("bundles MCP guide as a preinstalled skill", () => {
	const skill = fs.readFileSync(mcpGuidePath, "utf8");

	assert.match(skill, /^---\s*\nname: mcp-guide/m);
	assert.match(skill, /description: Use when the user wants to configure or manage MCP servers in UGK/);
	assert.match(skill, /pastes.*mcpServers JSON/i);
	assert.match(skill, /install scope/);
	assert.match(skill, /npm link/);
	assert.match(skill, /\/mcp status/);
	assert.equal(fs.existsSync(mcpConfigureScriptPath), true);
});

test("bundles Bash guide as a preinstalled skill", () => {
	const skill = fs.readFileSync(bashGuidePath, "utf8");

	assert.match(skill, /^---\s*\nname: bash-guide/m);
	assert.match(skill, /settings\.json.*shellPath/i);
	assert.match(skill, /ugk-environment-doctor/);
	assert.match(skill, /subagent/i);
	assert.match(skill, /不要.*反复.*which bash|avoid repeated .*which bash/i);
});

test("bundles guided environment doctor skill", () => {
	const skill = fs.readFileSync(environmentDoctorPath, "utf8");
	const shellRef = fs.readFileSync(environmentDoctorRefs[0], "utf8");
	const cdpRef = fs.readFileSync(environmentDoctorRefs[1], "utf8");
	const mcpRef = fs.readFileSync(environmentDoctorRefs[2], "utf8");
	const nodeRef = fs.readFileSync(environmentDoctorRefs[3], "utf8");
	const apiRef = fs.readFileSync(environmentDoctorRefs[4], "utf8");
	const { frontmatter } = parseFrontmatter(skill);

	assert.equal(frontmatter.name, "ugk-environment-doctor");
	assert.match(frontmatter.description as string, /environment setup and troubleshooting/i);
	assert.match(frontmatter.description as string, /doctor|bash unavailable|Chrome CDP|MCP|Node\/npm|API\/model/i);
	assert.match(skill, /one failing area at a time/i);
	assert.match(skill, /API and model switching are guidance, not required health checks/i);
	assert.match(skill, /If the user provides a `bash\.exe` path/);
	assert.match(skill, /When the user provides a path, port, JSON config, environment variable name, or other concrete setting/);
	assert.match(skill, /verify it and apply the UGK-side config yourself/);
	assert.match(skill, /set_shell_path\.mjs/);
	assert.match(shellRef, /set_shell_path\.mjs/);
	assert.match(shellRef, /do not ask the user to edit JSON/i);
	assert.match(shellRef, /Never tell a beginner user to manually edit `settings\.json`/i);
	assert.match(cdpRef, /\/cdp port <port>/);
	assert.match(cdpRef, /Do not ask the user to edit settings manually/i);
	assert.match(mcpRef, /configure_mcp\.py/);
	assert.match(mcpRef, /instead of asking the user to paste JSON into a config file manually/i);
	assert.match(nodeRef, /Do not ask for manual PATH changes until the binaries have been verified/i);
	assert.match(apiRef, /Apply supported UGK-side config yourself/i);
	assert.equal(fs.existsSync(environmentDoctorShellScript), true);
	for (const ref of environmentDoctorRefs) {
		assert.equal(fs.existsSync(ref), true);
	}
});

test("bundles Chrome CDP guide with broad tool-first trigger guidance", () => {
	const skill = fs.readFileSync(chromeCdpGuidePath, "utf8");

	// Run-time frontmatter parse (same parser pi uses to load the skill).
	// Guards against a bare colon in `description` breaking YAML at load time.
	const { frontmatter } = parseFrontmatter(skill);
	assert.equal(frontmatter.name, "chrome-cdp-guide");
	assert.equal(typeof frontmatter.description, "string");
	assert.ok((frontmatter.description as string).length > 0);
	assert.ok((frontmatter.description as string).length < 1024);

	assert.match(skill, /MUST use for almost every CDP-related request/);
	assert.match(skill, /If the request mentions CDP, load this skill before taking action/);
	assert.match(skill, /Prefer the chrome_cdp tool/);
	assert.match(skill, /do not control CDP through bash\/curl\/node scripts/i);
	assert.match(skill, /action=launch/);
	assert.match(skill, /Start with `chrome_cdp` `action=status`/);
});

test("bundles task install guide for pasted install commands", () => {
	const skill = fs.readFileSync(taskInstallGuidePath, "utf8");
	const { frontmatter } = parseFrontmatter(skill);

	assert.equal(frontmatter.name, "task-install-guide");
	assert.match(frontmatter.description as string, /ugk task install NAME/);
	assert.match(frontmatter.description as string, /pastes|Chinese/i);
	assert.match(skill, /Run `ugk task install <name>`/);
	assert.match(skill, /Do not manually download/);
});

test("npm package excludes local MCP config files", () => {
	const npmIgnore = fs.readFileSync(new URL("../.npmignore", import.meta.url), "utf8");

	assert.match(npmIgnore, /^mcp\.json$/m);
	assert.match(npmIgnore, /^\.mcp\.local\.json$/m);
});

test("MCP guide configure script merges pasted mcpServers JSON into install config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-guide-"));
	const input = path.join(cwd, "input.json");
	fs.writeFileSync(
		input,
		JSON.stringify({
			mcpServers: {
				"funasr-transcriber": {
					command: "python",
					args: ["E:/AII/MCP-LOCAL/funasr-transcriber/server.py"],
				},
			},
		}),
	);

	const output = execFileSync(
		"python",
		[
			fileURLToPath(mcpConfigureScriptPath),
			"--scope",
			"install",
			"--package-root",
			cwd,
			"--cwd",
			cwd,
			"--input",
			input,
		],
		{ encoding: "utf8" },
	);
	const summary = JSON.parse(output);
	const configPath = path.join(cwd, "mcp.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

	assert.equal(summary.scope, "install");
	assert.equal(summary.server_count, 1);
	assert.equal(summary.config_path, configPath);
	assert.deepEqual(config.mcpServers["funasr-transcriber"], {
		command: "python",
		args: ["E:/AII/MCP-LOCAL/funasr-transcriber/server.py"],
	});
});
