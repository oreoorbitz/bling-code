import type { HarnessProfile } from "../settings-manager.ts";
import type { LearningActionRecord } from "./action-store.ts";

export interface RoleUsage {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Reasoning tokens, a subset of `output`. Present only when some record reported a breakdown. */
	reasoning?: number;
}

/** Per delegated role (scout, coder) behavior counters for one arm. */
export interface SubagentRoleStats {
	runs: number;
	/** Tool calls that errored or were blocked, summed over runs (includes scope violations). */
	failedToolCalls: number;
	scopeViolations: number;
	/** Runs that ended with the coder's `escalate` tool. */
	escalations: number;
	/** escalations / runs. */
	escalationRate: number;
	/** Runs that exceeded the role's maxDiffLines. */
	diffTooLarge: number;
	/** Runs whose latest Ling verdict is accepted. */
	accepted: number;
	rejected: number;
	/** Runs with no verdict recorded. */
	unjudged: number;
	/** accepted / (accepted + rejected); null when no run has a verdict. */
	acceptanceRate: number | null;
	/** Time to first tool call over the runs that made one (nearest rank). */
	timeToFirstToolCallMs: WallClock | null;
}

export interface WallClock {
	p50: number;
	p95: number;
}

export interface ArmReport {
	armId: string;
	harnessProfile?: HarnessProfile;
	runs: number;
	passed: number;
	totalCost: number;
	costOfPass: number | null;
	costByRole: Record<string, RoleUsage>;
	subagentStats: Record<string, SubagentRoleStats>;
	wallClockMs: WallClock | null;
	passingWallClockMs: WallClock | null;
	subagentOutcomes: Record<string, number>;
	servedUpstreams: Record<string, Record<string, number>>;
	upstreamMismatches: number;
	/** Roles (or "primary") that recorded tokens but zero cost: pricing is probably missing, so cost figures are unreliable. */
	zeroCostRoles: string[];
	runsWithoutPrimaryAccounting: number;
}

export interface BenchmarkReport {
	arms: ArmReport[];
}

/** Nearest-rank percentile; undefined for an empty list. */
export function percentile(values: readonly number[], p: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1];
}

function wallClock(values: readonly number[]): WallClock | null {
	const p50 = percentile(values, 50);
	const p95 = percentile(values, 95);
	return p50 === undefined || p95 === undefined ? null : { p50, p95 };
}

function normalizeHost(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether an OpenRouter served-host name matches a requested upstream slug (family before "/"). */
export function upstreamMatches(requested: string, served: string): boolean {
	return normalizeHost(requested.split("/")[0] ?? "") === normalizeHost(served);
}

function emptyUsage(): RoleUsage {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(
	target: RoleUsage,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number },
	cost: number,
): void {
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
	target.calls += 1;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cost += cost;
}

function getOrCreate<T>(record: Record<string, T>, key: string, create: () => T): T {
	const existing = record[key];
	if (existing !== undefined) return existing;
	const created = create();
	record[key] = created;
	return created;
}

function count(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

interface RoleAccumulator {
	runs: Map<string, { escalated: boolean; diffTooLarge: boolean }>;
	failedToolCalls: number;
	scopeViolations: number;
	firstToolCallMs: number[];
}

interface ArmAccumulator {
	report: ArmReport;
	roles: Record<string, RoleAccumulator>;
	verdicts: Map<string, { verdict: "accepted" | "rejected"; timestamp: number }>;
	durations: number[];
	passingDurations: number[];
}

/**
 * Cost-of-pass by arm. A run is a `benchmark` ledger record; messages and subagent records that carry its
 * runId (injected into the child environment) are its linked actions. Assistant messages are role "primary".
 */
export function buildBenchmarkReport(
	actions: readonly LearningActionRecord[],
	options: { benchmarkId?: string } = {},
): BenchmarkReport {
	const linked = new Map<string, LearningActionRecord[]>();
	for (const action of actions) {
		if (action.kind === "benchmark" || !action.benchmarkRunId) continue;
		const list = linked.get(action.benchmarkRunId);
		if (list) list.push(action);
		else linked.set(action.benchmarkRunId, [action]);
	}
	const arms = new Map<string, ArmAccumulator>();
	for (const run of actions) {
		if (run.kind !== "benchmark" || (run.purpose ?? "benchmark") !== "benchmark") continue;
		if (options.benchmarkId !== undefined && run.benchmarkId !== options.benchmarkId) continue;
		const armId = run.armId ?? `${run.harnessProfile ?? "unrecorded"}:unlabeled:none`;
		let arm = arms.get(armId);
		if (!arm) {
			arm = {
				report: {
					armId,
					...(run.harnessProfile === undefined ? {} : { harnessProfile: run.harnessProfile }),
					runs: 0,
					passed: 0,
					totalCost: 0,
					costOfPass: null,
					costByRole: {},
					subagentStats: {},
					wallClockMs: null,
					passingWallClockMs: null,
					subagentOutcomes: {},
					servedUpstreams: {},
					upstreamMismatches: 0,
					zeroCostRoles: [],
					runsWithoutPrimaryAccounting: 0,
				},
				roles: {},
				verdicts: new Map(),
				durations: [],
				passingDurations: [],
			};
			arms.set(armId, arm);
		}
		const report = arm.report;
		const passed = run.passed && run.integrityPassed !== false;
		report.runs += 1;
		arm.durations.push(run.durationMs);
		if (passed) {
			report.passed += 1;
			arm.passingDurations.push(run.durationMs);
		}
		let primarySeen = false;
		for (const action of run.runId ? (linked.get(run.runId) ?? []) : []) {
			if (action.kind === "message") {
				if (action.message.role !== "assistant") continue;
				primarySeen = true;
				const usage = action.message.usage;
				addUsage(getOrCreate(report.costByRole, "primary", emptyUsage), usage, usage.cost.total);
				if (action.upstreamProvider) {
					count(
						getOrCreate(report.servedUpstreams, "primary", () => ({})),
						action.upstreamProvider,
					);
				}
			} else if (action.kind === "subagent") {
				addUsage(getOrCreate(report.costByRole, action.role, emptyUsage), action.usage, action.usage.cost);
				count(report.subagentOutcomes, action.outcome);
				for (const host of action.servedUpstreams) {
					count(
						getOrCreate(report.servedUpstreams, action.role, () => ({})),
						host,
					);
				}
				const roleStats = getOrCreate(arm.roles, action.role, () => ({
					runs: new Map(),
					failedToolCalls: 0,
					scopeViolations: 0,
					firstToolCallMs: [],
				}));
				roleStats.runs.set(action.runId, {
					escalated: action.outcome === "escalated",
					diffTooLarge: action.outcome === "diff_too_large",
				});
				roleStats.failedToolCalls += action.failedToolCalls ?? 0;
				roleStats.scopeViolations += action.scopeViolations;
				if (action.timeToFirstToolCallMs !== undefined)
					roleStats.firstToolCallMs.push(action.timeToFirstToolCallMs);
				const requested = action.requestedUpstream;
				if (requested && action.servedUpstreams.some((host) => !upstreamMatches(requested, host))) {
					report.upstreamMismatches += 1;
				}
			} else if (action.kind === "subagent_verdict") {
				// Verdicts are append-only; the latest one for a run decides.
				const previous = arm.verdicts.get(action.runId);
				if (!previous || action.timestamp >= previous.timestamp) {
					arm.verdicts.set(action.runId, { verdict: action.verdict, timestamp: action.timestamp });
				}
			}
		}
		if (!primarySeen) report.runsWithoutPrimaryAccounting += 1;
	}
	const result: ArmReport[] = [];
	for (const { report, roles, verdicts, durations, passingDurations } of arms.values()) {
		for (const [role, accumulator] of Object.entries(roles)) {
			let accepted = 0;
			let rejected = 0;
			let escalations = 0;
			let diffTooLarge = 0;
			for (const [runId, run] of accumulator.runs) {
				if (run.escalated) escalations += 1;
				if (run.diffTooLarge) diffTooLarge += 1;
				const verdict = verdicts.get(runId)?.verdict;
				if (verdict === "accepted") accepted += 1;
				else if (verdict === "rejected") rejected += 1;
			}
			const runs = accumulator.runs.size;
			report.subagentStats[role] = {
				runs,
				failedToolCalls: accumulator.failedToolCalls,
				scopeViolations: accumulator.scopeViolations,
				escalations,
				escalationRate: runs === 0 ? 0 : escalations / runs,
				diffTooLarge,
				accepted,
				rejected,
				unjudged: runs - accepted - rejected,
				acceptanceRate: accepted + rejected === 0 ? null : accepted / (accepted + rejected),
				timeToFirstToolCallMs: wallClock(accumulator.firstToolCallMs),
			};
		}
		report.zeroCostRoles = Object.entries(report.costByRole)
			.filter(([, usage]) => usage.cost === 0 && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0)
			.map(([role]) => role)
			.sort();
		report.totalCost = Object.values(report.costByRole).reduce((sum, usage) => sum + usage.cost, 0);
		report.costOfPass = report.passed > 0 ? report.totalCost / report.passed : null;
		report.wallClockMs = wallClock(durations);
		report.passingWallClockMs = wallClock(passingDurations);
		result.push(report);
	}
	result.sort((a, b) => a.armId.localeCompare(b.armId));
	return { arms: result };
}
