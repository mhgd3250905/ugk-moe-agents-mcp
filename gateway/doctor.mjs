#!/usr/bin/env node
/**
 * doctor.mjs — CLI 权限检查与配置(交互式)。
 *
 * 这是给用户(尤其需要授予控制性权限时)用的兜底 CLI。
 * MCP doctor tool 不能写 consent(chrome_cdp 等),所以用户必须跑这个。
 *
 * 用法:node gateway/doctor.mjs [expert-name]
 *   不传名字 → 检查所有专家
 *   传名字 → 只检查/配置指定专家
 *
 * 交互:逐项问 y/n(consent 类)+ 输入值(env 类)。binary 类只报告不交互。
 * 结果写入各专家包的 config.json。
 */

import readline from "node:readline";
import { loadExperts } from "./registry.mjs";
import { checkRequirements, applyConfig } from "./requirements.mjs";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** @param {string} q @returns {Promise<string>} */
function ask(q) {
	return new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));
}

/** @param {string} q @returns {Promise<boolean>} */
async function askYesNo(q) {
	const ans = (await ask(q + " (y/n) ")).toLowerCase();
	return ans === "y" || ans === "yes";
}

/**
 * @param {import("./registry.mjs").ExpertPackage} pkg
 */
async function doctorExpert(pkg) {
	console.log(`\n=== ${pkg.name} ===`);
	console.log(pkg.description);
	const { requirements, missing } = await checkRequirements(pkg);

	if (missing.length === 0) {
		console.log("  ✓ 全部权限就绪");
		return;
	}

	console.log("  缺失:");
	for (const r of missing) {
		console.log(`    [${r.type}] ${r.name}`);
	}

	/** @type {{consents?: Record<string, boolean>, env?: Record<string, string>}} */
	const updates = {};

	for (const r of missing) {
		if (r.type === "consent") {
			const ok = await askYesNo(`  同意让 ${pkg.name} 控制 ${r.name}?`);
			if (ok) {
				if (!updates.consents) updates.consents = {};
				updates.consents[r.name] = true;
			}
		} else if (r.type === "env") {
			const val = await ask(`  输入 ${r.name} 的值(直接回车跳过):`);
			if (val) {
				if (!updates.env) updates.env = {};
				updates.env[r.name] = val;
			}
		} else if (r.type === "binary") {
			console.log(`  ⚠ ${r.name} 缺失,请自行安装后重跑 doctor。howToFix: ${r.howToFix}`);
		}
	}

	if (updates.consents || updates.env) {
		// CLI doctor 允许写 consent(allowConsent=true)
		applyConfig(pkg, updates, { allowConsent: true });
		console.log("  ✓ 已写入 config.json");
		const { missing: after } = await checkRequirements(pkg);
		if (after.length > 0) {
			console.log(`  剩余缺失:${after.map((m) => m.name).join(", ")}`);
		} else {
			console.log("  ✓ 全部就绪");
		}
	}
}

async function main() {
	const filterName = process.argv[2];
	const experts = await loadExperts();

	if (experts.size === 0) {
		console.log("未安装任何专家包。把专家包放到 ~/.pi/agent/experts/<name>/。");
		rl.close();
		return;
	}

	console.log(`检查 ${experts.size} 个专家的权限...`);

	const targets = filterName
		? (experts.has(filterName) ? [experts.get(filterName)] : null)
		: [...experts.values()];

	if (!targets) {
		console.log(`专家 "${filterName}" 不存在。已安装:${[...experts.keys()].join(", ")}`);
		rl.close();
		return;
	}

	for (const pkg of targets) {
		await doctorExpert(pkg);
	}

	// 最终汇总
	console.log("\n=== 汇总 ===");
	let allReady = true;
	for (const pkg of (filterName ? [experts.get(filterName)] : [...experts.values()])) {
		const { missing } = await checkRequirements(pkg);
		const ready = missing.length === 0;
		if (!ready) allReady = false;
		console.log(`  ${ready ? "✓" : "✗"} ${pkg.name}${ready ? "" : ` (缺:${missing.map((m) => m.name).join(",")})`}`);
	}
	console.log(allReady ? "\n所有专家就绪。" : "\n部分专家未就绪,见上文。");
	rl.close();
}

main().catch((err) => {
	console.error("doctor 出错:", err?.message || String(err));
	process.exit(1);
});
