import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnection, McpOperationOptions } from "./registry.ts";

const SERVER_NAME_MAX_LENGTH = 32;
const TOOL_NAME_MAX_LENGTH = 64;

export type McpToolPolicyContext = {
	serverName: string;
	toolName: string;
	registeredName: string;
	reason: string;
	rawServerName: string;
	rawToolName: string;
	params: Record<string, unknown>;
	ctx?: unknown;
};

export type McpToolPolicyResult =
	| boolean
	| {
			allowed?: boolean;
			blocked?: boolean;
			reason?: string;
	  };

export type McpToolRegistrationOptions = {
	checkToolPolicy?: (context: McpToolPolicyContext) => McpToolPolicyResult | Promise<McpToolPolicyResult>;
	warn?: (message: string) => void;
	existingToolNames?: Iterable<string>;
};

export type McpToolRegistrationResult = {
	registered: string[];
	registeredByServer: Map<string, string[]>;
	skipped: Array<{ registeredName: string; serverName: string; toolName: string; reason: string }>;
	warnings: string[];
};

type McpToolDefinitionOptions = McpToolRegistrationOptions & {
	serverName?: string;
	toolName?: string;
	registeredName?: string;
};

type NormalizedServerNameEntry = {
	rawName: string;
	normalizedName: string;
	warning?: string;
};

export function normalizeServerName(raw: string): string {
	return normalizeProviderSafeName(raw, SERVER_NAME_MAX_LENGTH);
}

export function normalizeToolName(raw: string): string {
	return normalizeProviderSafeName(raw, TOOL_NAME_MAX_LENGTH);
}

export function buildToolName(serverName: string, toolName: string): string {
	return `${serverName}__${toolName}`;
}

export function adaptSchema(mcpInputSchema: unknown): unknown {
	return Type.Unsafe((mcpInputSchema ?? { type: "object" }) as Record<string, unknown>);
}

export function resolveNormalizedServerNames(rawNames: string[]): { names: Map<string, string>; warnings: string[] } {
	const entries = resolveNormalizedServerNameEntries(rawNames);
	return {
		names: new Map(entries.map((entry) => [entry.rawName, entry.normalizedName])),
		warnings: entries.flatMap((entry) => (entry.warning ? [entry.warning] : [])),
	};
}

export function createMcpToolDefinition(
	connection: McpConnection,
	mcpTool: Tool,
	opts: McpToolDefinitionOptions = {},
) {
	const serverName = opts.serverName ?? normalizeServerName(connection.name);
	const toolName = opts.toolName ?? normalizeToolName(mcpTool.name);
	const registeredName = opts.registeredName ?? buildToolName(serverName, toolName);
	const rawServerName = connection.name;
	const rawToolName = mcpTool.name;

	return defineTool({
		name: registeredName,
		label: registeredName,
		description: mcpTool.description ?? `MCP tool ${rawServerName}/${rawToolName}`,
		parameters: adaptSchema(mcpTool.inputSchema) as any,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const policyContext: McpToolPolicyContext = {
				serverName,
				toolName,
				registeredName,
				reason: `execute ${registeredName}`,
				rawServerName,
				rawToolName,
				params: params as Record<string, unknown>,
				ctx,
			};
			const policy = normalizePolicyResult(await opts.checkToolPolicy?.(policyContext));
			if (!policy.allowed) {
				return {
					content: [{ type: "text" as const, text: policy.reason }],
					details: { blocked: true },
				};
			}

			const callOptions: McpOperationOptions = signal ? { signal } : {};
			const result = await connection.callTool(rawToolName, params as Record<string, unknown>, callOptions);
			return toPiToolResult(result, { serverName, toolName, registeredName });
		},
	});
}

export function registerMcpTools(
	pi: ExtensionAPI,
	connections: McpConnection[],
	opts: McpToolRegistrationOptions = {},
): McpToolRegistrationResult {
	const registered = new Set(opts.existingToolNames ?? []);
	const registeredNames: string[] = [];
	const registeredByServer = new Map<string, string[]>();
	const warnings: string[] = [];
	const skipped: McpToolRegistrationResult["skipped"] = [];
	const serverNames = resolveNormalizedServerNameEntries(connections.map((connection) => connection.name));
	const usedToolNamesByServer = new Map<string, Set<string>>();

	for (const entry of serverNames) {
		if (entry.warning) {
			warn(entry.warning, warnings, opts.warn);
		}
	}

	for (const [index, connection] of connections.entries()) {
		const serverName = serverNames[index].normalizedName;
		const serverTools = registeredByServer.get(connection.name) ?? [];
		registeredByServer.set(connection.name, serverTools);
		const usedToolNames = usedToolNamesByServer.get(serverName) ?? new Set<string>();
		usedToolNamesByServer.set(serverName, usedToolNames);
		for (const mcpTool of connection.tools) {
			const baseToolName = normalizeToolName(mcpTool.name);
			const toolName = resolveNameCollision(baseToolName, usedToolNames, TOOL_NAME_MAX_LENGTH);
			usedToolNames.add(toolName);
			const registeredName = buildToolName(serverName, toolName);
			if (toolName !== baseToolName) {
				warn(
					`MCP tool "${connection.name}/${mcpTool.name}" normalized to duplicate "${baseToolName}", using "${registeredName}".`,
					warnings,
					opts.warn,
				);
			}
			if (registered.has(registeredName)) {
				const reason = `MCP tool "${connection.name}/${mcpTool.name}" skipped because "${registeredName}" is already registered.`;
				warn(reason, warnings, opts.warn);
				skipped.push({ registeredName, serverName, toolName, reason });
				continue;
			}

			pi.registerTool(createMcpToolDefinition(connection, mcpTool, { ...opts, serverName, toolName, registeredName }));
			registered.add(registeredName);
			registeredNames.push(registeredName);
			serverTools.push(registeredName);
		}
	}

	return {
		registered: registeredNames,
		registeredByServer,
		skipped,
		warnings,
	};
}

function normalizeProviderSafeName(raw: string, maxLength: number): string {
	return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, maxLength);
}

function resolveNormalizedServerNameEntries(rawNames: string[]): NormalizedServerNameEntry[] {
	const used = new Set<string>();
	return rawNames.map((rawName) => {
		const baseName = normalizeServerName(rawName);
		const normalizedName = resolveNameCollision(baseName, used, SERVER_NAME_MAX_LENGTH);
		used.add(normalizedName);

		if (normalizedName === baseName) {
			return { rawName, normalizedName };
		}

		return {
			rawName,
			normalizedName,
			warning: `MCP server "${rawName}" normalized to duplicate "${baseName}", using "${normalizedName}".`,
		};
	});
}

function resolveNameCollision(baseName: string, used: Set<string>, maxLength: number): string {
	if (!used.has(baseName)) {
		return baseName;
	}

	for (let suffixNumber = 2; ; suffixNumber += 1) {
		const suffix = `-${suffixNumber}`;
		const candidate = `${baseName.slice(0, maxLength - suffix.length)}${suffix}`;
		if (!used.has(candidate)) {
			return candidate;
		}
	}
}

function normalizePolicyResult(result: McpToolPolicyResult | undefined): { allowed: boolean; reason: string } {
	if (result === undefined || result === true) {
		return { allowed: true, reason: "" };
	}
	if (result === false) {
		return { allowed: false, reason: "MCP tool execution blocked by policy." };
	}

	const blocked = result.blocked === true || result.allowed === false;
	return {
		allowed: !blocked,
		reason: result.reason ?? "MCP tool execution blocked by policy.",
	};
}

function toPiToolResult(
	result: CallToolResult,
	details: { serverName: string; toolName: string; registeredName: string },
) {
	return {
		content: Array.isArray(result.content)
			? result.content
			: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
		details: {
			...details,
			result,
		},
	};
}

function warn(message: string, warnings: string[], warnFn?: (message: string) => void): void {
	warnings.push(message);
	warnFn?.(message);
}
