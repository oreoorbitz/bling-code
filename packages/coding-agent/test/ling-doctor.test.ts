import { describe, expect, test } from "vitest";
import {
	diagnoseLingConfiguration,
	diagnoseLingOpenRouterConfiguration,
	diagnoseSubagentConfiguration,
} from "../src/cli/ling-doctor.ts";
import type { ModelsJsonProvider } from "../src/core/model-config.ts";

function provider(overrides: Partial<ModelsJsonProvider> = {}): ModelsJsonProvider {
	return {
		baseUrl: "https://openrouter.ai/api/v1",
		apiKey: "$LING_API_KEY",
		api: "openai-completions",
		compat: { thinkingFormat: "openrouter" },
		models: [
			{
				id: "inclusionai/ling-3.1-flash",
				reasoning: true,
				contextWindow: 262144,
				maxTokens: 32768,
			},
		],
		...overrides,
	};
}

function messagesAt(diagnostics: ReturnType<typeof diagnoseLingConfiguration>, level: "warning" | "error"): string {
	return diagnostics
		.filter((diagnostic) => diagnostic.level === level)
		.map((diagnostic) => diagnostic.message)
		.join("\n");
}

describe("diagnoseLingConfiguration", () => {
	test("accepts a complete configuration without exposing the credential", () => {
		const secret = "sk-test-do-not-display";
		const diagnostics = diagnoseLingConfiguration({
			provider: provider(),
			defaultProvider: "ling",
			defaultModel: "inclusionai/ling-3.1-flash",
			env: { LING_API_KEY: secret },
		});

		expect(messagesAt(diagnostics, "error")).toBe("");
		expect(messagesAt(diagnostics, "warning")).toBe("");
		expect(JSON.stringify(diagnostics)).not.toContain(secret);
		expect(JSON.stringify(diagnostics)).toContain("ling/inclusionai/ling-3.1-flash");
	});

	test("accepts omitted limits using the models.json defaults", () => {
		const configured = provider({
			models: [{ id: "Ling-3.1-flash", reasoning: true }],
		});
		const diagnostics = diagnoseLingConfiguration({
			provider: configured,
			defaultProvider: "ling",
			defaultModel: "Ling-3.1-flash",
			env: { LING_API_KEY: "set" },
		});
		expect(messagesAt(diagnostics, "error")).toBe("");
	});

	test("requires configuration and a credential reference", () => {
		expect(messagesAt(diagnoseLingConfiguration({}), "error")).toContain('No "ling" provider');
		expect(messagesAt(diagnoseLingConfiguration({ provider: provider({ apiKey: undefined }) }), "error")).toContain(
			"no credential reference",
		);
	});

	test("reports a missing environment credential by variable name only", () => {
		const diagnostics = diagnoseLingConfiguration({ provider: provider(), env: {} });
		expect(messagesAt(diagnostics, "error")).toContain("LING_API_KEY is missing or empty");
	});

	test("rejects unsafe endpoints and impossible model limits", () => {
		const configured = provider({
			baseUrl: "https://user:password@example.test/v1?key=secret",
			models: [{ id: "Ling-3.1-flash", reasoning: true, contextWindow: 4096, maxTokens: 8192 }],
		});
		const errors = messagesAt(diagnoseLingConfiguration({ provider: configured }), "error");
		expect(errors).toContain("must not contain credentials");
		expect(errors).toContain("maxTokens exceeds contextWindow");
		expect(errors).not.toContain("password");
		expect(errors).not.toContain("key=secret");
	});

	test("detects dialect and exact-default drift", () => {
		const configured = provider({ compat: { thinkingFormat: "openai" } });
		const errors = messagesAt(
			diagnoseLingConfiguration({
				provider: configured,
				defaultProvider: "ling",
				defaultModel: "Ling-3.0-flash",
				env: { LING_API_KEY: "set" },
			}),
			"error",
		);
		expect(errors).toContain("reasoning dialect");
		expect(errors).toContain("not present in the provider configuration");
	});

	test("warns rather than fails when another provider is selected explicitly", () => {
		const diagnostics = diagnoseLingConfiguration({
			provider: provider(),
			defaultProvider: "other",
			defaultModel: "other-model",
			env: { LING_API_KEY: "set" },
		});
		expect(messagesAt(diagnostics, "error")).toBe("");
		expect(messagesAt(diagnostics, "warning")).toContain('saved default provider is "other"');
	});

	test("warns about literal credentials without repeating them", () => {
		const diagnostics = diagnoseLingConfiguration({ provider: provider({ apiKey: "sk-literal-secret" }) });
		expect(messagesAt(diagnostics, "warning")).toContain("stores a literal credential");
		expect(JSON.stringify(diagnostics)).not.toContain("sk-literal-secret");
	});
});

describe("diagnoseLingOpenRouterConfiguration", () => {
	const catalogModelIds = new Set(["inclusionai/ling-3.1-flash", "inclusionai/ling-3.0-flash"]);
	const configured: ModelsJsonProvider = {
		modelOverrides: {
			"inclusionai/ling-3.1-flash": {
				samplingParams: { temperature: 1, top_p: 0.95, top_k: 20 },
				compat: { openRouterRouting: { only: ["novita"], allow_fallbacks: false } },
			},
		},
	};

	test("accepts a configured default without exposing the credential", () => {
		const secret = "sk-or-do-not-display";
		const diagnostics = diagnoseLingOpenRouterConfiguration({
			provider: configured,
			defaultProvider: "openrouter",
			defaultModel: "inclusionai/ling-3.1-flash",
			env: { OPENROUTER_API_KEY: secret },
			hasStoredCredential: false,
			catalogModelIds,
		});
		expect(messagesAt(diagnostics, "error")).toBe("");
		expect(messagesAt(diagnostics, "warning")).toBe("");
		expect(JSON.stringify(diagnostics)).not.toContain(secret);
		expect(JSON.stringify(diagnostics)).toContain("openrouter/inclusionai/ling-3.1-flash");
		expect(JSON.stringify(diagnostics)).toContain("Upstream: novita (no fallbacks)");
	});

	test("warns when the upstream is unpinned or allows fallbacks", () => {
		const input = {
			defaultProvider: "openrouter",
			defaultModel: "inclusionai/ling-3.1-flash",
			env: { OPENROUTER_API_KEY: "set" },
			hasStoredCredential: false,
			catalogModelIds,
		};
		const unpinned = diagnoseLingOpenRouterConfiguration({
			...input,
			provider: { modelOverrides: { "inclusionai/ling-3.1-flash": { samplingParams: { temperature: 1 } } } },
		});
		expect(messagesAt(unpinned, "warning")).toContain("No upstream pin");
		const fallback = diagnoseLingOpenRouterConfiguration({
			...input,
			provider: {
				modelOverrides: {
					"inclusionai/ling-3.1-flash": { compat: { openRouterRouting: { order: ["novita"] } } },
				},
			},
		});
		expect(messagesAt(fallback, "warning")).toContain("allows fallbacks");
	});

	test("accepts a stored OpenRouter login instead of the environment variable", () => {
		const diagnostics = diagnoseLingOpenRouterConfiguration({
			provider: configured,
			defaultProvider: "openrouter",
			defaultModel: "inclusionai/ling-3.1-flash",
			env: {},
			hasStoredCredential: true,
			catalogModelIds,
		});
		expect(messagesAt(diagnostics, "error")).toBe("");
	});

	test("reports a missing credential and points out the misspelled variable name", () => {
		const errors = messagesAt(
			diagnoseLingOpenRouterConfiguration({
				env: { OPEN_ROUTER_API_KEY: "set" },
				hasStoredCredential: false,
				catalogModelIds,
			}),
			"error",
		);
		expect(errors).toContain("Set OPENROUTER_API_KEY or run /login");
		expect(errors).toContain("expected name is OPENROUTER_API_KEY");
	});

	test("rejects a Ling default missing from the catalog", () => {
		const errors = messagesAt(
			diagnoseLingOpenRouterConfiguration({
				defaultProvider: "openrouter",
				defaultModel: "inclusionai/ling-3.0-tiny",
				env: { OPENROUTER_API_KEY: "set" },
				hasStoredCredential: false,
				catalogModelIds,
			}),
			"error",
		);
		expect(errors).toContain("not in the OpenRouter model catalog");
	});

	test("warns about missing or non-vendor sampling", () => {
		const missing = diagnoseLingOpenRouterConfiguration({
			env: { OPENROUTER_API_KEY: "set" },
			hasStoredCredential: false,
			catalogModelIds,
		});
		expect(messagesAt(missing, "warning")).toContain("No saved default");
		expect(messagesAt(missing, "warning")).toContain("No sampling override for inclusionai/ling-3.1-flash");

		const drifted = diagnoseLingOpenRouterConfiguration({
			provider: {
				modelOverrides: {
					"inclusionai/ling-3.0-flash": { samplingParams: { temperature: 1, top_p: 0.95, top_k: 20 } },
				},
			},
			defaultProvider: "openrouter",
			defaultModel: "inclusionai/ling-3.0-flash",
			env: { OPENROUTER_API_KEY: "set" },
			hasStoredCredential: false,
			catalogModelIds,
		});
		expect(messagesAt(drifted, "warning")).toContain("differs from the vendor recommendation");
	});

	test("warns rather than fails when a non-Ling model is the saved default", () => {
		const diagnostics = diagnoseLingOpenRouterConfiguration({
			defaultProvider: "openrouter",
			defaultModel: "minimax/minimax-m3.1-flash",
			env: { OPENROUTER_API_KEY: "set" },
			hasStoredCredential: false,
			catalogModelIds,
		});
		expect(messagesAt(diagnostics, "error")).toBe("");
		expect(messagesAt(diagnostics, "warning")).toContain("not a Ling model");
	});
});

describe("diagnoseSubagentConfiguration", () => {
	const role = { kind: "scout" as const, provider: "openrouter", model: "inception/mercury-3" };

	test("reports nothing without roles", () => {
		expect(diagnoseSubagentConfiguration(undefined, {})).toEqual([]);
	});

	test("flags an invalid role", () => {
		const diagnostics = diagnoseSubagentConfiguration({ roles: { "bad-scout": role } }, {});
		expect(messagesAt(diagnostics, "error")).toContain("must name an upstream pin");
	});

	test("accepts a valid configuration", () => {
		const diagnostics = diagnoseSubagentConfiguration(
			{
				roles: { "mercury-scout": { ...role, upstream: "inception", sampling: { temperature: 0.2 } } },
				active: { scout: "mercury-scout" },
			},
			{},
		);
		expect(messagesAt(diagnostics, "error")).toBe("");
		expect(diagnostics[0]?.message).toContain("scout=mercury-scout");
	});
});
