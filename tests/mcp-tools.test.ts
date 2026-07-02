import test from "node:test";
import assert from "node:assert/strict";
import {
	adaptSchema,
	buildToolName,
	createMcpToolDefinition,
	normalizeServerName,
	normalizeToolName,
	registerMcpTools,
	resolveNormalizedServerNames,
} from "../extensions/mcp/tools.ts";

function makePi() {
	const tools = new Map<string, any>();
	return {
		tools,
		pi: {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		},
	};
}

function makeConnection(name: string, tools: any[] = [], callResult: any = { content: [{ type: "text", text: "ok" }] }) {
	const calls: Array<{ toolName: string; args: Record<string, unknown>; opts: Record<string, unknown> }> = [];
	return {
		calls,
		connection: {
			name,
			tools,
			status: "connected",
			async callTool(toolName: string, args: Record<string, unknown>, opts: Record<string, unknown> = {}) {
				calls.push({ toolName, args, opts });
				return callResult;
			},
		},
	};
}

test("buildToolName uses server__tool format", () => {
	assert.equal(buildToolName("alpha", "echo"), "alpha__echo");
});

test("normalizes provider-safe server and tool names", () => {
	assert.equal(normalizeServerName("My Server_Name!"), "my-server-name-");
	assert.equal(normalizeToolName("Read File@Now"), "read-file-now");
	assert.equal(normalizeServerName("A".repeat(80)), "a".repeat(32));
	assert.equal(normalizeToolName("B".repeat(90)), "b".repeat(64));
});

test("server name normalization resolves collisions with suffixes and warnings", () => {
	const result = resolveNormalizedServerNames(["Foo Bar", "foo_bar", "FOO-BAR"]);

	assert.deepEqual(result.names, new Map([
		["Foo Bar", "foo-bar"],
		["foo_bar", "foo-bar-2"],
		["FOO-BAR", "foo-bar-3"],
	]));
	assert.equal(result.warnings.length, 2);
	assert.match(result.warnings[0], /foo_bar/i);
	assert.match(result.warnings[0], /foo-bar-2/);
});

test("registerMcpTools suffixes normalized MCP tool name collisions", async () => {
	const { pi, tools } = makePi();
	const { connection, calls } = makeConnection("Alpha", [
		{ name: "Echo!", inputSchema: { type: "object" } },
		{ name: "echo-", inputSchema: { type: "object" } },
	]);

	const result = registerMcpTools(pi as any, [connection as any]);

	assert.deepEqual([...tools.keys()], ["alpha__echo-", "alpha__echo--2"]);
	assert.deepEqual(result.registered, ["alpha__echo-", "alpha__echo--2"]);
	assert.deepEqual(result.registeredByServer.get("Alpha"), ["alpha__echo-", "alpha__echo--2"]);
	assert.equal(result.skipped.length, 0);
	await tools.get("alpha__echo--2").execute("call-1", { message: "hi" }, undefined, undefined, {});
	assert.deepEqual(calls.at(-1), { toolName: "echo-", args: { message: "hi" }, opts: {} });
	assert.match(result.warnings.join("\n"), /echo-.*alpha__echo--2/i);
});

test("registerMcpTools skips collisions with existing non-MCP tools", () => {
	const { pi, tools } = makePi();
	const { connection } = makeConnection("Alpha", [
		{ name: "echo", inputSchema: { type: "object" } },
	]);

	const result = registerMcpTools(pi as any, [connection as any], { existingToolNames: ["alpha__echo"] });

	assert.deepEqual([...tools.keys()], []);
	assert.deepEqual(result.registered, []);
	assert.deepEqual(result.registeredByServer.get("Alpha"), []);
	assert.equal(result.skipped.length, 1);
	assert.match(result.warnings.join("\n"), /alpha__echo/);
});

test("adaptSchema preserves JSON Schema fields through Type.Unsafe", () => {
	const schemas = [
		{ type: "string" },
		{ type: "number" },
		{ type: "boolean" },
		{ type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		{ type: "array", items: { type: "string" } },
		{ type: "string", enum: ["red", "green"] },
		{ oneOf: [{ type: "string" }, { type: "number" }] },
		{ anyOf: [{ type: "string" }, { type: "null" }] },
		{ type: ["string", "null"], nullable: true },
		{ type: "object", additionalProperties: { type: "number" } },
		{
			type: "object",
			properties: { item: { $ref: "#/$defs/Item" } },
			$defs: { Item: { type: "object", properties: { id: { type: "string" } } } },
		},
	];

	for (const schema of schemas) {
		assert.deepEqual(adaptSchema(schema), schema);
	}
});

test("execute routes to connection.callTool with original MCP tool name and params", async () => {
	const { connection, calls } = makeConnection("Raw Server", [], {
		content: [{ type: "text", text: "mcp result" }],
		structuredContent: { value: 1 },
	});
	const definition = createMcpToolDefinition(connection as any, {
		name: "Raw Tool",
		inputSchema: { type: "object" },
	} as any);

	const result = await definition.execute("call-1", { value: 1 }, undefined, undefined, {});

	assert.deepEqual(calls, [{ toolName: "Raw Tool", args: { value: 1 }, opts: {} }]);
	assert.deepEqual(result.content, [{ type: "text", text: "mcp result" }]);
	assert.equal(result.details.serverName, "raw-server");
	assert.equal(result.details.toolName, "raw-tool");
	assert.equal(result.details.registeredName, "raw-server__raw-tool");
	assert.deepEqual(result.details.result, {
		content: [{ type: "text", text: "mcp result" }],
		structuredContent: { value: 1 },
	});
});

test("policy blocked execute does not call connection.callTool and returns blocked details", async () => {
	const { connection, calls } = makeConnection("Alpha");
	const definition = createMcpToolDefinition(
		connection as any,
		{ name: "Echo", inputSchema: { type: "object" } } as any,
		{
			checkToolPolicy: async (context: any) => ({
				allowed: false,
				reason: `blocked ${context.registeredName}`,
			}),
		},
	);

	const result = await definition.execute("call-1", { message: "hi" }, undefined, undefined, {});

	assert.deepEqual(calls, []);
	assert.deepEqual(result, {
		content: [{ type: "text", text: "blocked alpha__echo" }],
		details: { blocked: true },
	});
});
