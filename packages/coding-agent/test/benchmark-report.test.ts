import { describe, expect, it } from "vitest";
import {
	createBenchmarkAction,
	createMessageAction,
	createSubagentAction,
	createSubagentVerdictAction,
	type LearningActionRecord,
	type LearningBenchmarkActionInput,
	type LearningSubagentActionInput,
} from "../src/core/learning/action-store.ts";
import { buildBenchmarkReport, percentile, upstreamMatches } from "../src/core/learning/benchmark-report.ts";

const CWD = "/tmp/benchmark-report-project";
let counter = 0;

function run(overrides: Partial<LearningBenchmarkActionInput> & { runId: string }): LearningActionRecord {
	counter += 1;
	return createBenchmarkAction(CWD, {
		benchmarkId: "bench_0123456789abcdef0123456789abcdef",
		benchmarkName: "oracle",
		definitionHash: "a".repeat(64),
		command: "node",
		args: [],
		cwd: CWD,
		startedAt: counter,
		durationMs: 100,
		exitCode: 0,
		timedOut: false,
		stdout: "",
		stderr: "",
		passed: true,
		checks: [],
		purpose: "benchmark",
		harnessProfile: "bling",
		armId: "bling:arm-a:aaaaaaaa",
		...overrides,
	});
}

function primary(runId: string, cost: number, extra: { upstreamProvider?: string } = {}): LearningActionRecord {
	counter += 1;
	return createMessageAction(
		CWD,
		`session-${runId}`,
		{
			role: "assistant",
			content: [{ type: "text", text: `turn ${counter}` }],
			api: "openai-completions",
			provider: "openrouter",
			model: "ling",
			...(extra.upstreamProvider ? { responseProvider: extra.upstreamProvider } : {}),
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 5,
				totalTokens: 165,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop",
			timestamp: counter,
		},
		"bling",
		runId,
	);
}

function subagent(runId: string, overrides: Partial<LearningSubagentActionInput> = {}): LearningActionRecord {
	counter += 1;
	return createSubagentAction(CWD, {
		runId: `sub-${counter}`,
		role: "scout",
		roleName: "scout-a",
		roleIdentityHash: "0123456789ab",
		provider: "openrouter",
		model: "inception/mercury-3",
		requestedUpstream: "inception",
		servedUpstreams: ["Inception"],
		outcome: "completed",
		usage: { input: 1000, output: 100, cacheRead: 10, cacheWrite: 1, totalTokens: 1111, cost: 0.002 },
		turns: 3,
		startedAt: counter,
		durationMs: 50,
		scopeViolations: 0,
		parentSessionId: `session-${runId}`,
		parentToolCallId: `call-${counter}`,
		benchmarkRunId: runId,
		...overrides,
	});
}

function verdict(
	benchmarkRunId: string,
	subagentRunId: string,
	value: "accepted" | "rejected",
	decidedAt: number,
	role: "scout" | "coder" = "coder",
): LearningActionRecord {
	counter += 1;
	return createSubagentVerdictAction(CWD, {
		runId: subagentRunId,
		verdict: value,
		reason: "because",
		role,
		roleName: `${role}-a`,
		decidedAt,
		parentSessionId: `session-${benchmarkRunId}`,
		parentToolCallId: `verdict-call-${counter}`,
		benchmarkRunId,
	});
}

describe("percentile", () => {
	it("uses nearest rank", () => {
		const values = [50, 10, 40, 20, 30, 60, 70, 80, 90, 100];
		expect(percentile(values, 50)).toBe(50);
		expect(percentile(values, 95)).toBe(100);
		expect(percentile(values, 10)).toBe(10);
		expect(percentile([7], 95)).toBe(7);
		expect(percentile([], 50)).toBeUndefined();
	});
});

describe("upstreamMatches", () => {
	it("compares the slug family with the served host name ignoring case and punctuation", () => {
		expect(upstreamMatches("novita", "Novita")).toBe(true);
		expect(upstreamMatches("chutes/fp8", "Chutes")).toBe(true);
		expect(upstreamMatches("deepinfra/bf16", "DeepInfra")).toBe(true);
		expect(upstreamMatches("novita", "Chutes")).toBe(false);
	});
});

describe("buildBenchmarkReport", () => {
	it("computes cost-of-pass per arm across roles, including failed runs", () => {
		const records: LearningActionRecord[] = [
			// arm A: three runs, two pass. Costs: run1 0.10 + 0.02, run2 0.20, run3 (failed) 0.30 + 0.01.
			run({ runId: "a1", durationMs: 100 }),
			primary("a1", 0.1),
			subagent("a1", { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.02 } }),
			run({ runId: "a2", durationMs: 200 }),
			primary("a2", 0.2),
			run({ runId: "a3", durationMs: 300, passed: false, exitCode: 1 }),
			primary("a3", 0.3),
			subagent("a3", {
				role: "coder",
				outcome: "oracle_failed",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.01 },
			}),
			// arm B: one run, passes, cost 0.5.
			run({ runId: "b1", armId: "bling:arm-b:bbbbbbbb", durationMs: 1000 }),
			primary("b1", 0.5),
		];
		const { arms } = buildBenchmarkReport(records);
		expect(arms.map((arm) => arm.armId)).toEqual(["bling:arm-a:aaaaaaaa", "bling:arm-b:bbbbbbbb"]);
		const [a, b] = arms;
		expect(a.runs).toBe(3);
		expect(a.passed).toBe(2);
		expect(a.totalCost).toBeCloseTo(0.63, 10);
		expect(a.costOfPass).toBeCloseTo(0.315, 10);
		expect(a.costByRole.primary).toMatchObject({ calls: 3, input: 300, output: 30, cacheRead: 150, cacheWrite: 15 });
		expect(a.costByRole.primary.cost).toBeCloseTo(0.6, 10);
		expect(a.costByRole.scout.cost).toBeCloseTo(0.02, 10);
		expect(a.costByRole.coder.cost).toBeCloseTo(0.01, 10);
		expect(a.subagentOutcomes).toEqual({ completed: 1, oracle_failed: 1 });
		expect(a.wallClockMs).toEqual({ p50: 200, p95: 300 });
		expect(a.passingWallClockMs).toEqual({ p50: 100, p95: 200 });
		expect(a.runsWithoutPrimaryAccounting).toBe(0);
		expect(b.costOfPass).toBeCloseTo(0.5, 10);
		expect(b.wallClockMs).toEqual({ p50: 1000, p95: 1000 });
	});

	it("reports null cost-of-pass and null passing wall-clock when nothing passed", () => {
		const { arms } = buildBenchmarkReport([
			run({ runId: "x1", passed: false }),
			primary("x1", 0.4),
			run({ runId: "x2", passed: true, integrityPassed: false }),
			primary("x2", 0.1),
		]);
		expect(arms[0].passed).toBe(0);
		expect(arms[0].totalCost).toBeCloseTo(0.5, 10);
		expect(arms[0].costOfPass).toBeNull();
		expect(arms[0].passingWallClockMs).toBeNull();
		expect(arms[0].wallClockMs).not.toBeNull();
	});

	it("takes nearest-rank p50 and p95 over wall-clock times", () => {
		const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
		const records = durations.flatMap((durationMs, index) => [
			run({ runId: `w${index}`, durationMs }),
			primary(`w${index}`, 0),
		]);
		const { arms } = buildBenchmarkReport(records);
		expect(arms[0].wallClockMs).toEqual({ p50: 50, p95: 1000 });
	});

	it("flags a served host that differs from the requested pin, and accepts a case difference", () => {
		const { arms } = buildBenchmarkReport([
			run({ runId: "u1" }),
			primary("u1", 0.1, { upstreamProvider: "Novita" }),
			subagent("u1", { requestedUpstream: "novita", servedUpstreams: ["Novita"] }),
			subagent("u1", { requestedUpstream: "novita", servedUpstreams: ["Chutes"] }),
			subagent("u1", { requestedUpstream: "novita", servedUpstreams: ["Novita", "Chutes"] }),
		]);
		expect(arms[0].upstreamMismatches).toBe(2);
		expect(arms[0].servedUpstreams.scout).toEqual({ Novita: 2, Chutes: 2 });
		expect(arms[0].servedUpstreams.primary).toEqual({ Novita: 1 });
	});

	it("flags roles that have tokens but zero cost", () => {
		const zero = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: 0 };
		const { arms } = buildBenchmarkReport([
			run({ runId: "z1" }),
			primary("z1", 0.1),
			subagent("z1", { usage: zero }),
		]);
		expect(arms[0].zeroCostRoles).toEqual(["scout"]);
		const clean = buildBenchmarkReport([run({ runId: "z2" }), primary("z2", 0.1), subagent("z2")]);
		expect(clean.arms[0].zeroCostRoles).toEqual([]);
	});

	it("counts runs with no linked assistant messages", () => {
		const { arms } = buildBenchmarkReport([
			run({ runId: "n1" }),
			run({ runId: "n2" }),
			primary("n2", 0.1),
			run({ runId: "n3" }),
			subagent("n3"),
		]);
		expect(arms[0].runs).toBe(3);
		expect(arms[0].runsWithoutPrimaryAccounting).toBe(2);
	});

	it("excludes positive and negative controls, and filters by benchmark id", () => {
		const other = "bench_ffffffffffffffffffffffffffffffff";
		const { arms } = buildBenchmarkReport(
			[
				run({ runId: "c1", purpose: "positive-control" }),
				run({ runId: "c2", purpose: "negative-control", passed: false }),
				run({ runId: "c3" }),
				primary("c3", 0.1),
				run({ runId: "c4", benchmarkId: other }),
				primary("c4", 0.9),
			],
			{ benchmarkId: "bench_0123456789abcdef0123456789abcdef" },
		);
		expect(arms[0].runs).toBe(1);
		expect(arms[0].totalCost).toBeCloseTo(0.1, 10);
		expect(buildBenchmarkReport([run({ runId: "only-control", purpose: "positive-control" })]).arms).toEqual([]);
	});

	it("ignores linked records of runs that are not reported and unlinked records", () => {
		const { arms } = buildBenchmarkReport([
			run({ runId: "k1" }),
			primary("k1", 0.1),
			primary("someone-else", 5),
			subagent("someone-else", {
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 7 },
			}),
		]);
		expect(arms[0].totalCost).toBeCloseTo(0.1, 10);
	});

	it("groups records without an arm id under a fallback arm for their profile", () => {
		const legacy = createBenchmarkAction(CWD, {
			benchmarkId: "bench_0123456789abcdef0123456789abcdef",
			benchmarkName: "oracle",
			definitionHash: "a".repeat(64),
			command: "node",
			args: [],
			cwd: CWD,
			startedAt: 1,
			durationMs: 10,
			exitCode: 0,
			timedOut: false,
			stdout: "",
			stderr: "",
			passed: true,
			checks: [],
			harnessProfile: "stock",
		});
		const unprofiled = createBenchmarkAction(CWD, {
			benchmarkId: "bench_0123456789abcdef0123456789abcdef",
			benchmarkName: "oracle",
			definitionHash: "a".repeat(64),
			command: "node",
			args: [],
			cwd: CWD,
			startedAt: 2,
			durationMs: 10,
			exitCode: 0,
			timedOut: false,
			stdout: "",
			stderr: "",
			passed: true,
			checks: [],
		});
		const { arms } = buildBenchmarkReport([legacy, unprofiled]);
		expect(arms.map((arm) => arm.armId)).toEqual(["stock:unlabeled:none", "unrecorded:unlabeled:none"]);
		expect(arms.map((arm) => arm.runsWithoutPrimaryAccounting)).toEqual([1, 1]);
	});

	it("totals reasoning tokens per role and leaves the field absent when nothing reported it", () => {
		const records: LearningActionRecord[] = [
			run({ runId: "r1" }),
			primary("r1", 0.1),
			subagent("r1", {
				usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: 0.01, reasoning: 60 },
			}),
			subagent("r1", {
				usage: { input: 1, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 51, cost: 0.01, reasoning: 0 },
			}),
			subagent("r1", {
				role: "coder",
				usage: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: 0.01 },
			}),
		];
		const [arm] = buildBenchmarkReport(records).arms;
		expect(arm.costByRole.scout.reasoning).toBe(60);
		expect(arm.costByRole.scout.output).toBe(150);
		expect("reasoning" in arm.costByRole.coder).toBe(false);
		expect("reasoning" in arm.costByRole.primary).toBe(false);
	});

	it("includes primary reasoning tokens when the message reports them", () => {
		const message = primary("p1", 0.1) as Extract<LearningActionRecord, { kind: "message" }>;
		if (message.message.role !== "assistant") throw new Error("expected assistant message");
		message.message.usage.reasoning = 7;
		const [arm] = buildBenchmarkReport([run({ runId: "p1" }), message]).arms;
		expect(arm.costByRole.primary.reasoning).toBe(7);
	});

	it("reports per-role escalation rate, failed tool calls, scope violations and time to first tool call", () => {
		const coder = (runId: string, outcome: string, extra: Partial<LearningSubagentActionInput> = {}) =>
			subagent(runId, { role: "coder", outcome, ...extra });
		const records: LearningActionRecord[] = [
			run({ runId: "c1" }),
			primary("c1", 0.1),
			coder("c1", "passed", { failedToolCalls: 1, timeToFirstToolCallMs: 100 }),
			coder("c1", "escalated", { failedToolCalls: 2, scopeViolations: 1, timeToFirstToolCallMs: 300 }),
			coder("c1", "diff_too_large", { timeToFirstToolCallMs: 200 }),
			// A record from before these fields existed contributes runs only.
			coder("c1", "oracle_failed"),
			subagent("c1", { failedToolCalls: 3, timeToFirstToolCallMs: 40 }),
		];
		const { subagentStats } = buildBenchmarkReport(records).arms[0];
		expect(subagentStats.coder).toMatchObject({
			runs: 4,
			failedToolCalls: 3,
			scopeViolations: 1,
			escalations: 1,
			escalationRate: 0.25,
			diffTooLarge: 1,
			timeToFirstToolCallMs: { p50: 200, p95: 300 },
		});
		expect(subagentStats.scout).toMatchObject({ runs: 1, failedToolCalls: 3, escalations: 0, escalationRate: 0 });
		expect(subagentStats.scout.timeToFirstToolCallMs).toEqual({ p50: 40, p95: 40 });
	});

	it("computes acceptance rate per role from verdicts, the latest verdict wins, and counts unjudged runs", () => {
		const coder = (runId: string, subRunId: string) => subagent(runId, { runId: subRunId, role: "coder" });
		const records: LearningActionRecord[] = [
			run({ runId: "v1" }),
			primary("v1", 0.1),
			coder("v1", "s-a"),
			coder("v1", "s-b"),
			coder("v1", "s-c"),
			coder("v1", "s-d"),
			subagent("v1", { runId: "s-scout" }),
			verdict("v1", "s-a", "accepted", 10),
			verdict("v1", "s-b", "rejected", 11),
			// s-c: rejected first, then accepted: the later decision stands.
			verdict("v1", "s-c", "rejected", 12),
			verdict("v1", "s-c", "accepted", 13),
			// s-d has no verdict. A verdict for a run with no subagent record is ignored.
			verdict("v1", "s-unknown", "accepted", 14),
		];
		const { subagentStats } = buildBenchmarkReport(records).arms[0];
		expect(subagentStats.coder).toMatchObject({
			runs: 4,
			accepted: 2,
			rejected: 1,
			unjudged: 1,
			acceptanceRate: 2 / 3,
		});
		expect(subagentStats.scout).toMatchObject({ accepted: 0, rejected: 0, unjudged: 1, acceptanceRate: null });
	});

	it("keeps verdict statistics per arm", () => {
		const records: LearningActionRecord[] = [
			run({ runId: "a1" }),
			primary("a1", 0.1),
			subagent("a1", { runId: "sa", role: "coder" }),
			verdict("a1", "sa", "accepted", 1),
			run({ runId: "b1", armId: "bling:arm-b:bbbbbbbb" }),
			primary("b1", 0.1),
			subagent("b1", { runId: "sb", role: "coder" }),
			verdict("b1", "sb", "rejected", 1),
		];
		const { arms } = buildBenchmarkReport(records);
		expect(arms.map((arm) => arm.subagentStats.coder.acceptanceRate)).toEqual([1, 0]);
	});

	it("reports no subagent stats for arms without subagent records", () => {
		const { arms } = buildBenchmarkReport([run({ runId: "n1" }), primary("n1", 0.1)]);
		expect(arms[0].subagentStats).toEqual({});
	});
});
