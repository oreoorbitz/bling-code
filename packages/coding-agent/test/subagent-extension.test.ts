import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, JsonValue } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { CODER_SYSTEM_PROMPT } from "../src/core/subagents/prompts.ts";
import type { SubagentRunSummary } from "../src/core/subagents/types.ts";
import {
	CODE_FILE_TOOL_NAME,
	createSubagentsExtension,
	MAX_RESULT_CHARS,
	renderSummaryText,
	SCOUT_TOOL_NAME,
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
	base = realpathSync(mkdtempSync(join(tmpdir(), "subagent-extension-")));
	root = join(base, "project");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
	writeFileSync(join(root, "src", "other.ts"), "other\n");
	writeFileSync(join(base, "secret.txt"), "secret\n");
	symlinkSync(join(base, "secret.txt"), join(root, "src", "link.txt"));
});

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
	rmSync(base, { recursive: true, force: true });
});

interface SetupOptions {
	subagents?: Settings["subagents"];
	model?: boolean;
	auth?: boolean;
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
	const faux = registerFaux();
	registrations.push(faux);
	const settings = { subagents: options.subagents } as Settings;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, () => void>();
	const api = {
		on: (event: string, handler: () => void) => handlers.set(event, handler),
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
			find: () => (options.model === false ? undefined : faux.getModel()),
			hasConfiguredAuth: () => options.auth !== false,
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

/** A session entry holding a finished subagent tool result, as the session manager stores it. */
function toolResultEntry(toolName: string, details: unknown) {
	return { type: "message", message: { role: "toolResult", toolName, toolCallId: "x", content: [], details } };
}

function summaryOf(result: { details?: unknown }): SubagentRunSummary {
	return result.details as SubagentRunSummary;
}

function toolCall(name: string, args: Record<string, JsonValue>): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

const finish = { summary: "done", uncertainties: ["maybe"], interfaceChanges: [] };
const ORACLE_CONTAINS_TWO = {
	command: node,
	args: ["-e", "process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('TWO') ? 0 : 1)"],
};

describe("registration", () => {
	it("registers only the tools whose kind has an active role", () => {
		expect([...setup({ subagents: undefined }).tools.keys()]).toEqual([]);
		expect([...setup({ subagents: SCOUT_ONLY }).tools.keys()].sort()).toEqual([
			SCOUT_TOOL_NAME,
			SUBAGENT_VERDICT_TOOL_NAME,
		]);
		const both = setup({ subagents: BOTH });
		expect([...both.tools.keys()].sort()).toEqual([CODE_FILE_TOOL_NAME, SCOUT_TOOL_NAME, SUBAGENT_VERDICT_TOOL_NAME]);
		expect(both.tools.get(CODE_FILE_TOOL_NAME)?.executionMode).toBe("sequential");
		expect(both.tools.get(SCOUT_TOOL_NAME)?.promptGuidelines).toBeUndefined();
		expect(both.tools.get(CODE_FILE_TOOL_NAME)?.promptGuidelines).toBeUndefined();
	});
});

describe("no fallback", () => {
	it("returns an error and sends no request when the model is missing", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY, model: false });
		faux.setResponses([fauxAssistantMessage("never")]);
		const result = await run(SCOUT_TOOL_NAME, { question: "q" });
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("model_missing") });
		expect(faux.state.callCount).toBe(0);
	});

	it("returns an error and sends no request when auth is missing", async () => {
		const { faux, run } = setup({ subagents: BOTH, auth: false });
		faux.setResponses([fauxAssistantMessage("never")]);
		const scout = await run(SCOUT_TOOL_NAME, { question: "q" });
		const coder = await run(CODE_FILE_TOOL_NAME, { path: "src/a.ts", change: "c", oracle: ORACLE_CONTAINS_TWO });
		for (const result of [scout, coder]) {
			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("auth_missing") });
		}
		expect(faux.state.callCount).toBe(0);
	});

	it("errors when the active role is removed after registration", async () => {
		const { faux, settings, run } = setup({ subagents: SCOUT_ONLY });
		settings.subagents = undefined;
		const result = await run(SCOUT_TOOL_NAME, { question: "q" });
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not_configured") });
		expect(faux.state.callCount).toBe(0);
	});

	it("sends different pins for two roles on the same model id", async () => {
		const routings: unknown[] = [];
		const samplings: unknown[] = [];
		const { faux, settings, run } = setup({
			subagents: {
				active: { scout: "a" },
				roles: {
					a: roleConfig("scout", { upstream: "chutes/fp8", sampling: { temperature: 0.2, top_k: 20 } }),
					b: roleConfig("scout", { upstream: "cerebras", sampling: { temperature: 0.4 } }),
				},
			},
		});
		const record = (_context: unknown, _options: unknown, _state: unknown, model: any) => {
			routings.push(model.compat?.openRouterRouting);
			samplings.push(model.samplingParams);
			return fauxAssistantMessage("stopped");
		};
		faux.setResponses([record, record]);
		await run(SCOUT_TOOL_NAME, { question: "q" });
		settings.subagents = { ...settings.subagents, active: { scout: "b" } };
		await run(SCOUT_TOOL_NAME, { question: "q" });
		expect(routings).toEqual([
			{ only: ["chutes/fp8"], allow_fallbacks: false, require_parameters: true },
			{ only: ["cerebras"], allow_fallbacks: false, require_parameters: true },
		]);
		expect(samplings).toEqual([{ temperature: 0.2, top_k: 20 }, { temperature: 0.4 }]);
	});
});

describe("upstream mismatch", () => {
	const served = (host: string | undefined) => ({
		...fauxAssistantMessage("stopped"),
		...(host === undefined ? {} : { responseProvider: host }),
	});
	const cases: Array<[string, string | undefined, boolean]> = [
		["matching host, different case", "Chutes", false],
		["different host", "Novita", true],
		["no served host reported", undefined, false],
	];
	for (const [name, host, expected] of cases) {
		it(`flags ${name} as upstreamMismatch=${expected}`, async () => {
			const { faux, run } = setup({ subagents: SCOUT_ONLY });
			faux.setResponses([served(host)]);
			const summary = summaryOf(await run(SCOUT_TOOL_NAME, { question: "q" }));
			expect(summary.requestedUpstream).toBe("chutes/fp8");
			expect(summary.servedUpstreams).toEqual(host === undefined ? [] : [host]);
			expect(summary.upstreamMismatch).toBe(expected);
		});
	}
});

describe("brief validation", () => {
	it("rejects oversized or malformed scout briefs without a request", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		faux.setResponses([fauxAssistantMessage("never")]);
		const results = [
			await run(SCOUT_TOOL_NAME, { question: "" }),
			await run(SCOUT_TOOL_NAME, { question: "q", context: "x".repeat(8001) }),
			await run(SCOUT_TOOL_NAME, { question: "q", startPaths: Array.from({ length: 21 }, () => "src") }),
			await run(SCOUT_TOOL_NAME, { question: "q", startPaths: ["../outside"] }),
		];
		for (const result of results) expect(result.isError).toBe(true);
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects bad coder briefs without a request", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([fauxAssistantMessage("never")]);
		const base = { path: "src/a.ts", change: "c", oracle: ORACLE_CONTAINS_TWO };
		const results = [
			await run(CODE_FILE_TOOL_NAME, { ...base, path: "../outside.ts" }),
			await run(CODE_FILE_TOOL_NAME, { ...base, path: "src/link.txt" }),
			await run(CODE_FILE_TOOL_NAME, { ...base, path: "missing/x.ts" }),
			await run(CODE_FILE_TOOL_NAME, { ...base, path: ".env" }),
			await run(CODE_FILE_TOOL_NAME, { ...base, change: " " }),
			await run(CODE_FILE_TOOL_NAME, { ...base, snippets: [{ text: "x".repeat(12001) }] }),
			await run(CODE_FILE_TOOL_NAME, { ...base, oracle: { command: "", args: [] } }),
		];
		for (const result of results) expect(result.isError, JSON.stringify(result.content)).toBe(true);
		expect(faux.state.callCount).toBe(0);
	});
});

function toolNamesSeen(): { names: string[][]; factory: (context: any) => AssistantMessage } {
	const names: string[][] = [];
	return {
		names,
		factory: (context) => {
			names.push(
				context.messages
					.filter((m: { role: string }) => m.role === "system")
					.flatMap((m: any) => (m.toolsAdded ?? []).map((t: any) => t.name)),
			);
			return fauxAssistantMessage("stopped");
		},
	};
}

describe("child tools", () => {
	it("gives each child exactly its allowed tools", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		const seen = toolNamesSeen();
		faux.setResponses([seen.factory, seen.factory]);
		await run(SCOUT_TOOL_NAME, { question: "q" });
		await run(CODE_FILE_TOOL_NAME, { path: "src/a.ts", change: "c", oracle: ORACLE_CONTAINS_TWO });
		expect(seen.names[0]).toEqual(["read", "grep", "find", "ls", "run_script", "report"]);
		expect(seen.names[1]).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"edit",
			"write",
			"run_oracle",
			"finish",
			"escalate",
		]);
		for (const names of seen.names) {
			expect(names).not.toContain("bash");
			expect(names).not.toContain(SCOUT_TOOL_NAME);
			expect(names).not.toContain(CODE_FILE_TOOL_NAME);
			expect(names).not.toContain(SUBAGENT_VERDICT_TOOL_NAME);
		}
	});
});

describe("scout", () => {
	it("returns evidence checked by the harness", async () => {
		const completed: Array<[SubagentRunSummary, string]> = [];
		const { faux, run } = setup({
			subagents: SCOUT_ONLY,
			onRunComplete: (summary, _ctx, id) => {
				completed.push([summary, id]);
			},
		});
		faux.setResponses([
			toolCall("ls", { path: "src" }),
			toolCall("read", { path: "src/a.ts" }),
			toolCall("read", { path: "../secret.txt" }),
			toolCall("report", {
				findings: [
					{
						claim: "a.ts has three lines",
						confidence: "high",
						evidence: [
							{ path: "src/a.ts", startLine: 1, endLine: 3 },
							{ path: "src/a.ts", startLine: 40, endLine: 50 },
						],
					},
				],
				unresolved: ["who calls it"],
				suggestedNextAction: "edit a.ts",
				confidence: "medium",
			}),
		]);
		const result = await run(SCOUT_TOOL_NAME, { question: "how long is a.ts", startPaths: ["src"] });
		const summary = summaryOf(result);
		expect(result.isError).toBeUndefined();
		expect(summary.outcome).toBe("completed");
		expect(summary.scout?.findings[0].evidence.map((e) => e.verified)).toEqual([true, false]);
		expect(summary.scout?.unresolved).toEqual(["who calls it"]);
		expect(summary.toolCalls.map((c) => [c.tool, c.isError])).toEqual([
			["ls", false],
			["read", false],
			["read", true],
			["report", false],
		]);
		expect(summary.scopeViolations).toBe(1);
		expect(summary.kind).toBe("scout");
		expect(summary.roleName).toBe("scout-a");
		expect(summary.requestedUpstream).toBe("chutes/fp8");
		expect(summary.provider).toBe("openrouter");
		expect(summary.turns).toBe(4);
		expect(JSON.parse((result.content[0] as { text: string }).text).outcome).toBe("completed");
		expect(completed).toHaveLength(1);
		expect(completed[0][0]).toEqual(summary);
		expect(completed[0][1]).toBe(`call-${SCOUT_TOOL_NAME}`);
	});

	it("reports no_report with the raw text when the scout stops without reporting", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		faux.setResponses([fauxAssistantMessage([fauxText("I looked around and found nothing.")])]);
		const result = await run(SCOUT_TOOL_NAME, { question: "q" });
		const summary = summaryOf(result);
		expect(summary.outcome).toBe("no_report");
		expect(summary.rawText).toContain("found nothing");
		expect(summary.scout).toBeUndefined();
	});

	it("keeps going when the hook throws", async () => {
		const { faux, run } = setup({
			subagents: SCOUT_ONLY,
			onRunComplete: () => {
				throw new Error("ledger down");
			},
		});
		faux.setResponses([fauxAssistantMessage("stopped")]);
		const result = await run(SCOUT_TOOL_NAME, { question: "q" });
		expect(summaryOf(result).outcome).toBe("no_report");
	});

	it("maps a failing request to an error result without retrying", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "host down" }),
			fauxAssistantMessage("never"),
		]);
		const result = await run(SCOUT_TOOL_NAME, { question: "q" });
		expect(result.isError).toBe(true);
		expect(summaryOf(result)).toMatchObject({ outcome: "error", error: "host down" });
		expect(faux.state.callCount).toBe(1);
	});
});

describe("code_file", () => {
	const brief = (overrides: Record<string, unknown> = {}) => ({
		path: "src/a.ts",
		change: "uppercase two",
		contract: "export nothing",
		oracle: ORACLE_CONTAINS_TWO,
		...overrides,
	});
	const editTwo = () => toolCall("edit", { path: "src/a.ts", edits: [{ oldText: "two", newText: "TWO" }] });

	it("passes when the file changed and the harness oracle succeeds", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([editTwo(), toolCall("run_oracle", {}), toolCall("finish", finish)]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(result.isError).toBeUndefined();
		expect(summary.outcome).toBe("passed");
		expect(summary.coder?.changed).toBe(true);
		expect(summary.coder?.diff).toContain("+TWO");
		expect(summary.coder?.oracle).toMatchObject({ passed: true, exitCode: 0, childRuns: 1 });
		expect(summary.coder?.uncertainties).toEqual(["maybe"]);
		expect(summary.coder?.beforeSha256).not.toBe(summary.coder?.afterSha256);
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
		expect(summary.requestedUpstream).toBe("cerebras");
	});

	it("reports oracle_failed and leaves the file as written", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([
			toolCall("edit", { path: "src/a.ts", edits: [{ oldText: "two", newText: "2" }] }),
			toolCall("finish", finish),
		]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(summary.outcome).toBe("oracle_failed");
		expect(summary.coder?.oracle).toMatchObject({ passed: false, exitCode: 1, childRuns: 0 });
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\n2\nthree\n");
	});

	it("reports no_change when the file is untouched", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([toolCall("finish", { summary: "cannot", uncertainties: [], interfaceChanges: [] })]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(summary.outcome).toBe("no_change");
		expect(summary.coder?.changed).toBe(false);
		expect(summary.coder?.oracle).toBeUndefined();
		expect(summary.coder?.diff).toBe("");
	});

	it("rejects writes to other paths and counts the violations", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([
			toolCall("write", { path: "src/other.ts", content: "pwned" }),
			toolCall("edit", { path: "../secret.txt", edits: [{ oldText: "secret", newText: "pwned" }] }),
			toolCall("write", { path: "src/link.txt", content: "pwned" }),
			toolCall("finish", finish),
		]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(summary.scopeViolations).toBe(3);
		expect(summary.outcome).toBe("no_change");
		expect(readFileSync(join(root, "src", "other.ts"), "utf-8")).toBe("other\n");
		expect(readFileSync(join(base, "secret.txt"), "utf-8")).toBe("secret\n");
		expect(summary.toolCalls.filter((call) => call.isError)).toHaveLength(3);
	});

	it("allows the child no more oracle runs than the cap", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([
			editTwo(),
			toolCall("run_oracle", {}),
			toolCall("run_oracle", {}),
			toolCall("finish", finish),
		]);
		const summary = summaryOf(await run(CODE_FILE_TOOL_NAME, brief()));
		expect(summary.coder?.oracle?.childRuns).toBe(1);
		expect(summary.toolCalls.map((call) => [call.tool, call.isError])).toContainEqual(["run_oracle", true]);
		expect(summary.outcome).toBe("passed");
	});

	it("returns early-stop outcomes with the file state", async () => {
		const { faux, run } = setup({
			subagents: {
				active: { coder: "c" },
				roles: { c: roleConfig("coder", { budgets: { maxTurns: 1 } }) },
			},
		});
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(summary.outcome).toBe("budget_turns");
		expect(result.isError).toBe(true);
		expect(summary.coder?.changed).toBe(true);
		expect(summary.coder?.oracle?.passed).toBe(true);
		expect(summary.coder?.summary).toContain("did not call finish");
	});
});

describe("code_file escalation and diff budget", () => {
	const brief = (overrides: Record<string, unknown> = {}) => ({
		path: "src/a.ts",
		change: "uppercase two",
		oracle: ORACLE_CONTAINS_TWO,
		...overrides,
	});
	const editTwo = () => toolCall("edit", { path: "src/a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
	const coderWith = (budgets: Record<string, number>): Settings["subagents"] => ({
		active: { coder: "c" },
		roles: { c: roleConfig("coder", { budgets }) },
	});

	it("ends with outcome escalated, keeps the partial edit, and skips the oracle", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([
			editTwo(),
			toolCall("escalate", {
				reason: "scope_expansion",
				detail: "caller in src/other.ts must change",
				filesNeeded: ["src/other.ts"],
			}),
		]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(summary.outcome).toBe("escalated");
		expect(result.isError).toBeUndefined();
		expect(summary.coder?.escalation).toEqual({
			reason: "scope_expansion",
			detail: "caller in src/other.ts must change",
			filesNeeded: ["src/other.ts"],
		});
		expect(summary.coder?.changed).toBe(true);
		expect(summary.coder?.oracle).toBeUndefined();
		expect(summary.coder?.summary).toBe("caller in src/other.ts must change");
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
	});

	it("is distinct from oracle_failed and no_change when nothing was edited", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([toolCall("escalate", { reason: "ambiguous_spec", detail: "which casing?" })]);
		const summary = summaryOf(await run(CODE_FILE_TOOL_NAME, brief()));
		expect(summary.outcome).toBe("escalated");
		expect(summary.coder?.changed).toBe(false);
		expect(summary.coder?.escalation?.filesNeeded).toBeUndefined();
	});

	it("tells the coder to escalate instead of working around scope", () => {
		expect(CODER_SYSTEM_PROMPT).toContain("call the escalate tool instead of finish");
		expect(CODER_SYSTEM_PROMPT).toContain("scope_expansion");
		expect(CODER_SYSTEM_PROMPT).toContain("Do not add code to the target file only to compensate");
	});

	it("reports diff_too_large, leaves the file as written, and still reports the oracle", async () => {
		const { faux, run } = setup({ subagents: coderWith({ maxDiffLines: 1 }) });
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		const result = await run(CODE_FILE_TOOL_NAME, brief());
		const summary = summaryOf(result);
		expect(summary.outcome).toBe("diff_too_large");
		expect(result.isError).toBeUndefined();
		expect(summary.coder?.diffLines).toBe(2);
		expect(summary.coder?.diff).toContain("+TWO");
		expect(summary.coder?.oracle?.passed).toBe(true);
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
	});

	it("passes when the change is within maxDiffLines", async () => {
		const { faux, run } = setup({ subagents: coderWith({ maxDiffLines: 2 }) });
		faux.setResponses([editTwo(), toolCall("finish", finish)]);
		const summary = summaryOf(await run(CODE_FILE_TOOL_NAME, brief()));
		expect(summary.outcome).toBe("passed");
		expect(summary.coder?.diffLines).toBe(2);
	});

	it("has no diff limit by default", async () => {
		const { faux, run } = setup({ subagents: BOTH });
		faux.setResponses([
			toolCall("write", { path: "src/a.ts", content: "TWO\n".repeat(500) }),
			toolCall("finish", finish),
		]);
		const summary = summaryOf(await run(CODE_FILE_TOOL_NAME, brief()));
		expect(summary.coder?.diffLines).toBeGreaterThan(400);
		expect(summary.outcome).toBe("passed");
	});
});

describe("tool call diagnostics in the summary", () => {
	it("records time to first tool call and failed tool calls separately from scope violations", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		faux.setResponses([
			toolCall("read", { path: "../secret.txt" }),
			toolCall("read", { path: "src/missing.ts" }),
			toolCall("read", { path: "src/a.ts" }),
			toolCall("report", { findings: [], unresolved: [], confidence: "low" }),
		]);
		const summary = summaryOf(await run(SCOUT_TOOL_NAME, { question: "q" }));
		expect(summary.scopeViolations).toBe(1);
		expect(summary.toolCalls.map((call) => call.isError)).toEqual([true, true, false, false]);
		expect(summary.failedToolCalls).toBe(2);
		expect(summary.timeToFirstToolCallMs).toBeGreaterThanOrEqual(0);
		expect(summary.timeToFirstToolCallMs).toBeLessThanOrEqual(summary.durationMs);
	});

	it("omits time to first tool call when the child never called a tool", async () => {
		const { faux, run } = setup({ subagents: SCOUT_ONLY });
		faux.setResponses([fauxAssistantMessage("no tools")]);
		const summary = summaryOf(await run(SCOUT_TOOL_NAME, { question: "q" }));
		expect(summary.outcome).toBe("no_report");
		expect(summary.timeToFirstToolCallMs).toBeUndefined();
		expect(summary.failedToolCalls).toBe(0);
	});
});

describe("subagent_verdict", () => {
	const recorded = () => {
		const calls: Array<{ verdict: unknown; toolCallId: string }> = [];
		const onVerdict: SubagentVerdictHook = (verdict, _ctx, toolCallId) => {
			calls.push({ verdict, toolCallId });
		};
		return { calls, onVerdict };
	};

	it("records a verdict for a run in the session branch, with the run's role", async () => {
		const { calls, onVerdict } = recorded();
		const { faux, run, branch } = setup({ subagents: BOTH, onVerdict });
		faux.setResponses([toolCall("report", { findings: [], unresolved: [], confidence: "low" })]);
		const scoutResult = await run(SCOUT_TOOL_NAME, { question: "q" });
		const summary = summaryOf(scoutResult);
		branch.push(toolResultEntry(SCOUT_TOOL_NAME, summary));
		const result = await run(SUBAGENT_VERDICT_TOOL_NAME, {
			runId: summary.runId,
			verdict: "accepted",
			reason: "evidence verified",
		});
		expect(result.isError).toBeUndefined();
		expect(calls).toEqual([
			{
				verdict: {
					runId: summary.runId,
					verdict: "accepted",
					reason: "evidence verified",
					role: "scout",
					roleName: "scout-a",
				},
				toolCallId: `call-${SUBAGENT_VERDICT_TOOL_NAME}`,
			},
		]);
	});

	it("rejects a runId that is not a subagent result in this session, without recording", async () => {
		const { calls, onVerdict } = recorded();
		const { run, branch } = setup({ subagents: BOTH, onVerdict });
		branch.push(toolResultEntry("bash", { runId: "run-1", kind: "scout", roleName: "x" }));
		for (const runId of ["run-1", "nope"]) {
			const result = await run(SUBAGENT_VERDICT_TOOL_NAME, { runId, verdict: "rejected", reason: "r" });
			expect(result.isError).toBe(true);
		}
		expect(calls).toEqual([]);
	});

	it("rejects an empty reason", async () => {
		const { calls, onVerdict } = recorded();
		const { run, branch } = setup({ subagents: BOTH, onVerdict });
		branch.push(toolResultEntry(CODE_FILE_TOOL_NAME, { runId: "run-1", kind: "coder", roleName: "coder-a" }));
		const result = await run(SUBAGENT_VERDICT_TOOL_NAME, { runId: "run-1", verdict: "rejected", reason: "  " });
		expect(result.isError).toBe(true);
		expect(calls).toEqual([]);
	});

	it("reports a ledger failure as an error result", async () => {
		const { run, branch } = setup({
			subagents: BOTH,
			onVerdict: () => {
				throw new Error("disk full");
			},
		});
		branch.push(toolResultEntry(CODE_FILE_TOOL_NAME, { runId: "run-1", kind: "coder", roleName: "coder-a" }));
		const result = await run(SUBAGENT_VERDICT_TOOL_NAME, { runId: "run-1", verdict: "accepted", reason: "ok" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("disk full");
	});

	it("is described in the scout and code_file tool text", () => {
		const { tools } = setup({ subagents: BOTH });
		expect(tools.get(SCOUT_TOOL_NAME)?.description).toContain(SUBAGENT_VERDICT_TOOL_NAME);
		expect(tools.get(CODE_FILE_TOOL_NAME)?.description).toContain(SUBAGENT_VERDICT_TOOL_NAME);
		expect(tools.get(CODE_FILE_TOOL_NAME)?.description).toContain("escalated");
		expect(tools.get(CODE_FILE_TOOL_NAME)?.description).toContain("diff_too_large");
	});
});

describe("renderSummaryText", () => {
	it("bounds large summaries", () => {
		const summary = {
			runId: "r",
			kind: "coder",
			outcome: "oracle_failed",
			toolCalls: Array.from({ length: 50 }, () => ({ tool: "edit", args: "x".repeat(200), isError: false })),
			coder: {
				path: "a",
				changed: true,
				diff: "d".repeat(20_000),
				summary: "s",
				uncertainties: [],
				interfaceChanges: [],
			},
		} as unknown as SubagentRunSummary;
		const text = renderSummaryText(summary);
		expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
		expect(text).toContain("oracle_failed");
	});
});
