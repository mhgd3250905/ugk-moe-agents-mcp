import test from "node:test";
import assert from "node:assert/strict";
import {
	generateChallenge,
	readTaskShareConfig,
	writeTaskShareConfig,
	ensureCliAuth,
	openBrowser,
	taskShareConfigPath,
	type TaskShareAuthDeps,
} from "../extensions/task/task-share-auth.ts";

function memDeps(initial: Record<string, string> = {}): TaskShareAuthDeps {
	const files = new Map<string, string>(Object.entries(initial));
	return {
		agentDir: "/fake/agent",
		exists: (p) => files.has(p),
		readFile: (p) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT: ${p}`);
			return v;
		},
		writeFile: (p, c) => { files.set(p, c); },
		mkdir: () => {},
	};
}

test("generateChallenge returns 64 hex chars (32 bytes)", () => {
	const c = generateChallenge();
	assert.match(c, /^[0-9a-f]{64}$/);
	// two calls differ (randomness)
	assert.notEqual(c, generateChallenge());
});

test("readTaskShareConfig returns defaults when file is absent", () => {
	const cfg = readTaskShareConfig(memDeps());
	assert.equal(cfg.token, null);
	assert.equal(cfg.login, null);
	assert.equal(cfg.challenge, null);
	assert.equal(cfg.marketplaceUrl, "https://ugk-task-share.pages.dev");
});

test("readTaskShareConfig parses a valid file", () => {
	const deps = memDeps({
		[taskShareConfigPath({ agentDir: "/fake/agent" })]: JSON.stringify({ token: "tok", login: "me", marketplaceUrl: "https://x.test", challenge: null }),
	});
	const cfg = readTaskShareConfig(deps);
	assert.equal(cfg.token, "tok");
	assert.equal(cfg.login, "me");
	assert.equal(cfg.marketplaceUrl, "https://x.test");
});

test("readTaskShareConfig tolerates a corrupt file (falls back to defaults)", () => {
	const deps = memDeps({ [taskShareConfigPath({ agentDir: "/fake/agent" })]: "{not json" });
	const cfg = readTaskShareConfig(deps);
	assert.equal(cfg.token, null);
});

test("readTaskShareConfig strips a UTF-8 BOM", () => {
	const deps = memDeps({ [taskShareConfigPath({ agentDir: "/fake/agent" })]: "\uFEFF" + JSON.stringify({ token: "tok2" }) });
	assert.equal(readTaskShareConfig(deps).token, "tok2");
});

test("writeTaskShareConfig then readTaskShareConfig round-trips", () => {
	const deps = memDeps();
	writeTaskShareConfig({ token: "t", login: "l", marketplaceUrl: "https://m.test", challenge: null }, deps);
	const cfg = readTaskShareConfig(deps);
	assert.deepEqual(cfg, { token: "t", login: "l", marketplaceUrl: "https://m.test", challenge: null });
});

test("ensureCliAuth stores the token after polling returns ok", async () => {
	const deps = memDeps();
	const calls: string[] = [];
	let pollCount = 0;
	const fetchFn = async (url: string) => {
		calls.push(String(url));
		if (String(url).endsWith("/start")) return new Response(JSON.stringify({ url: "https://m.test/cli-auth?c=x" }), { headers: { "content-type": "application/json" } });
		pollCount++;
		if (pollCount === 1) return new Response(JSON.stringify({ status: "pending" }), { headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify({ status: "ok", token: "abcdef0123456789abcdef0123456789", login: "octo" }), { headers: { "content-type": "application/json" } });
	};
	const notifications: Array<[string, string]> = [];

	const result = await ensureCliAuth((m, l) => notifications.push([m, l]), { ...deps, fetchFn, spawnFn: () => ({ unref() {} } as any) }, 10000, 0);

	assert.equal(result.ok, true);
	assert.equal(result.config.token, "abcdef0123456789abcdef0123456789");
	assert.equal(result.config.login, "octo");
	assert.equal(result.config.challenge, null);
	// persisted to disk
	assert.equal(readTaskShareConfig(deps).token, "abcdef0123456789abcdef0123456789");
	// at least one notification carried the authorize URL
	assert.ok(notifications.some(([m]) => m.includes("cli-auth")));
});

test("ensureCliAuth throws when the server reports an error", async () => {
	const deps = memDeps();
	const fetchFn = async (url: string) => {
		if (String(url).endsWith("/start")) return new Response(JSON.stringify({ url: "https://m.test/cli-auth?c=x" }), { headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify({ status: "error", error: "challenge_expired_or_unknown" }), { headers: { "content-type": "application/json" } });
	};
	await assert.rejects(
		() => ensureCliAuth(() => {}, { ...deps, fetchFn, spawnFn: () => ({ unref() {} } as any) }, 10000, 0),
		/challenge_expired_or_unknown/,
	);
});

test("ensureCliAuth rejects a malformed token (review M4: format validation)", async () => {
	// A token that isn't 32-hex must not be stored — otherwise every later submit
	// would 401 with an opaque "invalid_token". status:ok with a bad token fails
	// fast instead of polling until timeout.
	const deps = memDeps();
	const fetchFn = async (url: string) => {
		if (String(url).endsWith("/start")) return new Response(JSON.stringify({ url: "https://m.test/cli-auth?c=x" }), { headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify({ status: "ok", token: "not-valid-hex", login: "octo" }), { headers: { "content-type": "application/json" } });
	};
	await assert.rejects(
		() => ensureCliAuth(() => {}, { ...deps, fetchFn, spawnFn: () => ({ unref() {} } as any) }, 10000, 0),
		/格式无效/,
	);
	// nothing persisted
	assert.equal(readTaskShareConfig(deps).token, null);
});

test("ensureCliAuth rejects when start endpoint fails", async () => {
	const deps = memDeps();
	const fetchFn = async () => new Response("nope", { status: 500 });
	await assert.rejects(
		() => ensureCliAuth(() => {}, { ...deps, fetchFn, spawnFn: () => ({ unref() {} } as any) }, 10000, 0),
		/授权启动失败/,
	);
});

test("openBrowser does not throw when spawn is stubbed", () => {
	let spawned = false;
	openBrowser("https://example.test", { spawnFn: (() => { spawned = true; return { unref() {} }; }) as any });
	assert.equal(spawned, true);
});
