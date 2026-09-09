/**
 * User config store for dsh-tool-subagent-model: one JSON file
 * (`$DSH_HOME/subagent-model.json`) holding the default child-agent settings
 * that the Settings > Plugins card edits. Written atomically (tmp + rename).
 *
 * The file is a user-level override layer for the TOOL behavior: values here
 * win over the composition row's config when present. Per-call tool arguments
 * (model / max_tokens) always win over both.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** File format version. */
const FORMAT_VERSION = 1;

/** Test seam: override the store path (per-invocation default otherwise). */
let overridePath;
export function setConfigPathForTesting(path) {
	overridePath = path;
}

/** Test seam: drop the override so `configPath()` resolves for real again. */
export function resetConfigPathForTesting() {
	overridePath = undefined;
}

/**
 * The harness home, mirroring `@deepseek-ai/dsh-home-paths`'s `resolveDshHome`
 * precedence: a non-blank `$DSH_HOME` over `~/.dsh`, with `~` expanded and the
 * result made absolute. Implemented locally rather than imported: a static
 * import of a host package is exactly what broke this plugin on dsh 0.1.2
 * (see CHANGELOG 0.3.8), and the resolution is three lines of pure logic.
 * @returns the absolute harness home path.
 */
function dshHome() {
	const env = process.env.DSH_HOME;
	const raw = typeof env === "string" && env.trim() !== "" ? env.trim() : join(homedir(), ".dsh");
	const expanded = raw === "~"
		? homedir()
		: raw.startsWith("~/") || raw.startsWith("~\\")
			? join(homedir(), raw.slice(2))
			: raw;
	return resolve(expanded);
}

/** Store file location: `$DSH_HOME/subagent-model.json` (default `~/.dsh`). */
export function configPath() {
	return overridePath ?? join(dshHome(), "subagent-model.json");
}

/**
 * The user-editable defaults. Absent values are `undefined` (no override),
 * so callers can layer them: tool argument > user config > row config.
 */
export function readUserConfig() {
	let parsed;
	try {
		const text = readFileSync(configPath(), "utf8");
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object") return {};
	const config = {};
	if (typeof parsed.defaultModel === "string" && parsed.defaultModel !== "") config.defaultModel = parsed.defaultModel;
	if (typeof parsed.defaultMaxTokens === "number" && Number.isInteger(parsed.defaultMaxTokens) && parsed.defaultMaxTokens > 0) {
		config.defaultMaxTokens = parsed.defaultMaxTokens;
	}
	if (typeof parsed.maxDepth === "number" && Number.isInteger(parsed.maxDepth) && parsed.maxDepth >= 0) config.maxDepth = parsed.maxDepth;
	if (typeof parsed.lockDefaultModel === "boolean") config.lockDefaultModel = parsed.lockDefaultModel;
	return config;
}

/**
 * Validate one wire patch for the user config.
 * @param patch - the request body (unknown shape).
 * @param modelIds - currently selectable model ids (for defaultModel).
 * @returns `{ ok: true, config }` with normalized values (`null` = unset), or
 *   `{ ok: false, error }` naming the offending field.
 */
export function validateUserConfigPatch(patch, modelIds) {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		return { ok: false, error: "body must be a JSON object" };
	}
	const config = { defaultModel: null, defaultMaxTokens: null, maxDepth: null, lockDefaultModel: null };
	if (patch.defaultModel !== undefined) {
		// `null` and `""` both mean "unset", consistent with the other fields.
		if (patch.defaultModel !== null && typeof patch.defaultModel !== "string") return { ok: false, error: "defaultModel must be a string" };
		if (patch.defaultModel !== null && patch.defaultModel !== "") {
			if (!modelIds.includes(patch.defaultModel)) {
				return { ok: false, error: `defaultModel "${patch.defaultModel}" is not among the configured providers' models (${modelIds.join(", ")})` };
			}
			config.defaultModel = patch.defaultModel;
		}
	}
	if (patch.defaultMaxTokens !== undefined) {
		if (patch.defaultMaxTokens !== null && patch.defaultMaxTokens !== "") {
			if (typeof patch.defaultMaxTokens !== "number" || !Number.isInteger(patch.defaultMaxTokens) || patch.defaultMaxTokens < 1 || patch.defaultMaxTokens > Number.MAX_SAFE_INTEGER) {
				return { ok: false, error: "defaultMaxTokens must be a positive integer" };
			}
			config.defaultMaxTokens = patch.defaultMaxTokens;
		}
	}
	if (patch.maxDepth !== undefined) {
		if (patch.maxDepth !== null && patch.maxDepth !== "") {
			if (typeof patch.maxDepth !== "number" || !Number.isInteger(patch.maxDepth) || patch.maxDepth < 0 || patch.maxDepth > 64) {
				return { ok: false, error: "maxDepth must be an integer in 0..64" };
			}
			config.maxDepth = patch.maxDepth;
		}
	}
	if (patch.lockDefaultModel !== undefined) {
		if (patch.lockDefaultModel !== null && patch.lockDefaultModel !== "") {
			if (typeof patch.lockDefaultModel !== "boolean") {
				return { ok: false, error: "lockDefaultModel must be a boolean" };
			}
			config.lockDefaultModel = patch.lockDefaultModel;
		}
	}
	return { ok: true, config };
}

/** Persist one validated config wholesale; returns the stored value. */
export function writeUserConfig(config) {
	const path = configPath();
	const payload = {
		version: FORMAT_VERSION,
		defaultModel: config.defaultModel ?? null,
		defaultMaxTokens: config.defaultMaxTokens ?? null,
		maxDepth: config.maxDepth ?? null,
		lockDefaultModel: config.lockDefaultModel ?? null
	};
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
	renameSync(tmp, path);
	return readUserConfig();
}
