import { Agent, type AgentEvent, type AgentTool, type BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { convertToLlm } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ResolvedRole } from "./roles.ts";
import type { SubagentOutcome, SubagentToolCallRecord, SubagentUsage } from "./types.ts";

export const TOOL_CALL_ARGS_LIMIT_CHARS = 200;

/** The part of `ModelRegistry` the runner needs: request-time auth and routing. */
export type SubagentModelStreamer = Pick<ModelRegistry, "streamSimple">;

export type RunnerOutcome = Extract<
	SubagentOutcome,
	| "completed"
	| "error"
	| "aborted"
	| "timeout"
	| "budget_turns"
	| "budget_tokens"
	| "budget_output"
	| "budget_context"
	| "budget_cost"
>;

export interface SubagentProgress {
	turns: number;
	usage: SubagentUsage;
}

export interface RunSubagentOptions {
	role: ResolvedRole;
	registry: SubagentModelStreamer;
	systemPrompt: string;
	/** The brief; sent as the only user message. */
	task: string;
	tools: AgentTool<any>[];
	/** Names of tools that end the run when they succeed. A budget trip in the same turn does not override them. */
	terminalTools?: readonly string[];
	beforeToolCall?: (context: BeforeToolCallContext) => Promise<{ block: true; reason: string } | undefined>;
	signal?: AbortSignal;
	onUpdate?: (progress: SubagentProgress) => void;
}

export interface SubagentRunResult {
	outcome: RunnerOutcome;
	error?: string;
	usage: SubagentUsage;
	turns: number;
	startedAt: number;
	durationMs: number;
	/** Distinct `responseProvider` values of the assistant messages. */
	servedUpstreams: string[];
	toolCalls: SubagentToolCallRecord[];
	/** Milliseconds until the first assistant message that contained a tool call; undefined when none did. */
	timeToFirstToolCallMs?: number;
	/** Tool calls that errored or were blocked before running. */
	failedToolCalls: number;
	/** Text of the last assistant message. */
	finalText: string;
	/** Number of requests that were sent. Always one per turn: the runner never re-prompts or retries. */
	requests: number;
}

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

const REASON_OUTCOME: Record<string, RunnerOutcome> = {
	aborted: "aborted",
	timeout: "timeout",
	budget_turns: "budget_turns",
	budget_tokens: "budget_tokens",
	budget_output: "budget_output",
	budget_context: "budget_context",
	budget_cost: "budget_cost",
};

/**
 * Run one child agent to completion. One prompt, no retries, no fallback model: the model object in `role` is used for
 * every request. The first of the parent signal, the wall-clock timeout and a budget trip aborts the run and decides
 * the outcome.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRunResult> {
	const { role, registry } = options;
	const budgets = role.budgets;
	const terminalTools = new Set(options.terminalTools ?? []);
	const startedAt = Date.now();
	const started = performance.now();
	const usage = emptyUsage();
	const upstreams = new Set<string>();
	const toolCalls: SubagentToolCallRecord[] = [];
	const pendingArgs = new Map<string, string>();
	let turns = 0;
	let requests = 0;
	let finalText = "";
	let lastError: string | undefined;
	let lastStopReason: AssistantMessage["stopReason"] | undefined;
	let abortReason: string | undefined;
	let timeToFirstToolCallMs: number | undefined;

	const finish = (outcome: RunnerOutcome, error?: string): SubagentRunResult => ({
		outcome,
		...(error === undefined ? {} : { error }),
		usage,
		turns,
		startedAt,
		durationMs: Math.max(0, Math.round(performance.now() - started)),
		servedUpstreams: [...upstreams],
		toolCalls,
		...(timeToFirstToolCallMs === undefined ? {} : { timeToFirstToolCallMs }),
		failedToolCalls: toolCalls.filter((call) => call.isError).length,
		finalText,
		requests,
	});

	if (options.signal?.aborted) return finish("aborted", "Aborted before the first request");

	const agent = new Agent({
		initialState: {
			systemPrompt: options.systemPrompt,
			model: role.model,
			thinkingLevel: role.thinking,
			tools: options.tools,
			messages: [],
		},
		convertToLlm,
		streamFn: (model, context, requestOptions) => {
			requests += 1;
			return registry.streamSimple(model, context, { ...requestOptions, maxRetries: 0 });
		},
		toolExecution: "sequential",
		...(options.beforeToolCall ? { beforeToolCall: async (context) => options.beforeToolCall?.(context) } : {}),
	});

	const trip = (reason: string): void => {
		if (abortReason !== undefined) return;
		abortReason = reason;
		agent.abort();
	};

	const checkBudgets = (message: AssistantMessage, toolResultErrors: Map<string, boolean>): void => {
		const finished = message.content.some(
			(part) => part.type === "toolCall" && terminalTools.has(part.name) && toolResultErrors.get(part.id) === false,
		);
		if (finished) return;
		const issuedToolCalls = message.content.some((part) => part.type === "toolCall");
		const lastContext = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (usage.totalTokens >= budgets.maxTotalTokens) trip("budget_tokens");
		else if (budgets.maxOutputTokens !== undefined && usage.output >= budgets.maxOutputTokens) trip("budget_output");
		else if (lastContext >= budgets.maxContextTokens) trip("budget_context");
		else if (budgets.maxCostUsd !== undefined && usage.cost >= budgets.maxCostUsd) trip("budget_cost");
		else if (issuedToolCalls && turns >= budgets.maxTurns) trip("budget_turns");
	};

	agent.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") break;
				usage.input += message.usage.input;
				usage.output += message.usage.output;
				usage.cacheRead += message.usage.cacheRead;
				usage.cacheWrite += message.usage.cacheWrite;
				usage.totalTokens += message.usage.totalTokens;
				usage.cost += message.usage.cost.total;
				if (message.usage.reasoning !== undefined)
					usage.reasoning = (usage.reasoning ?? 0) + message.usage.reasoning;
				if (timeToFirstToolCallMs === undefined && message.content.some((part) => part.type === "toolCall")) {
					timeToFirstToolCallMs = Math.max(0, Math.round(performance.now() - started));
				}
				if (message.responseProvider) upstreams.add(message.responseProvider);
				finalText = assistantText(message);
				lastStopReason = message.stopReason;
				lastError = message.stopReason === "error" ? (message.errorMessage ?? "Request failed") : undefined;
				break;
			}
			case "tool_execution_start":
				pendingArgs.set(event.toolCallId, truncate(JSON.stringify(event.args ?? {}), TOOL_CALL_ARGS_LIMIT_CHARS));
				break;
			case "tool_execution_end":
				toolCalls.push({
					tool: event.toolName,
					args: pendingArgs.get(event.toolCallId) ?? "{}",
					isError: event.isError,
				});
				pendingArgs.delete(event.toolCallId);
				break;
			case "turn_end": {
				// An aborted turn is the request cut off by a budget trip, timeout, or parent abort; it did not complete.
				if (event.message.role === "assistant" && event.message.stopReason === "aborted") break;
				turns += 1;
				options.onUpdate?.({ turns, usage: { ...usage } });
				if (event.message.role !== "assistant") break;
				const results = new Map(event.toolResults.map((result) => [result.toolCallId, result.isError]));
				checkBudgets(event.message, results);
				break;
			}
			default:
				break;
		}
	});

	const onParentAbort = () => trip("aborted");
	options.signal?.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => trip("timeout"), budgets.timeoutMs);
	try {
		await agent.prompt(options.task);
		await agent.waitForIdle();
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onParentAbort);
	}

	if (abortReason !== undefined) return finish(REASON_OUTCOME[abortReason] ?? "aborted");
	if (lastStopReason === "error") return finish("error", lastError);
	if (lastStopReason === "aborted") return finish("aborted", lastError);
	return finish("completed");
}
