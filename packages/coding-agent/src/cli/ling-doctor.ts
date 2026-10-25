import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { readStoredCredential } from "../core/auth-storage.ts";
import {
	isLingModelRef,
	LING_DEFAULT_PROFILE,
	LING_ENDPOINT_PROVIDER_ID,
	LING_OPENROUTER_PROVIDER_ID,
	LING_PROFILES,
} from "../core/ling-models.ts";
import { ModelConfig, type ModelsJsonProvider } from "../core/model-config.ts";
import { SettingsManager, type SubagentSettings } from "../core/settings-manager.ts";
import { activeRoleNames, validateSubagentSettings } from "../core/subagents/roles.ts";

export interface LingDoctorDiagnostic {
	level: "ok" | "warning" | "error";
	message: string;
}

interface LingDoctorInput {
	provider?: ModelsJsonProvider;
	defaultProvider?: string;
	defaultModel?: string;
	env?: Record<string, string | undefined>;
}

function isPositiveInteger(value: number | undefined): boolean {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

interface LingOpenRouterDoctorInput {
	/** The openrouter entry from models.json, if any. */
	provider?: ModelsJsonProvider;
	defaultProvider?: string;
	defaultModel?: string;
	env?: Record<string, string | undefined>;
	hasStoredCredential: boolean;
	catalogModelIds: ReadonlySet<string>;
}

/** Credential-blind, offline checks for Ling served through the built-in OpenRouter provider. */
export function diagnoseLingOpenRouterConfiguration(input: LingOpenRouterDoctorInput): LingDoctorDiagnostic[] {
	const diagnostics: LingDoctorDiagnostic[] = [];
	const add = (level: LingDoctorDiagnostic["level"], message: string): void => {
		diagnostics.push({ level, message });
	};
	const defaultLingModelId = LING_PROFILES[LING_DEFAULT_PROFILE].openRouterModelId;

	if (input.env?.OPENROUTER_API_KEY?.trim()) {
		add("ok", "Credential: $OPENROUTER_API_KEY is set (value not displayed).");
	} else if (input.hasStoredCredential) {
		add("ok", "Credential: an OpenRouter login is stored in auth.json (value not displayed).");
	} else {
		const misnamed = input.env?.OPEN_ROUTER_API_KEY?.trim()
			? " OPEN_ROUTER_API_KEY is set, but the expected name is OPENROUTER_API_KEY."
			: "";
		add("error", `No OpenRouter credential. Set OPENROUTER_API_KEY or run /login.${misnamed}`);
	}

	let modelId: string;
	if (input.defaultModel && isLingModelRef(input.defaultProvider, input.defaultModel)) {
		modelId = input.defaultModel;
		if (!input.catalogModelIds.has(modelId)) {
			add("error", `The saved Ling default "${modelId}" is not in the OpenRouter model catalog.`);
		} else {
			add("ok", `Saved default: ${LING_OPENROUTER_PROVIDER_ID}/${modelId}`);
		}
	} else if (!input.defaultProvider) {
		modelId = defaultLingModelId;
		add(
			"warning",
			`No saved default. ${APP_NAME} selects ${LING_OPENROUTER_PROVIDER_ID}/${modelId} when OpenRouter is authenticated; run "${APP_NAME} configure" to save it with vendor sampling.`,
		);
	} else {
		add(
			"warning",
			`The saved default is "${input.defaultProvider}/${input.defaultModel ?? ""}", not a Ling model. Ling will not be selected implicitly.`,
		);
		return diagnostics;
	}

	const sampling = input.provider?.modelOverrides?.[modelId]?.samplingParams;
	const profile = Object.values(LING_PROFILES).find((candidate) => candidate.openRouterModelId === modelId);
	if (!sampling) {
		add(
			"warning",
			`No sampling override for ${modelId}; requests use provider defaults. Run "${APP_NAME} configure".`,
		);
	} else {
		add("ok", `Sampling: ${JSON.stringify(sampling)}`);
		const recommended = profile?.samplingParams;
		if (
			recommended &&
			Object.entries(recommended).some(([key, value]) => (sampling as Record<string, unknown>)[key] !== value)
		) {
			add("warning", `Sampling differs from the vendor recommendation ${JSON.stringify(recommended)}.`);
		}
	}

	const routing = input.provider?.modelOverrides?.[modelId]?.compat?.openRouterRouting;
	const pinned = routing?.only?.length ? routing.only : routing?.order;
	if (!pinned?.length) {
		add(
			"warning",
			`No upstream pin for ${modelId}; OpenRouter may split requests across hosts with different quantization. Run "${APP_NAME} configure".`,
		);
	} else if (routing?.allow_fallbacks !== false) {
		add("warning", `Upstream ${pinned.join(", ")} allows fallbacks to other hosts.`);
	} else {
		add("ok", `Upstream: ${pinned.join(", ")} (no fallbacks)`);
	}
	return diagnostics;
}

/** Credential-blind, offline checks for an explicitly configured self-hosted Ling endpoint. */
export function diagnoseLingConfiguration(input: LingDoctorInput): LingDoctorDiagnostic[] {
	const diagnostics: LingDoctorDiagnostic[] = [];
	const add = (level: LingDoctorDiagnostic["level"], message: string): void => {
		diagnostics.push({ level, message });
	};
	const provider = input.provider;
	if (!provider) {
		add(
			"error",
			`No "${LING_ENDPOINT_PROVIDER_ID}" provider is configured. Run "${APP_NAME} configure --base-url <url>".`,
		);
		return diagnostics;
	}

	if (!provider.baseUrl) {
		add("error", "The Ling provider has no baseUrl.");
	} else {
		try {
			const url = new URL(provider.baseUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				add("error", "The Ling baseUrl must use http or https.");
			} else if (url.username || url.password || url.search || url.hash) {
				add("error", "The Ling baseUrl must not contain credentials, a query, or a fragment.");
			} else {
				add("ok", `Endpoint: ${url.origin}${url.pathname.replace(/\/+$/, "")}`);
			}
		} catch {
			add("error", "The Ling baseUrl is not a valid absolute URL.");
		}
	}

	if (provider.api !== "openai-completions") {
		add("error", 'The Ling provider api must be "openai-completions".');
	}
	const thinkingFormat = provider.compat?.thinkingFormat;
	if (thinkingFormat !== "ling" && thinkingFormat !== "qwen-chat-template" && thinkingFormat !== "openrouter") {
		add("error", "The Ling reasoning dialect must be ling, qwen-chat-template, or openrouter.");
	} else {
		add("ok", `Reasoning dialect: ${thinkingFormat}`);
	}

	const models = provider.models ?? [];
	if (models.length === 0) {
		add("error", "The Ling provider has no models.");
	}
	const modelIds = new Set<string>();
	for (const model of models) {
		if (!model.id.trim()) add("error", "A Ling model has an empty ID.");
		if (modelIds.has(model.id)) add("error", `Duplicate Ling model ID: ${model.id}`);
		modelIds.add(model.id);
		const contextWindow = model.contextWindow ?? 128000;
		const maxTokens = model.maxTokens ?? 16384;
		if (!isPositiveInteger(contextWindow)) {
			add("error", `Model ${model.id}: contextWindow must be a positive integer.`);
		}
		if (!isPositiveInteger(maxTokens)) {
			add("error", `Model ${model.id}: maxTokens must be a positive integer.`);
		}
		if (isPositiveInteger(contextWindow) && isPositiveInteger(maxTokens) && maxTokens > contextWindow) {
			add("error", `Model ${model.id}: maxTokens exceeds contextWindow.`);
		}
		if (!model.reasoning) add("warning", `Model ${model.id}: reasoning is disabled in its model metadata.`);
	}
	if (models.length > 0) add("ok", `Configured models: ${models.map((model) => model.id).join(", ")}`);

	if (!provider.apiKey) {
		add("error", "The Ling provider has no credential reference.");
	} else if (provider.apiKey.startsWith("$")) {
		const envName = provider.apiKey.slice(1);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
			add("error", "The Ling credential environment-variable reference is invalid.");
		} else if (!input.env?.[envName]?.trim()) {
			add("error", `Credential environment variable ${envName} is missing or empty.`);
		} else {
			add("ok", `Credential reference: $${envName} is set (value not displayed).`);
		}
	} else if (provider.apiKey.startsWith("!")) {
		add("warning", "The Ling credential uses an external command; doctor does not execute it.");
	} else {
		add(
			"warning",
			"The Ling provider stores a literal credential. Replace it with an environment reference such as $LING_API_KEY.",
		);
	}

	if (input.defaultProvider !== LING_ENDPOINT_PROVIDER_ID) {
		add(
			"warning",
			input.defaultProvider
				? `The saved default provider is "${input.defaultProvider}", not "${LING_ENDPOINT_PROVIDER_ID}". Ling will not be selected implicitly.`
				: `No saved default selects "${LING_ENDPOINT_PROVIDER_ID}". Select the model explicitly or run "${APP_NAME} configure".`,
		);
	} else if (!input.defaultModel) {
		add("error", "The saved default selects Ling but has no model ID.");
	} else if (!modelIds.has(input.defaultModel)) {
		add(
			"error",
			`The saved Ling default model "${input.defaultModel}" is not present in the provider configuration.`,
		);
	} else {
		add("ok", `Saved default: ${LING_ENDPOINT_PROVIDER_ID}/${input.defaultModel}`);
	}

	return diagnostics;
}

/** Offline checks for the `subagents` settings. Reports nothing when no roles are configured. */
export function diagnoseSubagentConfiguration(
	settings: SubagentSettings | undefined,
	env: NodeJS.ProcessEnv = process.env,
): LingDoctorDiagnostic[] {
	if (!settings?.roles || Object.keys(settings.roles).length === 0) return [];
	const errors = validateSubagentSettings(settings, env);
	if (errors.length > 0) return errors.map((message) => ({ level: "error" as const, message }));
	const active = Object.entries(activeRoleNames(settings, env)).map(([kind, name]) => `${kind}=${name}`);
	return [
		{
			level: "ok",
			message: `Subagent roles: ${Object.keys(settings.roles).length} defined, active ${active.length > 0 ? active.join(", ") : "none"}`,
		},
	];
}

export function printLingDoctorHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} doctor`)} - check Ling configuration without network access

${chalk.bold("Usage:")}
  ${APP_NAME} doctor

For OpenRouter, checks the credential, the saved Ling default against the model catalog, and the
sampling override. For a self-hosted endpoint, checks the endpoint, reasoning dialect, model limits,
credential reference, and exact saved model selection. Subagent role settings are validated too. Credential values are never displayed and no
API request is made.`);
}

export async function runLingDoctorCommand(
	args: string[],
	context: { cwd: string; agentDir: string },
): Promise<boolean> {
	if (args[0] !== "doctor") return false;
	try {
		if (args.length > 1) {
			if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
				printLingDoctorHelp();
				return true;
			}
			throw new Error(`Unknown doctor option: ${args[1]}`);
		}
		const modelsPath = join(context.agentDir, "models.json");
		const modelConfig = await ModelConfig.load(modelsPath);
		const configError = modelConfig.getError();
		const settings = SettingsManager.create(context.cwd, context.agentDir, { projectTrusted: false });
		const defaultProvider = settings.getDefaultProvider();
		const defaultModel = settings.getDefaultModel();
		const endpointProvider = modelConfig.getProvider(LING_ENDPOINT_PROVIDER_ID);
		const checkEndpoint =
			defaultProvider === LING_ENDPOINT_PROVIDER_ID ||
			(endpointProvider !== undefined && !isLingModelRef(defaultProvider, defaultModel));
		const diagnostics = configError
			? [{ level: "error" as const, message: configError }]
			: checkEndpoint
				? diagnoseLingConfiguration({ provider: endpointProvider, defaultProvider, defaultModel, env: process.env })
				: diagnoseLingOpenRouterConfiguration({
						provider: modelConfig.getProvider(LING_OPENROUTER_PROVIDER_ID),
						defaultProvider,
						defaultModel,
						env: process.env,
						hasStoredCredential:
							readStoredCredential(LING_OPENROUTER_PROVIDER_ID, join(context.agentDir, "auth.json")) !==
							undefined,
						catalogModelIds: new Set(getBuiltinModels(LING_OPENROUTER_PROVIDER_ID).map((model) => model.id)),
					});
		diagnostics.push(...diagnoseSubagentConfiguration(settings.getSettings().subagents));
		// Reading the project file is safe; it is only inspected, never applied, here.
		const projectSubagents = SettingsManager.create(context.cwd, context.agentDir).getProjectSettings().subagents;
		if (projectSubagents?.scripts && Object.keys(projectSubagents.scripts).length > 0) {
			diagnostics.push({
				level: "warning",
				message:
					"Project settings define subagents.scripts; they are ignored. Define scout scripts in global settings.",
			});
		}
		for (const diagnostic of diagnostics) {
			const label = diagnostic.level === "ok" ? "OK" : diagnostic.level === "warning" ? "WARN" : "FAIL";
			const color =
				diagnostic.level === "ok" ? chalk.green : diagnostic.level === "warning" ? chalk.yellow : chalk.red;
			console.log(color(`${label} ${diagnostic.message}`));
		}
		console.log(`Checked ${modelsPath}; no network request was made.`);
		if (diagnostics.some((diagnostic) => diagnostic.level === "error")) process.exitCode = 1;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exitCode = 1;
	}
	return true;
}
