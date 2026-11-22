import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import type { HarnessProfile } from "../settings-manager.ts";
import type { LongSessionSettings } from "../settings-schema.ts";
import type { LoopProtectionMode } from "./loop-guard.ts";

export interface LongSessionConfig {
	loopProtection: LoopProtectionMode;
	clearToolResultsChars: number;
	keepRecentToolResults: number;
	readCache: boolean;
}

/** The effective long-session guards; everything is off under the "stock" harness profile. */
export function longSessionConfig(
	harness: HarnessProfile,
	settings: LongSessionSettings | undefined,
): LongSessionConfig {
	const defaults = SETTINGS_DEFAULTS.longSession;
	const stock = harness === "stock";
	return {
		loopProtection: stock ? "off" : (settings?.loopProtection ?? defaults.loopProtection),
		clearToolResultsChars: stock ? 0 : (settings?.clearToolResultsChars ?? defaults.clearToolResultsChars),
		keepRecentToolResults: settings?.keepRecentToolResults ?? defaults.keepRecentToolResults,
		readCache: stock ? false : (settings?.readCache ?? defaults.readCache),
	};
}

/** Whether the guards differ from what the harness profile implies, so benchmark arms must tell them apart. */
export function longSessionIsDefault(harness: HarnessProfile, settings: LongSessionSettings | undefined): boolean {
	const effective = longSessionConfig(harness, settings);
	const baseline = longSessionConfig(harness, undefined);
	return (Object.keys(baseline) as Array<keyof LongSessionConfig>).every((key) => effective[key] === baseline[key]);
}
