import { Type } from "typebox";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { createMessageAction, createToolAction, ProjectActionStore } from "../../core/learning/action-store.ts";
import {
	DEFAULT_DECIDER_MIN_PROBABILITY,
	DEFAULT_DECIDER_MODEL,
	DEFAULT_DECIDER_PROVIDER,
	DEFAULT_DECIDER_THRESHOLD_CHARS,
	DEFAULT_REVIEW_BATCH_ACTIONS,
	DEFAULT_REVIEW_MAX_INPUT_TOKENS,
	type ImprovementProposal,
	ImprovementProposalStore,
	runImprovementReview,
	stageMemoryProposal,
} from "../../core/learning/improvement.ts";
import { ProjectMemoryStore, renderProjectMemory } from "../../core/learning/memory-store.ts";
import { harnessProfileOf } from "../../core/settings-schema.ts";
import { armIdFromSettings, ENV_BENCHMARK_RUN_ID } from "../../core/subagents/roles.ts";

/** Benchmark run that launched this process, read at hook time so tests and children see the live env. */
function readBenchmarkRunId(): string | undefined {
	return process.env[ENV_BENCHMARK_RUN_ID] || undefined;
}

function readLearningSettings(pi: ExtensionAPI) {
	const settings = pi.getSettings().learning;
	return {
		enabled: settings?.enabled !== false,
		actionLog: settings?.actionLog !== false,
		memory: settings?.memory !== false,
		harnessProfile: harnessProfileOf(pi.getSettings()),
		armId: armIdFromSettings(
			harnessProfileOf(pi.getSettings()),
			pi.getSettings().subagents,
			process.env,
			pi.getSettings().longSession,
		),
		decider: settings?.decider,
		review: settings?.review,
	};
}

function proposalText(proposal: ImprovementProposal): string {
	return `${proposal.id} [${proposal.status}] ${proposal.kind}/${proposal.operation}: ${proposal.title}\n${proposal.rationale}`;
}

export function createProjectLearningExtension(): ExtensionFactory {
	return (pi) => {
		let actions: ProjectActionStore | undefined;
		let memory: ProjectMemoryStore | undefined;
		const toolArgs = new Map<string, unknown>();
		const assistantActionsByToolCall = new Map<string, string>();

		const getActions = async (cwd: string) => {
			if (!actions || actions.cwd !== cwd) actions = await ProjectActionStore.open(cwd);
			return actions;
		};
		const getMemory = async (cwd: string) => {
			memory = await ProjectMemoryStore.open(cwd);
			return memory;
		};

		pi.on("session_start", async (_event, ctx) => {
			const settings = readLearningSettings(pi);
			if (!settings.enabled) return;
			if (settings.actionLog) await getActions(ctx.cwd);
			if (settings.memory) await getMemory(ctx.cwd);
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const settings = readLearningSettings(pi);
			if (settings.harnessProfile === "stock") {
				// Control arm: no curated memory in the prompt and no project_memory tool declaration.
				event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
					(name) => name !== "project_memory",
				);
				return;
			}
			if (!settings.enabled || !settings.memory || !ctx.isProjectTrusted()) return;
			const rendered = renderProjectMemory(await (await getMemory(ctx.cwd)).list());
			if (rendered) event.systemPromptOptions.sections.project_memory = rendered;
		});

		pi.on("message_end", async (event, ctx) => {
			const settings = readLearningSettings(pi);
			if (!settings.enabled || !settings.actionLog) return;
			const store = await getActions(ctx.cwd);
			const action = createMessageAction(
				ctx.cwd,
				ctx.sessionManager.getSessionId(),
				event.message,
				settings.harnessProfile,
				readBenchmarkRunId(),
				settings.armId,
			);
			await store.append(action);
			if (event.message.role === "assistant") {
				for (const part of event.message.content) {
					if (part.type === "toolCall") assistantActionsByToolCall.set(part.id, action.actionId);
				}
			}
		});

		pi.on("tool_execution_start", async (event) => {
			const settings = readLearningSettings(pi);
			if (!settings.enabled || !settings.actionLog) return;
			toolArgs.set(event.toolCallId, event.args);
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			const settings = readLearningSettings(pi);
			const args = toolArgs.get(event.toolCallId);
			toolArgs.delete(event.toolCallId);
			if (!settings.enabled || !settings.actionLog) return;
			const store = await getActions(ctx.cwd);
			const parentActionId = assistantActionsByToolCall.get(event.toolCallId);
			const benchmarkRunId = readBenchmarkRunId();
			await store.append(
				createToolAction(ctx.cwd, ctx.sessionManager.getSessionId(), {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args,
					result: event.result,
					isError: event.isError,
					harnessProfile: settings.harnessProfile,
					armId: settings.armId,
					...(benchmarkRunId === undefined ? {} : { benchmarkRunId }),
					...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
					...(parentActionId === undefined ? {} : { parentActionId }),
					...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
				}),
			);
		});

		pi.on("session_shutdown", async () => {
			toolArgs.clear();
			assistantActionsByToolCall.clear();
			await actions?.flush();
		});

		pi.registerTool({
			name: "project_memory",
			label: "Project memory",
			description:
				"Read project-local curated memory or stage an add/patch/remove proposal. Writes stay pending until the user approves them with /learning approve. Never stores a global or user profile.",
			promptSnippet: "read or propose changes to bounded project-specific memory",
			promptGuidelines: [
				"Use project_memory only for durable project facts and lessons; do not store secrets, transient task state, or user profiling.",
				"Memory changes are proposals: never claim they were saved until the user approves them.",
			],
			parameters: Type.Union([
				Type.Object({ operation: Type.Literal("list") }),
				Type.Object({ operation: Type.Literal("add"), content: Type.String() }),
				Type.Object({
					operation: Type.Literal("patch"),
					targetId: Type.String(),
					oldText: Type.String(),
					newText: Type.String(),
				}),
				Type.Object({ operation: Type.Literal("remove"), targetId: Type.String() }),
			]),
			execute: async (_id, params, _signal, _update, ctx) => {
				if (params.operation === "list") {
					const entries = await (await getMemory(ctx.cwd)).list();
					return {
						content: [{ type: "text", text: renderProjectMemory(entries) || "Project memory is empty." }],
						details: { entries },
					};
				}
				const proposal = await stageMemoryProposal(ctx.cwd, params);
				return {
					content: [
						{
							type: "text",
							text: `Staged ${proposal.id}. It is not active yet; ask the user to run /learning approve ${proposal.id}.`,
						},
					],
					details: { proposal },
				};
			},
		});

		pi.registerCommand("learning", {
			description: "Inspect project memory/actions and review pending improvements",
			handler: async (args, ctx) => {
				const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (subcommand === "actions") {
					const query = rest.join(" ");
					const store = await getActions(ctx.cwd);
					const results = query ? await store.search(query) : (await store.list()).slice(-20).reverse();
					ctx.ui.notify(
						results.length
							? results
									.map(
										(action) =>
											`${action.actionId} ${action.kind} ${new Date(action.timestamp).toISOString()}`,
									)
									.join("\n")
							: "No matching project actions.",
					);
					return;
				}
				if (subcommand === "memory") {
					const entries = await (await getMemory(ctx.cwd)).list();
					ctx.ui.notify(renderProjectMemory(entries) || "Project memory is empty.");
					return;
				}
				const proposals = await ImprovementProposalStore.open(ctx.cwd);
				if (subcommand === "pending" || subcommand === "list") {
					const pending = proposals.list().filter((proposal) => proposal.status === "pending");
					ctx.ui.notify(pending.length ? pending.map(proposalText).join("\n\n") : "No pending improvements.");
					return;
				}
				if (subcommand === "show") {
					ctx.ui.notify(JSON.stringify(proposals.get(rest[0] ?? ""), null, 2));
					return;
				}
				if (subcommand === "approve" || subcommand === "reject") {
					const proposal =
						subcommand === "approve"
							? await proposals.approve(rest[0] ?? "")
							: await proposals.reject(rest[0] ?? "");
					ctx.ui.notify(proposalText(proposal));
					if (subcommand === "approve" && proposal.kind === "memory") memory = undefined;
					if (subcommand === "approve" && proposal.kind === "skill") {
						ctx.ui.notify("Project skill applied. Run /reload to load it in this session.");
					}
					return;
				}
				const [actionStore, memoryStore] = await Promise.all([getActions(ctx.cwd), getMemory(ctx.cwd)]);
				const all = await actionStore.list();
				ctx.ui.notify(
					`Project learning: ${all.length} actions, ${(await memoryStore.list()).length} memories, ${proposals.list().filter((p) => p.status === "pending").length} pending proposals\n${actionStore.paths.root}`,
				);
			},
		});

		pi.registerCommand("improve", {
			description:
				"Review new project actions; use '/improve decider' for gating or '/improve decider-shadow' for calibration",
			handler: async (args, ctx) => {
				if (!ctx.model) {
					ctx.ui.notify("No chat model is selected for improvement review.", "error");
					return;
				}
				const settings = readLearningSettings(pi);
				const mode = args.trim();
				const deciderShadow = mode === "decider-shadow";
				const useDecider = mode === "decider" || deciderShadow || settings.decider?.enabled === true;
				const result = await runImprovementReview({
					cwd: ctx.cwd,
					runtime: ctx.modelRegistry,
					model: ctx.model,
					useDecider,
					deciderShadow,
					deciderProvider: settings.decider?.provider ?? DEFAULT_DECIDER_PROVIDER,
					deciderModel: settings.decider?.model ?? DEFAULT_DECIDER_MODEL,
					deciderThresholdChars: settings.decider?.thresholdChars ?? DEFAULT_DECIDER_THRESHOLD_CHARS,
					deciderMinProbability: settings.decider?.minProbability ?? DEFAULT_DECIDER_MIN_PROBABILITY,
					maxBatchActions: settings.review?.batchActions ?? DEFAULT_REVIEW_BATCH_ACTIONS,
					maxInputTokens: settings.review?.maxInputTokens ?? DEFAULT_REVIEW_MAX_INPUT_TOKENS,
				});
				if (result.status === "empty") ctx.ui.notify("No new project actions; no model request was made.");
				else if (result.status === "gated") {
					ctx.ui.notify(
						`Decider gated this batch (probability ${result.decision.probability.toFixed(3)}). No Ling review request was made.`,
					);
				} else {
					ctx.ui.notify(
						`${result.status === "cached" ? "Reused" : "Created"} ${result.reviewId}: ${result.proposals.length} proposals. Review with /learning pending.`,
					);
				}
			},
		});
	};
}

export default createProjectLearningExtension();
