import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { upstreamMatches } from "../../core/learning/benchmark-report.ts";
import type { Settings } from "../../core/settings-manager.ts";
import {
	createProjectScope,
	createWriteScope,
	type ProjectScope,
	ScopeError,
} from "../../core/subagents/path-scope.ts";
import { CODER_SYSTEM_PROMPT, SCOUT_SYSTEM_PROMPT } from "../../core/subagents/prompts.ts";
import {
	activeRoleNames,
	type ResolvedRole,
	type RoleKind,
	RoleResolutionError,
	resolveRole,
} from "../../core/subagents/roles.ts";
import { runSubagent, type SubagentRunResult } from "../../core/subagents/runner.ts";
import {
	assembleCoderReport,
	changedPaths,
	countChangedLines,
	createCoderChild,
	createScoutChild,
	type FileSnapshot,
	runAuthoritativeOracle,
	snapshotFile,
	snapshotGitStatus,
	verifyScoutReport,
} from "../../core/subagents/tools.ts";
import type { SubagentOutcome, SubagentRunSummary } from "../../core/subagents/types.ts";
import { recordSubagentRun, recordSubagentVerdict, type SubagentVerdictInput } from "./ledger.ts";

export const SCOUT_TOOL_NAME = "scout";
export const CODE_FILE_TOOL_NAME = "code_file";
export const SUBAGENT_VERDICT_TOOL_NAME = "subagent_verdict";

export const MAX_CONTEXT_CHARS = 8_000;
export const MAX_START_PATHS = 20;
export const MAX_SNIPPET_CHARS = 12_000;
export const MAX_RESULT_CHARS = 12_000;
const MAX_QUESTION_CHARS = 4_000;
const MAX_CHANGE_CHARS = 8_000;
const MAX_ORACLE_ARGS = 50;
const MAX_ORACLE_ARG_CHARS = 1_000;
const MAX_ORACLE_TIMEOUT_MS = 600_000;
const RAW_TEXT_LIMIT_CHARS = 4_000;
const MAX_VERDICT_REASON_CHARS = 1_000;

export type SubagentRunCompleteHook = (
	summary: SubagentRunSummary,
	ctx: ExtensionContext,
	toolCallId: string,
	settings: Settings,
) => void | Promise<void>;

export type SubagentVerdictHook = (
	verdict: SubagentVerdictInput,
	ctx: ExtensionContext,
	toolCallId: string,
	settings: Settings,
) => void | Promise<void>;

export interface SubagentsExtensionOptions {
	/** Called for every `subagent_verdict` call. A failure is returned to the model as an error result. */
	onVerdict?: SubagentVerdictHook;
	/** Called after every run, with the full summary. A failure never fails the tool call; it is attached to details as ledgerWarning. */
	onRunComplete?: SubagentRunCompleteHook;
}

const scoutParameters = Type.Object({
	question: Type.String({ description: "What to find out. One focused question." }),
	context: Type.Optional(
		Type.String({
			description: `Hints or snippets that narrow the search (at most ${MAX_CONTEXT_CHARS} characters).`,
		}),
	),
	startPaths: Type.Optional(
		Type.Array(Type.String(), {
			description: `Project-relative files or directories to start from (at most ${MAX_START_PATHS}).`,
		}),
	),
});

const codeFileParameters = Type.Object({
	path: Type.String({
		description: "The single target file, relative to the project root. Its parent directory must exist.",
	}),
	change: Type.String({ description: "The intended change, specific enough to carry out without further questions." }),
	contract: Type.Optional(
		Type.String({ description: "Interfaces other files rely on (signatures, types, exports) that must not change." }),
	),
	snippets: Type.Optional(
		Type.Array(Type.Object({ path: Type.Optional(Type.String()), text: Type.String() }), {
			description: `Selected context from other files (at most ${MAX_SNIPPET_CHARS} characters in total).`,
		}),
	),
	oracle: Type.Object(
		{
			command: Type.String({ description: "Executable to run. No shell: it is started directly." }),
			args: Type.Array(Type.String(), { description: "Arguments, one array entry each." }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_ORACLE_TIMEOUT_MS })),
		},
		{
			description:
				"The check that decides success. The harness runs it after the coder stops; exit code 0 means pass.",
		},
	),
});

const verdictParameters = Type.Object({
	runId: Type.String({ description: "The runId from the scout or code_file result being judged." }),
	verdict: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")], {
		description:
			"accepted: you used or kept the result (a changed file counts as kept). rejected: you discarded it, redid the work yourself, or reverted the change.",
	}),
	reason: Type.String({ maxLength: MAX_VERDICT_REASON_CHARS, description: "One or two sentences." }),
});

type VerdictParams = Static<typeof verdictParameters>;
type ScoutParams = Static<typeof scoutParameters>;
type CodeFileParams = Static<typeof codeFileParameters>;

const SCOUT_DESCRIPTION = `Delegate a read-only investigation to a cheaper scout model and get structured evidence back.
- The scout cannot edit anything or run arbitrary commands. It uses grep, find, ls, read, and project scripts the user configured.
- You choose the question, not the model. The scout's model, host, and budgets are fixed by configuration.
- The result is JSON: findings (claim, evidence with path and line range, confidence), unresolved questions, a suggested next action, and run metadata. Each evidence range has verified true or false, checked by the harness against the real file. Treat verified false as unreliable.
- The scout never performs the suggested next action and never retries. You decide what to do with the result, including whether to ask again.
- Outcome other than completed means the scout stopped early (no_report, budget_*, timeout, error). Partial text is in rawText.
- Once you have decided whether to use the result, record it with subagent_verdict (runId, accepted or rejected, reason).`;

const CODE_FILE_DESCRIPTION = `Delegate one change to exactly one file to a cheaper one-shot coder model.
- Give the target path, the intended change, the interface contract other files rely on, selected snippets, and an oracle command (argv array, no shell).
- The coder may edit or write only the target file, may run only the oracle (at most once by default), and has one attempt. It never retries.
- After the coder stops, the harness runs the oracle itself. outcome is passed (file changed and oracle exit 0), oracle_failed, no_change, escalated, diff_too_large, or an early stop (error, timeout, budget_*, aborted).
- escalated: the coder stopped on purpose because the task needs more than the target file (scope_expansion), it could not make the change work (unresolved_failure), or the brief was ambiguous (ambiguous_spec). coder.escalation has the detail and the files it needs. Decide yourself what to do; the coder will not retry.
- diff_too_large: the change exceeds the role's maxDiffLines. The file stays as written and the diff is returned; review it or revert.
- A failed run leaves the file as written. The result includes the unified diff, the oracle result, and the coder's uncertainties and interface changes. You decide whether to keep, fix, or revert; the coder will not.
- You choose the task, not the model. The coder's model, host, and budgets are fixed by configuration.
- Once you have decided whether to keep the result, record it with subagent_verdict (runId, accepted or rejected, reason).`;

const VERDICT_DESCRIPTION = `Record whether you accept or reject the result of a scout or code_file call, for benchmark accounting. It changes no file and has no other effect.
- Pass the runId from the result. accepted means you used the result (a changed file counts as kept); rejected means you discarded it, redid the work yourself, or reverted the change.
- Call it once per result after you have decided. A later call for the same runId replaces the earlier verdict.`;

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

function truncateText(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

const ERROR_OUTCOMES: ReadonlySet<SubagentOutcome> = new Set([
	"error",
	"aborted",
	"timeout",
	"budget_turns",
	"budget_tokens",
	"budget_output",
	"budget_context",
	"budget_cost",
]);

/** Compact JSON of the summary for Ling, at most {@link MAX_RESULT_CHARS}. Drops the least useful parts first. */
export function renderSummaryText(summary: SubagentRunSummary): string {
	let text = JSON.stringify(summary);
	if (text.length <= MAX_RESULT_CHARS) return text;
	const reduced: SubagentRunSummary = { ...summary, toolCalls: summary.toolCalls.slice(-10) };
	if (reduced.coder) {
		reduced.coder = {
			...reduced.coder,
			diff: truncateText(reduced.coder.diff, 4_000),
			...(reduced.coder.oracle
				? { oracle: { ...reduced.coder.oracle, outputTail: truncateText(reduced.coder.oracle.outputTail, 1_000) } }
				: {}),
		};
	}
	text = JSON.stringify(reduced);
	if (text.length <= MAX_RESULT_CHARS) return text;
	reduced.toolCalls = [];
	if (reduced.coder) reduced.coder = { ...reduced.coder, diff: truncateText(reduced.coder.diff, 1_000) };
	text = JSON.stringify(reduced);
	return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS - 20)}...[truncated]`;
}

function baseSummary(role: ResolvedRole, runId: string, run: SubagentRunResult, scopeViolations: number) {
	const requested = role.requestedUpstream;
	return {
		runId,
		kind: role.kind,
		roleName: role.name,
		roleIdentityHash: role.identityHash,
		provider: role.config.provider,
		model: role.config.model,
		...(role.requestedUpstream === undefined ? {} : { requestedUpstream: role.requestedUpstream }),
		servedUpstreams: run.servedUpstreams,
		upstreamMismatch:
			requested !== undefined && run.servedUpstreams.some((host) => !upstreamMatches(requested, host)),
		usage: run.usage,
		turns: run.turns,
		startedAt: run.startedAt,
		durationMs: run.durationMs,
		toolCalls: run.toolCalls,
		...(run.timeToFirstToolCallMs === undefined ? {} : { timeToFirstToolCallMs: run.timeToFirstToolCallMs }),
		failedToolCalls: run.failedToolCalls,
		scopeViolations,
		...(run.error === undefined ? {} : { error: run.error }),
	};
}

/** The scout or code_file result with this runId on the session's active branch, read from its tool result details. */
function findRunInBranch(ctx: ExtensionContext, runId: string): { role: RoleKind; roleName: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== SCOUT_TOOL_NAME && entry.message.toolName !== CODE_FILE_TOOL_NAME) continue;
		const details = entry.message.details as { runId?: unknown; kind?: unknown; roleName?: unknown } | undefined;
		if (details?.runId !== runId) continue;
		if ((details.kind !== "scout" && details.kind !== "coder") || typeof details.roleName !== "string") continue;
		return { role: details.kind, roleName: details.roleName };
	}
	return undefined;
}

function resolveRoleOrError(pi: ExtensionAPI, ctx: ExtensionContext, kind: RoleKind): ResolvedRole | string {
	try {
		return resolveRole(kind, pi.getSettings().subagents, ctx.modelRegistry);
	} catch (error) {
		if (error instanceof RoleResolutionError) return `${error.code}: ${error.message}`;
		throw error;
	}
}

function validateText(label: string, value: string | undefined, limit: number, required = false): string | undefined {
	if (required && (value === undefined || value.trim().length === 0)) return `${label} must not be empty`;
	if (value !== undefined && value.length > limit) return `${label} is longer than ${limit} characters`;
	return undefined;
}

function projectScopeOrError(cwd: string): ProjectScope | string {
	try {
		return createProjectScope(cwd);
	} catch (error) {
		return `Project root is not accessible: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export function createSubagentsExtension(extensionOptions: SubagentsExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		/** Runs the accounting hook; returns a warning instead of throwing so a ledger failure cannot fail the call. */
		const complete = async (
			summary: SubagentRunSummary,
			ctx: ExtensionContext,
			toolCallId: string,
		): Promise<string | undefined> => {
			try {
				await extensionOptions.onRunComplete?.(summary, ctx, toolCallId, pi.getSettings());
				return undefined;
			} catch (error) {
				return `Ledger record not written: ${error instanceof Error ? error.message : String(error)}`;
			}
		};
		const finalResult = (summary: SubagentRunSummary, ledgerWarning?: string) => ({
			content: [{ type: "text" as const, text: renderSummaryText(summary) }],
			details: ledgerWarning === undefined ? summary : { ...summary, ledgerWarning },
			...(ERROR_OUTCOMES.has(summary.outcome) ? { isError: true } : {}),
		});

		const runScout = async (
			toolCallId: string,
			params: ScoutParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
		) => {
			const resolved = resolveRoleOrError(pi, ctx, "scout");
			if (typeof resolved === "string") return errorResult(resolved);
			const role = resolved;
			const problem =
				validateText("question", params.question, MAX_QUESTION_CHARS, true) ??
				validateText("context", params.context, MAX_CONTEXT_CHARS) ??
				((params.startPaths?.length ?? 0) > MAX_START_PATHS
					? `startPaths has more than ${MAX_START_PATHS} entries`
					: undefined);
			if (problem) return errorResult(`Invalid brief: ${problem}`);
			const project = projectScopeOrError(ctx.cwd);
			if (typeof project === "string") return errorResult(project);
			for (const path of params.startPaths ?? []) {
				try {
					project.resolveAccessible(path);
				} catch (error) {
					if (!(error instanceof ScopeError)) throw error;
					return errorResult(`Invalid brief: startPaths entry ${path}: ${error.message}`);
				}
			}
			const scripts = pi.getSettings().subagents?.scripts ?? {};
			const child = createScoutChild({ project, scripts });
			const task = [
				`Question: ${params.question}`,
				params.context ? `Context from the requester:\n${params.context}` : undefined,
				params.startPaths?.length ? `Start from: ${params.startPaths.join(", ")}` : undefined,
				`Budget: at most ${role.budgets.maxTurns} turns. Finish with the report tool.`,
			]
				.filter((part) => part !== undefined)
				.join("\n\n");
			const gitBefore = await snapshotGitStatus(project.root, signal);
			const run = await runSubagent({
				role,
				registry: ctx.modelRegistry,
				systemPrompt: SCOUT_SYSTEM_PROMPT,
				task,
				tools: child.tools,
				terminalTools: child.terminalTools,
				beforeToolCall: child.beforeToolCall,
				signal,
			});
			const gitAfter = gitBefore ? await snapshotGitStatus(project.root) : undefined;
			const raw = child.getReport();
			const treeChanged =
				gitBefore && gitAfter ? changedPaths(gitBefore, gitAfter, project.root).length > 0 : undefined;
			const base = baseSummary(role, randomUUID(), run, child.counters.scopeViolations);
			const summary: SubagentRunSummary = raw
				? {
						...base,
						outcome: run.outcome,
						scout: {
							...(await verifyScoutReport(raw, project)),
							...(treeChanged === undefined ? {} : { treeChanged }),
						},
					}
				: {
						...base,
						outcome: run.outcome === "completed" ? "no_report" : run.outcome,
						...(run.finalText ? { rawText: truncateText(run.finalText, RAW_TEXT_LIMIT_CHARS) } : {}),
					};
			return finalResult(summary, await complete(summary, ctx, toolCallId));
		};

		const runCoder = async (
			toolCallId: string,
			params: CodeFileParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
		) => {
			const resolved = resolveRoleOrError(pi, ctx, "coder");
			if (typeof resolved === "string") return errorResult(resolved);
			const role = resolved;
			const snippetChars = (params.snippets ?? []).reduce((sum, snippet) => sum + snippet.text.length, 0);
			const argsTooLong = params.oracle.args.some((arg) => arg.length > MAX_ORACLE_ARG_CHARS);
			const problem =
				validateText("path", params.path, 1_000, true) ??
				validateText("change", params.change, MAX_CHANGE_CHARS, true) ??
				validateText("contract", params.contract, MAX_CONTEXT_CHARS) ??
				validateText("oracle.command", params.oracle.command, 1_000, true) ??
				(snippetChars > MAX_SNIPPET_CHARS
					? `snippets total more than ${MAX_SNIPPET_CHARS} characters`
					: undefined) ??
				(params.oracle.args.length > MAX_ORACLE_ARGS
					? `oracle.args has more than ${MAX_ORACLE_ARGS} entries`
					: undefined) ??
				(argsTooLong ? `an oracle argument is longer than ${MAX_ORACLE_ARG_CHARS} characters` : undefined);
			if (problem) return errorResult(`Invalid brief: ${problem}`);
			const project = projectScopeOrError(ctx.cwd);
			if (typeof project === "string") return errorResult(project);
			let scope: ReturnType<typeof createWriteScope>;
			try {
				scope = createWriteScope(project, params.path);
			} catch (error) {
				if (error instanceof ScopeError) return errorResult(`Invalid brief: ${error.message}`);
				return errorResult(
					`Invalid brief: target is not usable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const oracle = {
				command: params.oracle.command,
				args: params.oracle.args,
				timeoutMs: Math.min(params.oracle.timeoutMs ?? role.budgets.timeoutMs, MAX_ORACLE_TIMEOUT_MS),
			};
			const target = relative(project.root, scope.targetPath);
			const child = createCoderChild({ project, scope, oracle, maxOracleRuns: role.budgets.maxOracleRuns });
			const task = [
				`Target file (the only file you may edit or write): ${target}`,
				`Intended change:\n${params.change}`,
				params.contract ? `Interface contract (do not change):\n${params.contract}` : undefined,
				...(params.snippets ?? []).map(
					(snippet) => `Snippet${snippet.path ? ` from ${snippet.path}` : ""}:\n${snippet.text}`,
				),
				`Oracle (run it with run_oracle, at most ${role.budgets.maxOracleRuns} time${role.budgets.maxOracleRuns === 1 ? "" : "s"}): ${[oracle.command, ...oracle.args].join(" ")}`,
				`Budget: at most ${role.budgets.maxTurns} turns. Finish with the finish tool.`,
			]
				.filter((part) => part !== undefined)
				.join("\n\n");
			const before: FileSnapshot = await snapshotFile(scope.targetPath);
			const gitBefore = await snapshotGitStatus(project.root, signal);
			const run = await runSubagent({
				role,
				registry: ctx.modelRegistry,
				systemPrompt: CODER_SYSTEM_PROMPT,
				task,
				tools: child.tools,
				terminalTools: child.terminalTools,
				beforeToolCall: child.beforeToolCall,
				signal,
			});
			const after = await snapshotFile(scope.targetPath);
			const changed = before.sha256 !== after.sha256;
			const escalation = run.outcome === "completed" ? child.getEscalation() : undefined;
			// An escalating coder stopped on purpose with the work unfinished, so the oracle is not run for it.
			const oracleResult =
				changed && !signal?.aborted && escalation === undefined
					? await runAuthoritativeOracle({ oracle, cwd: project.root, childRuns: child.getOracleRuns(), signal })
					: undefined;
			const gitAfter = gitBefore ? await snapshotGitStatus(project.root) : undefined;
			const outsideTargetChanges =
				gitBefore && gitAfter
					? changedPaths(gitBefore, gitAfter, project.root).filter((path) => path !== target)
					: undefined;
			const maxDiffLines = role.budgets.maxDiffLines;
			// Checked after the child stops. The file is left as written, like every other failed coder run.
			const diffTooLarge = maxDiffLines !== undefined && countChangedLines(before, after) > maxDiffLines;
			let outcome: SubagentOutcome = run.outcome;
			if (run.outcome === "completed") {
				if (escalation) outcome = "escalated";
				else if (diffTooLarge) outcome = "diff_too_large";
				else outcome = !changed ? "no_change" : oracleResult?.passed ? "passed" : "oracle_failed";
			}
			const summary: SubagentRunSummary = {
				...baseSummary(role, randomUUID(), run, child.counters.scopeViolations),
				outcome,
				coder: assembleCoderReport({
					project,
					scope,
					before,
					after,
					finish: child.getFinish(),
					...(escalation === undefined ? {} : { escalation }),
					oracle: oracleResult,
					outsideTargetChanges,
				}),
			};
			return finalResult(summary, await complete(summary, ctx, toolCallId));
		};

		const runVerdict = async (toolCallId: string, params: VerdictParams, ctx: ExtensionContext) => {
			const problem =
				validateText("runId", params.runId, 200, true) ??
				validateText("reason", params.reason, MAX_VERDICT_REASON_CHARS, true);
			if (problem) return errorResult(`Invalid verdict: ${problem}`);
			const run = findRunInBranch(ctx, params.runId);
			if (!run) {
				return errorResult(
					`Unknown runId ${params.runId}: no scout or code_file result with that runId is in this session`,
				);
			}
			const verdict: SubagentVerdictInput = {
				runId: params.runId,
				verdict: params.verdict,
				reason: params.reason,
				role: run.role,
				roleName: run.roleName,
			};
			try {
				await extensionOptions.onVerdict?.(verdict, ctx, toolCallId, pi.getSettings());
			} catch (error) {
				return errorResult(`Verdict not recorded: ${error instanceof Error ? error.message : String(error)}`);
			}
			return {
				content: [{ type: "text" as const, text: `Recorded ${params.verdict} for run ${params.runId}.` }],
				details: verdict,
			};
		};

		pi.on("session_start", () => {
			const active = activeRoleNames(pi.getSettings().subagents);
			if (active.scout) {
				pi.registerTool({
					name: SCOUT_TOOL_NAME,
					label: SCOUT_TOOL_NAME,
					description: SCOUT_DESCRIPTION,
					parameters: scoutParameters,
					execute: (toolCallId, params, signal, _onUpdate, ctx) => runScout(toolCallId, params, signal, ctx),
				});
			}
			if (active.scout || active.coder) {
				pi.registerTool({
					name: SUBAGENT_VERDICT_TOOL_NAME,
					label: SUBAGENT_VERDICT_TOOL_NAME,
					description: VERDICT_DESCRIPTION,
					parameters: verdictParameters,
					execute: (toolCallId, params, _signal, _onUpdate, ctx) => runVerdict(toolCallId, params, ctx),
				});
			}
			if (active.coder) {
				pi.registerTool({
					name: CODE_FILE_TOOL_NAME,
					label: CODE_FILE_TOOL_NAME,
					description: CODE_FILE_DESCRIPTION,
					parameters: codeFileParameters,
					executionMode: "sequential",
					execute: (toolCallId, params, signal, _onUpdate, ctx) => runCoder(toolCallId, params, signal, ctx),
				});
			}
		});
	};
}

export default createSubagentsExtension({ onRunComplete: recordSubagentRun, onVerdict: recordSubagentVerdict });
