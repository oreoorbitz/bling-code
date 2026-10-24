import { describe, expect, test } from "vitest";
import { diagnoseLingConfiguration } from "../src/cli/ling-doctor.ts";
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
