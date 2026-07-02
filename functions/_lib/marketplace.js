import { unzipSync } from "fflate";

const SESSION_COOKIE = "ugk_session";
const OAUTH_STATE_COOKIE = "ugk_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const TASK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
// 此清单是"最小必需校验集",不是打包全集。CLI publish 扫目录打包全部文件
// (含 scripts/,见 task-share-publish.ts collectExtraFiles),不参考此清单决定打包内容。
// 此处仅用于校验"一个 taskbook 至少得有这 5 个"。
const REQUIRED_FILES = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"];

// CLI publish auth: market site brokers GitHub OAuth for the TUI. TUI POSTs a
// challenge, user logs in on the site; state<->challenge is bound server-side
// (migration 0009) so callback signs a cli_token the TUI polls for. No
// JS-readable challenge cookie — state rides the existing HttpOnly oauth_state.
const CLI_AUTH_TTL_SECONDS = 5 * 60; // pending challenge expiry
// P0 H2: cli_tokens are long-lived but not eternal. 90d balances "don't make
// the user re-auth constantly" against "stale tokens shouldn't linger forever".
const CLI_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function stringToBase64Url(value) {
	return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToString(value) {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function parseCookies(request) {
	const header = request.headers.get("cookie") ?? "";
	return Object.fromEntries(header.split(";").map((part) => {
		const [key, ...rest] = part.trim().split("=");
		return [key, rest.join("=")];
	}).filter(([key]) => key));
}

function json(data, init = {}) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(init.headers ?? {}),
		},
	});
}

// DEV-ONLY structured logging to D1. Covers the CLI auth chain (start/poll/
// callback/createCliToken) so real-device failures — which mock tests can't
// reproduce — leave a trail. Keep while the publish flow stabilizes; drop the
// table + call sites once it's proven in production.
const DEBUG_LOG_MAX_ROWS = 500;
async function debugLog(env, fn, step, detail) {
	try {
		const text = typeof detail === "string" ? detail : JSON.stringify(detail);
		await env.DB.prepare("INSERT INTO debug_log (ts, fn, step, detail) VALUES (?, ?, ?, ?)")
			.bind(new Date().toISOString(), fn, step, text.slice(0, 4000)).run();
		// ponytail: cap growth cheaply. Counting every write wastes a D1 read;
		// rowid is monotonic, so "id <= max - N" trims to the newest N rows.
		// The DELETE is a no-op until the table exceeds the cap.
		await env.DB.prepare("DELETE FROM debug_log WHERE id <= (SELECT MAX(id) FROM debug_log) - ?")
			.bind(DEBUG_LOG_MAX_ROWS).run();
	} catch {
		// logging must never break the request
	}
}

function htmlError(message, status = 400) {
	return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function cleanText(value) {
	return String(value ?? "").trim();
}

function safeFileName(value) {
	return cleanText(value).replaceAll("\\", "/").split("/").pop().replace(/[^A-Za-z0-9._-]/g, "-") || "task.zip";
}

// --- task package validation (server-side mirror of bin/task-install.js) ---
// ponytail: CLI (Node) and Functions (Workers runtime) have different bundling
// boundaries; cross-runtime "reuse" adds build complexity. Two equivalent pure
// functions with cross-referencing comments beat a shared module. Extract when a
// third consumer appears. <=> bin/task-install.js isTaskbook/isRequirementsSpec

function isStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTaskbook(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		(value.scope === "user" || value.scope === "project") &&
		(value.tags === undefined || isStringArray(value.tags))
	);
}

function isRequirementsSpec(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.goal === "string" &&
		value.goal.trim().length > 0 &&
		isStringArray(value.hardConstraints) &&
		value.hardConstraints.length > 0 &&
		isStringArray(value.acceptance) &&
		value.acceptance.length > 0
	);
}

function assertValidContract(contract) {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("Invalid contract.json");
	if (contract.runtimeInput !== undefined && !isStringArray(contract.runtimeInput)) throw new Error("Invalid contract.runtimeInput");
	if (contract.runtimeInputMeta === undefined) return;
	if (!contract.runtimeInputMeta || typeof contract.runtimeInputMeta !== "object" || Array.isArray(contract.runtimeInputMeta)) {
		throw new Error("Invalid contract.runtimeInputMeta");
	}
}

function assertSafePath(file) {
	if (
		typeof file !== "string" ||
		file.length === 0 ||
		file.includes("\\") ||
		file.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`Unsafe file path: ${String(file)}`);
	}
}

function validateTaskPackage(name, files) {
	if (!REQUIRED_FILES.every((file) => files[file] !== undefined)) {
		throw new Error(`Missing required files: ${REQUIRED_FILES.filter((file) => files[file] === undefined).join(", ")}`);
	}
	for (const file of Object.keys(files)) assertSafePath(file);
	const taskbook = JSON.parse(files["taskbook.json"]);
	const spec = JSON.parse(files["spec.json"]);
	const contract = JSON.parse(files["contract.json"]);
	if (!isTaskbook(taskbook)) throw new Error("Invalid taskbook.json");
	if (!isRequirementsSpec(spec)) throw new Error("Invalid spec.json");
	assertValidContract(contract);
	if (taskbook.name !== name) throw new Error(`taskbook.json name mismatch: expected ${name}, got ${String(taskbook.name)}`);
}

// ponytail: 纯 JS 复制版,与 extensions/task/task-share-publish.ts extractScriptReferences
// 同源(Workers 不能直接 import TS)。改一处规则记得同步另一处。第三个消费者出现再抽共享模块。
// 匹配 $TASK_DIR/scripts/x 或 \bscripts/x(文件名带扩展)。
function extractScriptReferences(text) {
	const re = /(?:\$TASK_DIR\/)?(scripts\/[A-Za-z0-9._\-\/]+\.[A-Za-z0-9]+)/g;
	const hits = new Set();
	let m;
	while ((m = re.exec(text)) !== null) {
		hits.add(m[1].replace(/['"\s]/g, ""));
	}
	return [...hits];
}

// 服务端兜底:skill.md/verify.mjs 引用的 scripts 文件必须在包里,否则拒绝发布。
// 跨途径保护(网页直传 zip 也校验),不依赖 CLI publish 端自觉。
function missingReferencedFiles(files) {
	const packaged = new Set(Object.keys(files));
	const missing = [];
	for (const [label, text] of [["skill.md", files["skill.md"] ?? ""], ["verify.mjs", files["verify.mjs"] ?? ""]]) {
		for (const ref of extractScriptReferences(text)) {
			if (!packaged.has(ref)) missing.push({ label, ref });
		}
	}
	return missing;
}

function invalidSourceUrlError(value) {
	try {
		return /^https?:$/i.test(new URL(value).protocol) ? null : "invalid_url_scheme";
	} catch {
		return "invalid_url";
	}
}

async function signature(data, secret) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))));
}

function sameSignature(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

export async function createSessionCookie(user, env) {
	const now = Math.floor(Date.now() / 1000);
	const payload = stringToBase64Url(JSON.stringify({ id: user.id, login: user.login, iat: now, exp: now + SESSION_MAX_AGE }));
	const sig = await signature(payload, env.SESSION_SECRET);
	return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

async function readSession(request, env) {
	const value = parseCookies(request)[SESSION_COOKIE];
	if (!value || !env.SESSION_SECRET) return null;
	const [payload, sig] = value.split(".");
	if (!payload || !sig || !sameSignature(sig, await signature(payload, env.SESSION_SECRET))) return null;
	const session = JSON.parse(base64UrlToString(payload));
	if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
	return session;
}

async function sessionUser(request, env) {
	const session = await readSession(request, env);
	if (!session) return null;
	return await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.id).first();
}

async function ensureTask(env, name) {
	const now = new Date().toISOString();
	await env.DB.prepare(
		"INSERT OR IGNORE INTO tasks (name, title, description, author_name, created_at) VALUES (?, ?, ?, ?, ?)",
	).bind(name, name, "", "UGK Official", now).run();
}

async function taskCounts(env, name) {
	const row = await env.DB.prepare("SELECT download_count, like_count, favorite_count FROM tasks WHERE name = ?").bind(name).first();
	return {
		downloads: row?.download_count ?? 0,
		likes: row?.like_count ?? 0,
		favorites: row?.favorite_count ?? 0,
	};
}

async function taskFlags(env, user, name) {
	if (!user) return { liked: false, favorited: false, downloaded: false };
	const liked = await env.DB.prepare("SELECT 1 FROM task_likes WHERE task_name = ? AND user_id = ?").bind(name, user.id).first();
	const favorited = await env.DB.prepare("SELECT 1 FROM task_favorites WHERE task_name = ? AND user_id = ?").bind(name, user.id).first();
	const downloaded = await env.DB.prepare("SELECT 1 FROM download_events WHERE task_name = ? AND user_id = ?").bind(name, user.id).first();
	return { liked: Boolean(liked), favorited: Boolean(favorited), downloaded: Boolean(downloaded) };
}

export async function githubLogin(request, env, deps = {}) {
	if (!env.GITHUB_CLIENT_ID) {
		return json({ error: "GitHub OAuth is not configured" }, { status: 500 });
	}

	const state = deps.randomUUID?.() ?? crypto.randomUUID();
	// P0 C1+C2: CLI publish flow arrives as /api/auth/github?cli_challenge=<c>.
	// Bind state<->challenge server-side so callback can reverse-look-up the
	// challenge from the HttpOnly oauth_state cookie it already trusts — the
	// challenge never enters a JS-readable cookie. No param = normal web login.
	const cliChallenge = new URL(request.url).searchParams.get("cli_challenge");
	if (cliChallenge) {
		await env.DB.prepare("UPDATE cli_auth_pending SET state = ? WHERE challenge = ?")
			.bind(state, cliChallenge).run();
	}
	const url = new URL("https://github.com/login/oauth/authorize");
	const origin = env.SITE_URL ?? new URL(request.url).origin;
	url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
	url.searchParams.set("scope", "read:user");
	url.searchParams.set("state", state);
	return new Response(null, {
		status: 302,
		headers: {
			location: url.href,
			"set-cookie": `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
		},
	});
}

export async function githubCallback(request, env, deps = {}) {
 try {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const cookieState = parseCookies(request)[OAUTH_STATE_COOKIE];
	await debugLog(env, "callback", "enter", { stateOk: state === cookieState, hasCode: Boolean(code), origin: url.origin });
	if (!state || !cookieState || state !== cookieState) return htmlError("Invalid OAuth state", 400);
	// P0 C1+C2: reverse-look-up the CLI challenge from the now-trusted state.
	// No row = normal web login (state wasn't bound to a challenge). This replaces
	// the old JS-readable ugk_cli_challenge cookie entirely.
	const cliPending = await env.DB.prepare("SELECT challenge FROM cli_auth_pending WHERE state = ?").bind(state).first();
	const cliChallenge = cliPending?.challenge ?? null;
	if (!code) return htmlError("Missing OAuth code", 400);
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return htmlError("GitHub OAuth is not configured", 500);

	const origin = env.SITE_URL ?? url.origin;
	const fetchFn = deps.fetch ?? fetch;
	const tokenResponse = await fetchFn("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${origin}/api/auth/callback`,
		}),
	});
	const token = await tokenResponse.json();
	// SECURITY: never log the access_token or full token response (review C-REZ-1).
	// Only record status + GitHub's error code on failure (no secret material).
	await debugLog(env, "callback", "token_exchange", { status: tokenResponse.status, hasAccessToken: Boolean(token && token.access_token), error: token?.error ?? null });
	if (!token.access_token) return htmlError("GitHub token exchange failed", 502);

	const userResponse = await fetchFn("https://api.github.com/user", {
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token.access_token}`,
			"user-agent": "ugk-task-share",
		},
	});
	const githubUser = await userResponse.json();
	// SECURITY: never log the full GitHub user object (review H-REZ-2: contains
	// email/private fields). Only status + id + login (non-secret identifiers).
	await debugLog(env, "callback", "user_fetch", { status: userResponse.status, hasId: Boolean(githubUser && githubUser.id), login: githubUser?.login ?? null });
	if (!githubUser.id || !githubUser.login) return htmlError("GitHub user fetch failed", 502);

	const now = new Date().toISOString();
	await env.DB.prepare(
		"INSERT INTO users (github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url",
	).bind(String(githubUser.id), githubUser.login, githubUser.avatar_url ?? "", now).run();
	const user = await env.DB.prepare("SELECT * FROM users WHERE github_id = ?").bind(String(githubUser.id)).first();
	const headers = new Headers();
	// SECURITY (review H-REZ-1): do NOT auto-sign a cli_token here. A challenge
	// can be injected into a victim's OAuth via a phishing link, silently issuing
	// a long-lived impersonating token. Instead, send the user to an explicit
	// confirmation page keyed by `state`; the token is only signed when the user
	// confirms via POST /api/cli/auth/confirm (authenticated by their session
	// cookie, not the OAuth state). cliChallenge null = normal web login.
	if (cliChallenge) {
		await debugLog(env, "callback", "cli_confirm_redirect", { login: githubUser.login });
		headers.set("location", `/cli-auth?cli=confirm&state=${encodeURIComponent(state)}`);
	} else {
		headers.set("location", "/");
	}
	headers.append("set-cookie", await createSessionCookie(user, env));
	headers.append("set-cookie", `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
	return new Response(null, { status: 302, headers });
 } catch (e) {
	await debugLog(env, "callback", "exception", String(e && e.stack ? e.stack : e));
	return htmlError("callback crashed (see debug_log)", 500);
 }
}

export async function currentSession(request, env) {
	const user = await sessionUser(request, env);
	return json({ user: user ? { id: user.id, login: user.login, avatarUrl: user.avatar_url } : null });
}

export async function marketplaceStats(env) {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS task_count, COALESCE(SUM(download_count), 0) AS download_count, COALESCE(SUM(like_count), 0) AS like_count, COALESCE(SUM(favorite_count), 0) AS favorite_count FROM tasks",
	).first();
	return json({
		tasks: row?.task_count ?? 0,
		downloads: row?.download_count ?? 0,
		likes: row?.like_count ?? 0,
		favorites: row?.favorite_count ?? 0,
	});
}

export async function accountFavorites(request, env) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	const rows = await env.DB.prepare(
		`SELECT tasks.name, tasks.title, tasks.description, tasks.author_name, tasks.download_count, tasks.like_count, tasks.favorite_count
		FROM task_favorites
		JOIN tasks ON tasks.name = task_favorites.task_name
		WHERE task_favorites.user_id = ?
		ORDER BY task_favorites.created_at DESC`,
	).bind(auth.user.id).all();
	return json({ favorites: rows.results ?? [] });
}

export function logout() {
	return new Response(null, {
		status: 204,
		headers: { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
	});
}

// CLI publish flow: Bearer token (random, stored in cli_tokens) lets the TUI
// authenticate without a cookie. Isolated from requireUser on purpose — Bearer
// must NOT silently widen every cookie-authed write endpoint (like/favorite/
// report/...), so only submitTask opts into it. ponytail: design doc proposed
// HMAC-signed user_id, but that can't be revoked without a denylist; a random
// token validated by table lookup is natively revocable (DELETE FROM cli_tokens).
async function requireBearerUser(request, env) {
	const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (!bearer) return { response: json({ error: "login_required" }, { status: 401 }) };
	// P0 H2: expire old tokens. Lazy GC (same pattern as cli_auth_pending cleanup
	// in startCliAuth — Workers free has no cron) trims expired rows, then the
	// lookup enforces the TTL so a GC-missed expired token still 401s.
	const cutoff = new Date(Date.now() - CLI_TOKEN_TTL_SECONDS * 1000).toISOString();
	await env.DB.prepare("DELETE FROM cli_tokens WHERE created_at < ?").bind(cutoff).run();
	const row = await env.DB.prepare(
		"SELECT users.* FROM cli_tokens JOIN users ON users.id = cli_tokens.user_id WHERE cli_tokens.token = ? AND cli_tokens.created_at > ?",
	).bind(bearer, cutoff).first();
	if (row) return { user: row };
	return { response: json({ error: "invalid_token" }, { status: 401 }) };
}

async function requireUser(request, env) {
	const user = await sessionUser(request, env);
	if (!user) return { response: json({ error: "login_required" }, { status: 401 }) };
	return { user };
}

async function requireAdmin(request, env) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth;
	const admins = String(env.ADMIN_GITHUB_LOGINS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
	if (!admins.includes(String(auth.user.login).toLowerCase())) return { response: json({ error: "admin_required" }, { status: 403 }) };
	return auth;
}

// --- CLI publish auth (TUI -> site-brokered GitHub OAuth) ---
// TUI generates challenge, POSTs here; site records it pending. User then
// visits /cli-auth?c=<challenge>, which stashes it in a cookie and kicks off
// GitHub OAuth. On callback, createCliToken signs a cli_token bound to the
// challenge; TUI polls pollCliAuth to retrieve it.

export async function startCliAuth(request, env, deps = {}) {
	const body = await request.json().catch(() => ({}));
	const challenge = cleanText(body.challenge);
	if (!challenge || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) {
		return json({ error: "invalid_challenge" }, { status: 400 });
	}
	const now = new Date().toISOString();
	// Clean expired pending entries on write (lazy GC; no cron in Workers free).
	await env.DB.prepare("DELETE FROM cli_auth_pending WHERE created_at < ?").bind(new Date(Date.now() - CLI_AUTH_TTL_SECONDS * 1000).toISOString()).run();
	await env.DB.prepare(
		"INSERT OR REPLACE INTO cli_auth_pending (challenge, created_at) VALUES (?, ?)",
	).bind(challenge, now).run();
	const origin = env.SITE_URL ?? new URL(request.url).origin;
	await debugLog(env, "startCliAuth", "pending_inserted", { challenge, origin });
	return json({ url: `${origin}/cli-auth?c=${encodeURIComponent(challenge)}` });
}

export async function pollCliAuth(request, env) {
	const body = await request.json().catch(() => ({}));
	const challenge = cleanText(body.challenge);
	if (!challenge) return json({ error: "invalid_challenge" }, { status: 400 });
	const tokenRow = await env.DB.prepare(
		"SELECT token, user_id, created_at FROM cli_tokens WHERE challenge = ? ORDER BY created_at DESC LIMIT 1",
	).bind(challenge).first();
	if (tokenRow) {
		const user = await env.DB.prepare("SELECT login, avatar_url FROM users WHERE id = ?").bind(tokenRow.user_id).first();
		// Claim: drop pending + any older sibling tokens for this challenge,
		// keeping only the newest (the one returned). submitTask looks up
		// cli_tokens BY token (not challenge), so the kept token stays usable;
		// revocation stays a manual DELETE. A repeated poll of the same challenge
		// returns the same (still-valid) token — that's harmless idempotency for
		// a TUI retry, and only the 32-byte-random challenge holder can poll it.
		await env.DB.prepare("DELETE FROM cli_auth_pending WHERE challenge = ?").bind(challenge).run();
		await env.DB.prepare("DELETE FROM cli_tokens WHERE challenge = ? AND created_at < ?").bind(challenge, tokenRow.created_at ?? "").run();
		await debugLog(env, "pollCliAuth", "ok", { challenge, login: user?.login ?? null });
		return json({ status: "ok", token: tokenRow.token, login: user?.login ?? null, avatarUrl: user?.avatar_url ?? null });
	}
	const pending = await env.DB.prepare("SELECT 1 FROM cli_auth_pending WHERE challenge = ?").bind(challenge).first();
	if (pending) return json({ status: "pending" });
	await debugLog(env, "pollCliAuth", "not_found", { challenge });
	return json({ status: "error", error: "challenge_expired_or_unknown" }, { status: 410 });
}

// Called from githubCallback when a cli_challenge cookie is present: signs a
// random cli_token bound to (user, challenge) so the polling TUI can claim it.
// Returns null (and signs nothing) if the challenge isn't pending — this guards
// the normal web-login path against a stale cli cookie that lingered after a
// previous CLI auth was interrupted/expired (review M1): without it, a stale
// cookie would hijack every subsequent web login into the CLI flow.
export async function createCliToken(user, challenge, env, deps = {}) {
	// Atomic claim: DELETE...RETURNING consumes the pending row in one statement.
	// If two OAuth callbacks race (two tabs), only the first DELETE removes a
	// row → RETURNING yields it; the second deletes 0 rows → null. This closes
	// the TOCTOU that separate SELECT/INSERT/DELETE had (review H1 correctness).
	// ponytail: SQLite/D1 RETURNING is supported; mock DB mirrors it (.first()).
	const claimed = await env.DB.prepare("DELETE FROM cli_auth_pending WHERE challenge = ? RETURNING challenge").bind(challenge).first();
	if (!claimed) return null;
	// ponytail: call crypto.randomUUID directly (not as a detached reference).
	// `(deps.randomUUID ?? crypto.randomUUID)()` would strip `this` → Workers
	// throws "Illegal invocation: function called with incorrect this reference".
	// Node's crypto is lenient so mock tests miss this; only Workers catches it.
	const raw = deps.randomUUID ? deps.randomUUID() : crypto.randomUUID();
	const token = raw.replaceAll("-", "");
	await env.DB.prepare(
		"INSERT INTO cli_tokens (token, user_id, challenge, created_at) VALUES (?, ?, ?, ?)",
	).bind(token, user.id, challenge, new Date().toISOString()).run();
	return token;
}

// SECURITY (review H-REZ-1): the second half of the CSRF defense. The callback
// no longer signs a token directly — it redirects to a confirmation page. The
// user must explicitly POST here to authorize. Auth is by the SESSION cookie
// (requireUser), NOT the OAuth state: an attacker who only injected a challenge
// into a victim's OAuth has no session, so they cannot reach this. The state
// merely reverse-looks-up the challenge; createCliToken then claims it atomically.
export async function confirmCliAuth(request, env) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	const body = await request.json().catch(() => ({}));
	const state = cleanText(body.state);
	if (!state) return json({ error: "invalid_state" }, { status: 400 });
	const pending = await env.DB.prepare("SELECT challenge FROM cli_auth_pending WHERE state = ?").bind(state).first();
	if (!pending?.challenge) return json({ error: "challenge_not_pending" }, { status: 410 });
	const token = await createCliToken(auth.user, pending.challenge, env);
	await debugLog(env, "confirmCliAuth", "signed", { login: auth.user.login, ok: Boolean(token) });
	if (!token) return json({ error: "already_claimed" }, { status: 409 });
	return json({ status: "ok", token, login: auth.user.login, avatarUrl: auth.user.avatar_url ?? null });
}

export async function submitTask(request, env) {
	// Submit is the only endpoint that accepts BOTH a cookie session (web upload
	// page) and a Bearer cli_token (TUI publish). Bearer is preferred when the
	// Authorization header is present; otherwise fall back to the cookie session.
	const hasBearer = request.headers.get("authorization")?.startsWith("Bearer ");
	const auth = hasBearer ? await requireBearerUser(request, env) : await requireUser(request, env);
	if (auth.response) return auth.response;
	const form = await request.formData();
	const name = cleanText(form.get("name"));
	const version = cleanText(form.get("version"));
	const title = cleanText(form.get("title"));
	const description = cleanText(form.get("description"));
	const artifact = form.get("artifact");
	const hasArtifact = artifact && typeof artifact === "object" && "arrayBuffer" in artifact && artifact.size > 0;
	if (!TASK_NAME_RE.test(name)) return json({ error: "invalid_name" }, { status: 400 });
	if (!VERSION_RE.test(version)) return json({ error: "invalid_version" }, { status: 400 });
	// review M6: reject a version that's already published for this task. Without
	// this, a re-submit of an existing version silently no-ops at publish time
	// (task_versions UNIQUE DO NOTHING) and the user believes they shipped a new
	// version while latest_version still points at the old one. Fail fast instead.
	const existingVersion = await env.DB.prepare("SELECT 1 FROM task_versions WHERE task_name = ? AND version = ?").bind(name, version).first();
	if (existingVersion) return json({ error: "version_already_published" }, { status: 409 });
	if (!title || !description) return json({ error: "missing_required_fields" }, { status: 400 });
	if (!hasArtifact) return json({ error: "artifact_required" }, { status: 400 });
	if (artifact.size > MAX_ARTIFACT_BYTES) return json({ error: "artifact_too_large" }, { status: 413 });
	if (!env.TASK_UPLOADS) return json({ error: "upload_storage_not_configured" }, { status: 500 });

	// Unzip → validate → store as individual files in R2 (not the raw zip).
	// CLI fetches files individually via manifest; storing loose files means
	// zero changes on the client side (no zip decompression in Node).
	const bytes = new Uint8Array(await artifact.arrayBuffer());
	let files;
	try {
		const extracted = unzipSync(bytes);
		// Strip a single common wrapper directory if every file sits under it.
		// Creators naturally run `zip -r foo.zip foo/`, producing foo/taskbook.json;
		// REQUIRED_FILES expects taskbook.json at the root.
		const entries = Object.keys(extracted).filter((p) => !p.endsWith("/"));
		const firstSegs = entries.map((p) => p.split("/").filter(Boolean)[0]);
		const wrapper = firstSegs.length && firstSegs.every((s) => s === firstSegs[0]) ? `${firstSegs[0]}/` : "";
		files = {};
		for (const [path, data] of Object.entries(extracted)) {
			if (path.endsWith("/")) continue;
			const rel = (wrapper && path.startsWith(wrapper) ? path.slice(wrapper.length) : path).split("/").filter(Boolean).join("/");
			files[rel] = new TextDecoder().decode(data);
		}
	} catch {
		return json({ error: "invalid_zip" }, { status: 400 });
	}
	try {
		validateTaskPackage(name, files);
	} catch (error) {
		return json({ error: "invalid_package", detail: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}

	// 引用完整性兜底:skill.md/verify.mjs 引用的 scripts 文件必须在包里。
	// CLI publish 端有同源校验,这里保护网页直传等其他途径。
	const missing = missingReferencedFiles(files);
	if (missing.length > 0) {
		return json({ error: "missing_referenced_file", detail: missing.map((m) => `${m.label} 引用 ${m.ref} 但包内无此文件`).join("; ") }, { status: 400 });
	}

	const prefix = `tasks/${name}/${version}`;
	try {
		for (const [file, content] of Object.entries(files)) {
			await env.TASK_UPLOADS.put(`${prefix}/${file}`, content);
		}
	} catch (e) {
		return json({ error: "r2_write_failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}

	const now = new Date().toISOString();
	try {
		const result = await env.DB.prepare(
			`INSERT INTO task_submissions (user_id, name, version, title, description, source_type, source_url, artifact_key, artifact_name, file_list, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(auth.user.id, name, version, title, description, "upload", null, prefix, `${name}-${version}.zip`, JSON.stringify(Object.keys(files)), now, now).run();
		return json({ id: result.meta?.last_row_id ?? null, name, version, title, description, status: "pending" });
	} catch (e) {
		return json({ error: "db_write_failed", detail: JSON.stringify(e, Object.getOwnPropertyNames(e)) }, { status: 500 });
	}
}

export async function accountSubmissions(request, env) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	const rows = await env.DB.prepare(
		`SELECT task_submissions.*, users.login AS author_login
		FROM task_submissions
		JOIN users ON users.id = task_submissions.user_id
		WHERE task_submissions.user_id = ?
		ORDER BY task_submissions.created_at DESC`,
	).bind(auth.user.id).all();
	return json({ submissions: rows.results ?? [] });
}

export async function accountDownloads(request, env) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	const rows = await env.DB.prepare(
		`SELECT download_events.task_name AS name, download_events.created_at, tasks.title, tasks.description, tasks.author_name
		FROM download_events
		JOIN tasks ON tasks.name = download_events.task_name
		WHERE download_events.user_id = ?
		ORDER BY download_events.created_at DESC`,
	).bind(auth.user.id).all();
	return json({ downloads: rows.results ?? [] });
}

export async function adminSubmissions(request, env) {
	const auth = await requireAdmin(request, env);
	if (auth.response) return auth.response;
	const rows = await env.DB.prepare(
		`SELECT task_submissions.*, users.login AS author_login
		FROM task_submissions
		JOIN users ON users.id = task_submissions.user_id
		WHERE task_submissions.status = 'pending'
		ORDER BY task_submissions.created_at ASC`,
	).all();
	return json({ submissions: rows.results ?? [] });
}

export async function adminReports(request, env) {
	const auth = await requireAdmin(request, env);
	if (auth.response) return auth.response;
	const rows = await env.DB.prepare(
		`SELECT task_reports.*, users.login AS reporter_login, tasks.title
		FROM task_reports
		JOIN users ON users.id = task_reports.user_id
		JOIN tasks ON tasks.name = task_reports.task_name
		WHERE task_reports.status = 'open'
		ORDER BY task_reports.created_at ASC`,
	).all();
	return json({ reports: rows.results ?? [] });
}

export async function reviewSubmission(request, env, id) {
	const auth = await requireAdmin(request, env);
	if (auth.response) return auth.response;
	const body = await request.json().catch(() => ({}));
	const status = cleanText(body.status);
	if (!["approved", "rejected", "published"].includes(status)) return json({ error: "invalid_status" }, { status: 400 });
	const submission = await env.DB.prepare(
		`SELECT task_submissions.*, users.login AS author_login
		FROM task_submissions
		JOIN users ON users.id = task_submissions.user_id
		WHERE task_submissions.id = ?`,
	).bind(Number(id)).first();
	if (!submission) return json({ error: "submission_not_found" }, { status: 404 });

	const now = new Date().toISOString();
	try {
		if (status === "published") {
			const version = submission.version;
			await env.DB.prepare(
				`INSERT INTO tasks (name, title, description, author_user_id, author_name, latest_version, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					author_user_id = excluded.author_user_id,
					author_name = excluded.author_name,
					latest_version = excluded.latest_version`,
			).bind(submission.name, submission.title, submission.description, submission.user_id, submission.author_login ?? "Community", version, now).run();
			await env.DB.prepare(
				`INSERT INTO task_versions (task_name, version, submission_id, artifact_key, source_url, published_by_user_id, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(task_name, version) DO NOTHING`,
			).bind(submission.name, version, submission.id, submission.artifact_key, submission.source_url, auth.user.id, now).run();
		}
		await env.DB.prepare(
			"UPDATE task_submissions SET status = ?, reviewer_user_id = ?, review_note = ?, updated_at = ? WHERE id = ?",
		).bind(status, auth.user.id, cleanText(body.note), now, Number(id)).run();
	} catch (e) {
		// review known-debt: the two INSERTs + UPDATE were unguarded; a D1 failure
		// crashed the Worker into an HTML 500. submitTask already had this guard.
		return json({ error: "review_db_write_failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}
	return json({ id: Number(id), name: submission.name, status });
}

export async function communityTasks(env) {
	const rows = await env.DB.prepare(
		`SELECT task_submissions.*, users.login AS author_login, tasks.download_count, tasks.like_count, tasks.favorite_count
		FROM task_submissions
		JOIN users ON users.id = task_submissions.user_id
		LEFT JOIN tasks ON tasks.name = task_submissions.name
		WHERE task_submissions.status = 'published'
		ORDER BY task_submissions.updated_at DESC`,
	).all();
	return json({ tasks: (rows.results ?? []).map((task) => ({
		id: task.id,
		name: task.name,
		title: task.title,
		description: task.description,
		author: task.author_login ?? "Community",
		downloads: task.download_count ?? 0,
		likes: task.like_count ?? 0,
		favorites: task.favorite_count ?? 0,
		sourceUrl: task.source_url,
		downloadUrl: task.artifact_key ? `/api/submissions/${task.id}/artifact` : task.source_url,
	})) });
}

export async function downloadSubmissionArtifact(env, id) {
	const submission = await env.DB.prepare("SELECT task_submissions.* FROM task_submissions WHERE id = ?").bind(Number(id)).first();
	if (!submission || submission.status !== "published") return json({ error: "artifact_not_found" }, { status: 404 });
	if (!submission.artifact_key || !env.TASK_UPLOADS) return json({ error: "artifact_not_available" }, { status: 404 });
	const object = await env.TASK_UPLOADS.get(submission.artifact_key);
	if (!object) return json({ error: "artifact_not_found" }, { status: 404 });
	return new Response(object.body, {
		headers: {
			"content-type": object.httpMetadata?.contentType ?? "application/zip",
			"content-disposition": `attachment; filename="${safeFileName(submission.artifact_name || `${submission.name}.zip`)}"`,
		},
	});
}

export async function reportTask(request, env, name) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	await ensureTask(env, name);
	const body = await request.json().catch(() => ({}));
	const reason = cleanText(body.reason);
	if (!reason) return json({ error: "reason_required" }, { status: 400 });
	const existing = await env.DB.prepare("SELECT 1 FROM task_reports WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).first();
	if (!existing) {
		await env.DB.prepare(
			`INSERT INTO task_reports (task_name, user_id, reason, status, created_at)
			VALUES (?, ?, ?, 'open', ?)
			ON CONFLICT(task_name, user_id) DO NOTHING`,
		).bind(name, auth.user.id, reason.slice(0, 1000), new Date().toISOString()).run();
	}
	return json({ reported: true });
}

export async function toggleLike(request, env, name) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	await ensureTask(env, name);
	const existing = await env.DB.prepare("SELECT 1 FROM task_likes WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).first();
	if (existing) {
		await env.DB.prepare("DELETE FROM task_likes WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).run();
		await env.DB.prepare("UPDATE tasks SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE name = ?").bind(name).run();
	} else {
		await env.DB.prepare("INSERT INTO task_likes (task_name, user_id, created_at) VALUES (?, ?, ?)").bind(name, auth.user.id, new Date().toISOString()).run();
		await env.DB.prepare("UPDATE tasks SET like_count = like_count + 1 WHERE name = ?").bind(name).run();
	}
	return json({ liked: !existing, ...(await taskCounts(env, name)) });
}

export async function toggleFavorite(request, env, name) {
	const auth = await requireUser(request, env);
	if (auth.response) return auth.response;
	await ensureTask(env, name);
	const existing = await env.DB.prepare("SELECT 1 FROM task_favorites WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).first();
	if (existing) {
		await env.DB.prepare("DELETE FROM task_favorites WHERE task_name = ? AND user_id = ?").bind(name, auth.user.id).run();
		await env.DB.prepare("UPDATE tasks SET favorite_count = CASE WHEN favorite_count > 0 THEN favorite_count - 1 ELSE 0 END WHERE name = ?").bind(name).run();
	} else {
		await env.DB.prepare("INSERT INTO task_favorites (task_name, user_id, created_at) VALUES (?, ?, ?)").bind(name, auth.user.id, new Date().toISOString()).run();
		await env.DB.prepare("UPDATE tasks SET favorite_count = favorite_count + 1 WHERE name = ?").bind(name).run();
	}
	return json({ favorited: !existing, ...(await taskCounts(env, name)) });
}

export async function getTaskStats(request, env, name) {
	await ensureTask(env, name);
	const user = await sessionUser(request, env);
	return json({ ...(await taskCounts(env, name)), ...(await taskFlags(env, user, name)) });
}

export async function getTaskStatsDetail(env, name) {
	await ensureTask(env, name);
	const rows = await env.DB.prepare(
		`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS download_count
		FROM download_events
		WHERE task_name = ?
		GROUP BY day
		ORDER BY day DESC
		LIMIT 14`,
	).bind(name).all();
	return json({ days: (rows.results ?? []).map((row) => ({ day: row.day, downloads: row.download_count ?? 0 })) });
}

export async function getTaskVersions(env, name) {
	const rows = await env.DB.prepare(
		`SELECT version, submission_id, artifact_key, source_url, published_by_user_id, created_at
		FROM task_versions
		WHERE task_name = ?
		ORDER BY created_at DESC`,
	).bind(name).all();
	return json({ versions: rows.results ?? [] });
}

export async function recordDownload(request, env, name) {
	const user = await sessionUser(request, env);
	await ensureTask(env, name);
	await env.DB.prepare("INSERT INTO download_events (task_name, user_id, created_at) VALUES (?, ?, ?)").bind(name, user?.id ?? null, new Date().toISOString()).run();
	await env.DB.prepare("UPDATE tasks SET download_count = download_count + 1 WHERE name = ?").bind(name).run();
	return json(await taskCounts(env, name));
}

// --- manifest: CLI install entry point ---
// Reads published tasks from D1 and maps each to its latest version's loose
// files in R2. One source of truth (no static + dynamic merge); CLI fetches
// this JSON then pulls each file URL individually.

export async function buildManifest(request, env) {
	const rows = await env.DB.prepare(
		`SELECT name, title, description, author_name, latest_version
		FROM tasks
		WHERE latest_version IS NOT NULL
		ORDER BY name`,
	).all();
	const origin = new URL(request.url).origin;
	const tasks = await Promise.all((rows.results ?? []).map(async (task) => {
		const submission = await env.DB.prepare(
			"SELECT file_list FROM task_submissions WHERE name = ? AND version = ? AND status = 'published' ORDER BY updated_at DESC LIMIT 1",
		).bind(task.name, task.latest_version).first();
		const fileList = JSON.parse(submission?.file_list ?? "[]");
		const files = Object.fromEntries(fileList.map((file) => [
			file,
			`${origin}/api/tasks/${encodeURIComponent(task.name)}/files?f=${encodeURIComponent(file)}`,
		]));
		return { name: task.name, title: task.title, description: task.description, author: task.author_name, version: task.latest_version, files };
	}));
	return json({ version: 1, generatedAt: new Date().toISOString(), tasks });
}

export async function serveTaskFile(env, name, file) {
	assertSafePath(file);
	const task = await env.DB.prepare("SELECT latest_version FROM tasks WHERE name = ?").bind(name).first();
	if (!task?.latest_version) return json({ error: "task_not_found" }, { status: 404 });
	const object = await env.TASK_UPLOADS.get(`tasks/${name}/${task.latest_version}/${file}`);
	if (!object) return json({ error: "file_not_found" }, { status: 404 });
	return new Response(object.body, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
