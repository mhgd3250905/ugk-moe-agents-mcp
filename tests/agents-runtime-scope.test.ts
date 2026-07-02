import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRuntimeScopeViolations } from "./support/agents-runtime-scope.js";

test("AGENTS.md stays runtime-only and points development rules elsewhere", () => {
	const agentsMd = fs.readFileSync("AGENTS.md", "utf8");

	assert.deepEqual(findRuntimeScopeViolations(agentsMd), []);
	assert.match(agentsMd, /docs\/DEVELOPMENT\.md/);
});

test("runtime scope guard catches development rules copied into AGENTS.md", () => {
	const pollutedAgentsMd = `
# ugk-pi-agent 运行时上下文

## pi runtime patch 契约

改完任何东西: npm test + git diff --check
不要直接改 node_modules/
读 settings.json 必须 BOM-safe
`;

	assert.deepEqual(findRuntimeScopeViolations(pollutedAgentsMd), [
		"pi runtime patch",
		"npm test",
		"git diff --check",
		"node_modules",
		"BOM-safe",
	]);
});
