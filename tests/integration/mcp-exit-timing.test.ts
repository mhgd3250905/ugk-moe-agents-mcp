import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubServerPath = fileURLToPath(new URL("../fixtures/mcp-stub-server.mjs", import.meta.url));
const registryPath = fileURLToPath(new URL("../../extensions/mcp/registry.ts", import.meta.url));
const indexPath = fileURLToPath(new URL("../../extensions/mcp/index.ts", import.meta.url));

function listProcessCommandLines(): string {
	if (process.platform !== "win32") {
		return spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout;
	}

	return spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object -ExpandProperty CommandLine",
		],
		{ encoding: "utf8" },
	).stdout;
}

function countMarkedStubProcesses(marker: string): number {
	return listProcessCommandLines()
		.split(/\r?\n/)
		.filter((line) => line.includes("mcp-stub-server.mjs") && line.includes(marker)).length;
}

async function waitForMarkedStubProcesses(marker: string, count: number): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (countMarkedStubProcesses(marker) === count) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	assert.equal(countMarkedStubProcesses(marker), count);
}

test("SIGINT to host process synchronously kills MCP child processes", { timeout: 30_000 }, async () => {
	const marker = `ugk-exit-${process.pid}-${Date.now()}`;
	const runner = path.join(os.tmpdir(), `${marker}.mjs`);
	let child: ChildProcess | undefined;

	fs.writeFileSync(
		runner,
		`
import { registerMcp } from ${JSON.stringify(pathToFileURL(indexPath).href)};
import { McpRegistry } from ${JSON.stringify(pathToFileURL(registryPath).href)};

const pi = {
  on() {},
  registerCommand() {},
  getActiveTools() { return []; },
  setActiveTools() {},
};
const state = registerMcp(pi, { registry: new McpRegistry() });
await state.registry.connect("stub", { command: process.execPath, args: [${JSON.stringify(stubServerPath)}, ${JSON.stringify(marker)}] }, { connectTimeoutMs: 1000, listToolsTimeoutMs: 1000 });
process.stderr.write("READY\\n");
setInterval(() => {}, 1000);
`,
	);

	try {
		child = spawn(process.execPath, [runner], { stdio: ["ignore", "ignore", "pipe"] });
		await waitForReady(child);
		assert.equal(countMarkedStubProcesses(marker), 1);

		child.kill("SIGINT");
		await waitForExit(child);
		await waitForMarkedStubProcesses(marker, 0);
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
		}
		fs.rmSync(runner, { force: true });
	}
});

function waitForReady(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("READY timeout")), 15_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`runner exited before READY: code=${code} signal=${signal}`));
		});
		child.stderr?.on("data", (chunk) => {
			if (String(chunk).includes("READY")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once("exit", () => resolve()));
}
