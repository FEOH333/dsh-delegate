/**
 * dsh-tool-subagent-model — typed session events.
 *
 * Every delegation mutation appends one `subagent-model/*` event to the
 * delegating parent's session log: an audit/replay trail that survives
 * restarts and never enters model history (non-surface events stay log-only,
 * the same mechanism the shipped `subagent/descriptor` event uses).
 *
 * Containment rule (copied from the team-plugin ecosystem, and the plugin's
 * own philosophy): recording must NEVER break the tool call. A broken event
 * append is logged and dropped.
 */

/** Event types this plugin appends. */
export const EVENT_RUN_STARTED = "subagent-model/run-started";
export const EVENT_RUN_SETTLED = "subagent-model/run-settled";

/**
 * Append one run event to the parent agent's session, contained.
 * @param ctx - plugin context (for the logger).
 * @param parent - the delegating agent; may be disposed/absent — that is fine.
 * @param type - the short event name (`run-started` / `run-settled`), prefixed
 *   with the `subagent-model/` namespace here.
 * @param data - the event payload (plain JSON).
 */
export function appendRunEvent(ctx, parent, type, data) {
	try {
		const session = parent?.session;
		if (session !== undefined && typeof session.append === "function") {
			session.append(`subagent-model/${type}`, data);
		}
	} catch (error) {
		try {
			ctx?.logger?.warn?.(`tool-subagent-model: session record failed after ${type}: ${String(error)}`);
		} catch {
			// logger itself must not throw out of a tool call
		}
	}
}
