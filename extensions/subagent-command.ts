import * as fs from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./subagent-agents.ts";
import { uiText } from "./shared/ui-language.ts";

function inheritModelLabel(): string {
	return uiText("继承 main/default", "Inherit main/default");
}

function modelValue(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

export async function setAgentModel(filePath: string, model: string | undefined): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		const content = await fs.readFile(filePath, "utf8");
		const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
		if (!match) throw new Error("Agent file has no YAML frontmatter");

		let frontmatter = match[0];
		if (!model) {
			frontmatter = frontmatter.replace(/^model\s*:.*(?:\r?\n)?/m, "");
		} else if (/^model\s*:/m.test(frontmatter)) {
			frontmatter = frontmatter.replace(/^model\s*:.*$/m, `model: ${quoteYamlString(model)}`);
		} else {
			frontmatter = frontmatter.replace(/(\r?\n)---$/, `$1model: ${quoteYamlString(model)}$1---`);
		}
		await fs.writeFile(filePath, frontmatter + content.slice(match[0].length), "utf8");
	});
}

export default function registerSubagentCommand(pi: ExtensionAPI) {
	pi.registerCommand("subagent", {
		description: uiText("列出 subagent 并设置模型", "List subagents and set their model"),
		handler: async (_args, ctx) => {
			const { agents } = discoverAgents(ctx.cwd, "both");
			if (agents.length === 0) {
				ctx.ui.notify(uiText("没有找到 subagent。", "No subagents found."), "warning");
				return;
			}

			const agentLabels = new Map(
				agents.map((agent) => [
					`${agent.name} · ${agent.model ?? uiText("继承", "inherit")} · ${agent.source}`,
					agent,
				]),
			);
			const agentChoice = await ctx.ui.select(uiText("子代理", "Subagents"), Array.from(agentLabels.keys()));
			if (!agentChoice) return;
			const agent = agentLabels.get(agentChoice);
			if (!agent) return;

			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify(uiText("没有可用模型。请先配置 API 或使用 /login。", "No models available. Configure an API or use /login first."), "warning");
				return;
			}

			const modelLabels = new Map(models.map((model) => [`${modelValue(model)} · ${model.name}`, model]));
			const inherited = inheritModelLabel();
			const modelChoice = await ctx.ui.select(`${agent.name} ${uiText("模型", "model")}`, [inherited, ...modelLabels.keys()]);
			if (!modelChoice) return;

			const selected = modelChoice === inherited ? undefined : modelValue(modelLabels.get(modelChoice)!);
			await setAgentModel(agent.filePath, selected);
			ctx.ui.notify(uiText(`已保存 ${agent.name} 模型设置，下一次 subagent 调用生效。`, `${agent.name} model setting saved. It takes effect on the next subagent call.`), "info");
		},
	});
}
