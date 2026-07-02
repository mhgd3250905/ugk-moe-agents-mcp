#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskbookName = "smoke_name_count";
const rawTaskInput = "读取 workspace package.json 的 name 字段,写入 name.json";

export function hasTaskPass(events) {
	return events.some((event) => {
		const text = event?.msg?.message?.content ?? event?.msg?.message ?? event?.msg?.line ?? "";
		return /taskbook "smoke_name_count" PASS/.test(text) || /taskbook "smoke_name_count" PASS/.test(String(text));
	});
}

export function hasTaskFail(events) {
	return events.some((event) => {
		const text = event?.msg?.message?.content ?? event?.msg?.message ?? event?.msg?.line ?? "";
		return /taskbook "smoke_name_count" FAIL/.test(String(text));
	});
}

export function hasTaskLanded(events) {
	return events.some((event) => {
		const text = event?.msg?.message?.content ?? event?.msg?.message ?? event?.msg?.line ?? "";
		return /taskbook "smoke_name_count" 已就绪/.test(String(text));
	});
}

export function hasTaskInputFallback(events) {
	return events.some((event) =>
		event?.msg?.type === "extension_ui_request" &&
		event?.msg?.method === "input" &&
		/^task input: /.test(String(event.msg.title ?? "")));
}

export function hasActiveJudgeUiPollution(events) {
	return events.some((event) => {
		const msg = event?.msg;
		if (msg?.type !== "extension_ui_request") return false;
		return msg.method === "setStatus" && msg.statusKey === "judge-mode" && typeof msg.statusText === "string" && msg.statusText.length > 0;
	});
}

export function getWidgetTimeline(events, widgetKey = "task-run-view") {
	return events
		.filter((event) => event?.msg?.type === "extension_ui_request" && event.msg.method === "setWidget" && event.msg.widgetKey === widgetKey)
		.map((event) => Array.isArray(event.msg.widgetLines) ? event.msg.widgetLines.map(String).join(" / ") : "(cleared)");
}

export function buildTaskReport(run) {
	const taskbookPass = run.taskbookRuns?.some((entry) => entry.status === "pass") ?? false;
	const taskbookFail = run.taskbookRuns?.some((entry) => entry.status === "fail") ?? false;
	const passed = !run.timedOut && run.exitCode === 0 && !run.stderr && hasTaskPass(run.events ?? []) && taskbookPass;
	const widgetTimeline = getWidgetTimeline(run.events ?? []);
	return [
		"# UGK Task Smoke Report",
		"",
		`Exit code: ${run.exitCode ?? "none"}`,
		`Timed out: ${run.timedOut ? "yes" : "no"}`,
		`Stderr: ${run.stderr ? "present" : "empty"}`,
		"Phase reached: reuse-run",
		`Taskbook landed: ${hasTaskLanded(run.events ?? []) ? "yes" : "no"}`,
		`Task PASS: ${hasTaskPass(run.events ?? []) ? "detected" : "missing"}`,
		`Taskbook run: ${taskbookPass ? "pass" : taskbookFail ? "fail" : "missing"}`,
		`Duration: ${Math.round((run.durationMs ?? 0) / 1000)}s`,
		"",
		passed ? "Result: pass" : "Result: fail",
		"",
		"## 场景 B 验证",
		"- taskbook load: ok",
		`- dispatcher fallback input: ${hasTaskInputFallback(run.events ?? []) ? "present" : "absent"}`,
		"- worker: see rpc-events.jsonl",
		"- verify: name.json 存在且 name 等于 smoke-pkg",
		`- PASS notify: ${hasTaskPass(run.events ?? []) ? "detected" : "missing"}`,
		`- active Judge UI pollution: ${hasActiveJudgeUiPollution(run.events ?? []) ? "present" : "absent"}`,
		"",
		"## Widget 时间线",
		...(widgetTimeline.length > 0 ? widgetTimeline.map((line) => `- ${line}`) : ["- missing"]),
		"",
	].join("\n");
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function prepareDirs() {
	const runDir = path.join(root, ".tmp", "smoke-task", stamp());
	const latestDir = path.join(root, ".tmp", "smoke-task", "latest");
	const workspace = path.join(runDir, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	return { runDir, latestDir, workspace };
}

async function writeJson(file, value) {
	await fs.writeFile(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function prepareWorkspace(runDir, workspace) {
	await writeJson(path.join(workspace, "package.json"), { name: "smoke-pkg", version: "0.0.1" });
	const taskbookDir = path.join(workspace, ".tasks", taskbookName);
	await fs.mkdir(taskbookDir, { recursive: true });
	const now = new Date().toISOString();
	await writeJson(path.join(taskbookDir, "taskbook.json"), {
		name: taskbookName,
		description: "Smoke: read package.json name into name.json",
		scope: "project",
		createdAt: now,
		updatedAt: now,
		tags: ["smoke"],
		runs: [],
	});
	await writeJson(path.join(taskbookDir, "spec.json"), {
		goal: "把 workspace package.json 的 name 字段输出到 name.json",
		hardConstraints: ["只用本地文件和 Node stdlib", "产物必须写到 TASK_OUTPUT_DIR/name.json"],
		acceptance: ["name.json 存在", "name.json 是合法 JSON", "name 字段等于 smoke-pkg"],
		forbidden: ["不要访问网络", "不要修改 package.json"],
		context: "自动化 /task smoke 的复用场景。",
	});
	await fs.writeFile(path.join(taskbookDir, "skill.md"), [
		"# 读 package.json name",
		"",
		"## 步骤",
		"1. 读取当前 workspace 的 package.json。",
		"2. 提取 name 字段。",
		"3. 写入 JSON 文件到 contract 要求的 outputDir/name.json,格式为 {\"name\":\"<value>\"}。",
		"",
	].join("\n"), "utf8");
	await fs.writeFile(path.join(taskbookDir, "verify.mjs"), [
		"import { readFile, stat } from \"node:fs/promises\";",
		"const failures = [];",
		"async function check(assertion, fn) {",
		"\ttry { await fn(); } catch (error) { failures.push({ assertion, expected: \"pass\", actual: error.message }); }",
		"}",
		"const file = `${process.env.TASK_OUTPUT_DIR}/name.json`;",
		"await check(\"name.json 存在\", async () => { await stat(file); });",
		"let parsed = {};",
		"await check(\"name.json 是合法 JSON\", async () => { parsed = JSON.parse(await readFile(file, \"utf8\")); });",
		"await check(\"name 等于 smoke-pkg\", async () => { if (parsed.name !== \"smoke-pkg\") throw new Error(`got ${parsed.name}`); });",
		"if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }",
		"process.exit(0);",
		"",
	].join("\n"), "utf8");
	await writeJson(path.join(taskbookDir, "contract.json"), {
		artifacts: [{ name: "name.json", type: "file", required: true }],
		runtimeInput: [],
	});
	const agentDir = path.join(runDir, "agent", "agents");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.copyFile(path.join(root, "agents", "worker.md"), path.join(agentDir, "worker.md"));
}

function smokeEnv(runDir) {
	return addDeepSeekEnvFallback({
		...process.env,
		PI_CODING_AGENT_DIR: path.join(runDir, "agent"),
		UGK_SKIP_UPDATE_CHECK: "1",
		UGK_SKIP_WORKSPACE_TRUST: "1",
		UGK_CLEAR_STARTUP: "0",
	}, readUserDeepSeekApiKey());
}

export function addDeepSeekEnvFallback(env, userValue) {
	const existing = normalizeDeepSeekApiKey(env.DEEPSEEK_API_KEY ?? "");
	if (existing) return existing === env.DEEPSEEK_API_KEY ? env : { ...env, DEEPSEEK_API_KEY: existing };
	const key = normalizeDeepSeekApiKey(userValue);
	return key ? { ...env, DEEPSEEK_API_KEY: key } : env;
}

export function normalizeDeepSeekApiKey(value = "") {
	const match = value.match(/\bsk-[^\s"'`]+/);
	return match?.[0] ?? "";
}

function readUserDeepSeekApiKey() {
	if (process.platform !== "win32") return "";
	const result = spawnSync("powershell.exe", [
		"-NoProfile",
		"-Command",
		"[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')",
	], { encoding: "utf8", windowsHide: true });
	return result.status === 0 ? result.stdout : "";
}

function writeEvent(stream, event) {
	stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
}

function endStream(stream) {
	return new Promise((resolve) => stream.end(resolve));
}

function uiResponse(id, payload) {
	return `${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`;
}

function optionText(option) {
	return typeof option === "string" ? option : option?.label ?? option?.value ?? "";
}

function optionValue(option) {
	return typeof option === "string" ? option : option?.value ?? option?.label ?? option;
}

function respondToUi(child, request) {
	if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)) return;
	if (request.method === "select") {
		const options = request.options ?? [];
		let choice = options.find((option) => /smoke_name_count/.test(optionText(option)))
			?? options.find((option) => /运行 taskbook|新建任务/.test(optionText(option)))
			?? options.find((option) => !/Exit/.test(optionText(option)))
			?? options[0];
		child.stdin.write(uiResponse(request.id, { value: optionValue(choice) }));
		return;
	}
	if (request.method === "input") {
		const title = String(request.title ?? "");
		const value = /name|名字/i.test(title) ? taskbookName : rawTaskInput;
		child.stdin.write(uiResponse(request.id, { value }));
		return;
	}
	if (request.method === "editor") {
		child.stdin.write(uiResponse(request.id, { value: "smoke execution summary" }));
		return;
	}
	if (request.method === "confirm") {
		child.stdin.write(uiResponse(request.id, { confirmed: true }));
		return;
	}
	child.stdin.write(uiResponse(request.id, { cancelled: true }));
}

async function readTaskbookRuns(workspace) {
	try {
		const data = JSON.parse(await fs.readFile(path.join(workspace, ".tasks", taskbookName, "taskbook.json"), "utf8"));
		return Array.isArray(data.runs) ? data.runs : [];
	} catch {
		return [];
	}
}

async function runTaskSmoke(runDir, workspace) {
	const startedAt = Date.now();
	const eventsFile = createWriteStream(path.join(runDir, "rpc-events.jsonl"), { flags: "a" });
	const stdout = createWriteStream(path.join(runDir, "stdout.log"), { flags: "a" });
	const stderr = createWriteStream(path.join(runDir, "stderr.log"), { flags: "a" });
	const events = [];
	const child = spawn(process.execPath, [
		path.join(root, "bin", "ugk.js"),
		"--mode", "rpc",
		"--no-session",
		"--model", process.env.UGK_SMOKE_MODEL ?? "deepseek/deepseek-v4-pro",
	], {
		cwd: workspace,
		env: smokeEnv(runDir),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const responses = new Map();
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
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				msg = { type: "output_text", line };
			}
			const event = { direction: "out", msg };
			events.push(event);
			writeEvent(eventsFile, event);
			if (msg.type === "response" && msg.id) responses.set(msg.id, msg);
			if (msg.type === "extension_ui_request") respondToUi(child, msg);
		}
	});
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		stderrText += text;
		stderr.write(text);
	});

	const exited = new Promise((resolve) => child.on("exit", (code) => {
		exitCode = code;
		resolve();
	}));
	const send = (message) => {
		const event = { direction: "in", msg: message };
		events.push(event);
		writeEvent(eventsFile, event);
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitForResponse = async (id, timeoutMs) => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (responses.has(id)) return responses.get(id);
			if (exitCode !== undefined) return undefined;
			await wait(100);
		}
		return undefined;
	};
	const waitForPass = async (timeoutMs) => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const runs = await readTaskbookRuns(workspace);
			if (hasTaskPass(events) && runs.some((run) => run.status === "pass")) return true;
			if (hasTaskFail(events) || runs.some((run) => run.status === "fail")) return false;
			if (exitCode !== undefined) return false;
			await wait(250);
		}
		return false;
	};
	const killTimer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 180000);

	send({ id: "startup", type: "get_commands" });
	await waitForResponse("startup", 10000);
	send({ id: "run", type: "prompt", message: `/task run ${taskbookName} ${rawTaskInput}` });
	await waitForResponse("run", 10000);
	await waitForPass(150000);
	child.stdin.end();
	await Promise.race([exited, wait(5000)]);
	if (exitCode === undefined) {
		timedOut = true;
		child.kill();
		await exited;
	}
	clearTimeout(killTimer);
	await Promise.all([endStream(eventsFile), endStream(stdout), endStream(stderr)]);
	return { exitCode, timedOut, stderr: stderrText, events, taskbookRuns: await readTaskbookRuns(workspace), durationMs: Date.now() - startedAt };
}

async function main() {
	const { runDir, latestDir, workspace } = await prepareDirs();
	await prepareWorkspace(runDir, workspace);
	const run = await runTaskSmoke(runDir, workspace);
	const report = buildTaskReport(run);
	await fs.writeFile(path.join(runDir, "report.md"), report, "utf8");
	await fs.rm(latestDir, { recursive: true, force: true });
	await fs.cp(runDir, latestDir, { recursive: true });
	process.stdout.write(`Task smoke report: ${path.join(latestDir, "report.md")}\n`);
	process.exitCode = report.includes("Result: pass") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
