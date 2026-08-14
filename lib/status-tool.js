/**
 * dsh-tool-subagent-model — `subagent_status` tool.
 *
 * One model-facing roster tool per PROCESS (single-flight, like the route
 * family): the plugin mounts as multiple rows (spawn + fork), but every row
 * shares the same registry, so the roster must exist exactly once. Reads the
 * on-disk run fold and enriches it with live subagent activity from
 * `ctx.subagents.listChildren` — the "disk truth + live residency" merge.
 *
 * Every dependency (subagents service, registry fs) degrades instead of
 * throwing: the tool must answer with what it knows, never break the turn.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { listRuns } from "./registry.js";

/** Module-level single-flight flag (mirrors routes.js). */
let registered = false;

/** Test seam. */
export function resetStatusToolForTesting() {
	registered = false;
}

/** The calling agent's workspace directory ("" = memory-only registry). */
function workspaceOf(parent) {
	try {
		return parent?.session?.header?.cwd ?? "";
	} catch {
		return "";
	}
}

/** Live activity map childId → 'running' | 'inactive' (best effort). */
async function liveActivity(ctx, sessionId) {
	const activity = new Map();
	try {
		if (typeof sessionId !== "string" || sessionId === "") return activity;
		const entries = await ctx.subagents.listChildren(sessionId);
		for (const entry of entries) {
			if (entry !== null && typeof entry === "object" && entry.kind === "child" && typeof entry.id === "string") {
				activity.set(entry.id, entry.activity);
			}
		}
	} catch {
		// absent persistence or a listing failure: residency stays unknown
	}
	return activity;
}

function renderStatus(cwd, runs, activity) {
	const lines = [
		`Subagent runs in ${cwd === "" ? "(unknown workspace)" : cwd}:`,
		`${runs.length} record(s); `
			+ `${runs.filter((run) => run.status === "running").length} running, `
			+ `${runs.filter((run) => run.status === "idle").length} idle, `
			+ `${runs.filter((run) => ["completed", "failed", "cancelled"].includes(run.status)).length} settled.`
	];
	for (const run of runs) {
		const live = run.childId !== "" && activity.has(run.childId) ? activity.get(run.childId) : "";
		// Anchor on the RIGHT timestamp: running records have tsSettled === 0,
		// which `??` does NOT skip (it only skips null/undefined) — the
		// v0.3.1 regression that printed "started <epoch>s ago".
		const anchor = run.status === "running"
			? (run.tsCreated || run.tsSettled || Date.now())
			: (run.tsSettled || run.tsCreated || Date.now());
		const age = Math.max(0, Math.round((Date.now() - anchor) / 1000));
		const when = run.status === "running" ? `started ${age}s ago` : `settled ${age}s ago`;
		const bits = [
			run.taskId,
			`[${run.status}${live === "running" && run.status !== "running" ? ", resident" : ""}]`,
			`${run.label || "(untitled)"}`,
			run.model !== "" ? `${run.model}${run.modelSource !== "" ? ` (${run.modelSource})` : ""}` : "(inherited model)",
			run.kind === "continuable" && run.childId !== "" ? `child ${run.childId}` : run.kind,
			when
		];
		if (run.dependsOn.length > 0) bits.push(`depends_on: ${run.dependsOn.join(", ")}`);
		if (run.summary !== "") bits.push(`summary: ${run.summary.slice(0, 120).replace(/\n/g, " ")}`);
		lines.push(`  ${bits.join(" | ")}`);
	}
	lines.push("Use a row's `task_id` in a new delegation's `depends_on` to order work by these runs.");
	return lines.join("\n");
}

/**
 * Register the roster tool once per process.
 * @param ctx - the first row's context (owns the registration).
 * @param options - `{ toolName, stateDir }`; `toolName: ""` disables the tool.
 * @returns a disposer (unregisters and clears the single-flight flag).
 */
export function registerStatusToolOnce(ctx, options) {
	if (registered) return () => {};
	const toolName = options.toolName;
	if (typeof toolName !== "string" || toolName === "") return () => {};
	if (ctx.tools.get(toolName) !== undefined) {
		ctx.logger?.warn?.(`tool-subagent-model: status tool "${toolName}" already registered by another plugin; skipping the roster tool`);
		return () => {};
	}
	registered = true;
	const stateDir = options.stateDir ?? ".dsh-subagents";
	const disposeTool = ctx.tools.register(defineTool({
		name: toolName,
		description: "Show the roster of subagent delegations made by the subagent_with_model / subagent_fork_with_model tools in this workspace: task ids, statuses (running / idle / completed / failed / cancelled), models, model provenance (arg / default / inherited), live residency, and dependency chains. Use this to check what earlier delegations are doing and to pick task ids for `depends_on` instead of re-reading the conversation.",
		parameters: {},
		output: {
			schema: { type: "object", additionalProperties: true, properties: {} },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		isConcurrencySafe: () => true,
		async execute(_args, exec) {
			const parent = exec.agent;
			if (!parent) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`);
			const cwd = workspaceOf(parent);
			const runs = listRuns(cwd, stateDir);
			const activity = await liveActivity(ctx, parent.session?.id ?? "");
			return { text: renderStatus(cwd, runs, activity) };
		}
	}));
	return () => {
		registered = false;
		try {
			disposeTool();
		} catch {
			// disposal failure must not break row teardown
		}
	};
}
