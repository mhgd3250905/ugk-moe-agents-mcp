import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	callTool,
	closeClient,
	connectStdio,
	createMcpClient,
	killStdioTransportProcess,
	listTools,
} from "../../extensions/mcp/client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, "..", "fixtures", "mcp-stub-server.mjs");
const hangingServerPath = path.join(__dirname, "..", "fixtures", "mcp-hanging-server.mjs");

function getClientProcessPid(client: ReturnType<typeof createMcpClient>): number | undefined {
	return (client as any)._transport?._process?.pid;
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (!isProcessRunning(pid)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(isProcessRunning(pid), false);
}

test("connects to a stdio stub server and lists tools", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });
	const tools = await listTools(client, { timeoutMs: 1000 });
	await closeClient(client);

	assert.equal(Array.isArray(tools), true);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["echo", "sum"],
	);
});

test("calls a tool and returns its content", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });
	const result = await callTool(client, "echo", { message: "hello" }, { timeoutMs: 1000 });
	await closeClient(client);

	assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);
});

test("closeClient terminates the stdio child process", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });
	const pid = getClientProcessPid(client);
	assert.equal(typeof pid, "number");

	await closeClient(client);

	await waitForProcessExit(pid);
});

test("closeClient is idempotent", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });

	await closeClient(client);
	await closeClient(client);
});

test("killStdioTransportProcess warns when SDK child process field is unavailable", () => {
	let stderr = "";
	const originalWrite = process.stderr.write;
	process.stderr.write = ((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;

	try {
		killStdioTransportProcess({ _process: undefined } as any);
	} finally {
		process.stderr.write = originalWrite;
	}

	assert.match(stderr, /warning: StdioClientTransport\._process unavailable/);
});

test("connectStdio fails with timeout when a server never responds", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });
	const promise = connectStdio(client, { command: process.execPath, args: [hangingServerPath] }, { timeoutMs: 100 });
	await new Promise((resolve) => setTimeout(resolve, 25));
	const pid = getClientProcessPid(client);

	await assert.rejects(
		promise,
		/timeout|timed out|Request timed out/i,
	);
	await closeClient(client);
	if (pid) await waitForProcessExit(pid);
});

test("connectStdio abort signal interrupts a pending connection", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });
	const controller = new AbortController();
	const promise = connectStdio(
		client,
		{ command: process.execPath, args: [hangingServerPath] },
		{ timeoutMs: 5000, signal: controller.signal },
	);
	await new Promise((resolve) => setTimeout(resolve, 25));
	const pid = getClientProcessPid(client);

	controller.abort();

	await assert.rejects(promise, /abort|aborted/i);
	await closeClient(client);
	if (pid) await waitForProcessExit(pid);
});
