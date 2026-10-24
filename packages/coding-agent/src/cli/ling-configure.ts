import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import type { ModelsJsonProvider } from "../core/model-config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export const LING_PROVIDER_ID = "ling";
export const LING_DEFAULT_CONTEXT_WINDOW = 262144;
export const LING_DEFAULT_MAX_TOKENS = 32768;

const PROFILES = {
	"3.1": {
		modelId: "Ling-3.1-flash",
		name: "Ling 3.1 Flash",
		temperature: 1.0,
	},
	"3.0": {
		modelId: "Ling-3.0-flash",
		name: "Ling 3.0 Flash",
		temperature: 0.6,
	},
} as const;

const DIALECTS = {
	ling: "ling",
	"chat-template": "qwen-chat-template",
	openrouter: "openrouter",
} as const;

export type LingProfile = keyof typeof PROFILES;
export type LingDialect = keyof typeof DIALECTS;

export interface LingConfigureOptions {
	baseUrl: string;
	profile: LingProfile;
	modelId?: string;
	apiKeyEnv: string;
	dialect: LingDialect;
	contextWindow: number;
	maxTokens: number;
	force: boolean;
}

export function printLingConfigureHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} configure`)} - configure an explicit OpenAI-compatible Ling endpoint

${chalk.bold("Usage:")}
  ${APP_NAME} configure --base-url <url> [options]

${chalk.bold("Options:")}
  --base-url <url>          Required endpoint base URL, for example http://localhost:30000/v1
  --profile <version>       Model profile: 3.1 (default) or 3.0
  --model-id <id>           Served model ID (default: Ling-3.1-flash or Ling-3.0-flash)
  --api-key-env <name>      Environment variable holding the API key (default: LING_API_KEY)
  --dialect <name>          Reasoning request format: chat-template (default), ling, or openrouter
  --context-window <tokens> Served context window (default: 262144, not the 1M architectural maximum)
  --max-tokens <tokens>     Maximum output tokens (default: 32768)
  --force                   Replace an existing ${LING_PROVIDER_ID} provider configuration
  --help, -h                Show this help

No hosted endpoint is selected implicitly. The API key itself is never written to models.json.
Use ${chalk.bold("--dialect ling")} for first-party Ant Ling, ${chalk.bold("chat-template")} for vLLM/SGLang,
or ${chalk.bold("openrouter")} for OpenRouter.`);
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

export function parseLingConfigureArgs(args: string[]): LingConfigureOptions | { help: true } {
	let baseUrl: string | undefined;
	let profile: LingProfile = "3.1";
	let modelId: string | undefined;
	let apiKeyEnv = "LING_API_KEY";
	let dialect: LingDialect = "chat-template";
	let contextWindow = LING_DEFAULT_CONTEXT_WINDOW;
	let maxTokens = LING_DEFAULT_MAX_TOKENS;
	let force = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--force") {
			force = true;
			continue;
		}
		const valueFlags = [
			"--base-url",
			"--profile",
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
				if (value !== "3.1" && value !== "3.0") throw new Error("--profile must be 3.1 or 3.0");
				profile = value;
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

	if (!baseUrl) throw new Error("--base-url is required; Ling Code does not choose a hosted endpoint implicitly");
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
	const selectedModelId = modelId ?? PROFILES[profile].modelId;
	if (!selectedModelId.trim() || /[\r\n\0]/.test(selectedModelId)) throw new Error("--model-id must be non-empty");
	const modelGeneration = selectedModelId.match(/ling[-_/]?3\.([01])(?:[-_./]|$)/i)?.[1];
	if (modelGeneration && `3.${modelGeneration}` !== profile) {
		throw new Error(
			`--model-id indicates Ling 3.${modelGeneration} but --profile is ${profile}; select the matching profile`,
		);
	}

	return {
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

export async function configureLing(
	options: LingConfigureOptions,
	settingsManager: SettingsManager,
	modelsPath: string,
): Promise<{ modelId: string; modelsPath: string }> {
	const config = await loadModelsFile(modelsPath);
	if (config.providers[LING_PROVIDER_ID] && !options.force) {
		throw new Error(`Provider "${LING_PROVIDER_ID}" already exists in ${modelsPath}; use --force to replace it`);
	}
	const profile = PROFILES[options.profile];
	const modelId = options.modelId ?? profile.modelId;
	const provider: ModelsJsonProvider = {
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
				id: modelId,
				name: profile.name,
				reasoning: true,
				input: ["text"],
				contextWindow: options.contextWindow,
				maxTokens: options.maxTokens,
				samplingParams: {
					temperature: profile.temperature,
					top_p: 0.95,
					top_k: 20,
				},
			},
		],
	};
	config.providers[LING_PROVIDER_ID] = provider;
	const directory = dirname(modelsPath);
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(directory, `.${basename(modelsPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporaryPath, modelsPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
	settingsManager.setDefaultModelAndProvider(LING_PROVIDER_ID, modelId);
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		const detail = settingsErrors.map(({ error }) => error.message).join("; ");
		throw new Error(`${modelsPath} was updated, but settings could not be saved: ${detail}`);
	}
	return { modelId, modelsPath };
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
		console.log(`Configured ${LING_PROVIDER_ID}/${result.modelId} in ${result.modelsPath}`);
		console.log(`Set the API key through $${options.apiKeyEnv}; no credential was written to disk.`);
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exitCode = 1;
	}
	return true;
}
