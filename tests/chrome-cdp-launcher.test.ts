import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getChromeLaunchCommand, getDefaultChromeProfilePath } from "../extensions/chrome-cdp/launcher.ts";

test("getDefaultChromeProfilePath uses dedicated ugk profile", () => {
	assert.equal(
		getDefaultChromeProfilePath(path.join("/Users", "demo")),
		path.join("/Users", "demo", ".ugk", "chrome-cdp-profile"),
	);
});

test("getChromeLaunchCommand builds macOS Chrome command with local debugging port and profile", () => {
	const command = getChromeLaunchCommand({ port: 9222, homeDir: path.join("/Users", "demo"), platform: "darwin" });

	assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.deepEqual(command.args, [
		"--remote-debugging-port=9222",
		`--user-data-dir=${path.join("/Users", "demo", ".ugk", "chrome-cdp-profile")}`,
	]);
});

test("getChromeLaunchCommand falls back to google-chrome on linux", () => {
	const command = getChromeLaunchCommand({ port: 9333, homeDir: path.join("/home", "demo"), platform: "linux" });

	assert.equal(command.command, "google-chrome");
	assert.deepEqual(command.args, [
		"--remote-debugging-port=9333",
		`--user-data-dir=${path.join("/home", "demo", ".ugk", "chrome-cdp-profile")}`,
	]);
});

test("getChromeLaunchCommand resolves Windows chrome.exe when present", () => {
	// 模拟一个标准安装路径,findWindowsChrome 会读到 PROGRAMFILES 指向的 exe
	const fakeProgramFiles = path.join(os.tmpdir(), "ugk-test-pf");
	const chromeExe = path.join(fakeProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
	fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
	fs.writeFileSync(chromeExe, "");
	process.env.PROGRAMFILES = fakeProgramFiles;

	try {
		const command = getChromeLaunchCommand({ port: 9444, homeDir: os.tmpdir(), platform: "win32" });

		assert.equal(command.command, chromeExe);
		assert.deepEqual(
			command.args,
			[`--remote-debugging-port=9444`, `--user-data-dir=${path.join(os.tmpdir(), ".ugk", "chrome-cdp-profile")}`],
		);
	} finally {
		delete process.env.PROGRAMFILES;
		fs.rmSync(fakeProgramFiles, { recursive: true, force: true });
	}
});

test("getChromeLaunchCommand falls back to chrome.exe on Windows if not found", () => {
	// 把所有候选路径都设成不存在的目录,触发 fallback
	process.env.PROGRAMFILES = path.join(os.tmpdir(), "ugk-empty-pf");
	process.env["PROGRAMFILES(X86)"] = path.join(os.tmpdir(), "ugk-empty-pf86");
	process.env.LOCALAPPDATA = path.join(os.tmpdir(), "ugk-empty-local");

	try {
		const command = getChromeLaunchCommand({ port: 9555, homeDir: os.tmpdir(), platform: "win32" });

		assert.equal(command.command, "chrome.exe");
	} finally {
		delete process.env.PROGRAMFILES;
		delete process.env["PROGRAMFILES(X86)"];
		delete process.env.LOCALAPPDATA;
	}
});

// ponytail: 钉死 Chrome teardown 回归(根因:child 句柄不可靠,改用 port 查杀)。
// launchChromeCdp 的 child 是 Windows Chrome stub,~150ms 后 exit(code=0),child.on(exit) 把
// 句柄从 Set 删掉,teardown 时 Set 空、没东西可杀 → 真正的 Chrome 成孤儿永久残留。
// 修复:不再管理 child 句柄,改登记 port;teardown 按 port 查命令行含 --remote-debugging-port=<port>
// 的 Chrome 进程杀掉。测试验证 port 登记 + teardown 对每个 port 调 killChromeByPort + 清空 + 幂等。
test("managed Chrome ports are killed on teardown and cleared (port-based, not child handles)", async () => {
	const { __testOnly } = await import("../extensions/chrome-cdp/launcher.ts");
	__testOnly.teardown(); // 干净起点

	const killedPorts: number[] = [];
	const restoreKill = __testOnly.setKillImpl((port) => { killedPorts.push(port); });
	__testOnly.managedPorts.add(9222);
	__testOnly.managedPorts.add(9333);
	__testOnly.managedPorts.add(9444);
	assert.equal(__testOnly.managedPorts.size, 3);

	__testOnly.teardown();

	assert.equal(__testOnly.managedPorts.size, 0, "teardown 后 port Set 应清空");
	assert.deepEqual(killedPorts.sort((a, b) => a - b), [9222, 9333, 9444], "三个 port 都应被查杀");
	// 幂等:再 teardown 不炸也不再杀(已清空)。
	__testOnly.teardown();
	assert.equal(killedPorts.length, 3, "幂等:空 Set 再 teardown 不重复杀");
	restoreKill();
});

// ponytail: killChromeByPort 的端到端验证靠真机测试(真起 Chrome,见 docs/reviews 审查报告)。
// 单元层无法可靠 mock:生产代码按 Name='chrome.exe' 过滤,测试用 node 进程冒充会被过滤掉、
// 测不到真实行为;用 node -e 传 --remote-debugging-port 又会被 node 当自己的参数拒绝启动。
// 所以这里只保留 port 登记 + teardown 调用链的单元测试;"按 port 查杀 chrome.exe"的核心
// 系统行为由真机验证(ugk 启动 Chrome → 退出 → 确认 Chrome 消失)兜底。
