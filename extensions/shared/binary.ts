import fs from "node:fs";
import path from "node:path";

// ponytail: 纯 Node 的 which/where 实现,无子进程。原版在 chrome-cdp/launcher.ts,
// task 的 requiredBinaries 前置校验也要用 —— 下沉到 shared/ 让两边复用,避免重复
// (task/ 不能 import chrome-cdp/,架构守卫强制)。
// 跨平台:遍历 PATH(path.delimiter),Windows 按 PATHEXT 补后缀,fs.existsSync 探测。
export function findCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const pathValue = env.PATH ?? "";
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
		const lowerCommand = command.toLowerCase();
		const candidates = extensions.map((ext) =>
			path.join(dir, lowerCommand.endsWith(ext.toLowerCase()) ? command : `${command}${ext}`),
		);
		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) return candidate;
			} catch {
				// Ignore unreadable PATH entries.
			}
		}
	}
	return null;
}

// 薄封装:给 task 的 requiredBinaries 校验用,只关心"在不在"。
export function isBinaryAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return findCommandOnPath(command, env) !== null;
}
