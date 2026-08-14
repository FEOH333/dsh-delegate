/**
 * dsh-tool-subagent-model
 *
 * A model-facing delegation tool like the official `subagent` / `subagent_fork`
 * tools, plus a per-call `model` (and optional `provider` / `max_tokens`)
 * picked from the providers the deployment already configured in the
 * `llm-pi-ai` settings section (the web Models page's source of truth).
 *
 * Design goals:
 * - Only stable public seams: `ctx.tools.register`, `ctx.subagents`
 *   (start / startContinuable / listChildren / subagent lifecycle events),
 *   `ctx.systemPrompt.section`, `ctx.webServer`, `Session.append`, and the
 *   optional `ctx.settings` read. No internal imports.
 * - All dependencies resolve from the host installation at runtime (the
 *   `$DSH_HOME/profiles/node_modules` fallback), so the plugin always runs
 *   against the installed dsh's own copies of `dsh-tools`, `dsh-subagent`,
 *   and `schemastery` — never pinned, never drifted.
 * - Graceful degradation: no settings service, an unregistered `llm-pi-ai`
 *   namespace, an empty provider list, or a missing subagent provider never
 *   breaks the tool — it degrades to inheriting the parent's model, exactly
 *   like the official tool.
 * - Lightweight run tracking (v0.3.0): a per-workspace append-only run
 *   registry, `depends_on` gating, per-child persona, typed audit events,
 *   and a shared roster tool. Every tracking seam is advisory — only the
 *   explicit `depends_on` gate treats it as authoritative — and the whole
 *   layer turns off with `trackRuns: false`.
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assertSubagentMaxDepth, settleRun } from "@deepseek-ai/dsh-subagent";
import { randomUUID } from "node:crypto";
import { readUserConfig, validateUserConfigPatch, writeUserConfig } from "./config-store.js";
import { registerRoutesOnce } from "./routes.js";
import { appendRunEvent } from "./events.js";
import {
	attachChild,
	childEntry,
	createRun,
	firstText,
	indexChild,
	listRuns,
	settleRun as settleRunRecord,
	unsatisfiedDependencies
} from "./registry.js";
import { registerStatusToolOnce } from "./status-tool.js";

/** Plugin identity registered by the Loader. */
export const name = "tool-subagent-model";
/** Host-plane services this row needs; all ship with dsh-base + dsh-web-app. */
export const inject = ["tools", "subagents", "systemPrompt", "webServer"];

/** Settings namespace the pi-ai adapter owns (registered by dsh-llm-pi-ai). */
const LLM_PI_AI_NS = "llm-pi-ai";
/** Prompt-section order: after bounded delegation policy, beside the official tool. */
const SECTION_ORDER = 116.5;

/** Plugin configuration; one row per model-facing tool instance. */
export const Config = z.object({
	/** The `ctx.subagents` provider name to start runs on (`spawn`, `fork`, ...). */
	provider: z.string().required(),
	/** Model-facing tool name; distinct for every loaded instance. */
	toolName: z.string().default("subagent_with_model"),
	/** Background lifecycle policy, mirroring the official tool's semantics. */
	backgroundMode: z.union(["one-shot", "continuable"]).default("continuable"),
	/** Absolute delegation-depth cap (default 3; 0 forbids delegation). */
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(3),
	/**
	 * Run-registry directory name under the session workspace
	 * (`<workspace>/<stateDir>/runs.jsonl`). `""` selects memory-only
	 * tracking (no files written into the workspace).
	 */
	stateDir: z.string().default(".dsh-subagents"),
	/**
	 * Model-facing name of the shared roster tool (`subagent_status`);
	 * `""` disables it. Registered once per process, so the first row wins.
	 */
	statusToolName: z.string().default("subagent_status"),
	/**
	 * Master switch for run tracking: registry records, session audit events,
	 * `depends_on` gating, and the roster tool. `false` restores the exact
	 * v0.2.x behavior (delegation only).
	 */
	trackRuns: z.boolean().default(true),
	/**
	 * Lock the child model to the user default: when true AND a default
	 * model is configured, a per-call `model` argument is ignored (the
	 * roster still records the truth via `modelSource`). The Settings card
	 * exposes the same switch per user; either one enables the lock.
	 */
	lockDefaultModel: z.boolean().default(false)
});

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * Flatten the `llm-pi-ai` settings section into selectable
 * `{provider, model, label}` entries. Defensive by construction: any shape
 * degrades to an empty list, which the callers treat as "no catalog available".
 * @param section - the resolved `llm-pi-ai` settings value (unknown shape).
 * @returns one entry per configured provider/model pair, in configuration order.
 */
export function flattenProviders(section) {
	if (section === null || typeof section !== "object") return [];
	const providers = section.providers;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return [];
	const entries = [];
	for (const [provider, profile] of Object.entries(providers)) {
		if (profile === null || typeof profile !== "object" || !Array.isArray(profile.models)) continue;
		for (const model of profile.models) {
			if (model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0) {
				entries.push({
					provider,
					model: model.id,
					label: typeof model.name === "string" && model.name !== "" ? model.name : model.id
				});
			}
		}
	}
	return entries;
}

/**
 * Resolve the child's provider route for a requested model id.
 *
 * - An explicit `provider` argument always wins.
 * - An inherited model (no explicit `model`) never throws: it stays on the
 *   parent's route, so calling the tool like the official one is always safe.
 * - An explicitly requested model resolves to the parent's route when that
 *   route serves it, else to the single route that serves it, and errors when
 *   the id is unknown or ambiguous — the model can correct from the message.
 * - With no catalog at all (empty `entries`), any explicit id passes through
 *   to the parent's route; the deployment's own adapters own availability.
 *
 * @param model - the requested model id, or undefined to inherit.
 * @param providerArg - an explicit provider route, or undefined.
 * @param parentProvider - the calling agent's provider route.
 * @param parentModel - the calling agent's model id.
 * @param entries - the flattened catalog from `flattenProviders`.
 * @returns the provider route the child should run on.
 */
export function resolveRoute(model, providerArg, parentProvider, parentModel, entries) {
	if (providerArg !== undefined && providerArg !== null && providerArg !== "") return providerArg;
	if (model === undefined) return parentProvider;
	const explicit = model !== parentModel;
	const serving = entries.filter((entry) => entry.model === model);
	if (serving.length === 0) {
		if (!explicit || entries.length === 0) return parentProvider;
		const ids = [...new Set(entries.map((entry) => entry.model))].join(", ");
		throw new Error(`model "${model}" is not offered by any configured provider; available: ${ids}. Omit \`model\` to inherit your current model (${parentProvider ?? "unknown provider"}).`);
	}
	if (serving.some((entry) => entry.provider === parentProvider)) return parentProvider;
	if (serving.length === 1) return serving[0].provider;
	if (!explicit) return parentProvider;
	throw new Error(`model "${model}" is offered by multiple providers (${serving.map((entry) => entry.provider).join(", ")}); pass \`provider\` to disambiguate.`);
}

/** Order-stable equality over flattened catalog entries (no-op-change guard). */
export function sameEntries(a, b) {
	if (a.length !== b.length) return false;
	return a.every((entry, index) => entry.provider === b[index].provider && entry.model === b[index].model);
}

// ── run tracking helpers ─────────────────────────────────────────────────────

/**
 * The calling agent's workspace directory. Advisory only: an unresolvable
 * cwd selects the registry's memory-only mode, never an error.
 */
function workspaceOf(agent) {
	try {
		return agent?.session?.header?.cwd ?? "";
	} catch {
		return "";
	}
}

/**
 * Map a `subagent/end` stop reason to a registry settle patch for a
 * continuable child. A clean epoch means the child finished its turn and is
 * idle (still continuable — NOT terminal); anything else settles terminal.
 */
function continuableSettleOf(info) {
	switch (info?.stopReason) {
		case "completed": return { status: "idle", stopReason: "completed" };
		case "aborted": return { status: "cancelled", stopReason: "aborted" };
		case "max-tokens": return { status: "failed", stopReason: "max-tokens" };
		case "refusal": return { status: "failed", stopReason: "refusal" };
		case "error": return { status: "failed", stopReason: "error" };
		default: return { status: "failed", stopReason: String(info?.stopReason ?? "unknown") };
	}
}

/**
 * Single-flight `subagent/end` listener: settles continuable runs this
 * plugin started (correlated through the registry's child index). Children
 * started by OTHER tools are ignored — the index only contains our ids.
 *
 * The listener never throws: settling is advisory bookkeeping.
 */
let endListenerInstalled = false;

export function installEndListenerOnce(ctx, stateDir) {
	if (endListenerInstalled) return;
	endListenerInstalled = true;
	ctx.on("subagent/end", (info) => {
		try {
			if (info === null || typeof info !== "object" || typeof info.id !== "string" || info.id === "") return;
			const entry = childEntry(info.id);
			if (entry === undefined) return; // not one of our children
			const patch = continuableSettleOf(info);
			const summary = firstText(info.lastAssistantMessage, 400);
			void settleRunRecord(entry.cwd, stateDir, entry.runId, { ...patch, summary }).then(() => {
				appendRunEvent(ctx, entry.parent, "run-settled", {
					runId: entry.runId,
					status: patch.status,
					stopReason: patch.stopReason,
					summary,
					ts: Date.now()
				});
			});
		} catch {
			// a listener must never break the emitter's other consumers
		}
	});
}

/** Reset the single-flight listener flag (test seam). */
export function resetEndListenerForTesting() {
	endListenerInstalled = false;
}

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values) {
	return values.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "text" && typeof value.text === "string").map((value) => value.text).join("");
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start, signal) {
	try {
		return await settleRun(await start);
	} catch (error) {
		return signal.aborted ? { status: "killed" } : {
			status: "failed",
			detail: String(error)
		};
	}
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
	switch (result.stopReason) {
		case "completed": return;
		case "aborted": return "subagent run was cancelled";
		case "error": return "subagent run failed";
		case "max-tokens": return "subagent run hit its token limit before finishing";
		case "refusal": return "subagent declined the task";
		default: return `subagent run ended abnormally (${String(result.stopReason)})`;
	}
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 */
function withPartialText(error, output) {
	const text = output.filter((block) => block.type === "text").map((block) => block.text).join("");
	return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`;
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(run) {
	const [execution] = await Promise.allSettled([run.result.then((result) => {
		const error = stopReasonError(result);
		if (error !== void 0) throw new Error(withPartialText(error, result.output));
		return {
			kind: "foreground",
			runId: run.id,
			output: result.output
		};
	})]);
	const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
	if (execution.status === "rejected") {
		if (disposal.status === "rejected") throw new AggregateError([execution.reason, disposal.reason], `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`);
		throw execution.reason;
	}
	if (disposal.status === "rejected") throw disposal.reason;
	return execution.value;
}

/** Model-facing wording from the provider's conversation-history descriptor. */
function providerWording(inheritsConversation) {
	if (inheritsConversation) return {
		description: "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn), running a model you choose from the configured providers. Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps. Pick `model` deliberately; omit it to inherit your current model.",
		promptDescription: "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new."
	};
	return {
		description: "Delegate a self-contained task to a subagent running a model you choose from the configured providers (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation. Pick `model` deliberately; omit it to inherit your current model.",
		promptDescription: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
	};
}

export function apply(ctx, config) {
	if (config.maxDepth !== "provider-managed") assertSubagentMaxDepth(config.maxDepth);
	const continuable = (config.backgroundMode ?? "continuable") === "continuable";
	const toolName = config.toolName ?? "subagent_with_model";
	let disposeTool;
	/** The flattened provider/model catalog, refreshed on settings changes. */
	let entries = [];

	/** Read the current `llm-pi-ai` settings section; absent service/section yields []. */
	const readEntries = () => {
		const settings = ctx.get("settings");
		if (settings === void 0) return [];
		try {
			return flattenProviders(settings.get(LLM_PI_AI_NS));
		} catch {
			return [];
		}
	};

	// Initial catalog. The `llm-pi-ai` settings namespace may register after
	// this row activates (entries mount concurrently); `refreshModelList` is
	// re-run on every execute and on settings changes, so the schema heals
	// itself even when this first read sees nothing.
	entries = readEntries();

	/** Rebuild the tool definition when the selectable model set changed. */
	const refreshModelList = () => {
		const next = readEntries();
		if (sameEntries(next, entries)) return;
		entries = next;
		ctx.logger.info(`tool-subagent-model: "${toolName}" model list refreshed (${entries.length} entries)`);
		if (disposeTool === void 0) return;
		disposeTool();
		disposeTool = void 0;
		const present = ctx.subagents.getProvider(config.provider);
		if (present !== void 0) mount(present);
	};

	const mount = (provider) => {
		if (typeof config.maxDepth === "number" && !provider.capabilities.depthLimit) throw new Error(`tool-subagent-model: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
		if (continuable && provider.prepareContinuable === void 0) throw new Error(`tool-subagent-model: provider "${provider.name}" does not support \`backgroundMode: continuable\``);
		const wording = providerWording(provider.inheritsParentContext);
		const modelIds = [...new Set(entries.map((entry) => entry.model))];
		const routes = [...new Set(entries.map((entry) => entry.provider))];
		disposeTool = ctx.tools.register(defineTool({
			name: toolName,
			description: wording.description + (continuable ? " This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result." : " This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.") + (config.trackRuns !== false ? ` Delegations are tracked in a workspace roster: pass \`task_id\` to name a run, \`depends_on\` to gate it on earlier runs, and read the roster with \`${config.statusToolName ?? "subagent_status"}\`.` : "") + (config.lockDefaultModel === true ? " NOTE: the default child model is LOCKED — a per-call `model` argument is ignored while a default model is configured." : ""),
			parameters: {
				description: {
					type: "string",
					required: true,
					description: "A short (3-5 word) description of the delegated task, for display."
				},
				prompt: {
					type: "string",
					required: true,
					description: wording.promptDescription
				},
				model: modelIds.length > 0 ? {
					type: "string",
					description: "The child agent's model id, chosen from the configured providers. Omit to use the configured default model (Settings > Plugins), or inherit your current model when none is set.",
					enum: modelIds
				} : {
					type: "string",
					description: "The child agent's model id. No provider model list is configured (llm-pi-ai settings), so any id is accepted and routed to your current provider; omit to inherit your current model."
				},
				...routes.length > 0 ? { provider: {
					type: "string",
					description: "Provider route serving the chosen model. Defaults to the route that offers `model` (preferring your current provider). Pass it only when the id is ambiguous or not listed.",
					enum: routes
				} } : {},
				max_tokens: {
					type: "integer",
					description: "Maximum output tokens for the child agent. Omit to use the configured default (Settings > Plugins), or the provider default when none is set."
				},
				run_in_background: {
					type: "boolean",
					description: continuable ? "Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it." : "Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill."
				},
				task_id: {
					type: "string",
					description: "Optional stable id naming this delegation (short kebab-case). Other delegations can declare `depends_on: [this id]` to wait for it; defaults to the run id when omitted."
				},
				depends_on: {
					type: "array",
					items: { type: "string" },
					description: "Optional task ids that must already be satisfied (completed / settled) before this delegation starts; the tool refuses with the unsatisfied list otherwise. Requires run tracking (trackRuns)."
				},
				persona: {
					type: "string",
					description: "Optional per-child persona: self-contained role/system text replacing the deployment persona for this child alone (persisted and reapplied when a continuable child resumes). Requires provider support; omit to keep the default persona."
				}
			},
			output: {
				schema: { oneOf: [
					{
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "background"
							},
							jobId: {
								type: "string",
								required: true
							},
							runId: {
								type: "string",
								required: true
							},
							task_id: {
								type: "string"
							},
							note: {
								type: "string"
							}
						}
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "continuable"
							},
							subagentId: {
								type: "string",
								required: true
							},
							runId: {
								type: "string",
								required: true
							},
							task_id: {
								type: "string"
							},
							note: {
								type: "string"
							}
						}
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "foreground"
							},
							runId: {
								type: "string",
								required: true
							},
							task_id: {
								type: "string"
							},
							note: {
								type: "string"
							},
							output: {
								type: "array",
								required: true,
								items: { type: "json" }
							}
						}
					}
				] },
				render: (_args, value) => [{
					type: "text",
					text: value.kind === "background"
						? `started background subagent task ${value.jobId} (task ${value.task_id ?? value.runId})${value.note ?? ""}\n[run: ${value.runId}]`
						: value.kind === "continuable"
							? `started subagent ${value.subagentId} (task ${value.task_id ?? value.runId})${value.note ?? ""}\n[run: ${value.runId}]`
							: `${outputValueText(value.output)}${value.note ?? ""}\n[run: ${value.runId}]`
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const parent = exec.agent;
				if (!parent) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`);
				// Fresh catalog every call: the `llm-pi-ai` namespace may have
				// registered or changed since the schema was built. This also
				// rebuilds the model enum live (cheap no-op when unchanged), so
				// a stale schema never blocks a valid call.
				refreshModelList();
				// User defaults from Settings > Plugins (~/.dsh/subagent-model.json):
				// tool argument > user default > inherited/row value.
				const user = readUserConfig();
				const parentProvider = parent.options?.provider;
				const parentModel = parent.options?.model;
				// Resolution order: explicit per-call arg > user default > parent
				// model. `lockDefaultModel` (row config OR Settings card) forces
				// the user default to win over an explicit arg while a default
				// is configured; without a default the lock is a no-op.
				const explicitArg = typeof args.model === "string" && args.model !== "";
				const hasDefault = typeof user.defaultModel === "string" && user.defaultModel !== "";
				const lock = config.lockDefaultModel === true || user.lockDefaultModel === true;
				let model;
				let modelSource;
				if (hasDefault && (lock || !explicitArg)) {
					model = user.defaultModel;
					modelSource = "default";
				} else if (explicitArg) {
					model = args.model;
					modelSource = "arg";
				} else {
					model = parentModel;
					modelSource = "inherited";
				}
				const lockNote = lock && explicitArg && model !== args.model
					? ` (model locked to default ${model})`
					: "";
				const provider = resolveRoute(model, args.provider, parentProvider, parentModel, entries);
				const agentOptions = {
					...provider !== undefined ? { provider } : {},
					...model !== undefined ? { model } : {},
					...(Number.isInteger(args.max_tokens) && args.max_tokens > 0 ? { maxTokens: args.max_tokens } : {}),
					...(!(Number.isInteger(args.max_tokens) && args.max_tokens > 0) && user.defaultMaxTokens !== undefined ? { maxTokens: user.defaultMaxTokens } : {})
				};
				const maxDepth = user.maxDepth ?? (typeof config.maxDepth === "number" ? config.maxDepth : void 0);

				// ── run-tracking preamble (registry/events are advisory; the
				//    `depends_on` gate is the one authoritative consumer) ──────
				const track = config.trackRuns !== false;
				const stateCfg = config.stateDir ?? ".dsh-subagents";
				const cwd = workspaceOf(parent);
				const dependsOn = Array.isArray(args.depends_on)
					? args.depends_on.filter((id) => typeof id === "string" && id !== "").slice(0, 32)
					: [];
				const persona = typeof args.persona === "string" && args.persona !== "" ? args.persona : void 0;
				if (persona !== void 0) {
					const providerNow = ctx.subagents.getProvider(config.provider);
					if (providerNow !== void 0 && !providerNow.capabilities?.persona) {
						throw new Error(`provider "${config.provider}" cannot apply a per-child persona (no persona capability) — drop \`persona\` or use a provider that supports it`);
					}
				}
				if (dependsOn.length > 0) {
					if (!track) throw new Error(`\`depends_on\` requires run tracking (row config trackRuns: false)`);
					const unsatisfied = unsatisfiedDependencies(cwd, stateCfg, dependsOn);
					if (unsatisfied.length > 0) {
						const listing = unsatisfied.map((entry) => `${entry.taskId} (${entry.status}${entry.label !== "" ? `, ${entry.label}` : ""})`).join("; ");
						throw new Error(`cannot start: ${unsatisfied.length} unsatisfied dependenc${unsatisfied.length === 1 ? "y" : "ies"}: ${listing} — wait for them to settle, or drop \`depends_on\``);
					}
				}
				const runId = randomUUID();
				const taskId = typeof args.task_id === "string" && args.task_id.trim() !== "" ? args.task_id.trim().slice(0, 64) : runId;
				const background = args.run_in_background ?? continuable;
				const kind = continuable && background ? "continuable" : background ? "background" : "foreground";
				if (track) {
					await createRun(cwd, stateCfg, {
						runId,
						kind,
						label: args.description,
						model: model ?? "",
						modelSource,
						provider: provider ?? "",
						taskId,
						dependsOn,
						persona: persona ?? ""
					});
					appendRunEvent(ctx, parent, "run-started", {
						runId,
						kind,
						label: args.description,
						model: model ?? "",
						modelSource,
						provider: provider ?? "",
						taskId,
						dependsOn,
						ts: Date.now()
					});
				}

				const request = {
					label: args.description,
					prompt: [{
						type: "text",
						text: args.prompt
					}],
					parent,
					agentOptions,
					...maxDepth !== void 0 ? { maxDepth } : {},
					...persona !== void 0 ? { persona } : {}
				};
				if (background) {
					if (continuable) {
						const started = await ctx.subagents.startContinuable({
							provider: config.provider,
							label: args.description,
							request,
							signal: exec.signal
						});
						if (track) {
							await attachChild(cwd, stateCfg, runId, started.childId);
							indexChild(started.childId, { cwd, runId, parent });
						}
						return { kind: "continuable", subagentId: started.childId, runId, task_id: taskId, ...lockNote !== "" ? { note: lockNote } : {} };
					}
					const jobs = ctx.get("jobs");
					if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
					return {
						kind: "background",
						jobId: jobs.start({
							kind: "subagent",
							label: args.description,
							owner: parent,
							run: () => {
								const controller = new AbortController();
								return {
									cancel: (reason) => {
										controller.abort(reason ?? "background subagent task killed");
									},
									done: settleStart(ctx.subagents.start(config.provider, {
										...request,
										signal: controller.signal
									}), controller.signal).then((outcome) => {
										if (!track) return outcome;
										const status = outcome.status === "completed" ? "completed" : outcome.status === "killed" ? "cancelled" : "failed";
										const summary = firstText(outcome.output, 400);
										return settleRunRecord(cwd, stateCfg, runId, { status, stopReason: outcome.status, summary }).then(() => {
											appendRunEvent(ctx, parent, "run-settled", {
												runId,
												status,
												stopReason: outcome.status,
												summary,
												ts: Date.now()
											});
											return outcome;
										});
									})
								};
							}
						}),
						runId,
						task_id: taskId,
						...lockNote !== "" ? { note: lockNote } : {}
					};
				}
				try {
					const result = await settleForegroundRun(await ctx.subagents.start(config.provider, {
						...request,
						signal: exec.signal
					}));
					if (track) {
						const summary = firstText(result.output, 400);
						await settleRunRecord(cwd, stateCfg, runId, { status: "completed", stopReason: "completed", summary });
						appendRunEvent(ctx, parent, "run-settled", {
							runId,
							status: "completed",
							stopReason: "completed",
							summary,
							ts: Date.now()
						});
					}
					return { ...result, runId, task_id: taskId, ...lockNote !== "" ? { note: lockNote } : {} };
				} catch (error) {
					if (track) {
						try {
							await settleRunRecord(cwd, stateCfg, runId, { status: "failed", stopReason: "error", summary: String(error) });
						} catch {
							// a settle failure must never mask the original error
						}
						appendRunEvent(ctx, parent, "run-settled", {
							runId,
							status: "failed",
							stopReason: "error",
							summary: String(error),
							ts: Date.now()
						});
					}
					throw error;
				}
			}
		}));
	};

	// Provider lifecycle: the official pattern, so a late-registered provider
	// still gets its tool and a removed one loses it.
	ctx.on("subagent/provider-added", (provider) => {
		if (provider.name === config.provider && disposeTool === void 0) mount(provider);
	});
	ctx.on("subagent/provider-removed", (name) => {
		if (name !== config.provider || disposeTool === void 0) return;
		disposeTool();
		disposeTool = void 0;
	});
	const present = ctx.subagents.getProvider(config.provider);
	if (present !== void 0) mount(present);
	else ctx.logger.info(`tool-subagent-model: subagent provider "${config.provider}" not registered yet; the "${toolName}" tool will register when it appears`);

	// Settings changes (the web Models page, or editing settings.yaml) refresh
	// the selectable model list and rebuild the enum live. A no-op change is
	// skipped so the request-cache prefix stays stable.
	ctx.on("settings/updated", (ns) => {
		if (ns === LLM_PI_AI_NS) refreshModelList();
	});

	// The /api/subagent-model route family: the Settings > Plugins card reads
	// and writes the user defaults through these (never the settings RPC, so
	// no api-proxy whitelist change is needed). The family is shared by every
	// row of this plugin, so it is registered ONCE per process — a per-row
	// registration would throw "duplicate exact route" on the second row and
	// fail the whole boot (the v0.2.0 regression, see routes.js).
	// `readRuns` serves the client toolview cards: the on-disk run fold
	// merged with live subagent residency (best effort, read-only).
	registerRoutesOnce(ctx, {
		readConfig: readUserConfig,
		writeConfig: writeUserConfig,
		validateConfig: validateUserConfigPatch,
		readEntries,
		readRuns: async ({ cwd, sessionId }) => {
			const stateCfg = config.stateDir ?? ".dsh-subagents";
			const runs = config.trackRuns !== false ? listRuns(cwd, stateCfg) : [];
			const activity = new Map();
			try {
				if (typeof sessionId === "string" && sessionId !== "") {
					for (const entry of await ctx.subagents.listChildren(sessionId)) {
						if (entry !== null && typeof entry === "object" && entry.kind === "child" && typeof entry.id === "string") {
							activity.set(entry.id, entry.activity);
						}
					}
				}
			} catch {
				// residency stays unknown on listing failure
			}
			return runs.map((run) => ({ ...run, live: activity.get(run.childId) ?? null }));
		}
	});

	// Shared roster tool + continuable-settlement listener: process-global
	// resources, single-flight across rows (same rule as the route family).
	registerStatusToolOnce(ctx, {
		toolName: config.trackRuns !== false ? (config.statusToolName ?? "subagent_status") : "",
		stateDir: config.stateDir ?? ".dsh-subagents"
	});
	if (config.trackRuns !== false) installEndListenerOnce(ctx, config.stateDir ?? ".dsh-subagents");

	// Guidance section, mirroring the official tool's `tool:<name>` section.
	if (continuable) ctx.systemPrompt.section({
		name: `tool:${toolName}`,
		order: SECTION_ORDER,
		text: (context) => disposeTool === void 0 || ctx.tools.get(toolName, context.scope) === void 0 ? "" : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message. Choose the child's \`model\` deliberately: prefer a faster or cheaper model for mechanical or offloadable work, and reserve the stronger models for the main conversation or for children whose output quality matters.${config.trackRuns !== false ? ` For multi-step delegation chains: pass \`task_id\` to name a run and \`depends_on\` to block one until earlier runs settle (the tool lists unsatisfied dependencies when it refuses); check \`${config.statusToolName ?? "subagent_status"}\` for the workspace roster instead of re-reading the conversation.` : ""}`
	});
}
