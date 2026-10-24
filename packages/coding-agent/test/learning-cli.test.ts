import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLingLearningCommand } from "../src/cli/ling-learning.ts";
import { createMessageAction, getLearningPaths, ProjectActionStore } from "../src/core/learning/action-store.ts";
import { ImprovementProposalStore, type SkillProposal, stageMemoryProposal } from "../src/core/learning/improvement.ts";
import { ProjectMemoryStore } from "../src/core/learning/memory-store.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeProject(): { cwd: string; agentDir: string } {
	return { cwd: makeTempDir("ling-cli-project-"), agentDir: makeTempDir("ling-cli-agent-") };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

interface CliResult {
	handled: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | undefined;
}

/** Runs the command with console output and process.exitCode captured and restored. */
async function runCli(args: string[], cwd: string, agentDir: string): Promise<CliResult> {
	const logs: string[] = [];
	const errors: string[] = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		logs.push(parts.map(String).join(" "));
	});
	const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		errors.push(parts.map(String).join(" "));
	});
	const originalExitCode = process.exitCode;
	process.exitCode = undefined;
	try {
		const handled = await runLingLearningCommand(args, { cwd, agentDir });
		return {
			handled,
			stdout: logs.join("\n"),
			stderr: errors.join("\n"),
			exitCode: process.exitCode,
		};
	} finally {
		process.exitCode = originalExitCode;
		logSpy.mockRestore();
		errorSpy.mockRestore();
	}
}

function uniquePrefix(id: string, others: string[]): string {
	for (let length = 1; length <= id.length; length++) {
		const prefix = id.slice(0, length);
		if (others.every((other) => other === id || !other.startsWith(prefix))) return prefix;
	}
	return id;
}

describe("runLingLearningCommand", () => {
	it("returns false for unrelated commands without writing anything", async () => {
		const { cwd, agentDir } = makeProject();
		const result = await runCli(["auth", "check"], cwd, agentDir);
		expect(result.handled).toBe(false);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBeUndefined();
		expect(existsSync(join(cwd, ".bling"))).toBe(false);
	});

	it("prints help for learning --help and improve -h without touching the project", async () => {
		const { cwd, agentDir } = makeProject();
		for (const args of [
			["learning", "--help"],
			["improve", "-h"],
		]) {
			const result = await runCli(args, cwd, agentDir);
			expect(result.handled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(result.stdout).toContain("bling learning status");
			expect(result.stdout).toContain("bling learning approve <proposal-id>");
			expect(result.stdout).toContain("bling improve [--decider]");
		}
		expect(existsSync(join(cwd, ".bling"))).toBe(false);
	});

	it("reports an empty status for a fresh project without creating state", async () => {
		const { cwd, agentDir } = makeProject();
		for (const args of [["learning"], ["learning", "status"]]) {
			const result = await runCli(args, cwd, agentDir);
			expect(result.handled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(result.stdout).toContain(`Project learning directory: ${join(cwd, ".bling", "learning")}`);
			expect(result.stdout).toContain("Actions: 0");
			expect(result.stdout).toContain("Memories: 0");
			expect(result.stdout).toContain("Pending proposals: 0");
		}
		expect(existsSync(join(cwd, ".bling"))).toBe(false);
	});

	it("rejects unknown learning subcommands with an error and no writes", async () => {
		const { cwd, agentDir } = makeProject();
		const result = await runCli(["learning", "frobnicate"], cwd, agentDir);
		expect(result.handled).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown learning subcommand: frobnicate");
		expect(existsSync(join(cwd, ".bling"))).toBe(false);
	});

	describe("actions", () => {
		it("lists recorded actions and searches them offline", async () => {
			const { cwd, agentDir } = makeProject();
			const store = ProjectActionStore.open(cwd);
			const message = { role: "user", content: "Fix the flaky cache test", timestamp: 1 } as AgentMessage;
			const action = createMessageAction(cwd, "session-1", message);
			await store.append(action);
			await store.flush();

			const listed = await runCli(["learning", "actions"], cwd, agentDir);
			expect(listed.handled).toBe(true);
			expect(listed.exitCode).toBeUndefined();
			expect(listed.stdout).toContain(action.actionId);
			expect(listed.stdout).toContain("message");

			const found = await runCli(["learning", "actions", "flaky"], cwd, agentDir);
			expect(found.stdout).toContain(action.actionId);

			const missed = await runCli(["learning", "actions", "no-such-term"], cwd, agentDir);
			expect(missed.stdout).toContain("No matching project actions.");
		});

		it("prints a notice when there are no actions", async () => {
			const { cwd, agentDir } = makeProject();
			const result = await runCli(["learning", "actions"], cwd, agentDir);
			expect(result.handled).toBe(true);
			expect(result.stdout).toContain("No matching project actions.");
		});
	});

	describe("memory", () => {
		it("reports empty memory for a fresh project", async () => {
			const { cwd, agentDir } = makeProject();
			const result = await runCli(["learning", "memory"], cwd, agentDir);
			expect(result.handled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(result.stdout).toContain("Project memory is empty.");
		});

		it("adds, lists, and removes user memory entries", async () => {
			const { cwd, agentDir } = makeProject();
			const added = await runCli(["learning", "memory", "add", "Prefer", "pnpm", "over", "npm."], cwd, agentDir);
			expect(added.handled).toBe(true);
			expect(added.exitCode).toBeUndefined();
			expect(added.stdout).toMatch(/^Added mem_/);

			const store = await ProjectMemoryStore.open(cwd);
			expect(store.list()).toHaveLength(1);
			expect(store.list()[0].content).toBe("Prefer pnpm over npm.");
			expect(store.list()[0].source).toBe("user");
			const id = store.list()[0].id;

			const duplicate = await runCli(["learning", "memory", "add", "Prefer", "pnpm", "over", "npm."], cwd, agentDir);
			expect(duplicate.stdout).toBe(`Already present ${id}`);
			expect((await ProjectMemoryStore.open(cwd)).list()).toHaveLength(1);

			const listed = await runCli(["learning", "memory"], cwd, agentDir);
			expect(listed.stdout).toContain(`- [${id}] Prefer pnpm over npm.`);

			const removed = await runCli(["learning", "memory", "remove", id], cwd, agentDir);
			expect(removed.stdout).toBe(`Removed ${id}`);
			expect((await ProjectMemoryStore.open(cwd)).list()).toHaveLength(0);
		});

		it("supports id prefixes for remove", async () => {
			const { cwd, agentDir } = makeProject();
			const store = await ProjectMemoryStore.open(cwd);
			const first = await store.add("First fact.");
			const second = await store.add("Second fact.");
			const prefix = uniquePrefix(first.entry.id, [second.entry.id]);

			const removed = await runCli(["learning", "memory", "remove", prefix], cwd, agentDir);
			expect(removed.exitCode).toBeUndefined();
			expect(removed.stdout).toBe(`Removed ${first.entry.id}`);
			expect((await ProjectMemoryStore.open(cwd)).list().map((entry) => entry.id)).toEqual([second.entry.id]);
		});

		it("errors on missing text, missing id, and unknown id without writes", async () => {
			const { cwd, agentDir } = makeProject();

			const noText = await runCli(["learning", "memory", "add"], cwd, agentDir);
			expect(noText.exitCode).toBe(1);
			expect(noText.stderr).toContain("bling learning memory add requires text");

			const noId = await runCli(["learning", "memory", "remove"], cwd, agentDir);
			expect(noId.exitCode).toBe(1);
			expect(noId.stderr).toContain("bling learning memory remove requires an ID");

			const unknown = await runCli(["learning", "memory", "remove", "mem_doesnotexist"], cwd, agentDir);
			expect(unknown.exitCode).toBe(1);
			expect(unknown.stderr).toContain('no project memory entry matches "mem_doesnotexist"');

			expect(existsSync(join(cwd, ".bling"))).toBe(false);
		});
	});

	describe("proposals", () => {
		it("reports no proposals for a fresh project", async () => {
			const { cwd, agentDir } = makeProject();
			for (const args of [
				["learning", "list"],
				["learning", "pending"],
			]) {
				const result = await runCli(args, cwd, agentDir);
				expect(result.handled).toBe(true);
				expect(result.exitCode).toBeUndefined();
				expect(result.stdout).toContain("No proposals.");
			}
			expect(existsSync(join(cwd, ".bling"))).toBe(false);
		});

		it("lists and shows staged proposals by id and unique prefix", async () => {
			const { cwd, agentDir } = makeProject();
			const first = await stageMemoryProposal(cwd, { operation: "add", content: "Build with tsc." });
			const second = await stageMemoryProposal(cwd, { operation: "add", content: "Test with vitest." });

			const listed = await runCli(["learning", "list"], cwd, agentDir);
			expect(listed.exitCode).toBeUndefined();
			expect(listed.stdout).toContain(`${first.id}\tpending\tmemory/add\tadd project memory`);
			expect(listed.stdout).toContain(`${second.id}\tpending\tmemory/add\tadd project memory`);

			const shown = await runCli(["learning", "show", first.id], cwd, agentDir);
			const parsed = JSON.parse(shown.stdout);
			expect(parsed.id).toBe(first.id);
			expect(parsed.kind).toBe("memory");
			expect(parsed.operation).toBe("add");
			expect(parsed.content).toBe("Build with tsc.");
			expect(parsed.status).toBe("pending");

			const prefix = uniquePrefix(second.id, [first.id]);
			const shownByPrefix = await runCli(["learning", "show", prefix], cwd, agentDir);
			expect(JSON.parse(shownByPrefix.stdout).id).toBe(second.id);
		});

		it("approves a staged memory-add proposal into project memory", async () => {
			const { cwd, agentDir } = makeProject();
			const staged = await stageMemoryProposal(cwd, { operation: "add", content: "Node 22 is pinned." });

			const approved = await runCli(["learning", "approve", staged.id], cwd, agentDir);
			expect(approved.exitCode).toBeUndefined();
			expect(approved.stdout).toContain(`applied: ${staged.id}`);
			expect(approved.stdout).not.toContain("Restart or /reload");

			const memory = await ProjectMemoryStore.open(cwd);
			expect(memory.list()).toHaveLength(1);
			expect(memory.list()[0].content).toBe("Node 22 is pinned.");
			expect(memory.list()[0].source).toBe("review");

			const pending = await runCli(["learning", "pending"], cwd, agentDir);
			expect(pending.stdout).toContain("No proposals.");

			const status = await runCli(["learning", "status"], cwd, agentDir);
			expect(status.stdout).toContain("Pending proposals: 0");
			expect(status.stdout).toContain("Memories: 1");
		});

		it("rejects a staged proposal and refuses to reject it twice", async () => {
			const { cwd, agentDir } = makeProject();
			const keep = await stageMemoryProposal(cwd, { operation: "add", content: "Keep this fact." });
			const drop = await stageMemoryProposal(cwd, { operation: "add", content: "Drop this fact." });

			const rejected = await runCli(["learning", "reject", drop.id], cwd, agentDir);
			expect(rejected.exitCode).toBeUndefined();
			expect(rejected.stdout).toContain(`rejected: ${drop.id}`);

			const pending = await runCli(["learning", "pending"], cwd, agentDir);
			expect(pending.stdout).toContain(keep.id);
			expect(pending.stdout).not.toContain(drop.id);

			const again = await runCli(["learning", "reject", drop.id], cwd, agentDir);
			expect(again.exitCode).toBe(1);
			expect(again.stderr).toContain("Proposal is rejected, not pending");

			const approveRejected = await runCli(["learning", "approve", drop.id], cwd, agentDir);
			expect(approveRejected.exitCode).toBe(1);
			expect(approveRejected.stderr).toContain("Proposal is rejected, not pending");
			expect((await ProjectMemoryStore.open(cwd)).list()).toHaveLength(0);
		});

		it("approves a synthetic skill proposal and writes the SKILL.md inside the project", async () => {
			const { cwd, agentDir } = makeProject();
			const content = [
				"---",
				"name: test-skill",
				"description: A synthetic skill for CLI tests.",
				"---",
				"",
				"Follow the project build steps.",
				"",
			].join("\n");
			const proposal: SkillProposal = {
				id: "prop_skilltest",
				reviewId: "rev_skilltest",
				title: "create test-skill",
				rationale: "Synthetic proposal for CLI coverage",
				evidenceActionIds: ["act_synthetic"],
				evidence: [{ actionId: "act_synthetic", evidenceClass: "inferred" }],
				status: "pending",
				createdAt: 1,
				updatedAt: 1,
				kind: "skill",
				operation: "create",
				name: "test-skill",
				content,
			};
			const store = await ImprovementProposalStore.open(cwd);
			await store.add([proposal]);

			const approved = await runCli(["learning", "approve", proposal.id], cwd, agentDir);
			expect(approved.exitCode).toBeUndefined();
			expect(approved.stdout).toContain(`applied: ${proposal.id}`);
			expect(approved.stdout).toContain("Restart or /reload sessions to load the skill.");

			const skillPath = join(cwd, ".bling", "skills", "test-skill", "SKILL.md");
			expect(readFileSync(skillPath, "utf-8")).toBe(content);
			const reopened = await ImprovementProposalStore.open(cwd);
			expect(reopened.get(proposal.id).status).toBe("applied");
		});

		it("errors on missing and unknown proposal ids without creating state", async () => {
			const { cwd, agentDir } = makeProject();

			const showNoId = await runCli(["learning", "show"], cwd, agentDir);
			expect(showNoId.exitCode).toBe(1);
			expect(showNoId.stderr).toContain("bling learning show requires a proposal ID");

			const approveNoId = await runCli(["learning", "approve"], cwd, agentDir);
			expect(approveNoId.exitCode).toBe(1);
			expect(approveNoId.stderr).toContain("bling learning approve requires a proposal ID");

			const rejectNoId = await runCli(["learning", "reject"], cwd, agentDir);
			expect(rejectNoId.exitCode).toBe(1);
			expect(rejectNoId.stderr).toContain("bling learning reject requires a proposal ID");

			const showUnknown = await runCli(["learning", "show", "prop_doesnotexist"], cwd, agentDir);
			expect(showUnknown.exitCode).toBe(1);
			expect(showUnknown.stderr).toContain("Proposal not found");

			const approveUnknown = await runCli(["learning", "approve", "prop_doesnotexist"], cwd, agentDir);
			expect(approveUnknown.exitCode).toBe(1);
			expect(approveUnknown.stderr).toContain("Proposal not found");

			expect(existsSync(join(cwd, ".bling"))).toBe(false);
		});
	});

	describe("cursor recovery", () => {
		it("skips a poison batch without loading a model and resets the cursor explicitly", async () => {
			const { cwd, agentDir } = makeProject();
			const actions = ProjectActionStore.open(cwd);
			const action = createMessageAction(cwd, "session-1", {
				role: "user",
				content: "poison batch",
				timestamp: 1,
			} as AgentMessage);
			await actions.append(action);

			const skipped = await runCli(["learning", "cursor", "skip"], cwd, agentDir);
			expect(skipped.exitCode).toBeUndefined();
			expect(skipped.stdout).toContain(`Skipped 1 action(s) through ${action.actionId}`);
			expect(JSON.parse(readFileSync(getLearningPaths(cwd).cursor, "utf8")).lastActionId).toBe(action.actionId);

			const reset = await runCli(["learning", "cursor", "reset"], cwd, agentDir);
			expect(reset.stdout).toBe("Review cursor reset.");
			expect(existsSync(getLearningPaths(cwd).cursor)).toBe(false);
		});
	});

	describe("improve argument validation", () => {
		it("requires a value for --model and rejects unknown model references offline", async () => {
			const { cwd, agentDir } = makeProject();
			const originalOffline = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				const missingValue = await runCli(["improve", "--model"], cwd, agentDir);
				expect(missingValue.handled).toBe(true);
				expect(missingValue.exitCode).toBe(1);
				expect(missingValue.stderr).toContain("--model requires provider/model");

				const unknownModel = await runCli(
					["improve", "--model", "zz-no-such-provider/zz-no-such-model"],
					cwd,
					agentDir,
				);
				expect(unknownModel.handled).toBe(true);
				expect(unknownModel.exitCode).toBe(1);
				expect(unknownModel.stderr).toContain('Model "zz-no-such-provider/zz-no-such-model" not found');
			} finally {
				if (originalOffline === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = originalOffline;
			}
			expect(existsSync(join(cwd, ".bling"))).toBe(false);
		});
	});
});
