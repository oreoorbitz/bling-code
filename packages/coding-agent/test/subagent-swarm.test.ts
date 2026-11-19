import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { SWARM_MAX_CONCURRENCY_ENV } from "../src/core/subagents/swarm-batch.ts";
import type { SubagentRunSummary } from "../src/core/subagents/types.ts";
import {
	CODE_FILE_TOOL_NAME,
	createSubagentsExtension,
	MAX_SWARM_RESULT_CHARS,
	MAX_SWARM_TASKS,
	renderSwarmText,
	SCOUT_TOOL_NAME,
	SUBAGENT_SWARM_TOOL_NAME,
	SUBAGENT_VERDICT_TOOL_NAME,
	type SubagentRunCompleteHook,
	type SubagentVerdictHook,
} from "../src/extensions/subagents/index.ts";
import { fauxStreamer, registerFaux, roleConfig } from "./subagent-test-utils.ts";

const node = process.execPath;
const registrations: Array<{ unregister(): void }> = [];
let base: string;
let root: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "subagent-swarm-")));
	root = join(base, "project");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
	writeFileSync(join(root, "src", "other.ts"), "other\n");
	writeFileSync(join(base, "secret.txt"), "secret\n");
	symlinkSync(join(base, "secret.txt"), join(root, "src", "link.txt"));
});

afterEach(() => {
	delete process.env[SWARM_MAX_CONCURRENCY_ENV];
	while (registrations.length > 0) registrations.pop()?.unregister();
	rmSync(base, { recursive: true, force: true });
});

interface SetupOptions {
	subagents?: Settings["subagents"];
	fauxOptions?: Parameters<typeof registerFaux>[0];
	onRunComplete?: SubagentRunCompleteHook;
	onVerdict?: SubagentVerdictHook;
}

const SCOUT_ONLY: Settings["subagents"] = {
	active: { scout: "scout-a" },
	roles: { "scout-a": roleConfig("scout", { upstream: "chutes/fp8" }) },
};

const BOTH: Settings["subagents"] = {
	active: { scout: "scout-a", coder: "coder-a" },
	roles: {
		"scout-a": roleConfig("scout", { upstream: "chutes/fp8" }),
		"coder-a": roleConfig("coder", { upstream: "cerebras", sampling: { temperature: 0.1 } }),
	},
};

function setup(options: SetupOptions = {}) {
	const faux = registerFaux(options.fauxOptions);
	registrations.push(faux);
	const settings = { subagents: options.subagents } as Settings;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler),
		getSettings: () => settings,
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
	} as unknown as ExtensionAPI;
	createSubagentsExtension({ onRunComplete: options.onRunComplete, onVerdict: options.onVerdict })(api);
	handlers.get("session_start")?.();
	const streamer = fauxStreamer();
	/** The active session branch as the verdict tool sees it. Tests append the tool results of earlier calls. */
	const branch: unknown[] = [];
	const ctx = {
		cwd: root,
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-test" },
		modelRegistry: {
			find: () => faux.getModel(),
			hasConfiguredAuth: () => true,
			streamSimple: streamer.streamSimple,
		},
	} as unknown as ExtensionContext;
	const run = async (name: string, params: unknown, signal?: AbortSignal) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`tool ${name} not registered`);
		return tool.execute(`call-${name}`, params as never, signal, undefined, ctx as never);
	};
	return { faux, settings, tools, run, ctx, branch };
}

interface SwarmDetails {
	description: string;
	results: SubagentRunSummary[];
	ledgerWarning?: string;
}

function swarmDetails(result: { details?: unknown }): SwarmDetails {
	return result.details as SwarmDetails;
}

/** A session entry holding a finished subagent tool result, as the session manager stores it. */
function toolResultEntry(toolName: string, details: unknown) {
	return { type: "message", message: { role: "toolResult", toolName, toolCallId: "x", content: [], details } };
}

function toolCall(name: string, args: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

const finish = { summary: "done", uncertainties: ["maybe"], interfaceChanges: [] };
const EMPTY_REPORT = { findings: [], unresolved: [], confidence: "low" };
const ORACLE_CONTAINS_TWO = {
	command: node,
	args: ["-e", "process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('TWO') ? 0 : 1)"],
};
const ORACLE_ALWAYS_PASSES = { command: node, args: ["-e", "process.exit(0)"] };

const scoutTask = (question: string) => ({ kind: "scout", question });
const coderTask = (path: string, change = "change it") => ({
	kind: "coder",
	path,
	change,
	oracle: ORACLE_ALWAYS_PASSES,
});
const swarmParams = (tasks: unknown[], description = "batch") => ({ description, tasks });

/** Text of the user messages of a request, for factories that branch on the brief. */
function userPrompt(context: TranscriptContext): string {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
		)
		.join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a test condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("registration", () => {
	it("registers subagent_swarm with any active role and runs it sequentially", () => {
		const { tools } = setup({ subagents: BOTH });
		const swarm = tools.get(SUBAGENT_SWARM_TOOL_NAME);
		expect(swarm).toBeDefined();
		expect(swarm?.executionMode).toBe("sequential");
		expect(swarm?.description).toContain("2 to 128");
		expect(swarm?.description).toContain(SUBAGENT_VERDICT_TOOL_NAME);
		expect([...setup({ subagents: SCOUT_ONLY }).tools.keys()].sort()).toEqual([
			SCOUT_TOOL_NAME,
			SUBAGENT_SWARM_TOOL_NAME,
			SUBAGENT_VERDICT_TOOL_NAME,
		]);
		expect([...setup({ subagents: undefined }).tools.keys()]).toEqual([]);
	});
});

describe("preflight validation", () => {
	it("rejects fewer than two or more than 128 tasks without a request", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([fauxAssistantMessage("never")]);
		const one = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("q")]));
		const many = await run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams(Array.from({ length: 129 }, (_, index) => scoutTask(`q${index}`))),
		);
		for (const result of [one, many]) {
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain("tasks");
		}
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects invalid briefs before starting anything, naming the task", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([fauxAssistantMessage("never")]);
		const result = await run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams([
				scoutTask("fine"),
				{ kind: "scout", question: "" },
				coderTask("../outside.ts"),
				{ kind: "unknown", question: "q" },
			]),
		);
		expect(result.isError).toBe(true);
		const text = JSON.stringify(result.content);
		expect(text).toContain("Task 2");
		expect(text).toContain("Task 3");
		expect(text).toContain("Task 4");
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects duplicate coder targets before starting anything", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([fauxAssistantMessage("never")]);
		const result = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([coderTask("src/a.ts"), coderTask("./src/a.ts")]));
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("distinct targets");
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects a batch needing a role that is not active", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		faux.setResponses([fauxAssistantMessage("never")]);
		const result = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("q"), coderTask("src/a.ts")]));
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("not_configured");
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects an invalid BLING_SWARM_MAX_CONCURRENCY without a request", async () => {
		process.env[SWARM_MAX_CONCURRENCY_ENV] = "zero";
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([fauxAssistantMessage("never")]);
		const result = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("a"), scoutTask("b")]));
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(SWARM_MAX_CONCURRENCY_ENV);
		expect(faux.state.callCount).toBe(0);
	});
});

describe("scheduling and concurrency", () => {
	it("starts every task at once when no concurrency cap is set", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		let entered = 0;
		faux.setResponses(
			Array.from({ length: 4 }, () => () => {
				entered += 1;
				return toolCall("report", EMPTY_REPORT);
			}),
		);
		const result = await run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams([scoutTask("q1"), scoutTask("q2"), scoutTask("q3"), scoutTask("q4")]),
		);
		expect(result.isError).toBeUndefined();
		expect(entered).toBe(4);
		expect(swarmDetails(result).results.map((summary) => summary.outcome)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
		]);
	});

	it("caps simultaneous subagents at BLING_SWARM_MAX_CONCURRENCY", async () => {
		process.env[SWARM_MAX_CONCURRENCY_ENV] = "2";
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		const gates: Array<() => void> = [];
		let entered = 0;
		faux.setResponses(
			Array.from({ length: 4 }, () => () => {
				entered += 1;
				return new Promise<ReturnType<typeof toolCall>>((resolve) => {
					gates.push(() => resolve(toolCall("report", EMPTY_REPORT)));
				});
			}),
		);
		const runPromise = run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams([scoutTask("q1"), scoutTask("q2"), scoutTask("q3"), scoutTask("q4")]),
		);
		await waitFor(() => entered === 2);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(entered).toBe(2);
		for (const release of gates.splice(0, 2)) release();
		await waitFor(() => entered === 4);
		for (const release of gates.splice(0, 2)) release();
		const result = await runPromise;
		expect(result.isError).toBeUndefined();
		expect(swarmDetails(result).results).toHaveLength(4);
	});
});

describe("results, ledger, and verdicts", () => {
	it("returns results in task order, writes one ledger record per task, and keeps verdicts working", async () => {
		const completed: SubagentRunSummary[] = [];
		const verdicts: unknown[] = [];
		const { faux, run, branch } = setup({
			subagents: BOTH,
			onRunComplete: (summary) => {
				completed.push(summary);
			},
			onVerdict: (verdict) => {
				verdicts.push(verdict);
			},
		});
		let coderRequests = 0;
		faux.setResponses(
			Array.from({ length: 3 }, () => (context: TranscriptContext) => {
				const text = userPrompt(context);
				if (text.includes("Target file")) {
					coderRequests += 1;
					return coderRequests % 2 === 1
						? toolCall("edit", { path: "src/a.ts", edits: [{ oldText: "two", newText: "TWO" }] })
						: toolCall("finish", finish);
				}
				return text.includes("where is A")
					? toolCall("report", {
							findings: [{ claim: "answer A", confidence: "high", evidence: [] }],
							unresolved: [],
							confidence: "high",
						})
					: toolCall("report", EMPTY_REPORT);
			}),
		);
		const params = swarmParams([
			{ kind: "scout", question: "where is A" },
			{ kind: "coder", path: "src/a.ts", change: "uppercase two", oracle: ORACLE_CONTAINS_TWO },
		]);
		const result = await run(SUBAGENT_SWARM_TOOL_NAME, params);
		expect(result.isError).toBeUndefined();
		const details = swarmDetails(result);
		expect(details.description).toBe("batch");
		expect(details.results).toHaveLength(2);
		const [scoutSummary, coderSummary] = details.results;
		// Results are in task order, each with its own runId and role.
		expect(scoutSummary.outcome).toBe("completed");
		expect(scoutSummary.scout?.findings[0]?.claim).toBe("answer A");
		expect(scoutSummary.roleName).toBe("scout-a");
		expect(coderSummary.outcome).toBe("passed");
		expect(coderSummary.coder?.diff).toContain("+TWO");
		expect(coderSummary.roleName).toBe("coder-a");
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
		for (const [index, summary] of details.results.entries()) {
			expect(summary.swarm).toEqual({ index: index + 1, total: 2, attempts: 1, rateLimitRetries: 0 });
			expect(typeof summary.runId).toBe("string");
		}
		expect(details.results[0]?.runId).not.toBe(details.results[1]?.runId);

		// The text Ling sees is bounded JSON with the same outcomes.
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeLessThanOrEqual(MAX_SWARM_RESULT_CHARS);
		const parsed = JSON.parse(text) as { total: number; completed: number; results: Array<{ runId: string }> };
		expect(parsed.total).toBe(2);
		expect(parsed.completed).toBe(2);
		expect(parsed.results.map((entry) => entry.runId)).toEqual(details.results.map((summary) => summary.runId));

		// One ledger record per task, not per request.
		expect(completed.map((summary) => summary.runId)).toEqual(details.results.map((summary) => summary.runId));

		// subagent_verdict resolves both runIds from the swarm result on the branch.
		branch.push(toolResultEntry(SUBAGENT_SWARM_TOOL_NAME, details));
		for (const [runId, role, roleName] of [
			[scoutSummary.runId, "scout", "scout-a"],
			[coderSummary.runId, "coder", "coder-a"],
		] as const) {
			const verdict = await run(SUBAGENT_VERDICT_TOOL_NAME, { runId, verdict: "accepted", reason: "used it" });
			expect(verdict.isError).toBeUndefined();
			expect(verdicts).toContainEqual({ runId, verdict: "accepted", reason: "used it", role, roleName });
		}
		const unknown = await run(SUBAGENT_VERDICT_TOOL_NAME, {
			runId: "nope",
			verdict: "rejected",
			reason: "r",
		});
		expect(unknown.isError).toBe(true);
	});

	it("keeps the single scout and code_file tools working after a swarm call", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		let coderRequests = 0;
		faux.setResponses(
			Array.from({ length: 4 }, () => (context: TranscriptContext) => {
				if (userPrompt(context).includes("Target file")) {
					coderRequests += 1;
					return coderRequests === 1
						? toolCall("edit", { path: "src/other.ts", edits: [{ oldText: "other", newText: "OTHER" }] })
						: toolCall("finish", finish);
				}
				return toolCall("report", EMPTY_REPORT);
			}),
		);
		const swarm = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("q1"), scoutTask("q2")]));
		expect(swarm.isError).toBeUndefined();
		const single = await run(CODE_FILE_TOOL_NAME, {
			path: "src/other.ts",
			change: "uppercase",
			oracle: {
				command: node,
				args: ["-e", "process.exit(require('fs').readFileSync('src/other.ts','utf8').includes('OTHER') ? 0 : 1)"],
			},
		});
		expect(single.isError).toBeUndefined();
		expect((single.details as SubagentRunSummary).outcome).toBe("passed");
		expect(readFileSync(join(root, "src", "other.ts"), "utf-8")).toBe("OTHER\n");
	});

	it("still confines each coder to its own target inside the batch", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		let coderRequests = 0;
		faux.setResponses(
			Array.from({ length: 3 }, () => (context: TranscriptContext) => {
				const text = userPrompt(context);
				if (!text.includes("Target file")) return toolCall("report", EMPTY_REPORT);
				coderRequests += 1;
				return coderRequests === 1
					? toolCall("write", { path: "src/a.ts", content: "pwned\n" })
					: toolCall("finish", finish);
			}),
		);
		const mixed = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([coderTask("src/other.ts"), scoutTask("q")]));
		expect(mixed.isError).toBeUndefined();
		const coder = swarmDetails(mixed).results[0]!;
		expect(coder.outcome).toBe("no_change");
		expect(coder.scopeViolations).toBe(1);
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\ntwo\nthree\n");
	});
});

describe("startup rate-limit retries", () => {
	it(
		"requeues a task that rate-limited before its first response and aggregates usage across attempts",
		{ timeout: 20_000 },
		async () => {
			const completed: SubagentRunSummary[] = [];
			const { faux, run } = setup({
				subagents: SCOUT_ONLY,
				onRunComplete: (summary) => {
					completed.push(summary);
				},
			});
			const seen = { first: 0, second: 0 };
			faux.setResponses(
				Array.from({ length: 3 }, () => (context: TranscriptContext) => {
					const text = userPrompt(context);
					if (text.includes("aaaa")) {
						seen.first += 1;
						if (seen.first === 1) {
							return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
						}
					} else {
						seen.second += 1;
					}
					return toolCall("report", EMPTY_REPORT);
				}),
			);
			// Equal-length questions keep the per-request usage estimates comparable.
			const result = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("aaaa"), scoutTask("bbbb")]));
			expect(result.isError).toBeUndefined();
			const [retried, plain] = swarmDetails(result).results;
			expect(retried?.outcome).toBe("completed");
			expect(retried?.swarm).toEqual({ index: 1, total: 2, attempts: 2, rateLimitRetries: 1 });
			expect(retried?.turns).toBe(2);
			expect(plain?.outcome).toBe("completed");
			expect(plain?.swarm).toEqual({ index: 2, total: 2, attempts: 1, rateLimitRetries: 0 });
			expect(plain?.turns).toBe(1);
			// Usage aggregates both attempts of the retried task: same brief, so same per-attempt input.
			expect(retried?.usage.input).toBe(2 * (plain?.usage.input ?? 0));
			// Exactly one ledger record per task, even for the retried one.
			expect(completed.map((summary) => summary.runId)).toEqual(
				swarmDetails(result).results.map((summary) => summary.runId),
			);
			expect(completed.find((summary) => summary.runId === retried?.runId)?.turns).toBe(2);
		},
	);

	it("does not retry quota exhaustion even though gateways serve it as 429", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		const seen = { quota: 0, fine: 0 };
		faux.setResponses(
			Array.from({ length: 2 }, () => (context: TranscriptContext) => {
				const text = userPrompt(context);
				if (text.includes("quota")) {
					seen.quota += 1;
					return fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage:
							"429 insufficient_quota: You exceeded your current quota, please check your plan and billing",
					});
				}
				seen.fine += 1;
				return toolCall("report", EMPTY_REPORT);
			}),
		);
		const result = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("quota"), scoutTask("fine")]));
		expect(result.isError).toBe(true);
		const [quota, fine] = swarmDetails(result).results;
		expect(quota?.outcome).toBe("error");
		expect(quota?.swarm?.attempts).toBe(1);
		expect(fine?.outcome).toBe("completed");
	});
});

describe("coder retry safety", () => {
	it("never re-runs a coder that already started, and surfaces the failure", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		const seen = { a: 0, b: 0 };
		faux.setResponses(
			Array.from({ length: 3 }, () => (context: TranscriptContext) => {
				const text = userPrompt(context);
				if (text.includes("src/a.ts")) {
					seen.a += 1;
					// Streams content first (the attempt becomes ready), then fails on a rate limit.
					return fauxAssistantMessage([fauxText("about to edit")], {
						stopReason: "error",
						errorMessage: "429 Too Many Requests",
					});
				}
				seen.b += 1;
				return seen.b % 2 === 1
					? toolCall("edit", { path: "src/other.ts", edits: [{ oldText: "other", newText: "OTHER" }] })
					: toolCall("finish", finish);
			}),
		);
		const result = await run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams([coderTask("src/a.ts"), coderTask("src/other.ts")]),
		);
		expect(result.isError).toBe(true);
		const [failed, passed] = swarmDetails(result).results;
		expect(failed?.outcome).toBe("error");
		expect(failed?.error).toContain("429");
		expect(failed?.swarm).toEqual({ index: 1, total: 2, attempts: 1, rateLimitRetries: 0 });
		// No fresh attempt for the started coder: one request, and the untouched target proves it.
		expect(seen.a).toBe(1);
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\ntwo\nthree\n");
		expect(passed?.outcome).toBe("passed");
	});
});

describe("whole-call abort", () => {
	it(
		"yields per-task aborted results, with usage recorded for the tasks that had started",
		{ timeout: 20_000 },
		async () => {
			process.env[SWARM_MAX_CONCURRENCY_ENV] = "2";
			const completed: SubagentRunSummary[] = [];
			const { faux, run } = setup({
				subagents: SCOUT_ONLY,
				fauxOptions: { tokensPerSecond: 20 },
				onRunComplete: (summary) => {
					completed.push(summary);
				},
			});
			let entered = 0;
			// Each response streams slowly, so the two capped attempts are in flight when we abort.
			faux.setResponses(
				Array.from({ length: 6 }, () => () => {
					entered += 1;
					return fauxAssistantMessage([fauxText("x".repeat(4_000))]);
				}),
			);
			const controller = new AbortController();
			const runPromise = run(
				SUBAGENT_SWARM_TOOL_NAME,
				swarmParams(Array.from({ length: 6 }, (_, index) => scoutTask(`q${index}`))),
				controller.signal,
			);
			await waitFor(() => entered >= 2);
			await new Promise((resolve) => setTimeout(resolve, 200));
			controller.abort();
			const result = await runPromise;
			expect(result.isError).toBe(true);
			const details = swarmDetails(result);
			expect(details.results).toHaveLength(6);
			expect(details.results.every((summary) => summary.outcome === "aborted")).toBe(true);
			const started = details.results.filter((summary) => (summary.swarm?.attempts ?? 0) === 1);
			const notStarted = details.results.filter((summary) => (summary.swarm?.attempts ?? 0) === 0);
			expect(started).toHaveLength(2);
			expect(notStarted).toHaveLength(4);
			for (const summary of started) {
				expect(summary.usage.input).toBeGreaterThan(0);
				expect(summary.error).toContain("interrupted");
			}
			// Only the two started tasks consumed tokens, so only they are recorded.
			expect(completed).toHaveLength(2);
			const text = (result.content[0] as { text: string }).text;
			expect(text.length).toBeLessThanOrEqual(MAX_SWARM_RESULT_CHARS);
		},
	);
});

describe("bounded result text", () => {
	it("caps the whole text at MAX_SWARM_RESULT_CHARS while details keep full reports and diffs", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		const bigFindings = Array.from({ length: 30 }, (_, index) => ({
			claim: `finding ${index} ${"c".repeat(900)}`,
			confidence: "low",
			evidence: [],
		}));
		let coderRequests = 0;
		faux.setResponses(
			Array.from({ length: 3 }, () => (context: TranscriptContext) => {
				const text = userPrompt(context);
				if (!text.includes("Target file")) {
					return toolCall("report", { findings: bigFindings, unresolved: [], confidence: "low" });
				}
				coderRequests += 1;
				return coderRequests === 1
					? toolCall("write", { path: "src/a.ts", content: `${"d".repeat(30_000)}\n` })
					: toolCall("finish", finish);
			}),
		);
		const result = await run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams([
				{ kind: "scout", question: "many findings" },
				{ kind: "coder", path: "src/a.ts", change: "rewrite", oracle: ORACLE_ALWAYS_PASSES },
			]),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeLessThanOrEqual(MAX_SWARM_RESULT_CHARS);
		const parsed = JSON.parse(text) as {
			results: Array<{ runId: string; outcome: string; scout?: { findings: unknown[]; unresolved: string[] } }>;
		};
		const details = swarmDetails(result);
		expect(parsed.results.map((entry) => entry.runId)).toEqual(details.results.map((summary) => summary.runId));
		// The text keeps as many scout findings as fit and says how many it dropped; the details keep
		// everything (the diff itself is capped at 20000 chars by the coder report).
		const keptFindings = parsed.results[0]?.scout?.findings.length ?? 0;
		expect(keptFindings).toBeGreaterThan(0);
		expect(keptFindings).toBeLessThan(30);
		expect(parsed.results[0]?.scout?.unresolved).toContain(`[${30 - keptFindings} findings omitted for length]`);
		expect(details.results[0]?.scout?.findings).toHaveLength(30);
		expect(details.results[1]?.coder?.diff.length).toBeGreaterThan(19_000);
	});
});

describe("sibling coders", () => {
	it("runs each coder oracle after every coder stopped, and does not report sibling targets as outside changes", async () => {
		writeFileSync(join(root, "src", "b.ts"), "b\n");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q");
		git("add", "src/a.ts", "src/b.ts", "src/other.ts");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
		// Both oracles need both files finished. Coder B first runs its own slow oracle (one second),
		// then writes, so an oracle run as soon as coder A finishes would see b.ts unfinished.
		const check =
			"const f=require('fs');process.exit(f.readFileSync('src/a.ts','utf8')==='A2\\n'&&f.readFileSync('src/b.ts','utf8')==='B2\\n'?0:1)";
		const bothDone = { command: node, args: ["-e", check] };
		const slowBothDone = { command: node, args: ["-e", `setTimeout(()=>{${check}},1000)`] };
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses(
			Array.from({ length: 5 }, () => (context: TranscriptContext) => {
				const isA = userPrompt(context).includes("Target file (the only file you may edit or write): src/a.ts");
				const turn = context.messages.filter((message) => message.role === "toolResult").length;
				if (isA)
					return turn === 0
						? toolCall("write", { path: "src/a.ts", content: "A2\n" })
						: toolCall("finish", finish);
				if (turn === 0) return toolCall("run_oracle", {});
				return turn === 1 ? toolCall("write", { path: "src/b.ts", content: "B2\n" }) : toolCall("finish", finish);
			}),
		);
		const result = await run(
			SUBAGENT_SWARM_TOOL_NAME,
			swarmParams([
				{ kind: "coder", path: "src/a.ts", change: "A2", oracle: bothDone },
				{ kind: "coder", path: "src/b.ts", change: "B2", oracle: slowBothDone },
			]),
		);
		const details = swarmDetails(result);
		expect(details.results.map((summary) => summary.outcome)).toEqual(["passed", "passed"]);
		for (const summary of details.results) {
			expect(summary.coder?.outsideTargetChanges ?? []).toEqual([]);
		}
	});

	it("reports a task whose run crashed as an error, records it, and keeps the other tasks", async () => {
		const completed: SubagentRunSummary[] = [];
		const { faux, run } = setup({
			subagents: BOTH,
			onRunComplete: (summary) => {
				completed.push(summary);
			},
		});
		faux.setResponses(
			Array.from({ length: 3 }, () => (context: TranscriptContext) => {
				if (!userPrompt(context).includes("Target file")) return toolCall("report", EMPTY_REPORT);
				// Replacing the target with a directory makes the after-run snapshot throw.
				rmSync(join(root, "src", "a.ts"));
				mkdirSync(join(root, "src", "a.ts"));
				return toolCall("finish", finish);
			}),
		);
		const result = await run(SUBAGENT_SWARM_TOOL_NAME, swarmParams([scoutTask("q"), coderTask("src/a.ts")]));
		const details = swarmDetails(result);
		expect(details.results[0]?.outcome).toBe("completed");
		expect(details.results[1]?.outcome).toBe("error");
		expect(details.results[1]?.error).toContain("Subagent failed:");
		expect(completed.map((summary) => summary.outcome).sort()).toEqual(["completed", "error"]);
	});

	it("keeps the text valid JSON for a full batch with long errors and paths", () => {
		const summaries = Array.from({ length: MAX_SWARM_TASKS }, (_, index) => ({
			runId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
			kind: "coder",
			roleName: "coder-a",
			roleIdentityHash: "abc",
			provider: "openrouter",
			model: "some/model",
			servedUpstreams: ["Host"],
			upstreamMismatch: false,
			outcome: "oracle_failed",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.001 },
			turns: 3,
			startedAt: 0,
			durationMs: 1000,
			toolCalls: [],
			failedToolCalls: 0,
			scopeViolations: 0,
			error: "e".repeat(2_000),
			swarm: { index: index + 1, total: MAX_SWARM_TASKS, attempts: 1, rateLimitRetries: 0 },
			coder: { path: `src/${"p".repeat(900)}.ts`, changed: true, diffLines: 4, diff: "d".repeat(5_000) },
		})) as unknown as SubagentRunSummary[];
		const text = renderSwarmText("batch", summaries);
		expect(text.length).toBeLessThanOrEqual(MAX_SWARM_RESULT_CHARS);
		const parsed = JSON.parse(text) as { results: unknown[]; omittedTasks?: number };
		expect(parsed.results).toHaveLength(MAX_SWARM_TASKS);
		expect(parsed.omittedTasks).toBeUndefined();
	});
});
