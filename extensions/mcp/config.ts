import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripBom } from "../shared/settings-io.ts";

export type McpConfigScope = "install" | "user" | "project" | "local";

export type McpServerConfig = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
};

export type McpConfigEntry = {
	name: string;
	config: McpServerConfig;
	scope: McpConfigScope;
};

export type McpConfigError = {
	scope: McpConfigScope;
	filePath: string;
	message: string;
	serverName?: string;
	missingVar?: string;
};

export type McpConfig = {
	servers: Map<string, McpConfigEntry>;
	errors: McpConfigError[];
};

export type McpConfigLoadOptions = {
	packageRoot?: string;
	env?: Record<string, string | undefined>;
	sourceEnv?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	homedir?: () => string;
};

export function loadInstallConfig(packageRoot: string | undefined, opts: McpConfigLoadOptions = {}): McpConfig {
	if (!packageRoot) {
		return { servers: new Map(), errors: [] };
	}
	return loadConfigFile(path.join(packageRoot, "mcp.json"), "install", opts);
}

export function loadUserConfig(opts: McpConfigLoadOptions = {}): McpConfig {
	return loadConfigFile(resolveUserConfigPath(opts), "user", opts);
}

export function loadProjectConfig(cwd: string, opts: McpConfigLoadOptions = {}): McpConfig {
	return loadConfigFile(path.join(cwd, ".mcp.json"), "project", opts);
}

export function loadLocalConfig(cwd: string, opts: McpConfigLoadOptions = {}): McpConfig {
	return loadConfigFile(path.join(cwd, ".mcp.local.json"), "local", opts);
}

export function loadMcpConfig(cwd: string, opts: McpConfigLoadOptions = {}): McpConfig {
	return mergeConfigs(
		loadInstallConfig(opts.packageRoot, opts),
		loadUserConfig(opts),
		loadProjectConfig(cwd, opts),
		loadLocalConfig(cwd, opts),
	);
}

export function mergeConfigs(...configs: McpConfig[]): McpConfig {
	const servers = new Map<string, McpConfigEntry>();
	for (const config of configs) {
		for (const error of config.errors) {
			if (error.serverName) {
				servers.delete(error.serverName);
			}
		}
		for (const [name, entry] of config.servers) {
			servers.set(name, entry);
		}
	}

	return {
		servers,
		errors: configs.flatMap((config) => config.errors),
	};
}

export function validateServerConfig(
	name: string,
	cfg: unknown,
): { ok: true; value: McpServerConfig } | { ok: false; error: string } {
	if (!isRecord(cfg)) {
		return { ok: false, error: `MCP server "${name}" must be an object` };
	}

	if (typeof cfg.command !== "string" || cfg.command.length === 0) {
		return { ok: false, error: `MCP server "${name}" command is required and must be a string` };
	}

	if (cfg.args !== undefined && !isStringArray(cfg.args)) {
		return { ok: false, error: `MCP server "${name}" args must be a string array` };
	}

	if (cfg.env !== undefined && !isStringRecord(cfg.env)) {
		return { ok: false, error: `MCP server "${name}" env must be an object of string values` };
	}

	const value: McpServerConfig = { command: cfg.command };
	if (cfg.args !== undefined) {
		value.args = [...cfg.args];
	}
	if (cfg.env !== undefined) {
		value.env = { ...cfg.env };
	}
	return { ok: true, value };
}

export function interpolateEnv(
	env: Record<string, string>,
	sourceEnv: Record<string, string | undefined> = process.env,
): { ok: true; value: Record<string, string> } | { ok: false; missingVar: string; error: string } {
	const value: Record<string, string> = {};

	for (const [key, rawValue] of Object.entries(env)) {
		const missingVar = findMissingVar(rawValue, sourceEnv);
		if (missingVar) {
			return {
				ok: false,
				missingVar,
				error: `Environment variable "${missingVar}" is required for MCP env "${key}"`,
			};
		}

		value[key] = rawValue.replace(/\$\{([^}]+)\}/g, (_, varName: string) => sourceEnv[varName] ?? "");
	}

	return { ok: true, value };
}

function loadConfigFile(filePath: string, scope: McpConfigScope, opts: McpConfigLoadOptions): McpConfig {
	const servers = new Map<string, McpConfigEntry>();
	if (!fs.existsSync(filePath)) {
		return { servers, errors: [] };
	}

	let rawConfig: unknown;
	try {
		// BOM-safe:project/local scope 的 .mcp.json 是用户手编,PowerShell 保存会带
		// UTF-8 BOM,裸 parse 会抛错导致整个文件的所有 server 进 errors(failed)。
		rawConfig = JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
	} catch (error) {
		return {
			servers,
			errors: [toConfigError(scope, filePath, `Failed to parse JSON: ${toError(error).message}`)],
		};
	}

	if (!isRecord(rawConfig) || !isRecord(rawConfig.mcpServers)) {
		return {
			servers,
			errors: [toConfigError(scope, filePath, "MCP config must contain an object mcpServers field")],
		};
	}

	const errors: McpConfigError[] = [];
	for (const [name, cfg] of Object.entries(rawConfig.mcpServers)) {
		const validated = validateServerConfig(name, cfg);
		if (!validated.ok) {
			errors.push(toConfigError(scope, filePath, validated.error, name));
			continue;
		}

		const serverConfig = validated.value;
		if (serverConfig.env) {
			const interpolated = interpolateEnv(serverConfig.env, opts.sourceEnv ?? process.env);
			if (!interpolated.ok) {
				errors.push(
					toConfigError(scope, filePath, interpolated.error, name, interpolated.missingVar),
				);
				continue;
			}
			serverConfig.env = interpolated.value;
		}

		servers.set(name, { name, config: serverConfig, scope });
	}

	return { servers, errors };
}

function resolveUserConfigPath(opts: McpConfigLoadOptions): string {
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const homedir = opts.homedir ?? os.homedir;

	if (platform === "win32" && env.APPDATA) {
		return path.join(env.APPDATA, "ugk", "mcp.json");
	}

	return path.join(homedir(), ".config", "ugk", "mcp.json");
}

function toConfigError(
	scope: McpConfigScope,
	filePath: string,
	message: string,
	serverName?: string,
	missingVar?: string,
): McpConfigError {
	return { scope, filePath, message, serverName, missingVar };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function findMissingVar(value: string, sourceEnv: Record<string, string | undefined>): string | undefined {
	for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
		const varName = match[1];
		if (sourceEnv[varName] === undefined) {
			return varName;
		}
	}
	return undefined;
}

export function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}
