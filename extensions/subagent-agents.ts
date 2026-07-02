/**
 * Subagent 配置发现与加载
 *
 * 从官方 examples/extensions/subagent/agents.ts 照搬(不造轮子)。
 * 改动:仅补充中文注释。
 *
 * agent 定义为 .md 文件 + YAML frontmatter:
 *   ---
 *   name: scout
 *   description: 快速代码侦察
 *   tools: read, grep, find, ls, bash
 *   model: deepseek-v4-flash
 *   ---
 *   <system prompt body>
 *
 * 加载位置:
 *   - user 级:~/.pi/agent/agents/*.md(始终加载,默认)
 *   - project 级:.pi/agents/*.md(仅 agentScope 为 project/both 时加载,且交互确认)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

// 随包 agents/ 目录(scout/planner/reviewer/checker/worker)。本文件位于 extensions/,
// dirname/.. 即仓库/包根,与 index.ts:115 的 packageRoot 同公式。
// 让 discoverAgents 自动加载随包 agent → 出厂预装,用户无需手动 cp 到 ~/.pi/agent/agents/。
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installAgentsDir = path.join(packageRoot, "agents");

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "install" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** 从 cwd 向上查找最近的 .pi/agents 目录(project 级) */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// 随包 install agent 最先 set,优先级最低:被 user/project 同名 agent 覆盖。
	// 无论 scope 如何都加载 —— install 是可信的随包默认,不触发 confirmProjectAgents(只筛 source==="project")。
	// user 目录为空时,install 作兜底实现"装即用";非空时用户自定义覆盖随包默认。
	const installAgents = loadAgentsFromDir(installAgentsDir, "install");
	for (const agent of installAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
