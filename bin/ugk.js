#!/usr/bin/env node
/**
 * ugk CLI 入口(npm bin 指向这里)
 *
 * 极薄包装:把 pi 作为内置依赖,用 -e 临时注入我们的扩展。
 * 用户打 `ugk` = 跑 pi + 自动加载 ugk 全部能力,全程不知 pi 存在。
 *
 * -e 走 temporary resolve(resource-loader.js),零全局副作用,不写 settings.json。
 * skills/prompts 通过 extensions/index.ts 的 resources_discover 事件随包加载。
 */

// pi 期望的运行时标记(见 pi cli.js:12)
process.env.PI_CODING_AGENT = "true";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildUgkCliArgs } from "./ugk-cli-args.js";
import {
	isTaskInstallCommand,
	runTaskInstallCli,
	isTaskRemoveCommand,
	runTaskRemoveCli,
	isTaskUpdateCommand,
	runTaskUpdateCli,
} from "./task-install.js";
import { installUgkExtensionOverlayPatch } from "./ugk-extension-overlay-patch.js";
import { installUgkPackageUpdatePatch } from "./ugk-package-update-patch.js";
import { applyUgkRuntimePolicy, installUgkEditorBorderGlyphPatch } from "./ugk-runtime-policy.js";
import { installUgkSessionViewPatch } from "./ugk-session-view-patch.js";
import { ensureUgkQuietStartupDefault } from "./ugk-startup-settings.js";
import { runUgkUpdatePreflight } from "./update-preflight.js";
import { ensureWorkspaceTrusted } from "./workspace-trust.js";

applyUgkRuntimePolicy();

// 扩展文件绝对路径(与 cwd 无关,基于本文件位置定位)
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const userArgs = process.argv.slice(2);

if (isTaskInstallCommand(userArgs)) {
	process.exit(await runTaskInstallCli(userArgs, { stdout: process.stdout, stderr: process.stderr }));
}
if (isTaskRemoveCommand(userArgs)) {
	process.exit(await runTaskRemoveCli(userArgs, { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }));
}
if (isTaskUpdateCommand(userArgs)) {
	process.exit(await runTaskUpdateCli(userArgs, { stdout: process.stdout, stderr: process.stderr }));
}

const update = await runUgkUpdatePreflight({
	argv: userArgs,
	packageRoot,
});
if (update.action === "exit") {
	process.exit(update.exitCode ?? 0);
}

const trust = await ensureWorkspaceTrusted();
if (!trust.trusted) {
	console.error(trust.reason || "Workspace trust declined.");
	process.exit(1);
}

const { CustomEditor, InteractiveMode, main } = await import("@earendil-works/pi-coding-agent");
installUgkEditorBorderGlyphPatch(CustomEditor);
// Install pi patches; warn if either fails to apply (e.g. pi upgrade changed internals).
if (!installUgkSessionViewPatch({ InteractiveMode })) {
	console.warn("ugk: session-view patch did not apply (pi version drift?). Session switching may be limited.");
}
if (!installUgkPackageUpdatePatch({ InteractiveMode })) {
	console.warn("ugk: package-update patch did not apply (pi version drift?). 'Run pi update' notices may reappear.");
}
if (!installUgkExtensionOverlayPatch({ InteractiveMode })) {
	console.warn("ugk: extension-overlay patch did not apply (pi version drift?). Extension inputs may flicker while Working is visible.");
}

ensureUgkQuietStartupDefault();

// 透传用户参数,追加 -e 注入我们的扩展
await main(buildUgkCliArgs(userArgs, packageRoot));
