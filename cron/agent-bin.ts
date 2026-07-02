import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CronAgentBinDeps {
	execSync?: (command: string) => void;
}

// cron/ 位于仓库/包根下,dirname/.. 即根,bin/ugk.js 在根/bin/。
// 克隆用户既无全局 ugk 也无 pi —— 让 fallback 用 node + 随包 bin/ugk.js 绝对路径,
// 而不是回退到不存在的 pi(那会 ENOENT)。
const bundledUgkJs = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "bin", "ugk.js");

/**
 * 解析 cron 触发 agent 时用的命令。
 * 优先级:PATH 上的 ugk(全局安装) → node + 随包 bin/ugk.js(克隆/本地兜底)。
 * 返回的命令字符串通过 shell 执行(见 service.ts spawn 的 shell:true),
 * 因此 node + 绝对路径形态(含空格)也能正确解析。
 */
export function getCronAgentBin(deps: CronAgentBinDeps = {}): string {
	const run = deps.execSync ?? ((command: string) => execSync(command, { stdio: "ignore", timeout: 5000 }));
	try {
		run("ugk --version");
		return "ugk";
	} catch {
		// ponytail: 不回退 pi(克隆用户没有)。用 node 跑随包 bin/ugk.js —— 它就在本包里,
		// 克隆和 npm 安装场景都存在。process.execPath 是当前 node,跨平台可靠。
		// 路径含空格时用引号包裹(shell 执行)。
		return fs.existsSync(bundledUgkJs)
			? `"${process.execPath}" "${bundledUgkJs}"`
			: "pi";
	}
}
