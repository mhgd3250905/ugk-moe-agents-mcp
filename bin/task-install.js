import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline/promises";
import { defaultAgentDir } from "./paths.js";

export const OFFICIAL_MANIFEST_URL = "https://ugk-task-share.pages.dev/api/manifest";

// 此清单是"最小必需校验集",不是打包全集。CLI publish 扫目录打包全部文件
// (含 scripts/,见 task-share-publish.ts collectExtraFiles);此处仅用于校验
// "一个 taskbook 至少得有这 5 个",不决定打包/下载的全部内容。
const REQUIRED_FILES = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"];
const NAME_RE = /^[A-Za-z0-9_-]+$/;

function isStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerifyFailure(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.assertion === "string" &&
		typeof value.expected === "string" &&
		typeof value.actual === "string" &&
		(value.hint === undefined || typeof value.hint === "string")
	);
}

function isTaskRun(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.timestamp === "string" &&
		(value.status === "pass" || value.status === "fail") &&
		typeof value.exitCode === "number" &&
		Array.isArray(value.verifyFailures) &&
		value.verifyFailures.every(isVerifyFailure) &&
		typeof value.duration === "number" &&
		Object.hasOwn(value, "input")
	);
}

function isTaskbook(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		(value.scope === "user" || value.scope === "project") &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.tags === undefined || isStringArray(value.tags)) &&
		Array.isArray(value.runs) &&
		value.runs.every(isTaskRun)
	);
}

function isRequirementsSpec(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.goal === "string" &&
		value.goal.trim().length > 0 &&
		isStringArray(value.hardConstraints) &&
		value.hardConstraints.length > 0 &&
		isStringArray(value.acceptance) &&
		value.acceptance.length > 0 &&
		(value.forbidden === undefined || isStringArray(value.forbidden)) &&
		(value.context === undefined || typeof value.context === "string")
	);
}

function assertValidContract(contract) {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("Invalid contract.json");
	if (contract.runtimeInput !== undefined && !isStringArray(contract.runtimeInput)) throw new Error("Invalid contract.runtimeInput");
	if (contract.runtimeInputMeta === undefined) return;
	if (!contract.runtimeInputMeta || typeof contract.runtimeInputMeta !== "object" || Array.isArray(contract.runtimeInputMeta)) {
		throw new Error("Invalid contract.runtimeInputMeta");
	}
	const fields = new Set(isStringArray(contract.runtimeInput) ? contract.runtimeInput : []);
	for (const [field, meta] of Object.entries(contract.runtimeInputMeta)) {
		if (!fields.has(field)) throw new Error(`Invalid contract.runtimeInputMeta: "${field}" is not declared in runtimeInput`);
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error(`Invalid contract.runtimeInputMeta.${field}`);
	}
}

function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJson(text, label) {
	try {
		return JSON.parse(stripBom(text));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertValidName(name) {
	if (!NAME_RE.test(name)) throw new Error(`Invalid taskbook name: ${name}`);
}

function assertSafeManifestPath(file) {
	if (
		typeof file !== "string" ||
		file.length === 0 ||
		path.isAbsolute(file) ||
		file.includes("\\") ||
		file.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`Unsafe file path in manifest: ${String(file)}`);
	}
}

async function fetchText(fetchFn, url) {
	const response = await fetchFn(url);
	if (!response?.ok) throw new Error(`Failed to download ${url}: HTTP ${response?.status ?? "unknown"}`);
	return await response.text();
}

function findManifestTask(manifest, name) {
	const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
	const task = tasks.find((item) => item?.name === name);
	if (!task) throw new Error(`Official taskbook not found: ${name}`);
	const files = task.files;
	if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error(`Invalid manifest entry for ${name}`);
	for (const file of REQUIRED_FILES) {
		if (typeof files[file] !== "string") throw new Error(`Invalid manifest entry for ${name}: missing ${file}`);
	}
	for (const file of Object.keys(files)) {
		assertSafeManifestPath(file);
		if (typeof files[file] !== "string") throw new Error(`Invalid manifest entry for ${name}: invalid ${file}`);
	}
	return task;
}

function validateTaskbook(name, texts) {
	const taskbook = parseJson(texts["taskbook.json"], "taskbook.json");
	const spec = parseJson(texts["spec.json"], "spec.json");
	const contract = parseJson(texts["contract.json"], "contract.json");
	if (!isTaskbook(taskbook)) throw new Error("Invalid taskbook.json");
	if (!isRequirementsSpec(spec)) throw new Error("Invalid spec.json");
	assertValidContract(contract);
	if (taskbook?.name !== name) throw new Error(`taskbook.json name mismatch: expected ${name}, got ${String(taskbook?.name)}`);
	return taskbook;
}

export function isTaskInstallCommand(argv) {
	return argv[0] === "task" && argv[1] === "install";
}

export async function runTaskInstall(name, deps = {}) {
	assertValidName(name);
	const fetchFn = deps.fetch ?? globalThis.fetch;
	if (typeof fetchFn !== "function") throw new Error("fetch is not available in this Node.js runtime");
	const manifestUrl = deps.manifestUrl ?? OFFICIAL_MANIFEST_URL;
	const agentDir = deps.agentDir ?? defaultAgentDir();
	const manifest = parseJson(await fetchText(fetchFn, manifestUrl), "manifest.json");
	const task = findManifestTask(manifest, name);
	const targetDir = path.join(agentDir, "tasks", name);
	// ponytail: force 只给 runTaskUpdate 内部用,绕过"已装拒绝"以实现覆盖;
	// 对外 CLI install 不暴露此 flag,避免用户误覆盖。
	if (!deps.force && existsSync(targetDir)) throw new Error(`taskbook "${name}" already exists: ${targetDir}`);

	const texts = {};
	for (const file of Object.keys(task.files)) {
		texts[file] = await fetchText(fetchFn, task.files[file]);
	}
	validateTaskbook(name, texts);

	const tasksRoot = path.join(agentDir, "tasks");
	const tempDir = path.join(tasksRoot, `.install-${name}-${Date.now()}`);
	await mkdir(tempDir, { recursive: true });
	try {
		for (const file of Object.keys(task.files)) {
			await mkdir(path.dirname(path.join(tempDir, file)), { recursive: true });
			await writeFile(path.join(tempDir, file), texts[file], "utf8");
		}
		// force 覆盖:rename 不覆盖已存在目录,先删旧目标(仅 force 路径,update 内部用)
		if (deps.force && existsSync(targetDir)) {
			await rm(targetDir, { recursive: true, force: true });
		}
		await rename(tempDir, targetDir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return { name, dir: targetDir };
}

export async function runTaskInstallCli(argv, deps = {}) {
	const name = argv[2];
	if (!name) {
		deps.stderr?.write?.("Usage: ugk task install <name>\n");
		return 1;
	}
	try {
		const result = await runTaskInstall(name, deps);
		deps.stdout?.write?.(`已安装 taskbook "${result.name}"\n下一步: /task run ${result.name} <你的输入>\n`);
		return 0;
	} catch (error) {
		deps.stderr?.write?.(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

export function isTaskRemoveCommand(argv) {
	return argv[0] === "task" && argv[1] === "remove";
}

export async function runTaskRemove(name, deps = {}) {
	assertValidName(name);
	const agentDir = deps.agentDir ?? defaultAgentDir();
	const targetDir = path.join(agentDir, "tasks", name);
	if (!existsSync(targetDir)) throw new Error(`taskbook "${name}" is not installed: ${targetDir}`);
	await rm(targetDir, { recursive: true, force: true });
	return { name, dir: targetDir };
}

async function defaultConfirm(name, deps) {
	// 生产:readline 读一行。bin/ugk.js dispatch 在 TUI 启动前,stdin 可同步交互。
	const stdin = deps.stdin ?? process.stdin;
	const stdout = deps.stdout ?? process.stdout;
	stdout.write(`即将删除 taskbook "${name}"(位于 user tasks 目录)。继续?[y/N] `);
	const rl = readline.createInterface({ input: stdin, output: stdout });
	try {
		const answer = (await rl.question("")).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

export async function runTaskRemoveCli(argv, deps = {}) {
	const name = argv[2];
	if (!name) {
		deps.stderr?.write?.("Usage: ugk task remove <name> [-y|--yes]\n");
		return 1;
	}
	const yes = argv.includes("-y") || argv.includes("--yes");
	const confirm = deps.confirm ?? defaultConfirm;
	try {
		if (!yes) {
			const ok = await confirm(name, deps);
			if (!ok) {
				deps.stdout?.write?.("未删除。\n");
				return 1;
			}
		}
		const result = await runTaskRemove(name, deps);
		deps.stdout?.write?.(`已删除 taskbook "${result.name}"\n`);
		return 0;
	} catch (error) {
		deps.stderr?.write?.(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

export function isTaskUpdateCommand(argv) {
	return argv[0] === "task" && argv[1] === "update";
}

export async function runTaskUpdate(name, deps = {}) {
	assertValidName(name);
	// update = install(force)。force 路径自带"删旧目标再 rename",未装时直接装。
	return runTaskInstall(name, { ...deps, force: true });
}

export async function runTaskUpdateCli(argv, deps = {}) {
	const name = argv[2];
	if (!name) {
		deps.stderr?.write?.("Usage: ugk task update <name>\n");
		return 1;
	}
	try {
		const result = await runTaskUpdate(name, deps);
		deps.stdout?.write?.(`已更新 taskbook "${result.name}"\n下一步: /task run ${result.name} <你的输入>\n`);
		return 0;
	} catch (error) {
		deps.stderr?.write?.(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
