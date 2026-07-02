import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatMcpStatus } from "../extensions/mcp/formatter.ts";

// ponytail: 锁死 import cycle 不回归。formatter 曾为拿 McpCommandState 类型反向 import
// commands.ts,形成 commands→formatter→commands cycle。现 formatter 自描述窄类型。
// 回归信号:formatter.ts 源码再次出现 import from "./commands"。
test("formatter.ts 不再 import commands.ts(import cycle 不回归)", () => {
	const source = fs.readFileSync(
		path.resolve("extensions/mcp/formatter.ts"),
		"utf8",
	);
	assert.doesNotMatch(
		source,
		/from\s+["']\.\/commands(\.ts)?["']/,
		"formatter.ts 重新 import 了 commands.ts —— MCP import cycle 回归",
	);
});

test("formatMcpStatus 用窄 state shape 渲染连接/工具/模式", () => {
	const status = formatMcpStatus({
		registry: {
			connections: [
				{ name: "alpha", status: "connected", tools: [{ name: "echo" }] } as any,
			],
		},
		permissionState: { mode: "ask" },
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		failedServers: new Map([["beta", "boom"]]),
		warnings: ["low mem"],
	});

	assert.match(status, /已连接 server: 1 \(alpha\)/);
	assert.match(status, /工具: 1/);
	assert.match(status, /权限模式: ask/);
	assert.match(status, /失败 server: beta \(boom\)/);
	assert.match(status, /警告: low mem/);
});
