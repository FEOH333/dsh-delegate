/**
 * User config store for dsh-tool-subagent-model: one JSON file
 * (`~/.dsh/subagent-model.json`) holding the default child-agent settings
 * that the Settings > Plugins card edits. Written atomically (tmp + rename).
 *
 * The file is a user-level override layer for the TOOL behavior: values here
 * win over the composition row's config when present. Per-call tool arguments
 * (model / max_tokens) always win over both.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** File format version. */
const FORMAT_VERSION = 1;

/** Test seam: override the store path (per-invocation default otherwise). */
let overridePath;
export function setConfigPathForTesting(path) {
	overridePath = path;
}

/** Store file location: <home>/.dsh/subagent-model.json. */
export function configPath() {
	return overridePath ?? join(homedir(), ".dsh", "subagent-model.json");
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
	const config = { defaultModel: null, defaultMaxTokens: null, maxDepth: null };
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
	return { ok: true, config };
}

/** Persist one validated config wholesale; returns the stored value. */
export function writeUserConfig(config) {
	const path = configPath();
	const payload = {
		version: FORMAT_VERSION,
		defaultModel: config.defaultModel ?? null,
		defaultMaxTokens: config.defaultMaxTokens ?? null,
		maxDepth: config.maxDepth ?? null
	};
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
	renameSync(tmp, path);
	return readUserConfig();
}
