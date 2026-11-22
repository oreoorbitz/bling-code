import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { longSessionConfig } from "../src/core/long-session/config.ts";
import {
	HARD_TOOL_CALL_CAP,
	isGitOverviewInspection,
	LoopGuard,
	SOFT_TOOL_CALL_CAP,
} from "../src/core/long-session/loop-guard.ts";
import { ReadCache } from "../src/core/long-session/read-cache.ts";
import { CLEARED_TOOL_RESULT, ToolResultClearing } from "../src/core/long-session/tool-result-clearing.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { armIdFromSettings } from "../src/core/subagents/roles.ts";
import { createLongSessionExtension } from "../src/extensions/long-session/index.ts";

describe("LoopGuard", () => {
	const repeat = (guard: LoopGuard, times: number, input: unknown = { path: "a.ts" }) =>
		Array.from({ length: times }, () => guard.observe("read", input));

	it("reminds once at the third identical call and stops at the fifth under stop", () => {
		const verdicts = repeat(new LoopGuard("stop"), 5);
		expect(verdicts.slice(0, 2)).toEqual([{}, {}]);
		expect(verdicts[2]?.reminder).toContain("`read` has been called 3 times in a row with identical arguments");
		expect(verdicts[2]?.reminder).toContain("Repeating the same call stops this turn.");
		expect(verdicts[3]).toEqual({});
		expect(verdicts[4]?.stop).toContain("called 5 times");
	});

	it("only reminds under warn, does nothing under off, and restarts the streak on a different call", () => {
		const warn = repeat(new LoopGuard("warn"), 5);
		expect(warn[4]?.stop).toBeUndefined();
		expect(warn[4]?.reminder).toContain("called 5 times");
		expect(warn[2]?.reminder).not.toContain("stops this turn");
		expect(repeat(new LoopGuard("off"), 6).every((verdict) => verdict.reminder === undefined)).toBe(true);
		const guard = new LoopGuard("stop");
		repeat(guard, 2);
		guard.observe("read", { path: "b.ts" });
		expect(repeat(guard, 2).every((verdict) => verdict.reminder === undefined)).toBe(true);
	});

	it("treats argument key order as identical", () => {
		const guard = new LoopGuard("stop");
		guard.observe("read", { path: "a.ts", offset: 1 });
		guard.observe("read", { offset: 1, path: "a.ts" });
		expect(guard.observe("read", { path: "a.ts", offset: 1 }).reminder).toBeDefined();
	});

	it("catches repeated repository inspection with varying commands", () => {
		const guard = new LoopGuard("stop");
		const commands = [
			"git status",
			"git diff",
			"git status --short",
			"git diff HEAD",
			"git ls-files",
			"git diff --stat",
		];
		const verdicts = [...commands, "git status -s", "git --no-pager diff"].map((command) =>
			guard.observe("bash", { command }),
		);
		expect(verdicts[5]?.reminder).toContain("The last 6 shell commands only inspected the repository");
		expect(verdicts[7]?.stop).toContain("More of the same inspection stops this turn.");
	});

	it("classifies only overview git commands as inspection", () => {
		expect(isGitOverviewInspection("git status && git diff")).toBe(true);
		expect(isGitOverviewInspection("git diff HEAD~1..HEAD --stat")).toBe(true);
		expect(isGitOverviewInspection("git diff -- src/a.ts")).toBe(false);
		expect(isGitOverviewInspection("git diff src/a.ts")).toBe(false);
		expect(isGitOverviewInspection("git status && npm test")).toBe(false);
		expect(isGitOverviewInspection("git add -A")).toBe(false);
	});

	it("past the soft cap stops on a call repeated across the run, and stops at the hard cap even under warn", () => {
		const guard = new LoopGuard("stop");
		for (let index = 0; index < SOFT_TOOL_CALL_CAP; index++) guard.observe("read", { path: `f${index}` });
		const verdicts = Array.from({ length: 12 }, (_, index) =>
			guard.observe("grep", index % 2 === 0 ? { pattern: "x" } : { pattern: `y${index}` }),
		);
		expect(verdicts.find((verdict) => verdict.reminder !== undefined)?.pattern).toBe("turn_cap");
		expect(verdicts.find((verdict) => verdict.stop !== undefined)?.count).toBe(6);

		const warn = new LoopGuard("warn");
		let last = {};
		for (let index = 0; index <= HARD_TOOL_CALL_CAP; index++) last = warn.observe("read", { path: `f${index}` });
		expect(last).toMatchObject({ pattern: "turn_cap", stop: expect.stringContaining("more than 1000") });
	});
});

function toolResult(id: string, toolName: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	} as AgentMessage;
}

const textOf = (message: AgentMessage | undefined) =>
	message?.role === "toolResult"
		? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
		: "";

describe("ToolResultClearing", () => {
	it("does nothing under the threshold", () => {
		const messages = [toolResult("1", "read", "x".repeat(40)), toolResult("2", "read", "x".repeat(40))];
		expect(new ToolResultClearing().apply(messages, 100, 1)).toEqual({ messages: undefined, newlyCleared: [] });
	});

	it("clears the oldest clearable results down to half the threshold and keeps recent, errors, and subagents", () => {
		const messages = [
			toolResult("1", "read", "a".repeat(30)),
			toolResult("2", "bash", "b".repeat(30), true),
			toolResult("3", "scout", "c".repeat(30)),
			toolResult("4", "grep", "d".repeat(30)),
			toolResult("5", "read", "e".repeat(30)),
			toolResult("6", "read", "f".repeat(30)),
		];
		const { messages: context, newlyCleared } = new ToolResultClearing().apply(messages, 100, 1);
		// Clearable total 120 > 100: clear oldest until <= 50, never the last one.
		expect(newlyCleared.map((result) => result.toolCallId)).toEqual(["1", "4", "5"]);
		expect(context?.map(textOf)).toEqual([
			CLEARED_TOOL_RESULT,
			"b".repeat(30),
			"c".repeat(30),
			CLEARED_TOOL_RESULT,
			CLEARED_TOOL_RESULT,
			"f".repeat(30),
		]);
	});

	it("keeps earlier clearings and does not clear again until the threshold is crossed again", () => {
		const clearing = new ToolResultClearing();
		const messages = Array.from({ length: 4 }, (_, index) => toolResult(String(index), "read", "x".repeat(30)));
		expect(clearing.apply(messages, 100, 1).newlyCleared).toHaveLength(3);
		const more = [...messages, toolResult("4", "read", "x".repeat(30))];
		const second = clearing.apply(more, 100, 1);
		expect(second.newlyCleared).toEqual([]);
		expect(second.messages?.slice(0, 3).map(textOf)).toEqual([
			CLEARED_TOOL_RESULT,
			CLEARED_TOOL_RESULT,
			CLEARED_TOOL_RESULT,
		]);
	});
});

describe("ReadCache", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "read-cache-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("matches an unchanged file and range only, and forgets evicted results", () => {
		const file = join(dir, "a.txt");
		writeFileSync(file, "one\n");
		const cache = new ReadCache();
		cache.record(statSync(file), {}, "call-1");
		expect(cache.isUnchanged(statSync(file), {})).toBe(true);
		expect(cache.isUnchanged(statSync(file), { offset: 2 })).toBe(false);
		writeFileSync(file, "one\ntwo\n");
		expect(cache.isUnchanged(statSync(file), {})).toBe(false);
		cache.record(statSync(file), {}, "call-2");
		cache.evict(new Set(["call-2"]));
		expect(cache.isUnchanged(statSync(file), {})).toBe(false);
	});
});

describe("long-session extension", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "long-session-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function setup(settings: Partial<Settings> = {}) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			getSettings: () => settings as Settings,
		} as unknown as ExtensionAPI;
		createLongSessionExtension()(api);
		const ctx = { cwd: dir };
		const emit = (name: string, event: object) => handlers.get(name)?.({ type: name, ...event }, ctx);
		emit("agent_start", {});
		const read = async (id: string, input: object = { path: "src/a.ts" }) => {
			emit("tool_call", { toolName: "read", toolCallId: id, input });
			return (await emit("tool_result", {
				toolName: "read",
				toolCallId: id,
				input,
				content: [{ type: "text", text: "export const a = 1;\n" }],
				isError: false,
			})) as { content: Array<{ text: string }> } | undefined;
		};
		return { emit, read };
	}

	it("answers a repeated read of an unchanged file with a note, and reads again after a change", async () => {
		const { read } = setup();
		expect(await read("1")).toBeUndefined();
		expect((await read("2"))?.content[0]?.text).toContain("File src/a.ts is unchanged since it was last read");
		expect(await read("3", { path: "src/a.ts", offset: 1 })).toBeUndefined();
		const future = new Date(Date.now() + 5_000);
		writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
		utimesSync(join(dir, "src", "a.ts"), future, future);
		expect(await read("4")).toBeUndefined();
	});

	it("reads again once the earlier result was cleared from the context", async () => {
		const { emit, read } = setup({ longSession: { clearToolResultsChars: 30, keepRecentToolResults: 1 } });
		await read("1");
		await emit("context", {
			messages: [
				toolResult("1", "read", "x".repeat(20)),
				toolResult("x", "bash", "y".repeat(20)),
				toolResult("y", "bash", "z".repeat(20)),
			],
		});
		expect(await read("2")).toBeUndefined();
	});

	it("appends the loop reminder to the result and blocks the stop-point call under stop", async () => {
		const { emit } = setup({ longSession: { loopProtection: "stop", readCache: false } });
		const call = (id: string) => emit("tool_call", { toolName: "bash", toolCallId: id, input: { command: "ls" } });
		call("1");
		call("2");
		expect(call("3")).toBeUndefined();
		const result = (await emit("tool_result", {
			toolName: "bash",
			toolCallId: "3",
			input: { command: "ls" },
			content: [{ type: "text", text: "a.ts" }],
			isError: false,
		})) as { content: Array<{ text: string }> };
		expect(result.content.map((part) => part.text)).toEqual(["a.ts", expect.stringContaining("System: `bash`")]);
		call("4");
		expect(call("5")).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("System:") });
	});

	it("is inactive under the stock harness profile", async () => {
		const { emit, read } = setup({ harness: { profile: "stock" } });
		await read("1");
		expect(await read("2")).toBeUndefined();
		for (let index = 0; index < 6; index++) {
			expect(emit("tool_call", { toolName: "bash", toolCallId: `b${index}`, input: { command: "ls" } })).toBe(
				undefined,
			);
		}
		expect(longSessionConfig("stock", { readCache: true }).readCache).toBe(false);
	});

	it("changes the benchmark arm ID only when the guards differ from the profile's default", () => {
		const base = armIdFromSettings("bling", undefined, {});
		expect(base).toBe("bling:unlabeled:none");
		expect(armIdFromSettings("bling", undefined, {}, { readCache: true })).toBe(base);
		expect(armIdFromSettings("bling", undefined, {}, { readCache: false })).not.toBe(base);
		expect(armIdFromSettings("stock", undefined, {}, { readCache: false })).toBe("stock:unlabeled:none");
	});
});
