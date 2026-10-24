import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { ModelConfig, type ModelsJsonProvider } from "../core/model-config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { LING_PROVIDER_ID } from "./ling-configure.ts";

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

/** Credential-blind, offline checks for the explicitly configured Ling provider. */
export function diagnoseLingConfiguration(input: LingDoctorInput): LingDoctorDiagnostic[] {
	const diagnostics: LingDoctorDiagnostic[] = [];
	const add = (level: LingDoctorDiagnostic["level"], message: string): void => {
		diagnostics.push({ level, message });
	};
	const provider = input.provider;
	if (!provider) {
		add("error", `No "${LING_PROVIDER_ID}" provider is configured. Run "${APP_NAME} configure --base-url <url>".`);
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

	if (input.defaultProvider !== LING_PROVIDER_ID) {
		add(
			"warning",
			input.defaultProvider
				? `The saved default provider is "${input.defaultProvider}", not "${LING_PROVIDER_ID}". Ling will not be selected implicitly.`
				: `No saved default selects "${LING_PROVIDER_ID}". Select the model explicitly or run "${APP_NAME} configure".`,
		);
	} else if (!input.defaultModel) {
		add("error", "The saved default selects Ling but has no model ID.");
	} else if (!modelIds.has(input.defaultModel)) {
		add(
			"error",
			`The saved Ling default model "${input.defaultModel}" is not present in the provider configuration.`,
		);
	} else {
		add("ok", `Saved default: ${LING_PROVIDER_ID}/${input.defaultModel}`);
	}

	return diagnostics;
}

export function printLingDoctorHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} doctor`)} - check Ling configuration without network access

${chalk.bold("Usage:")}
  ${APP_NAME} doctor

Checks the configured endpoint, reasoning dialect, model limits, credential reference, and exact saved
model selection. Credential values are never displayed and no API request is made.`);
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
		const diagnostics = configError
			? [{ level: "error" as const, message: configError }]
			: diagnoseLingConfiguration({
					provider: modelConfig.getProvider(LING_PROVIDER_ID),
					defaultProvider: settings.getDefaultProvider(),
					defaultModel: settings.getDefaultModel(),
					env: process.env,
				});
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
