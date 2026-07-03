#!/usr/bin/env node
/**
 * ugk-moe-agent CLI 入口(npm bin 指向这里)
 *
 * 极薄包装:把 pi 作为内置依赖,用 -e 临时注入我们的扩展。
 * 用户打 `ugk` = 跑 pi + 自动加载 moe-agent 扩展能力。
 *
 * -e 走 temporary resolve(resource-loader.js),零全局副作用,不写 settings.json。
 * skills/prompts 通过 extensions/index.ts 的 resources_discover 事件随包加载。
 */

// pi 期望的运行时标记(见 pi cli.js:12)
process.env.PI_CODING_AGENT = "true";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildUgkCliArgs } from "./ugk-cli-args.js";
import { applyUgkRuntimePolicy, installUgkEditorBorderGlyphPatch } from "./ugk-runtime-policy.js";
import { ensureUgkQuietStartupDefault } from "./ugk-startup-settings.js";
import { ensureWorkspaceTrusted } from "./workspace-trust.js";

applyUgkRuntimePolicy();

// 扩展文件绝对路径(与 cwd 无关,基于本文件位置定位)
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const userArgs = process.argv.slice(2);

const trust = await ensureWorkspaceTrusted();
if (!trust.trusted) {
	console.error(trust.reason || "Workspace trust declined.");
	process.exit(1);
}

const { CustomEditor, main } = await import("@earendil-works/pi-coding-agent");
installUgkEditorBorderGlyphPatch(CustomEditor);

ensureUgkQuietStartupDefault();

// 透传用户参数,追加 -e 注入我们的扩展
await main(buildUgkCliArgs(userArgs, packageRoot));
