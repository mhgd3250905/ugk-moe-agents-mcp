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
		],
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const name = request.params.name;
	const args = request.params.arguments ?? {};

	try {
		if (name === "run_expert") {
			const { jobId } = await startExpert({
				expert: String(args.expert ?? ""),
				input: args.input ?? {},
			});
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

		return { isError: true, content: [{ type: "text", text: `未知 tool: ${name}` }] };
	} catch (err) {
		return { isError: true, content: [{ type: "text", text: `执行失败: ${err?.message || String(err)}` }] };
	}
});

await server.connect(new StdioServerTransport());
