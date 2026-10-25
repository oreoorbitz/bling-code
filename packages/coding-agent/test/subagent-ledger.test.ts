import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, JsonValue } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import {
	createMessageAction,
	createToolAction,
	type LearningSubagentAction,
	type LearningSubagentVerdictAction,
	type LearningToolAction,
	ProjectActionStore,
} from "../src/core/learning/action-store.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { ENV_BENCHMARK_RUN_ID } from "../src/core/subagents/roles.ts";
import type { SubagentRunSummary } from "../src/core/subagents/types.ts";
import {
	CODE_FILE_TOOL_NAME,
	createSubagentsExtension,
	type SubagentRunCompleteHook,
} from "../src/extensions/subagents/index.ts";
import { recordSubagentRun, recordSubagentVerdict } from "../src/extensions/subagents/ledger.ts";
import { fauxStreamer, registerFaux, roleConfig, withUsage } from "./subagent-test-utils.ts";

const node = process.execPath;
const registrations: Array<{ unregister(): void }> = [];
let base: string;
let root: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "subagent-ledger-")));
	root = join(base, "project");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
});

afterEach(() => {
	vi.unstubAllEnvs();
	while (registrations.length > 0) registrations.pop()?.unregister();
	rmSync(base, { recursive: true, force: true });
});

const CALL_ID = "call-code_file";
const ORACLE = {
	command: node,
	args: ["-e", "process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('TWO') ? 0 : 1)"],
};

function toolCall(name: string, args: Record<string, JsonValue>): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function parentMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: CALL_ID, name: CODE_FILE_TOOL_NAME, arguments: {} }],
		api: "openai-completions",
		provider: "openrouter",
		model: "ling",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 5000,
	};
}

interface SetupOptions {
	learning?: Settings["learning"];
	harness?: Settings["harness"];
	branch?: AssistantMessage[];
	patches?: Parameters<typeof withUsage>[1];
	onRunComplete?: SubagentRunCompleteHook;
}

function setup(options: SetupOptions = {}) {
	const faux = registerFaux();
	registrations.push(faux);
	const settings = {
		learning: options.learning,
		harness: options.harness,
		subagents: {
			active: { coder: "coder-a" },
			roles: { "coder-a": roleConfig("coder", { upstream: "novita" }) },
		},
	} as Settings;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, () => void>();
	const api = {
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		getSettings: () => settings,
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
	} as unknown as ExtensionAPI;
	createSubagentsExtension({ onRunComplete: options.onRunComplete ?? recordSubagentRun })(api);
	handlers.get("session_start")?.();
	const streamer = withUsage(fauxStreamer(), options.patches ?? [{ input: 10, output: 5, cost: 0.01 }]);
	const ctx = {
		cwd: root,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () =>
				(options.branch ?? []).map((message, index) => ({ type: "message", id: `e${index}`, message })),
		},
		modelRegistry: {
			find: () => faux.getModel(),
			hasConfiguredAuth: () => true,
			streamSimple: streamer.streamSimple,
		},
	} as unknown as ExtensionContext;
	const run = async () => {
		const tool = tools.get(CODE_FILE_TOOL_NAME);
		if (!tool) throw new Error("code_file not registered");
		return tool.execute(
			CALL_ID,
			{ path: "src/a.ts", change: "uppercase two", oracle: ORACLE } as never,
			undefined,
			undefined,
			ctx as never,
		);
	};
	return { faux, run };
}

const finish = { summary: "done", uncertainties: [], interfaceChanges: [] };
const editTwo = () => toolCall("edit", { path: "src/a.ts", edits: [{ oldText: "two", newText: "TWO" }] });

describe("subagent ledger records", () => {
	it("writes one record per code_file run with usage, served host, oracle and parent links", async () => {
		const parent = parentMessage();
		const { faux, run } = setup({
			branch: [parent],
			patches: [
				{ input: 10, output: 5, cost: 0.01, responseProvider: "Novita" },
				{ input: 20, output: 4, cacheRead: 3, cost: 0.02, responseProvider: "Novita" },
			],
		});
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		const result = await run();
		const summary = result.details as SubagentRunSummary;
		expect(summary.outcome).toBe("passed");

		const records = await ProjectActionStore.open(root).list();
		expect(records).toHaveLength(1);
		const record = records[0] as LearningSubagentAction;
		expect(record.kind).toBe("subagent");
		expect(record.role).toBe("coder");
		expect(record.roleName).toBe("coder-a");
		expect(record.provider).toBe("openrouter");
		expect(record.requestedUpstream).toBe("novita");
		expect(record.servedUpstreams).toEqual(["Novita"]);
		expect(record.outcome).toBe("passed");
		expect(record.usage).toMatchObject({ input: 30, output: 9, cacheRead: 3, cacheWrite: 0, totalTokens: 42 });
		expect(record.usage.cost).toBeCloseTo(0.03, 10);
		expect(record.turns).toBe(2);
		expect(record.targetPath).toBe("src/a.ts");
		expect(record.oracle).toMatchObject({ command: node, exitCode: 0, passed: true, timedOut: false });
		expect(record.diffSha256).toBe(
			createHash("sha256")
				.update(summary.coder?.diff ?? "")
				.digest("hex"),
		);
		expect(record.parentSessionId).toBe("session-1");
		expect(record.sessionId).toBe("session-1");
		expect(record.parentToolCallId).toBe(CALL_ID);
		expect(record.parentActionId).toBe(createMessageAction(root, "session-1", parent, "bling").actionId);
		expect(record.harnessProfile).toBe("bling");
		expect(record.armId).toMatch(/^bling:/);
		expect(record.benchmarkRunId).toBeUndefined();
		expect("benchmarkRunId" in record).toBe(false);
	});

	it("joins the matching tool record through the parent tool call id", async () => {
		const { faux, run } = setup({ branch: [parentMessage()] });
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		await run();
		const store = ProjectActionStore.open(root);
		await store.append(
			createToolAction(root, "session-1", {
				toolCallId: CALL_ID,
				toolName: CODE_FILE_TOOL_NAME,
				isError: false,
			}),
		);
		const records = await store.list();
		const subagent = records.find((record) => record.kind === "subagent") as LearningSubagentAction;
		const tool = records.find((record) => record.kind === "tool") as LearningToolAction;
		expect(tool.toolCallId).toBe(subagent.parentToolCallId);
	});

	it("leaves parentActionId undefined when the assistant message is not in the branch", async () => {
		const { faux, run } = setup({ branch: [] });
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		await run();
		const record = (await ProjectActionStore.open(root).list())[0] as LearningSubagentAction;
		expect(record.parentActionId).toBeUndefined();
		expect(record.parentToolCallId).toBe(CALL_ID);
	});

	it("tags the record with the benchmark run id and honours the stock profile", async () => {
		vi.stubEnv(ENV_BENCHMARK_RUN_ID, "run-xyz");
		const { faux, run } = setup({ harness: { profile: "stock" } });
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		await run();
		const record = (await ProjectActionStore.open(root).list())[0] as LearningSubagentAction;
		expect(record.benchmarkRunId).toBe("run-xyz");
		expect(record.harnessProfile).toBe("stock");
	});

	it("records reasoning tokens, diagnostics, diff size and the escalation reason", async () => {
		const { faux, run } = setup({
			branch: [parentMessage()],
			patches: [
				{ input: 10, output: 50, reasoning: 30, cost: 0.01 },
				{ input: 10, output: 20, reasoning: 5, cost: 0.01 },
			],
		});
		faux.setResponses([
			editTwo(),
			toolCall("escalate", { reason: "scope_expansion", detail: "needs other.ts", filesNeeded: ["src/other.ts"] }),
		]);
		await run();
		const record = (await ProjectActionStore.open(root).list())[0] as LearningSubagentAction;
		expect(record.outcome).toBe("escalated");
		expect(record.usage.reasoning).toBe(35);
		expect(record.usage.output).toBe(70);
		expect(record.escalationReason).toBe("scope_expansion");
		expect(record.diffLines).toBe(2);
		expect(record.failedToolCalls).toBe(0);
		expect(record.timeToFirstToolCallMs).toBeGreaterThanOrEqual(0);
	});

	it("omits reasoning, escalation and time to first tool call when there are none", async () => {
		const { faux, run } = setup({ branch: [parentMessage()] });
		faux.setResponses([fauxAssistantMessage("nothing to do")]);
		await run();
		const record = (await ProjectActionStore.open(root).list())[0] as LearningSubagentAction;
		expect("reasoning" in record.usage).toBe(false);
		expect("escalationReason" in record).toBe(false);
		expect("timeToFirstToolCallMs" in record).toBe(false);
		expect(record.failedToolCalls).toBe(0);
	});

	it("writes nothing when learning or the action log is disabled", async () => {
		for (const learning of [{ enabled: false }, { actionLog: false }]) {
			const { faux, run } = setup({ learning });
			faux.setResponses([toolCall("finish", finish)]);
			await run();
		}
		expect(await ProjectActionStore.open(root).list()).toEqual([]);
	});

	it("does not fail the tool call when the ledger write fails; attaches a warning", async () => {
		const { faux, run } = setup({
			onRunComplete: () => {
				throw new Error("disk full");
			},
		});
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		const result = await run();
		expect(result.isError).toBeUndefined();
		const details = result.details as SubagentRunSummary;
		expect(details.outcome).toBe("passed");
		expect(details.ledgerWarning).toContain("disk full");
	});
});

describe("subagent verdict ledger records", () => {
	const settings = {} as Settings;
	const ctx = {
		cwd: "",
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	const withCwd = () => ({ ...ctx, cwd: root }) as ExtensionContext;
	const verdict = {
		runId: "run-1",
		verdict: "accepted" as const,
		reason: "kept the diff",
		role: "coder" as const,
		roleName: "coder-a",
	};

	it("writes a subagent_verdict record linked to the run, once per tool call", async () => {
		await recordSubagentVerdict(verdict, withCwd(), "call-v1", settings);
		await recordSubagentVerdict(verdict, withCwd(), "call-v1", settings);
		const records = await ProjectActionStore.open(root).list();
		expect(records).toHaveLength(1);
		const record = records[0] as LearningSubagentVerdictAction;
		expect(record.kind).toBe("subagent_verdict");
		expect(record.actionId).toMatch(/^verdict_/);
		expect(record).toMatchObject({
			runId: "run-1",
			verdict: "accepted",
			reason: "kept the diff",
			role: "coder",
			roleName: "coder-a",
			parentSessionId: "session-1",
			sessionId: "session-1",
			parentToolCallId: "call-v1",
			harnessProfile: "bling",
		});
		expect("benchmarkRunId" in record).toBe(false);
	});

	it("a later verdict is a separate record and the benchmark run id and stock profile are tagged", async () => {
		vi.stubEnv(ENV_BENCHMARK_RUN_ID, "run-xyz");
		await recordSubagentVerdict(verdict, withCwd(), "call-v1", { harness: { profile: "stock" } } as Settings);
		await recordSubagentVerdict({ ...verdict, verdict: "rejected" }, withCwd(), "call-v2", settings);
		const records = (await ProjectActionStore.open(root).list()) as LearningSubagentVerdictAction[];
		expect(records.map((record) => record.verdict)).toEqual(["accepted", "rejected"]);
		expect(records[0].actionId).not.toBe(records[1].actionId);
		expect(records[0]).toMatchObject({ benchmarkRunId: "run-xyz", harnessProfile: "stock" });
	});

	it("redacts credentials in the reason", async () => {
		await recordSubagentVerdict(
			{ ...verdict, reason: "leaked sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789 in output" },
			withCwd(),
			"call-v1",
			settings,
		);
		const record = (await ProjectActionStore.open(root).list())[0] as LearningSubagentVerdictAction;
		expect(record.reason).not.toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789");
		expect(record.reason).toContain("[REDACTED]");
	});

	it("writes nothing when the action log is disabled", async () => {
		await recordSubagentVerdict(verdict, withCwd(), "call-v1", { learning: { actionLog: false } } as Settings);
		expect(await ProjectActionStore.open(root).list()).toEqual([]);
	});
});
