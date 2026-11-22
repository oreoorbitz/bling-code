import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { upstreamMatches } from "../../core/learning/benchmark-report.ts";
import type { Settings } from "../../core/settings-manager.ts";
import {
	type CapacityEvent,
	type CapacitySnapshot,
	capacityKey,
	SubagentCapacity,
} from "../../core/subagents/capacity.ts";
import {
	createProjectScope,
	createWriteScope,
	type ProjectScope,
	ScopeError,
	type WriteScope,
} from "../../core/subagents/path-scope.ts";
import { CODER_SYSTEM_PROMPT, SCOUT_SYSTEM_PROMPT } from "../../core/subagents/prompts.ts";
import {
	activeRoleNames,
	type DelegationMode,
	delegationMode,
	type ResolvedRole,
	type RoleKind,
	RoleResolutionError,
	resolveRole,
} from "../../core/subagents/roles.ts";
import { runSubagent, type SubagentRunResult } from "../../core/subagents/runner.ts";
import {
	DEFAULT_MAX_RATE_LIMIT_RETRIES,
	resolveSwarmMaxConcurrency,
	SwarmBatch,
	type SwarmBatchLauncher,
	type SwarmBatchRunResult,
	type SwarmBatchTask,
	userCancellationReason,
} from "../../core/subagents/swarm-batch.ts";
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
import type {
	OracleRunResult,
	SubagentOutcome,
	SubagentRunSummary,
	SubagentUsage,
} from "../../core/subagents/types.ts";
import { recordCapacityEvent, recordSubagentRun, recordSubagentVerdict, type SubagentVerdictInput } from "./ledger.ts";

export const SCOUT_TOOL_NAME = "scout";
export const CODE_FILE_TOOL_NAME = "code_file";
export const SUBAGENT_VERDICT_TOOL_NAME = "subagent_verdict";
export const SUBAGENT_SWARM_TOOL_NAME = "subagent_swarm";

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
export const MIN_SWARM_TASKS = 2;
export const MAX_SWARM_TASKS = 128;
export const MAX_SWARM_DESCRIPTION_CHARS = 500;
/** Overall bound for the text the subagent_swarm tool returns, across every task result. */
export const MAX_SWARM_RESULT_CHARS = 48_000;
/** How long a single scout or code_file call waits for a slot on its host before it is refused. */
export const SINGLE_CALL_SLOT_WAIT_MS = 30_000;
/** Grace added to a role's timeoutMs when handing a task to the batch scheduler, so the runner's own timeout (a "timeout" outcome) wins over the scheduler's abort (an "aborted" outcome). */
const SWARM_TASK_TIMEOUT_GRACE_MS = 30_000;
/** How long to wait for aborted in-flight attempts to settle so their usage is recorded. */
const SWARM_ABORT_SETTLE_MS = 10_000;

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
	/** Called for every change of a host's learned concurrency. A failure is ignored. */
	onCapacityEvent?: (event: CapacityEvent, ctx: ExtensionContext, settings: Settings) => void | Promise<void>;
	/** Clock for the capacity governor; tests inject one. */
	now?: () => number;
	/** Launch pause after a rate limit, in milliseconds; tests shorten it. */
	capacityPauseMs?: number;
}

const scoutQuestionSchema = Type.String({ description: "What to find out. One focused question." });
const scoutContextSchema = Type.Optional(
	Type.String({
		description: `Hints or snippets that narrow the search (at most ${MAX_CONTEXT_CHARS} characters).`,
	}),
);
const scoutStartPathsSchema = Type.Optional(
	Type.Array(Type.String(), {
		description: `Project-relative files or directories to start from (at most ${MAX_START_PATHS}).`,
	}),
);

const scoutParameters = Type.Object({
	question: scoutQuestionSchema,
	context: scoutContextSchema,
	startPaths: scoutStartPathsSchema,
});

const codeFilePathSchema = Type.String({
	description: "The single target file, relative to the project root. Its parent directory must exist.",
});
const codeFileChangeSchema = Type.String({
	description: "The intended change, specific enough to carry out without further questions.",
});
const codeFileContractSchema = Type.Optional(
	Type.String({ description: "Interfaces other files rely on (signatures, types, exports) that must not change." }),
);
const codeFileSnippetsSchema = Type.Optional(
	Type.Array(Type.Object({ path: Type.Optional(Type.String()), text: Type.String() }), {
		description: `Selected context from other files (at most ${MAX_SNIPPET_CHARS} characters in total).`,
	}),
);
const codeFileOracleSchema = Type.Object(
	{
		command: Type.String({ description: "Executable to run. No shell: it is started directly." }),
		args: Type.Array(Type.String(), { description: "Arguments, one array entry each." }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_ORACLE_TIMEOUT_MS })),
	},
	{
		description: "The check that decides success. The harness runs it after the coder stops; exit code 0 means pass.",
	},
);

const codeFileParameters = Type.Object({
	path: codeFilePathSchema,
	change: codeFileChangeSchema,
	contract: codeFileContractSchema,
	snippets: codeFileSnippetsSchema,
	oracle: codeFileOracleSchema,
});

/** One subagent_swarm task: exactly the brief of one scout or code_file call, plus its kind. */
const swarmTaskParameters = Type.Union([
	Type.Object({
		kind: Type.Literal("scout", { description: "A read-only investigation; the same brief as the scout tool." }),
		question: scoutQuestionSchema,
		context: scoutContextSchema,
		startPaths: scoutStartPathsSchema,
	}),
	Type.Object({
		kind: Type.Literal("coder", { description: "A one-file change; the same brief as the code_file tool." }),
		path: codeFilePathSchema,
		change: codeFileChangeSchema,
		contract: codeFileContractSchema,
		snippets: codeFileSnippetsSchema,
		oracle: codeFileOracleSchema,
	}),
]);

const subagentSwarmParameters = Type.Object({
	description: Type.String({
		description: "What the swarm does overall.",
		maxLength: MAX_SWARM_DESCRIPTION_CHARS,
	}),
	tasks: Type.Array(swarmTaskParameters, {
		minItems: MIN_SWARM_TASKS,
		maxItems: MAX_SWARM_TASKS,
		description: `The briefs to run, in order. ${MIN_SWARM_TASKS} to ${MAX_SWARM_TASKS} tasks; results come back in this order.`,
	}),
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
type SwarmParams = Static<typeof subagentSwarmParameters>;

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

const VERDICT_DESCRIPTION = `Record whether you accept or reject the result of a scout, code_file, or subagent_swarm task, for benchmark accounting. It changes no file and has no other effect.
- Pass the runId from the result. accepted means you used the result (a changed file counts as kept); rejected means you discarded it, redid the work yourself, or reverted the change.
- Call it once per result after you have decided. A later call for the same runId replaces the earlier verdict.`;

const SWARM_DESCRIPTION = `Launch ${MIN_SWARM_TASKS} to ${MAX_SWARM_TASKS} subagents as one batch, each a scout or code_file brief, and get every result back in task order.
- A task is exactly the parameters of one scout or code_file call plus kind: "scout" or "coder". Roles, models, hosts, and budgets are fixed by configuration, exactly as for the single tools.
- Every brief is checked before anything starts. An invalid brief fails the whole call and starts nothing. Two coder tasks must not target the same file.
- Concurrency is learned per host for the whole session: after a host rate limits, at most the learned number of subagents run on it at once (shared with single scout and code_file calls), and launches on it pause briefly. The result's concurrency field shows each host's learned limit, running count, and remaining pause; size the next batch to it.
- Tasks start in bounded waves and run concurrently. A provider rate limit before a task's first response requeues only that task, at most ${DEFAULT_MAX_RATE_LIMIT_RETRIES} times; a daily or account quota is not retried. Anything the subagent already received (including a coder that started writing its file) is never re-run. There is no resume: to retry failed work, call subagent_swarm again with fresh briefs.
- Coders edit at the same time, so a coder's own run_oracle may see other targets half-written. The authoritative oracle of each coder task runs after every task has stopped, one at a time, against the final files; its result decides the outcome.
- Each result is the same summary a single scout or code_file call returns, with its runId; record your decision with subagent_verdict. Every task is also written to the ledger like a single run, with usage aggregated across its attempts. In a large batch the text keeps the most useful parts of each result and says what it omitted.
- Scout scripts and coder run_oracle calls from different tasks may run at the same time; they must be safe to run concurrently.`;

const SCOUT_SNIPPET = "delegate a read-only codebase question to a cheaper scout model; returns cited findings";
const CODE_FILE_SNIPPET =
	"delegate a change to one file to a cheaper coder model; the harness runs your check command and returns the diff";
const VERDICT_SNIPPET = "record whether you kept a scout or code_file result";
const SWARM_SNIPPET =
	"launch 2-128 scout or coder briefs as one batch; returns every result in task order with a runId each";

const SCOUT_GUIDELINES: Record<DelegationMode, string[]> = {
	auto: [
		"Use scout instead of reading files yourself when answering needs searching or reading more than about three files, for example where something is used, which modules lack tests, or how data flows between modules. Ask one specific question and give startPaths.",
	],
	prefer: [
		"Delegate investigation: before reading source files yourself, call scout with one specific question and startPaths. Read files yourself only to check a finding scout marked unverified or low confidence, or when scout failed.",
	],
	required: [
		"Delegation is required in this run: call scout before reading source files yourself for any question about where or how something is implemented.",
	],
};
const CODE_FILE_GUIDELINES: Record<DelegationMode, string[]> = {
	auto: [
		"Use code_file for a change confined to one file when you can state the change and a command that checks it. Put the interface other files rely on in contract, then review the returned diff and oracle result instead of re-reading the file.",
		"For a change spanning several files, decide the shared contract first, then call code_file once per file.",
	],
	prefer: [
		"Delegate file changes: make each change with code_file, one call per file, with the interface other files rely on in contract and a command that checks it. Review the returned diff and oracle result instead of re-reading the file.",
		"For a change spanning several files, decide the shared contract first, then call code_file once per file.",
		"Edit a file yourself only when it is really necessary: code_file on it escalated or failed, or the change is a trivial fix to a code_file result you are keeping. Your first edit or write of a file is blocked once as a reminder; repeat it only if doing it yourself is necessary.",
	],
	required: [
		"For a change spanning several files, decide the shared contract first, then call code_file once per file.",
		"Delegation is required in this run: make every file change with code_file, one call per file. edit and write are blocked for a file until code_file on that file escalates or fails. Do not change files through bash.",
	],
};
const VERDICT_GUIDELINES = ["After deciding what to do with each scout or code_file result, call subagent_verdict."];
const SWARM_GUIDELINES: Record<DelegationMode, string[]> = {
	auto: [
		"Batch independent delegations: when several questions or one-file changes are ready at once, issue them as tasks of one subagent_swarm call instead of many sequential scout or code_file calls.",
	],
	prefer: [
		"Delegate in batches: independent questions and one-file changes go to one subagent_swarm call with a task each, under the same fixed roles and budgets as scout and code_file. Give every coder task a distinct target file.",
	],
	required: [
		"Delegation is required in this run: batch independent file changes as coder tasks of one subagent_swarm call (a distinct target file per task) instead of editing directly.",
	],
};

/** Real path of `path`, or of its parent joined with the name when the file does not exist yet. */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

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

/** Compact JSON of the summary for Ling, at most `limit` characters. Drops the least useful parts first. */
export function renderSummaryText(summary: SubagentRunSummary, limit: number = MAX_RESULT_CHARS): string {
	let text = JSON.stringify(summary);
	if (text.length <= limit) return text;
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
	if (text.length <= limit) return text;
	reduced.toolCalls = [];
	if (reduced.coder) reduced.coder = { ...reduced.coder, diff: truncateText(reduced.coder.diff, 1_000) };
	text = JSON.stringify(reduced);
	return text.length <= limit ? text : `${text.slice(0, limit - 20)}...[truncated]`;
}

const SUCCESS_OUTCOMES: ReadonlySet<SubagentOutcome> = new Set(["completed", "passed"]);

/**
 * The smallest form of a summary for the swarm text: identity, outcome, cost, and the coder target.
 * Deliberately partial; the full summary is in the tool result details. Without `error` it is at
 * most about 320 characters, which keeps {@link MAX_SWARM_TASKS} of them within the swarm text bound.
 */
function minimalSummary(summary: SubagentRunSummary, limit?: number): SubagentRunSummary {
	const minimal = {
		runId: summary.runId,
		kind: summary.kind,
		outcome: summary.outcome,
		usage: { cost: Number(summary.usage.cost.toFixed(6)) },
		durationMs: summary.durationMs,
		...(summary.upstreamMismatch ? { upstreamMismatch: true } : {}),
		...(summary.swarm === undefined ? {} : { swarm: summary.swarm }),
		...(summary.coder
			? {
					coder: {
						// The end of a path names the file; keep it.
						path: summary.coder.path.length <= 64 ? summary.coder.path : `...${summary.coder.path.slice(-61)}`,
						changed: summary.coder.changed,
						diffLines: summary.coder.diffLines,
					},
				}
			: {}),
	} as unknown as SubagentRunSummary;
	if (limit === undefined || summary.error === undefined) return minimal;
	const room = limit - JSON.stringify(minimal).length - 21;
	if (room > 0) minimal.error = truncateText(summary.error, room);
	return minimal;
}

/** A smaller copy of a summary whose JSON fits within `limit` characters, or its minimal form. */
function reduceSummaryToChars(summary: SubagentRunSummary, limit: number): SubagentRunSummary {
	if (JSON.stringify(summary).length <= limit) return summary;
	const reduced: SubagentRunSummary = {
		...summary,
		toolCalls: summary.toolCalls.slice(-5),
		...(summary.coder
			? {
					coder: {
						...summary.coder,
						diff: truncateText(summary.coder.diff, 1_000),
						...(summary.coder.oracle
							? {
									oracle: {
										...summary.coder.oracle,
										outputTail: truncateText(summary.coder.oracle.outputTail, 300),
									},
								}
							: {}),
					},
				}
			: {}),
	};
	if (JSON.stringify(reduced).length <= limit) return reduced;
	// Keep the evidence Ling delegated for: drop tool calls, then shorten raw text and drop trailing
	// scout findings, before falling back to the minimal form that carries no report at all.
	reduced.toolCalls = [];
	if (reduced.rawText !== undefined) {
		const room = limit - JSON.stringify({ ...reduced, rawText: "" }).length - 12;
		reduced.rawText = truncateText(reduced.rawText, Math.max(0, room));
	}
	if (reduced.scout) {
		const scout = reduced.scout;
		let kept = scout.findings.length;
		const withFindings = (count: number) => {
			const omitted = scout.findings.length - count;
			reduced.scout = {
				...scout,
				findings: scout.findings.slice(0, count),
				unresolved:
					omitted > 0 ? [...scout.unresolved, `[${omitted} findings omitted for length]`] : scout.unresolved,
			};
		};
		while (kept > 0 && JSON.stringify(reduced).length > limit) withFindings(--kept);
	}
	if (JSON.stringify(reduced).length <= limit) return reduced;
	return minimalSummary(summary, limit);
}

/**
 * The bounded JSON text of a subagent_swarm result: one reduced summary per task in task order, plus
 * outcome counts. The full summaries are in the tool result details; this text stays under
 * {@link MAX_SWARM_RESULT_CHARS} no matter how many tasks returned large reports, and is always valid
 * JSON: when even minimal summaries do not fit, trailing tasks are counted in `omittedTasks`.
 */
export function renderSwarmText(
	description: string,
	summaries: readonly SubagentRunSummary[],
	concurrency: readonly SwarmConcurrencyView[] = [],
): string {
	const counts = { total: summaries.length, completed: 0, failed: 0, aborted: 0 };
	for (const summary of summaries) {
		if (summary.outcome === "aborted") counts.aborted += 1;
		else if (SUCCESS_OUTCOMES.has(summary.outcome)) counts.completed += 1;
		else counts.failed += 1;
	}
	const header = { description, ...counts, ...(concurrency.length > 0 ? { concurrency } : {}) };
	const overhead = JSON.stringify(header).length + summaries.length + 64;
	const available = Math.max(0, MAX_SWARM_RESULT_CHARS - overhead);
	const perTask = Math.floor(available / Math.max(1, summaries.length));
	let text = JSON.stringify({
		...header,
		results: summaries.map((summary) => reduceSummaryToChars(summary, perTask)),
	});
	if (text.length <= MAX_SWARM_RESULT_CHARS) return text;
	const results = summaries.map((summary) => minimalSummary(summary));
	let omittedTasks = 0;
	for (;;) {
		text = JSON.stringify({ ...header, results, ...(omittedTasks > 0 ? { omittedTasks } : {}) });
		if (text.length <= MAX_SWARM_RESULT_CHARS || results.length === 0) return text;
		results.pop();
		omittedTasks += 1;
	}
}

/** One host's capacity as Ling sees it in a swarm result, to size the next batch. */
export interface SwarmConcurrencyView {
	host: string;
	/** Learned limit of concurrent subagents; absent until the host rate limits. */
	limit?: number;
	running: number;
	/** Seconds until launches on the host resume after a rate limit. */
	pausedForSeconds?: number;
}

function concurrencyView(snapshot: CapacitySnapshot, now: number): SwarmConcurrencyView {
	const pausedFor = snapshot.pausedUntil === undefined ? 0 : Math.ceil((snapshot.pausedUntil - now) / 1000);
	return {
		host: snapshot.key,
		...(snapshot.limit === undefined ? {} : { limit: snapshot.limit }),
		running: snapshot.running,
		...(pausedFor > 0 ? { pausedForSeconds: pausedFor } : {}),
	};
}

function roleCapacityKey(role: ResolvedRole): string {
	return capacityKey(role.config.provider, role.config.model, role.requestedUpstream);
}

function zeroUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/** What a subagent_swarm attempt adds to a scout or coder run. */
interface SwarmAttemptOptions {
	/** Forwards readiness to the batch scheduler. */
	onReady: () => void;
	/** Project-relative coder targets of the other tasks in the batch: their edits are not this task's changes. */
	ignorePaths: ReadonlySet<string>;
}

/**
 * Thrown by a swarm attempt that rate-limited before producing any content. The batch scheduler
 * classifies it with `isRateLimitError` and requeues the task; any other failure resolves the
 * attempt normally so it is never retried.
 */
class SwarmAttemptRateLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SwarmAttemptRateLimitError";
	}
}

/**
 * Merge the per-attempt summaries of one swarm task into the single summary that is returned and
 * recorded: counters and usage aggregate across attempts, while the report-bearing fields (scout,
 * coder, rawText, error) come from the final attempt, whose outcome stands. Rate-limit retries
 * happen only before an attempt produced content, so the final attempt's report is the task's report.
 */
function aggregateAttemptSummaries(attempts: readonly SubagentRunSummary[]): SubagentRunSummary {
	const final = attempts[attempts.length - 1]!;
	const usage = zeroUsage();
	const served = new Set<string>();
	const toolCalls: SubagentRunSummary["toolCalls"] = [];
	let reasoning = 0;
	let hasReasoning = false;
	let turns = 0;
	let failedToolCalls = 0;
	let scopeViolations = 0;
	let startedAt = Number.POSITIVE_INFINITY;
	let endedAt = 0;
	for (const attempt of attempts) {
		usage.input += attempt.usage.input;
		usage.output += attempt.usage.output;
		usage.cacheRead += attempt.usage.cacheRead;
		usage.cacheWrite += attempt.usage.cacheWrite;
		usage.totalTokens += attempt.usage.totalTokens;
		usage.cost += attempt.usage.cost;
		if (attempt.usage.reasoning !== undefined) {
			hasReasoning = true;
			reasoning += attempt.usage.reasoning;
		}
		turns += attempt.turns;
		failedToolCalls += attempt.failedToolCalls;
		scopeViolations += attempt.scopeViolations;
		startedAt = Math.min(startedAt, attempt.startedAt);
		endedAt = Math.max(endedAt, attempt.startedAt + attempt.durationMs);
		toolCalls.push(...attempt.toolCalls);
		for (const host of attempt.servedUpstreams) served.add(host);
	}
	// Each attempt measures from its own start; the task's clock starts with its first attempt.
	const firstToolAttempt = attempts.find((attempt) => attempt.timeToFirstToolCallMs !== undefined);
	return {
		...final,
		usage: hasReasoning ? { ...usage, reasoning } : usage,
		turns,
		startedAt,
		durationMs: Math.max(0, endedAt - startedAt),
		toolCalls,
		timeToFirstToolCallMs:
			firstToolAttempt === undefined
				? undefined
				: firstToolAttempt.startedAt - startedAt + firstToolAttempt.timeToFirstToolCallMs!,
		failedToolCalls,
		scopeViolations,
		servedUpstreams: [...served],
		upstreamMismatch: attempts.some((attempt) => attempt.upstreamMismatch),
	};
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

/** The scout, code_file, or subagent_swarm task result with this runId on the session's active branch, read from tool result details. */
function findRunInBranch(ctx: ExtensionContext, runId: string): { role: RoleKind; roleName: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName === SUBAGENT_SWARM_TOOL_NAME) {
			const swarmDetails = entry.message.details as
				| { results?: Array<{ runId?: unknown; kind?: unknown; roleName?: unknown }> }
				| undefined;
			for (const result of swarmDetails?.results ?? []) {
				if (result.runId !== runId) continue;
				if ((result.kind !== "scout" && result.kind !== "coder") || typeof result.roleName !== "string") continue;
				return { role: result.kind, roleName: result.roleName };
			}
			continue;
		}
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

/** Size and shape problems of a scout brief, without touching the filesystem. */
function scoutBriefProblem(params: ScoutParams): string | undefined {
	return (
		validateText("question", params.question, MAX_QUESTION_CHARS, true) ??
		validateText("context", params.context, MAX_CONTEXT_CHARS) ??
		((params.startPaths?.length ?? 0) > MAX_START_PATHS
			? `startPaths has more than ${MAX_START_PATHS} entries`
			: undefined)
	);
}

/** Size and shape problems of a coder brief, without touching the filesystem. */
function coderBriefProblem(params: CodeFileParams): string | undefined {
	const snippetChars = (params.snippets ?? []).reduce((sum, snippet) => sum + snippet.text.length, 0);
	const argsTooLong = params.oracle.args.some((arg) => arg.length > MAX_ORACLE_ARG_CHARS);
	return (
		validateText("path", params.path, 1_000, true) ??
		validateText("change", params.change, MAX_CHANGE_CHARS, true) ??
		validateText("contract", params.contract, MAX_CONTEXT_CHARS) ??
		validateText("oracle.command", params.oracle.command, 1_000, true) ??
		(snippetChars > MAX_SNIPPET_CHARS ? `snippets total more than ${MAX_SNIPPET_CHARS} characters` : undefined) ??
		(params.oracle.args.length > MAX_ORACLE_ARGS
			? `oracle.args has more than ${MAX_ORACLE_ARGS} entries`
			: undefined) ??
		(argsTooLong ? `an oracle argument is longer than ${MAX_ORACLE_ARG_CHARS} characters` : undefined)
	);
}

/** The first startPaths entry that is not accessible inside the project, if any. */
function startPathsProblem(project: ProjectScope, params: ScoutParams): string | undefined {
	for (const path of params.startPaths ?? []) {
		try {
			project.resolveAccessible(path);
		} catch (error) {
			if (!(error instanceof ScopeError)) throw error;
			return `startPaths entry ${path}: ${error.message}`;
		}
	}
	return undefined;
}

/** The write scope for a coder target, or the problem with the target. */
function writeScopeOrProblem(project: ProjectScope, path: string): WriteScope | string {
	try {
		return createWriteScope(project, path);
	} catch (error) {
		if (error instanceof ScopeError) return error.message;
		return `target is not usable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export function createSubagentsExtension(extensionOptions: SubagentsExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		/** Files a failed or escalated code_file run released for direct edit and write under required delegation. */
		const releasedTargets = new Set<string>();
		/** Files whose first direct edit or write was already blocked once under "prefer" delegation. */
		const remindedTargets = new Set<string>();
		/** Context of the latest subagent tool call: capacity changes from timers are recorded against it. */
		let latestCtx: ExtensionContext | undefined;
		const now = extensionOptions.now ?? Date.now;
		const capacity = new SubagentCapacity({
			now,
			...(extensionOptions.capacityPauseMs === undefined ? {} : { pauseMs: extensionOptions.capacityPauseMs }),
			onEvent: (event) => {
				const ctx = latestCtx;
				if (ctx === undefined || extensionOptions.onCapacityEvent === undefined) return;
				void Promise.resolve()
					.then(() => extensionOptions.onCapacityEvent?.(event, ctx, pi.getSettings()))
					.catch(() => {});
			},
		});
		/**
		 * runSubagent plus capacity reporting: the first response lifts a pause on the host, and the
		 * run's end reports a rate limit (with the slot still held) or a success.
		 */
		const runReported = async (options: Parameters<typeof runSubagent>[0]): Promise<SubagentRunResult> => {
			const key = roleCapacityKey(options.role);
			const run = await runSubagent({
				...options,
				onReady: () => {
					capacity.reportSuccess(key);
					options.onReady?.();
				},
			});
			if (run.rateLimit !== undefined) capacity.reportRateLimited(key);
			else if (run.turns > 0) capacity.reportSuccess(key);
			return run;
		};
		/** Hold a slot on the role's host for a single scout or code_file call, or say why there is none. */
		const withSlot = async <R>(
			role: ResolvedRole,
			signal: AbortSignal | undefined,
			body: () => Promise<R>,
		): Promise<R | ReturnType<typeof errorResult>> => {
			let slot: Awaited<ReturnType<SubagentCapacity["acquire"]>>;
			try {
				slot = await capacity.acquire(roleCapacityKey(role), SINGLE_CALL_SLOT_WAIT_MS, signal);
			} catch {
				return errorResult("Interrupted while waiting for a subagent slot; nothing ran.");
			}
			if (typeof slot !== "function") return errorResult(`No subagent slot: ${slot.refused}`);
			try {
				return await body();
			} finally {
				slot();
			}
		};
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

		/**
		 * Run one scout brief and build its summary. Validation and role resolution happen at the
		 * call sites (the single scout tool validates per call; subagent_swarm preflights the whole
		 * batch first). `swarm` is set for subagent_swarm tasks.
		 */
		const buildScoutSummary = async (
			role: ResolvedRole,
			project: ProjectScope,
			params: ScoutParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
			runId: string,
			swarm?: SwarmAttemptOptions,
		): Promise<{ summary: SubagentRunSummary; run: SubagentRunResult }> => {
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
			const run = await runReported({
				role,
				registry: ctx.modelRegistry,
				systemPrompt: SCOUT_SYSTEM_PROMPT,
				task,
				tools: child.tools,
				terminalTools: child.terminalTools,
				beforeToolCall: child.beforeToolCall,
				signal,
				...(swarm === undefined ? {} : { onReady: swarm.onReady }),
			});
			const gitAfter = gitBefore ? await snapshotGitStatus(project.root) : undefined;
			const raw = child.getReport();
			const treeChanged =
				gitBefore && gitAfter
					? changedPaths(gitBefore, gitAfter, project.root).some((path) => !swarm?.ignorePaths.has(path))
					: undefined;
			const base = baseSummary(role, runId, run, child.counters.scopeViolations);
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
			return { summary, run };
		};

		/**
		 * Run one coder brief and build its summary. See {@link buildScoutSummary} for the split of
		 * responsibilities. In a swarm the authoritative oracle is not run here: the summary is
		 * provisional and `runOracle` settles it once every coder in the batch has stopped editing.
		 */
		const buildCoderSummary = async (
			role: ResolvedRole,
			project: ProjectScope,
			scope: WriteScope,
			params: CodeFileParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
			runId: string,
			swarm?: SwarmAttemptOptions,
		): Promise<{
			summary: SubagentRunSummary;
			run: SubagentRunResult;
			runOracle?: (oracleSignal: AbortSignal | undefined) => Promise<SubagentRunSummary>;
		}> => {
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
			const run = await runReported({
				role,
				registry: ctx.modelRegistry,
				systemPrompt: CODER_SYSTEM_PROMPT,
				task,
				tools: child.tools,
				terminalTools: child.terminalTools,
				beforeToolCall: child.beforeToolCall,
				signal,
				...(swarm === undefined ? {} : { onReady: swarm.onReady }),
			});
			const after = await snapshotFile(scope.targetPath);
			const changed = before.sha256 !== after.sha256;
			const escalation = run.outcome === "completed" ? child.getEscalation() : undefined;
			// An escalating coder stopped on purpose with the work unfinished, so the oracle is not run for it.
			const needsOracle = changed && !signal?.aborted && escalation === undefined;
			const runOracle = (oracleSignal: AbortSignal | undefined) =>
				runAuthoritativeOracle({
					oracle,
					cwd: project.root,
					childRuns: child.getOracleRuns(),
					signal: oracleSignal,
				});
			const outsideChanges = async () => {
				const gitAfter = gitBefore ? await snapshotGitStatus(project.root) : undefined;
				// Sibling swarm coders write their own targets meanwhile; those are not this coder's changes.
				return gitBefore && gitAfter
					? changedPaths(gitBefore, gitAfter, project.root).filter(
							(path) => path !== target && !swarm?.ignorePaths.has(path),
						)
					: undefined;
			};
			const maxDiffLines = role.budgets.maxDiffLines;
			// Checked after the child stops. The file is left as written, like every other failed coder run.
			const diffTooLarge = maxDiffLines !== undefined && countChangedLines(before, after) > maxDiffLines;
			const settle = (
				oracleResult: OracleRunResult | undefined,
				outsideTargetChanges: string[] | undefined,
			): SubagentRunSummary => {
				let outcome: SubagentOutcome = run.outcome;
				if (run.outcome === "completed") {
					if (escalation) outcome = "escalated";
					else if (diffTooLarge) outcome = "diff_too_large";
					else outcome = !changed ? "no_change" : oracleResult?.passed ? "passed" : "oracle_failed";
				}
				return {
					...baseSummary(role, runId, run, child.counters.scopeViolations),
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
			};
			if (swarm !== undefined) {
				const outsideTargetChanges = await outsideChanges();
				return {
					summary: settle(undefined, outsideTargetChanges),
					run,
					...(needsOracle
						? {
								runOracle: async (oracleSignal: AbortSignal | undefined) =>
									settle(await runOracle(oracleSignal), outsideTargetChanges),
							}
						: {}),
				};
			}
			const oracleResult = needsOracle ? await runOracle(signal) : undefined;
			return { summary: settle(oracleResult, await outsideChanges()), run };
		};

		const runScout = async (
			toolCallId: string,
			params: ScoutParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
		) => {
			const resolved = resolveRoleOrError(pi, ctx, "scout");
			if (typeof resolved === "string") return errorResult(resolved);
			const problem = scoutBriefProblem(params);
			if (problem) return errorResult(`Invalid brief: ${problem}`);
			const project = projectScopeOrError(ctx.cwd);
			if (typeof project === "string") return errorResult(project);
			const pathProblem = startPathsProblem(project, params);
			if (pathProblem) return errorResult(`Invalid brief: ${pathProblem}`);
			latestCtx = ctx;
			return withSlot(resolved, signal, async () => {
				const { summary } = await buildScoutSummary(resolved, project, params, signal, ctx, randomUUID());
				return finalResult(summary, await complete(summary, ctx, toolCallId));
			});
		};

		const runCoder = async (
			toolCallId: string,
			params: CodeFileParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
		) => {
			const resolved = resolveRoleOrError(pi, ctx, "coder");
			if (typeof resolved === "string") return errorResult(resolved);
			const problem = coderBriefProblem(params);
			if (problem) return errorResult(`Invalid brief: ${problem}`);
			const project = projectScopeOrError(ctx.cwd);
			if (typeof project === "string") return errorResult(project);
			const scope = writeScopeOrProblem(project, params.path);
			if (typeof scope === "string") return errorResult(`Invalid brief: ${scope}`);
			latestCtx = ctx;
			return withSlot(resolved, signal, async () => {
				const { summary } = await buildCoderSummary(resolved, project, scope, params, signal, ctx, randomUUID());
				// A failed run leaves the file as written; release the target under required delegation.
				if (summary.outcome !== "passed") releasedTargets.add(canonicalPath(scope.targetPath));
				return finalResult(summary, await complete(summary, ctx, toolCallId));
			});
		};

		interface SwarmTaskData {
			/** 0-based position in the tasks array; results are reported 1-based. */
			index: number;
			kind: RoleKind;
			params: ScoutParams | CodeFileParams;
			/** One runId per task: the ledger record and subagent_verdict key for the whole task. */
			runId: string;
			role: ResolvedRole;
			/** Canonical write target for coder tasks; undefined for scouts. */
			targetPath?: string;
		}

		/** Check every brief, resolve the roles, and reject duplicate coder targets, all before anything starts. */
		const preflightSwarm = (
			params: SwarmParams,
			ctx: ExtensionContext,
		): { tasks: SwarmTaskData[]; project: ProjectScope } | string => {
			const problems: string[] = [];
			const descriptionProblem = validateText("description", params.description, MAX_SWARM_DESCRIPTION_CHARS, true);
			if (descriptionProblem) problems.push(descriptionProblem);
			if (!Array.isArray(params.tasks)) {
				return `Invalid tasks: tasks must be an array of ${MIN_SWARM_TASKS} to ${MAX_SWARM_TASKS} briefs`;
			}
			if (params.tasks.length < MIN_SWARM_TASKS || params.tasks.length > MAX_SWARM_TASKS) {
				problems.push(`tasks must have between ${MIN_SWARM_TASKS} and ${MAX_SWARM_TASKS} entries`);
			}
			const kindsUsed = new Set<RoleKind>();
			for (const entry of params.tasks) {
				const kind = (entry as { kind?: unknown }).kind;
				if (kind === "scout" || kind === "coder") kindsUsed.add(kind);
			}
			const roles = new Map<RoleKind, ResolvedRole>();
			for (const kind of kindsUsed) {
				const resolved = resolveRoleOrError(pi, ctx, kind);
				if (typeof resolved === "string") problems.push(resolved);
				else roles.set(kind, resolved);
			}
			const project = projectScopeOrError(ctx.cwd);
			if (typeof project === "string") return project;
			const coderTargets = new Map<string, number>();
			const tasks: SwarmTaskData[] = [];
			for (const [index, entry] of params.tasks.entries()) {
				const task = entry as { kind?: unknown } & ScoutParams & CodeFileParams;
				const position = `Task ${index + 1}`;
				if (task.kind !== "scout" && task.kind !== "coder") {
					problems.push(`${position}: kind must be "scout" or "coder"`);
					continue;
				}
				const briefProblem = task.kind === "scout" ? scoutBriefProblem(task) : coderBriefProblem(task);
				if (briefProblem) {
					problems.push(`${position}: ${briefProblem}`);
					continue;
				}
				if (task.kind === "scout") {
					const pathProblem = startPathsProblem(project, task);
					if (pathProblem) {
						problems.push(`${position}: ${pathProblem}`);
						continue;
					}
					tasks.push({ index, kind: "scout", params: task, runId: randomUUID(), role: roles.get("scout")! });
					continue;
				}
				const scope = writeScopeOrProblem(project, task.path);
				if (typeof scope === "string") {
					problems.push(`${position}: ${scope}`);
					continue;
				}
				const target = canonicalPath(scope.targetPath);
				const previousIndex = coderTargets.get(target);
				if (previousIndex !== undefined) {
					problems.push(
						`${position}: coder target ${task.path} is also the target of task ${previousIndex}; coder tasks must have distinct targets`,
					);
					continue;
				}
				coderTargets.set(target, index + 1);
				tasks.push({
					index,
					kind: "coder",
					params: task,
					runId: randomUUID(),
					role: roles.get("coder")!,
					targetPath: target,
				});
			}
			if (problems.length > 0) return problems.join("\n");
			return { tasks, project };
		};

		const runSwarm = async (
			toolCallId: string,
			params: SwarmParams,
			signal: AbortSignal | undefined,
			ctx: ExtensionContext,
		) => {
			const preflight = preflightSwarm(params, ctx);
			if (typeof preflight === "string") return errorResult(`Invalid swarm: ${preflight}`);
			let maxConcurrency: number | undefined;
			try {
				maxConcurrency = resolveSwarmMaxConcurrency();
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
			const { tasks, project } = preflight;
			latestCtx = ctx;

			// The batch resolves with per-task aborted results on any caller abort, so an interrupt
			// (whatever reason the agent loop attaches) yields per-task results instead of a rejection.
			const batchController = new AbortController();
			const onToolAbort = () => batchController.abort(userCancellationReason());
			if (signal?.aborted) onToolAbort();
			else signal?.addEventListener("abort", onToolAbort, { once: true });

			// One summary list per task; the launcher appends every attempt, rate-limit retries included.
			const attemptsByTask = new Map<number, SubagentRunSummary[]>();
			// Deferred authoritative oracle of each coder task's latest attempt, run after the batch.
			const oracleByTask = new Map<number, (oracleSignal: AbortSignal | undefined) => Promise<SubagentRunSummary>>();
			const pendingAttempts = new Set<Promise<unknown>>();
			const coderTargets = tasks.flatMap((task) =>
				task.targetPath === undefined ? [] : [relative(project.root, task.targetPath)],
			);
			const summaryWithoutRun = (task: SwarmTaskData, outcome: SubagentOutcome, error: string) => ({
				runId: task.runId,
				kind: task.kind,
				roleName: task.role.name,
				roleIdentityHash: task.role.identityHash,
				provider: task.role.config.provider,
				model: task.role.config.model,
				...(task.role.requestedUpstream === undefined ? {} : { requestedUpstream: task.role.requestedUpstream }),
				servedUpstreams: [],
				upstreamMismatch: false,
				outcome,
				error,
				usage: zeroUsage(),
				turns: 0,
				startedAt: Date.now(),
				durationMs: 0,
				toolCalls: [],
				failedToolCalls: 0,
				scopeViolations: 0,
			});
			const launcher: SwarmBatchLauncher<SwarmTaskData, SubagentRunSummary> = {
				launch: async (launchOptions) => {
					const { signal: attemptSignal, onReady } = launchOptions;
					const task = launchOptions.task.data;
					const completion = (async (): Promise<SubagentRunSummary> => {
						let ready = false;
						const swarmOptions: SwarmAttemptOptions = {
							onReady: () => {
								ready = true;
								onReady();
							},
							ignorePaths: new Set(
								task.targetPath === undefined
									? coderTargets
									: coderTargets.filter((path) => path !== relative(project.root, task.targetPath!)),
							),
						};
						const attempts = attemptsByTask.get(task.index) ?? [];
						attemptsByTask.set(task.index, attempts);
						let built: Awaited<ReturnType<typeof buildCoderSummary>>;
						try {
							built =
								task.kind === "scout"
									? await buildScoutSummary(
											task.role,
											project,
											task.params as ScoutParams,
											attemptSignal,
											ctx,
											task.runId,
											swarmOptions,
										)
									: await buildCoderSummary(
											task.role,
											project,
											createWriteScope(project, (task.params as CodeFileParams).path),
											task.params as CodeFileParams,
											attemptSignal,
											ctx,
											task.runId,
											swarmOptions,
										);
						} catch (error) {
							// A crash around the run (snapshot, git, scope) is the task's result, never a retry:
							// a coder may already have written its target. Its usage, if any, is lost.
							const failed = summaryWithoutRun(
								task,
								"error",
								`Subagent failed: ${error instanceof Error ? error.message : String(error)}`,
							);
							attempts.push(failed);
							oracleByTask.delete(task.index);
							return failed;
						}
						attempts.push(built.summary);
						if (built.runOracle === undefined) oracleByTask.delete(task.index);
						else oracleByTask.set(task.index, built.runOracle);
						// Only a rate limit before the attempt produced anything is retryable: after
						// readiness a coder may already have written its target, so the failure is
						// surfaced as the task's result instead of re-run.
						if (built.run.rateLimit !== undefined && !ready) {
							throw new SwarmAttemptRateLimitError(built.summary.error ?? built.run.rateLimit.message);
						}
						return built.summary;
					})();
					pendingAttempts.add(completion);
					const forget = () => pendingAttempts.delete(completion);
					completion.then(forget, forget);
					return { id: randomUUID(), completion };
				},
			};

			const batchTasks: SwarmBatchTask<SwarmTaskData>[] = tasks.map((task) => ({
				data: task,
				// The runner enforces the role timeout itself (a "timeout" outcome); the grace period
				// keeps the scheduler's abort as a backstop for a wedged attempt rather than the norm.
				// Coder oracles run after the batch, so they are not inside this budget.
				timeout: task.role.budgets.timeoutMs + SWARM_TASK_TIMEOUT_GRACE_MS,
			}));
			let batchResults: Array<SwarmBatchRunResult<SwarmTaskData, SubagentRunSummary>>;
			try {
				batchResults = await new SwarmBatch(launcher, batchTasks, {
					signal: batchController.signal,
					maxConcurrency,
					isRateLimitError: (error) => error instanceof SwarmAttemptRateLimitError,
					// Session-wide per-host capacity replaces the batch's own: what this batch learns
					// about a host applies to later calls, and single calls share the same slots.
					admit: (task) => capacity.tryAcquire(roleCapacityKey((task.data as SwarmTaskData).role)),
					subscribeCapacity: (listener) => capacity.subscribe(listener),
				}).run();
			} catch (error) {
				// Not reachable for caller aborts (mapped to user cancellation above); keep a
				// per-task aborted shape anyway so the caller never sees a bare rejection.
				const message = error instanceof Error ? error.message : String(error);
				batchResults = tasks.map((task) => ({
					task: batchTasks[task.index]!,
					status: "aborted" as const,
					state: "not_started" as const,
					error: message,
				}));
			} finally {
				signal?.removeEventListener("abort", onToolAbort);
			}
			// Attempts aborted by a caller interrupt settle after the batch resolves; wait briefly so
			// their usage lands in the per-task aggregates and ledger records.
			if (pendingAttempts.size > 0) {
				await Promise.race([
					Promise.allSettled([...pendingAttempts]),
					new Promise((resolve) => setTimeout(resolve, SWARM_ABORT_SETTLE_MS)),
				]);
			}

			// Authoritative coder oracles run one at a time once every coder stopped editing, so no
			// oracle sees a sibling's half-written target and each one checks the final tree.
			for (const [index, runOracle] of oracleByTask) {
				const attempts = attemptsByTask.get(index)!;
				const last = attempts.length - 1;
				if (signal?.aborted) {
					attempts[last] = {
						...attempts[last]!,
						outcome: "aborted",
						error: "Interrupted before the oracle ran.",
					};
					continue;
				}
				try {
					attempts[last] = await runOracle(signal);
				} catch (error) {
					attempts[last] = {
						...attempts[last]!,
						outcome: "error",
						error: `Oracle failed to run: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}

			const summaries: SubagentRunSummary[] = batchResults.map((result, index) => {
				const task = tasks[index]!;
				const attempts = attemptsByTask.get(index) ?? [];
				const swarm = {
					index: index + 1,
					total: tasks.length,
					attempts: attempts.length,
					rateLimitRetries: Math.max(0, attempts.length - 1),
				};
				if (attempts.length > 0) {
					const aggregated = aggregateAttemptSummaries(attempts);
					const withBatchError =
						aggregated.error === undefined && result.error !== undefined
							? { ...aggregated, error: result.error }
							: aggregated;
					return { ...withBatchError, swarm };
				}
				// No attempt finished: the batch was interrupted first, or the launch itself failed.
				return {
					...summaryWithoutRun(
						task,
						result.status === "failed" ? "error" : "aborted",
						result.error ??
							"The subagent batch was interrupted before this task started; nothing ran and nothing was recorded.",
					),
					swarm,
				};
			});

			// One ledger record per task that actually ran, keyed by the task runId; never-started
			// tasks consumed nothing and are omitted.
			let ledgerWarning: string | undefined;
			for (const [index, summary] of summaries.entries()) {
				if ((summary.swarm?.attempts ?? 0) === 0) continue;
				const task = tasks[index]!;
				if (summary.kind === "coder" && summary.outcome !== "passed" && task.targetPath !== undefined) {
					releasedTargets.add(task.targetPath);
				}
				const warning = await complete(summary, ctx, toolCallId);
				if (warning !== undefined && ledgerWarning === undefined) ledgerWarning = warning;
			}
			const hosts = [...new Set(tasks.map((task) => roleCapacityKey(task.role)))];
			const concurrency = hosts.map((host) => concurrencyView(capacity.snapshot(host), now()));
			const details = {
				description: params.description,
				results: summaries,
				concurrency,
				...(ledgerWarning === undefined ? {} : { ledgerWarning }),
			};
			return {
				content: [{ type: "text" as const, text: renderSwarmText(params.description, summaries, concurrency) }],
				details,
				...(summaries.some((summary) => ERROR_OUTCOMES.has(summary.outcome)) ? { isError: true } : {}),
			};
		};

		const runVerdict = async (toolCallId: string, params: VerdictParams, ctx: ExtensionContext) => {
			const problem =
				validateText("runId", params.runId, 200, true) ??
				validateText("reason", params.reason, MAX_VERDICT_REASON_CHARS, true);
			if (problem) return errorResult(`Invalid verdict: ${problem}`);
			const run = findRunInBranch(ctx, params.runId);
			if (!run) {
				return errorResult(
					`Unknown runId ${params.runId}: no scout, code_file, or subagent_swarm result with that runId is in this session`,
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

		pi.on("tool_call", (event, ctx) => {
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			const subagents = pi.getSettings().subagents;
			const mode = delegationMode(subagents);
			if (mode === "auto" || !activeRoleNames(subagents).coder) return undefined;
			const path = (event.input as { path?: unknown }).path;
			const target = typeof path === "string" ? canonicalPath(resolve(ctx.cwd, path)) : undefined;
			if (target !== undefined && releasedTargets.has(target)) return undefined;
			// code_file cannot reach files outside the project scope (e.g. scratch probes in /tmp), so never gate them.
			const project = projectScopeOrError(ctx.cwd);
			if (target !== undefined && (typeof project === "string" || !project.isAllowed(target))) return undefined;
			const name = typeof path === "string" ? path : "this file";
			if (mode === "prefer") {
				// One reminder per file: repeating the call is the parent's judgment that a direct edit is necessary.
				if (target === undefined || remindedTargets.has(target)) return undefined;
				remindedTargets.add(target);
				return {
					block: true,
					reason: `Delegate this change: call ${CODE_FILE_TOOL_NAME} for ${name} with the change, contract, and a check command. If doing it yourself is really necessary, repeat the ${event.toolName} call and it will run.`,
				};
			}
			return {
				block: true,
				reason: `Delegation is required in this run: change ${name} with ${CODE_FILE_TOOL_NAME}. ${event.toolName} is allowed for a file only after ${CODE_FILE_TOOL_NAME} on it escalated or failed.`,
			};
		});

		// Learned host limits outlive a session switch in this process; only the timers stop here.
		pi.on("session_shutdown", () => capacity.dispose());

		pi.on("session_start", () => {
			releasedTargets.clear();
			remindedTargets.clear();
			const subagents = pi.getSettings().subagents;
			const active = activeRoleNames(subagents);
			const mode = delegationMode(subagents);
			if (active.scout) {
				pi.registerTool({
					name: SCOUT_TOOL_NAME,
					label: SCOUT_TOOL_NAME,
					description: SCOUT_DESCRIPTION,
					promptSnippet: SCOUT_SNIPPET,
					promptGuidelines: SCOUT_GUIDELINES[mode],
					parameters: scoutParameters,
					execute: (toolCallId, params, signal, _onUpdate, ctx) => runScout(toolCallId, params, signal, ctx),
				});
			}
			if (active.scout || active.coder) {
				pi.registerTool({
					name: SUBAGENT_VERDICT_TOOL_NAME,
					label: SUBAGENT_VERDICT_TOOL_NAME,
					description: VERDICT_DESCRIPTION,
					promptSnippet: VERDICT_SNIPPET,
					promptGuidelines: VERDICT_GUIDELINES,
					parameters: verdictParameters,
					execute: (toolCallId, params, _signal, _onUpdate, ctx) => runVerdict(toolCallId, params, ctx),
				});
				pi.registerTool({
					name: SUBAGENT_SWARM_TOOL_NAME,
					label: SUBAGENT_SWARM_TOOL_NAME,
					description: SWARM_DESCRIPTION,
					promptSnippet: SWARM_SNIPPET,
					promptGuidelines: SWARM_GUIDELINES[mode],
					parameters: subagentSwarmParameters,
					executionMode: "sequential",
					execute: (toolCallId, params, signal, _onUpdate, ctx) => runSwarm(toolCallId, params, signal, ctx),
				});
			}
			if (active.coder) {
				pi.registerTool({
					name: CODE_FILE_TOOL_NAME,
					label: CODE_FILE_TOOL_NAME,
					description: CODE_FILE_DESCRIPTION,
					promptSnippet: CODE_FILE_SNIPPET,
					promptGuidelines: CODE_FILE_GUIDELINES[mode],
					parameters: codeFileParameters,
					executionMode: "sequential",
					execute: (toolCallId, params, signal, _onUpdate, ctx) => runCoder(toolCallId, params, signal, ctx),
				});
			}
		});
	};
}

export default createSubagentsExtension({
	onRunComplete: recordSubagentRun,
	onVerdict: recordSubagentVerdict,
	onCapacityEvent: recordCapacityEvent,
});
