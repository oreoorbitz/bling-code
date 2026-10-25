import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolExecutionEndEvent,
} from "../src/core/extensions/index.ts";
import {
	type LearningMessageAction,
	type LearningToolAction,
	ProjectActionStore,
} from "../src/core/learning/action-store.ts";
import { ImprovementProposalStore } from "../src/core/learning/improvement.ts";
import { ProjectMemoryStore } from "../src/core/learning/memory-store.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { ENV_BENCHMARK_RUN_ID } from "../src/core/subagents/roles.ts";
import { normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { createProjectLearningExtension } from "../src/extensions/learning/index.ts";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

interface SetupOptions {
	learning?: Settings["learning"];
	harness?: Settings["harness"];
	trusted?: boolean;
	sessionId?: string;
}

function assistantMessage(text: string, timestamp: number, thinking?: string): AgentMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking !== undefined) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text });
	content.push({ type: "toolCall", id: `call_${timestamp}`, name: "bash", arguments: { command: "ls" } });
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function setup(cwd: string, options: SetupOptions = {}) {
	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, CommandHandler>();
	let memoryTool: ToolDefinition | undefined;

	const api = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		getSettings: () => ({ learning: options.learning, harness: options.harness }) as Settings,
		registerTool(definition: ToolDefinition) {
			memoryTool = definition;
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
	} as unknown as ExtensionAPI;

	createProjectLearningExtension()(api);

	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
		isProjectTrusted: () => options.trusted ?? true,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;

	async function emit(eventName: string, event: unknown): Promise<void> {
		const handler = handlers.get(eventName);
		if (!handler) throw new Error(`No handler registered for ${eventName}`);
		await handler(event as never, ctx);
	}

	const sessionStart = () => emit("session_start", { type: "session_start" });
	const sessionShutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	const messageEnd = (message: AgentMessage) => emit("message_end", { type: "message_end", message });
	const toolExecutionStart = (event: { toolCallId: string; toolName: string; args: unknown }) =>
		emit("tool_execution_start", { type: "tool_execution_start", ...event });
	const toolExecutionEnd = (event: {
		toolCallId: string;
		toolName: string;
		result: unknown;
		isError: boolean;
		durationMs?: number;
		parentToolCallId?: string;
	}) => emit("tool_execution_end", { type: "tool_execution_end", ...event } as ToolExecutionEndEvent);

	async function beforeAgentStart(selectedTools?: string[]): Promise<BeforeAgentStartEvent> {
		const event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "hello",
			systemPrompt: "",
			systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd, ...(selectedTools ? { selectedTools } : {}) }),
		} as BeforeAgentStartEvent;
		await emit("before_agent_start", event);
		return event;
	}

	async function executeMemoryTool(params: Record<string, unknown>) {
		if (!memoryTool) throw new Error("project_memory tool was not registered");
		const result = await memoryTool.execute("call_memory", params as never, undefined, undefined, ctx as never);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		return { text, details: result.details as Record<string, unknown> | undefined };
	}

	async function runCommand(name: string, args: string): Promise<void> {
		const handler = commands.get(name);
		if (!handler) throw new Error(`No command registered: ${name}`);
		await handler(args, ctx);
	}

	return {
		ctx,
		emit,
		sessionStart,
		sessionShutdown,
		messageEnd,
		toolExecutionStart,
		toolExecutionEnd,
		beforeAgentStart,
		executeMemoryTool,
		runCommand,
		notify: ctx.ui.notify as ReturnType<typeof vi.fn>,
	};
}

async function readLedger(cwd: string) {
	return ProjectActionStore.open(cwd).list();
}

describe("createProjectLearningExtension", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-learning-extension-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("harness profile", () => {
		it("stock injects no project memory and drops the project_memory tool", async () => {
			await (await ProjectMemoryStore.open(tempDir)).add("Use pnpm");
			const stock = setup(tempDir, { harness: { profile: "stock" } });
			await stock.sessionStart();
			const event = await stock.beforeAgentStart(["read", "project_memory"]);
			expect(event.systemPromptOptions.sections.project_memory).toBeUndefined();
			expect(event.systemPromptOptions.selectedTools).toEqual(["read"]);

			const bling = setup(tempDir, { harness: { profile: "bling" } });
			await bling.sessionStart();
			const blingEvent = await bling.beforeAgentStart(["read", "project_memory"]);
			expect(blingEvent.systemPromptOptions.sections.project_memory).toContain("Use pnpm");
			expect(blingEvent.systemPromptOptions.selectedTools).toEqual(["read", "project_memory"]);
		});

		it("stamps message and tool records with the profile", async () => {
			const h = setup(tempDir, { harness: { profile: "stock" } });
			await h.sessionStart();
			await h.messageEnd(assistantMessage("hi", 1000));
			await h.toolExecutionStart({ toolCallId: "c1", toolName: "bash", args: {} });
			await h.toolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
			const records = await readLedger(tempDir);
			expect(records.map((record) => (record as { harnessProfile?: string }).harnessProfile)).toEqual([
				"stock",
				"stock",
			]);
			// Outside benchmarks the arm ID still records the active configuration.
			expect(records.map((record) => (record as { armId?: string }).armId)).toEqual([
				"stock:unlabeled:none",
				"stock:unlabeled:none",
			]);
		});
	});

	describe("benchmark run linkage", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		async function recordSession() {
			const h = setup(tempDir);
			await h.sessionStart();
			await h.messageEnd(assistantMessage("hi", 1000));
			await h.toolExecutionStart({ toolCallId: "call_1000", toolName: "bash", args: {} });
			await h.toolExecutionEnd({ toolCallId: "call_1000", toolName: "bash", result: "ok", isError: false });
			return readLedger(tempDir);
		}

		it("tags message and tool records with the benchmark run id from the environment", async () => {
			vi.stubEnv(ENV_BENCHMARK_RUN_ID, "run-abc");
			const records = await recordSession();
			expect(records.map((record) => record.kind)).toEqual(["message", "tool"]);
			for (const record of records) {
				expect((record as LearningMessageAction | LearningToolAction).benchmarkRunId).toBe("run-abc");
			}
		});

		it("leaves the key absent and the action ids unchanged when the variable is unset", async () => {
			vi.stubEnv(ENV_BENCHMARK_RUN_ID, "run-abc");
			const tagged = await recordSession();
			rmSync(join(tempDir, CONFIG_DIR_NAME), { recursive: true, force: true });
			vi.stubEnv(ENV_BENCHMARK_RUN_ID, "");
			const untagged = await recordSession();
			for (const record of untagged) expect("benchmarkRunId" in record).toBe(false);
			expect(untagged.map((record) => record.actionId)).toEqual(tagged.map((record) => record.actionId));
		});
	});

	describe("action logging", () => {
		it("persists the complete assistant message, including reasoning, on message_end", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			const message = assistantMessage("Running the tests now.", 1000, "The user wants a fix; run tests first.");
			await h.messageEnd(message);

			const records = await readLedger(tempDir);
			expect(records).toHaveLength(1);
			const record = records[0] as LearningMessageAction;
			expect(record.kind).toBe("message");
			expect(record.sessionId).toBe("session-1");
			expect(record.timestamp).toBe(1000);
			expect(record.message).toEqual(message);
			const content = (record.message as { content: Array<{ type: string; thinking?: string }> }).content;
			expect(content[0]).toEqual({ type: "thinking", thinking: "The user wants a fix; run tests first." });
		});

		it("joins tool args captured at tool_execution_start to the tool_execution_end record", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			await h.toolExecutionStart({ toolCallId: "call_1", toolName: "bash", args: { command: "ls -la" } });
			await h.toolExecutionEnd({
				toolCallId: "call_1",
				toolName: "bash",
				result: { output: "file.txt" },
				isError: false,
				durationMs: 12,
				parentToolCallId: "call_parent",
			});

			const records = await readLedger(tempDir);
			expect(records).toHaveLength(1);
			const record = records[0] as LearningToolAction;
			expect(record.kind).toBe("tool");
			expect(record.toolCallId).toBe("call_1");
			expect(record.toolName).toBe("bash");
			expect(record.args).toEqual({ command: "ls -la" });
			expect(record.result).toEqual({ output: "file.txt" });
			expect(record.isError).toBe(false);
			expect(record.durationMs).toBe(12);
			expect(record.parentToolCallId).toBe("call_parent");
		});

		it("links a tool action to the assistant action that requested it", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			const message = assistantMessage("Inspect the project.", 1000);
			await h.messageEnd(message);
			await h.toolExecutionStart({ toolCallId: "call_1000", toolName: "bash", args: { command: "ls" } });
			await h.toolExecutionEnd({
				toolCallId: "call_1000",
				toolName: "bash",
				result: { output: "file.txt" },
				isError: false,
			});

			const records = await readLedger(tempDir);
			const assistant = records[0] as LearningMessageAction;
			const tool = records[1] as LearningToolAction;
			expect(tool.parentActionId).toBe(assistant.actionId);
			expect(assistant.message).toEqual(message);
		});

		it("consumes captured args once; a repeated end event records null args", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			await h.toolExecutionStart({ toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
			await h.toolExecutionEnd({ toolCallId: "call_1", toolName: "bash", result: "first", isError: false });
			await h.toolExecutionEnd({ toolCallId: "call_1", toolName: "bash", result: "second", isError: false });

			const records = (await readLedger(tempDir)) as LearningToolAction[];
			expect(records).toHaveLength(2);
			expect(records[0].args).toEqual({ command: "ls" });
			expect(records[1].args).toBeNull();
		});

		it("records null args for tool_execution_end without a preceding start", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			await h.toolExecutionEnd({ toolCallId: "call_orphan", toolName: "read", result: "data", isError: true });

			const records = (await readLedger(tempDir)) as LearningToolAction[];
			expect(records).toHaveLength(1);
			expect(records[0].args).toBeNull();
			expect(records[0].isError).toBe(true);
		});

		it("suppresses duplicate appends for replayed message and tool events", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			const message = assistantMessage("done", 42);
			await h.messageEnd(message);
			await h.messageEnd(message);
			const toolEnd = { toolCallId: "call_1", toolName: "bash", result: "ok", isError: false };
			await h.toolExecutionEnd(toolEnd);
			await h.toolExecutionEnd(toolEnd);

			const records = await readLedger(tempDir);
			expect(records).toHaveLength(2);
			expect(records.map((record) => record.kind)).toEqual(["message", "tool"]);
		});
	});

	describe("project memory injection", () => {
		it("adds project memory to before_agent_start sections for trusted projects", async () => {
			const seeded = await ProjectMemoryStore.open(tempDir);
			await seeded.add("Uses pnpm, not npm.");

			const h = setup(tempDir, { trusted: true });
			await h.sessionStart();
			const event = await h.beforeAgentStart();

			const section = event.systemPromptOptions.sections.project_memory;
			expect(section).toContain("Project memory (curated; project-local only):");
			expect(section).toContain("Uses pnpm, not npm.");
		});

		it("does not inject project memory for untrusted projects", async () => {
			const seeded = await ProjectMemoryStore.open(tempDir);
			await seeded.add("Uses pnpm, not npm.");

			const h = setup(tempDir, { trusted: false });
			await h.sessionStart();
			const event = await h.beforeAgentStart();

			expect(event.systemPromptOptions.sections.project_memory).toBeUndefined();
		});

		it("injects nothing when project memory is empty", async () => {
			const h = setup(tempDir, { trusted: true });
			await h.sessionStart();
			const event = await h.beforeAgentStart();

			expect(event.systemPromptOptions.sections.project_memory).toBeUndefined();
		});

		it("refreshes external memory updates before the next prompt", async () => {
			const h = setup(tempDir, { trusted: true });
			await h.sessionStart();
			const before = await h.beforeAgentStart();
			expect(before.systemPromptOptions.sections.project_memory).toBeUndefined();

			const external = await ProjectMemoryStore.open(tempDir);
			await external.add("Added by an explicit CLI command.");

			const after = await h.beforeAgentStart();
			expect(after.systemPromptOptions.sections.project_memory).toContain("Added by an explicit CLI command.");
			const listed = await h.executeMemoryTool({ operation: "list" });
			expect(listed.text).toContain("Added by an explicit CLI command.");
		});
	});

	describe("settings", () => {
		it("learning.enabled=false disables all learning activity", async () => {
			const h = setup(tempDir, { learning: { enabled: false } });
			await h.sessionStart();
			await h.messageEnd(assistantMessage("hi", 1));
			await h.toolExecutionStart({ toolCallId: "c1", toolName: "bash", args: {} });
			await h.toolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
			const event = await h.beforeAgentStart();

			expect(event.systemPromptOptions.sections.project_memory).toBeUndefined();
			expect(existsSync(join(tempDir, CONFIG_DIR_NAME))).toBe(false);
		});

		it("learning.actionLog=false skips the ledger but keeps memory injection", async () => {
			const seeded = await ProjectMemoryStore.open(tempDir);
			await seeded.add("Tests run offline.");

			const h = setup(tempDir, { learning: { actionLog: false } });
			await h.sessionStart();
			await h.messageEnd(assistantMessage("hi", 1));
			await h.toolExecutionStart({ toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
			await h.toolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
			const event = await h.beforeAgentStart();

			expect(existsSync(join(tempDir, CONFIG_DIR_NAME, "learning", "actions.jsonl"))).toBe(false);
			expect(event.systemPromptOptions.sections.project_memory).toContain("Tests run offline.");
		});

		it("learning.memory=false skips memory injection but keeps the action ledger", async () => {
			const seeded = await ProjectMemoryStore.open(tempDir);
			await seeded.add("Tests run offline.");

			const h = setup(tempDir, { learning: { memory: false } });
			await h.sessionStart();
			const event = await h.beforeAgentStart();
			await h.messageEnd(assistantMessage("hi", 1));

			expect(event.systemPromptOptions.sections.project_memory).toBeUndefined();
			expect(await readLedger(tempDir)).toHaveLength(1);
		});
	});

	describe("project_memory tool", () => {
		it("lists empty memory", async () => {
			const h = setup(tempDir);
			await h.sessionStart();
			const result = await h.executeMemoryTool({ operation: "list" });
			expect(result.text).toBe("Project memory is empty.");
		});

		it("stages mutations as proposals until the user approves them", async () => {
			const h = setup(tempDir);
			await h.sessionStart();

			const staged = await h.executeMemoryTool({ operation: "add", content: "Build with tsc." });
			expect(staged.text).toContain("Staged");
			const proposal = (staged.details as { proposal: { id: string; status: string; kind: string } }).proposal;
			expect(proposal.status).toBe("pending");
			expect(proposal.kind).toBe("memory");

			// The mutation is not active in project memory yet.
			const memory = await ProjectMemoryStore.open(tempDir);
			expect(memory.list()).toHaveLength(0);
			const listed = await h.executeMemoryTool({ operation: "list" });
			expect(listed.text).toBe("Project memory is empty.");

			// The proposal is pending and visible through the /learning command.
			const proposals = await ImprovementProposalStore.open(tempDir);
			expect(proposals.list().map((p) => p.id)).toEqual([proposal.id]);
			await h.runCommand("learning", "pending");
			expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining(proposal.id));

			// Approval applies the staged mutation.
			await h.runCommand("learning", `approve ${proposal.id}`);
			expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("[applied]"));
			expect((await ProjectMemoryStore.open(tempDir)).list().map((entry) => entry.content)).toEqual([
				"Build with tsc.",
			]);
		});

		it("reloads cached project memory after /learning approve applies a memory proposal", async () => {
			const h = setup(tempDir, { trusted: true });
			await h.sessionStart();

			const staged = await h.executeMemoryTool({ operation: "add", content: "Uses pnpm, not npm." });
			const proposalId = (staged.details as { proposal: { id: string } }).proposal.id;

			// Populate the extension's cached (empty) memory store before approval.
			const before = await h.beforeAgentStart();
			expect(before.systemPromptOptions.sections.project_memory).toBeUndefined();

			await h.runCommand("learning", `approve ${proposalId}`);

			// The next prompt and tool list must observe the approved entry, not the stale cache.
			const after = await h.beforeAgentStart();
			expect(after.systemPromptOptions.sections.project_memory).toContain("Uses pnpm, not npm.");
			const listed = await h.executeMemoryTool({ operation: "list" });
			expect(listed.text).toContain("Uses pnpm, not npm.");
		});
	});

	describe("session_shutdown", () => {
		it("flushes queued ledger writes and clears captured tool args", async () => {
			const flushSpy = vi.spyOn(ProjectActionStore.prototype, "flush");
			try {
				const h = setup(tempDir);
				await h.sessionStart();

				// Queue a write, then shut down without awaiting the message handler first.
				const pending = h.messageEnd(assistantMessage("queued", 7));
				await h.sessionShutdown();
				await pending;

				expect(flushSpy).toHaveBeenCalled();
				expect(await readLedger(tempDir)).toHaveLength(1);

				// Args captured before shutdown are discarded, not joined to later end events.
				await h.toolExecutionStart({ toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
				await h.sessionShutdown();
				await h.toolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "ok", isError: false });

				const records = (await readLedger(tempDir)) as Array<LearningMessageAction | LearningToolAction>;
				expect(records).toHaveLength(2);
				const toolRecord = records[1] as LearningToolAction;
				expect(toolRecord.kind).toBe("tool");
				expect(toolRecord.args).toBeNull();
			} finally {
				flushSpy.mockRestore();
			}
		});
	});
});
