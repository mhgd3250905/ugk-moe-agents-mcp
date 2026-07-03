/**
 * server.mjs — ugk-moe-agent 专家 MCP 网关入口。
 *
 * 暴露 3 个统一 tool(异步句柄模式,避开 60s callTool 超时):
 *   run_expert  — 启动专家任务,返回 jobId(<5s)
 *   check_job   — 查状态(running/pass/fail/error)+ 进度(<1s)
 *   get_result  — 取完成的任务结果(产物路径/摘要/failures)(<1s)
 *
 * 接入:用户在 user scope mcp.json 声明:
 *   { "mcpServers": { "ugk-experts": { "command": "node", "args": ["<dir>/gateway/server.mjs"] } } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadExperts, listExpertNames } from "./registry.mjs";
import { startExpert, checkJob, getResult } from "./runner.mjs";
import { checkRequirements, applyConfig, missingRequirementsError } from "./requirements.mjs";

const server = new Server(
	{ name: "ugk-experts", version: "0.1.0" },
	{
		capabilities: { tools: {} },
		instructions: [
			"ugk 专家 agent 网关。要跑专家任务,用三步:",
			"1) run_expert({expert, input}) 启动,拿 jobId;",
			"2) 轮询 check_job({jobId}) 直到 status 不是 running;",
			"3) get_result({jobId}) 取最终结果(产物路径 + 摘要,或 verify 失败原因)。",
			"专家列表见 run_expert 的 expert 参数 enum。",
		].join(" "),
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	const expertNames = await listExpertNames();
	return {
		tools: [
			{
				name: "run_expert",
				description: "启动专家任务,立即返回 jobId。任务异步执行,用 check_job 轮询进度。",
				inputSchema: {
					type: "object",
					properties: {
						expert: {
							type: "string",
							enum: expertNames,
							description: "专家名。已安装的专家见此 enum。",
						},
						input: {
							type: "object",
							description: "专家输入参数,结构由专家包 agent.json 的 inputSchema 定义。",
						},
					},
					required: ["expert", "input"],
				},
			},
			{
				name: "check_job",
				description: "查任务状态。status: running | pass | fail | error。pass/fail/error 表示已完成,可 get_result 取结果。",
				inputSchema: {
					type: "object",
					properties: {
						jobId: { type: "string", description: "run_expert 返回的 jobId" },
					},
					required: ["jobId"],
				},
			},
			{
				name: "get_result",
				description: "取已完成的任务结果。pass: 返回产物路径 + 专家摘要。fail: 返回 verify 的结构化失败原因。error: 返回错误诊断。",
				inputSchema: {
					type: "object",
					properties: {
						jobId: { type: "string", description: "run_expert 返回的 jobId" },
					},
					required: ["jobId"],
				},
			},
			{
				name: "doctor",
				description: "专家权限查询与配置(给小白用户用,全程对话不碰命令行)。两种模式:① 查询(只传 expert 或不传)→ 返回各专家所需权限 + 缺失项 + howToFix;② 应用(传 action:'apply' + env)→ 写入 API key 等非控制性配置。注意:consent 类(如 chrome_cdp 控制同意)MCP 无法代写,howToFix 会指引用户跑 CLI doctor。典型流程:先查询 → 把 howToFix 转达用户 → 用户给值 → 应用 → 再 run_expert。",
				inputSchema: {
					type: "object",
					properties: {
						expert: { type: "string", description: "专家名。不传则查所有专家。" },
						action: { type: "string", enum: ["apply"], description: "传 'apply' 进入应用模式(写入配置)。不传为查询模式。" },
						env: {
							type: "object",
							description: "应用模式:要写入的环境变量(API key 等),如 {MIMO_API_KEY:'sk-xxx'}。",
							additionalProperties: { type: "string" },
						},
					},
				},
			},
		],
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const name = request.params.name;
	const args = request.params.arguments ?? {};

	try {
		if (name === "run_expert") {
			const result = await startExpert({
				expert: String(args.expert ?? ""),
				input: args.input ?? {},
			});
			// 权限预检:缺权限时不 spawn,返回结构化缺失清单
			if ("missingRequirements" in result) {
				const errBody = missingRequirementsError(result.missingRequirements);
				return { isError: true, content: [{ type: "text", text: JSON.stringify(errBody, null, 2) }] };
			}
			const { jobId } = result;
			return { content: [{ type: "text", text: JSON.stringify({ jobId, status: "running", hint: "用 check_job 轮询,完成后 get_result 取结果" }) }] };
		}

		if (name === "check_job") {
			const jobId = String(args.jobId ?? "");
			const job = checkJob(jobId);
			if (!job) {
				return { isError: true, content: [{ type: "text", text: `jobId "${jobId}" 不存在` }] };
			}
			return { content: [{ type: "text", text: JSON.stringify({
				jobId: job.jobId,
				status: job.status,
				expert: job.expert,
				...(job.progress ? { progress: job.progress } : {}),
				...(job.endedAt ? { durationMs: job.endedAt - job.startedAt } : {}),
			}) }] };
		}

		if (name === "get_result") {
			const jobId = String(args.jobId ?? "");
			const result = getResult(jobId);
			if (!result) {
				return { isError: true, content: [{ type: "text", text: `jobId "${jobId}" 不存在` }] };
			}
			if (result.status === "running") {
				return { isError: true, content: [{ type: "text", text: `job "${jobId}" 还在运行,稍后再来` }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		}

		if (name === "doctor") {
			const experts = await loadExperts();
			const targetExpert = args.expert ? String(args.expert) : null;

			// 应用模式:写入 env(API key 等)。注意:consent 类被 requirements.applyConfig 拒绝。
			if (args.action === "apply") {
				if (!targetExpert) {
					return { isError: true, content: [{ type: "text", text: "apply 模式必须指定 expert" }] };
				}
				const pkg = experts.get(targetExpert);
				if (!pkg) {
					return { isError: true, content: [{ type: "text", text: `专家 "${targetExpert}" 不存在` }] };
				}
				// allowConsent=false:consent 类被拒(MCP 不能代写控制性权限,安全约束)
				applyConfig(pkg, { env: args.env || {} }, { allowConsent: false });
				const { requirements, missing } = await checkRequirements(pkg);
				return { content: [{ type: "text", text: JSON.stringify({
					expert: targetExpert,
					applied: true,
					requirements,
					ready: missing.length === 0,
					...(missing.length ? { stillMissing: missing } : {}),
				}, null, 2) }] };
			}

			// 查询模式:返回权限状态
			const targets = targetExpert ? [targetExpert] : [...experts.keys()];
			/** @type {any[]} */
			const report = [];
			for (const eName of targets) {
				const pkg = experts.get(eName);
				if (!pkg) continue;
				const { requirements, missing } = await checkRequirements(pkg);
				report.push({ expert: eName, ready: missing.length === 0, requirements, ...(missing.length ? { missing } : {}) });
			}
			return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
		}

		return { isError: true, content: [{ type: "text", text: `未知 tool: ${name}` }] };
	} catch (err) {
		return { isError: true, content: [{ type: "text", text: `执行失败: ${err?.message || String(err)}` }] };
	}
});

await server.connect(new StdioServerTransport());
