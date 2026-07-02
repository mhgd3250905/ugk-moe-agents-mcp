#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const shellPath = process.argv[2];
const agentDir = process.argv[3] || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

function fail(message) {
	console.error(message);
	process.exit(1);
}

if (!shellPath) {
	fail("Usage: node set_shell_path.mjs <path-to-bash> [agentDir]");
}

if (!fs.existsSync(shellPath)) {
	fail(`Shell path does not exist: ${shellPath}`);
}

let output = "";
try {
	output = execFileSync(shellPath, ["-lc", "echo ok"], { encoding: "utf8", timeout: 5000 });
} catch (error) {
	fail(`Shell verification failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (!output.includes("ok")) {
	fail(`Shell verification failed: expected "ok", got ${JSON.stringify(output)}`);
}

fs.mkdirSync(agentDir, { recursive: true });
const settingsPath = path.join(agentDir, "settings.json");
let settings = {};
if (fs.existsSync(settingsPath)) {
	const raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
	if (raw.trim()) {
		try {
			settings = JSON.parse(raw);
		} catch (error) {
			fail(`settings.json is not valid JSON; not overwriting: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

settings.shellPath = shellPath;
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ok: true, settingsPath, shellPath, verified: "echo ok" }, null, 2));
