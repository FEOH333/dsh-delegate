/**
 * Client-half smoke test for dsh-tool-subagent-model.
 *
 * Loads lib/client.js the way the web shell does (window.__ModuleLoader__
 * handoff), runs the factory with a stub require, then verifies the plugin
 * contract: the settings-page registration, the settings-card registration,
 * the three toolview keys, and the SSR-safe initial render of every card
 * (no fetch during SSR, hooks are inert).
 * Execute with:  node test/client-smoke.mjs  (from the package directory)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
// The harness ships react@18 at the top level but react-dom only as nested
// copies (react-dom@19 pairs with react@19 inside UI packages). SSR rendering
// needs ONE consistent react/react-dom pair, so resolve both from the
// react-dom location instead of letting `require("react")` grab the loose
// top-level react@18 and mixing it with a different react-dom.
const reactDomServerEntry = require.resolve("react-dom/server");
const reactDomDir = dirname(dirname(reactDomServerEntry));
const React = require(require.resolve("react", { paths: [reactDomDir] }));
const ReactDOMServer = require(reactDomServerEntry);

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

// ── package manifest: the client-modules loader contract ────────────────────
// The loader requires `dsh.client.platform` ("web") plus `exports["./client"]`.
// `dsh.client.inject` named `@deepseek-ai/dsh-client-runtime`, which no longer
// ships with dsh (the loader skips a missing row-inject, so it was inert and
// misleading) — dropped in v0.3.8, along with its peer dependency.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.dsh.client.platform, "web");
assert.equal(manifest.dsh.client.inject, undefined);
assert.equal(manifest.exports["./client"], "./lib/client.js");
assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-client-runtime"], undefined);
assert.ok(manifest.exports["."].endsWith("index.js"));

// ── plugin contract: plugin card + settings page + three toolviews ──────────

const registered = [];
/** The optional sessions service, resolved lazily by the navigation helper. */
const sessionsStub = {
	subagentAddress: (childId) => ({ parentSessionId: "p", childSessionId: childId, mode: "child" }),
	openSubagent: () => {}
};
let sessionsReads = 0;
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
		sessionsReads += 1;
		return sessionsStub;
	},
	// declared services (mod.inject)
	locale: {
		register: (ns, dictionaries) => {
			assert.equal(ns, "subagent-model");
			assert.ok(dictionaries.zh && dictionaries.en);
			// v0.3.3 keys exist in both dictionaries
			assert.ok(dictionaries.zh.lockDefaultModel && dictionaries.en.lockDefaultModel);
			assert.ok(dictionaries.zh.srcArg && dictionaries.zh.srcDefault && dictionaries.zh.srcInherited);
		},
		bind: (ns) => {
			assert.equal(ns, "subagent-model");
			return (key) => key; // the section label thunk resolves through this
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
// v0.3.8: the optional sessions service is resolved per click, never captured
// at apply time — a controller that activates later must not leave a dead
// "open child session" button.
assert.equal(sessionsReads, 0, "apply must not capture the optional sessions service");
assert.equal(registered.length, 5); // plugin card + settings page + 3 toolview keys
assert.equal(registered[0].name, "settings.plugin.item");
const entry = registered[0].contribution();
// settings.plugin.item is a KEYED slot since dsh 0.1.1-rc.2 — registration
// carries `key`, never the old list-slot `id`/`order`/`locale` fields.
assert.equal(entry.name, "settings.plugin.item");
assert.equal(entry.key, "subagent-model");
assert.equal(entry.id, undefined); // legacy list-slot field must be gone
assert.equal(typeof entry.component, "function");
assert.equal(registered[1].name, "settings.section");
const section = registered[1].contribution();
// settings.section is a plain LIST slot: id + order + label thunk (v0.3.6)
assert.equal(section.name, "settings.section");
assert.equal(section.id, "subagent-model");
assert.equal(section.order, 18);
assert.equal(typeof section.label, "function");
assert.equal(typeof section.component, "function");

// toolview keys claim exactly this plugin's tool names (open key domain)
const toolviews = registered.slice(2);
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

// ── the dedicated settings page renders (SSR-safe, embeds the card) ─────────

const sectionHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(section.component, {}));
assert.match(sectionHtml, /aria-expanded="false"/); // the embedded card renders
assert.match(sectionHtml, /子代理模型/); // the resolution falls back to the zh dictionary

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
