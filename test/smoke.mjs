/**
 * Mock-host smoke test for dsh-tool-subagent-model.
 *
 * Runs against the REAL `@deepseek-ai/dsh-tools` (defineTool validates the
 * schema) and `@deepseek-ai/dsh-subagent`, with a stubbed Cordis context.
 * Execute with:  node test/smoke.mjs  (from the package directory)
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apply,
	flattenProviders,
	installEndListenerOnce,
	resetEndListenerForTesting,
	resolveRoute,
	sameEntries
} from "../lib/index.js";
import { readUserConfig, setConfigPathForTesting, validateUserConfigPatch, writeUserConfig } from "../lib/config-store.js";
import { makeRoutes, registerRoutesOnce, resetRoutesOnceForTesting } from "../lib/routes.js";
import {
	childEntry,
	createRun,
	firstText,
	listRuns,
	resetRegistryForTesting,
	settleRun,
	unsatisfiedDependencies
} from "../lib/registry.js";
import { resetStatusToolForTesting } from "../lib/status-tool.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const initialSection = {
	providers: {
		"provider-a": {
			models: [
				{ id: "model-fast", name: "Fast Model" },
				{ id: "model-pro", name: "Pro Model" }
			]
		},
		"provider-b": {
			models: [
				{ id: "model-pro", name: "Pro Model (mirror)" }
			]
		}
	}
};

const providers = {
	spawn: {
		name: "spawn",
		inheritsParentContext: false,
		capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
		prepareContinuable: async () => ({})
	},
	fork: {
		name: "fork",
		inheritsParentContext: true,
		capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
		prepareContinuable: async () => ({ seed: [] })
	},
	nopersona: {
		name: "nopersona",
		inheritsParentContext: false,
		capabilities: { outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
		prepareContinuable: async () => ({})
	}
};

/** Session events appended by the plugin (audit trail). */
const appendedEvents = [];

function makeCtx({ sectionRef = { current: initialSection }, jobRegistry = undefined } = {}) {
	const bus = new Map();
	const state = {
		registrations: [],
		sections: [],
		starts: [],
		continuables: [],
		routes: [],
		routeKeys: new Set(),
		disposed: 0
	};
	const settings = { get: (ns) => (ns === "llm-pi-ai" ? sectionRef.current : undefined) };
	const ctx = {
		state,
		get: (key) => (key === "settings" ? settings : key === "jobs" ? jobRegistry : undefined),
		on: (event, fn) => {
			if (!bus.has(event)) bus.set(event, []);
			bus.get(event).push(fn);
		},
		emit: (event, ...args) => {
			for (const fn of bus.get(event) ?? []) fn(...args);
		},
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		tools: {
			register: (definition) => {
				state.registrations.push(definition);
				return () => {
					state.disposed += 1;
					const index = state.registrations.indexOf(definition);
					if (index >= 0) state.registrations.splice(index, 1);
				};
			},
			get: (toolName) => state.registrations.find((definition) => definition.name === toolName)
		},
		systemPrompt: { section: (sectionDef) => state.sections.push(sectionDef) },
		webServer: {
			register: (route) => {
				// Mirror the real webserver: duplicate (kind, path) throws.
				const key = `${route.kind}:${route.path}`;
				if (state.routeKeys.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
				state.routeKeys.add(key);
				state.routes.push(route);
				return () => {};
			}
		},
		effect: (fn) => {
			const result = fn();
			return typeof result === "function" ? result : () => {};
		},
		subagents: {
			getProvider: (name) => providers[name],
			start: async (providerName, request) => {
				state.starts.push({ providerName, request });
				return {
					id: "run-1",
					result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "done" }] }),
					dispose: async () => {}
				};
			},
			startContinuable: async (spec) => {
				state.continuables.push(spec);
				return { childId: "child-1", messageId: "msg-1" };
			},
			listChildren: async () => []
		}
	};
	// Inject-discipline guard mirroring the real Cordis Proxy (host side):
	// the raw object carries exactly the declared injects + builtins + the
	// test's own event emitter; anything else throws "cannot get property
	// ... without inject", the v0.3.0 client-side failure mode.
	return new Proxy(ctx, {
		get(target, prop) {
			if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
			throw new Error(`cannot get property "${String(prop)}" without inject`);
		}
	});
}

const wsA = join(tmpdir(), "subagent-model-ws-a");
const parent = {
	options: { provider: "provider-a", model: "model-fast" },
	session: {
		id: "s1",
		header: { cwd: wsA },
		append: (type, data) => {
			appendedEvents.push({ type, data });
		}
	}
};
const exec = { agent: parent, signal: new AbortController().signal };

// Hermetic user-config isolation: EVERY section of this suite (including the
// early execute paths) reads the plugin's user defaults through this temp
// path. Without this, the suite would read the developer machine's real
// `~/.dsh/subagent-model.json` — machine-dependent AND a config leak.
const tempHome = mkdtempSync(join(tmpdir(), "subagent-model-test-"));
setConfigPathForTesting(join(tempHome, ".dsh", "subagent-model.json"));

// ── pure helpers ────────────────────────────────────────────────────────────

assert.deepEqual(flattenProviders(initialSection), [
	{ provider: "provider-a", model: "model-fast", label: "Fast Model" },
	{ provider: "provider-a", model: "model-pro", label: "Pro Model" },
	{ provider: "provider-b", model: "model-pro", label: "Pro Model (mirror)" }
]);
assert.deepEqual(flattenProviders(null), []);
assert.deepEqual(flattenProviders({ providers: "nope" }), []);
assert.deepEqual(flattenProviders({ providers: { r: { models: [{ id: 42 }, null, { id: "ok" }] } } }), [{ provider: "r", model: "ok", label: "ok" }]);
assert.deepEqual(flattenProviders({ providers: { r: {} } }), []);

// explicit provider wins
assert.equal(resolveRoute("model-fast", "provider-b", "provider-a", "model-fast", flattenProviders(initialSection)), "provider-b");
// inherited model never throws, stays on parent route
assert.equal(resolveRoute(undefined, undefined, "provider-a", "model-fast", flattenProviders(initialSection)), "provider-a");
// explicit model served by parent route -> parent route
assert.equal(resolveRoute("model-fast", undefined, "provider-a", "model-fast", flattenProviders(initialSection)), "provider-a");
// explicit model not on parent route, single server -> that route
assert.equal(resolveRoute("model-fast", undefined, "somewhere-else", "other-model", flattenProviders(initialSection)), "provider-a");
// ambiguous, parent not serving -> error
assert.throws(() => resolveRoute("model-pro", undefined, "somewhere-else", "other-model", [{ provider: "a", model: "model-pro" }, { provider: "b", model: "model-pro" }]), /multiple providers/);
// unknown explicit id with a catalog -> error listing available ids
assert.throws(() => resolveRoute("nope", undefined, "provider-a", "model-fast", flattenProviders(initialSection)), /not offered/);
// unknown id without any catalog -> pass through to parent route
assert.equal(resolveRoute("nope", undefined, "provider-a", "model-fast", []), "provider-a");
// inherited ambiguous id -> parent route, never throws
assert.equal(resolveRoute("model-pro", undefined, "somewhere-else", "model-pro", [{ provider: "a", model: "model-pro" }, { provider: "b", model: "model-pro" }]), "somewhere-else");

assert.equal(sameEntries(flattenProviders(initialSection), flattenProviders(initialSection)), true);
assert.equal(sameEntries(flattenProviders(initialSection), [{ provider: "provider-a", model: "model-fast" }]), false);

// ── spawn instance: registration + execution ────────────────────────────────

resetRegistryForTesting();
resetStatusToolForTesting();
resetEndListenerForTesting();
const ctx = makeCtx();
// the inject-discipline guard works — accessing an undeclared service throws
assert.throws(() => ctx.agents, /cannot get property "agents" without inject/);
apply(ctx, { provider: "spawn", toolName: "subagent_with_model", backgroundMode: "continuable", maxDepth: 3 });
// delegation tool + shared roster tool (single-flight across rows)
assert.equal(ctx.state.registrations.length, 2);
const def = ctx.state.registrations.find((definition) => definition.name === "subagent_with_model");
assert.ok(def, "delegation tool must be registered");
const statusDef = ctx.state.registrations.find((definition) => definition.name === "subagent_status");
assert.ok(statusDef, "roster tool must be registered once");
assert.equal(def.parameters.properties.model.enum.length, 2);
assert.deepEqual(def.parameters.properties.model.enum, ["model-fast", "model-pro"]);
assert.deepEqual(def.parameters.properties.provider.enum, ["provider-a", "provider-b"]);
assert.ok(!def.parameters.required.includes("model"));
assert.equal(def.parameters.properties.max_tokens.type, "integer");
assert.equal(def.parameters.properties.run_in_background.type, "boolean");
assert.equal(def.parameters.properties.task_id.type, "string");
assert.equal(def.parameters.properties.depends_on.type, "array");
assert.equal(def.parameters.properties.persona.type, "string");
assert.equal(ctx.state.sections.length, 1);
assert.equal(ctx.state.sections[0].name, "tool:subagent_with_model");
assert.match(ctx.state.sections[0].text({ scope: undefined }), /background by default/);
assert.match(ctx.state.sections[0].text({ scope: undefined }), /depends_on/);

// foreground with explicit model + max_tokens (shape now carries runId/task_id)
let result = await def.execute({ description: "do thing", prompt: "task", model: "model-fast", max_tokens: 500, run_in_background: false }, exec);
assert.equal(result.kind, "foreground");
assert.match(result.runId, /^[0-9a-f-]{36}$/);
assert.equal(result.task_id, result.runId); // defaults to the run id
assert.deepEqual(result.output, [{ type: "text", text: "done" }]);
assert.deepEqual(ctx.state.starts[0].request.agentOptions, { provider: "provider-a", model: "model-fast", maxTokens: 500 });
assert.equal(ctx.state.starts[0].request.parent, parent);
assert.equal(ctx.state.starts[0].request.maxDepth, 3);
assert.ok(!("persona" in ctx.state.starts[0].request), "no persona when omitted");
// the foreground settle landed in the registry (awaited before returning)
assert.equal(listRuns(parent.session.header.cwd, ".dsh-subagents").at(-1).status, "completed");
// and the audit trail carries the lifecycle pair
assert.ok(appendedEvents.some((entry) => entry.type === "subagent-model/run-started"));
assert.ok(appendedEvents.some((entry) => entry.type === "subagent-model/run-settled" && entry.data.status === "completed"));

// omit model -> inherit parent's model, parent's provider
await def.execute({ description: "inherit", prompt: "task", run_in_background: false }, exec);
assert.deepEqual(ctx.state.starts[1].request.agentOptions, { provider: "provider-a", model: "model-fast" });

// persona passes through when the provider supports it
await def.execute({ description: "persona", prompt: "task", persona: "You are a reviewer", run_in_background: false }, exec);
assert.equal(ctx.state.starts.at(-1).request.persona, "You are a reviewer");

// continuable background is the default
result = await def.execute({ description: "bg", prompt: "task", model: "model-pro", task_id: "t-bg" }, exec);
assert.equal(result.kind, "continuable");
assert.equal(result.subagentId, "child-1");
assert.match(result.runId, /^[0-9a-f-]{36}$/);
assert.equal(result.task_id, "t-bg");
assert.equal(ctx.state.continuables.length, 1);
assert.deepEqual(ctx.state.continuables[0].request.agentOptions, { provider: "provider-a", model: "model-pro" });
assert.equal(ctx.state.continuables[0].provider, "spawn");
// the record is indexed by child id and running
assert.equal(childEntry("child-1").runId, result.runId);
assert.equal(listRuns(parent.session.header.cwd, ".dsh-subagents").find((record) => record.runId === result.runId).status, "running");

// a clean subagent/end epoch settles the continuable run to idle (NOT terminal)
ctx.emit("subagent/end", { id: "child-1", stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "hi" }] });
await new Promise((resolve) => setTimeout(resolve, 10)); // settle promise chain
assert.equal(listRuns(parent.session.header.cwd, ".dsh-subagents").find((record) => record.runId === result.runId).status, "idle");

// unknown explicit model -> rejected by the schema enum itself
await assert.rejects(def.execute({ description: "x", prompt: "task", model: "model-extra", run_in_background: false }, exec), /must be one of/);

// model without a calling agent -> clear error
await assert.rejects(def.execute({ description: "x", prompt: "task", run_in_background: false }, { agent: undefined, signal: exec.signal }), /requires a calling agent/);

// settings change refreshes the enum live; no-op change keeps the prefix stable
const before = ctx.state.registrations.length;
const disposedBefore = ctx.state.disposed;
ctx.emit("settings/updated", "llm-pi-ai"); // no-op
assert.equal(ctx.state.registrations.length, before);
assert.equal(ctx.state.disposed, disposedBefore);
initialSection.providers["provider-a"].models.push({ id: "model-extra", name: "Extra Model" });
ctx.emit("settings/updated", "llm-pi-ai");
assert.equal(ctx.state.disposed, disposedBefore + 1);
assert.equal(ctx.state.registrations.length, 2); // roster tool + re-mounted delegation tool
const refreshed = ctx.state.registrations.find((definition) => definition.name === "subagent_with_model");
assert.deepEqual(refreshed.parameters.properties.model.enum, ["model-fast", "model-pro", "model-extra"]);
// fresh catalog is read at execute time even without the event
await refreshed.execute({ description: "fresh", prompt: "task", model: "model-extra", run_in_background: false }, exec);
assert.deepEqual(ctx.state.starts.at(-1).request.agentOptions, { provider: "provider-a", model: "model-extra" });

// provider-removed unregisters the delegation tool; the shared roster stays
ctx.emit("subagent/provider-removed", "spawn");
assert.equal(ctx.state.registrations.length, 1);
assert.equal(ctx.state.registrations[0].name, "subagent_status");

// ── fork instance: wording + registration ───────────────────────────────────

const ctx2 = makeCtx();
apply(ctx2, { provider: "fork", toolName: "subagent_fork_with_model", backgroundMode: "continuable", maxDepth: 3 });
assert.equal(ctx2.state.registrations.length, 1);
assert.match(ctx2.state.registrations[0].description, /inherits this conversation/);
await ctx2.state.registrations[0].execute({ description: "fork task", prompt: "build on it", model: "model-fast" }, exec);
assert.deepEqual(ctx2.state.continuables[0].request.agentOptions, { provider: "provider-a", model: "model-fast" });

// ── one-shot mode: background job routing ───────────────────────────────────

const jobs = { start: (spec) => `job-${spec.label}` };
const ctx3 = makeCtx({ jobRegistry: jobs });
apply(ctx3, { provider: "spawn", toolName: "subagent_model_oneshot", backgroundMode: "one-shot", maxDepth: 3 });
const def3 = ctx3.state.registrations[0];
assert.match(def3.description, /job id/);
result = await def3.execute({ description: "job", prompt: "task", model: "model-fast", run_in_background: true }, exec);
assert.equal(result.kind, "background");
assert.equal(result.jobId, "job-job");
assert.match(result.runId, /^[0-9a-f-]{36}$/);
assert.equal(result.task_id, result.runId);
assert.equal(ctx3.state.starts.length, 0); // started through the job registry

// ── late settings-namespace registration self-heals the schema ─────────────

const late = { current: undefined };
const ctx4 = makeCtx({ sectionRef: late });
apply(ctx4, { provider: "spawn", toolName: "subagent_late", backgroundMode: "continuable", maxDepth: 3 });
assert.equal(ctx4.state.registrations[0].parameters.properties.model.enum, undefined); // no catalog yet
late.current = { providers: { "provider-a": { models: [{ id: "model-fast" }, { id: "model-pro" }] } } }; // the llm-pi-ai namespace appears after this row activated
const def4 = ctx4.state.registrations[0];
result = await def4.execute({ description: "late", prompt: "task", model: "model-fast", run_in_background: false }, exec);
assert.equal(result.kind, "foreground");
assert.match(result.runId, /^[0-9a-f-]{36}$/);
assert.deepEqual(result.output, [{ type: "text", text: "done" }]);
assert.deepEqual(ctx4.state.starts.at(-1).request.agentOptions, { provider: "provider-a", model: "model-fast" });
// and the schema healed for the next call
assert.deepEqual(ctx4.state.registrations[0].parameters.properties.model.enum, ["model-fast", "model-pro"]);

// ── config store + routes + user-default integration ────────────────────────

// absent file → empty config
assert.deepEqual(readUserConfig(), {});

// validate + write + read back
let verdict = validateUserConfigPatch({ defaultModel: "model-fast", defaultMaxTokens: 2048, maxDepth: 2 }, ["model-fast", "model-pro"]);
assert.equal(verdict.ok, true);
let stored = writeUserConfig(verdict.config);
assert.deepEqual(stored, { defaultModel: "model-fast", defaultMaxTokens: 2048, maxDepth: 2 });
assert.deepEqual(readUserConfig(), stored);

// validation rejects unknown model / bad tokens / bad depth
verdict = validateUserConfigPatch({ defaultModel: "nope" }, ["model-fast", "model-pro"]);
assert.equal(verdict.ok, false);
assert.match(verdict.error, /not among/);
verdict = validateUserConfigPatch({ defaultMaxTokens: -5 }, ["model-fast"]);
assert.equal(verdict.ok, false);
verdict = validateUserConfigPatch({ maxDepth: 999 }, ["model-fast"]);
assert.equal(verdict.ok, false);
verdict = validateUserConfigPatch({ maxDepth: 0 }, ["model-fast"]); // 0 = forbid delegation, still valid
assert.equal(verdict.ok, true);

// unset fields normalize to null (null accepted on every field, incl. defaultModel)
verdict = validateUserConfigPatch({ defaultModel: null, defaultMaxTokens: null, maxDepth: "" }, ["model-fast"]);
assert.deepEqual(verdict.config, { defaultModel: null, defaultMaxTokens: null, maxDepth: null });
verdict = validateUserConfigPatch({ defaultModel: "", defaultMaxTokens: null, maxDepth: "" }, ["model-fast"]);
assert.deepEqual(verdict.config, { defaultModel: null, defaultMaxTokens: null, maxDepth: null });
writeUserConfig(verdict.config);

// route fixtures
function fakeRes() {
	const res = { status: 0, headers: null, body: null };
	res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
	res.end = (payload) => { res.body = payload; };
	return res;
}
function fakeReq({ method = "GET", remoteAddress = "127.0.0.1", headers = {}, body = "" } = {}) {
	const req = { method, socket: { remoteAddress }, headers: { host: "127.0.0.1:3080", ...headers } };
	req[Symbol.asyncIterator] = async function* () { if (body !== "") yield Buffer.from(body); };
	return req;
}

const { routes } = makeRoutes({
	readConfig: readUserConfig,
	writeConfig: writeUserConfig,
	validateConfig: validateUserConfigPatch,
	readEntries: () => flattenProviders(initialSection),
	readRuns: async ({ cwd, sessionId }) => [{ runId: "r1", taskId: "t1", label: "sample", cwd, sessionId, live: null }]
});
assert.equal(routes.length, 3);
assert.equal(routes[0].path, "/api/subagent-model/config");
assert.equal(routes[1].path, "/api/subagent-model/models");
assert.equal(routes[2].path, "/api/subagent-model/runs");

// GET runs (read-only roster; cwd/sessionId ride the query)
let resRuns = fakeRes();
await routes[2].handler(fakeReq(), resRuns);
assert.equal(resRuns.status, 200);
assert.equal(JSON.parse(resRuns.body).runs[0].runId, "r1");

// GET config (all values unset -> empty object on the wire)
let res = fakeRes();
await routes[0].handler(fakeReq(), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body).config, {});

// POST valid (loopback + same origin)
res = fakeRes();
await routes[0].handler(fakeReq({ method: "POST", headers: { origin: "http://127.0.0.1:3080" }, body: JSON.stringify({ defaultModel: "model-pro", defaultMaxTokens: 1000, maxDepth: 1 }) }), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body).config, { defaultModel: "model-pro", defaultMaxTokens: 1000, maxDepth: 1 });

// POST invalid model -> 400
res = fakeRes();
await routes[0].handler(fakeReq({ method: "POST", headers: { origin: "http://127.0.0.1:3080" }, body: JSON.stringify({ defaultModel: "bogus" }) }), res);
assert.equal(res.status, 400);

// POST cross-origin -> 403 (trust fence)
res = fakeRes();
await routes[0].handler(fakeReq({ method: "POST", headers: { origin: "http://evil.example" }, body: JSON.stringify({}) }), res);
assert.equal(res.status, 403);

// GET models (initialSection gained model-extra in the settings-update test above)
res = fakeRes();
await routes[1].handler(fakeReq(), res);
assert.equal(res.status, 200);
assert.deepEqual(JSON.parse(res.body).entries.map((entry) => entry.model), ["model-fast", "model-pro", "model-extra", "model-pro"]);

// user defaults applied at execute: tool argument > user default > inherit
writeUserConfig({ defaultModel: "model-pro", defaultMaxTokens: 777, maxDepth: 1 });
resetRoutesOnceForTesting();
const ctxU = makeCtx();
apply(ctxU, { provider: "spawn", toolName: "subagent_user", backgroundMode: "continuable", maxDepth: 3 });
await ctxU.state.registrations[0].execute({ description: "ud", prompt: "task", run_in_background: false }, exec);
assert.deepEqual(ctxU.state.starts.at(-1).request.agentOptions, { provider: "provider-a", model: "model-pro", maxTokens: 777 });
assert.equal(ctxU.state.starts.at(-1).request.maxDepth, 1);
// per-call arguments still win over user defaults
await ctxU.state.registrations[0].execute({ description: "ud2", prompt: "task", model: "model-fast", max_tokens: 99, run_in_background: false }, exec);
assert.deepEqual(ctxU.state.starts.at(-1).request.agentOptions, { provider: "provider-a", model: "model-fast", maxTokens: 99 });
assert.equal(ctxU.state.starts.at(-1).request.maxDepth, 1);

// routes were registered through ctx.webServer
assert.equal(ctxU.state.routes.length, 3);

// ── regression: two rows of the same plugin share ONE route family ──────────
// The profile patch mounts spawn + fork as separate rows; every row's apply()
// runs against the same webServer. v0.2.0 registered the routes per row and
// the second row threw "duplicate exact route", failing the whole boot.
resetRoutesOnceForTesting();
const shared = makeCtx();
apply(shared, { provider: "spawn", toolName: "subagent_regression_a", backgroundMode: "continuable", maxDepth: 3 });
apply(shared, { provider: "fork", toolName: "subagent_regression_b", backgroundMode: "continuable", maxDepth: 3 });
assert.equal(shared.state.registrations.length, 2); // both tools still mount (roster already registered by an earlier row)
assert.equal(shared.state.routes.length, 3); // route family registered exactly once
assert.doesNotThrow(() => apply(shared, { provider: "spawn", toolName: "subagent_regression_c", backgroundMode: "continuable", maxDepth: 3 }));
assert.equal(shared.state.routes.length, 3);

// ── registry unit behavior ──────────────────────────────────────────────────

const wsB = mkdtempSync(join(tmpdir(), "subagent-model-ws-b-"));
const r1 = await createRun(wsB, ".dsh-subagents", { runId: "r-a", kind: "foreground", label: "first", model: "m", provider: "p", taskId: "t-a" });
assert.equal(r1.status, "running");
assert.equal(listRuns(wsB, ".dsh-subagents").length, 1);
await settleRun(wsB, ".dsh-subagents", "r-a", { status: "completed", stopReason: "completed", summary: "done" });
assert.equal(listRuns(wsB, ".dsh-subagents")[0].status, "completed");
// terminal statuses are sticky
await settleRun(wsB, ".dsh-subagents", "r-a", { status: "running" });
assert.equal(listRuns(wsB, ".dsh-subagents")[0].status, "completed");
// unknown dependency → unsatisfied; completed → satisfied
assert.deepEqual(unsatisfiedDependencies(wsB, ".dsh-subagents", ["t-a", "missing"]), [
	{ taskId: "missing", status: "unknown", label: "" }
]);
assert.deepEqual(unsatisfiedDependencies(wsB, ".dsh-subagents", ["t-a"]), []);
// the file really is append-only JSONL with last-write-wins fold
const lines = readFileSync(join(wsB, ".dsh-subagents", "runs.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "");
assert.ok(lines.length >= 2);
assert.equal(firstText([{ type: "text", text: "hello" }, { type: "text", text: " world" }], 6), "hello ");
assert.equal(firstText(undefined, 5), "");

// ── depends_on gating + persona capability + trackRuns off ───────────────────

resetRegistryForTesting();
const wsC = mkdtempSync(join(tmpdir(), "subagent-model-ws-c-"));
const parent2 = {
	options: { provider: "provider-a", model: "model-fast" },
	session: { id: "s2", header: { cwd: wsC }, append: () => {} }
};
const exec2 = { agent: parent2, signal: new AbortController().signal };

const ctxG = makeCtx();
apply(ctxG, { provider: "spawn", toolName: "subagent_gate", backgroundMode: "continuable", maxDepth: 3 });
const defG = ctxG.state.registrations.find((definition) => definition.name === "subagent_gate");

// dependent-before-dependency refuses with the unsatisfied list
await assert.rejects(
	defG.execute({ description: "b", prompt: "x", task_id: "t-b", depends_on: ["t-a"], run_in_background: false }, exec2),
	/unsatisfied dependenc.*t-a \(unknown\)/
);
// run the dependency to completion, then the dependent starts
await defG.execute({ description: "a", prompt: "x", task_id: "t-a", run_in_background: false }, exec2);
const gated = await defG.execute({ description: "b", prompt: "x", task_id: "t-b", depends_on: ["t-a"], run_in_background: false }, exec2);
assert.equal(gated.kind, "foreground");
assert.equal(gated.task_id, "t-b");
// a continuable child whose epoch settled cleanly satisfies dependencies too
const gatedCont = await defG.execute({ description: "c", prompt: "x", task_id: "t-c" }, exec2);
await new Promise((resolve) => setTimeout(resolve, 10));
// simulate the clean epoch end (listener is installed on ctx1, so settle directly here)
await settleRun(wsC, ".dsh-subagents", gatedCont.runId, { status: "idle", stopReason: "completed" });
const gatedOnIdle = await defG.execute({ description: "d", prompt: "x", depends_on: ["t-c"], run_in_background: false }, exec2);
assert.equal(gatedOnIdle.kind, "foreground");

// provider without persona capability fails loud when persona is requested
const ctxP = makeCtx();
apply(ctxP, { provider: "nopersona", toolName: "subagent_nopersona", backgroundMode: "continuable", maxDepth: 3 });
const defP = ctxP.state.registrations.find((definition) => definition.name === "subagent_nopersona");
await assert.rejects(
	defP.execute({ description: "p", prompt: "x", persona: "You are a reviewer", run_in_background: false }, exec2),
	/no persona capability/
);

// trackRuns: false restores v0.2.x behavior: no records, no roster tool, gating refused
resetStatusToolForTesting();
const ctxT = makeCtx();
apply(ctxT, { provider: "spawn", toolName: "subagent_bare", backgroundMode: "continuable", maxDepth: 3, trackRuns: false });
assert.equal(ctxT.state.registrations.length, 1); // delegation tool only
await assert.rejects(
	ctxT.state.registrations[0].execute({ description: "x", prompt: "x", depends_on: ["anything"], run_in_background: false }, exec2),
	/requires run tracking/
);

// ── background jobs settle through the done wrapper ──────────────────────────

resetRegistryForTesting();
const wsD = mkdtempSync(join(tmpdir(), "subagent-model-ws-d-"));
const parent3 = {
	options: { provider: "provider-a", model: "model-fast" },
	session: { id: "s3", header: { cwd: wsD }, append: () => {} }
};
const captured = { spec: null };
const jobsCapture = { start: (spec) => { captured.spec = spec; return "job-captured"; } };
const ctxJ = makeCtx({ jobRegistry: jobsCapture });
apply(ctxJ, { provider: "spawn", toolName: "subagent_job", backgroundMode: "one-shot", maxDepth: 3 });
const jobResult = await ctxJ.state.registrations[0].execute({ description: "j", prompt: "x", task_id: "t-j", run_in_background: true }, { agent: parent3, signal: new AbortController().signal });
assert.equal(jobResult.kind, "background");
assert.ok(captured.spec !== null, "the job spec must be captured");
const operation = captured.spec.run();
const outcome = await operation.done;
assert.equal(outcome.status, "completed");
assert.equal(listRuns(wsD, ".dsh-subagents").find((record) => record.taskId === "t-j").status, "completed");

// ── roster tool output ───────────────────────────────────────────────────────

const ctxS = makeCtx();
apply(ctxS, { provider: "spawn", toolName: "subagent_status_host", backgroundMode: "continuable", maxDepth: 3 });
const roster = ctxS.state.registrations.find((definition) => definition.name === "subagent_status") ?? ctx.state.registrations.find((definition) => definition.name === "subagent_status");
const rosterValue = await roster.execute({}, exec2);
assert.match(rosterValue.text, /Subagent runs in/);
assert.match(rosterValue.text, /t-a/); // records from wsC
assert.match(rosterValue.text, /\[completed\]/);

// ── memory-only mode (stateDir: "") never touches the workspace ──────────────

const wsE = mkdtempSync(join(tmpdir(), "subagent-model-ws-e-"));
const parent4 = {
	options: { provider: "provider-a", model: "model-fast" },
	session: { id: "s4", header: { cwd: wsE }, append: () => {} }
};
const ctxM = makeCtx();
apply(ctxM, { provider: "spawn", toolName: "subagent_mem", backgroundMode: "continuable", maxDepth: 3, stateDir: "" });
await ctxM.state.registrations[0].execute({ description: "m", prompt: "x", task_id: "t-m", run_in_background: false }, { agent: parent4, signal: new AbortController().signal });
assert.ok(!existsSync(join(wsE, "runs.jsonl")), "memory-only mode must not create files");
assert.equal(listRuns(wsE, "").find((record) => record.taskId === "t-m").status, "completed");
rmSync(wsE, { recursive: true, force: true });

// clear user defaults so the file's defaults do not leak into nothing else
writeUserConfig({ defaultModel: null, defaultMaxTokens: null, maxDepth: null });
rmSync(tempHome, { recursive: true, force: true });
for (const leftover of [wsA, wsB, wsC, wsD]) {
	rmSync(leftover, { recursive: true, force: true });
}

console.log("smoke.mjs: all assertions passed");
