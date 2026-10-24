import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ProjectActionStore } from "../core/learning/action-store.ts";
import {
	DEFAULT_DECIDER_MIN_PROBABILITY,
	DEFAULT_DECIDER_MODEL,
	DEFAULT_DECIDER_PROVIDER,
	DEFAULT_DECIDER_THRESHOLD_CHARS,
	DEFAULT_REVIEW_BATCH_ACTIONS,
	DEFAULT_REVIEW_MAX_INPUT_TOKENS,
	ImprovementProposalStore,
	resetImprovementCursor,
	runImprovementReview,
	skipImprovementBatch,
} from "../core/learning/improvement.ts";
import { ProjectMemoryStore, renderProjectMemory } from "../core/learning/memory-store.ts";
import { findInitialModel, resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export function printLingLearningHelp(): void {
	console.log(`Project-local learning and review

Usage:
  ling learning status
  ling learning actions [query]
  ling learning memory [add <text> | remove <id>]
  ling learning list
  ling learning show <proposal-id>
  ling learning approve <proposal-id>
  ling learning reject <proposal-id>
  ling learning cursor <reset|skip>
  ling improve [--decider] [--decider-shadow] [--model <provider/model>]

Actions and provider-returned reasoning stay in .ling/learning. Memory and skill
proposals require explicit approval. --decider enables OpenRouter Decider only
when review state exceeds its threshold; --decider-shadow records the gate but
still runs Ling for calibration. OPENROUTER_API_KEY stays external.`);
}

function argumentValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function runImprove(args: string[], cwd: string, agentDir: string): Promise<void> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const settings = settingsManager.getSettings();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const requestedModel = argumentValue(args, "--model");
	if (args.includes("--model") && !requestedModel) throw new Error("--model requires provider/model");
	let model: Model<Api> | undefined;
	if (requestedModel) {
		const resolved = resolveCliModel({ cliModel: requestedModel, modelRuntime });
		if (resolved.error) throw new Error(resolved.error);
		model = resolved.model;
	} else {
		model = (
			await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: settings.defaultProvider,
				defaultModelId: settings.defaultModel,
				defaultThinkingLevel: settings.defaultThinkingLevel,
				modelThinkingLevels: settings.modelThinkingLevels,
				modelRuntime,
			})
		).model;
	}
	if (!model) throw new Error("No review model is available; configure Ling or pass --model explicitly");
	const result = await runImprovementReview({
		cwd,
		runtime: modelRuntime,
		model,
		useDecider:
			args.includes("--decider") ||
			args.includes("--decider-shadow") ||
			settings.learning?.decider?.enabled === true,
		deciderShadow: args.includes("--decider-shadow"),
		deciderProvider: settings.learning?.decider?.provider ?? DEFAULT_DECIDER_PROVIDER,
		deciderModel: settings.learning?.decider?.model ?? DEFAULT_DECIDER_MODEL,
		deciderThresholdChars: settings.learning?.decider?.thresholdChars ?? DEFAULT_DECIDER_THRESHOLD_CHARS,
		deciderMinProbability: settings.learning?.decider?.minProbability ?? DEFAULT_DECIDER_MIN_PROBABILITY,
		maxBatchActions: settings.learning?.review?.batchActions ?? DEFAULT_REVIEW_BATCH_ACTIONS,
		maxInputTokens: settings.learning?.review?.maxInputTokens ?? DEFAULT_REVIEW_MAX_INPUT_TOKENS,
	});
	if (result.status === "empty") {
		console.log("No new project actions; no model request was made.");
	} else if (result.status === "gated") {
		console.log(
			`Decider gated ${result.reviewId} (probability ${result.decision.probability.toFixed(3)}); no Ling review request was made.`,
		);
	} else {
		console.log(`${result.status === "cached" ? "Reused" : "Created"} ${result.reviewId}`);
		console.log(`${result.proposals.length} proposal(s); inspect with: ling learning list`);
		for (const proposal of result.proposals)
			console.log(`${proposal.id} ${proposal.kind}/${proposal.operation}: ${proposal.title}`);
	}
}

export async function runLingLearningCommand(
	args: string[],
	context: { cwd: string; agentDir: string },
): Promise<boolean> {
	if (args[0] !== "learning" && args[0] !== "improve") return false;
	if (args.includes("--help") || args.includes("-h")) {
		printLingLearningHelp();
		return true;
	}
	try {
		if (args[0] === "improve") {
			await runImprove(args.slice(1), context.cwd, context.agentDir);
			return true;
		}
		const [subcommand = "status", ...rest] = args.slice(1);
		if (subcommand === "actions") {
			const store = await ProjectActionStore.open(context.cwd);
			const query = rest.join(" ");
			const results = query ? await store.search(query) : (await store.list()).slice(-20).reverse();
			for (const action of results)
				console.log(`${action.actionId}\t${action.kind}\t${new Date(action.timestamp).toISOString()}`);
			if (results.length === 0) console.log("No matching project actions.");
			return true;
		}
		if (subcommand === "memory") {
			const store = await ProjectMemoryStore.open(context.cwd);
			const [operation, ...content] = rest;
			if (operation === "add") {
				const text = content.join(" ").trim();
				if (!text) throw new Error("ling learning memory add requires text");
				const { entry, duplicate } = await store.add(text, "user");
				console.log(`${duplicate ? "Already present" : "Added"} ${entry.id}`);
			} else if (operation === "remove") {
				if (!content[0]) throw new Error("ling learning memory remove requires an ID");
				console.log(`Removed ${(await store.remove(content[0])).id}`);
			} else {
				console.log(renderProjectMemory(await store.list()) || "Project memory is empty.");
			}
			return true;
		}
		if (subcommand === "cursor") {
			const operation = rest[0];
			if (operation === "reset") {
				console.log(
					(await resetImprovementCursor(context.cwd)) ? "Review cursor reset." : "No review cursor to reset.",
				);
			} else if (operation === "skip") {
				const settings = SettingsManager.create(context.cwd, context.agentDir).getSettings();
				const skipped = await skipImprovementBatch({
					cwd: context.cwd,
					maxBatchActions: settings.learning?.review?.batchActions ?? DEFAULT_REVIEW_BATCH_ACTIONS,
					maxInputTokens: settings.learning?.review?.maxInputTokens ?? DEFAULT_REVIEW_MAX_INPUT_TOKENS,
				});
				console.log(
					skipped.actionCount
						? `Skipped ${skipped.actionCount} action(s) through ${skipped.lastActionId}; no model request was made.`
						: "No new project actions to skip.",
				);
			} else {
				throw new Error("ling learning cursor requires reset or skip");
			}
			return true;
		}
		const proposalStore = await ImprovementProposalStore.open(context.cwd);
		if (subcommand === "list" || subcommand === "pending") {
			const proposals = proposalStore
				.list()
				.filter((proposal) => subcommand === "list" || proposal.status === "pending");
			for (const proposal of proposals) {
				console.log(
					`${proposal.id}\t${proposal.status}\t${proposal.kind}/${proposal.operation}\t${proposal.title}`,
				);
			}
			if (proposals.length === 0) console.log("No proposals.");
			return true;
		}
		if (subcommand === "show") {
			if (!rest[0]) throw new Error("ling learning show requires a proposal ID");
			console.log(JSON.stringify(proposalStore.get(rest[0]), null, 2));
			return true;
		}
		if (subcommand === "approve" || subcommand === "reject") {
			if (!rest[0]) throw new Error(`ling learning ${subcommand} requires a proposal ID`);
			const proposal =
				subcommand === "approve" ? await proposalStore.approve(rest[0]) : await proposalStore.reject(rest[0]);
			console.log(`${proposal.status}: ${proposal.id}`);
			if (subcommand === "approve" && proposal.kind === "skill")
				console.log("Restart or /reload sessions to load the skill.");
			return true;
		}
		if (subcommand !== "status") throw new Error(`Unknown learning subcommand: ${subcommand}`);
		const [actions, memory] = await Promise.all([
			ProjectActionStore.open(context.cwd),
			ProjectMemoryStore.open(context.cwd),
		]);
		console.log(`Project learning directory: ${actions.paths.root}`);
		console.log(`Actions: ${(await actions.list()).length}`);
		console.log(`Memories: ${(await memory.list()).length}`);
		console.log(
			`Pending proposals: ${proposalStore.list().filter((proposal) => proposal.status === "pending").length}`,
		);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	return true;
}
