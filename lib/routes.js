/**
 * The /api/subagent-model route family: read/write the user config
 * (`~/.dsh/subagent-model.json`), list the selectable models from the
 * `llm-pi-ai` settings section, and serve the read-only run roster (run
 * metadata for one workspace, merged with live residency). The browser half
 * (Settings > Plugins card + toolview cards) talks to these routes only —
 * never to the settings RPC, so no api-proxy whitelist change is needed.
 *
 * Writes carry a loopback + same-origin trust fence (mirrors dsh-ssh): a
 * LAN-exposed dsh web deployment must not let a foreign origin rewrite the
 * config. Reads (models + runs) are harmless and stay open.
 */

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Loopback literal check plus browser same-origin markers (dsh-ssh pattern). */
function isLoopbackRequest(request) {
	const address = request.socket?.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers?.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
	res.end(payload);
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return undefined;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Register the shared route family ONCE per process.
 *
 * The profile patch mounts this plugin as TWO rows (spawn + fork tools), and
 * every row's `apply()` runs separately against the SAME `webServer`. The
 * route family is process-global and shared by all rows (they read/write the
 * same user-config file), so a per-instance registration would throw
 * "duplicate exact route" on the second row and fail the whole boot — the
 * v0.2.0 regression. A module-level flag makes the second row a no-op.
 *
 * Real conflicts (another plugin owning the same path) still fail loud on the
 * first registrant, matching the webserver's composition-level contract.
 * @param ctx - plugin context with `webServer`.
 * @param deps - store accessors and the live model catalog reader.
 */
let sharedRoutesRegistered = false;

export function registerRoutesOnce(ctx, deps) {
	if (sharedRoutesRegistered) return;
	sharedRoutesRegistered = true;
	const { routes } = makeRoutes(deps);
	ctx.effect(
		() => {
			const disposers = routes.map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		},
		"tool-subagent-model: routes"
	);
}

/** Test seam: clear the per-process flag so a fresh context can register again. */
export function resetRoutesOnceForTesting() {
	sharedRoutesRegistered = false;
}

/**
 * Build the route family.
 * @param deps - store accessors, the live model catalog reader, and the
 *   roster reader (`readRuns({ cwd, sessionId })` → run records merged with
 *   live residency).
 * @returns the `WebRoute` list for `ctx.webServer.register`.
 */
export function makeRoutes({ readConfig, writeConfig, validateConfig, readEntries, readRuns }) {
	const routes = [
		{
			kind: "exact",
			path: "/api/subagent-model/config",
			handler: async (req, res) => {
				if (req.method === "GET") {
					writeJson(res, 200, { config: readConfig() });
					return;
				}
				if (req.method === "POST") {
					if (!isLoopbackRequest(req)) {
						writeJson(res, 403, { error: "forbidden: config writes are loopback-only" });
						return;
					}
					const body = await readJsonBody(req);
					if (body === undefined) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const modelIds = readEntries().map((entry) => entry.model);
					const verdict = validateConfig(body, modelIds);
					if (!verdict.ok) {
						writeJson(res, 400, { error: verdict.error });
						return;
					}
					writeJson(res, 200, { ok: true, config: writeConfig(verdict.config) });
					return;
				}
				writeJson(res, 405, { error: "method not allowed" });
			}
		},
		{
			kind: "exact",
			path: "/api/subagent-model/models",
			handler: (req, res) => {
				if (req.method !== "GET") {
					writeJson(res, 405, { error: "method not allowed" });
					return;
				}
				writeJson(res, 200, { entries: readEntries() });
			}
		},
		{
			kind: "exact",
			path: "/api/subagent-model/runs",
			handler: async (req, res) => {
				if (req.method !== "GET") {
					writeJson(res, 405, { error: "method not allowed" });
					return;
				}
				// Read-only roster: run metadata for one workspace, merged with
				// live residency. No loopback fence (reads are harmless; the
				// payload contains no file contents or prompts).
				const url = new URL(req.url ?? "/", "http://x");
				const cwd = url.searchParams.get("cwd") ?? "";
				const sessionId = url.searchParams.get("sessionId") ?? "";
				try {
					const runs = typeof readRuns === "function" ? await readRuns({ cwd, sessionId }) : [];
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
						"referrer-policy": "no-referrer"
					});
					res.end(JSON.stringify({ runs }));
				} catch (error) {
					writeJson(res, 500, { error: `roster read failed: ${String(error)}` });
				}
			}
		}
	];
	return { routes };
}
