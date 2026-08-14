/**
 * Client-half smoke test for dsh-tool-subagent-model.
 *
 * Loads lib/client.js the way the web shell does (window.__ModuleLoader__
 * handoff), runs the factory with a stub require, then verifies the plugin
 * contract: the settings-card registration, the three toolview keys, and the
 * SSR-safe initial render of every card (no fetch during SSR, hooks are
 * inert).
 * Execute with:  node test/client-smoke.mjs  (from the package directory)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const ReactDOMServer = require("react-dom/server");

// ── load the bundle through the module-loader handoff ───────────────────────

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let handoff = null;
globalThis.window = { __ModuleLoader__: { load: (value) => { handoff = value; } } };
(0, eval)(code);
assert.ok(handoff !== null, "bundle must call window.__ModuleLoader__.load");
assert.equal(handoff.id, "dsh-tool-subagent-model");

// The factory's require must only touch platform seed words ("react").
const mod = handoff.factory((spec) => {
	if (spec === "react") return React;
	throw new Error(`unexpected require: ${spec}`);
});
assert.ok(Array.isArray(mod.inject), "exports.inject must be an array");
assert.equal(typeof mod.apply, "function");

// ── plugin contract: settings card + three toolview registrations ───────────

const registered = [];
/** Stubs for every declared service + the Cordis builtins apply() may touch. */
const stubs = {
	// builtins (always available on a real Context)
	effect: (fn) => {
		const disposer = fn();
		return typeof disposer === "function" ? disposer : () => {};
	},
	get: (name) => {
		// optional-service accessor: this plugin reads only "sessions"
		assert.equal(name, "sessions");
		return undefined;
	},
	// declared services (mod.inject)
	locale: {
		register: (ns, dictionaries) => {
			assert.equal(ns, "subagent-model");
			assert.ok(dictionaries.zh && dictionaries.en);
			// v0.3.3 keys exist in both dictionaries
			assert.ok(dictionaries.zh.lockDefaultModel && dictionaries.en.lockDefaultModel);
			assert.ok(dictionaries.zh.srcArg && dictionaries.zh.srcDefault && dictionaries.zh.srcInherited);
		}
	},
	slots: {
		inject: (name, contribution) => registered.push({ name, contribution }),
		register: (options, component) => ({ ...options, component })
	}
};
// Inject-discipline guard mirroring the real Cordis Proxy: any property that
// is neither a declared inject nor a builtin throws, exactly like the v0.3.0
// incident ("cannot get property \"sessions\" without inject").
const ctx = new Proxy(stubs, {
	get(target, prop) {
		if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
		throw new Error(`cannot get property "${String(prop)}" without inject`);
	}
});
// every declared inject must have a stub (a future inject addition without a
// stub fails the test explicitly instead of silently serving undefined)
for (const name of mod.inject) {
	assert.ok(stubs[name] !== undefined, `mock must provide a stub for declared inject "${name}"`);
}
// the guard itself works — this is the assertion that would have caught the v0.3.0 bug
assert.throws(() => ctx.sessions, /cannot get property "sessions" without inject/);
mod.apply(ctx);
assert.equal(registered.length, 4); // settings card + 3 toolview keys
assert.equal(registered[0].name, "settings.plugin.item");
const entry = registered[0].contribution();
assert.equal(entry.name, "settings.plugin.item");
assert.equal(entry.id, "subagent-model");
assert.equal(entry.order, 30);
assert.equal(typeof entry.locale, "string");
assert.equal(typeof entry.component, "function");

// toolview keys claim exactly this plugin's tool names (open key domain)
const toolviews = registered.slice(1);
assert.ok(toolviews.every((injection) => injection.name === "tool.call.toolview"));
const toolviewEntries = toolviews.map((injection) => injection.contribution());
assert.deepEqual(toolviewEntries.map((view) => view.key), ["subagent_with_model", "subagent_fork_with_model", "subagent_status"]);
assert.ok(toolviewEntries.every((view) => view.name === "tool.call.toolview" && typeof view.component === "function"));

// ── the card renders its initial (closed) state without a host ──────────────

const html = ReactDOMServer.renderToStaticMarkup(React.createElement(entry.component, { t: (key) => key }));
assert.match(html, /aria-expanded="false"/);
assert.match(html, /title/); // the locale passthrough renders the entry keys
assert.match(html, /description/);
assert.doesNotThrow(() => ReactDOMServer.renderToStaticMarkup(React.createElement(entry.component, {})));

// ── the delegation toolview renders a settled run card (SSR-safe, no fetch) ─

const runBlock = {
	kind: "tool-result",
	call: { name: "subagent_with_model", argsRaw: JSON.stringify({ description: "整理日志", model: "model-fast" }) },
	content: [{ type: "text", text: "started subagent child-9 (task t-9)\n[run: 12345678-1234-4123-8123-123456789abc]" }]
};
const runHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(toolviewEntries[0].component, {
	t: (key) => key,
	toolName: "subagent_with_model",
	block: runBlock,
	cwd: "",
	sessionId: ""
}));
assert.match(runHtml, /整理日志/);
assert.match(runHtml, /model-fast/);
assert.match(runHtml, /statusUnknown/); // no roster record without a host

// ── the roster toolview renders the empty state during SSR ───────────────────

const rosterBlock = {
	kind: "tool-result",
	call: { name: "subagent_status", argsRaw: "{}" },
	content: [{ type: "text", text: "Subagent runs in …" }]
};
const rosterHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(toolviewEntries[2].component, {
	t: (key) => key,
	toolName: "subagent_status",
	block: rosterBlock,
	cwd: "",
	sessionId: ""
}));
assert.match(rosterHtml, /rosterTitle/);
assert.match(rosterHtml, /rosterEmpty/);

// ── a still-running call renders the starting state ──────────────────────────

const runningBlock = { callId: "c1", name: "subagent_with_model", argsRaw: JSON.stringify({ description: "x" }) };
assert.doesNotThrow(() => ReactDOMServer.renderToStaticMarkup(React.createElement(toolviewEntries[0].component, {
	t: (key) => key,
	toolName: "subagent_with_model",
	block: runningBlock,
	cwd: "",
	sessionId: ""
})));

console.log("client-smoke.mjs: all assertions passed");
