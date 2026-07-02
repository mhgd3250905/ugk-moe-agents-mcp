import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

type ClientInfo = {
	name: string;
	version: string;
};

type StdioConfig = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
};

type OperationOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
};

type KillableProcess = {
	exitCode: number | null;
	kill(signal?: string): boolean;
	stdin?: { destroy(): void };
	stdout?: { destroy(): void };
	stderr?: { destroy(): void };
};

type StdioClientTransportWithProcess = StdioClientTransport & {
	_process?: KillableProcess | null;
};

const transports = new WeakMap<Client, StdioClientTransport>();
const closingClients = new WeakMap<Client, Promise<void>>();

export function createMcpClient({ name, version }: ClientInfo): Client {
	return new Client({ name, version });
}

export async function connectStdio(
	client: Client,
	{ command, args, env }: StdioConfig,
	opts: OperationOptions = {},
): Promise<void> {
	const transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
	transports.set(client, transport);

	try {
		await client.connect(transport, toRequestOptions(opts, DEFAULT_CONNECT_TIMEOUT_MS));
	} catch (error) {
		await closeTransport(client, transport);
		throw error;
	}
}

export async function listTools(client: Client, opts: OperationOptions = {}): Promise<Tool[]> {
	const result = await client.listTools(undefined, toRequestOptions(opts, DEFAULT_LIST_TIMEOUT_MS));
	return result.tools;
}

export async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
	opts: OperationOptions = {},
): Promise<CallToolResult> {
	return (await client.callTool(
		{ name, arguments: args },
		undefined,
		toRequestOptions(opts, DEFAULT_CALL_TIMEOUT_MS),
	)) as CallToolResult;
}

export async function closeClient(client: Client): Promise<void> {
	const existingClose = closingClients.get(client);
	if (existingClose) {
		return existingClose;
	}

	const closePromise = closeClientOnce(client).finally(() => {
		closingClients.delete(client);
	});
	closingClients.set(client, closePromise);
	return closePromise;
}

export function killClientProcess(client: Client): void {
	const transport = transports.get(client) as StdioClientTransportWithProcess | undefined;
	transports.delete(client);
	if (transport) {
		killStdioTransportProcess(transport);
	}
}

export function killStdioTransportProcess(transport: StdioClientTransportWithProcess): void {
	const child = transport._process;
	if (!child) {
		process.stderr.write(
			"ugk-mcp: warning: StdioClientTransport._process unavailable, child may not be killed (SDK version drift?)\n",
		);
		return;
	}

	child.stdin?.destroy();
	child.stdout?.destroy();
	child.stderr?.destroy();
	if (child.exitCode === null) {
		child.kill("SIGTERM");
	}
	transport._process = undefined;
}

function toRequestOptions(opts: OperationOptions, defaultTimeoutMs: number) {
	return {
		timeout: opts.timeoutMs ?? defaultTimeoutMs,
		signal: opts.signal,
	};
}

async function closeClientOnce(client: Client): Promise<void> {
	const transport = transports.get(client) as StdioClientTransportWithProcess | undefined;
	transports.delete(client);

	if (transport) {
		killStdioTransportProcess(transport);
	}
	await closeBestEffort([client.close(), transport?.close()]);
}

async function closeTransport(client: Client, transport: StdioClientTransport): Promise<void> {
	if (transports.get(client) === transport) {
		transports.delete(client);
	}

	killStdioTransportProcess(transport as StdioClientTransportWithProcess);
	await closeBestEffort([client.close(), transport.close()]);
}

async function closeBestEffort(promises: Array<Promise<unknown> | undefined>, timeoutMs = 100): Promise<void> {
	const pending = promises.filter((promise): promise is Promise<unknown> => Boolean(promise));
	if (pending.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled(pending),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}),
	]);
	if (timer) clearTimeout(timer);
}
