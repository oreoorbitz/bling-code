import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLingBenchmarkCommand } from "../src/cli/ling-benchmark.ts";
import {
	getLearningPaths,
	type LearningBenchmarkAction,
	ProjectActionStore,
	REDACTED,
} from "../src/core/learning/action-store.ts";
import { buildBenchmarkReport } from "../src/core/learning/benchmark-report.ts";
import { BENCHMARK_OUTPUT_LIMIT_CHARS, ProjectBenchmarkStore } from "../src/core/learning/benchmarks.ts";
import {
	ENV_BENCHMARK_ARM,
	ENV_BENCHMARK_RUN_ID,
	ENV_SUBAGENT_DELEGATION,
	ENV_SUBAGENT_ROLE,
} from "../src/core/subagents/roles.ts";

const tempDirs: string[] = [];

function makeProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "ling-benchmark-"));
	tempDirs.push(dir);
	return dir;
}

function nodeScript(script: string) {
	return { command: process.execPath, args: ["-e", script] };
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.LING_BENCHMARK_CANARY;
	delete process.env.LING_BENCHMARK_SECRET;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("ProjectBenchmarkStore", () => {
	it("derives stable content-addressed benchmark IDs and persists definitions", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		const added = await store.add({
			name: "unit-oracle",
			description: "A local executable oracle",
			...nodeScript("console.log('ok')"),
			oracle: { outputIncludes: ["ok"] },
		});
		expect(added.id).toMatch(/^bench_[0-9a-f]{32}$/);
		expect(added.definitionHash).toMatch(/^[0-9a-f]{64}$/);
		expect(store.get("unit-oracle").id).toBe(added.id);
		expect(store.get(added.id.slice(0, 16)).id).toBe(added.id);

		const reopened = await ProjectBenchmarkStore.open(project);
		expect(reopened.list()).toEqual([added]);
		const other = await ProjectBenchmarkStore.open(makeProject());
		expect(other.list()).toEqual([]);
		expect(existsSync(join(project, ".bling", "benchmarks.json"))).toBe(true);
	});

	it("rejects invalid and duplicate definitions", async () => {
		const store = await ProjectBenchmarkStore.open(makeProject());
		await expect(store.add({ name: "Bad_Name", command: "node" })).rejects.toThrow(/lowercase hyphenated/);
		await expect(store.add({ name: "ok", command: " " })).rejects.toThrow(/nonempty/);
		await store.add({ name: "ok", ...nodeScript("") });
		await expect(store.add({ name: "ok", ...nodeScript("") })).rejects.toThrow(/already exists/);
	});

	it("executes a passing oracle and appends a complete run action", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		const benchmark = await store.add({
			name: "passing",
			...nodeScript("console.log('oracle-pass'); console.error('diagnostic')"),
			oracle: { exitCode: 0, stdoutIncludes: ["oracle-pass"], stderrIncludes: ["diagnostic"] },
		});
		const result = await store.run(benchmark.name);
		expect(result.actionId).toMatch(/^run_[0-9a-f]{32}$/);
		expect(result.kind).toBe("benchmark");
		expect(result.passed).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.stdout).toContain("oracle-pass");
		expect(result.stderr).toContain("diagnostic");
		expect(result.checks.every((check) => check.passed)).toBe(true);

		const ledger = await ProjectActionStore.open(project).list();
		expect(ledger).toEqual([result]);
		expect(getLearningPaths(project).actions).toBe(join(project, ".bling", "learning", "actions.jsonl"));
	});

	it("records assertion and process failures instead of hiding them", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		await store.add({
			name: "wrong-output",
			...nodeScript("console.log('actual')"),
			oracle: { outputIncludes: ["expected"], outputExcludes: ["actual"] },
		});
		const failed = await store.run("wrong-output");
		expect(failed.passed).toBe(false);
		expect(failed.exitCode).toBe(0);
		expect(failed.checks.filter((check) => !check.passed)).toHaveLength(2);

		await store.add({ name: "nonzero", ...nodeScript("process.exit(7)"), oracle: { exitCode: 0 } });
		expect((await store.run("nonzero")).passed).toBe(false);
		await store.add({ name: "expected-nonzero", ...nodeScript("process.exit(7)"), oracle: { exitCode: 7 } });
		expect((await store.run("expected-nonzero")).passed).toBe(true);
	});

	it("records timeouts and spawn failures as failed runs", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		await store.add({ name: "timeout", ...nodeScript("setTimeout(() => {}, 1000)"), timeoutMs: 20 });
		const timedOut = await store.run("timeout");
		expect(timedOut.passed).toBe(false);
		expect(timedOut.timedOut).toBe(true);
		expect(timedOut.checks).toContainEqual({ name: "timeout", expected: 20, passed: false });

		await store.add({ name: "missing", command: "definitely-not-a-real-ling-benchmark-command" });
		const missing = await store.run("missing");
		expect(missing.passed).toBe(false);
		expect(missing.error).toBeTruthy();
	});

	it("force-kills a timed-out child that ignores SIGTERM", async () => {
		const store = await ProjectBenchmarkStore.open(makeProject());
		await store.add({
			name: "ignores-term",
			...nodeScript("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
			timeoutMs: 20,
		});
		const result = await store.run("ignores-term");
		expect(result.passed).toBe(false);
		expect(result.timedOut).toBe(true);
	});

	it("keeps benchmark cwd inside the project", async () => {
		const store = await ProjectBenchmarkStore.open(makeProject());
		await store.add({ name: "escape", ...nodeScript(""), cwd: "../" });
		await expect(store.run("escape")).rejects.toThrow(/inside the project/);
		expect(await ProjectActionStore.open(store.cwd).list()).toEqual([]);
	});

	it("isolates child credentials by default and permits explicit environment access", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		process.env.LING_BENCHMARK_CANARY = "visible-canary-value";
		process.env.LING_BENCHMARK_SECRET = "secret-canary-value";
		await store.add({
			name: "clean-env",
			...nodeScript("console.log(process.env.LING_BENCHMARK_SECRET ?? 'missing')"),
		});
		const isolated = await store.run("clean-env");
		expect(isolated.stdout.trim()).toBe("missing");
		expect(isolated.environmentMode).toBe("isolated");
		expect(isolated.environmentKeys).not.toContain("LING_BENCHMARK_SECRET");

		await store.add({
			name: "allowed-env",
			envAllowlist: ["LING_BENCHMARK_CANARY"],
			...nodeScript("console.log(process.env.LING_BENCHMARK_CANARY ?? 'missing')"),
		});
		const allowed = await store.run("allowed-env");
		expect(allowed.stdout.trim()).toBe("visible-canary-value");
		expect(allowed.environmentKeys).toContain("LING_BENCHMARK_CANARY");
		expect(allowed.environmentKeys).not.toContain("LING_BENCHMARK_SECRET");

		await store.add({
			name: "inherited-env",
			environmentMode: "inherit",
			...nodeScript("console.log(process.env.LING_BENCHMARK_SECRET ?? 'missing')"),
		});
		expect((await store.run("inherited-env")).stdout.trim()).toBe("secret-canary-value");
	});

	it("exports the run id and arm to the child, even in isolated mode, and stores them on the record", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		process.env.LING_BENCHMARK_SECRET = "secret-canary-value";
		const print = `console.log(JSON.stringify([process.env.${ENV_BENCHMARK_RUN_ID}, process.env.${ENV_BENCHMARK_ARM}, process.env.${ENV_SUBAGENT_ROLE.scout}, process.env.LING_BENCHMARK_SECRET ?? null]))`;
		await store.add({ name: "linked", ...nodeScript(print) });
		const first = await store.run("linked", {
			armId: "bling:test:abcd1234",
			childEnv: { [ENV_SUBAGENT_ROLE.scout]: "scout-a" },
		});
		const [runId, arm, scout, secret] = JSON.parse(first.stdout.trim());
		expect(first.runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(runId).toBe(first.runId);
		expect(arm).toBe("bling:test:abcd1234");
		expect(first.armId).toBe("bling:test:abcd1234");
		expect(scout).toBe("scout-a");
		expect(secret).toBeNull();
		expect(first.environmentKeys).toContain(ENV_BENCHMARK_RUN_ID);
		expect(first.environmentKeys).not.toContain("LING_BENCHMARK_SECRET");

		const second = await store.run("linked");
		expect(second.runId).not.toBe(first.runId);
		expect(JSON.parse(second.stdout.trim())[1]).toBeNull();
		expect("armId" in second).toBe(false);
	});

	it("injects the run id in inherit mode and for validation controls", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		const print = `console.log(process.env.${ENV_BENCHMARK_RUN_ID})`;
		await store.add({ name: "inherit-linked", environmentMode: "inherit", ...nodeScript(print) });
		const inherited = await store.run("inherit-linked");
		expect(inherited.stdout.trim()).toBe(inherited.runId);

		await store.add({
			name: "controls-linked",
			...nodeScript(""),
			oracle: { outputIncludes: ["run-"] },
			validation: {
				positive: nodeScript(`console.log('run-' + process.env.${ENV_BENCHMARK_RUN_ID})`),
				negative: nodeScript(""),
			},
		});
		const validated = await store.validate("controls-linked", { armId: "bling:test:abcd1234" });
		expect(validated.positive.stdout.trim()).toBe(`run-${validated.positive.runId}`);
		expect(validated.positive.runId).not.toBe(validated.negative.runId);
		expect(validated.negative.armId).toBe("bling:test:abcd1234");
	});

	it("serializes concurrent definition additions and removals", async () => {
		const project = makeProject();
		const stores = await Promise.all(Array.from({ length: 12 }, () => ProjectBenchmarkStore.open(project)));
		await Promise.all(stores.map((store, index) => store.add({ name: `concurrent-${index}`, ...nodeScript("") })));
		expect((await ProjectBenchmarkStore.open(project)).list()).toHaveLength(12);
		await Promise.all(stores.map((store, index) => store.remove(`concurrent-${index}`)));
		expect((await ProjectBenchmarkStore.open(project)).list()).toEqual([]);
	});

	it("fails and records a run when its definition file changes during execution", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		const definitionsPath = join(project, ".bling", "benchmarks.json");
		await store.add({
			name: "tampered",
			...nodeScript(`require('fs').writeFileSync(${JSON.stringify(definitionsPath)}, '{}')`),
		});
		const result = await store.run("tampered");
		expect(result.passed).toBe(false);
		expect(result.integrityPassed).toBe(false);
		expect(result.definitionFileHashBefore).toMatch(/^[0-9a-f]{64}$/);
		expect(result.definitionFileHashAfter).not.toBe(result.definitionFileHashBefore);
		expect(result.checks).toContainEqual({
			name: "definitionUnchanged",
			expected: result.definitionFileHashBefore,
			passed: false,
		});
		expect(await ProjectActionStore.open(project).list()).toEqual([result]);
	});

	it("accepts a discriminating oracle and rejects a vacuous one", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		await store.add({
			name: "validated",
			...nodeScript("console.log('pass')"),
			oracle: { outputIncludes: ["pass"] },
			validation: {
				positive: nodeScript("console.log('pass')"),
				negative: nodeScript("console.log('no-op')"),
			},
		});
		const valid = await store.validate("validated");
		expect(valid.passed).toBe(true);
		expect(valid.positive.purpose).toBe("positive-control");
		expect(valid.negative.purpose).toBe("negative-control");

		await store.add({
			name: "vacuous",
			...nodeScript(""),
			validation: {
				positive: nodeScript(""),
				negative: nodeScript(""),
			},
		});
		expect((await store.validate("vacuous")).passed).toBe(false);
		const actions = await ProjectActionStore.open(project).list();
		expect(actions.filter((action) => action.kind === "benchmark")).toHaveLength(4);
	});

	it("bounds and redacts captured output", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		const fakeToken = "ghp_0123456789abcdef0123456789abcdef0123";
		await store.add({
			name: "bounded",
			...nodeScript(`console.log('${fakeToken}'); console.log('x'.repeat(${BENCHMARK_OUTPUT_LIMIT_CHARS + 1000}))`),
		});
		const result = await store.run("bounded");
		expect(result.stdout).toContain(REDACTED);
		expect(result.stdout).not.toContain(fakeToken);
		expect(result.stdout).toContain("[output truncated]");
		expect(result.stdout.length).toBeLessThan(BENCHMARK_OUTPUT_LIMIT_CHARS + 100);
	});
});

interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number | undefined;
}

async function runCli(args: string[], cwd: string, agentDir: string = makeProject()): Promise<CliResult> {
	const logs: string[] = [];
	const errors: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(" ")));
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => errors.push(parts.map(String).join(" ")));
	const previous = process.exitCode;
	process.exitCode = undefined;
	try {
		expect(await runLingBenchmarkCommand(args, { cwd, agentDir })).toBe(true);
		return { stdout: logs.join("\n"), stderr: errors.join("\n"), exitCode: process.exitCode };
	} finally {
		process.exitCode = previous;
		vi.restoreAllMocks();
	}
}

describe("bling benchmark", () => {
	it("adds, lists, runs, inspects, and removes a project oracle without a model", async () => {
		const project = makeProject();
		const added = await runCli(
			[
				"benchmark",
				"add",
				"cli-oracle",
				"--stdout-contains",
				"pass",
				"--",
				process.execPath,
				"-e",
				"console.log('pass')",
			],
			project,
		);
		expect(added.exitCode).toBeUndefined();
		expect(added.stdout).toMatch(/^Added cli-oracle \(bench_/);

		const listed = await runCli(["benchmark", "list"], project);
		expect(listed.stdout).toContain("cli-oracle");
		expect(listed.stdout).toContain(process.execPath);

		const ran = await runCli(["benchmark", "run", "cli-oracle"], project);
		expect(ran.exitCode).toBeUndefined();
		expect(ran.stdout).toMatch(/^PASS cli-oracle run_/);
		const runs = await runCli(["benchmark", "runs", "cli-oracle"], project);
		expect(runs.stdout).toContain("PASS\tcli-oracle");

		const removed = await runCli(["benchmark", "remove", "cli-oracle"], project);
		expect(removed.stdout).toBe("Removed cli-oracle");
		expect((await ProjectBenchmarkStore.open(project)).list()).toEqual([]);
	});

	it("records the harness profile from --harness and lists it in runs", async () => {
		const project = makeProject();
		await runCli(
			["benchmark", "add", "arm", "--expect-exit", "0", "--", process.execPath, "-e", "process.exit(0)"],
			project,
		);
		const stock = await runCli(["benchmark", "run", "arm", "--harness", "stock"], project);
		expect(stock.exitCode).toBeUndefined();
		expect(stock.stdout).toMatch(/^PASS arm run_/);
		const plain = await runCli(["benchmark", "run", "arm"], project);
		expect(plain.exitCode).toBeUndefined();
		const actions = (await ProjectActionStore.open(project).list()) as LearningBenchmarkAction[];
		expect(actions.map((action) => action.harnessProfile)).toEqual(["stock", "bling"]);
		const runs = await runCli(["benchmark", "runs", "arm"], project);
		expect(runs.stdout).toContain("\tstock");
		expect(runs.stdout).toContain("\tbling");
	});

	it("rejects an invalid --harness value", async () => {
		const project = makeProject();
		await runCli(["benchmark", "add", "arm", "--", process.execPath, "-e", "0"], project);
		const result = await runCli(["benchmark", "run", "arm", "--harness", "bogus"], project);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("--harness requires bling, bling-noverify, bling-lean, stock");
		expect(await ProjectActionStore.open(project).list()).toHaveLength(0);
	});

	it("store.run stamps the profile, leaving unprofiled records unchanged", async () => {
		const project = makeProject();
		const store = await ProjectBenchmarkStore.open(project);
		await store.add({ name: "ctl", ...nodeScript("process.exit(0)"), oracle: { exitCode: 0 } });
		const bare = await store.run("ctl");
		const stock = await store.run("ctl", { harnessProfile: "stock" });
		expect("harnessProfile" in bare).toBe(false);
		expect(stock.harnessProfile).toBe("stock");
		expect(stock.actionId).not.toBe(bare.actionId);
	});

	it("returns a failing status for a failed oracle while retaining its run", async () => {
		const project = makeProject();
		await runCli(
			["benchmark", "add", "fails", "--expect-exit", "0", "--", process.execPath, "-e", "process.exit(2)"],
			project,
		);
		const result = await runCli(["benchmark", "run", "fails"], project);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("FAIL fails run_");
		expect(result.stdout).toContain("Failed exitCode: 0");
		const actions = await ProjectActionStore.open(project).list();
		expect(actions).toHaveLength(1);
		expect((actions[0] as LearningBenchmarkAction).passed).toBe(false);
	});

	it("supports explicit environment options and validation from the CLI", async () => {
		const project = makeProject();
		process.env.LING_BENCHMARK_CANARY = "cli-visible";
		await runCli(
			[
				"benchmark",
				"add",
				"cli-env",
				"--allow-env",
				"LING_BENCHMARK_CANARY",
				"--stdout-contains",
				"cli-visible",
				"--",
				process.execPath,
				"-e",
				"console.log(process.env.LING_BENCHMARK_CANARY)",
			],
			project,
		);
		expect((await runCli(["benchmark", "run", "cli-env"], project)).stdout).toMatch(/^PASS/);
		const conflict = await runCli(
			["benchmark", "add", "bad-env", "--allow-env", "HOME", "--inherit-env", "--", process.execPath, "-e", ""],
			project,
		);
		expect(conflict.exitCode).toBe(1);
		expect(conflict.stderr).toContain("cannot be combined");

		const store = await ProjectBenchmarkStore.open(project);
		await store.add({
			name: "cli-validation",
			...nodeScript(""),
			oracle: { outputIncludes: ["required"] },
			validation: {
				positive: nodeScript("console.log('required')"),
				negative: nodeScript(""),
			},
		});
		const validated = await runCli(["benchmark", "validate", "cli-validation"], project);
		expect(validated.exitCode).toBeUndefined();
		expect(validated.stdout).toMatch(/^VALID cli-validation/);
	});

	describe("arms", () => {
		const arms = {
			subagents: {
				active: { scout: "scout-a", coder: "coder-a" },
				roles: {
					"scout-a": {
						kind: "scout",
						provider: "openrouter",
						model: "inception/mercury-3",
						upstream: "inception",
					},
					"scout-b": {
						kind: "scout",
						provider: "openrouter",
						model: "inception/mercury-2.5",
						upstream: "inception",
					},
					"coder-a": { kind: "coder", provider: "openrouter", model: "qwen/qwen3.8-27b", upstream: "novita" },
				},
			},
		};

		async function armFor(project: string, agentDir: string, extra: string[]): Promise<string | undefined> {
			const before = (await ProjectActionStore.open(project).list()).length;
			const result = await runCli(["benchmark", "run", "arm", ...extra], project, agentDir);
			expect(result.exitCode).toBeUndefined();
			const actions = await ProjectActionStore.open(project).list();
			return (actions[before] as LearningBenchmarkAction).armId;
		}

		it("--scout and --coder change the arm id and are exported to the child", async () => {
			const project = makeProject();
			const agentDir = makeProject();
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(arms));
			const print = `console.log(process.env.${ENV_SUBAGENT_ROLE.scout} + ',' + process.env.${ENV_SUBAGENT_ROLE.coder})`;
			await runCli(["benchmark", "add", "arm", "--", process.execPath, "-e", print], project, agentDir);
			const settingsArm = await armFor(project, agentDir, []);
			const scoutB = await armFor(project, agentDir, ["--scout", "scout-b"]);
			const scoutNone = await armFor(project, agentDir, ["--scout", "none"]);
			const bothNone = await armFor(project, agentDir, ["--scout", "none", "--coder", "none"]);
			const harnessStock = await armFor(project, agentDir, ["--harness", "stock"]);
			const ids = [settingsArm, scoutB, scoutNone, bothNone, harnessStock];
			expect(new Set(ids).size).toBe(5);
			expect(bothNone).toMatch(/^bling:unlabeled:none$/);
			expect(harnessStock).toMatch(/^stock:/);
			// Unflagged runs export no overrides in isolated mode; flagged runs export exactly what was passed.
			const actions = (await ProjectActionStore.open(project).list()) as LearningBenchmarkAction[];
			expect(actions.map((action) => action.stdout.trim())).toEqual([
				"undefined,undefined",
				"scout-b,undefined",
				"none,undefined",
				"none,none",
				"undefined,undefined",
			]);
		});

		it("--delegation changes the arm id, is exported to the child, and rejects unknown modes", async () => {
			const project = makeProject();
			const agentDir = makeProject();
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(arms));
			await runCli(
				[
					"benchmark",
					"add",
					"arm",
					"--",
					process.execPath,
					"-e",
					`console.log(process.env.${ENV_SUBAGENT_DELEGATION})`,
				],
				project,
				agentDir,
			);
			const ids = [
				await armFor(project, agentDir, []),
				await armFor(project, agentDir, ["--delegation", "auto"]),
				await armFor(project, agentDir, ["--delegation", "required"]),
			];
			expect(new Set(ids).size).toBe(3);
			// The default mode is prefer, so an explicit prefer is the same arm as an unflagged run.
			expect(await armFor(project, agentDir, ["--delegation", "prefer"])).toBe(ids[0]);
			const actions = (await ProjectActionStore.open(project).list()) as LearningBenchmarkAction[];
			expect(actions.map((action) => action.stdout.trim())).toEqual(["undefined", "auto", "required", "prefer"]);
			const bogus = await runCli(["benchmark", "run", "arm", "--delegation", "always"], project, agentDir);
			expect(bogus.exitCode).toBe(1);
			expect(bogus.stderr).toContain("--delegation requires prefer, auto, required");
		});

		it("rejects an unknown role name and a missing value", async () => {
			const project = makeProject();
			const agentDir = makeProject();
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(arms));
			await runCli(["benchmark", "add", "arm", "--", process.execPath, "-e", "0"], project, agentDir);
			const unknown = await runCli(["benchmark", "run", "arm", "--coder", "missing"], project, agentDir);
			expect(unknown.exitCode).toBe(1);
			expect(unknown.stderr).toContain("--coder missing: no such role");
			const missing = await runCli(["benchmark", "run", "arm", "--scout"], project, agentDir);
			expect(missing.exitCode).toBe(1);
			expect(missing.stderr).toContain("--scout requires a role name");
			expect(await ProjectActionStore.open(project).list()).toHaveLength(0);
		});

		it("lists the arm id in runs", async () => {
			const project = makeProject();
			const agentDir = makeProject();
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(arms));
			await runCli(["benchmark", "add", "arm", "--", process.execPath, "-e", "0"], project, agentDir);
			const arm = await armFor(project, agentDir, ["--scout", "scout-b"]);
			const runs = await runCli(["benchmark", "runs", "arm"], project, agentDir);
			expect(runs.stdout).toContain(`\t${arm}`);
		});
	});

	describe("report", () => {
		const ACTION_STORE_URL = pathToFileURL(join(import.meta.dirname, "../src/core/learning/action-store.ts")).href;

		/** A benchmark whose child process writes primary and subagent ledger records tagged with the injected run id. */
		async function addAccountingBenchmark(
			project: string,
			agentDir: string,
			cost: { primary: number; scout: number },
		) {
			const script = join(project, "child.mjs");
			writeFileSync(
				script,
				`const { createMessageAction, createSubagentAction, ProjectActionStore } = await import(${JSON.stringify(ACTION_STORE_URL)});
const cwd = process.cwd();
const runId = process.env.${ENV_BENCHMARK_RUN_ID};
const store = ProjectActionStore.open(cwd);
const usage = (total) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
await store.append(createMessageAction(cwd, 'child-' + runId, { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-completions', provider: 'openrouter', model: 'ling', usage: usage(${cost.primary}), stopReason: 'stop', timestamp: Date.now() }, 'bling', runId));
await store.append(createSubagentAction(cwd, { runId: 'sub-' + runId, role: 'scout', roleName: 'scout-a', roleIdentityHash: '0123456789ab', provider: 'openrouter', model: 'inception/mercury-3', requestedUpstream: 'inception', servedUpstreams: ['Inception'], outcome: 'completed', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: ${cost.scout} }, turns: 2, startedAt: Date.now(), durationMs: 5, scopeViolations: 0, parentSessionId: 'child-' + runId, parentToolCallId: 'call-1', benchmarkRunId: runId }));
await store.flush();
`,
			);
			await runCli(["benchmark", "add", "accounted", "--", process.execPath, script], project, agentDir);
		}

		it("shows the combined cost of a run whose child wrote linked records (end to end)", async () => {
			const project = makeProject();
			const agentDir = makeProject();
			await addAccountingBenchmark(project, agentDir, { primary: 0.1, scout: 0.02 });
			const ran = await runCli(["benchmark", "run", "accounted"], project, agentDir);
			expect(ran.exitCode).toBeUndefined();
			expect(ran.stdout).toMatch(/^PASS accounted/);

			const json = await runCli(["benchmark", "report", "accounted", "--json"], project, agentDir);
			expect(json.exitCode).toBeUndefined();
			const report = JSON.parse(json.stdout);
			expect(report.arms).toHaveLength(1);
			const [arm] = report.arms;
			expect(arm.armId).toBe("bling:unlabeled:none");
			expect(arm.runs).toBe(1);
			expect(arm.passed).toBe(1);
			expect(arm.totalCost).toBeCloseTo(0.12, 10);
			expect(arm.costOfPass).toBeCloseTo(0.12, 10);
			expect(arm.costByRole.primary.cost).toBeCloseTo(0.1, 10);
			expect(arm.costByRole.scout.cost).toBeCloseTo(0.02, 10);
			expect(arm.upstreamMismatches).toBe(0);
			expect(arm.runsWithoutPrimaryAccounting).toBe(0);
			// The CLI prints exactly the object the library builds.
			expect(report).toEqual(
				JSON.parse(JSON.stringify(buildBenchmarkReport(await ProjectActionStore.open(project).list()))),
			);
		});

		it("prints a text block per arm and filters by benchmark", async () => {
			const project = makeProject();
			const agentDir = makeProject();
			await addAccountingBenchmark(project, agentDir, { primary: 0.1, scout: 0.02 });
			await runCli(["benchmark", "add", "plain", "--", process.execPath, "-e", "0"], project, agentDir);
			await runCli(["benchmark", "run", "accounted"], project, agentDir);
			await runCli(["benchmark", "run", "plain"], project, agentDir);

			const all = await runCli(["benchmark", "report"], project, agentDir);
			expect(all.stdout).toContain("bling:unlabeled:none");
			expect(all.stdout).toContain("runs 2, passed 2");
			const one = await runCli(["benchmark", "report", "accounted"], project, agentDir);
			expect(one.stdout).toContain("runs 1, passed 1");
			expect(one.stdout).toContain("cost-of-pass $0.120000");
			expect(one.stdout).toContain("primary: 1 calls");
			expect(one.stdout).toContain("scout: 1 calls");
			expect(one.stdout).toContain("wall-clock p50");
			expect(one.stdout).toContain("runs without primary accounting 0");
			const plain = await runCli(["benchmark", "report", "plain"], project, agentDir);
			expect(plain.stdout).toContain("runs without primary accounting 1");
			expect(plain.stdout).toContain("no linked accounting");
		});

		it("reports nothing for a project without runs and rejects unknown options", async () => {
			const project = makeProject();
			const empty = await runCli(["benchmark", "report"], project);
			expect(empty.stdout).toBe("No matching benchmark runs.");
			const bad = await runCli(["benchmark", "report", "--bogus"], project);
			expect(bad.exitCode).toBe(1);
			expect(bad.stderr).toContain("Unknown benchmark report option: --bogus");
		});
	});

	it("prints help without creating project state", async () => {
		const project = makeProject();
		const result = await runCli(["benchmark", "--help"], project);
		expect(result.stdout).toContain("Project-specific executable benchmarks");
		expect(existsSync(join(project, ".bling"))).toBe(false);
	});
});
