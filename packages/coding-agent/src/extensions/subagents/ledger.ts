import { createHash } from "node:crypto";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import {
	createMessageAction,
	createSubagentAction,
	createSubagentVerdictAction,
	type LearningSubagentActionInput,
	type LearningSubagentVerdictActionInput,
	ProjectActionStore,
} from "../../core/learning/action-store.ts";
import type { Settings } from "../../core/settings-manager.ts";
import { ENV_BENCHMARK_RUN_ID } from "../../core/subagents/roles.ts";
import type { SubagentRunSummary } from "../../core/subagents/types.ts";

/** Action ID of the assistant message that contains `toolCallId`, recomputed from the session branch. */
function findParentActionId(
	ctx: ExtensionContext,
	sessionId: string,
	toolCallId: string,
	harnessProfile: "bling" | "stock",
): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (!entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)) continue;
		return createMessageAction(ctx.cwd, sessionId, entry.message, harnessProfile).actionId;
	}
	return undefined;
}

/** Map a finished subagent run to a ledger record input. */
export function subagentActionInput(
	summary: SubagentRunSummary,
	ctx: ExtensionContext,
	toolCallId: string,
	settings: Settings,
): LearningSubagentActionInput {
	const sessionId = ctx.sessionManager.getSessionId();
	const harnessProfile = settings.harness?.profile === "stock" ? "stock" : "bling";
	const parentActionId = findParentActionId(ctx, sessionId, toolCallId, harnessProfile);
	const benchmarkRunId = process.env[ENV_BENCHMARK_RUN_ID] || undefined;
	const oracle = summary.coder?.oracle;
	const diff = summary.coder?.diff;
	return {
		runId: summary.runId,
		role: summary.kind,
		roleName: summary.roleName,
		roleIdentityHash: summary.roleIdentityHash,
		provider: summary.provider,
		model: summary.model,
		...(summary.requestedUpstream === undefined ? {} : { requestedUpstream: summary.requestedUpstream }),
		servedUpstreams: summary.servedUpstreams,
		outcome: summary.outcome,
		...(summary.error === undefined ? {} : { error: summary.error }),
		usage: summary.usage,
		turns: summary.turns,
		startedAt: summary.startedAt,
		durationMs: summary.durationMs,
		...(summary.coder ? { targetPath: summary.coder.path } : {}),
		...(oracle
			? {
					oracle: {
						command: oracle.command,
						args: oracle.args,
						exitCode: oracle.exitCode,
						passed: oracle.passed,
						timedOut: oracle.timedOut,
						durationMs: oracle.durationMs,
					},
				}
			: {}),
		...(diff === undefined ? {} : { diffSha256: createHash("sha256").update(diff).digest("hex") }),
		...(summary.coder ? { diffLines: summary.coder.diffLines } : {}),
		...(summary.coder?.escalation ? { escalationReason: summary.coder.escalation.reason } : {}),
		scopeViolations: summary.scopeViolations,
		...(summary.timeToFirstToolCallMs === undefined ? {} : { timeToFirstToolCallMs: summary.timeToFirstToolCallMs }),
		failedToolCalls: summary.failedToolCalls,
		parentSessionId: sessionId,
		parentToolCallId: toolCallId,
		...(parentActionId === undefined ? {} : { parentActionId }),
		...(benchmarkRunId === undefined ? {} : { benchmarkRunId }),
		harnessProfile,
	};
}

/** onRunComplete hook: one `subagent` ledger record per run, when the learning action log is on. */
export async function recordSubagentRun(
	summary: SubagentRunSummary,
	ctx: ExtensionContext,
	toolCallId: string,
	settings: Settings,
): Promise<void> {
	if (settings.learning?.enabled === false || settings.learning?.actionLog === false) return;
	const input = subagentActionInput(summary, ctx, toolCallId, settings);
	await ProjectActionStore.open(ctx.cwd).append(createSubagentAction(ctx.cwd, input));
}

export interface SubagentVerdictInput {
	runId: string;
	verdict: "accepted" | "rejected";
	reason: string;
	role: "scout" | "coder";
	roleName: string;
}

/** Map Ling's verdict on a subagent result to a ledger record input. */
export function subagentVerdictActionInput(
	verdict: SubagentVerdictInput,
	ctx: ExtensionContext,
	toolCallId: string,
	settings: Settings,
): LearningSubagentVerdictActionInput {
	const benchmarkRunId = process.env[ENV_BENCHMARK_RUN_ID] || undefined;
	return {
		...verdict,
		decidedAt: Date.now(),
		parentSessionId: ctx.sessionManager.getSessionId(),
		parentToolCallId: toolCallId,
		...(benchmarkRunId === undefined ? {} : { benchmarkRunId }),
		harnessProfile: settings.harness?.profile === "stock" ? "stock" : "bling",
	};
}

/** onVerdict hook: one `subagent_verdict` ledger record per decision, when the learning action log is on. */
export async function recordSubagentVerdict(
	verdict: SubagentVerdictInput,
	ctx: ExtensionContext,
	toolCallId: string,
	settings: Settings,
): Promise<void> {
	if (settings.learning?.enabled === false || settings.learning?.actionLog === false) return;
	const input = subagentVerdictActionInput(verdict, ctx, toolCallId, settings);
	await ProjectActionStore.open(ctx.cwd).append(createSubagentVerdictAction(ctx.cwd, input));
}
