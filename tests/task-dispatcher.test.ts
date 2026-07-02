import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import {
	buildTaskDispatcherPrompt,
	extractRuntimeInputFromText,
	resolveRuntimeInputFromText,
	setTaskDispatcherForTests,
} from "../extensions/task/task-dispatcher.ts";

const contract = {
	runtimeInput: ["text"],
	runtimeInputMeta: { text: { type: "string", default: "text" } },
	artifacts: [],
};

test("task dispatcher prompt includes skill contract and raw input", () => {
	const prompt = buildTaskDispatcherPrompt("# Skill", contract, "Hello 世界");

	assert.match(prompt, /contract\.runtimeInput/);
	assert.match(prompt, /runtimeInputMeta/);
	assert.match(prompt, /Hello 世界/);
	assert.match(prompt, /# Skill/);
});

test("extractRuntimeInputFromText parses fenced json", () => {
	assert.deepEqual(extractRuntimeInputFromText("```json\n{\"text\":\"Hello 世界\"}\n```"), { text: "Hello 世界" });
	assert.equal(extractRuntimeInputFromText("not json"), undefined);
});

test("resolveRuntimeInputFromText throws when dispatcher unavailable, even in interactive mode", async () => {
	// ponytail: dispatcher 配置错误一致性 —— 交互/headless 都抛错,不偷偷退化到逐字段 UI 问。
	// 用户在场也该知道"dispatcher 没配好",要么配好要么用 field=value,不该静默降级。
	const ctx = {
		ui: {
			input() { throw new Error("should not reach UI input — dispatcher error must throw first"); },
		},
	};
	await assert.rejects(
		async () => resolveRuntimeInputFromText(ctx, "# Skill", contract, "Hello 世界"),
		/dispatcher 模型不可用/,
	);
});

test("resolveRuntimeInputFromText merges dispatcher output with defaults", async () => {
	setTaskDispatcherForTests(async () => ({ text: "Hello 世界" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", {
			runtimeInput: ["text", "section"],
			runtimeInputMeta: {
				text: { type: "string" },
				section: { type: "string", default: "技术", required: false },
			},
		}, "Hello 世界");

		assert.deepEqual(value, { text: "Hello 世界", section: "技术" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText sends explicit field=value through dispatcher", async () => {
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => {
		dispatcherCalled = true;
		return { url: "https://x", page: 2 };
	});
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", {
			runtimeInput: ["url", "page"],
			runtimeInputMeta: {
				url: { required: true },
				page: { default: 1, required: false },
			},
		}, "https://x, page=2", undefined, true);
		assert.equal(dispatcherCalled, true);
		assert.deepEqual(value, { url: "https://x", page: 2 });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText does not let invalid allowedValues override dispatcher canonical output", async () => {
	setTaskDispatcherForTests(async () => ({ subtitlePath: "zh.srt", voice: "苏打" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", {
			runtimeInput: ["subtitlePath", "voice"],
			runtimeInputMeta: {
				subtitlePath: { required: true },
				voice: { default: "冰糖", allowedValues: ["冰糖", "苏打", "白桦"] },
			},
		}, "zh.srt voice=年轻男声", undefined, true);

		assert.deepEqual(value, { subtitlePath: "zh.srt", voice: "苏打" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText rejects dispatcher values outside allowedValues", async () => {
	setTaskDispatcherForTests(async () => ({ subtitlePath: "zh.srt", verbosity: "verbose" }));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", {
				runtimeInput: ["subtitlePath", "verbosity"],
				runtimeInputMeta: {
					subtitlePath: { required: true },
					verbosity: { default: "normal", allowedValues: ["normal", "talkative"] },
				},
			}, "zh.srt 话痨模式", undefined, true),
			/字段值不在允许范围.*verbosity/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText rejects invalid local allowedValues when dispatcher does not canonicalize them", async () => {
	setTaskDispatcherForTests(async () => ({ subtitlePath: "zh.srt" }));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", {
				runtimeInput: ["subtitlePath", "voice"],
				runtimeInputMeta: {
					subtitlePath: { required: true },
					voice: { default: "冰糖", allowedValues: ["冰糖", "苏打", "白桦"] },
				},
			}, "zh.srt voice=年轻男声", undefined, true),
			/dispatcher 未输出显式字段.*voice/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText sends explicit structured topN input through dispatcher", async () => {
	const topNContract = { runtimeInput: ["topN"] };
	let calls = 0;
	setTaskDispatcherForTests(async () => {
		calls += 1;
		return { topN: 3 };
	});
	try {
		assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "{\"topN\":3}", undefined, true), { topN: 3 });
		assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "topN: 3", undefined, true), { topN: 3 });
		assert.equal(calls, 2);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText routes natural-language topN to dispatcher", async () => {
	// ponytail: 自然语言("帮我查询知乎top3")交给 dispatcher,不在本地用正则抽。
	// 撤掉了 topN 正则捷径 —— 那是对自然语言的字符串比对,治标不治本。
	const topNContract = { runtimeInput: ["topN"] };
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { topN: 3 }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", topNContract, "帮我查询知乎top3", undefined, true);
		assert.equal(dispatcherCalled, true, "自然语言 topN 必须走 dispatcher");
		assert.deepEqual(value, { topN: 3 });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText throws when dispatcher model is unavailable and input is natural language", async () => {
	// ponytail: dispatcher 不可用(无 model/auth)是配置错误,显式抛错 —— 不静默退化到本地正则。
	// 自然语言 input 没有 local 结构化解析兜底,必须报错让用户配 dispatcher 或改用 field=value。
	const topNContract = { runtimeInput: ["topN"] };
	// 空 ctx → findModel 返回 undefined → callDispatcher 抛"模型不可用"。
	await assert.rejects(
		() => resolveRuntimeInputFromText({}, "# Skill", topNContract, "帮我查询知乎top3", undefined, true),
		/dispatcher 模型不可用/,
	);
});

test("resolveRuntimeInputFromText uses complete defaults for empty headless input", async () => {
	const value = await resolveRuntimeInputFromText({}, "# Skill", {
		runtimeInput: ["answerCount"],
		runtimeInputMeta: { answerCount: { default: 20 } },
	}, "", undefined, true);

	assert.deepEqual(value, { answerCount: 20 });
});

test("resolveRuntimeInputFromText uses dispatcher result for natural language input", async () => {
	setTaskDispatcherForTests(async () => ({ url: "https://b23.tv/xxx" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", { runtimeInput: ["url"] }, "把这个下下来 https://b23.tv/xxx");
		assert.deepEqual(value, { url: "https://b23.tv/xxx" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("task dispatcher uses the current session model", async () => {
	// ponytail: 用多字段 contract 才会走到 dispatcher(单字段现在本地解析,见 single-field 测试组)。
	// 这里专门测模型解析,不测解析路径。
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("```json\n{\"text\":\"Hello 世界\",\"section\":\"技术\"}\n```")]);
	const model = faux.getModel();
	let authModel;
	try {
		const value = await resolveRuntimeInputFromText({
			model,
			modelRegistry: {
				async getApiKeyAndHeaders(candidate: unknown) {
					authModel = candidate;
					return { ok: true, apiKey: "sk-test", headers: { "x-test": "1" } };
				},
			},
		}, "# Skill", { runtimeInput: ["text", "section"], runtimeInputMeta: { text: {}, section: {} } }, "Hello 世界");

		assert.equal(authModel, model);
		assert.deepEqual(value, { text: "Hello 世界", section: "技术" });
		assert.equal(faux.state.callCount, 1);
	} finally {
		faux.unregister();
	}
});

test("resolveRuntimeInputFromText reports dispatcher model usage", async () => {
	const faux = registerFauxProvider();
	const response = fauxAssistantMessage("```json\n{\"text\":\"Hello 世界\",\"section\":\"技术\"}\n```") as any;
	response.usage = {
		input: 120000,
		output: 30000,
		cacheRead: 5000,
		cacheWrite: 0,
		totalTokens: 155000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
	};
	faux.setResponses([response]);
	const model = faux.getModel();
	const usage: any[] = [];
	try {
		const value = await resolveRuntimeInputFromText({
			model,
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "sk-test", headers: {} };
				},
			},
		}, "# Skill", { runtimeInput: ["text", "section"], runtimeInputMeta: { text: {}, section: {} } }, "Hello 世界", undefined, false, (item: any) => usage.push(item));

		assert.deepEqual(value, { text: "Hello 世界", section: "技术" });
		assert.equal(usage.length, 1);
		assert.equal(usage[0].model, "faux/faux-1");
		assert.ok(usage[0].usage.input > 0);
		assert.ok(usage[0].usage.output > 0);
	} finally {
		faux.unregister();
	}
});

test("task dispatcher uses contract dispatcherModel override when available", async () => {
	// ponytail: 多字段,强制走 dispatcher。测的是 dispatcherModel 覆盖解析,不是解析路径本身。
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("```json\n{\"text\":\"override\",\"section\":\"技术\"}\n```")]);
	const model = faux.getModel();
	let findArgs: unknown[] | undefined;
	let authModel;
	try {
		const value = await resolveRuntimeInputFromText({
			model: { id: "fallback" },
			modelRegistry: {
				find(provider: string, modelId: string) {
					findArgs = [provider, modelId];
					return model;
				},
				async getApiKeyAndHeaders(candidate: unknown) {
					authModel = candidate;
					return { ok: true, apiKey: "sk-test", headers: {} };
				},
			},
		}, "# Skill", { runtimeInput: ["text", "section"], runtimeInputMeta: { text: {}, section: {} } }, "Hello 世界", "deepseek-v4-flash");

		assert.deepEqual(findArgs, ["deepseek", "deepseek-v4-flash"]);
		assert.equal(authModel, model);
		assert.deepEqual(value, { text: "override", section: "技术" });
	} finally {
		faux.unregister();
	}
});

// === required 门禁测试 ===
// 复现报告场景:contract 有 url(required) + page(optional, default:1)。
// 显式 field=value 也必须经过 dispatcher,local 只用于发现 dispatcher 是否漏字段。
const biliContract = {
	runtimeInput: ["url", "page"],
	runtimeInputMeta: {
		url: { description: "B站UP主主页视频链接", required: true },
		page: { description: "页码,从1开始", required: false, default: 1 },
	},
};

test("required gate: local partial hit still requires dispatcher to emit the explicit field", async () => {
	setTaskDispatcherForTests(async () => ({ url: "https://space.bilibili.com/12890453/upload/video", page: 1 }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://space.bilibili.com/12890453/upload/video, page=1");

		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1,
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: full local hit still goes through dispatcher", async () => {
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => {
		dispatcherCalled = true;
		return { url: "https://space.bilibili.com/12890453/upload/video", page: 1 };
	});
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", biliContract, "url=https://space.bilibili.com/12890453/upload/video page=1");

		assert.equal(dispatcherCalled, true);
		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1,
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: bare URL (local undefined) still routes to dispatcher", async () => {
	setTaskDispatcherForTests(async () => ({ url: "https://space.bilibili.com/12890453/upload/video" }));
	try {
		// 裸 URL:local 抽不出任何 field=value → undefined → 走 dispatcher
		const value = await resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://space.bilibili.com/12890453/upload/video");

		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1,
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("dispatcher unavailable (no model/auth) → throws explicitly instead of silent fallback", async () => {
	// ponytail: dispatcher 是唯一自然语言解析路径。模型/auth 不可用是配置错误,显式抛错,
	// 不再静默退化(否则会重新长出字符串比对补丁)。这个 throw 比"缺 required"更早更准。
	await assert.rejects(
		async () => resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://x.com, page=2", undefined, true),
		/dispatcher 模型不可用/,
	);
});

test("required gate: contract without required:true declarations does NOT gate (legacy compat)", async () => {
	// 保守语义:只有显式 required:true 才门禁。旧式 contract(无 required 字段)不门禁,
	// 保持旧行为不变——部分输入不会被拦截,不会从软失败变成硬失败。
	// 这是回归保护:防止"激活 required"误伤所有旧 taskbook。
	const legacyContract = { runtimeInput: ["text", "section"] };
	setTaskDispatcherForTests(async () => ({ text: "from-dispatcher", section: "x" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", legacyContract, "some natural language");
		assert.deepEqual(value, { text: "from-dispatcher", section: "x" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("structured legacy input still requires dispatcher", async () => {
	const legacyMultiContract = {
		runtimeInput: ["a", "b"],
		// 无 runtimeInputMeta,或 meta 里没有 required:true
	};
	await assert.rejects(
		() => resolveRuntimeInputFromText({}, "# Skill", legacyMultiContract, "a=hello", undefined, true),
		/dispatcher 模型不可用/,
	);
});

// === dispatcher 是唯一参数解析路径 ===
// 设计:裸值、自然语言、结构化输入一律交给 dispatcher(reasoningEffort=medium + 明确映射 prompt)。
// 本地只接明确的 "field=value" 和 JSON(确定性解析,不是猜)。撤掉了之前的单字段裸值捷径
// —— 那是针对特定 contract 形态打补丁,强化 dispatcher 后不需要。
// 下面这组用 dispatcher mock 验证:这些输入确实路由到 dispatcher,且 prompt 把映射规则讲清楚了。

test("bare URL routes to dispatcher (no local shortcut)", async () => {
	// 报告场景:bilibili_url = 裸 URL。强化前 local 解析失败 + dispatcher(minimal)抽不出 → 报错。
	// 现在:裸 URL 交给 dispatcher,它按字段名/描述判断裸值归属。
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { bilibili_url: "https://www.bilibili.com/video/BV1g87a69Ere/" }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill",
			{ runtimeInput: ["bilibili_url"], runtimeInputMeta: { bilibili_url: { required: true } } },
			"https://www.bilibili.com/video/BV1g87a69Ere/",
			undefined, true);
		assert.equal(dispatcherCalled, true, "裸 URL 必须走 dispatcher");
		assert.deepEqual(value, { bilibili_url: "https://www.bilibili.com/video/BV1g87a69Ere/" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("multi-field bare URL routes to dispatcher (spider: url + page default)", async () => {
	// 报告场景:bili-up-homepage-spider 双字段 url(required) + page(default=1)。
	// dispatcher 拿 contract 说明书,裸 URL 映射到 url,page 补 default。
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { url: "https://space.bilibili.com/12890453/upload/video" }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill",
			{
				runtimeInput: ["url", "page"],
				runtimeInputMeta: {
					url: { description: "B站UP主主页视频链接", required: true },
					page: { description: "页码,从1开始", required: false, default: 1 },
				},
			},
			"https://space.bilibili.com/12890453/upload/video",
			undefined, true);
		assert.equal(dispatcherCalled, true);
		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1, // default 补上
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("natural language with embedded URL routes to dispatcher", async () => {
	// "下载这个 https://x" → dispatcher 从句子里抽 url,不把整句当字段值。
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { url: "https://x" }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill",
			{ runtimeInput: ["url"] },
			"下载这个 https://x",
			undefined, true);
		assert.equal(dispatcherCalled, true);
		assert.deepEqual(value, { url: "https://x" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("buildTaskDispatcherPrompt instructs bare-value mapping and natural-language extraction", () => {
	// 验证强化后的 prompt 把映射规则讲清楚:裸值归字段、自然语言抽真值、别编造。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["url", "page"] }, "https://x");
	assert.match(prompt, /裸值.*按字段名或 description.*判断/);
	assert.match(prompt, /自然语言句子.*抽出字段的真实值/);
	assert.match(prompt, /参考词.*术语.*人名/);
	assert.match(prompt, /不要.*当字段值/);
	assert.match(prompt, /不要编造/);
});

// === required 门禁升级:字段值有效性(x-search 试金石踩出的坑)===
// 复现场景:dispatcher 输出的 JSON 合法,但某个 required 字段的值是无意义残片字符串
// (如 timeWindow:"{mode:")。旧 coversRequired 只看 key 存在 → 放行 → worker 拿到残片现编默认。
// 新 coversRequired 要求 required 字段"存在且值有效" → 残片视为解析失败 → headless 抛错。

const timeWindowContract = {
	runtimeInput: ["keyword", "startIso", "endIso"],
	runtimeInputMeta: {
		keyword: { description: "搜索关键词", required: true },
		startIso: { description: "窗口起 ISO", required: true },
		endIso: { description: "窗口止 ISO", required: true },
	},
};

test("required gate: dispatcher returns valid values → passes through", async () => {
	// 基线:三个 required 字段都有有效值,正常返回。
	setTaskDispatcherForTests(async () => ({
		keyword: "medtrum",
		startIso: "2026-06-15T00:00:00.000Z",
		endIso: "2026-06-22T00:00:00.000Z",
	}));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", timeWindowContract, "medtrum 上周", undefined, true);
		assert.deepEqual(value, {
			keyword: "medtrum",
			startIso: "2026-06-15T00:00:00.000Z",
			endIso: "2026-06-22T00:00:00.000Z",
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher returns a field with truncated-string value → throws (not passes through)", async () => {
	// ponytail: 机制层能抓的是"空值/缺失"。纯字符串残片(如 "{mode:") 对机制层是合法非空字符串,
	// 无法通用判别 —— 那是 verify 产物层的职责(校验 startIso 能否 parse 成日期)。
	// 这里测机制层能抓的:空对象值(dispatcher 想输出嵌套对象但没填内容)。
	const objectFieldContract = {
		runtimeInput: ["config"],
		runtimeInputMeta: { config: { description: "配置对象", required: true } },
	};
	setTaskDispatcherForTests(async () => ({ config: {} })); // 空对象 = 无效
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", objectFieldContract, "xxx", undefined, true),
			/字段值无效.*config/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher returns empty-string value → throws", async () => {
	// 空字符串/纯空白也算无效值(dispatcher 没真正算出东西)。
	setTaskDispatcherForTests(async () => ({
		keyword: "medtrum",
		startIso: "   ", // 纯空白
		endIso: "2026-06-22T00:00:00.000Z",
	}));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", timeWindowContract, "medtrum 上周", undefined, true),
			/字段值无效.*startIso/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher returns empty object value → throws", async () => {
	// 空对象 {} 也算无效(嵌套对象字段 dispatcher 没填内容)。
	const objectFieldContract = {
		runtimeInput: ["config"],
		runtimeInputMeta: { config: { description: "配置对象", required: true } },
	};
	setTaskDispatcherForTests(async () => ({ config: {} }));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", objectFieldContract, "xxx", undefined, true),
			/字段值无效.*config/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: error message distinguishes missing vs invalid fields", async () => {
	// ponytail: 报错要精准 —— 缺字段说缺,值无效说无效,不混淆。
	// keyword 缺失,startIso 是空白。报错应同时指出两者,且措辞区分。
	setTaskDispatcherForTests(async () => ({
		startIso: "   ", // 无效(空白)
		endIso: "2026-06-22T00:00:00.000Z",
		// keyword 缺失
	}));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", timeWindowContract, "xxx", undefined, true),
			(err: Error) => {
				assert.match(err.message, /缺失字段.*keyword/, "报错应指出缺失的 keyword");
				assert.match(err.message, /字段值无效.*startIso/, "报错应指出无效的 startIso");
				return true;
			},
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: valid non-required field with empty value does NOT trigger gate", async () => {
	// ponytail: 门禁只管 required 字段。非 required 字段值无效(如空串)不该触发门禁,
	// 它会走 default 补全或原样保留。这是"required 门禁"语义,不是"所有字段都校验"。
	const mixedContract = {
		runtimeInput: ["keyword", "note"],
		runtimeInputMeta: {
			keyword: { required: true },
			note: { required: false, default: "" },
		},
	};
	setTaskDispatcherForTests(async () => ({ keyword: "x", note: "" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", mixedContract, "x", undefined, true);
		// note 是空串但非 required → 不门禁,正常返回
		assert.deepEqual(value, { keyword: "x", note: "" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("buildTaskDispatcherPrompt emphasizes LLM compute capability and complete output", () => {
	// ponytail: 验证强化后的 prompt 告诉 dispatcher 它能算 + 必须输出完整值。
	// 这是配合机制层门禁的源头治理:让 dispatcher 少产出残片。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["startIso"] }, "上周");
	assert.match(prompt, /推理与计算/, "prompt 应说明 dispatcher 能算日期/推理");
	assert.match(prompt, /完整.*有效/, "prompt 应要求输出完整有效值");
	assert.match(prompt, /截断|半成品/, "prompt 应禁止截断/半成品输出");
});

test("buildTaskDispatcherPrompt injects the real current date so dispatcher computes relative times correctly", () => {
	// ponytail: 真实 bug —— dispatcher 算"上周"猜成 16 个月前(用训练数据日期)。
	// 修复:prompt 注入当前 UTC ISO + 本地时间 + 星期几,让相对时间算得准。
	// 这是机制层修复:任何需要算日期的 taskbook 都受益。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["startIso"] }, "上周");
	const now = new Date();
	const expectedIsoPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
	assert.match(prompt, /当前时间.*算相对时间时必须以此为基准/, "prompt 应明示当前时间作为计算基准");
	assert.ok(prompt.includes(expectedIsoPrefix), "prompt 应含真实当前日期 " + expectedIsoPrefix);
	assert.match(prompt, /星期几|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/, "prompt 应提供星期几(用于判断自然周边界)");
});

test("interactive UI prefills dispatcher's valid partial output instead of re-asking all fields", async () => {
	// ponytail: 钉死预填回归。dispatcher 部分成功(算对 keyword、漏 requiredField)时,
	// 交互式逐字段问询应预填 dispatcher 算出的有效值,而非用 contract 默认值全量重问。
	// 旧行为:partial 出 if 块作用域就丢,UI 用 inputDefault(contract) 全量重问,dispatcher 成果白费。
	const twoFieldContract = {
		runtimeInput: ["keyword", "requiredField"],
		runtimeInputMeta: {
			keyword: { required: true },
			requiredField: { required: true },
		},
	};
	// dispatcher 算出 keyword 的有效值,但漏了 requiredField → coversRequired false → 落交互路径。
	setTaskDispatcherForTests(async () => ({ keyword: "算好的关键词" }));
	try {
		const inputs: Array<{ title: string; prefill: string }> = [];
		const ctx = {
			ui: {
				input(title: string, prefill: string) {
					inputs.push({ title, prefill });
					// 用户只在 requiredField 填新值,keyword 用预填回车确认。
					return title.includes("requiredField") ? "用户补的值" : prefill;
				},
			},
		};
		const value = await resolveRuntimeInputFromText(ctx, "# Skill", twoFieldContract, "某个关键词", undefined, false);
		// 最终值:keyword 用 dispatcher 的 + 用户确认,requiredField 用用户补的。
		assert.deepEqual(value, { keyword: "算好的关键词", requiredField: "用户补的值" });
		// 关键断言:keyword 的预填应是 dispatcher 算出的值,不是 contract 默认值。
		const keywordInput = inputs.find((i) => i.title.includes("keyword"));
		assert.ok(keywordInput, "应问询 keyword");
		assert.equal(keywordInput.prefill, "算好的关键词", "keyword 预填应为 dispatcher 算出的有效值,而非 contract 默认");
		// requiredField dispatcher 没算出,预填回退到 contract 默认。
		const requiredInput = inputs.find((i) => i.title.includes("requiredField"));
		assert.ok(requiredInput, "应问询 requiredField");
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

// === 未声明字段门禁 ===
// 复现 session 019f236b 的真 bug:agent/dispatcher 传了 `maxChars=150`,
// 但合法字段是 `maxUnitChars`(默认 90)。旧行为:未知字段静默流到下游,
// maxUnitChars 回退默认 90,agent 以为设了 150 实际跑 90,完全不知情。
// 新行为:gate 硬失败,反馈里带可用字段列表,agent 能自己改对。
const translatorContract = {
	runtimeInput: ["subtitlePath", "maxUnitChars"],
	runtimeInputMeta: {
		subtitlePath: { description: "源字幕路径", required: true },
		maxUnitChars: { description: "每单元最大字数", required: false, default: 90 },
	},
};

test("unknown field gate: dispatcher returns undeclared field → throws with field list", async () => {
	// ponytail: dispatcher 吐出 maxChars(不在 runtimeInput 里),headless 必须硬失败。
	// 错误信息要同时含错误的字段名(maxChars)和可用字段列表(含 maxUnitChars),
	// agent 看到"maxChars 错了 + 可用 maxUnitChars"能立刻自己改对 —— 显式反馈。
	setTaskDispatcherForTests(async () => ({ subtitlePath: "x.srt", maxChars: 150 }));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", translatorContract, "x.srt maxChars=150", undefined, true),
			(err: Error) => {
				assert.match(err.message, /未声明字段.*maxChars/, "报错应指出未声明的 maxChars");
				assert.match(err.message, /可用字段.*maxUnitChars/, "报错应列出可用字段(含 maxUnitChars)");
				return true;
			},
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("unknown field gate: dispatcher outputs only declared fields → passes (regression)", async () => {
	// ponytail: 回归保护。全部合法字段正常通过,不被新 gate 误伤。
	setTaskDispatcherForTests(async () => ({ subtitlePath: "x.srt", maxUnitChars: 150 }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", translatorContract, "x.srt maxUnitChars=150", undefined, true);
		assert.deepEqual(value, { subtitlePath: "x.srt", maxUnitChars: 150 });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("unknown field gate: prompt instructs dispatcher to emit only declared fields", async () => {
	// ponytail: 源头治理 —— prompt 明确禁止输出未声明字段,和机制层硬失败双层防御。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["url"] }, "https://x");
	assert.match(prompt, /只输出.*声明的字段.*未声明字段.*解析失败/, "prompt 应禁止输出未声明字段");
});
