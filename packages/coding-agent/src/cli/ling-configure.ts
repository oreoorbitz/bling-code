import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import {
	LING_DEFAULT_PROFILE,
	LING_ENDPOINT_PROVIDER_ID,
	LING_OPENROUTER_PROVIDER_ID,
	LING_PROFILES,
	type LingProfile,
} from "../core/ling-models.ts";
import type { ModelsJsonProvider } from "../core/model-config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export const LING_DEFAULT_CONTEXT_WINDOW = 262144;
export const LING_DEFAULT_MAX_TOKENS = 32768;

const DIALECTS = {
	ling: "ling",
	"chat-template": "qwen-chat-template",
	openrouter: "openrouter",
} as const;

export type LingDialect = keyof typeof DIALECTS;

/** Ling through OpenRouter's built-in provider. Model metadata comes from the catalog. */
export interface LingOpenRouterConfigureOptions {
	target: "openrouter";
	profile: LingProfile;
	/** OpenRouter provider slug that exclusively serves the model, for example "novita" or "deepinfra/fp4". */
	upstream: string;
}

/** Ling through an explicit self-hosted OpenAI-compatible endpoint, such as vLLM or SGLang. */
export interface LingEndpointConfigureOptions {
	target: "endpoint";
	baseUrl: string;
	profile: LingProfile;
	modelId: string;
	apiKeyEnv: string;
	dialect: LingDialect;
	contextWindow: number;
	maxTokens: number;
	force: boolean;
}

export type LingConfigureOptions = LingOpenRouterConfigureOptions | LingEndpointConfigureOptions;

export function printLingConfigureHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} configure`)} - select a Ling model on OpenRouter or a self-hosted endpoint

${chalk.bold("Usage:")}
  ${APP_NAME} configure [--profile <version>]
  ${APP_NAME} configure --base-url <url> [options]

${chalk.bold("Options:")}
  --profile <version>       Model profile: 3.1 (default), 3.0, or 3.0-vl
  --upstream <slug>         OpenRouter provider to pin, without fallbacks (default: novita; deepinfra for 3.0-vl)
  --help, -h                Show this help

${chalk.bold("Self-hosted endpoint options:")}
  --base-url <url>          Endpoint base URL, for example http://localhost:30000/v1
  --model-id <id>           Served model ID (default: Ling-3.1-flash, Ling-3.0-flash, or Ling-3.0-flash-vl)
  --api-key-env <name>      Environment variable holding the API key (default: LING_API_KEY)
  --dialect <name>          Reasoning request format: chat-template (default), ling, or openrouter
  --context-window <tokens> Served context window (default: 262144, not the 1M architectural maximum)
  --max-tokens <tokens>     Maximum output tokens (default: 32768)
  --force                   Replace an existing ${LING_ENDPOINT_PROVIDER_ID} provider configuration

Without --base-url, the profile selects OpenRouter's ${chalk.bold("inclusionai/ling-*")} model and stores the vendor
sampling parameters and upstream pin as a models.json override. Authenticate with OPENROUTER_API_KEY or /login.
The API key itself is never written to models.json.`);
}

function readOptionValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parsePositiveInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
	return parsed;
}

const ENDPOINT_ONLY_FLAGS = [
	"--model-id",
	"--api-key-env",
	"--dialect",
	"--context-window",
	"--max-tokens",
	"--force",
] as const;

export function parseLingConfigureArgs(args: string[]): LingConfigureOptions | { help: true } {
	let baseUrl: string | undefined;
	let profile: LingProfile = LING_DEFAULT_PROFILE;
	let modelId: string | undefined;
	let apiKeyEnv = "LING_API_KEY";
	let dialect: LingDialect = "chat-template";
	let contextWindow = LING_DEFAULT_CONTEXT_WINDOW;
	let maxTokens = LING_DEFAULT_MAX_TOKENS;
	let force = false;
	let upstream: string | undefined;
	const endpointFlags: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") return { help: true };
		if ((ENDPOINT_ONLY_FLAGS as readonly string[]).includes(arg)) endpointFlags.push(arg);
		if (arg === "--force") {
			force = true;
			continue;
		}
		const valueFlags = [
			"--base-url",
			"--profile",
			"--upstream",
			"--model-id",
			"--api-key-env",
			"--dialect",
			"--context-window",
			"--max-tokens",
		];
		if (!valueFlags.includes(arg)) throw new Error(`Unknown configure option: ${arg}`);
		const value = readOptionValue(args, i, arg);
		i++;
		switch (arg) {
			case "--base-url":
				baseUrl = value;
				break;
			case "--profile":
				if (!Object.hasOwn(LING_PROFILES, value)) throw new Error("--profile must be 3.1, 3.0, or 3.0-vl");
				profile = value as LingProfile;
				break;
			case "--upstream":
				if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?$/.test(value)) {
					throw new Error("--upstream must be an OpenRouter provider slug such as novita or deepinfra/fp4");
				}
				upstream = value;
				break;
			case "--model-id":
				modelId = value;
				break;
			case "--api-key-env":
				apiKeyEnv = value;
				break;
			case "--dialect":
				if (value !== "ling" && value !== "chat-template" && value !== "openrouter") {
					throw new Error("--dialect must be ling, chat-template, or openrouter");
				}
				dialect = value;
				break;
			case "--context-window":
				contextWindow = parsePositiveInteger(value, arg);
				break;
			case "--max-tokens":
				maxTokens = parsePositiveInteger(value, arg);
				break;
		}
	}

	if (!baseUrl) {
		if (endpointFlags.length > 0) {
			throw new Error(`${endpointFlags[0]} applies only to a self-hosted endpoint; add --base-url <url>`);
		}
		return { target: "openrouter", profile, upstream: upstream ?? LING_PROFILES[profile].openRouterUpstream };
	}
	if (upstream) throw new Error("--upstream applies only to OpenRouter; remove --base-url");
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("--base-url must be an absolute http or https URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("--base-url must be an absolute http or https URL");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("--base-url must not contain credentials, a query, or a fragment");
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
		throw new Error("--api-key-env must be a valid environment variable name");
	}
	if (maxTokens > contextWindow) throw new Error("--max-tokens must not exceed --context-window");
	const selectedModelId = modelId ?? LING_PROFILES[profile].endpointModelId;
	if (!selectedModelId.trim() || /[\r\n\0]/.test(selectedModelId)) throw new Error("--model-id must be non-empty");
	const modelGeneration = selectedModelId.match(/ling[-_/]?3\.([01])(?:[-_./]|$)/i)?.[1];
	if (modelGeneration && !profile.startsWith(`3.${modelGeneration}`)) {
		throw new Error(
			`--model-id indicates Ling 3.${modelGeneration} but --profile is ${profile}; select the matching profile`,
		);
	}
	const modelIsVision = /[-_]vl(?:[-_./]|$)/i.test(selectedModelId);
	if (modelGeneration && modelIsVision !== (profile === "3.0-vl")) {
		throw new Error(
			`--model-id ${modelIsVision ? "is" : "is not"} a vision model but --profile is ${profile}; select the matching profile`,
		);
	}

	return {
		target: "endpoint",
		baseUrl: baseUrl.replace(/\/+$/, ""),
		profile,
		modelId: selectedModelId,
		apiKeyEnv,
		dialect,
		contextWindow,
		maxTokens,
		force,
	};
}

interface ModelsFile {
	$schema?: string;
	providers: Record<string, ModelsJsonProvider>;
}

async function loadModelsFile(modelsPath: string): Promise<ModelsFile> {
	let source: string;
	try {
		source = await readFile(modelsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(source)));
	} catch (error) {
		throw new Error(`Cannot update invalid ${modelsPath}: ${error instanceof Error ? error.message : error}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Cannot update ${modelsPath}: expected a JSON object`);
	}
	const providers = (parsed as { providers?: unknown }).providers;
	if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
		throw new Error(`Cannot update ${modelsPath}: expected a providers object`);
	}
	return { ...(parsed as { $schema?: string }), providers: providers as Record<string, ModelsJsonProvider> };
}

function createEndpointProvider(options: LingEndpointConfigureOptions): ModelsJsonProvider {
	const profile = LING_PROFILES[options.profile];
	return {
		name: "Ling (configured endpoint)",
		baseUrl: options.baseUrl,
		apiKey: `$${options.apiKeyEnv}`,
		api: "openai-completions",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			thinkingFormat: DIALECTS[options.dialect],
		},
		models: [
			{
				id: options.modelId,
				name: profile.name,
				reasoning: true,
				input: [...profile.input],
				contextWindow: options.contextWindow,
				maxTokens: options.maxTokens,
				samplingParams: { ...profile.samplingParams },
			},
		],
	};
}

/**
 * Adds vendor sampling and an exclusive upstream pin to the built-in OpenRouter model, preserving other
 * overrides, other compat fields, and provider settings.
 */
function withOpenRouterProfile(
	existing: ModelsJsonProvider | undefined,
	options: LingOpenRouterConfigureOptions,
): ModelsJsonProvider {
	const { openRouterModelId, samplingParams } = LING_PROFILES[options.profile];
	const override = existing?.modelOverrides?.[openRouterModelId];
	return {
		...existing,
		modelOverrides: {
			...existing?.modelOverrides,
			[openRouterModelId]: {
				...override,
				samplingParams: { ...samplingParams },
				compat: {
					...override?.compat,
					openRouterRouting: { only: [options.upstream], allow_fallbacks: false },
				},
			},
		},
	};
}

export async function configureLing(
	options: LingConfigureOptions,
	settingsManager: SettingsManager,
	modelsPath: string,
): Promise<{ provider: string; modelId: string; modelsPath: string }> {
	const config = await loadModelsFile(modelsPath);
	let provider: string;
	let modelId: string;
	if (options.target === "openrouter") {
		provider = LING_OPENROUTER_PROVIDER_ID;
		modelId = LING_PROFILES[options.profile].openRouterModelId;
		config.providers[provider] = withOpenRouterProfile(config.providers[provider], options);
	} else {
		provider = LING_ENDPOINT_PROVIDER_ID;
		modelId = options.modelId;
		if (config.providers[provider] && !options.force) {
			throw new Error(`Provider "${provider}" already exists in ${modelsPath}; use --force to replace it`);
		}
		config.providers[provider] = createEndpointProvider(options);
	}
	const directory = dirname(modelsPath);
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.${basename(modelsPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporaryPath, modelsPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
	settingsManager.setDefaultModelAndProvider(provider, modelId);
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		const detail = settingsErrors.map(({ error }) => error.message).join("; ");
		throw new Error(`${modelsPath} was updated, but settings could not be saved: ${detail}`);
	}
	return { provider, modelId, modelsPath };
}

export async function runLingConfigureCommand(
	args: string[],
	context: { cwd: string; agentDir: string },
): Promise<boolean> {
	if (args[0] !== "configure") return false;
	try {
		const options = parseLingConfigureArgs(args.slice(1));
		if ("help" in options) {
			printLingConfigureHelp();
			return true;
		}
		const modelsPath = join(context.agentDir, "models.json");
		const settingsManager = SettingsManager.create(context.cwd, context.agentDir, { projectTrusted: false });
		const result = await configureLing(options, settingsManager, modelsPath);
		console.log(`Configured ${result.provider}/${result.modelId} in ${result.modelsPath}`);
		console.log(
			options.target === "openrouter"
				? `Pinned to OpenRouter upstream ${options.upstream} without fallbacks. Authenticate with $OPENROUTER_API_KEY or /login; no credential was written to disk.`
				: `Set the API key through $${options.apiKeyEnv}; no credential was written to disk.`,
		);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exitCode = 1;
	}
	return true;
}
