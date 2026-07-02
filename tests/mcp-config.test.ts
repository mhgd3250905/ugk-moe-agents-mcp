import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	interpolateEnv,
	loadInstallConfig,
	loadMcpConfig,
	loadProjectConfig,
	loadUserConfig,
	mergeConfigs,
	validateServerConfig,
} from "../extensions/mcp/config.ts";

function makeTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-config-"));
}

function writeJson(filePath: string, value: unknown) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

test("loads a valid project .mcp.json", () => {
	const cwd = makeTempDir();
	writeJson(path.join(cwd, ".mcp.json"), {
		mcpServers: {
			alpha: {
				command: "node",
				args: ["server.mjs"],
				env: { TOKEN: "plain-token" },
			},
		},
	});

	const config = loadProjectConfig(cwd);
	const alpha = config.servers.get("alpha");

	assert.equal(config.errors.length, 0);
	assert.equal(alpha?.name, "alpha");
	assert.equal(alpha?.scope, "project");
	assert.deepEqual(alpha?.config, {
		command: "node",
		args: ["server.mjs"],
		env: { TOKEN: "plain-token" },
	});
});

test("loads install config from the UGK package root", () => {
	const packageRoot = makeTempDir();
	writeJson(path.join(packageRoot, "mcp.json"), {
		mcpServers: {
			packaged: {
				command: "node",
				args: ["server.mjs"],
			},
		},
	});

	const config = loadInstallConfig(packageRoot);
	const packaged = config.servers.get("packaged");

	assert.equal(config.errors.length, 0);
	assert.equal(packaged?.name, "packaged");
	assert.equal(packaged?.scope, "install");
	assert.deepEqual(packaged?.config, {
		command: "node",
		args: ["server.mjs"],
	});
});

test("merges scopes with local overriding project overriding user overriding install", () => {
	const install = {
		servers: new Map([
			["shared", { name: "shared", scope: "install" as const, config: { command: "install-cmd" } }],
			["installOnly", { name: "installOnly", scope: "install" as const, config: { command: "install-only" } }],
		]),
		errors: [],
	};
	const user = {
		servers: new Map([
			["shared", { name: "shared", scope: "user" as const, config: { command: "user-cmd" } }],
			["userOnly", { name: "userOnly", scope: "user" as const, config: { command: "user-only" } }],
		]),
		errors: [],
	};
	const project = {
		servers: new Map([
			["shared", { name: "shared", scope: "project" as const, config: { command: "project-cmd" } }],
			["projectOnly", { name: "projectOnly", scope: "project" as const, config: { command: "project-only" } }],
		]),
		errors: [],
	};
	const local = {
		servers: new Map([
			["shared", { name: "shared", scope: "local" as const, config: { command: "local-cmd" } }],
			["localOnly", { name: "localOnly", scope: "local" as const, config: { command: "local-only" } }],
		]),
		errors: [],
	};

	const merged = mergeConfigs(install, user, project, local);

	assert.equal(merged.errors.length, 0);
	assert.equal(merged.servers.get("shared")?.scope, "local");
	assert.equal(merged.servers.get("shared")?.config.command, "local-cmd");
	assert.equal(merged.servers.get("installOnly")?.config.command, "install-only");
	assert.equal(merged.servers.get("userOnly")?.config.command, "user-only");
	assert.equal(merged.servers.get("projectOnly")?.config.command, "project-only");
	assert.equal(merged.servers.get("localOnly")?.config.command, "local-only");
});

test("higher scope replaces a same-name server without field-level merging", () => {
	const cwd = makeTempDir();
	const packageRoot = path.join(cwd, "package");
	const appData = path.join(cwd, "appdata");
	writeJson(path.join(packageRoot, "mcp.json"), {
		mcpServers: {
			shared: {
				command: "install-cmd",
				args: ["from-install"],
			},
		},
	});
	writeJson(path.join(appData, "ugk", "mcp.json"), {
		mcpServers: {
			shared: {
				command: "user-cmd",
				args: ["from-user"],
				env: { USER_TOKEN: "kept-only-in-user" },
			},
		},
	});
	writeJson(path.join(cwd, ".mcp.json"), {
		mcpServers: {
			shared: {
				command: "project-cmd",
				args: ["from-project"],
			},
		},
	});
	writeJson(path.join(cwd, ".mcp.local.json"), {
		mcpServers: {
			shared: {
				command: "local-cmd",
			},
		},
	});

	const merged = loadMcpConfig(cwd, {
		packageRoot,
		platform: "win32",
		env: { APPDATA: appData },
		homedir: () => path.join(cwd, "home"),
	});

	assert.equal(merged.errors.length, 0);
	assert.deepEqual(merged.servers.get("shared")?.config, { command: "local-cmd" });
});

test("higher scope invalid same-name server blocks lower scope fallback", () => {
	const cwd = makeTempDir();
	writeJson(path.join(cwd, ".mcp.json"), {
		mcpServers: {
			shared: {
				command: "project-cmd",
			},
		},
	});
	writeJson(path.join(cwd, ".mcp.local.json"), {
		mcpServers: {
			shared: {
				env: { TOKEN: "${MISSING_TOKEN}" },
			},
		},
	});

	const merged = loadMcpConfig(cwd, {
		platform: "linux",
		env: {},
		homedir: () => path.join(cwd, "home"),
		sourceEnv: {},
	});

	assert.equal(merged.servers.has("shared"), false);
	assert.equal(merged.errors.length, 1);
	assert.equal(merged.errors[0].scope, "local");
	assert.equal(merged.errors[0].serverName, "shared");
});

test("rejects a server when command is missing", () => {
	const result = validateServerConfig("missingCommand", { args: ["server.mjs"] });

	assert.equal(result.ok, false);
	assert.match(result.error, /missingCommand/);
	assert.match(result.error, /command/);
});

test("interpolates environment variables", () => {
	const result = interpolateEnv(
		{ TOKEN: "${UGK_TOKEN}", URL: "https://${UGK_HOST}/mcp" },
		{ UGK_TOKEN: "secret", UGK_HOST: "example.test" },
	);

	assert.deepEqual(result, {
		ok: true,
		value: { TOKEN: "secret", URL: "https://example.test/mcp" },
	});
});

test("reports a missing environment variable instead of replacing it with empty text", () => {
	const result = interpolateEnv({ TOKEN: "${MISSING_TOKEN}" }, {});

	assert.equal(result.ok, false);
	assert.equal(result.missingVar, "MISSING_TOKEN");
	assert.match(result.error, /MISSING_TOKEN/);
});

test("returns an empty config when no config files exist", () => {
	const cwd = makeTempDir();

	const config = loadMcpConfig(cwd, {
		packageRoot: path.join(cwd, "package"),
		platform: "linux",
		env: {},
		homedir: () => path.join(cwd, "home"),
	});

	assert.equal(config.errors.length, 0);
	assert.deepEqual(Array.from(config.servers.keys()), []);
});

test("reports non-JSON and schema errors clearly", () => {
	const nonJsonDir = makeTempDir();
	fs.writeFileSync(path.join(nonJsonDir, ".mcp.json"), "{not-json", "utf8");
	const nonJson = loadProjectConfig(nonJsonDir);

	assert.equal(nonJson.servers.size, 0);
	assert.equal(nonJson.errors.length, 1);
	assert.match(nonJson.errors[0].message, /JSON|parse/i);
	assert.match(nonJson.errors[0].filePath, /\.mcp\.json$/);

	const schemaDir = makeTempDir();
	writeJson(path.join(schemaDir, ".mcp.json"), { mcpServers: [] });
	const schema = loadProjectConfig(schemaDir);

	assert.equal(schema.servers.size, 0);
	assert.equal(schema.errors.length, 1);
	assert.match(schema.errors[0].message, /mcpServers/i);
});

test("resolves Windows user config from APPDATA and falls back to homedir when APPDATA is absent", () => {
	const cwd = makeTempDir();
	const appData = path.join(cwd, "appdata");
	const home = path.join(cwd, "home");
	writeJson(path.join(appData, "ugk", "mcp.json"), {
		mcpServers: { appDataServer: { command: "from-appdata" } },
	});
	writeJson(path.join(home, ".config", "ugk", "mcp.json"), {
		mcpServers: { homeServer: { command: "from-home" } },
	});

	const fromAppData = loadUserConfig({
		platform: "win32",
		env: { APPDATA: appData },
		homedir: () => home,
	});
	const fromHome = loadUserConfig({
		platform: "win32",
		env: {},
		homedir: () => home,
	});

	assert.deepEqual(Array.from(fromAppData.servers.keys()), ["appDataServer"]);
	assert.deepEqual(Array.from(fromHome.servers.keys()), ["homeServer"]);
});
