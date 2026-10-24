import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import {
	configureLing,
	LING_DEFAULT_CONTEXT_WINDOW,
	LING_DEFAULT_MAX_TOKENS,
	type LingEndpointConfigureOptions,
	parseLingConfigureArgs,
} from "../src/cli/ling-configure.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function parse(args: string[]) {
	const result = parseLingConfigureArgs(args);
	if ("help" in result) throw new Error("Expected configure options");
	return result;
}

function parseEndpoint(args: string[]): LingEndpointConfigureOptions {
	const result = parse(args);
	if (result.target !== "endpoint") throw new Error("Expected endpoint options");
	return result;
}

describe("parseLingConfigureArgs", () => {
	test("defaults to Ling 3.1 Flash on OpenRouter", () => {
		expect(parse([])).toEqual({ target: "openrouter", profile: "3.1", upstream: "novita" });
	});

	test("selects Ling 3.0 and 3.0 VL profiles explicitly", () => {
		expect(parse(["--profile", "3.0"])).toEqual({ target: "openrouter", profile: "3.0", upstream: "novita" });
		expect(parse(["--profile", "3.0-vl"])).toEqual({
			target: "openrouter",
			profile: "3.0-vl",
			upstream: "deepinfra",
		});
		expect(() => parse(["--profile", "3.0-tiny"])).toThrow("--profile must be 3.1, 3.0, or 3.0-vl");
	});

	test("pins an explicit OpenRouter upstream and rejects it for a self-hosted endpoint", () => {
		expect(parse(["--upstream", "deepinfra/fp4"])).toMatchObject({ upstream: "deepinfra/fp4" });
		expect(() => parse(["--upstream", "Novita AI"])).toThrow("--upstream must be an OpenRouter provider slug");
		expect(() => parse(["--base-url", "http://localhost:30000/v1", "--upstream", "novita"])).toThrow(
			"--upstream applies only to OpenRouter",
		);
	});

	test("rejects self-hosted endpoint options without --base-url", () => {
		expect(() => parse(["--dialect", "chat-template"])).toThrow("--dialect applies only to a self-hosted endpoint");
		expect(() => parse(["--force"])).toThrow("--force applies only to a self-hosted endpoint");
	});

	test("uses the conservative Ling 3.1 profile for a self-hosted endpoint", () => {
		const options = parse(["--base-url", "http://localhost:30000/v1/"]);
		expect(options).toEqual({
			target: "endpoint",
			baseUrl: "http://localhost:30000/v1",
			profile: "3.1",
			modelId: "Ling-3.1-flash",
			apiKeyEnv: "LING_API_KEY",
			dialect: "chat-template",
			contextWindow: LING_DEFAULT_CONTEXT_WINDOW,
			maxTokens: LING_DEFAULT_MAX_TOKENS,
			force: false,
		});
	});

	test("keeps Ling 3.0 as an explicit endpoint profile", () => {
		const options = parseEndpoint([
			"--base-url",
			"https://openrouter.ai/api/v1",
			"--profile",
			"3.0",
			"--model-id",
			"inclusionai/ling-3.0-flash",
			"--dialect",
			"openrouter",
		]);
		expect(options.profile).toBe("3.0");
		expect(options.modelId).toBe("inclusionai/ling-3.0-flash");
		expect(options.dialect).toBe("openrouter");
	});

	test("rejects credentials in the endpoint URL", () => {
		expect(() => parse(["--base-url", "https://key@example.test/v1"])).toThrow("must not contain credentials");
	});

	test("rejects a model ID from a different Ling generation than the profile", () => {
		expect(() =>
			parse(["--base-url", "http://localhost:30000/v1", "--model-id", "inclusionai/ling-3.0-flash"]),
		).toThrow("indicates Ling 3.0 but --profile is 3.1");
		expect(
			parseEndpoint(["--base-url", "http://localhost:30000/v1", "--model-id", "private-deployment"]).modelId,
		).toBe("private-deployment");
	});

	test("rejects a vision model ID with a text profile and vice versa", () => {
		const base = ["--base-url", "http://localhost:30000/v1"];
		expect(() => parse([...base, "--profile", "3.0", "--model-id", "inclusionai/ling-3.0-flash-vl"])).toThrow(
			"is a vision model but --profile is 3.0",
		);
		expect(() => parse([...base, "--profile", "3.0-vl", "--model-id", "inclusionai/ling-3.0-flash"])).toThrow(
			"is not a vision model but --profile is 3.0-vl",
		);
		expect(parseEndpoint([...base, "--profile", "3.0-vl"]).modelId).toBe("Ling-3.0-flash-vl");
	});

	test("rejects a malformed endpoint with an actionable error", () => {
		expect(() => parse(["--base-url", "localhost:30000/v1"])).toThrow(
			"--base-url must be an absolute http or https URL",
		);
	});

	test("rejects an output limit larger than the served context", () => {
		expect(() =>
			parse(["--base-url", "http://localhost:30000/v1", "--context-window", "4096", "--max-tokens", "8192"]),
		).toThrow("--max-tokens must not exceed --context-window");
	});
});

describe("configureLing on OpenRouter", () => {
	test("stores vendor sampling as an override and selects the built-in Ling model", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ling-configure-openrouter-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					existing: { baseUrl: "http://localhost:9000/v1", models: [] },
					openrouter: {
						headers: { "X-Title": "bling" },
						modelOverrides: {
							"inclusionai/ling-3.1-flash": {
								name: "Ling (renamed)",
								samplingParams: { temperature: 0.2 },
								compat: { supportsStrictMode: false },
							},
							"other/model": { name: "Other" },
						},
					},
				},
			}),
		);
		const settings = SettingsManager.create(dir, dir);

		const result = await configureLing(parse([]), settings, modelsPath);

		expect(result).toMatchObject({ provider: "openrouter", modelId: "inclusionai/ling-3.1-flash" });
		const config = JSON.parse(await readFile(modelsPath, "utf8"));
		expect(config.providers.existing).toBeDefined();
		expect(config.providers.openrouter).toEqual({
			headers: { "X-Title": "bling" },
			modelOverrides: {
				"inclusionai/ling-3.1-flash": {
					name: "Ling (renamed)",
					samplingParams: { temperature: 1, top_p: 0.95, top_k: 20 },
					compat: {
						supportsStrictMode: false,
						openRouterRouting: { only: ["novita"], allow_fallbacks: false },
					},
				},
				"other/model": { name: "Other" },
			},
		});
		const reloaded = SettingsManager.create(dir, dir);
		expect(reloaded.getDefaultProvider()).toBe("openrouter");
		expect(reloaded.getDefaultModel()).toBe("inclusionai/ling-3.1-flash");
	});

	test("applies the override to the built-in catalog model", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ling-configure-openrouter-runtime-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");

		await configureLing(parse(["--profile", "3.0-vl"]), SettingsManager.create(dir, dir), modelsPath);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
		const model = runtime.getModel("openrouter", "inclusionai/ling-3.0-flash-vl");
		expect(model?.input).toContain("image");
		expect(model?.samplingParams).toEqual({ temperature: 1, top_p: 0.95, top_k: 20 });
		expect(model?.compat).toMatchObject({
			thinkingFormat: "openrouter",
			openRouterRouting: { only: ["deepinfra"], allow_fallbacks: false },
		});
	});
});

describe("configureLing on a self-hosted endpoint", () => {
	test("writes an externalized credential and selects the exact configured model", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ling-configure-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		await writeFile(
			modelsPath,
			JSON.stringify({ providers: { existing: { baseUrl: "http://localhost:9000/v1", models: [] } } }),
		);
		const settings = SettingsManager.create(dir, dir);
		const options = parse(["--base-url", "http://localhost:30000/v1"]);

		const result = await configureLing(options, settings, modelsPath);

		expect(result.modelId).toBe("Ling-3.1-flash");
		const config = JSON.parse(await readFile(modelsPath, "utf8"));
		expect(config.providers.existing).toBeDefined();
		expect(config.providers.ling).toMatchObject({
			baseUrl: "http://localhost:30000/v1",
			apiKey: "$LING_API_KEY",
			api: "openai-completions",
			compat: {
				maxTokensField: "max_tokens",
				thinkingFormat: "qwen-chat-template",
			},
		});
		expect(config.providers.ling.models[0]).toMatchObject({
			id: "Ling-3.1-flash",
			contextWindow: 262144,
			maxTokens: 32768,
			samplingParams: { temperature: 1, top_p: 0.95, top_k: 20 },
		});
		expect(JSON.stringify(config)).not.toContain("secret");
		const reloaded = SettingsManager.create(dir, dir);
		expect(reloaded.getDefaultProvider()).toBe("ling");
		expect(reloaded.getDefaultModel()).toBe("Ling-3.1-flash");
	});

	test("uses different sampling for Ling 3.0 without changing the model ID implicitly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ling-configure-30-"));
		tempDirs.push(dir);
		const settings = SettingsManager.create(dir, dir);
		const options = parse([
			"--base-url",
			"http://localhost:30000/v1",
			"--profile",
			"3.0",
			"--model-id",
			"inclusionAI/Ling-3.0-flash",
		]);

		await configureLing(options, settings, join(dir, "models.json"));

		const config = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
		expect(config.providers.ling.models[0].id).toBe("inclusionAI/Ling-3.0-flash");
		expect(config.providers.ling.models[0].samplingParams.temperature).toBe(0.6);
		expect(settings.getDefaultModel()).toBe("inclusionAI/Ling-3.0-flash");
	});

	test("reports settings persistence failures instead of claiming complete configuration", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ling-configure-settings-error-"));
		tempDirs.push(dir);
		const settings = SettingsManager.fromStorage({
			withLock: (_scope, fn) => {
				const next = fn(undefined);
				if (next !== undefined) throw new Error("disk full");
			},
		});

		await expect(
			configureLing(parse(["--base-url", "http://localhost:30000/v1"]), settings, join(dir, "models.json")),
		).rejects.toThrow("models.json was updated, but settings could not be saved");
	});

	test("does not overwrite an existing Ling endpoint without force", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ling-configure-force-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { ling: { baseUrl: "http://old.test/v1" } } }));
		const settings = SettingsManager.create(dir, dir);

		await expect(configureLing(parse(["--base-url", "http://new.test/v1"]), settings, modelsPath)).rejects.toThrow(
			"use --force",
		);
		expect(JSON.parse(await readFile(modelsPath, "utf8")).providers.ling.baseUrl).toBe("http://old.test/v1");
	});
});
