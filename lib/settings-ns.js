/**
 * dsh-tool-subagent-model — settings-namespace presence.
 *
 * Since dsh 0.1.1-rc.2 the Settings > Plugins page dispatches plugin-config
 * cards by SETTINGS NAMESPACE (the served-namespaces ∩ registered-cards
 * intersection), so a keyed `settings.plugin.item` card is invisible unless
 * the Host serves its namespace. This module registers the `subagent-model`
 * namespace exactly once per process (official `installSettingsSection`
 * pattern, the same link the shell / web-search plugin cards use).
 *
 * The namespace is a PRESENCE declaration only: the card's data continues to
 * flow through the plugin's own `/api/subagent-model` routes and
 * `~/.dsh/subagent-model.json`; hooks are inert. Failures only hide the card,
 * never break the delegation tools.
 *
 * Since 0.3.6 the Web settings panel ALSO gains a dedicated `settings.section`
 * page (client side) that renders regardless of namespace dispatch — the two
 * mechanisms are independent, so at least one surface is always available.
 */
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Settings namespace this plugin exposes (mirrors the client card key). */
export const SUBAGENT_MODEL_SETTINGS_NS = settingsNamespace("subagent-model");

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
 * Register the settings namespace ONCE per process. Headless profiles without
 * the settings service skip registration silently.
 */
export function installSettingsSectionOnce(ctx, config) {
	if (settingsSectionInstalled) return;
	if (ctx.get("settings") === void 0) return; // headless profiles: no card surface
	settingsSectionInstalled = true;
	try {
		installSettingsSection(ctx, SUBAGENT_MODEL_SETTINGS_NS, SubagentSettingsSchema, {
			defaultModel: "",
			defaultMaxTokens: config.defaultMaxTokens ?? void 0,
			maxDepth: typeof config.maxDepth === "number" ? config.maxDepth : void 0,
			lockDefaultModel: config.lockDefaultModel === true
		}, {
			setSource: () => {},
			onChange: () => {}
		});
	} catch (error) {
		settingsSectionInstalled = false;
		ctx.logger.warn(`tool-subagent-model: settings namespace registration failed: ${String(error)}`);
	}
}

/** Reset the single-flight flag (test seam). */
export function resetSettingsSectionForTesting() {
	settingsSectionInstalled = false;
}