# Session API Token Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show current-session cumulative subagent/task worker token usage in the footer, grouped by concrete model and displayed in M tokens.

**Architecture:** Reuse the usage already returned by subagent runs. Do not add a ledger, provider balance query, or new dependency. The footer recomputes from current session entries; `run_task` only needs to expose worker `usage` and `model` in its tool result details so the same scan can count it.

**Tech Stack:** TypeScript, existing pi session entries, existing UGK footer renderer, `node:test`.

---

## Scope

In:
- Keep the existing main footer usage line unchanged.
- Add one API usage footer line when current session has subagent/task worker usage.
- Group by exact model, for example `deepseek-v4-pro` and `deepseek-v4-flash`.
- Display token totals as M tokens: `API deepseek-v4-pro Σ1.42M ↑1.10M ↓0.32M`.
- Count `input`, `output`, `cacheRead`, and `cacheWrite` when present.
- Count `subagent` direct tool results and `run_task` worker results.

Out:
- Provider balance APIs.
- Persistent usage database.
- Historical retrofill for old `run_task` results that did not store usage.
- Internal task dispatcher/checker/reviewer usage. Add later only if the first line proves insufficient.
- API money display on the new API line. Main footer cost stays as-is.

## Files

- Modify: `extensions/ui-brand-utils.ts`
  - Add `UgkApiUsage`.
  - Add optional `apiUsage` to `UgkFooterOptions`.
  - Format one extra footer line for API model totals.
- Modify: `extensions/ui-brand.ts`
  - Add local helpers to scan tool result details from session entries.
  - Pass collected API usage to `buildUgkFooterLines`.
  - Render a variable number of footer lines.
- Modify: `extensions/task/task-worker.ts`
  - Keep full worker usage fields and pass through `model`.
- Modify: `extensions/task/task.ts`
  - Add `usage` and `model` to `SubtaskResult`.
  - Include them in `run_task` details results.
- Modify tests:
  - `tests/ui-brand-utils.test.ts`
  - `tests/ui-brand-extension.test.ts`
  - `tests/task-worker.test.ts`
  - `tests/subtask-tool.test.ts`

## Task 1: Footer API Line Formatter

**Files:**
- Modify: `extensions/ui-brand-utils.ts`
- Test: `tests/ui-brand-utils.test.ts`

- [ ] Add a failing formatter test:

```ts
test("buildUgkFooterLines renders api model token totals in M tokens", () => {
	const lines = buildUgkFooterLines({
		cwd: "/Users/shengkai/projects/ugk-tui",
		branch: "feature/api-usage",
		modelId: "deepseek-v4-pro",
		statuses: ["就绪"],
		usage: {
			input: 127000,
			output: 24100,
			cacheRead: 9000,
			cacheWrite: 0,
			cost: 0,
			contextPercent: 9.8,
			contextWindow: 1000000,
		},
		apiUsage: [
			{ model: "deepseek-v4-pro", input: 1100000, output: 320000, cacheRead: 0, cacheWrite: 0, cost: 0.08 },
			{ model: "deepseek-v4-flash", input: 31000, output: 7000, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		],
		width: 120,
	});

	assert.equal(lines.length, 4);
	assert.match(lines[2], /API deepseek-v4-pro Σ1\.42M ↑1\.10M ↓0\.32M/);
	assert.match(lines[2], /deepseek-v4-flash Σ0\.04M ↑0\.03M ↓0\.01M/);
	assert.doesNotMatch(lines[2], /\$/);
});
```

- [ ] Run:

```powershell
node --test tests/ui-brand-utils.test.ts
```

Expected: fail because `apiUsage` is not implemented.

- [ ] Implement the smallest formatter change in `extensions/ui-brand-utils.ts`:

```ts
export interface UgkApiUsage {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface UgkFooterOptions {
	// existing fields...
	apiUsage?: UgkApiUsage[];
}

function formatMillionTokens(value: number): string {
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function totalApiTokens(item: UgkApiUsage): number {
	return item.input + item.output + item.cacheRead + item.cacheWrite;
}

function formatApiUsageLine(items: UgkApiUsage[] | undefined): string {
	const visible = (items ?? [])
		.filter((item) => item.model && totalApiTokens(item) > 0)
		.sort((a, b) => totalApiTokens(b) - totalApiTokens(a))
		.slice(0, 3);
	if (visible.length === 0) return "";
	return `API ${visible.map((item) => [
		item.model,
		`Σ${formatMillionTokens(totalApiTokens(item))}`,
		`↑${formatMillionTokens(item.input)}`,
		`↓${formatMillionTokens(item.output)}`,
		item.cacheRead ? `R${formatMillionTokens(item.cacheRead)}` : "",
		item.cacheWrite ? `W${formatMillionTokens(item.cacheWrite)}` : "",
	].filter(Boolean).join(" ")).join(" | ")}`;
}
```

Then insert the API line before the status line:

```ts
const apiUsage = formatApiUsageLine(options.apiUsage);
return [
	hardTruncate(`ugk ${formatCwd(options.cwd)}${branch}`, options.width),
	hardTruncate(`${usage.join(" ")}  ${model}`, options.width),
	...(apiUsage ? [hardTruncate(apiUsage, options.width)] : []),
	hardTruncate(options.statuses.join(" "), options.width),
];
```

- [ ] Run:

```powershell
node --test tests/ui-brand-utils.test.ts
```

Expected: pass.

## Task 2: Collect Subagent And run_task Usage From Session Entries

**Files:**
- Modify: `extensions/ui-brand.ts`
- Test: `tests/ui-brand-extension.test.ts`

- [ ] Add a failing footer integration test:

```ts
test("ugk footer totals subagent and run_task api usage by model", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) { handlers.set(event, handler); },
		registerCommand() {},
		registerFlag() {},
		getFlag() { return undefined; },
		getSessionName() { return "demo"; },
	};
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "subagent",
						details: {
							results: [
								{ model: "deepseek-v4-pro", usage: { input: 1000000, output: 200000, cacheRead: 10000, cacheWrite: 0, cost: 0.02 } },
							],
						},
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "run_task",
						details: {
							results: [
								{ model: "deepseek-v4-flash", usage: { input: 500000, output: 50000, cacheRead: 0, cacheWrite: 0, cost: 0.003 } },
							],
						},
					},
				},
			],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 12.3, contextWindow: 1000000 }),
		ui: {
			setHeader: () => {},
			setFooter: (factory: unknown) => { footerFactory = factory as Function; },
			setTitle: () => {},
		},
	};

	registerUgkBrandUi(pi as any);
	await handlers.get("session_start")!({ reason: "startup" }, ctx);

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const footerData = { getGitBranch: () => null, getExtensionStatuses: () => new Map([["ready", "就绪"]]), onBranchChange: () => () => {} };
	const footer = footerFactory!({ requestRender() {} }, theme, footerData);
	const text = footer.render(160).join("\n");

	assert.match(text, /deepseek-v4-pro Σ1\.21M ↑1\.00M ↓0\.20M R0\.01M/);
	assert.match(text, /deepseek-v4-flash Σ0\.55M ↑0\.50M ↓0\.05M/);
	assert.match(text, /就绪/);
});
```

- [ ] Run:

```powershell
node --test tests/ui-brand-extension.test.ts
```

Expected: fail because footer does not collect or render API usage yet.

- [ ] Implement local collection helpers in `extensions/ui-brand.ts`. Keep them near `collectUsage`:

```ts
function collectEntries(source: BrandUiSessionSource): unknown[] {
	return source.sessionManager?.getEntries?.() ?? source.sessionManager?.getBranch?.() ?? [];
}

function usageValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addApiUsage(target: Map<string, UgkApiUsage>, model: unknown, usage: any): void {
	const key = typeof model === "string" && model.trim() ? model.trim() : "unknown";
	const current = target.get(key) ?? { model: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	current.input += usageValue(usage?.input);
	current.output += usageValue(usage?.output);
	current.cacheRead += usageValue(usage?.cacheRead);
	current.cacheWrite += usageValue(usage?.cacheWrite);
	current.cost += usageValue(usage?.cost);
	target.set(key, current);
}

function collectApiUsage(source: BrandUiSessionSource): UgkApiUsage[] {
	const totals = new Map<string, UgkApiUsage>();
	for (const entry of collectEntries(source)) {
		const message = (entry as any).message;
		if ((entry as any).type !== "message" || message?.role !== "toolResult") continue;
		const results = Array.isArray(message.details?.results) ? message.details.results : [];
		if (message.toolName === "subagent") {
			for (const result of results) addApiUsage(totals, result?.model, result?.usage);
		}
		if (message.toolName === "run_task") {
			for (const result of results) addApiUsage(totals, result?.model, result?.usage);
		}
	}
	return [...totals.values()];
}
```

Reuse `collectEntries(source)` inside `collectUsage(source)` to avoid two subtly different scans.

- [ ] Pass the new value into footer options:

```ts
apiUsage: collectApiUsage(this.source),
```

- [ ] Update render destructuring so a fourth line does not swallow the status:

```ts
const [pwd, usage, ...extraLines] = lines;
const rendered = [this.theme.fg("dim", coloredPwd), colorFooterUsageLine(usage, this.theme)];
for (const line of extraLines) {
	if (line.trim()) rendered.push(colorFooterStatusLine(statuses, line, this.theme));
}
```

- [ ] Run:

```powershell
node --test tests/ui-brand-extension.test.ts
```

Expected: pass.

## Task 3: Preserve Worker Usage And Model

**Files:**
- Modify: `extensions/task/task-worker.ts`
- Test: `tests/task-worker.test.ts`

- [ ] Update the existing `dispatchWorker maps subagent result to task worker result` test. The fake subagent result should include:

```ts
model: "deepseek-v4-pro",
usage: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3, cost: 0.01, contextTokens: 25, turns: 1 },
```

Expected assertion:

```ts
assert.equal(result.model, "deepseek-v4-pro");
assert.deepEqual(result.usage, { input: 10, output: 5, cacheRead: 7, cacheWrite: 3, cost: 0.01 });
```

- [ ] Run:

```powershell
node --test tests/task-worker.test.ts
```

Expected: fail because `TaskWorkerResult` currently drops `model/cacheRead/cacheWrite`.

- [ ] Implement the pass-through:

```ts
export interface TaskWorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TaskWorkerResult {
	ok: boolean;
	outputDir: string;
	summary: string;
	errorMessage?: string;
	usage: TaskWorkerUsage;
	model?: string;
	phases?: Record<string, number>;
}

function compactUsage(usage: UsageStats): TaskWorkerUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
	};
}
```

Abort fallback usage must include the new zero fields:

```ts
usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
```

Successful return should include:

```ts
model: result.model,
usage: compactUsage(result.usage),
```

- [ ] Run:

```powershell
node --test tests/task-worker.test.ts
```

Expected: pass.

## Task 4: Put Worker Usage Into run_task Details

**Files:**
- Modify: `extensions/task/task.ts`
- Test: `tests/subtask-tool.test.ts`

- [ ] Update `workerOk()` in `tests/subtask-tool.test.ts` to include:

```ts
model: "deepseek-v4-pro",
usage: { input: 1000000, output: 200000, cacheRead: 10000, cacheWrite: 0, cost: 0.02, contextTokens: 1210000, turns: 1 },
```

- [ ] Add assertions to `run_task single returns machine-verifiable PASS and records the run`:

```ts
assert.equal(result.details.results[0].model, "deepseek-v4-pro");
assert.deepEqual(result.details.results[0].usage, {
	input: 1000000,
	output: 200000,
	cacheRead: 10000,
	cacheWrite: 0,
	cost: 0.02,
});
```

- [ ] Run:

```powershell
node --test tests/subtask-tool.test.ts
```

Expected: fail because `SubtaskResult` currently omits worker usage/model.

- [ ] Add fields to `SubtaskResult` in `extensions/task/task.ts`:

```ts
usage?: TaskWorkerResult["usage"];
model?: string;
```

- [ ] In the successful `executeSubtask()` return, add:

```ts
usage: outcome.workerResult.usage,
model: outcome.workerResult.model,
```

Do not add usage to taskbook run history; the footer only needs tool result details.

- [ ] Run:

```powershell
node --test tests/subtask-tool.test.ts
```

Expected: pass.

## Task 5: Final Verification

- [ ] Run targeted tests:

```powershell
node --test tests/ui-brand-utils.test.ts tests/ui-brand-extension.test.ts tests/task-worker.test.ts tests/subtask-tool.test.ts
```

Expected: all pass.

- [ ] Run full test suite:

```powershell
npm test
```

Expected: all pass, with the existing Node warning acceptable if unchanged.

- [ ] Manual smoke without paid API:
  - Render footer from the `ui-brand-extension` fake session.
  - Confirm output contains one API line.
  - Confirm the API line is grouped by model and uses M tokens.
  - Confirm main usage line still contains the existing `↑`, `↓`, cost, context bar, and model chip.

## Acceptance Criteria

- Footer still shows main session usage exactly as before.
- When current session has subagent results with usage, footer shows an API line grouped by exact `model`.
- When current session has `run_task` results after this change, footer includes worker usage under the worker model.
- API line uses M-token format, not k-token format.
- API line does not show `$`; main footer cost remains unchanged.
- Empty sessions or sessions without subagent/task usage do not show the API line.
- Long API lines are truncated by existing footer width logic.
- No new dependency, config file, persistence layer, or provider-specific API call is introduced.

## Skipped

- Dispatcher/checker/reviewer usage: add only if users still see unexplained billing after worker/subagent totals.
- API balance/final invoice matching: provider-specific and not needed for current-session visibility.
- Cached incremental aggregation: current footer already scans session entries; add caching only if long sessions make render measurably slow.
