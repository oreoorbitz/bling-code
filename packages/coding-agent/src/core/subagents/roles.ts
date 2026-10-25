import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai/compat";
import { APP_NAME } from "../../config.ts";
import { canonicalJson } from "../learning/action-store.ts";
import { LING_OPENROUTER_PROVIDER_ID } from "../ling-models.ts";
import type { HarnessProfile } from "../settings-manager.ts";
import type { SubagentBudgets, SubagentRoleConfig, SubagentRoleKind, SubagentSettings } from "../settings-schema.ts";

export type RoleKind = SubagentRoleKind;
export const ROLE_KINDS: readonly RoleKind[] = ["scout", "coder"];
export const ROLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ENV_PREFIX = APP_NAME.toUpperCase();
export const ENV_SUBAGENT_ROLE: Record<RoleKind, string> = {
	scout: `${ENV_PREFIX}_SUBAGENT_SCOUT`,
	coder: `${ENV_PREFIX}_SUBAGENT_CODER`,
};
export const ENV_BENCHMARK_RUN_ID = `${ENV_PREFIX}_BENCHMARK_RUN_ID`;
export const ENV_BENCHMARK_ARM = `${ENV_PREFIX}_BENCHMARK_ARM`;
/** Env value that disables a role kind even when settings activate one (the "Ling only" arm). */
export const ROLE_DISABLED_VALUE = "none";

export interface ResolvedBudgets {
	maxTurns: number;
	maxTotalTokens: number;
	maxContextTokens: number;
	timeoutMs: number;
	maxCostUsd?: number;
	maxOracleRuns: number;
	/** Cumulative billed output tokens, including reasoning. Unset by default. */
	maxOutputTokens?: number;
	/** Coder only: most changed lines (added plus removed) in the target. Unset by default. */
	maxDiffLines?: number;
}

export const DEFAULT_ROLE_BUDGETS: Record<RoleKind, ResolvedBudgets> = {
	scout: { maxTurns: 20, maxTotalTokens: 400_000, maxContextTokens: 49_000, timeoutMs: 180_000, maxOracleRuns: 0 },
	coder: { maxTurns: 12, maxTotalTokens: 400_000, maxContextTokens: 49_000, timeoutMs: 300_000, maxOracleRuns: 1 },
};

const ALL_SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "seed"] as const;

/**
 * Sampling parameters an OpenRouter upstream does not list as supported, keyed by upstream family (slug text before
 * "/"). With `require_parameters: true` a request carrying one of these has no eligible host and fails, so they are
 * rejected at validation time. A fact about hosts: built from `https://openrouter.ai/api/v1/models/<id>/endpoints`
 * `supported_parameters` on 2026-10-24 for the models in the documented arms (union across those models), and it must
 * be rechecked before runs.
 */
export const UNSUPPORTED_SAMPLING_BY_UPSTREAM: Record<string, readonly string[]> = {
	inception: ["top_p", "top_k", "min_p", "repetition_penalty", "seed"], // mercury: temperature only
	cerebras: ["top_k", "min_p", "repetition_penalty"],
	novita: ["min_p"],
	coreweave: ["min_p"],
	chutes: ["min_p"],
	baidu: ["top_k", "min_p", "repetition_penalty", "seed"], // deepseek-v4-flash: temperature, top_p
	anthropic: [...ALL_SAMPLING_KEYS], // claude-haiku-5.5 lists none of them
	"open-inference": [],
	wafer: [],
};

export function upstreamFamily(upstream: string): string {
	return (upstream.split("/")[0] ?? "").toLowerCase();
}

export function resolveBudgets(kind: RoleKind, overrides?: SubagentBudgets): ResolvedBudgets {
	const defaults = DEFAULT_ROLE_BUDGETS[kind];
	return {
		maxTurns: overrides?.maxTurns ?? defaults.maxTurns,
		maxTotalTokens: overrides?.maxTotalTokens ?? defaults.maxTotalTokens,
		maxContextTokens: overrides?.maxContextTokens ?? defaults.maxContextTokens,
		timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs,
		maxOracleRuns: overrides?.maxOracleRuns ?? defaults.maxOracleRuns,
		...(overrides?.maxCostUsd === undefined ? {} : { maxCostUsd: overrides.maxCostUsd }),
		...(overrides?.maxOutputTokens === undefined ? {} : { maxOutputTokens: overrides.maxOutputTokens }),
		...(overrides?.maxDiffLines === undefined || kind !== "coder" ? {} : { maxDiffLines: overrides.maxDiffLines }),
	};
}

export function validateRoleConfig(name: string, role: SubagentRoleConfig): string[] {
	const errors: string[] = [];
	const label = `subagents.roles.${name}`;
	if (!ROLE_NAME_PATTERN.test(name) || name.length > 64) {
		errors.push(`${label}: name must be lowercase hyphenated and at most 64 characters`);
	}
	if (role.provider === LING_OPENROUTER_PROVIDER_ID) {
		if (!role.upstream) errors.push(`${label}: openrouter roles must name an upstream pin (no implicit host)`);
	} else if (role.upstream !== undefined) {
		errors.push(`${label}: upstream is only supported for the ${LING_OPENROUTER_PROVIDER_ID} provider`);
	}
	if (role.kind === "scout" && role.budgets?.maxDiffLines !== undefined) {
		errors.push(`${label}: budgets.maxDiffLines applies to coder roles only`);
	}
	const unsupported = role.upstream ? (UNSUPPORTED_SAMPLING_BY_UPSTREAM[upstreamFamily(role.upstream)] ?? []) : [];
	for (const key of Object.keys(role.sampling ?? {})) {
		if (unsupported.includes(key))
			errors.push(`${label}: upstream ${role.upstream} does not support sampling parameter ${key}`);
	}
	return errors;
}

/** Active role name per kind: env override first (value "none" disables), then settings. */
export function activeRoleNames(
	settings: SubagentSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Partial<Record<RoleKind, string>> {
	const names: Partial<Record<RoleKind, string>> = {};
	for (const kind of ROLE_KINDS) {
		const fromEnv = env[ENV_SUBAGENT_ROLE[kind]]?.trim();
		const name = fromEnv ? (fromEnv === ROLE_DISABLED_VALUE ? undefined : fromEnv) : settings?.active?.[kind];
		if (name) names[kind] = name;
	}
	return names;
}

export function validateSubagentSettings(
	settings: SubagentSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const errors: string[] = [];
	for (const [name, role] of Object.entries(settings?.roles ?? {})) errors.push(...validateRoleConfig(name, role));
	for (const kind of ROLE_KINDS) {
		const name = activeRoleNames(settings, env)[kind];
		if (!name) continue;
		const role = settings?.roles?.[name];
		if (!role) errors.push(`active ${kind} role "${name}" is not defined in subagents.roles`);
		else if (role.kind !== kind) errors.push(`active ${kind} role "${name}" has kind ${role.kind}`);
	}
	for (const name of Object.keys(settings?.scripts ?? {})) {
		if (!ROLE_NAME_PATTERN.test(name)) errors.push(`subagents.scripts.${name}: name must be lowercase hyphenated`);
	}
	return errors;
}

export interface RoleModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export type RoleResolutionErrorCode = "not_configured" | "invalid_config" | "model_missing" | "auth_missing";

export class RoleResolutionError extends Error {
	readonly code: RoleResolutionErrorCode;
	constructor(code: RoleResolutionErrorCode, message: string) {
		super(message);
		this.name = "RoleResolutionError";
		this.code = code;
	}
}

export interface ResolvedRole {
	name: string;
	kind: RoleKind;
	config: SubagentRoleConfig;
	model: Model<Api>;
	thinking: ThinkingLevel;
	budgets: ResolvedBudgets;
	requestedUpstream?: string;
	identityHash: string;
}

export function roleIdentity(name: string, config: SubagentRoleConfig): Record<string, unknown> {
	return {
		name,
		kind: config.kind,
		provider: config.provider,
		model: config.model,
		upstream: config.upstream,
		zdr: config.zdr,
		dataCollection: config.dataCollection,
		contextWindow: config.contextWindow,
		sampling: config.sampling,
		thinking: config.thinking ?? "off",
		budgets: resolveBudgets(config.kind, config.budgets),
	};
}

/** Clone of the catalog model with this role's pin and sampling. Never mutates `base`; sampling replaces, not merges. */
export function deriveRoleModel(base: Model<Api>, config: SubagentRoleConfig): Model<Api> {
	const derived: Model<Api> = {
		...base,
		samplingParams: { ...(config.sampling ?? {}) },
		samplingParamsByThinkingLevel: undefined,
		...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
	};
	if (config.upstream !== undefined) {
		derived.compat = {
			...(base.compat ?? {}),
			// require_parameters keeps OpenRouter from silently dropping a request parameter (sampling, tools, reasoning)
			// that the pinned host does not support.
			openRouterRouting: {
				only: [config.upstream],
				allow_fallbacks: false,
				require_parameters: true,
				...(config.zdr === undefined ? {} : { zdr: config.zdr }),
				...(config.dataCollection === undefined ? {} : { data_collection: config.dataCollection }),
			},
		} as Model<Api>["compat"];
	}
	return derived;
}

export function resolveRole(
	kind: RoleKind,
	settings: SubagentSettings | undefined,
	source: RoleModelSource,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedRole {
	const name = activeRoleNames(settings, env)[kind];
	if (!name) throw new RoleResolutionError("not_configured", `No active ${kind} role is configured`);
	const config = settings?.roles?.[name];
	if (!config) {
		throw new RoleResolutionError(
			"invalid_config",
			`Active ${kind} role "${name}" is not defined in subagents.roles`,
		);
	}
	if (config.kind !== kind) {
		throw new RoleResolutionError("invalid_config", `Role "${name}" has kind ${config.kind}, not ${kind}`);
	}
	const errors = validateRoleConfig(name, config);
	if (errors.length > 0) throw new RoleResolutionError("invalid_config", errors.join("; "));
	const base = source.find(config.provider, config.model);
	if (!base) {
		throw new RoleResolutionError(
			"model_missing",
			`Model ${config.provider}/${config.model} is not in the model catalog; no fallback is attempted`,
		);
	}
	if (config.budgets?.maxCostUsd !== undefined && base.cost.input === 0 && base.cost.output === 0) {
		throw new RoleResolutionError(
			"invalid_config",
			`Role "${name}" sets budgets.maxCostUsd but ${config.provider}/${config.model} has no pricing (input and output cost are 0), so the cost budget could never trip`,
		);
	}
	if (!source.hasConfiguredAuth(base)) {
		throw new RoleResolutionError(
			"auth_missing",
			`Provider ${config.provider} has no configured credentials; no fallback is attempted`,
		);
	}
	const model = deriveRoleModel(base, config);
	return {
		name,
		kind,
		config,
		model,
		thinking: clampThinkingLevel(model, config.thinking ?? "off") as ThinkingLevel,
		budgets: resolveBudgets(kind, config.budgets),
		...(config.upstream === undefined ? {} : { requestedUpstream: config.upstream }),
		identityHash: createHash("sha256")
			.update(canonicalJson(roleIdentity(name, config)))
			.digest("hex")
			.slice(0, 12),
	};
}

/** Stable arm label: harness profile + armLabel + hash of the active role identities. No model lookup. */
export function armIdFromSettings(
	harness: HarnessProfile,
	settings: SubagentSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const names = activeRoleNames(settings, env);
	const identities = ROLE_KINDS.flatMap((kind) => {
		const name = names[kind];
		if (!name) return [];
		const config = settings?.roles?.[name];
		return [config ? roleIdentity(name, config) : { kind, name, missing: true }];
	});
	const hash =
		identities.length === 0
			? "none"
			: createHash("sha256").update(canonicalJson(identities)).digest("hex").slice(0, 8);
	return `${harness}:${settings?.armLabel ?? "unlabeled"}:${hash}`;
}
