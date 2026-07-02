#!/usr/bin/env node
/**
 * ugk 一键交互式安装器
 *
 * 用法(用户):
 *   npx ugk-install
 *
 * 流程:
 *   1. 检测 Node ≥18 / npm
 *   2. npm install -g ugk-agent(权限错给修复指引)
 *   3. 交互式问 DeepSeek API key,验证有效性
 *   4. 写 auth.json(标准结构,BOM-safe,0600)
 *   5. 验证 ugk --version
 *
 * key 写 auth.json({deepseek:{type:"api_key",key}}) 而非 env:
 *   - 调用优先级最高(高于 env,见 pi auth-storage.js)
 *   - 跨进程即时生效,不用重开终端、不污染 shell rc
 *   - 是 pi /login 同款结构
 */

import { createInterface } from "node:readline";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const UGK_PACKAGE = "ugk-agent";
const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";

// ---- 输出辅助(检测 TTY,无色退回纯文本) ----
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = {
	green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
	red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
	yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
	cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
	bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};
const info = (s) => console.log(`${c.cyan("•")} ${s}`);
const success = (s) => console.log(`${c.green("✓")} ${s}`);
const warn = (s) => console.log(`${c.yellow("!")} ${s}`);
const fail = (s) => console.error(`${c.red("✗")} ${s}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

// ---- 步骤 1:欢迎 ----
function showBanner() {
	console.log();
	console.log(c.bold(c.green("  ╔══════════════════════════════════════╗")));
	console.log(c.bold(c.green("  ║         ugk 一键安装器               ║")));
	console.log(c.bold(c.green("  ║   终端 AI 编码 agent,装即用          ║")));
	console.log(c.bold(c.green("  ╚══════════════════════════════════════╝")));
	console.log();
}

// ---- 步骤 2:检测 Node/npm ----
function checkNode() {
	const requiredMajor = 18;
	try {
		const out = execSync("node --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const major = parseInt(out.replace(/^v/, ""), 10);
		if (Number.isNaN(major) || major < requiredMajor) {
			fail(`检测到 Node ${out},但 ugk 需要 Node ${requiredMajor}+。`);
			console.log(`  请到 ${c.cyan("https://nodejs.org")} 下载 LTS 版安装,然后重跑本安装器。`);
			process.exit(1);
		}
		return out;
	} catch {
		fail("未检测到 Node.js。ugk 需要 Node.js 18+ 才能运行。");
		console.log(`  请到 ${c.cyan("https://nodejs.org")} 下载 LTS 版安装,然后重跑本安装器。`);
		console.log(`  (Windows 也可:winget install OpenJS.NodeJS.LTS)`);
		process.exit(1);
	}
}

function checkNpm() {
	try {
		return execSync("npm --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		fail("未检测到 npm。npm 随 Node.js 一起安装,请重装 Node.js LTS。");
		process.exit(1);
	}
}

// ---- 步骤 3:装 ugk ----
function installUgk() {
	info("正在安装 ugk(npm install -g ugk-agent,可能需要 1-2 分钟)...");
	const result = spawnSync("npm", ["install", "-g", UGK_PACKAGE], {
		stdio: ["ignore", "inherit", "inherit"],
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		const isWindows = process.platform === "win32";
		console.log();
		fail("npm 全局安装失败。最常见原因是权限不足(EACCES)。");
		console.log();
		console.log(c.bold("修复方法(二选一):"));
		if (isWindows) {
			console.log(`  1. 用管理员身份重开 PowerShell/终端,再跑本安装器`);
			console.log(`  2. 或手动配 npm 全局目录(推荐,免管理员权限):`);
			console.log(`     ${c.cyan("npm config set prefix \"$env:APPDATA\\npm\"")}`);
			console.log(`     然后重开终端再跑 npx ugk-install`);
		} else {
			console.log(`  1. 配置 npm 全局目录到你的用户目录(推荐,免 sudo):`);
			console.log(`     ${c.cyan("mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'")}`);
			console.log(`     把 ~/.npm-global/bin 加进 PATH,然后重开终端再跑 npx ugk-install`);
			console.log(`  2. 或用 sudo(不推荐,有安全风险):sudo npm install -g ugk-agent`);
		}
		console.log();
		console.log(`详细排查:https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally`);
		process.exit(1);
	}
	success("ugk 安装完成。");
}

function isUgkInstalled() {
	try {
		execSync("ugk --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

// ---- 步骤 4-6:问 key + 验证 + 写 auth.json ----
async function askForKey() {
	console.log();
	info("ugk 默认用 DeepSeek 模型。需要 DeepSeek API key 才能使用。");
	const hasKey = (await question(`已有 DeepSeek API key? ${c.bold("(y/n)")} `)).trim().toLowerCase();
	if (hasKey !== "y" && hasKey !== "yes") {
		console.log();
		warn("没问题。请先去申请 key:");
		console.log(`  ${c.cyan("https://platform.deepseek.com")} → 创建 API key`);
		console.log(`  拿到 key(形如 sk-...)后,重跑 ${c.bold("npx ugk-install")} 即可自动配置。`);
		console.log();
		console.log(`(ugk 也支持 OpenAI/Claude 等其他模型,详见 https://github.com/mhgd3250905/ugk-tui)`);
		return undefined;
	}
	// key 输入(明文——终端历史可自行清理;隐藏输入需原生 TTY hack,保持简单)
	const key = (await question(`请粘贴你的 DeepSeek API key: `)).trim();
	if (!key) {
		warn("未输入 key,跳过配置。可稍后重跑本安装器,或手动 setx DEEPSEEK_API_KEY。");
		return undefined;
	}
	if (!key.startsWith("sk-")) {
		warn("DeepSeek key 通常以 sk- 开头。请确认输入的是完整 key。");
		const cont = (await question(`仍要保存这个值吗? ${c.bold("(y/n)")} `)).trim().toLowerCase();
		if (cont !== "y" && cont !== "yes") return undefined;
	}
	return key;
}

async function validateKey(key) {
	info("正在验证 key 有效性(向 DeepSeek 发一个轻量请求)...");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10000);
	try {
		const res = await fetch(DEEPSEEK_MODELS_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: controller.signal,
		});
		if (res.ok) {
			success("key 有效。");
			return true;
		}
		if (res.status === 401 || res.status === 403) {
			fail(`key 验证失败(HTTP ${res.status})—— key 无效或已过期。`);
		} else {
			warn(`key 验证返回 HTTP ${res.status}(网络/服务异常)。仍会保存,稍后用 ugk 时若报错再检查 key。`);
			return true;
		}
		return false;
	} catch (e) {
		warn(`无法连接 DeepSeek 验证(${e.message ?? e})。仍会保存 key,稍后用 ugk 时若报错再检查。`);
		return true;
	} finally {
		clearTimeout(timer);
	}
}

function stripBom(content) {
	return content.replace(/^\uFEFF/, "");
}

function resolveAuthPath() {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "auth.json");
}

function writeAuthJson(key) {
	const authPath = resolveAuthPath();
	let auth = {};
	if (fs.existsSync(authPath)) {
		try {
			const raw = stripBom(fs.readFileSync(authPath, "utf8"));
			if (raw.trim()) {
				auth = JSON.parse(raw);
				if (typeof auth !== "object" || auth === null || Array.isArray(auth)) auth = {};
			}
		} catch {
			warn(`现有 auth.json 解析失败(损坏)。为避免覆盖,本次不写 key。`);
			console.log(`  路径: ${authPath}`);
			console.log(`  请手动备份/删除该文件后重跑,或手动 setx DEEPSEEK_API_KEY。`);
			process.exit(1);
		}
	}
	// 标准 pi 凭据结构(已读 auth-storage.js:387 确认:type+key,非 apiKey)
	auth.deepseek = { type: "api_key", key };

	fs.mkdirSync(path.dirname(authPath), { recursive: true });
	fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	// Windows 上 chmod 是 no-op,显式再设一次(跨平台无害)
	try {
		fs.chmodSync(authPath, 0o600);
	} catch {
		// Windows 上 chmod 可能失败,忽略
	}
	return authPath;
}

// ---- 主流程 ----
async function main() {
	showBanner();

	const nodeVer = checkNode();
	success(`Node ${nodeVer} 已就绪。`);
	const npmVer = checkNpm();
	success(`npm ${npmVer} 已就绪。`);

	if (isUgkInstalled()) {
		info("检测到 ugk 已安装,跳过安装步骤。");
	} else {
		installUgk();
	}

	const key = await askForKey();
	if (key) {
		const valid = await validateKey(key);
		if (!valid) {
			const retry = (await question(`要重新输入 key 吗? ${c.bold("(y/n)")} `)).trim().toLowerCase();
			if (retry === "y" || retry === "yes") {
				const newKey = (await question(`请粘贴你的 DeepSeek API key: `)).trim();
				if (newKey && (await validateKey(newKey))) {
					const written = writeAuthJson(newKey);
					success(`key 已写入: ${c.cyan(written)}`);
				} else {
					warn("key 未保存。可稍后重跑本安装器。");
				}
			} else {
				warn("key 未保存。可稍后重跑本安装器。");
			}
		} else {
			const written = writeAuthJson(key);
			success(`key 已写入: ${c.cyan(written)}`);
		}
	}

	console.log();
	console.log(c.bold(c.green("  ════════════════════════════════════════")));
	console.log(c.bold(c.green("  ✓ ugk 安装配置完成!")));
	console.log(c.bold(c.green("  ════════════════════════════════════════")));
	console.log();
	console.log(`  现在任意目录运行 ${c.bold(c.cyan("ugk"))} 开始使用。`);
	console.log(`  文档: ${c.cyan("https://github.com/mhgd3250905/ugk-tui")}`);
	console.log();

	rl.close();
}

main().catch((err) => {
	fail(`安装器异常: ${err?.message ?? err}`);
	console.error(err);
	process.exit(1);
});
