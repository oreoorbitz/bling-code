/** Provider ID written by `configure --base-url` for a self-hosted Ling endpoint. */
export const LING_ENDPOINT_PROVIDER_ID = "ling";
/** Built-in provider that serves Ling by default. */
export const LING_OPENROUTER_PROVIDER_ID = "openrouter";
const LING_OPENROUTER_MODEL_PREFIX = "inclusionai/ling-";

/**
 * Vendor-recommended sampling from each model's release notes, and the OpenRouter upstream
 * pinned by default so one run is never split across hosts with different quantization. Novita is
 * the only host for Ling 3.1 (1M context) and serves 3.0 with the full 262k context; Ant Digital is
 * the only host for the 3.2 Flash free trial; DeepInfra is the only host for 3.0 VL.
 */
export const LING_PROFILES = {
	"3.1": {
		name: "Ling 3.1 Flash",
		openRouterModelId: "inclusionai/ling-3.1-flash",
		openRouterUpstream: "novita",
		endpointModelId: "Ling-3.1-flash",
		input: ["text"],
		samplingParams: { temperature: 1.0, top_p: 0.95, top_k: 20 },
	},
	"3.2": {
		name: "Ling 3.2 Flash",
		openRouterModelId: "inclusionai/ling-3.2-flash:free",
		openRouterUpstream: "antdigital",
		endpointModelId: "Ling-3.2-flash",
		input: ["text", "image"],
		// Provisional: no vendor sampling published during the free trial, so mirror 3.1.
		samplingParams: { temperature: 1.0, top_p: 0.95, top_k: 20 },
	},
	"3.0": {
		name: "Ling 3.0 Flash",
		openRouterModelId: "inclusionai/ling-3.0-flash",
		openRouterUpstream: "novita",
		endpointModelId: "Ling-3.0-flash",
		input: ["text"],
		samplingParams: { temperature: 0.6, top_p: 0.95, top_k: 20 },
	},
	"3.0-vl": {
		name: "Ling 3.0 Flash VL",
		openRouterModelId: "inclusionai/ling-3.0-flash-vl",
		openRouterUpstream: "deepinfra",
		endpointModelId: "Ling-3.0-flash-vl",
		input: ["text", "image"],
		samplingParams: { temperature: 1.0, top_p: 0.95, top_k: 20 },
	},
} as const;

export type LingProfile = keyof typeof LING_PROFILES;

export const LING_DEFAULT_PROFILE: LingProfile = "3.1";

/**
 * Whether a provider/model pair is a Ling model contract. Ling defaults and Ling sessions are never
 * replaced implicitly by another provider or Ling generation.
 */
export function isLingModelRef(provider: string | undefined, modelId: string | undefined): boolean {
	if (provider === LING_ENDPOINT_PROVIDER_ID) return true;
	return provider === LING_OPENROUTER_PROVIDER_ID && !!modelId?.toLowerCase().startsWith(LING_OPENROUTER_MODEL_PREFIX);
}
