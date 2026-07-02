import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { defaultAgentDir } from "./paths.js";

const execFileAsync = promisify(execFile);
/** GitHub repo slug, used for both API calls and release-notes links. */
export const GITHUB_REPO_SLUG = "mhgd3250905/ugk-tui";
const GITHUB_MAIN_COMMIT_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/commits/main`;
const GITHUB_FETCH_TIMEOUT_MS = 3000;
const GLOBAL_PACKAGE_NAME = "ugk-agent";

export function shortRef(ref) {
	return ref.slice(0, 7);
}

function defaultPackageRoot() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function statePath(agentDir = defaultAgentDir()) {
	return path.join(agentDir, "ugk-update.json");
}

export function readUgkUpdateState(agentDir = defaultAgentDir()) {
	try {
		return JSON.parse(fs.readFileSync(statePath(agentDir), "utf8"));
	} catch {
		return {};
	}
}

export function writeUgkUpdateState(state, agentDir = defaultAgentDir()) {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(statePath(agentDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function shouldCheckForUgkUpdate(_state, _now, force = false) {
	if (force) return true;
	return true;
}

export function shouldPromptForUgkUpdate(state, info) {
	return state.skippedRef !== info.latestRef;
}

export function formatUgkUpdateNotice(info) {
	return [
		"UGK 有新版本可用",
		"",
		`当前版本: ${info.currentVersion} (${shortRef(info.currentRef)})`,
		`最新版本: ${shortRef(info.latestRef)}`,
		"",
		"更新内容:",
		"- 同步 UGK 最新功能、修复和文档",
	].join("\n");
}

export async function detectUgkUpdate(deps = {}) {
	const currentRef = await (deps.getCurrentRef || (() => getLocalGitRef(deps.packageRoot)))();
	const latestRef = await (deps.getLatestRef || getGithubMainRef)();
	const currentVersion = (deps.getCurrentVersion || (() => readPackageVersion(deps.packageRoot)))();

	if (!currentRef || !latestRef || currentRef === latestRef) return undefined;
	const localAlreadyContainsLatest = await (deps.isLatestAncestorOfCurrent ||
		((current, latest) => isGitAncestor(latest, current, deps.packageRoot)))(currentRef, latestRef);
	if (localAlreadyContainsLatest) return undefined;

	return {
		currentRef,
		latestRef,
		currentVersion,
		source: "github-main",
	};
}

export async function isGitAncestor(ancestorRef, descendantRef, packageRoot = defaultPackageRoot()) {
	try {
		await execFileAsync("git", ["-C", packageRoot, "merge-base", "--is-ancestor", ancestorRef, descendantRef]);
		return true;
	} catch {
		return false;
	}
}

export async function getLocalGitRef(packageRoot = defaultPackageRoot()) {
	try {
		const { stdout } = await execFileAsync("git", ["-C", packageRoot, "rev-parse", "HEAD"]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export async function getGithubMainRef() {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(GITHUB_MAIN_COMMIT_URL, {
			headers: { "user-agent": "ugk-agent/update-check" },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const body = await response.json();
		return body.sha;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export function readPackageVersion(packageRoot = defaultPackageRoot()) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		return pkg.version || "unknown";
	} catch {
		return "unknown";
	}
}

export function getPackageInstallCommand(platform = process.platform) {
	if (platform === "win32") {
		return {
			command: "cmd.exe",
			args: ["/d", "/s", "/c", "npm", "install"],
		};
	}

	return {
		command: "npm",
		args: ["install"],
	};
}

export function getGlobalPackageInstallCommand(platform = process.platform) {
	if (platform === "win32") {
		return {
			command: "cmd.exe",
			args: ["/d", "/s", "/c", "npm", "install", "-g", GLOBAL_PACKAGE_NAME],
		};
	}

	return {
		command: "npm",
		args: ["install", "-g", GLOBAL_PACKAGE_NAME],
	};
}

export function isGitCheckout(packageRoot = defaultPackageRoot()) {
	return fs.existsSync(path.join(packageRoot, ".git"));
}

export function getUgkUpdateCommandLabel(packageRoot = defaultPackageRoot(), gitCheckout = isGitCheckout(packageRoot)) {
	return gitCheckout ? "git pull --rebase origin main && npm install" : `npm install -g ${GLOBAL_PACKAGE_NAME}`;
}

function runCommand(command, args, options = {}) {
	if (options.stdio === "inherit") {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				stdio: "inherit",
				windowsHide: true,
			});
			child.on("error", reject);
			child.on("exit", (code, signal) => {
				if (code === 0) {
					resolve({ stdout: "", stderr: "" });
					return;
				}
				const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${suffix}`));
			});
		});
	}

	return execFileAsync(command, args, { cwd: options.cwd });
}

export async function applyLocalGitUpdate(packageRoot = defaultPackageRoot(), options = {}) {
	const status = await execFileAsync("git", ["-C", packageRoot, "status", "--porcelain", "--untracked-files=no"]);
	if (status.stdout.trim()) {
		throw new Error("当前本地项目有未提交的已跟踪改动,为避免覆盖修改,已取消自动更新。");
	}

	await runCommand("git", ["-C", packageRoot, "pull", "--rebase", "origin", "main"], { stdio: options.stdio });
	const install = getPackageInstallCommand();
	await runCommand(install.command, install.args, { cwd: packageRoot, stdio: options.stdio });
	return "UGK 已更新完成。请重启 ugk 使用新版本。";
}

export async function applyGlobalNpmUpdate(options = {}) {
	const install = getGlobalPackageInstallCommand();
	await runCommand(install.command, install.args, { stdio: options.stdio });
	return "UGK 已更新完成。请重启 ugk 使用新版本。";
}

export async function applyUgkUpdate(packageRoot = defaultPackageRoot(), options = {}) {
	if (isGitCheckout(packageRoot)) {
		return applyLocalGitUpdate(packageRoot, options);
	}
	return applyGlobalNpmUpdate(options);
}

