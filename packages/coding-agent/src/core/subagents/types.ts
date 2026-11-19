import type { RoleKind } from "./roles.ts";

export type SubagentOutcome =
	| "completed"
	| "passed"
	| "oracle_failed"
	| "escalated"
	| "diff_too_large"
	| "no_change"
	| "error"
	| "aborted"
	| "timeout"
	| "budget_turns"
	| "budget_tokens"
	| "budget_context"
	| "budget_cost"
	| "budget_output"
	| "no_report";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	/**
	 * Reasoning tokens, a subset of `output` (already billed inside it). Present only when the provider reported a
	 * reasoning breakdown on at least one response.
	 */
	reasoning?: number;
}

export interface SubagentToolCallRecord {
	tool: string;
	args: string;
	isError: boolean;
}

export interface EvidenceItem {
	path: string;
	startLine: number;
	endLine: number;
	quote?: string;
	/** Set by the harness: the file exists inside the project and the range is within it. */
	verified: boolean;
}

export type Confidence = "high" | "medium" | "low";

export interface ScoutFinding {
	claim: string;
	evidence: EvidenceItem[];
	confidence: Confidence;
}

export interface ScoutReport {
	findings: ScoutFinding[];
	unresolved: string[];
	suggestedNextAction?: string;
	confidence: Confidence;
}

export interface OracleRunResult {
	command: string;
	args: string[];
	exitCode: number | null;
	passed: boolean;
	timedOut: boolean;
	durationMs: number;
	outputTail: string;
	/** How many times the child itself ran the oracle before the harness ran the authoritative one. */
	childRuns: number;
}

export type EscalationReason = "scope_expansion" | "unresolved_failure" | "ambiguous_spec";

/** The coder's terminal `escalate` call: it stopped on purpose and hands the decision back to Ling. */
export interface CoderEscalation {
	reason: EscalationReason;
	detail: string;
	filesNeeded?: string[];
}

export interface CoderReport {
	path: string;
	changed: boolean;
	diff: string;
	beforeSha256: string | undefined;
	afterSha256: string | undefined;
	/** Changed lines in the target: lines added plus lines removed. */
	diffLines: number;
	summary: string;
	uncertainties: string[];
	interfaceChanges: string[];
	oracle?: OracleRunResult;
	escalation?: CoderEscalation;
	outsideTargetChanges?: string[];
}

/** Present on summaries produced by the `subagent_swarm` tool: task position and per-task attempt accounting. */
export interface SubagentSwarmInfo {
	/** 1-based position of this task in the subagent_swarm call's tasks array. */
	index: number;
	/** Total number of tasks in the call. */
	total: number;
	/** Attempts this task ran, including startup rate-limit retries. */
	attempts: number;
	/** How many of those attempts were startup rate-limit retries. */
	rateLimitRetries: number;
}

export interface SubagentRunSummary {
	runId: string;
	kind: RoleKind;
	roleName: string;
	roleIdentityHash: string;
	provider: string;
	model: string;
	requestedUpstream?: string;
	servedUpstreams: string[];
	/** A served host does not match `requestedUpstream` (same matching rule as the benchmark report). */
	upstreamMismatch: boolean;
	outcome: SubagentOutcome;
	error?: string;
	usage: SubagentUsage;
	turns: number;
	startedAt: number;
	durationMs: number;
	toolCalls: SubagentToolCallRecord[];
	/** Milliseconds from the run start until the first assistant message that contained a tool call. */
	timeToFirstToolCallMs?: number;
	/** Tool calls that errored or were blocked (scope violations are included; `scopeViolations` counts only those). */
	failedToolCalls: number;
	scopeViolations: number;
	rawText?: string;
	scout?: ScoutReport & { treeChanged?: boolean };
	coder?: CoderReport;
	/** Set on results of the subagent_swarm tool; absent on scout/code_file runs. */
	swarm?: SubagentSwarmInfo;
	/** Set on the tool result details only, when the ledger write failed. Not part of the stored record. */
	ledgerWarning?: string;
}
