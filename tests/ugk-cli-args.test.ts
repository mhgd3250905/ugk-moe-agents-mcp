import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildUgkCliArgs } from "../bin/ugk-cli-args.js";

test("buildUgkCliArgs isolates pi resource discovery before loading UGK", () => {
	const packageRoot = path.resolve();
	const args = buildUgkCliArgs(["--model", "deepseek-v4-pro"], packageRoot);

	assert.deepEqual(args, [
		"--model",
		"deepseek-v4-pro",
		"--theme",
		path.join(packageRoot, "themes", "ugk-geek.json"),
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		path.join(packageRoot, "extensions", "index.ts"),
	]);
});

test("buildUgkCliArgs preserves an explicit user theme", () => {
	const packageRoot = path.resolve();
	const customTheme = path.join(packageRoot, "themes", "custom.json");
	const args = buildUgkCliArgs(["--theme", customTheme], packageRoot);

	assert.deepEqual(args, [
		"--theme",
		customTheme,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		path.join(packageRoot, "extensions", "index.ts"),
	]);
});
