import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedRole } from "../src/core/subagents/roles.ts";
import { runSubagent } from "../src/core/subagents/runner.ts";
import { fauxStreamer, makeRole, registerFaux, type UsagePatch, withUsage } from "./subagent-test-utils.ts";

const registrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

const echoTool: AgentTool = {
	name: "echo",
	label: "echo",
	description: "Echo",
	parameters: Type.Object({ text: Type.String() }),
	async execute(_id, params) {
		return { content: [{ type: "text", text: String((params as { text: string }).text) }], details: undefined };
	},
};

const reportTool: AgentTool = {
	name: "report",
	label: "report",
	description: "Report",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: undefined, terminate: true };
	},
};

function setup(options: Parameters<typeof registerFaux>[0] = {}) {
	const faux = registerFaux(options);
	registrations.push(faux);
	return faux;
}

function withBudgets(role: ResolvedRole, budgets: Partial<ResolvedRole["budgets"]>): ResolvedRole {
	return { ...role, budgets: { ...role.budgets, ...budgets } };
}

function callEcho() {
	return fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" });
}

describe("runSubagent", () => {
	it("sends the role pin, sampling, and maxRetries 0 on every request, per role", async () => {
		const faux = setup();
		const seen: Array<{ routing: unknown; sampling: unknown; maxRetries: unknown }> = [];
		const factory = (
			_context: unknown,
			options: { maxRetries?: number } | undefined,
			_state: unknown,
			model: any,
		) => {
			seen.push({
				routing: model.compat?.openRouterRouting,
				sampling: model.samplingParams,
				maxRetries: options?.maxRetries,
			});
			return fauxAssistantMessage("done");
		};
		const first = makeRole(faux, "scout", { upstream: "chutes/fp8", sampling: { temperature: 0.1, top_k: 20 } }, "a");
		const second = makeRole(faux, "scout", { upstream: "deepinfra/bf16", sampling: { temperature: 0.3 } }, "b");
		for (const role of [first, second]) {
			faux.setResponses([factory]);
			const result = await runSubagent({
				role,
				registry: fauxStreamer(),
				systemPrompt: "sys",
				task: "go",
				tools: [],
			});
			expect(result.outcome).toBe("completed");
		}
		expect(seen).toEqual([
			{
				routing: { only: ["chutes/fp8"], allow_fallbacks: false, require_parameters: true },
				sampling: { temperature: 0.1, top_k: 20 },
				maxRetries: 0,
			},
			{
				routing: { only: ["deepinfra/bf16"], allow_fallbacks: false, require_parameters: true },
				sampling: { temperature: 0.3 },
				maxRetries: 0,
			},
		]);
	});

	it("accumulates usage, served hosts, turns, and harness-recorded tool calls", async () => {
		const faux = setup();
		faux.setResponses([callEcho(), fauxAssistantMessage("finished")]);
		const patches: UsagePatch[] = [
			{ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01, responseProvider: "Novita" },
			{ input: 20, output: 4, cacheRead: 3, cacheWrite: 0, cost: 0.02, responseProvider: "Novita" },
		];
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: withUsage(fauxStreamer(), patches),
			systemPrompt: "sys",
			task: "go",
			tools: [echoTool],
		});
		expect(result.outcome).toBe("completed");
		expect(result.turns).toBe(2);
		expect(result.requests).toBe(2);
		expect(result.usage).toMatchObject({ input: 30, output: 9, cacheRead: 5, cacheWrite: 1, totalTokens: 45 });
		expect(result.usage.cost).toBeCloseTo(0.03);
		expect(result.servedUpstreams).toEqual(["Novita"]);
		expect(result.toolCalls).toEqual([{ tool: "echo", args: '{"text":"hi"}', isError: false }]);
		expect(result.finalText).toBe("finished");
	});

	it("records long tool arguments truncated", async () => {
		const faux = setup();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "x".repeat(500) })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [echoTool],
		});
		expect(result.toolCalls[0].args.length).toBeLessThanOrEqual(203);
		expect(result.toolCalls[0].args.endsWith("...")).toBe(true);
	});

	const budgetCases: Array<{
		name: string;
		budgets: Partial<ResolvedRole["budgets"]>;
		patch: UsagePatch;
		outcome: string;
		turns: number;
	}> = [
		{ name: "maxTurns", budgets: { maxTurns: 2 }, patch: { input: 1, output: 1 }, outcome: "budget_turns", turns: 2 },
		{
			name: "maxTotalTokens",
			budgets: { maxTotalTokens: 250 },
			patch: { input: 100, output: 50 },
			outcome: "budget_tokens",
			turns: 2,
		},
		{
			// Output (which includes reasoning) trips its own budget long before the total does.
			name: "maxOutputTokens",
			budgets: { maxOutputTokens: 60 },
			patch: { input: 1, output: 40, reasoning: 30 },
			outcome: "budget_output",
			turns: 2,
		},
		{
			name: "maxContextTokens",
			budgets: { maxContextTokens: 90 },
			patch: { input: 50, cacheRead: 50, output: 1 },
			outcome: "budget_context",
			turns: 1,
		},
		{
			name: "maxCostUsd",
			budgets: { maxCostUsd: 0.05 },
			patch: { input: 1, output: 1, cost: 0.03 },
			outcome: "budget_cost",
			turns: 2,
		},
	];
	for (const budgetCase of budgetCases) {
		it(`stops on ${budgetCase.name}`, async () => {
			const faux = setup();
			faux.setResponses(Array.from({ length: 10 }, () => callEcho()));
			const result = await runSubagent({
				role: withBudgets(makeRole(faux, "scout"), budgetCase.budgets),
				registry: withUsage(fauxStreamer(), [budgetCase.patch]),
				systemPrompt: "sys",
				task: "go",
				tools: [echoTool],
			});
			expect(result.outcome).toBe(budgetCase.outcome);
			expect(result.turns).toBe(budgetCase.turns);
			// The abort stops the loop; at most one further request is attempted and it is aborted.
			expect(faux.state.callCount).toBeLessThanOrEqual(budgetCase.turns + 1);
		});
	}

	it("lets a successful terminal tool win over a budget trip in the same turn", async () => {
		const faux = setup();
		faux.setResponses([callEcho(), fauxAssistantMessage([fauxToolCall("report", {})], { stopReason: "toolUse" })]);
		const result = await runSubagent({
			role: withBudgets(makeRole(faux, "scout"), { maxTurns: 2 }),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [echoTool, reportTool],
			terminalTools: ["report"],
		});
		expect(result.outcome).toBe("completed");
		expect(result.turns).toBe(2);
	});

	it("maps a failed request to an error outcome and does not retry", async () => {
		const faux = setup();
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream exploded" }),
			fauxAssistantMessage("never used"),
		]);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [],
		});
		expect(result.outcome).toBe("error");
		expect(result.error).toBe("upstream exploded");
		expect(faux.state.callCount).toBe(1);
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("times out a slow response", async () => {
		const faux = setup({ tokensPerSecond: 5 });
		faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(200))])]);
		const result = await runSubagent({
			role: withBudgets(makeRole(faux, "scout"), { timeoutMs: 150 }),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [],
		});
		expect(result.outcome).toBe("timeout");
		expect(result.durationMs).toBeLessThan(5000);
	});

	it("aborts with the parent signal", async () => {
		const faux = setup({ tokensPerSecond: 5 });
		faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(200))])]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [],
			signal: controller.signal,
		});
		expect(result.outcome).toBe("aborted");
	});

	it("sends no request when the parent signal is already aborted", async () => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("never")]);
		const controller = new AbortController();
		controller.abort();
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [],
			signal: controller.signal,
		});
		expect(result.outcome).toBe("aborted");
		expect(faux.state.callCount).toBe(0);
	});

	it("sums reasoning tokens and leaves them undefined when no response reports them", async () => {
		const faux = setup();
		faux.setResponses([callEcho(), fauxAssistantMessage("finished")]);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: withUsage(fauxStreamer(), [
				{ input: 10, output: 20, reasoning: 12 },
				{ input: 10, output: 8, reasoning: 3 },
			]),
			systemPrompt: "sys",
			task: "go",
			tools: [echoTool],
		});
		expect(result.usage.output).toBe(28);
		expect(result.usage.reasoning).toBe(15);

		const plain = setup();
		plain.setResponses([fauxAssistantMessage("finished")]);
		const without = await runSubagent({
			role: makeRole(plain, "scout"),
			registry: withUsage(fauxStreamer(), [{ input: 10, output: 5 }]),
			systemPrompt: "sys",
			task: "go",
			tools: [],
		});
		expect("reasoning" in without.usage).toBe(false);
	});

	it("records time to the first tool call and counts failed tool calls", async () => {
		const faux = setup({ tokensPerSecond: 200 });
		faux.setResponses([
			fauxAssistantMessage([fauxText("thinking about it ".repeat(20)), fauxToolCall("echo", { text: "a" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("echo", { text: "b" }), fauxToolCall("missing", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [echoTool],
			// Blocked calls and unknown tools both count as failed.
			beforeToolCall: async (context) =>
				(context.args as { text?: string }).text === "b" ? { block: true, reason: "no" } : undefined,
		});
		expect(result.toolCalls.map((call) => call.isError)).toEqual([false, true, true]);
		expect(result.failedToolCalls).toBe(2);
		expect(result.timeToFirstToolCallMs).toBeGreaterThan(0);
		expect(result.timeToFirstToolCallMs).toBeLessThanOrEqual(result.durationMs);
	});

	it("leaves time to first tool call undefined when no tool was called", async () => {
		const faux = setup();
		faux.setResponses([fauxAssistantMessage("just text")]);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [],
		});
		expect(result.timeToFirstToolCallMs).toBeUndefined();
		expect(result.failedToolCalls).toBe(0);
	});

	it("blocks tool calls through beforeToolCall", async () => {
		const faux = setup();
		faux.setResponses([callEcho(), fauxAssistantMessage("done")]);
		const result = await runSubagent({
			role: makeRole(faux, "scout"),
			registry: fauxStreamer(),
			systemPrompt: "sys",
			task: "go",
			tools: [echoTool],
			beforeToolCall: async () => ({ block: true, reason: "no" }),
		});
		expect(result.toolCalls).toEqual([{ tool: "echo", args: '{"text":"hi"}', isError: true }]);
		expect(result.outcome).toBe("completed");
	});
});
