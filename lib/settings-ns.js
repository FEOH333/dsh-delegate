/**
 * dsh-tool-subagent-model — settings-namespace presence.
 *
 * Since dsh 0.1.1-rc.2 the Settings > Plugins page dispatches plugin-config
 * cards by SETTINGS NAMESPACE (the served-namespaces ∩ registered-cards
 * intersection), so a keyed `settings.plugin.item` card is invisible unless
 * the Host serves its namespace. This module registers the `subagent-model`
 * namespace exactly once per process.
 *
 * The namespace is a PRESENCE declaration only: the card's data continues to
 * flow through the plugin's own `/api/subagent-model` routes and
 * `$DSH_HOME/subagent-model.json`; hooks are inert. Failures only hide the card,
 * never break the delegation tools.
 *
 * Since 0.3.6 the Web settings panel ALSO gains a dedicated `settings.section`
 * page (client side) that renders regardless of namespace dispatch — the two
 * mechanisms are independent, so at least one surface is always available.
 *
 * ── dsh 0.1.2 compatibility ────────────────────────────────────────────────
 * dsh 0.1.2-rc.1 removed the `installSettingsSection` / `settingsNamespace`
 * wrapper exports from `@deepseek-ai/dsh-settings` (the module now exposes only
 * `SettingsProvider`, `SettingsConflictError` and `redactSecrets`). Importing
 * them statically is a link-time SyntaxError, which aborted the whole profile
 * boot — so this module now calls the underlying seam directly:
 *
 *     ctx.inject(['settings'], sctx => sctx.settings.register(ns, schema, { base }))
 *
 * `SettingsProvider.register` is what the old wrapper delegated to, and its
 * signature is unchanged across 0.1.1-rc.2 and 0.1.2-rc.1, so this form works
 * on both. `settingsNamespace()` only validated a regex and returned its
 * argument, so the namespace is now a plain string constant.
 */
import z from "@deepseek-ai/schemastery";

/** Settings namespace this plugin exposes (mirrors the client card key). */
export const SUBAGENT_MODEL_SETTINGS_NS = "subagent-model";

/** Declared (advisory) shape of the user-defaults config; all optional. */
const SubagentSettingsSchema = z.object({
	defaultModel: z.string(),
	defaultMaxTokens: z.natural(),
	maxDepth: z.natural(),
	lockDefaultModel: z.boolean()
});

/** Single-flight flag: two rows share one profile, the namespace is process-wide. */
let settingsSectionInstalled = false;

/**
 * Register the settings namespace ONCE per process.
 *
 * The registration goes through `ctx.inject(['settings'], …)` ONLY — never a
 * preceding `ctx.get('settings')` presence check. Profile rows are mounted
 * concurrently and the settings provider's async init can still be in flight
 * when this row applies, so a `ctx.get` guard returns `undefined` and bails out
 * forever: the namespace is then never served and the Settings > Plugins card
 * silently disappears (observed live on dsh 0.1.2-rc.1). `ctx.inject` runs the
 * callback immediately when the service is already available and defers it
 * until it appears otherwise — the exact pattern dsh-agent-presets,
 * dsh-llm-pi-ai and the shipped client plugins use. A headless profile without
 * a settings service simply never fires the callback.
 *
 * The registration itself is wrapped too: the callback may run after this
 * function returned, so a throw there would otherwise escape as an unhandled
 * error instead of the intended "card hidden, tools unaffected" degradation.
 *
 * @param ctx - the first row's context (owns the registration).
 * @param config - that row's configuration (seeds the base layer).
 */
export function installSettingsSectionOnce(ctx, config) {
	if (settingsSectionInstalled) return;
	settingsSectionInstalled = true;
	try {
		ctx.inject(["settings"], (sctx) => {
			try {
				sctx.settings.register(SUBAGENT_MODEL_SETTINGS_NS, SubagentSettingsSchema, {
					base: {
						defaultModel: "",
						defaultMaxTokens: config.defaultMaxTokens ?? void 0,
						maxDepth: typeof config.maxDepth === "number" ? config.maxDepth : void 0,
						lockDefaultModel: config.lockDefaultModel === true
					}
				});
			} catch (error) {
				settingsSectionInstalled = false;
				ctx.logger.warn(`tool-subagent-model: settings namespace registration failed: ${String(error)}`);
			}
		});
	} catch (error) {
		settingsSectionInstalled = false;
		ctx.logger.warn(`tool-subagent-model: settings namespace injection failed: ${String(error)}`);
	}
}

/** Reset the single-flight flag (test seam). */
export function resetSettingsSectionForTesting() {
	settingsSectionInstalled = false;
}
