import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
	buildManifest,
	createSessionCookie,
	accountDownloads,
	accountSubmissions,
	adminSubmissions,
	adminReports,
	communityTasks,
	currentSession,
	githubCallback,
	githubLogin,
	marketplaceStats,
	getTaskStats,
	getTaskStatsDetail,
	getTaskVersions,
	recordDownload,
	reportTask,
	reviewSubmission,
	serveTaskFile,
	submitTask,
	toggleFavorite,
	toggleLike,
	startCliAuth,
	pollCliAuth,
	confirmCliAuth,
} from "../functions/_lib/marketplace.js";

// Build a minimal valid task package zip in-memory for submit tests.
const SAMPLE_FILES = {
	"taskbook.json": JSON.stringify({ name: "pkg-task", description: "demo", scope: "user", tags: ["demo"], runs: [] }),
	"spec.json": JSON.stringify({ goal: "demo task", hardConstraints: ["works"], acceptance: ["passes"] }),
	"skill.md": "# Pkg Task\nWrite result.json.\n",
	"verify.mjs": "process.exit(0);\n",
	"contract.json": "{}",
};

function taskZip(name: string): Uint8Array {
	const encoded: Record<string, Uint8Array> = {};
	for (const [file, text] of Object.entries(SAMPLE_FILES)) encoded[file] = new TextEncoder().encode(file === "taskbook.json" ? JSON.stringify({ ...JSON.parse(text), name }) : text);
	return zipSync(encoded);
}

// zip with a wrapper directory (creators naturally run `zip -r foo.zip foo/`)
function taskZipWithWrapper(name: string): Uint8Array {
	const encoded: Record<string, Uint8Array> = {};
	for (const [file, text] of Object.entries(SAMPLE_FILES)) encoded[`${name}/${file}`] = new TextEncoder().encode(file === "taskbook.json" ? JSON.stringify({ ...JSON.parse(text), name }) : text);
	return zipSync(encoded);
}

function createDb() {
	const users = new Map();
	const usersById = new Map();
	const tasks = new Map([["video-downloader", { download_count: 0, like_count: 0, favorite_count: 0 }]]);
	const submissions = [];
	const versions = [];
	const downloads = [];
	const reports = [];
	const likes = new Set();
	const favorites = new Set();
	const cliPending = new Map(); // challenge -> { created_at, state }
	const cliTokens = []; // { token, user_id, challenge, created_at }
	let nextUserId = 1;
	let nextSubmissionId = 1;
	return {
		prepare(sql) {
			return {
				values: [],
				bind(...values) {
					this.values = values;
					return this;
				},
				async first() {
					if (sql.startsWith("SELECT COUNT(*) AS task_count")) {
						let downloads = 0;
						let likes = 0;
						let favorites = 0;
						for (const task of tasks.values()) {
							downloads += task.download_count;
							likes += task.like_count;
							favorites += task.favorite_count;
						}
						return { task_count: tasks.size, download_count: downloads, like_count: likes, favorite_count: favorites };
					}
					if (sql.startsWith("SELECT * FROM users WHERE id = ?")) return usersById.get(this.values[0]) ?? null;
					if (sql.startsWith("SELECT * FROM users WHERE github_id = ?")) return users.get(String(this.values[0])) ?? null;
					if (sql.startsWith("SELECT task_submissions.*")) return submissions.find((item) => item.id === this.values[0]) ?? null;
					if (sql.startsWith("SELECT 1 FROM task_likes")) return likes.has(`${this.values[0]}:${this.values[1]}`) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM task_favorites")) return favorites.has(`${this.values[0]}:${this.values[1]}`) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM download_events")) return downloads.some((item) => item.task_name === this.values[0] && item.user_id === this.values[1]) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT 1 FROM task_reports")) return reports.some((item) => item.task_name === this.values[0] && item.user_id === this.values[1]) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT download_count")) return tasks.get(this.values[0]) ?? null;
					if (sql.startsWith("SELECT latest_version FROM tasks")) return tasks.get(this.values[0]) ?? null;
					if (sql.startsWith("SELECT file_list FROM task_submissions")) return submissions.find((item) => item.name === this.values[0] && item.version === this.values[1] && item.status === "published") ?? null;
					if (sql.startsWith("SELECT 1 FROM cli_auth_pending")) return cliPending.has(this.values[0]) ? { "1": 1 } : null;
					if (sql.startsWith("DELETE FROM cli_auth_pending WHERE challenge = ? RETURNING")) {
						// Atomic claim via RETURNING (createCliToken): delete + return the row.
						const ch = this.values[0];
						if (cliPending.has(ch)) { cliPending.delete(ch); return { challenge: ch }; }
						return null;
					}
					if (sql.startsWith("SELECT challenge FROM cli_auth_pending WHERE state = ?")) {
						const found = [...cliPending.entries()].find(([, v]) => v.state === this.values[0]);
						return found ? { challenge: found[0] } : null;
					}
					if (sql.startsWith("SELECT 1 FROM task_versions WHERE task_name = ? AND version = ?")) return versions.some((v) => v.task_name === this.values[0] && v.version === this.values[1]) ? { ok: 1 } : null;
					if (sql.startsWith("SELECT token, user_id, created_at FROM cli_tokens")) {
						const tok = cliTokens.filter((t) => t.challenge === this.values[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
						return tok ? { token: tok.token, user_id: tok.user_id, created_at: tok.created_at } : null;
					}
					if (sql.startsWith("SELECT login, avatar_url FROM users WHERE id = ?")) {
						const u = usersById.get(this.values[0]);
						return u ? { login: u.login, avatar_url: u.avatar_url } : null;
					}
					if (sql.startsWith("SELECT users.* FROM cli_tokens JOIN users")) {
						// P0 H2: lookup now enforces created_at > cutoff (this.values[1]).
						const tok = cliTokens.find((t) => t.token === this.values[0] && t.created_at > this.values[1]);
						return tok ? (usersById.get(tok.user_id) ?? null) : null;
					}
					throw new Error(`Unhandled first SQL: ${sql}`);
				},
				async all() {
					if (sql.includes("FROM task_submissions") && sql.includes("WHERE task_submissions.user_id")) return { results: submissions.filter((item) => item.user_id === this.values[0]) };
					if (sql.includes("FROM task_submissions") && sql.includes("WHERE task_submissions.status = 'pending'")) return { results: submissions.filter((item) => item.status === "pending") };
					if (sql.includes("FROM task_submissions") && sql.includes("WHERE task_submissions.status = 'published'")) return { results: submissions.filter((item) => item.status === "published") };
					if (sql.includes("FROM download_events") && sql.includes("WHERE download_events.user_id")) {
						return { results: downloads.filter((item) => item.user_id === this.values[0]).map((item) => ({ ...item, ...(tasks.get(item.task_name) ?? {}), name: item.task_name })) };
					}
					if (sql.includes("FROM download_events") && sql.includes("WHERE task_name = ?")) {
						const counts = new Map();
						for (const item of downloads.filter((download) => download.task_name === this.values[0])) {
							const day = item.created_at.slice(0, 10);
							counts.set(day, (counts.get(day) ?? 0) + 1);
						}
						return { results: [...counts].map(([day, download_count]) => ({ day, download_count })) };
					}
					if (sql.includes("FROM task_versions")) return { results: versions.filter((item) => item.task_name === this.values[0]) };
					if (sql.includes("FROM tasks") && sql.includes("latest_version IS NOT NULL")) {
						return { results: [...tasks.entries()].filter(([, task]: [string, any]) => task.latest_version).map(([name, task]: [string, any]) => ({ name, title: task.title, description: task.description, author_name: task.author_name, latest_version: task.latest_version })).sort((a: any, b: any) => a.name.localeCompare(b.name)) };
					}
					if (sql.includes("FROM task_reports")) return { results: reports.map((item) => ({ ...item, reporter_login: usersById.get(item.user_id)?.login ?? "unknown" })) };
					throw new Error(`Unhandled all SQL: ${sql}`);
				},
				async run() {
					if (sql.startsWith("INSERT INTO users")) {
						const [githubId, login, avatarUrl, now] = this.values;
						let user = users.get(String(githubId));
						if (!user) {
							user = { id: nextUserId++, github_id: String(githubId), login, avatar_url: avatarUrl, created_at: now };
							users.set(String(githubId), user);
							usersById.set(user.id, user);
						} else {
							user.login = login;
							user.avatar_url = avatarUrl;
						}
						return { success: true };
					}
					if (sql.startsWith("INSERT OR IGNORE INTO tasks")) {
						const [name, title, description, authorName, now] = this.values;
						if (!tasks.has(name)) tasks.set(name, { title, description, author_name: authorName, created_at: now, download_count: 0, like_count: 0, favorite_count: 0 });
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_submissions")) {
							const [userId, name, version, title, description, sourceType, sourceUrl, artifactKey, artifactName, fileList, now] = this.values;
							submissions.push({ id: nextSubmissionId++, user_id: userId, name, version, title, description, source_type: sourceType, source_url: sourceUrl, artifact_key: artifactKey, artifact_name: artifactName, file_list: fileList, status: "pending", created_at: now, updated_at: now, author_login: usersById.get(userId)?.login ?? "unknown" });
							return { success: true };
						}
					if (sql.startsWith("UPDATE task_submissions SET status")) {
						const [status, reviewerId, note, now, id] = this.values;
						const item = submissions.find((submission) => submission.id === id);
						item.status = status;
						item.reviewer_user_id = reviewerId;
						item.review_note = note;
						item.updated_at = now;
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_versions")) {
						const [taskName, version, submissionId, artifactKey, sourceUrl, publishedByUserId, now] = this.values;
						versions.push({ task_name: taskName, version, submission_id: submissionId, artifact_key: artifactKey, source_url: sourceUrl, published_by_user_id: publishedByUserId, created_at: now });
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO tasks")) {
							const [name, title, description, authorUserId, authorName, latestVersion, now] = this.values;
							tasks.set(name, { title, description, author_user_id: authorUserId, author_name: authorName, latest_version: latestVersion, created_at: now, download_count: 0, like_count: 0, favorite_count: 0 });
							return { success: true };
						}
					if (sql.startsWith("INSERT INTO task_likes")) {
						likes.add(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM task_likes")) {
						likes.delete(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_favorites")) {
						favorites.add(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM task_favorites")) {
						favorites.delete(`${this.values[0]}:${this.values[1]}`);
						return { success: true };
					}
					if (sql.startsWith("UPDATE tasks SET like_count")) {
						tasks.get(this.values[0]).like_count = [...likes].filter((item) => item.startsWith(`${this.values[0]}:`)).length;
						return { success: true };
					}
					if (sql.startsWith("UPDATE tasks SET favorite_count")) {
						tasks.get(this.values[0]).favorite_count = [...favorites].filter((item) => item.startsWith(`${this.values[0]}:`)).length;
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO download_events")) {
						const [taskName, userId, now] = this.values;
						downloads.push({ id: downloads.length + 1, task_name: taskName, user_id: userId, created_at: now });
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO task_reports")) {
						const [taskName, userId, reason, now] = this.values;
						if (!reports.some((item) => item.task_name === taskName && item.user_id === userId)) reports.push({ id: reports.length + 1, task_name: taskName, user_id: userId, reason, status: "open", created_at: now });
						return { success: true };
					}
					if (sql.startsWith("UPDATE tasks SET download_count")) {
						tasks.get(this.values[0]).download_count++;
						return { success: true };
					}
					if (sql.startsWith("INSERT OR REPLACE INTO cli_auth_pending") || sql.startsWith("INSERT INTO cli_auth_pending")) {
						const [challenge, createdAt] = this.values;
						cliPending.set(challenge, { created_at: createdAt, state: cliPending.get(challenge)?.state ?? null });
						return { success: true };
					}
					if (sql.startsWith("UPDATE cli_auth_pending SET state = ?")) {
						const [stateVal, challenge] = this.values;
						const row = cliPending.get(challenge);
						if (row) row.state = stateVal;
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM cli_auth_pending WHERE challenge = ?")) {
						cliPending.delete(this.values[0]);
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM cli_auth_pending WHERE created_at < ?")) {
						for (const [k, v] of cliPending) if (v.created_at < this.values[0]) cliPending.delete(k);
						return { success: true };
					}
					if (sql.startsWith("INSERT INTO cli_tokens")) {
						const [token, userId, challenge, createdAt] = this.values;
						cliTokens.push({ token, user_id: userId, challenge, created_at: createdAt });
						return { success: true, meta: { last_row_id: cliTokens.length } };
					}
					if (sql.startsWith("DELETE FROM cli_tokens WHERE challenge = ? AND created_at < ?")) {
						// drop older sibling tokens for this challenge, keep the newest
						for (let i = cliTokens.length - 1; i >= 0; i--) {
							if (cliTokens[i].challenge === this.values[0] && cliTokens[i].created_at < this.values[1]) cliTokens.splice(i, 1);
						}
						return { success: true };
					}
					if (sql.startsWith("DELETE FROM cli_tokens WHERE created_at < ?")) {
						// P0 H2: lazy GC of expired tokens (requireBearerUser).
						for (let i = cliTokens.length - 1; i >= 0; i--) {
							if (cliTokens[i].created_at < this.values[0]) cliTokens.splice(i, 1);
						}
						return { success: true };
					}
					throw new Error(`Unhandled run SQL: ${sql}`);
				},
			};
		},
	};
}

function createR2() {
	const objects = new Map();
	return {
		objects,
		async put(key, value) {
			objects.set(key, value);
		},
		async get(key) {
			return objects.has(key) ? { body: objects.get(key), httpMetadata: {} } : null;
		},
	};
}

function env() {
	return {
		DB: createDb(),
		TASK_UPLOADS: createR2(),
		ADMIN_GITHUB_LOGINS: "octo",
		GITHUB_CLIENT_ID: "client-id",
		GITHUB_CLIENT_SECRET: "client-secret",
		SESSION_SECRET: "test-secret",
		SITE_URL: "https://ugk-task-share.pages.dev",
	};
}

test("githubLogin redirects to GitHub and stores oauth state", async () => {
	const response = await githubLogin(new Request("https://ugk-task-share.pages.dev/api/auth/github"), env(), { randomUUID: () => "state-1" });

	assert.equal(response.status, 302);
	assert.match(response.headers.get("location"), /github\.com\/login\/oauth\/authorize/);
	assert.match(response.headers.get("set-cookie"), /ugk_oauth_state=state-1/);
});

test("githubLogin reports missing OAuth configuration", async () => {
	const testEnv = env();
	delete testEnv.GITHUB_CLIENT_ID;
	const response = await githubLogin(new Request("https://ugk-task-share.pages.dev/api/auth/github"), testEnv);
	const body = await response.json();

	assert.equal(response.status, 500);
	assert.match(body.error, /not configured/i);
});

test("githubCallback verifies state, upserts user, and sets a session", async () => {
	const response = await githubCallback(
		new Request("https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=state-1", {
			headers: { cookie: "ugk_oauth_state=state-1" },
		}),
		env(),
		{
			fetch: async (url) => {
				if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { headers: { "content-type": "application/json" } });
				return new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "https://avatar.test/u.png" }), { headers: { "content-type": "application/json" } });
			},
		},
	);

	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), "/");
	assert.match(response.headers.get("set-cookie"), /ugk_session=/);
});

test("githubCallback rejects mismatched state", async () => {
	const response = await githubCallback(
		new Request("https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=bad", {
			headers: { cookie: "ugk_oauth_state=state-1" },
		}),
		env(),
	);

	assert.equal(response.status, 400);
	assert.match(await response.text(), /state/i);
});

test("session endpoint returns the signed-in user", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const response = await currentSession(new Request("https://ugk-task-share.pages.dev/api/session", { headers: { cookie } }), testEnv);
	const body = await response.json();

	assert.equal(body.user.login, "octo");
});

test("like and favorite require login and toggle counts", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const request = new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/like", { method: "POST", headers: { cookie } });

	assert.equal((await toggleLike(new Request(request), testEnv, "video-downloader")).status, 200);
	assert.equal((await (await toggleLike(new Request(request), testEnv, "video-downloader")).json()).liked, false);

	const favorite = await toggleFavorite(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/favorite", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	assert.equal((await favorite.json()).favorited, true);

	const anonymous = await toggleLike(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/like", { method: "POST" }), testEnv, "video-downloader");
	assert.equal(anonymous.status, 401);
});

test("stats include live counts and signed-in user flags", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);

	await toggleLike(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/like", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	await toggleFavorite(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/favorite", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	const response = await getTaskStats(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/stats", { headers: { cookie } }), testEnv, "video-downloader");
	const body = await response.json();

	assert.equal(body.likes, 1);
	assert.equal(body.favorites, 1);
	assert.equal(body.liked, true);
	assert.equal(body.favorited, true);
});

test("download events work for anonymous users", async () => {
	const testEnv = env();
	const response = await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST" }), testEnv, "video-downloader");
	const body = await response.json();

	assert.equal(body.downloads, 1);
});

test("marketplace stats summarize live D1 counters", async () => {
	const testEnv = env();
	await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST" }), testEnv, "video-downloader");
	const response = await marketplaceStats(testEnv);
	const body = await response.json();

	assert.deepEqual(body, { tasks: 1, downloads: 1, likes: 0, favorites: 0 });
});

test("signed-in users submit task packages and see pending submissions", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "my-task");
	form.set("version", "1.0.0");
	form.set("title", "My Task");
	form.set("description", "Does one useful thing");
	form.set("artifact", new File([taskZip("my-task") as BlobPart], "my-task.zip", { type: "application/zip" }));

	const submitResponse = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const submitted = await submitResponse.json();
	const accountResponse = await accountSubmissions(new Request("https://ugk-task-share.pages.dev/api/account/submissions", { headers: { cookie } }), testEnv);
	const account = await accountResponse.json();

	assert.equal(submitted.status, "pending");
	assert.equal(submitted.name, "my-task");
	assert.equal(submitted.version, "1.0.0");
	assert.equal(account.submissions.length, 1);
	// 5 required files stored as loose objects in R2
	assert.equal(testEnv.TASK_UPLOADS.objects.size, 5);
});

test("task submissions reject missing artifact", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "no-artifact-task");
	form.set("version", "1.0.0");
	form.set("title", "No Artifact");
	form.set("description", "Missing the zip");

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "artifact_required");
});

test("task submissions reject invalid semver version", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "bad-version-task");
	form.set("version", "latest");
	form.set("title", "Bad Version");
	form.set("description", "Non-semver version");
	form.set("artifact", new File([taskZip("bad-version-task") as BlobPart], "bad.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "invalid_version");
});

test("task submissions reject malformed zip before R2 write", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "bad-zip-task");
	form.set("version", "1.0.0");
	form.set("title", "Bad Zip");
	form.set("description", "Not a real zip");
	form.set("artifact", new File([new Uint8Array([0, 1, 2, 3]) as BlobPart], "bad.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "invalid_zip");
	assert.equal(testEnv.TASK_UPLOADS.objects.size, 0);
});

test("task submissions reject a package missing required files", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	// zip with only taskbook.json, missing the other 4 required files
	const partial = zipSync({ "taskbook.json": new TextEncoder().encode(SAMPLE_FILES["taskbook.json"]) });
	const form = new FormData();
	form.set("name", "pkg-task");
	form.set("version", "1.0.0");
	form.set("title", "Partial");
	form.set("description", "Missing files");
	form.set("artifact", new File([partial as BlobPart], "partial.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "invalid_package");
});

test("task submissions reject a package whose taskbook name mismatches", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "declared-name");
	form.set("version", "1.0.0");
	form.set("title", "Name Mismatch");
	form.set("description", "taskbook.json name != form name");
	// zip's taskbook.json says name: pkg-task, but form says declared-name
	form.set("artifact", new File([taskZip("pkg-task") as BlobPart], "mismatch.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "invalid_package");
});

test("task submissions reject a package that references a missing scripts file", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	// 合法包(5 核心文件齐全),但 skill.md 引用了 scripts/missing.mjs 而包里没有
	const encoded: Record<string, Uint8Array> = {};
	for (const [file, text] of Object.entries({ ...SAMPLE_FILES, "skill.md": "# Task\n读 $TASK_DIR/scripts/missing.mjs 全文\n" })) {
		encoded[file] = new TextEncoder().encode(file === "taskbook.json" ? JSON.stringify({ ...JSON.parse(text), name: "pkg-task" }) : text);
	}
	const zip = zipSync(encoded);
	const form = new FormData();
	form.set("name", "pkg-task");
	form.set("version", "1.0.0");
	form.set("title", "Broken Ref");
	form.set("description", "skill.md references a missing script");
	form.set("artifact", new File([zip as BlobPart], "broken.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "missing_referenced_file");
	assert.match(body.detail, /scripts\/missing\.mjs/);
	assert.equal(testEnv.TASK_UPLOADS.objects.size, 0, "no files written on rejection");
});

test("task submissions reject a version that is already published (review M6)", async () => {
	// Re-submitting an existing version would silently no-op at publish time
	// (task_versions UNIQUE DO NOTHING) and mislead the user. Fail fast at submit.
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	// Simulate a prior publish of dupe-task v1.0.0: insert the version row directly.
	await testEnv.DB.prepare("INSERT INTO task_versions (task_name, version, submission_id, artifact_key, source_url, published_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("dupe-task", "1.0.0", 1, "tasks/dupe-task/1.0.0", null, 1, new Date().toISOString()).run();

	const form = new FormData();
	form.set("name", "dupe-task");
	form.set("version", "1.0.0");
	form.set("title", "Dupe");
	form.set("description", "Same version as an existing publish");
	form.set("artifact", new File([taskZip("dupe-task") as BlobPart], "dupe.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 409);
	assert.equal(body.error, "version_already_published");
	// A different version of the same task is still allowed.
	const form2 = new FormData();
	form2.set("name", "dupe-task");
	form2.set("version", "1.0.1");
	form2.set("title", "Dupe 2");
	form2.set("description", "New version");
	form2.set("artifact", new File([taskZip("dupe-task") as BlobPart], "dupe2.zip", { type: "application/zip" }));
	const response2 = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form2 }), testEnv);
	assert.equal(response2.status, 200);
});

test("task submissions reject oversized artifacts before R2 upload", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "huge-artifact-task");
	form.set("version", "1.0.0");
	form.set("title", "Huge Artifact Task");
	form.set("description", "Attempts to upload too much data");
	form.set("artifact", new File([new Uint8Array(25 * 1024 * 1024 + 1) as BlobPart], "huge.zip", { type: "application/zip" }));

	const response = await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	const body = await response.json();

	assert.equal(response.status, 413);
	assert.equal(body.error, "artifact_too_large");
	assert.equal(testEnv.TASK_UPLOADS.objects.size, 0);
});

test("admins publish pending submissions into the public queue", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "public-task");
	form.set("version", "1.0.0");
	form.set("title", "Public Task");
	form.set("description", "Ready for review");
	form.set("artifact", new File([taskZip("public-task") as BlobPart], "public-task.zip", { type: "application/zip" }));
	await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);

	const pending = await (await adminSubmissions(new Request("https://ugk-task-share.pages.dev/api/admin/submissions", { headers: { cookie } }), testEnv)).json();
	const review = await reviewSubmission(
		new Request("https://ugk-task-share.pages.dev/api/admin/submissions/1", { method: "POST", headers: { cookie }, body: JSON.stringify({ status: "published", note: "ok" }) }),
		testEnv,
		1,
	);
	const publicTasks = await (await communityTasks(testEnv)).json();

	assert.equal(pending.submissions.length, 1);
	assert.equal((await review.json()).status, "published");
	assert.equal(publicTasks.tasks[0].name, "public-task");
});

test("signed-in users see per-task download state and account downloads", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);

	await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST", headers: { cookie } }), testEnv, "video-downloader");
	const stats = await (await getTaskStats(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/stats", { headers: { cookie } }), testEnv, "video-downloader")).json();
	const account = await (await accountDownloads(new Request("https://ugk-task-share.pages.dev/api/account/downloads", { headers: { cookie } }), testEnv)).json();

	assert.equal(stats.downloaded, true);
	assert.equal(account.downloads[0].name, "video-downloader");
});

test("signed-in users can report a task once and admins can review reports", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);

	const report = await reportTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/report", { method: "POST", headers: { cookie }, body: JSON.stringify({ reason: "Broken artifact" }) }),
		testEnv,
		"video-downloader",
	);
	const duplicate = await reportTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/report", { method: "POST", headers: { cookie }, body: JSON.stringify({ reason: "Broken artifact again" }) }),
		testEnv,
		"video-downloader",
	);
	const reports = await (await adminReports(new Request("https://ugk-task-share.pages.dev/api/admin/reports", { headers: { cookie } }), testEnv)).json();

	assert.equal((await report.json()).reported, true);
	assert.equal((await duplicate.json()).reported, true);
	assert.equal(reports.reports.length, 1);
});

test("published submissions expose immutable task versions", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "versioned-task");
	form.set("version", "2.1.0");
	form.set("title", "Versioned Task");
	form.set("description", "Ready for versions");
	form.set("artifact", new File([taskZip("versioned-task") as BlobPart], "versioned-task.zip", { type: "application/zip" }));

	await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	await reviewSubmission(
		new Request("https://ugk-task-share.pages.dev/api/admin/submissions/1", { method: "POST", headers: { cookie }, body: JSON.stringify({ status: "published" }) }),
		testEnv,
		1,
	);
	const versions = await (await getTaskVersions(testEnv, "versioned-task")).json();

	assert.equal(versions.versions[0].version, "2.1.0");
});

test("buildManifest lists published tasks with loose-file URLs and serveTaskFile delivers them", async () => {
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	const form = new FormData();
	form.set("name", "manifest-task");
	form.set("version", "1.0.0");
	form.set("title", "Manifest Task");
	form.set("description", "For manifest test");
	form.set("artifact", new File([taskZip("manifest-task") as BlobPart], "manifest-task.zip", { type: "application/zip" }));
	await submitTask(new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { cookie }, body: form }), testEnv);
	await reviewSubmission(
		new Request("https://ugk-task-share.pages.dev/api/admin/submissions/1", { method: "POST", headers: { cookie }, body: JSON.stringify({ status: "published" }) }),
		testEnv,
		1,
	);

	const manifestResponse = await buildManifest(new Request("https://ugk-task-share.pages.dev/api/manifest"), testEnv);
	const manifest = await manifestResponse.json();

	assert.equal(manifest.tasks.length, 1);
	assert.equal(manifest.tasks[0].name, "manifest-task");
	assert.equal(manifest.tasks[0].version, "1.0.0");
	// 5 required files, each mapped to a fetchable URL
	assert.equal(Object.keys(manifest.tasks[0].files).length, 5);
	assert.match(manifest.tasks[0].files["taskbook.json"], /\/api\/tasks\/manifest-task\/files\?f=taskbook\.json$/);

	// Serve one of the loose files — should return the stored content
	const fileResponse = await serveTaskFile(testEnv, "manifest-task", "contract.json");
	assert.equal(fileResponse.status, 200);
	const text = await fileResponse.text();
	assert.deepEqual(JSON.parse(text), {}); // contract.json is "{}"
});

test("serveTaskFile rejects path traversal", async () => {
	const testEnv = env();
	await assert.rejects(() => serveTaskFile(testEnv, "any", "../../etc/passwd"));
});

test("stats detail rolls download events up by day", async () => {
	const testEnv = env();
	await recordDownload(new Request("https://ugk-task-share.pages.dev/api/tasks/video-downloader/download", { method: "POST" }), testEnv, "video-downloader");
	const detail = await (await getTaskStatsDetail(testEnv, "video-downloader")).json();

	assert.equal(detail.days[0].downloads, 1);
	assert.match(detail.days[0].day, /^\d{4}-\d{2}-\d{2}$/);
});

// --- CLI publish auth (TUI -> site-brokered GitHub OAuth) ---

async function seedUser(testEnv) {
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "https://avatar.test/u.png", new Date().toISOString()).run();
	return await createSessionCookie({ id: 1, login: "octo" }, testEnv);
}

test("startCliAuth records the challenge and returns the authorize url", async () => {
	const testEnv = env();
	const response = await startCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge: "a".repeat(64) }) }),
		testEnv,
	);
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.match(body.url, /\/cli-auth\?c=/);
});

test("startCliAuth rejects a malformed challenge", async () => {
	const testEnv = env();
	const response = await startCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge: "short" }) }),
		testEnv,
	);
	const body = await response.json();

	assert.equal(response.status, 400);
	assert.equal(body.error, "invalid_challenge");
});

test("pollCliAuth reports pending while the user has not logged in", async () => {
	const testEnv = env();
	await startCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge: "b".repeat(64) }) }),
		testEnv,
	);
	const response = await pollCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/poll", { method: "POST", body: JSON.stringify({ challenge: "b".repeat(64) }) }),
		testEnv,
	);
	const body = await response.json();

	assert.equal(body.status, "pending");
});

test("pollCliAuth returns the token after the callback signs one", async () => {
	const testEnv = env();
	await seedUser(testEnv);
	const challenge = "c".repeat(64);
	await startCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge }) }),
		testEnv,
	);
	// P0 C1+C2: githubLogin binds state<->challenge server-side; callback
	// reverse-looks-up challenge from the trusted oauth_state (no challenge cookie).
	const loginState = "11111111-2222-3333-4444-555555555555";
	await githubLogin(
		new Request(`https://ugk-task-share.pages.dev/api/auth/github?cli_challenge=${challenge}`),
		testEnv,
		{ randomUUID: () => loginState },
	);
	const callback = await githubCallback(
		new Request(`https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=${loginState}`, { headers: { cookie: `ugk_oauth_state=${loginState}` } }),
		testEnv,
		{
			fetch: async (url) => {
				if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { headers: { "content-type": "application/json" } });
				return new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "" }), { headers: { "content-type": "application/json" } });
			},
		},
	);
	// SECURITY (H-REZ-1): callback redirects to a confirmation page, NOT done.
	assert.equal(callback.headers.get("location"), `/cli-auth?cli=confirm&state=${loginState}`);

	// The user explicitly confirms (authenticated by session cookie).
	const cookie = await createSessionCookie({ id: 1, login: "octo" }, testEnv);
	await confirmCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/confirm", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: loginState }) }),
		testEnv,
	);

	const poll = await pollCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/poll", { method: "POST", body: JSON.stringify({ challenge }) }),
		testEnv,
	);
	const polled = await poll.json();

	assert.equal(polled.status, "ok");
	assert.equal(polled.login, "octo");
	assert.match(polled.token, /^[0-9a-f]{32}$/); // createCliToken's random uuid, dashes stripped
	// Challenge is single-use: pending cleared after claim.
	assert.equal((await testEnv.DB.prepare("SELECT 1 FROM cli_auth_pending WHERE challenge = ?").bind(challenge).first()), null);
});

test("pollCliAuth reports an error for an unknown challenge", async () => {
	const testEnv = env();
	const response = await pollCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/poll", { method: "POST", body: JSON.stringify({ challenge: "z".repeat(64) }) }),
		testEnv,
	);
	const body = await response.json();

	assert.equal(response.status, 410);
	assert.equal(body.status, "error");
});

test("requireUser accepts a valid Bearer cli_token", async () => {
	const testEnv = env();
	const cookie = await seedUser(testEnv);
	const challenge = "d".repeat(64);
	await startCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge }) }),
		testEnv,
	);
	const loginState = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	await githubLogin(
		new Request(`https://ugk-task-share.pages.dev/api/auth/github?cli_challenge=${challenge}`),
		testEnv,
		{ randomUUID: () => loginState },
	);
	await githubCallback(
		new Request(`https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=${loginState}`, { headers: { cookie: `ugk_oauth_state=${loginState}` } }),
		testEnv,
		{
			fetch: async (url) => {
				if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { headers: { "content-type": "application/json" } });
				return new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "" }), { headers: { "content-type": "application/json" } });
			},
		},
	);
	// Explicit user confirmation (session-cookie auth) signs the token.
	await confirmCliAuth(
		new Request("https://ugk-task-share.pages.dev/api/cli/auth/confirm", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: loginState }) }),
		testEnv,
	);
	const poll = await (await pollCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/poll", { method: "POST", body: JSON.stringify({ challenge }) }), testEnv)).json();
	assert.equal(poll.status, "ok");

	// Submit via Bearer token (no cookie session) should authenticate the user.
	const form = new FormData();
	form.set("name", "bearer-task");
	form.set("version", "1.0.0");
	form.set("title", "Bearer Task");
	form.set("description", "Authed via cli_token");
	form.set("artifact", new File([taskZip("bearer-task") as BlobPart], "bearer-task.zip", { type: "application/zip" }));
	const response = await submitTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { authorization: `Bearer ${poll.token}` }, body: form }),
		testEnv,
	);
	const submitted = await response.json();

	assert.equal(response.status, 200);
	assert.equal(submitted.name, "bearer-task");
	assert.equal(submitted.status, "pending");
});

test("requireUser rejects an invalid Bearer token", async () => {
	const testEnv = env();
	const form = new FormData();
	form.set("name", "x");
	form.set("version", "1.0.0");
	form.set("title", "X");
	form.set("description", "X");
	form.set("artifact", new File([taskZip("x") as BlobPart], "x.zip", { type: "application/zip" }));
	const response = await submitTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { authorization: "Bearer not-a-real-token" }, body: form }),
		testEnv,
	);
	const body = await response.json();

	assert.equal(response.status, 401);
	assert.equal(body.error, "invalid_token");
});

test("requireBearerUser rejects an expired cli_token (P0 H2)", async () => {
	// A token older than CLI_TOKEN_TTL_SECONDS (90d) must 401 even before the
	// lazy GC physically deletes it — the lookup enforces created_at > cutoff.
	const testEnv = env();
	await testEnv.DB.prepare("INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?)").bind("42", "octo", "", new Date().toISOString()).run();
	// Insert a token with a 1-year-old created_at (well past the 90d TTL).
	const stale = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
	await testEnv.DB.prepare("INSERT INTO cli_tokens (token, user_id, challenge, created_at) VALUES (?, ?, ?, ?)").bind("stale-but-real-token", 1, "oldchallenge", stale).run();

	const form = new FormData();
	form.set("name", "x");
	form.set("version", "1.0.0");
	form.set("title", "X");
	form.set("description", "X");
	form.set("artifact", new File([taskZip("x") as BlobPart], "x.zip", { type: "application/zip" }));
	const response = await submitTask(
		new Request("https://ugk-task-share.pages.dev/api/tasks/submit", { method: "POST", headers: { authorization: "Bearer stale-but-real-token" }, body: form }),
		testEnv,
	);
	const body = await response.json();

	assert.equal(response.status, 401);
	assert.equal(body.error, "invalid_token");
});

test("githubCallback without a state-bound challenge redirects home as before (normal web login)", async () => {
	// P0 C1+C2: callback reverse-looks-up the challenge from the trusted state.
	// A state with no pending binding = normal web login → redirect "/", not the
	// CLI success page. This is what keeps ordinary web login un-hijacked.
	const testEnv = env();
	const response = await githubCallback(
		new Request("https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=s1", { headers: { cookie: "ugk_oauth_state=s1" } }),
		testEnv,
		{
			fetch: async (url) => {
				if (String(url).includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { headers: { "content-type": "application/json" } });
				return new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "" }), { headers: { "content-type": "application/json" } });
			},
		},
	);

	assert.equal(response.headers.get("location"), "/");
});

test("githubCallback whose pending challenge was already claimed falls back to a normal home redirect", async () => {
	// review M1: an already-consumed challenge (pending row gone) must not
	// hijack a later login into the CLI flow. callback reverse-looks-up the
	// challenge from state; if pending is gone (claimed), it's a normal login.
	const testEnv = env();
	const cookie = await seedUser(testEnv);
	const challenge = "f".repeat(64);
	await startCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge }) }), testEnv);
	const loginState = "22222222-3333-4444-5555-666666666666";
	await githubLogin(new Request(`https://ugk-task-share.pages.dev/api/auth/github?cli_challenge=${challenge}`), testEnv, { randomUUID: () => loginState });
	// Walk through OAuth + explicit confirm to claim the challenge once.
	const oauthFetch = (url) => url.includes("access_token") ? new Response(JSON.stringify({ access_token: "t" }), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "" }), { headers: { "content-type": "application/json" } });
	await githubCallback(new Request(`https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=${loginState}`, { headers: { cookie: `ugk_oauth_state=${loginState}` } }), testEnv, { fetch: oauthFetch });
	await confirmCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/confirm", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: loginState }) }), testEnv);
	// A second callback with the SAME state: pending row is gone (claim deleted
	// it), so reverse-lookup finds nothing → normal web login → "/".
	const response = await githubCallback(new Request(`https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=${loginState}`, { headers: { cookie: `ugk_oauth_state=${loginState}` } }), testEnv, { fetch: oauthFetch });
	assert.equal(response.headers.get("location"), "/");
});

test("createCliToken atomic claim refuses a second signing for an already-claimed challenge", async () => {
	// review H1 (TOCTOU): createCliToken now claims via DELETE...RETURNING, so
	// the first confirm signs a token and deletes the pending row; a second
	// confirm for the same state finds the row gone → 409, no second token.
	const testEnv = env();
	const cookie = await seedUser(testEnv);
	const challenge = "e".repeat(64);
	await startCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/start", { method: "POST", body: JSON.stringify({ challenge }) }), testEnv);
	const state1 = "11111111-2222-3333-4444-555555555555";
	await githubLogin(new Request(`https://ugk-task-share.pages.dev/api/auth/github?cli_challenge=${challenge}`), testEnv, { randomUUID: () => state1 });
	const oauthFetch = (url) => url.includes("access_token") ? new Response(JSON.stringify({ access_token: "t" }), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ id: 42, login: "octo", avatar_url: "" }), { headers: { "content-type": "application/json" } });
	await githubCallback(new Request(`https://ugk-task-share.pages.dev/api/auth/callback?code=abc&state=${state1}`, { headers: { cookie: `ugk_oauth_state=${state1}` } }), testEnv, { fetch: oauthFetch });

	// first confirm: signs a token (atomic claim deletes pending)
	const c1 = await confirmCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/confirm", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: state1 }) }), testEnv);
	assert.equal((await c1.json()).status, "ok");

	// second confirm with the SAME state: pending already claimed → 410 (the
	// reverse-lookup finds no row; createCliToken's own RETURNING never runs)
	const c2 = await confirmCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/confirm", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: state1 }) }), testEnv);
	assert.equal(c2.status, 410);

	// poll returns the one signed token
	const poll = await (await pollCliAuth(new Request("https://ugk-task-share.pages.dev/api/cli/auth/poll", { method: "POST", body: JSON.stringify({ challenge }) }), testEnv)).json();
	assert.equal(poll.status, "ok");
	assert.match(poll.token, /^[0-9a-f]{32}$/);
});

