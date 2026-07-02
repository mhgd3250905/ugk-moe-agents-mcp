/**
 * TUI 上传 taskbook 到市场(打包 + Bearer 上传)。
 *
 * 设计见 docs/design/2026-07-01-task-publish-from-tui.md §6.5。
 * 读 LoadedTaskbook 5 个核心文件 + 扫描目录下的额外文件(含 scripts/) → 清空 runs 历史 → zip → multipart 上传。
 * 认证由 task-share-auth.ts 的 task-share.json (cli_token) 提供。
 *
 * 引用完整性:skill.md/verify.mjs 里 $TASK_DIR/scripts/<x> 引用的文件必须能在包里找到,
 * 否则发布中止(早失败,避免 install 后 task 残废)。服务端 submitTask 有同源兜底校验。
 */

import { zipSync } from "fflate";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { LoadedTaskbook } from "./task-book.ts";

/** 可注入依赖(便于单测)。 */
export interface TaskSharePublishDeps {
	fetchFn?: typeof fetch;
}

export interface PublishResult {
	ok: true;
	name: string;
	version: string;
}

const CORE_FILES = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"] as const;

// 排除规则:打包时跳过这些。核心 5 文件由 buildTaskZip 单独构造(sanitized),不靠目录扫描。
// ponytail: 所有 task 的测试文件实测统一为 *.test.mjs,加 *.spec.* / __tests__/ 是 YAGNI。
const SKIP_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);
const SKIP_SUFFIXES = [".test.mjs", ".log"];

function shouldSkip(relPath: string): boolean {
	const parts = relPath.split("/");
	if (parts.some((p) => SKIP_DIRS.has(p))) return true;
	if (relPath.endsWith(".DS_Store")) return true;
	return SKIP_SUFFIXES.some((s) => relPath.endsWith(s));
}

/**
 * 递归扫描 task 目录,返回除核心 5 文件 + 测试/垃圾外的所有文件相对路径。
 * 目录不存在时返回空数组(向后兼容无 dir 的场景,如纯内存 LoadedTaskbook)。
 */
export async function collectExtraFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(current: string, relBase: string): Promise<void> {
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return; // 目录不存在/不可读 → 无额外文件
		}
		for (const entry of entries) {
			const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
			if (shouldSkip(rel)) continue;
			const abs = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(abs, rel);
			} else if (entry.isFile() && !(CORE_FILES as readonly string[]).includes(rel)) {
				results.push(rel);
			}
		}
	}
	await walk(dir, "");
	return results.sort();
}

/**
 * 从 LoadedTaskbook 构造上传用 zip。
 * 关键:taskbook.json 的 runs 历史必须清空(文档 §6.5 注 + §10 风险②),
 * 避免把本地运行记录传到市场。
 *
 * 除核心 5 文件外,扫描 loaded.dir 下的额外文件(如 scripts/*.mjs)一并打包;
 * 排除测试文件(*.test.mjs)和垃圾。
 */
export async function buildTaskZip(loaded: LoadedTaskbook): Promise<Uint8Array> {
	// 浅拷贝 taskbook 并清空 runs,不动原对象(它可能仍在内存被其他逻辑用)。
	const taskbookSanitized = { ...loaded.taskbook, runs: [] };
	const encoder = new TextEncoder();
	const files: Record<string, Uint8Array> = {
		"taskbook.json": encoder.encode(JSON.stringify(taskbookSanitized, null, "\t") + "\n"),
		"spec.json": encoder.encode(JSON.stringify(loaded.spec, null, "\t") + "\n"),
		"contract.json": encoder.encode(JSON.stringify(loaded.contract, null, "\t") + "\n"),
		"skill.md": encoder.encode(loaded.skill),
		"verify.mjs": encoder.encode(loaded.verify),
	};
	// 扫描目录加载额外文件(scripts/ 等)。dir 不存在则跳过(只打核心 5 文件)。
	if (loaded.dir) {
		const extras = await collectExtraFiles(loaded.dir);
		for (const rel of extras) {
			try {
				files[rel] = encoder.encode(await readFile(path.join(loaded.dir, rel), "utf8"));
			} catch {
				// 单个文件读取失败(并发删除等)→ 跳过,不阻塞打包
			}
		}
	}
	return zipSync(files);
}

/**
 * 从文本中提取被引用的 scripts 文件相对路径。
 * 覆盖实测样本的引用形式:
 *   - `读 $TASK_DIR/scripts/dom-collector.js` → scripts/dom-collector.js
 *   - `node "$TASK_DIR/scripts/make-fluent-subtitle.mjs"` → scripts/make-fluent-subtitle.mjs
 *   - 裸 `scripts/foo.mjs`(无 $TASK_DIR 前缀)→ scripts/foo.mjs
 * 纯函数,本地(TS)与服务端 marketplace.js(纯 JS 复制版)同源。
 */
export function extractScriptReferences(text: string): string[] {
	// ponytail: 不引第三方正则库。匹配 $TASK_DIR/scripts/x 或 \bscripts/x,文件名含 . 扩展。
	const re = /(?:\$TASK_DIR\/)?(scripts\/[A-Za-z0-9._\-\/]+\.[A-Za-z0-9]+)/g;
	const hits = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		hits.add(m[1].replace(/['"\s]/g, ""));
	}
	return [...hits];
}

/**
 * 校验 skill.md / verify.mjs 引用的 scripts 文件都在打包集里。
 * @param packagedFiles 即将打包的文件相对路径列表(核心 5 + extras)
 * @throws Error 引用的文件不在包里 —— 早失败,避免发布残废 task。
 */
export function assertReferencedFilesExist(skill: string, verify: string, packagedFiles: string[]): void {
	const packaged = new Set(packagedFiles);
	const sources: Array<[string, string]> = [["skill.md", skill], ["verify.mjs", verify]];
	for (const [label, text] of sources) {
		for (const ref of extractScriptReferences(text)) {
			if (!packaged.has(ref)) {
				throw new Error(`发布中止:${label} 引用了 ${ref},但该文件不存在于 task 目录(无法打包)。请确认文件存在且未被排除规则跳过。`);
			}
		}
	}
}

/**
 * 打包并上传 taskbook 到市场。
 * @param title 自定义标题(市场卡片用);空则回退 taskbook.name。
 * @param description 自定义一句话描述(市场卡片用);空则回退 taskbook.description。
 *   两者分离是因为 taskbook.description 是给 agent 的运行指令(常很长),
 *   不适合市场卡片给人看的简短文案。
 * @throws Error 引用文件缺失 / 上传失败(网络/鉴权/校验)。
 */
export async function publishTask(
	loaded: LoadedTaskbook,
	version: string,
	token: string,
	marketplaceUrl: string,
	title: string | undefined,
	description: string | undefined,
	deps: TaskSharePublishDeps = {},
): Promise<PublishResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	// 先确认将打包的文件清单,做引用完整性校验(早失败),再构造 zip。
	const extras = loaded.dir ? await collectExtraFiles(loaded.dir) : [];
	assertReferencedFilesExist(loaded.skill, loaded.verify, [...CORE_FILES, ...extras]);
	const zip = await buildTaskZip(loaded);
	const name = loaded.taskbook.name;

	const form = new FormData();
	form.set("name", name);
	form.set("version", version);
	form.set("title", title || name);
	form.set("description", description || loaded.taskbook.description);
	form.set("artifact", new File([zip as BlobPart], `${name}-${version}.zip`, { type: "application/zip" }));

	const res = await fetchFn(`${marketplaceUrl}/api/tasks/submit`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: form,
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
		throw new Error(`上传失败:${detail}`);
	}
	return { ok: true, name, version };
}
