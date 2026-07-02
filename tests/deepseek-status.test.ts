import test from "node:test";
import assert from "node:assert/strict";
import { getDeepSeekStatus } from "../extensions/deepseek-status.ts";

test("reports configured when DeepSeek API key exists in environment", () => {
	assert.equal(
		getDeepSeekStatus({
			env: { DEEPSEEK_API_KEY: "sk-test" },
			readFile: () => {
				throw new Error("auth should not be read when env is set");
			},
		}),
		"deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)",
	);
});

test("reports configured when pi login stored DeepSeek auth", () => {
	assert.equal(
		getDeepSeekStatus({
			env: {},
			authPath: "C:\\Users\\me\\.pi\\agent\\auth.json",
			readFile: () => JSON.stringify({ deepseek: { apiKey: "sk-login" } }),
		}),
		"deepseek: 已配置(pi login/auth.json, deepseek-chat/默认模型可用)",
	);
});

test("reports missing when neither environment nor pi auth has DeepSeek", () => {
	assert.equal(
		getDeepSeekStatus({
			env: {},
			authPath: "C:\\Users\\me\\.pi\\agent\\auth.json",
			readFile: () => JSON.stringify({ openai: { apiKey: "sk-openai" } }),
		}),
		"deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)",
	);
});
