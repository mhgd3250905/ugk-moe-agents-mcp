import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
	callTool as callMcpTool,
	closeClient,
	connectStdio,
	createMcpClient,
	killClientProcess,
	listTools,
} from "./client.ts";
import { toError, type McpServerConfig } from "./config.ts";

export type McpConnectionStatus = "connected" | "failed" | "disconnected";

export type McpOperationOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type McpConnectOptions = {
	timeoutMs?: number;
	connectTimeoutMs?: number;
	listToolsTimeoutMs?: number;
	signal?: AbortSignal;
	canConnect?: (context: McpConnectPolicyContext) => boolean | Promise<boolean>;
	beforeConnect?: (context: McpConnectPolicyContext) => void | Promise<void>;
};

export type McpConnectPolicyContext = {
	name: string;
	config: McpServerConfig;
};

export class McpConnectionError extends Error {
	readonly connection: McpConnection;

	constructor(message: string, connection: McpConnection, cause?: unknown) {
		super(message, { cause });
		this.name = "McpConnectionError";
		this.connection = connection;
	}
}

export class McpConnection {
	readonly name: string;
	readonly client: Client;
	tools: Tool[];
	status: McpConnectionStatus;
	error?: Error;
	message?: string;

	private closePromise?: Promise<void>;

	constructor(name: string, client: Client) {
		this.name = name;
		this.client = client;
		this.tools = [];
		this.status = "disconnected";
	}

	static async create(
		name: string,
		config: McpServerConfig,
		opts: McpConnectOptions = {},
	): Promise<McpConnection> {
		const connection = new McpConnection(
			name,
			createMcpClient({ name: `ugk-mcp-${name}`, version: "1.0.0" }),
		);

		try {
			await connectStdio(connection.client, config, {
				timeoutMs: opts.connectTimeoutMs ?? opts.timeoutMs,
				signal: opts.signal,
			});
			connection.tools = await listTools(connection.client, {
				timeoutMs: opts.listToolsTimeoutMs ?? opts.timeoutMs,
				signal: opts.signal,
			});
			connection.status = "connected";
			return connection;
		} catch (error) {
			connection.status = "failed";
			const cause = toError(error);
			connection.error = new Error(`${cause.message} (command: ${config.command})`, { cause });
			connection.message = connection.error.message;
			await closeClient(connection.client);
			throw new McpConnectionError(
				`MCP server "${name}" failed to connect: ${connection.error.message}`,
				connection,
				error,
			);
		}
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown> = {},
		opts: McpOperationOptions = {},
	): Promise<CallToolResult> {
		if (this.status !== "connected") {
			throw new Error(`MCP server "${this.name}" is ${this.status}; cannot call tool "${toolName}"`);
		}

		return callMcpTool(this.client, toolName, args, opts);
	}

	async disconnect(): Promise<void> {
		if (this.closePromise) {
			return this.closePromise;
		}

		if (this.status === "disconnected") {
			return;
		}

		this.closePromise = closeClient(this.client).finally(() => {
			this.status = "disconnected";
			this.closePromise = undefined;
		});
		return this.closePromise;
	}

	killProcess(): void {
		killClientProcess(this.client);
		this.status = "disconnected";
	}
}

export class McpRegistry {
	readonly connections = new Map<string, McpConnection>();

	async connect(
		name: string,
		config: McpServerConfig,
		opts: McpConnectOptions = {},
	): Promise<McpConnection> {
		const policyContext = { name, config };
		const allowed = opts.canConnect ? await opts.canConnect(policyContext) : true;
		if (!allowed) {
			await this.disconnect(name);
			const connection = new McpConnection(
				name,
				createMcpClient({ name: `ugk-mcp-${name}`, version: "1.0.0" }),
			);
			connection.status = "failed";
			connection.error = new Error(`MCP server "${name}" blocked by spawn policy`);
			connection.message = connection.error.message;
			this.connections.set(name, connection);
			throw new McpConnectionError(connection.message, connection, connection.error);
		}

		await opts.beforeConnect?.(policyContext);
		await this.disconnect(name);

		try {
			const connection = await McpConnection.create(name, config, opts);
			this.connections.set(name, connection);
			return connection;
		} catch (error) {
			if (error instanceof McpConnectionError) {
				this.connections.set(name, error.connection);
			}
			throw error;
		}
	}

	get(name: string): McpConnection | undefined {
		return this.connections.get(name);
	}

	async disconnect(name: string): Promise<void> {
		await this.connections.get(name)?.disconnect();
	}

	async disconnectAll(): Promise<void> {
		await Promise.all(Array.from(this.connections.values(), (connection) => connection.disconnect()));
	}

	killAllProcesses(): void {
		for (const connection of this.connections.values()) {
			connection.killProcess();
		}
	}
}
