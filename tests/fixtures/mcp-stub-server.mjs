import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "ugk-test-mcp-server", version: "1.0.0" },
	{ capabilities: { tools: {} }, instructions: "Use echo for test messages." },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echoes the provided message",
			inputSchema: {
				type: "object",
				properties: {
					message: { type: "string" },
				},
				required: ["message"],
			},
		},
		{
			name: "sum",
			description: "Adds two numbers",
			inputSchema: {
				type: "object",
				properties: {
					a: { type: "number" },
					b: { type: "number" },
				},
				required: ["a", "b"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "echo") {
		const message = String(request.params.arguments?.message ?? "");
		return { content: [{ type: "text", text: `echo:${message}` }] };
	}

	if (request.params.name === "sum") {
		const args = request.params.arguments ?? {};
		const total = Number(args.a ?? 0) + Number(args.b ?? 0);
		return { content: [{ type: "text", text: String(total) }] };
	}

	return {
		isError: true,
		content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
	};
});

await server.connect(new StdioServerTransport());
