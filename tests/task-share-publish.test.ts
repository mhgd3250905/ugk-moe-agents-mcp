import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import {
	buildTaskZip,
	publishTask,
	collectExtraFiles,
	extractScriptReferences,
	assertReferencedFilesExist,
} from "../extensions/task/task-share-publish.ts";
import type { LoadedTaskbook } from "../extensions/task/task-book.ts";

function tempDir() {
	return mkdtempSync(path.join(os.tmpdir(), "ugk-publish-"));
}

function sampleLoaded(name = "demo-task", withRuns = true): LoadedTaskbook {
	return {
		taskbook: {
			name,
			description: "a demo task",
			scope: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			tags: ["demo"],
			runs: withRuns ? [
				// runs must be stripped before upload (doc §6.5 + §10 risk②)
				{ timestamp: "2026-01-02T00:00:00.000Z", status: "pass", exitCode: 0, verifyFailures: [], duration: 1.2, input: "x" } as any,
				{ timestamp: "2026-01-03T00:00:00.000Z", status: "fail", exitCode: 1, verifyFailures: [], duration: 0.4, input: "y" } as any,
			] : [],
		},
		spec: { goal: "do demo", hardConstraints: ["works"], acceptance: ["passes"] } as any,
		contract: { runtimeInput: ["url"] },
		skill: "# Demo\nWrite result.\n",
		verify: "process.exit(0);\n",
		scope: "user",
		dir: "/fake/agent/tasks/demo-task",
	};
}

test("buildTaskZip contains the 5 required files", async () => {
	const zip = await buildTaskZip(sampleLoaded());
	const entries = Object.keys(unzipSync(zip));
	for (const file of ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"]) {
		assert.ok(entries.includes(file), `missing ${file}`);
	}
});

test("buildTaskZip strips the runs history from taskbook.json", async () => {
	const zip = await buildTaskZip(sampleLoaded("demo-task", true));
	const files = unzipSync(zip);
	const taskbook = JSON.parse(new TextDecoder().decode(files["taskbook.json"]));
	assert.deepEqual(taskbook.runs, []);
	// other fields preserved
	assert.equal(taskbook.name, "demo-task");
	assert.equal(taskbook.description, "a demo task");
});

test("buildTaskZip does not mutate the source LoadedTaskbook", async () => {
	const loaded = sampleLoaded("demo-task", true);
	await buildTaskZip(loaded);
	assert.equal(loaded.taskbook.runs.length, 2, "original runs array untouched");
});

// 造一个带 scripts/ 的真实临时 task 目录,模拟实际 task 结构
function realTaskDir(opts: { withScript?: boolean; withTest?: boolean } = {}): string {
	const dir = tempDir();
	mkdirSync(path.join(dir, "scripts"), { recursive: true });
	if (opts.withScript !== false) writeFileSync(path.join(dir, "scripts", "make-fluent-subtitle.mjs"), "export const ok = true;\n");
	if (opts.withTest) writeFileSync(path.join(dir, "scripts", "make-fluent-subtitle.test.mjs"), "import assert;\n");
	return dir;
}

test("buildTaskZip packages scripts/ files from the task directory", async () => {
	const dir = realTaskDir({ withScript: true });
	try {
		const loaded = { ...sampleLoaded(), dir };
		const zip = await buildTaskZip(loaded);
		const entries = Object.keys(unzipSync(zip));
		assert.ok(entries.includes("scripts/make-fluent-subtitle.mjs"), "scripts/*.mjs should be packaged");
		// 核心 5 文件仍在
		assert.ok(entries.includes("skill.md"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildTaskZip excludes *.test.mjs files", async () => {
	const dir = realTaskDir({ withScript: true, withTest: true });
	try {
		const loaded = { ...sampleLoaded(), dir };
		const zip = await buildTaskZip(loaded);
		const entries = Object.keys(unzipSync(zip));
		assert.ok(entries.includes("scripts/make-fluent-subtitle.mjs"), "runtime script packaged");
		assert.ok(!entries.includes("scripts/make-fluent-subtitle.test.mjs"), "test file excluded");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectExtraFiles returns scripts/ files but not core/test/garbage", async () => {
	const dir = tempDir();
	try {
		mkdirSync(path.join(dir, "scripts"), { recursive: true });
		writeFileSync(path.join(dir, "scripts", "a.mjs"), "x");
		writeFileSync(path.join(dir, "scripts", "a.test.mjs"), "x");
		writeFileSync(path.join(dir, "skill.md"), "x"); // 核心文件,不返回
		writeFileSync(path.join(dir, "run.log"), "x"); // 垃圾,不返回
		const extras = await collectExtraFiles(dir);
		assert.deepEqual(extras, ["scripts/a.mjs"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extractScriptReferences parses both $TASK_DIR and bare scripts/ forms", () => {
	const skill = `
读 $TASK_DIR/scripts/dom-collector.js 全文
node "$TASK_DIR/scripts/make-fluent-subtitle.mjs" --foo
读 scripts/helper.mjs 的内容
`;
	const refs = extractScriptReferences(skill);
	assert.ok(refs.includes("scripts/dom-collector.js"));
	assert.ok(refs.includes("scripts/make-fluent-subtitle.mjs"));
	assert.ok(refs.includes("scripts/helper.mjs"));
});

test("assertReferencedFilesExist passes when all references are packaged", () => {
	const skill = "读 $TASK_DIR/scripts/foo.mjs";
	const verify = "process.exit(0);";
	// 不抛 = 通过
	assert.doesNotThrow(() => assertReferencedFilesExist(skill, verify, ["skill.md", "scripts/foo.mjs"]));
});

test("assertReferencedFilesExist throws when a referenced file is missing", () => {
	const skill = "读 $TASK_DIR/scripts/missing.mjs 全文";
	const verify = "process.exit(0);";
	assert.throws(
		() => assertReferencedFilesExist(skill, verify, ["skill.md"]),
		/scripts\/missing\.mjs/,
	);
});

test("publishTask sends multipart with name/version/artifact and Bearer token", async () => {
	let captured: { url: string; headers: Headers; form: FormData } | null = null;
	const fetchFn = async (url: string, init: any) => {
		captured = { url, headers: new Headers(init.headers), form: init.body as FormData };
		return new Response(JSON.stringify({ status: "pending", name: "demo-task", version: "1.0.0" }), { headers: { "content-type": "application/json" } });
	};

	const result = await publishTask(sampleLoaded(), "1.0.0", "TOKEN", "https://m.test", undefined, undefined, { fetchFn });

	assert.equal(result.ok, true);
	assert.equal(result.name, "demo-task");
	assert.equal(result.version, "1.0.0");
	assert.match(captured!.url, /\/api\/tasks\/submit$/);
	assert.equal(captured!.headers.get("authorization"), "Bearer TOKEN");
	assert.equal(captured!.form.get("name"), "demo-task");
	assert.equal(captured!.form.get("version"), "1.0.0");
	assert.equal(captured!.form.get("title"), "demo-task"); // defaults to name when no custom title
	assert.equal(captured!.form.get("description"), "a demo task"); // description falls back to taskbook.description
	const artifact = captured!.form.get("artifact") as File;
	assert.equal(artifact.type, "application/zip");
	assert.match(artifact.name, /demo-task-1\.0\.0\.zip$/);
});

test("publishTask uses an explicit title when provided", async () => {
	let captured: FormData | null = null;
	const fetchFn = async (_url: string, init: any) => {
		captured = init.body as FormData;
		return new Response(JSON.stringify({ status: "pending" }), { headers: { "content-type": "application/json" } });
	};
	await publishTask(sampleLoaded(), "2.0.0", "T", "https://m.test", "Custom Title", undefined, { fetchFn });
	assert.equal(captured!.get("title"), "Custom Title");
});

test("publishTask uses an explicit description when provided (separate from title)", async () => {
	// title and description are distinct fields; a custom short description must
	// override the long agent-facing taskbook.description.
	let captured: FormData | null = null;
	const fetchFn = async (_url: string, init: any) => {
		captured = init.body as FormData;
		return new Response(JSON.stringify({ status: "pending" }), { headers: { "content-type": "application/json" } });
	};
	await publishTask(sampleLoaded(), "3.0.0", "T", "https://m.test", "Short Title", "One-line summary for the card", { fetchFn });
	assert.equal(captured!.get("title"), "Short Title");
	assert.equal(captured!.get("description"), "One-line summary for the card");
});

test("publishTask throws with the server error detail on failure", async () => {
	const fetchFn = async () => new Response(JSON.stringify({ error: "invalid_version" }), { status: 400, headers: { "content-type": "application/json" } });
	await assert.rejects(
		() => publishTask(sampleLoaded(), "bad", "T", "https://m.test", undefined, undefined, { fetchFn }),
		/invalid_version/,
	);
});
