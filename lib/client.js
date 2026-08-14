/**
 * dsh-tool-subagent-model — browser half (hand-written, no build step).
 *
 * Registers one card into the Settings > Plugins (plugin configuration)
 * section (edit the default child-agent model / max tokens / depth cap), plus
 * conversation-flow tool-call cards for this plugin's tools via the open
 * `tool.call.toolview` keyed slot: a run card per delegation (status from the
 * host roster, child-session navigation, persona/dependency detail) and a
 * roster card for `subagent_status`.
 *
 * The card talks ONLY to the plugin's own /api/subagent-model routes (plain
 * fetch), never to the settings RPC, so no api-proxy whitelist change is
 * needed for a third-party plugin.
 *
 * Bundle contract: the client-modules loader executes this file and calls
 * `window.__ModuleLoader__.load({ id, factory })`; the factory's `require`
 * resolves platform seed words ("react", ...) and registered sibling
 * bundles. The id MUST be this package's name (the graph row id).
 */
window.__ModuleLoader__.load({
	id: "dsh-tool-subagent-model",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const { createElement: h, useEffect, useState } = React;

		/** Locale namespace this card owns. */
		const NS = "subagent-model";

		const zh = {
			title: "子代理模型",
			description: "subagent_with_model / subagent_fork_with_model 的默认配置",
			defaultModel: "默认子代理模型",
			defaultModelHint: "调用工具时不传 model 时使用；留空则继承主 agent 模型",
			inheritOption: "（继承主 agent 模型）",
			removedOption: "（已从提供商移除: {id}）",
			maxTokens: "默认最大输出 tokens",
			maxTokensHint: "调用工具时不传 max_tokens 时使用；留空则不限制",
			maxDepth: "委派深度上限",
			maxDepthHint: "0 = 禁止委派；留空则使用组合配置默认值 3",
			save: "保存",
			saving: "保存中...",
			saved: "已保存",
			loading: "加载中...",
			note: "每次调用仍可传 model / max_tokens / provider 临时覆盖；此处是省略参数时的默认值。模型列表来自「设置 → 模型」页。",
			expand: "展开",
			collapse: "收起",
			rosterTitle: "子代理任务花名册",
			rosterCount: "{n} 条记录",
			rosterEmpty: "该工作区暂无委派记录",
			statusRunning: "运行中",
			statusIdle: "空闲（可继续）",
			statusCompleted: "已完成",
			statusFailed: "失败",
			statusCancelled: "已取消",
			statusUnknown: "状态未知",
			starting: "启动中…",
			kindContinuable: "可续聊",
			kindBackground: "后台任务",
			kindForeground: "同步",
			taskLabel: "任务",
			dependsLabel: "依赖",
			personaLabel: "角色人设",
			openChild: "打开子会话",
			summaryLabel: "结果摘要",
			liveRunning: "驻留运行",
			liveInactive: "驻留休眠",
			rosterHint: "用 subagent_status 工具查看完整花名册与 task_id",
			childLabel: "子会话"
		};
		const en = {
			title: "Subagent Model",
			description: "Defaults for subagent_with_model / subagent_fork_with_model",
			defaultModel: "Default subagent model",
			defaultModelHint: "Used when `model` is omitted; empty inherits the main agent's model",
			inheritOption: "(inherit main agent's model)",
			removedOption: "(removed from providers: {id})",
			maxTokens: "Default max output tokens",
			maxTokensHint: "Used when `max_tokens` is omitted; empty means provider default",
			maxDepth: "Delegation depth cap",
			maxDepthHint: "0 = no delegation; empty keeps the composition default (3)",
			save: "Save",
			saving: "Saving...",
			saved: "Saved",
			loading: "Loading...",
			note: "Per-call model / max_tokens / provider still override; these are defaults when omitted. The model list comes from Settings > Models.",
			expand: "Expand",
			collapse: "Collapse",
			rosterTitle: "Subagent run roster",
			rosterCount: "{n} record(s)",
			rosterEmpty: "No delegations recorded in this workspace",
			statusRunning: "Running",
			statusIdle: "Idle (continuable)",
			statusCompleted: "Completed",
			statusFailed: "Failed",
			statusCancelled: "Cancelled",
			statusUnknown: "Unknown",
			starting: "Starting…",
			kindContinuable: "Continuable",
			kindBackground: "Background",
			kindForeground: "Foreground",
			taskLabel: "Task",
			dependsLabel: "Depends on",
			personaLabel: "Persona",
			openChild: "Open child session",
			summaryLabel: "Summary",
			liveRunning: "resident",
			liveInactive: "inactive",
			rosterHint: "Use the subagent_status tool for the full roster and task ids",
			childLabel: "Child"
		};

		/** Route helpers (same origin). */
		async function readJson(response) {
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				const message = body !== null && typeof body === "object" && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return body;
		}

		const cardStyles = {
			card: { listStyle: "none", margin: "6px 0", border: "1px solid rgba(128,128,128,0.35)", borderRadius: "8px", background: "rgba(128,128,128,0.07)" },
			header: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "10px 12px", background: "transparent", border: "none", color: "inherit", cursor: "pointer", textAlign: "left" },
			headText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" },
			name: { fontWeight: 600, fontSize: "13px" },
			desc: { opacity: 0.65, fontSize: "12px" },
			chevron: { opacity: 0.7, fontSize: "12px" },
			body: { padding: "12px", borderTop: "1px solid rgba(128,128,128,0.2)", display: "flex", flexDirection: "column", gap: "10px" },
			row: { display: "flex", flexDirection: "column", gap: "4px" },
			label: { fontSize: "12px", opacity: 0.9 },
			hint: { fontSize: "11px", opacity: 0.55 },
			control: { padding: "6px 8px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.4)", background: "rgba(0,0,0,0.25)", color: "inherit", fontSize: "13px" },
			actions: { display: "flex", alignItems: "center", gap: "10px" },
			button: { padding: "6px 16px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.5)", background: "rgba(128,128,128,0.18)", color: "inherit", fontSize: "13px", cursor: "pointer" },
			statusOk: { fontSize: "12px", color: "#66bb6a" },
			statusErr: { fontSize: "12px", color: "#ef5350" },
			note: { fontSize: "11px", opacity: 0.55 }
		};

		/** The card: defaults for the subagent-model delegation tools. */
		function SubagentModelCard(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => zh[key] ?? key;
			const [open, setOpen] = useState(false);
			const [config, setConfig] = useState(null);
			const [entries, setEntries] = useState([]);
			const [draftModel, setDraftModel] = useState("");
			const [draftTokens, setDraftTokens] = useState("");
			const [draftDepth, setDraftDepth] = useState("");
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const [cfg, models] = await Promise.all([
							readJson(await fetch("/api/subagent-model/config")),
							readJson(await fetch("/api/subagent-model/models"))
						]);
						if (cancelled) return;
						const value = cfg.config;
						setConfig(value);
						setEntries(Array.isArray(models.entries) ? models.entries : []);
						setDraftModel(value.defaultModel ?? "");
						setDraftTokens(value.defaultMaxTokens == null ? "" : String(value.defaultMaxTokens));
						setDraftDepth(value.maxDepth == null ? "" : String(value.maxDepth));
					} catch (error) {
						if (!cancelled) setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
					}
				})();
				return () => { cancelled = true; };
			}, []);

			async function save() {
				setBusy(true);
				setStatus(null);
				try {
					const payload = {
						defaultModel: draftModel,
						defaultMaxTokens: draftTokens === "" ? null : Number(draftTokens),
						maxDepth: draftDepth === "" ? null : Number(draftDepth)
					};
					const body = await readJson(await fetch("/api/subagent-model/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					}));
					const value = body.config;
					setConfig(value);
					setDraftModel(value.defaultModel ?? "");
					setDraftTokens(value.defaultMaxTokens == null ? "" : String(value.defaultMaxTokens));
					setDraftDepth(value.maxDepth == null ? "" : String(value.maxDepth));
					setStatus({ ok: true, text: t("saved") });
				} catch (error) {
					setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(false);
				}
			}

			const modelIds = entries.map((entry) => entry.model);
			const staleDefault = config !== null && config.defaultModel !== "" && config.defaultModel != null && !modelIds.includes(config.defaultModel);

			return h("li", { style: cardStyles.card },
				h("button", { type: "button", style: cardStyles.header, "aria-expanded": open, onClick: () => setOpen(!open) },
					h("span", { style: cardStyles.headText },
						h("span", { style: cardStyles.name }, t("title")),
						h("span", { style: cardStyles.desc }, t("description"))
					),
					h("span", { style: cardStyles.chevron }, open ? "▴" : "▾")
				),
				open ? h("div", { style: cardStyles.body },
					config === null && status === null ? h("div", { style: cardStyles.hint }, t("loading")) : null,
					h("div", { style: cardStyles.row },
						h("label", { style: cardStyles.label }, t("defaultModel")),
						h("select", { style: cardStyles.control, value: draftModel, onChange: (event) => setDraftModel(event.target.value), disabled: entries.length === 0 },
							h("option", { value: "" }, t("inheritOption")),
							entries.map((entry) => h("option", { key: `${entry.provider}/${entry.model}`, value: entry.model, title: `${entry.provider} / ${entry.model}` },
								`${entry.label} — ${entry.model}${entry.provider !== "" ? ` (${entry.provider})` : ""}`
							)),
							staleDefault ? h("option", { key: "stale", value: config.defaultModel }, t("removedOption").replace("{id}", config.defaultModel)) : null
						),
						h("span", { style: cardStyles.hint }, t("defaultModelHint"))
					),
					h("div", { style: cardStyles.row },
						h("label", { style: cardStyles.label }, t("maxTokens")),
						h("input", { type: "number", min: "1", step: "1", style: cardStyles.control, value: draftTokens, onChange: (event) => setDraftTokens(event.target.value), placeholder: "4096" }),
						h("span", { style: cardStyles.hint }, t("maxTokensHint"))
					),
					h("div", { style: cardStyles.row },
						h("label", { style: cardStyles.label }, t("maxDepth")),
						h("input", { type: "number", min: "0", step: "1", style: cardStyles.control, value: draftDepth, onChange: (event) => setDraftDepth(event.target.value), placeholder: "3" }),
						h("span", { style: cardStyles.hint }, t("maxDepthHint"))
					),
					h("div", { style: cardStyles.actions },
						h("button", { type: "button", style: cardStyles.button, onClick: save, disabled: busy },
							busy ? t("saving") : t("save")
						),
						status !== null ? h("span", { style: status.ok ? cardStyles.statusOk : cardStyles.statusErr }, status.text) : null
					),
					h("div", { style: cardStyles.note }, t("note"))
				) : null
			);
		}

		// ── toolview cards: conversation-flow roster for this plugin's tools ──

		/** Tool names whose tool-call cards this bundle owns (open key domain). */
		const TOOLVIEW_KEYS = ["subagent_with_model", "subagent_fork_with_model", "subagent_status"];
		/** The roster tool renders the shared run-list view. */
		const ROSTER_TOOL_KEY = "subagent_status";

		/** Host services captured from apply() for session navigation. */
		let services = null;

		function parseArgsRaw(raw) {
			try {
				const value = JSON.parse(typeof raw === "string" && raw !== "" ? raw : "{}");
				return value !== null && typeof value === "object" ? value : {};
			} catch {
				return {};
			}
		}

		function parseRunId(text) {
			if (typeof text !== "string") return "";
			const match = /\[run: ([0-9a-fA-F-]{36})\]/.exec(text);
			return match === null ? "" : match[1];
		}

		function resultText(block) {
			if (block === null || typeof block !== "object" || block.kind !== "tool-result") return "";
			return (block.content ?? [])
				.filter((content) => content !== null && typeof content === "object" && content.type === "text" && typeof content.text === "string")
				.map((content) => content.text)
				.join("");
		}

		async function fetchRuns(cwd, sessionId) {
			if (typeof fetch !== "function") return [];
			try {
				const params = new URLSearchParams();
				if (typeof cwd === "string" && cwd !== "") params.set("cwd", cwd);
				if (typeof sessionId === "string" && sessionId !== "") params.set("sessionId", sessionId);
				const response = await fetch(`/api/subagent-model/runs?${params.toString()}`, { cache: "no-store" });
				if (!response.ok) return [];
				const body = await response.json();
				return body !== null && typeof body === "object" && Array.isArray(body.runs) ? body.runs : [];
			} catch {
				return [];
			}
		}

		const STATUS_STYLE = {
			running: { color: "#4fc3f7", border: "1px solid rgba(79,195,247,0.45)" },
			idle: { color: "#b0bec5", border: "1px solid rgba(176,190,197,0.4)" },
			completed: { color: "#66bb6a", border: "1px solid rgba(102,187,106,0.45)" },
			failed: { color: "#ef5350", border: "1px solid rgba(239,83,80,0.45)" },
			cancelled: { color: "#ffa726", border: "1px solid rgba(255,167,38,0.45)" }
		};

		const runStyles = {
			root: { margin: "6px 0", border: "1px solid rgba(128,128,128,0.3)", borderRadius: "8px", background: "rgba(128,128,128,0.06)", padding: "10px 12px", fontSize: "12px", display: "flex", flexDirection: "column", gap: "6px" },
			head: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			label: { fontWeight: 600, fontSize: "13px" },
			badge: { padding: "1px 8px", borderRadius: "10px", fontSize: "11px", lineHeight: "18px" },
			chip: { padding: "1px 8px", borderRadius: "6px", background: "rgba(128,128,128,0.16)", fontSize: "11px", lineHeight: "18px" },
			meta: { opacity: 0.75, display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" },
			summary: { opacity: 0.8, whiteSpace: "pre-wrap", maxHeight: "9em", overflow: "auto", borderLeft: "2px solid rgba(128,128,128,0.35)", paddingLeft: "8px" },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "2px 0" },
			hint: { opacity: 0.55 },
			button: { padding: "2px 8px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.45)", background: "transparent", color: "inherit", fontSize: "11px", cursor: "pointer" }
		};

		function statusText(t, status) {
			switch (status) {
				case "running": return t("statusRunning");
				case "idle": return t("statusIdle");
				case "completed": return t("statusCompleted");
				case "failed": return t("statusFailed");
				case "cancelled": return t("statusCancelled");
				default: return t("statusUnknown");
			}
		}

		function openChildSession(childId) {
			if (typeof childId !== "string" || childId === "") return;
			try {
				const sessions = services?.sessions;
				if (sessions === undefined || sessions === null) return;
				if (typeof sessions.subagentAddress !== "function" || typeof sessions.openSubagent !== "function") return;
				const address = sessions.subagentAddress(childId);
				if (address !== undefined && address !== null) sessions.openSubagent(address);
			} catch {
				// navigation is a convenience; never throw out of a click handler
			}
		}

		/** One run's compact row (shared by the run card and the roster view). */
		function RunRow(t, run) {
			const style = STATUS_STYLE[run.status] ?? STATUS_STYLE.idle;
			return h("div", { key: run.runId, style: runStyles.row },
				h("span", { style: { ...runStyles.badge, ...style } }, statusText(t, run.status)),
				h("span", { style: { fontWeight: 600 } }, run.taskId),
				h("span", {}, run.label || "(untitled)"),
				run.model ? h("span", { style: runStyles.chip }, run.model) : null,
				run.kind ? h("span", { style: runStyles.chip }, t(run.kind === "continuable" ? "kindContinuable" : run.kind === "background" ? "kindBackground" : "kindForeground")) : null,
				run.live === "running" ? h("span", { style: runStyles.hint }, t("liveRunning")) : run.live === "inactive" ? h("span", { style: runStyles.hint }, t("liveInactive")) : null,
				run.childId ? h("button", { type: "button", style: runStyles.button, onClick: () => openChildSession(run.childId) }, t("openChild")) : null
			);
		}

		/** The tool-call card: run view for delegation tools, roster view for the status tool. */
		function SubagentToolView(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const isRoster = props.toolName === ROSTER_TOOL_KEY;
			const block = props.block ?? null;
			const isResult = block !== null && typeof block === "object" && block.kind === "tool-result";
			const call = isResult ? (block.call ?? null) : block;
			const argsRaw = call !== null && typeof call.argsRaw === "string" ? call.argsRaw : "";
			const args = parseArgsRaw(argsRaw);
			const text = isResult ? resultText(block) : "";
			const runId = parseRunId(text);
			const [runs, setRuns] = useState(null);
			const [settled, setSettled] = useState(false);

			useEffect(() => {
				if (typeof fetch !== "function") return undefined; // SSR: inert
				let cancelled = false;
				const tick = async () => {
					const list = await fetchRuns(props.cwd, props.sessionId);
					if (!cancelled) setRuns(list);
				};
				void tick();
				const timer = setInterval(tick, 2500);
				return () => { cancelled = true; clearInterval(timer); };
			}, [props.cwd, props.sessionId, settled]);

			useEffect(() => {
				if (runId === "") return;
				const record = (runs ?? []).find((run) => run.runId === runId);
				if (record !== undefined && ["completed", "failed", "cancelled", "idle"].includes(record.status)) setSettled(true);
			}, [runs, runId]);

			if (isRoster) {
				const list = runs ?? [];
				return h("div", { style: runStyles.root },
					h("div", { style: runStyles.head },
						h("span", { style: runStyles.label }, t("rosterTitle")),
						h("span", { style: runStyles.hint }, t("rosterCount").replace("{n}", String(list.length)))
					),
					list.length === 0 ? h("div", { style: runStyles.hint }, t("rosterEmpty")) : list.map((run) => RunRow(t, run)),
					h("div", { style: runStyles.hint }, t("rosterHint"))
				);
			}

			// delegation (run) view
			const record = (runs ?? []).find((run) => run.runId === runId) ?? null;
			const status = record !== null ? record.status : (isResult ? "unknown" : "running");
			return h("div", { style: runStyles.root },
				h("div", { style: runStyles.head },
					h("span", { style: runStyles.label }, args.description || "(untitled)"),
					h("span", { style: { ...runStyles.badge, ...(STATUS_STYLE[status] ?? STATUS_STYLE.idle) } },
						isResult ? statusText(t, status) : t("starting")),
					args.model ? h("span", { style: runStyles.chip }, args.model) : null,
					record !== null && record.live === "running" ? h("span", { style: runStyles.hint }, t("liveRunning")) : null
				),
				h("div", { style: runStyles.meta },
					record !== null && record.taskId ? h("span", {}, `${t("taskLabel")}: ${record.taskId}`) : null,
					record !== null && record.kind ? h("span", {}, t(record.kind === "continuable" ? "kindContinuable" : record.kind === "background" ? "kindBackground" : "kindForeground")) : null,
					record !== null && Array.isArray(record.dependsOn) && record.dependsOn.length > 0 ? h("span", {}, `${t("dependsLabel")}: ${record.dependsOn.join(", ")}`) : null,
					record !== null && record.childId !== "" ? h("button", { type: "button", style: runStyles.button, onClick: () => openChildSession(record.childId) }, t("openChild")) : null
				),
				args.persona ? h("details", null,
					h("summary", { style: { cursor: "pointer", opacity: 0.75 } }, t("personaLabel")),
					h("div", { style: runStyles.summary }, args.persona)
				) : null,
				record !== null && record.summary !== "" ? h("div", { style: runStyles.summary }, `${t("summaryLabel")}: ${record.summary}`) : null
			);
		}

		/** Browser-half plugin entry. */
		function apply(ctx) {
			// Optional capability, NOT a hard inject: a shell without the
			// sessions service loses only the "open child session" button —
			// the settings card and toolviews keep working. (v0.3.0 regression:
			// `ctx.sessions` was read without declaring the inject.)
			services = { sessions: ctx.get("sessions") ?? null };
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "subagent-model: dictionaries");
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "subagent-model",
				order: 30,
				locale: NS
			}, SubagentModelCard));
			for (const key of TOOLVIEW_KEYS) {
				try {
					ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
						name: "tool.call.toolview",
						key
					}, SubagentToolView));
				} catch (error) {
					// A future shell without the toolview slot must never break the settings card.
					try {
						console.warn(`tool-subagent-model: toolview slot unavailable for ${key}: ${String(error)}`);
					} catch {
						// console itself must not throw either
					}
				}
			}
		}

		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		return module.exports;
	}
});
