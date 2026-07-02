/**
 * cron 工具 — ugk 内管理定时任务(代理本地 cron 服务的 HTTP API)
 *
 * 用法示例:
 *   - action=status      查服务是否在线
 *   - action=list        列出所有任务
 *   - action=add         新增任务(需 schedule + prompt)
 *   - action=remove      删除任务(需 id)
 *   - action=history     查执行历史(可指定 id 查单个任务)
 *
 * 服务地址 http://127.0.0.1:17741,需先 `npm run cron:start` 启动。
 * 用 StringEnum(非 Type.Union)以兼容 Google API(官方 README 警告)。
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CRON_PATHS,
	formatCronHealth,
	formatCronJobCreated,
	formatCronJobList,
	formatCronRunHistory,
	type CronJob,
	type CronRun,
} from "./cron-contract.ts";

const CRON_BASE = process.env.UGK_CRON_URL || "http://127.0.0.1:17741";

/** 调 cron 服务,返回 { ok, data } 或 { ok:false, error } */
async function callCron(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; data?: any; error?: string }> {
	try {
		const res = await fetch(`${CRON_BASE}${path}`, {
			method,
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			return { ok: false, error: (data as any).error || `HTTP ${res.status}` };
		}
		return { ok: true, data };
	} catch (e: any) {
		// 连接失败 = 服务没起
		if (e?.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(e?.message || "")) {
			return {
				ok: false,
				error: "cron 服务未启动。请在另一个终端运行:npm run cron:start",
			};
		}
		return { ok: false, error: e?.message || String(e) };
	}
}

const cronTool = defineTool({
	name: "cron",
	label: "Cron",
	description:
		"管理 ugk 定时任务(需先启动 cron 服务:npm run cron:start)。action=status 查服务状态;list 列任务;add 新增(schedule 用标准 5 段 crontab + prompt 任务描述);remove 删除(需 id);history 查执行历史。任务到点会自动起 ugk 子进程执行 prompt,结果存 ~/.pi/agent/cron-output/",
	parameters: Type.Object({
		action: StringEnum(["status", "list", "add", "remove", "history"] as const, {
			description: "status=服务状态 list=列任务 add=新增 remove=删除 history=执行历史",
		}),
		schedule: Type.Optional(
			Type.String({
				description: 'crontab 表达式(5段:分 时 日 月 周),如 "0 9 * * *" 每天9点,"* * * * *" 每分钟。add 时必填',
			}),
		),
		prompt: Type.Optional(
			Type.String({ description: "agent 任务描述,到点会用 ugk --print 执行。add 时必填" }),
		),
		name: Type.Optional(Type.String({ description: "任务名(add 时可选,默认自动生成)" })),
		model: Type.Optional(Type.String({ description: "指定模型(add 时可选,默认继承全局)" })),
		id: Type.Optional(Type.String({ description: "任务 id,remove 时必填" })),
	}),

	async execute(_toolCallId, params) {
		const action = params.action as string;

		// status
		if (action === "status") {
			const r = await callCron("GET", CRON_PATHS.health);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: `❌ ${r.error}` }],
					details: { online: false },
				};
			}
			const d = r.data;
			return {
				content: [{ type: "text", text: formatCronHealth(d, CRON_BASE) }],
				details: { online: true, ...d },
			};
		}

		// list
		if (action === "list") {
			const r = await callCron("GET", CRON_PATHS.jobs);
			if (!r.ok) return { content: [{ type: "text", text: `❌ ${r.error}` }], details: { ok: false } };
			const jobs = (r.data.jobs || []) as CronJob[];
			return {
				content: [{ type: "text", text: formatCronJobList(jobs) }],
				details: { jobs },
			};
		}

		// add
		if (action === "add") {
			if (!params.schedule || !params.prompt) {
				return {
					content: [{ type: "text", text: "❌ add 需要 schedule 和 prompt 参数。" }],
					details: { ok: false },
				};
			}
			const r = await callCron("POST", CRON_PATHS.jobs, {
				schedule: params.schedule,
				prompt: params.prompt,
				name: params.name,
				model: params.model,
			});
			if (!r.ok) return { content: [{ type: "text", text: `❌ ${r.error}` }], details: { ok: false } };
			const j = r.data.job as CronJob;
			return {
				content: [{ type: "text", text: formatCronJobCreated(j) }],
				details: { ok: true, job: j },
			};
		}

		// remove
		if (action === "remove") {
			if (!params.id) {
				return {
					content: [{ type: "text", text: "❌ remove 需要 id 参数(先用 list 查 id)。" }],
					details: { ok: false },
				};
			}
			const r = await callCron("DELETE", CRON_PATHS.job(params.id));
			if (!r.ok) return { content: [{ type: "text", text: `❌ ${r.error}` }], details: { ok: false } };
			return {
				content: [{ type: "text", text: `✅ 已删除任务:${params.id}` }],
				details: { ok: true, id: params.id },
			};
		}

		// history
		if (action === "history") {
			const r = params.id
				? await callCron("GET", CRON_PATHS.jobRuns(params.id))
				: await callCron("GET", CRON_PATHS.runs);
			if (!r.ok) return { content: [{ type: "text", text: `❌ ${r.error}` }], details: { ok: false } };
			const runs = (r.data.runs || []) as CronRun[];
			return {
				content: [{ type: "text", text: formatCronRunHistory(runs) }],
				details: { runs },
			};
		}

		return { content: [{ type: "text", text: `未知 action: ${action}` }], details: {} };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(cronTool);
}
