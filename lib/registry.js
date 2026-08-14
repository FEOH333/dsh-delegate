/**
 * dsh-tool-subagent-model — run registry.
 *
 * A durable, per-workspace append-only JSONL record of every delegation made
 * by this plugin's tools (`<workspace>/.dsh-subagents/runs.jsonl`, the
 * directory name is the row's `stateDir` config). Each mutation appends one
 * line and the fold resolves last-write-wins per runId, so the file is an
 * audit log and the fold is the truth snapshot — the same "disk state, read
 * on demand" pattern as community team plugins, minus the team ceremony.
 *
 * Design rules (lightweight + compatible):
 * - Advisory by construction: EVERY filesystem failure degrades to an
 *   in-memory record and never throws out of a tool call. The registry must
 *   never break delegation; `depends_on` gating is the only consumer that
 *   treats it as authoritative, and it works from the same in-memory fold.
 * - Only `node:*` modules: no dsh imports, so the module survives any future
 *   dsh package reshuffle. The file format is versioned independently.
 * - In-process per-path promise-chain locks serialize read-modify-write;
 *   multi-process writers of the same workspace are NOT coordinated (a
 *   documented boundary, same as the community plugins).
 * - `stateDir: ""` (or an unresolvable cwd) selects memory-only mode.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** File format version, stamped into every record. */
const FORMAT_VERSION = 1;

/** Record statuses. `idle` = a continuable child settled its last turn. */
export const RUN_STATUS = ["running", "idle", "completed", "failed", "cancelled"];

/** Where the resolved child model came from (stored per record since v0.3.3). */
export const MODEL_SOURCES = ["arg", "default", "inherited"];

/** Dependency gating: these statuses satisfy a `depends_on` entry. */
const SATISFIED_STATUSES = new Set(["completed", "idle"]);

/** Terminal (never again running) statuses. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Append-driven compaction threshold: when the file grows past this many
 * lines the fold rewrites it down to active runs + recent terminal runs.
 */
const COMPACT_LINE_LIMIT = 400;
/** Terminal runs kept by compaction (most recent first). */
const COMPACT_TERMINAL_KEEP = 120;
/** Terminal runs older than this many hours are dropped by compaction. */
const COMPACT_TERMINAL_AGE_MS = 24 * 60 * 60 * 1000;

// ── in-process state ─────────────────────────────────────────────────────────

/** Per-file promise-chain locks (read-modify-write serialization). */
const locks = new Map();

/** Memory-only store per cwd (used when stateDir is "" or fs fails). */
const memoryStores = new Map();

/** Child session id → { cwd, runId, parent } for `subagent/end` correlation. */
const childIndex = new Map();

/** Test seam: forget every module-level cache. */
export function resetRegistryForTesting() {
	locks.clear();
	memoryStores.clear();
	childIndex.clear();
}

// ── small helpers ────────────────────────────────────────────────────────────

function withLock(key, fn) {
	const previous = locks.get(key) ?? Promise.resolve();
	const gate = previous.catch(() => undefined).then(fn);
	locks.set(key, gate.catch(() => undefined));
	return gate;
}

function registryPathOf(cwd, stateDir) {
	if (cwd === undefined || cwd === null || cwd === "" || stateDir === undefined || stateDir === null || stateDir === "") return "";
	return join(cwd, stateDir, "runs.jsonl");
}

/** Read + fold the file (last write per runId wins). Absent file → []. */
function foldFile(path) {
	if (path === "" || !existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n");
	const byId = new Map();
	for (const line of lines) {
		if (line.trim() === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue; // a torn trailing line must never poison the fold
		}
		if (record === null || typeof record !== "object" || typeof record.runId !== "string" || record.v !== FORMAT_VERSION) continue;
		byId.set(record.runId, record);
	}
	return [...byId.values()].sort((a, b) => a.tsCreated - b.tsCreated);
}

/** One memory-store fold for a cwd. */
function foldMemory(cwd) {
	const byId = memoryStores.get(cwd) ?? new Map();
	return [...byId.values()].sort((a, b) => a.tsCreated - b.tsCreated);
}

/** Append one record line; on failure fall back to the memory store. */
function appendRecord(cwd, path, record) {
	if (path !== "") {
		try {
			if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
			return;
		} catch {
			// fall through to the memory store
		}
	}
	let store = memoryStores.get(cwd);
	if (store === undefined) {
		store = new Map();
		memoryStores.set(cwd, store);
	}
	store.set(record.runId, record);
}

/** Rewrite the file down to active + recent terminal runs (append-driven). */
function compactIfNeeded(cwd, path) {
	if (path === "" || !existsSync(path)) return;
	let lines = 0;
	try {
		lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
	} catch {
		return;
	}
	if (lines < COMPACT_LINE_LIMIT) return;
	const records = foldFile(path);
	const now = Date.now();
	const kept = records
		.filter((record) => !TERMINAL_STATUSES.has(record.status)
			|| (now - (record.tsSettled ?? record.tsCreated) <= COMPACT_TERMINAL_AGE_MS))
		.sort((a, b) => b.tsCreated - a.tsCreated)
		.slice(0, COMPACT_TERMINAL_KEEP)
		.reverse();
	const tmp = `${path}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, kept.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		try { if (existsSync(tmp)) renameSync(tmp, `${tmp}.bak`); } catch { /* ignore */ }
	}
}

// ── public API ───────────────────────────────────────────────────────────────

/** Normalize one caller-supplied task id to a stable key. */
export function normalizeTaskId(taskId, runId) {
	if (typeof taskId === "string" && taskId.trim() !== "") return taskId.trim().slice(0, 64);
	return runId;
}

/**
 * Create a run record (`status: "running"`). Returns the full record.
 * Never throws: advisory bookkeeping.
 */
export async function createRun(cwd, stateDir, input) {
	const runId = typeof input.runId === "string" && input.runId !== "" ? input.runId : randomUUID();
	const record = {
		v: FORMAT_VERSION,
		runId,
		kind: input.kind === "background" || input.kind === "foreground" ? input.kind : "continuable",
		label: typeof input.label === "string" ? input.label : "",
		model: typeof input.model === "string" ? input.model : "",
		modelSource: MODEL_SOURCES.includes(input.modelSource) ? input.modelSource : "",
		provider: typeof input.provider === "string" ? input.provider : "",
		childId: typeof input.childId === "string" ? input.childId : "",
		taskId: normalizeTaskId(input.taskId, runId),
		dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.filter((id) => typeof id === "string" && id !== "").slice(0, 32) : [],
		persona: typeof input.persona === "string" && input.persona !== "" ? input.persona : "",
		status: "running",
		stopReason: "",
		summary: "",
		tsCreated: Date.now(),
		tsSettled: 0
	};
	const path = registryPathOf(cwd, stateDir);
	await withLock(path === "" ? `mem:${cwd}` : path, async () => {
		appendRecord(cwd, path, record);
		compactIfNeeded(cwd, path);
	});
	return record;
}

/**
 * Update one record's runtime identity (child session id). Never throws.
 */
export async function attachChild(cwd, stateDir, runId, childId) {
	if (typeof childId !== "string" || childId === "") return;
	const path = registryPathOf(cwd, stateDir);
	await withLock(path === "" ? `mem:${cwd}` : path, async () => {
		const records = path === "" ? foldMemory(cwd) : foldFile(path);
		const record = records.find((candidate) => candidate.runId === runId);
		if (record === undefined) return;
		record.childId = childId;
		appendRecord(cwd, path, record);
	});
}

/**
 * Settle one run record. Terminal statuses are sticky; a continuable child
 * may flip between `running` (new epoch observed via a start record) and
 * `idle` again, but never back from a terminal status. Never throws.
 */
export async function settleRun(cwd, stateDir, runId, patch) {
	const status = RUN_STATUS.includes(patch.status) ? patch.status : "failed";
	const path = registryPathOf(cwd, stateDir);
	await withLock(path === "" ? `mem:${cwd}` : path, async () => {
		const records = path === "" ? foldMemory(cwd) : foldFile(path);
		const record = records.find((candidate) => candidate.runId === runId);
		if (record === undefined) return;
		if (TERMINAL_STATUSES.has(record.status)) return; // sticky terminal
		record.status = status;
		record.stopReason = typeof patch.stopReason === "string" ? patch.stopReason : "";
		record.summary = typeof patch.summary === "string" ? patch.summary.slice(0, 1000) : "";
		record.tsSettled = Date.now();
		appendRecord(cwd, path, record);
	});
}

/** Read one folded record by run id (sync, for listeners). */
export function getRunSync(cwd, stateDir, runId) {
	const path = registryPathOf(cwd, stateDir);
	try {
		return (path === "" ? foldMemory(cwd) : foldFile(path)).find((record) => record.runId === runId);
	} catch {
		return undefined;
	}
}

/**
 * The roster: active records first, then recent terminal records, newest
 * last. Advisory read — a failure yields [].
 */
export function listRuns(cwd, stateDir) {
	const path = registryPathOf(cwd, stateDir);
	let records;
	try {
		records = path === "" ? foldMemory(cwd) : foldFile(path);
	} catch {
		records = foldMemory(cwd);
	}
	return records
		.filter((record) => !TERMINAL_STATUSES.has(record.status) || Date.now() - (record.tsSettled ?? record.tsCreated) <= COMPACT_TERMINAL_AGE_MS)
		.sort((a, b) => a.tsCreated - b.tsCreated);
}

/**
 * Dependency gate: every id in `dependsOn` must have a satisfying record
 * (`completed` or `idle`). Returns the unsatisfied entries with their
 * current status so the model gets an actionable error.
 */
export function unsatisfiedDependencies(cwd, stateDir, dependsOn) {
	const records = listRuns(cwd, stateDir);
	const byTask = new Map();
	for (const record of records) byTask.set(record.taskId, record);
	return dependsOn
		.filter((id) => {
			const record = byTask.get(id);
			return record === undefined || !SATISFIED_STATUSES.has(record.status);
		})
		.map((id) => {
			const record = byTask.get(id);
			return { taskId: id, status: record === undefined ? "unknown" : record.status, label: record?.label ?? "" };
		});
}

// ── subagent/end correlation ─────────────────────────────────────────────────

/** Remember which record a child id belongs to (for the end listener). */
export function indexChild(childId, entry) {
	if (typeof childId !== "string" || childId === "") return;
	childIndex.set(childId, { ...entry });
}

/** Look up the entry for a settled child id. */
export function childEntry(childId) {
	return childIndex.get(childId);
}

/** First text of an optional content-block array, truncated. */
export function firstText(blocks, limit) {
	if (!Array.isArray(blocks)) return "";
	const text = blocks
		.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
	return limit === undefined ? text : text.slice(0, limit);
}
