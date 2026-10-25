import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { SettingsSchema, type SubagentRoleConfig, type SubagentSettings } from "../src/core/settings-schema.ts";
import {
	activeRoleNames,
	armIdFromSettings,
	deriveRoleModel,
	type RoleModelSource,
	RoleResolutionError,
	resolveRole,
	validateRoleConfig,
	validateSubagentSettings,
} from "../src/core/subagents/roles.ts";

function baseModel(): Model<Api> {
	return {
		id: "qwen/qwen3.8-27b",
		name: "Qwen",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
		samplingParams: { temperature: 0.7, top_k: 40 },
		compat: { thinkingFormat: "openrouter" },
	} as Model<Api>;
}

function role(overrides: Partial<SubagentRoleConfig> = {}): SubagentRoleConfig {
	return {
		kind: "scout",
		provider: "openrouter",
		model: "qwen/qwen3.8-27b",
		upstream: "chutes/fp8",
		sampling: { temperature: 0.2 },
		...overrides,
	};
}

function source(model: Model<Api> | undefined, auth = true): RoleModelSource {
	return { find: () => model, hasConfiguredAuth: () => auth };
}

function code(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof RoleResolutionError ? error.code : "other";
	}
	return undefined;
}

describe("validateRoleConfig", () => {
	test("requires upstream for openrouter", () => {
		expect(validateRoleConfig("a", role({ upstream: undefined })).join()).toContain("upstream pin");
	});
	test("rejects upstream for other providers", () => {
		expect(validateRoleConfig("a", role({ provider: "ling" })).join()).toContain("only supported");
	});
	test("inception rejects top_p and top_k", () => {
		const errors = validateRoleConfig("a", role({ upstream: "inception", sampling: { top_p: 0.9, top_k: 5 } }));
		expect(errors).toHaveLength(2);
	});
	test("cerebras rejects top_k but accepts top_p", () => {
		expect(validateRoleConfig("a", role({ upstream: "cerebras", sampling: { top_k: 5 } }))).toHaveLength(1);
		expect(validateRoleConfig("a", role({ upstream: "cerebras", sampling: { top_p: 0.9 } }))).toEqual([]);
	});
	test("rejects bad names", () => {
		expect(validateRoleConfig("Bad_Name", role())).toHaveLength(1);
	});
});

describe("validateRoleConfig budgets and sampling table", () => {
	test("maxDiffLines is coder only", () => {
		expect(validateRoleConfig("a", role({ budgets: { maxDiffLines: 10 } })).join()).toContain("coder roles only");
		expect(validateRoleConfig("a", role({ kind: "coder", budgets: { maxDiffLines: 10 } }))).toEqual([]);
	});
	test("resolves maxOutputTokens and maxDiffLines, unset by default", () => {
		const settings = (kind: "scout" | "coder", budgets?: SubagentRoleConfig["budgets"]): SubagentSettings => ({
			roles: { r: role({ kind, budgets }) },
			active: { [kind]: "r" },
		});
		const unset = resolveRole("coder", settings("coder"), source(baseModel()), {}).budgets;
		expect(unset.maxOutputTokens).toBeUndefined();
		expect(unset.maxDiffLines).toBeUndefined();
		const set = resolveRole(
			"coder",
			settings("coder", { maxOutputTokens: 5000, maxDiffLines: 40 }),
			source(baseModel()),
			{},
		).budgets;
		expect(set).toMatchObject({ maxOutputTokens: 5000, maxDiffLines: 40, maxTotalTokens: 400000 });
	});
	test("rejects sampling parameters the pinned host does not list", () => {
		const check = (upstream: string, sampling: object) =>
			validateRoleConfig("a", role({ upstream, sampling })).length === 0;
		expect(check("inception", { temperature: 0.2 })).toBe(true);
		expect(check("inception", { temperature: 0.2, seed: 1 })).toBe(false);
		expect(check("baidu/fp8", { temperature: 0.2, top_p: 0.9 })).toBe(true);
		expect(check("baidu/fp8", { top_k: 20 })).toBe(false);
		expect(check("anthropic", {})).toBe(true);
		expect(check("anthropic", { temperature: 0.2 })).toBe(false);
		expect(check("novita", { temperature: 1, top_p: 0.95, top_k: 20, repetition_penalty: 1 })).toBe(true);
		expect(check("novita", { min_p: 0.1 })).toBe(false);
		expect(check("coreweave/fp4", { min_p: 0.1 })).toBe(false);
		expect(check("chutes/fp8", { min_p: 0.1 })).toBe(false);
		expect(check("open-inference/fp4", { temperature: 0.2, top_p: 0.9, top_k: 20, min_p: 0.1 })).toBe(true);
		expect(check("wafer/nvfp4", { min_p: 0.1, repetition_penalty: 1.1, seed: 3 })).toBe(true);
		expect(check("cerebras", { top_k: 20 })).toBe(false);
		expect(check("cerebras", { temperature: 0.2, top_p: 0.9, seed: 1 })).toBe(true);
	});
});

describe("validateSubagentSettings", () => {
	test("active role missing or wrong kind", () => {
		const settings: SubagentSettings = { roles: { s: role() }, active: { scout: "x", coder: "s" } };
		const errors = validateSubagentSettings(settings, {});
		expect(errors.some((e) => e.includes('"x" is not defined'))).toBe(true);
		expect(errors.some((e) => e.includes("has kind scout"))).toBe(true);
	});
});

describe("deriveRoleModel", () => {
	test("pins, replaces sampling, leaves base untouched", () => {
		const base = baseModel();
		const snapshot = structuredClone(base);
		const derived = deriveRoleModel(base, role({ contextWindow: 65536 }));
		expect(derived.compat).toMatchObject({
			openRouterRouting: {
				only: ["chutes/fp8"],
				allow_fallbacks: false,
				require_parameters: true,
			},
		});
		expect(derived.samplingParams).toEqual({ temperature: 0.2 });
		expect(derived.contextWindow).toBe(65536);
		expect(base).toEqual(snapshot);
	});
	test("maps zdr and dataCollection to routing fields, omitting them when unset", () => {
		const plain = deriveRoleModel(baseModel(), role());
		expect((plain.compat as { openRouterRouting: object }).openRouterRouting).toEqual({
			only: ["chutes/fp8"],
			allow_fallbacks: false,
			require_parameters: true,
		});
		const strict = deriveRoleModel(baseModel(), role({ zdr: true, dataCollection: "deny" }));
		expect((strict.compat as { openRouterRouting: object }).openRouterRouting).toEqual({
			only: ["chutes/fp8"],
			allow_fallbacks: false,
			require_parameters: true,
			zdr: true,
			data_collection: "deny",
		});
		const off = deriveRoleModel(baseModel(), role({ zdr: false, dataCollection: "allow" }));
		expect((off.compat as { openRouterRouting: object }).openRouterRouting).toMatchObject({
			zdr: false,
			data_collection: "allow",
		});
	});
	test("same model, different upstreams coexist", () => {
		const base = baseModel();
		const a = deriveRoleModel(base, role({ upstream: "chutes/fp8" }));
		const b = deriveRoleModel(base, role({ upstream: "cerebras" }));
		expect((a.compat as { openRouterRouting: { only: string[] } }).openRouterRouting.only).toEqual(["chutes/fp8"]);
		expect((b.compat as { openRouterRouting: { only: string[] } }).openRouterRouting.only).toEqual(["cerebras"]);
	});
});

describe("resolveRole", () => {
	const settings: SubagentSettings = { roles: { s: role() }, active: { scout: "s" } };
	test("error codes", () => {
		expect(code(() => resolveRole("coder", settings, source(baseModel()), {}))).toBe("not_configured");
		expect(code(() => resolveRole("scout", { roles: {}, active: { scout: "s" } }, source(baseModel()), {}))).toBe(
			"invalid_config",
		);
		expect(code(() => resolveRole("scout", settings, source(undefined), {}))).toBe("model_missing");
		expect(code(() => resolveRole("scout", settings, source(baseModel(), false), {}))).toBe("auth_missing");
	});
	test("rejects maxCostUsd when the model has no pricing, accepts it when priced", () => {
		const budgeted: SubagentSettings = {
			roles: { s: role({ budgets: { maxCostUsd: 0.1 } }) },
			active: { scout: "s" },
		};
		const unpriced = baseModel();
		expect(code(() => resolveRole("scout", budgeted, source(unpriced), {}))).toBe("invalid_config");
		const inputOnly = { ...baseModel(), cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
		expect(resolveRole("scout", budgeted, source(inputOnly), {}).budgets.maxCostUsd).toBe(0.1);
		// No cost budget: zero pricing is allowed.
		expect(resolveRole("scout", settings, source(unpriced), {}).budgets.maxCostUsd).toBeUndefined();
	});
	test("resolves with budgets and requested upstream", () => {
		const resolved = resolveRole("scout", settings, source(baseModel()), {});
		expect(resolved.requestedUpstream).toBe("chutes/fp8");
		expect(resolved.budgets.maxTurns).toBe(20);
		expect(resolved.identityHash).toMatch(/^[0-9a-f]{12}$/);
	});
	test("env overrides settings and none disables", () => {
		const two: SubagentSettings = { roles: { s: role(), t: role({ upstream: "cerebras" }) }, active: { scout: "s" } };
		expect(resolveRole("scout", two, source(baseModel()), { BLING_SUBAGENT_SCOUT: "t" }).name).toBe("t");
		expect(activeRoleNames(two, { BLING_SUBAGENT_SCOUT: "none" })).toEqual({});
	});
});

describe("armIdFromSettings", () => {
	const settings: SubagentSettings = { armLabel: "x", roles: { s: role() }, active: { scout: "s" } };
	test("stable and sensitive", () => {
		const id = armIdFromSettings("bling", settings, {});
		expect(armIdFromSettings("bling", structuredClone(settings), {})).toBe(id);
		expect(id).toMatch(/^bling:x:[0-9a-f]{8}$/);
		const changed = (roles: Record<string, SubagentRoleConfig>, extra: Partial<SubagentSettings> = {}) =>
			armIdFromSettings("bling", { ...settings, roles, ...extra }, {});
		expect(changed({ s: role({ upstream: "cerebras" }) })).not.toBe(id);
		expect(changed({ s: role({ sampling: { temperature: 0.3 } }) })).not.toBe(id);
		expect(changed({ s: role({ budgets: { maxTurns: 5 } }) })).not.toBe(id);
		expect(changed({ s: role({ budgets: { maxOutputTokens: 5000 } }) })).not.toBe(id);
		expect(changed({ s: role({ zdr: true }) })).not.toBe(id);
		expect(changed({ s: role({ dataCollection: "deny" }) })).not.toBe(id);
		expect(changed({ s: role() }, { armLabel: "y" })).not.toBe(id);
		expect(armIdFromSettings("stock", settings, {})).not.toBe(id);
	});
	test("none hash without roles", () => {
		expect(armIdFromSettings("bling", undefined, {})).toBe("bling:unlabeled:none");
	});
});

describe("example config", () => {
	const mk = (name: string, kind: "scout" | "coder", model: string, upstream: string, sampling: object) => [
		name,
		{ kind, provider: "openrouter", model, upstream, sampling },
	];
	const example = {
		subagents: {
			armLabel: "qwen-fp8",
			active: { scout: "qwen-fp8-scout", coder: "qwen-fp8-coder" },
			roles: Object.fromEntries([
				mk("mercury-3-scout", "scout", "inception/mercury-3", "inception", { temperature: 0.2 }),
				mk("qwen-fp8-scout", "scout", "qwen/qwen3.8-27b", "chutes/fp8", {
					temperature: 0.2,
					top_p: 0.9,
					top_k: 20,
				}),
				mk("qwen-fp16-coder", "coder", "qwen/qwen3.8-27b", "cerebras", { temperature: 0.2, top_p: 0.9 }),
				mk("qwen-fp8-coder", "coder", "qwen/qwen3.8-27b", "chutes/fp8", {
					temperature: 0.2,
					top_p: 0.9,
					top_k: 20,
				}),
			]),
			scripts: { "list-exports": { command: "node", args: ["scripts/list-exports.mjs"], timeoutMs: 30000 } },
		},
	};
	test("passes schema and validation", () => {
		expect(Value.Check(SettingsSchema, example)).toBe(true);
		expect(validateSubagentSettings(example.subagents as SubagentSettings, {})).toEqual([]);
	});
});

describe("documented round-1 arms in LING.md", () => {
	const lingMd = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "LING.md"), "utf-8");
	const block = [...lingMd.matchAll(/```json\n([\s\S]*?)```/g)]
		.map((match) => match[1])
		.find((text) => text.includes('"ling30-scout"'));
	const parsed = block ? (JSON.parse(block) as { subagents: SubagentSettings }) : undefined;

	test("the example parses, passes the schema, and validates against the host table", () => {
		expect(parsed).toBeDefined();
		expect(Value.Check(SettingsSchema, parsed)).toBe(true);
		expect(validateSubagentSettings(parsed?.subagents, {})).toEqual([]);
	});
	test("contains every round-1 role with the documented pin", () => {
		const roles = parsed?.subagents.roles ?? {};
		const pins = Object.fromEntries(Object.entries(roles).map(([name, config]) => [name, config.upstream]));
		expect(pins).toEqual({
			"ling30-scout": "novita",
			"gptoss20-scout": "coreweave/fp4",
			"mercury25-scout": "inception",
			"qwen-fp8-scout": "chutes/fp8",
			"ling-coder-oneshot": "novita",
			"ling-coder-repair2": "novita",
			"glm53-cheap": "open-inference/fp4",
			"glm53-fast": "wafer/nvfp4",
			"dsv4-flash": "baidu/fp8",
			haiku55: "anthropic",
		});
		for (const [name, config] of Object.entries(roles)) {
			if (config.kind === "scout") expect(config.thinking, name).toBe("off");
		}
		expect(roles["ling-coder-oneshot"]?.budgets?.maxOracleRuns).toBe(1);
		expect(roles["ling-coder-repair2"]?.budgets?.maxOracleRuns).toBe(3);
	});
	test("every documented role resolves against a catalog model and carries the strict pin", () => {
		for (const [name, config] of Object.entries(parsed?.subagents.roles ?? {})) {
			const settings: SubagentSettings = { roles: { [name]: config }, active: { [config.kind]: name } };
			const resolved = resolveRole(config.kind, settings, source(baseModel()), {});
			expect((resolved.model.compat as { openRouterRouting: object }).openRouterRouting).toMatchObject({
				allow_fallbacks: false,
				require_parameters: true,
			});
		}
	});
});
