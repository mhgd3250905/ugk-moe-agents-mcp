#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crashPattern = /uncaughtException|UnhandledPromiseRejection|This extension ctx is stale|TypeError|ReferenceError/i;

export function hasCrashText(text) {
	return crashPattern.test(text);
}

export function parseDriver(args = process.argv.slice(2)) {
	const driverArg = args.find((arg, index) => arg.startsWith("--driver=") || args[index - 1] === "--driver");
	const driver = driverArg?.startsWith("--driver=") ? driverArg.slice("--driver=".length) : driverArg;
	if (!driver) return "auto";
	if (["auto", "rpc"].includes(driver)) return driver;
	throw new Error(`Unsupported smoke driver: ${driver}`);
}

export function chooseDriver(driver, _options = {}) {
	if (driver === "auto") return "rpc";
	return driver;
}

export function buildReport(scenarios, run) {
	const failed = scenarios.filter((scenario) => !scenario.ok).length;
	return [
		"# UGK RPC Smoke Report",
		"",
		`Driver: ${run.driver ?? "unknown"}`,
		`Exit code: ${run.exitCode ?? "none"}`,
		`Timed out: ${run.timedOut ? "yes" : "no"}`,
		`Crash text: ${hasCrashText(run.stderr ?? "") ? "detected" : "none"}`,
		"",
		"## Scenarios",
		...scenarios.map((scenario) => `- ${scenario.ok ? "✅" : "❌"} ${scenario.name}${scenario.detail ? ` — ${scenario.detail}` : ""}`),
		"",
		failed === 0 && !run.timedOut && !hasCrashText(run.stderr ?? "") ? "Result: pass" : "Result: fail",
		"",
	].join("\n");
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function prepareDirs() {
	const runDir = path.join(root, ".tmp", "smoke", stamp());
	const latestDir = path.join(root, ".tmp", "smoke", "latest");
	await fs.mkdir(runDir, { recursive: true });
	return { runDir, latestDir };
}

async function writeEvent(stream, event) {
	stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
}

function endStream(stream) {
	return new Promise((resolve) => stream.end(resolve));
}

function smokeEnv(runDir) {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: path.join(runDir, "agent"),
		UGK_SKIP_UPDATE_CHECK: "1",
		UGK_SKIP_WORKSPACE_TRUST: "1",
		UGK_CLEAR_STARTUP: "0",
	};
}

function startRpc(runDir) {
	return spawn(process.execPath, ["bin/ugk.js", "--mode", "rpc", "--no-session", "--model", "deepseek/deepseek-v4-pro"], {
		cwd: root,
		env: smokeEnv(runDir),
		stdio: ["pipe", "pipe", "pipe"],
	});
}

async function runRpcSmoke(runDir) {
	const events = createWriteStream(path.join(runDir, "events.jsonl"), { flags: "a" });
	const stdout = createWriteStream(path.join(runDir, "stdout.log"), { flags: "a" });
	const stderr = createWriteStream(path.join(runDir, "stderr.log"), { flags: "a" });
	const child = startRpc(runDir);
	const responses = new Map();
	const scenarios = [];
	let stdoutBuffer = "";
	let stderrText = "";
	let exitCode;
	let timedOut = false;

	child.stdout.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		stdout.write(text);
		stdoutBuffer += text;
		let index;
		while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
			const line = stdoutBuffer.slice(0, index).trim();
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			if (!line) continue;
			try {
				const message = JSON.parse(line);
				writeEvent(events, { type: "output", message });
				if (message.type === "response" && message.id) responses.set(message.id, message);
				if (message.type === "extension_ui_request") respondToUi(child, message);
			} catch {
				writeEvent(events, { type: "output_text", line });
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		stderrText += text;
		stderr.write(text);
	});

	const exited = new Promise((resolve) => {
		child.on("exit", (code) => {
			exitCode = code;
			resolve();
		});
	});

	async function command(name, payload, timeoutMs = 8000) {
		const id = name.replace(/[^a-z0-9-]/gi, "-");
		const message = { id, ...payload };
		writeEvent(events, { type: "input", message });
		child.stdin.write(`${JSON.stringify(message)}\n`);
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (responses.has(id)) {
				const response = responses.get(id);
				return { name, ok: response.success === true, detail: response.success ? undefined : response.error };
			}
			if (exitCode !== undefined) return { name, ok: false, detail: `process exited ${exitCode}` };
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { name, ok: false, detail: "timeout" };
	}

	const killTimer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 45000);

	scenarios.push(await command("startup", { type: "get_commands" }));
	scenarios.push(await command("brand-ui-status", { type: "prompt", message: "/ugk-ui status" }));
	scenarios.push(await command("brand-ui-off", { type: "prompt", message: "/ugk-ui off" }));
	scenarios.push(await command("brand-ui-on", { type: "prompt", message: "/ugk-ui on" }));
	scenarios.push(await command("doctor", { type: "prompt", message: "/doctor" }));

	child.stdin.end();
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
	if (exitCode === undefined) {
		timedOut = true;
		child.kill();
		await exited;
	}
	clearTimeout(killTimer);
	scenarios.push({ name: "shutdown", ok: exitCode === 0, detail: exitCode === 0 ? undefined : `exit ${exitCode}` });
	await Promise.all([endStream(events), endStream(stdout), endStream(stderr)]);
	return { driver: "rpc", scenarios, exitCode, timedOut, stderr: stderrText };
}

function respondToUi(child, request) {
	if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)) return;
	const response = { type: "extension_ui_response", id: request.id, cancelled: true };
	if (request.method === "confirm") response.confirmed = false;
	child.stdin.write(`${JSON.stringify(response)}\n`);
}

async function main() {
	const { runDir, latestDir } = await prepareDirs();
	const requestedDriver = parseDriver();
	chooseDriver(requestedDriver);
	const run = await runRpcSmoke(runDir);
	const report = buildReport(run.scenarios, run);
	await fs.writeFile(path.join(runDir, "report.md"), report);
	await fs.rm(latestDir, { recursive: true, force: true });
	await fs.cp(runDir, latestDir, { recursive: true });
	process.stdout.write(`Smoke report: ${path.join(latestDir, "report.md")}\n`);
	process.exitCode = report.includes("Result: pass") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
