import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLingBenchmarkCommand } from "../src/cli/ling-benchmark.ts";
import {
	getLearningPaths,
	type LearningBenchmarkAction,
	ProjectActionStore,
	REDACTED,
} from "../src/core/learning/action-store.ts";
import { BENCHMARK_OUTPUT_LIMIT_CHARS, ProjectBenchmarkStore } from "../src/core/learning/benchmarks.ts";

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
		expect(existsSync(join(project, ".ling", "benchmarks.json"))).toBe(true);
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
		expect(getLearningPaths(project).actions).toBe(join(project, ".ling", "learning", "actions.jsonl"));
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
		const definitionsPath = join(project, ".ling", "benchmarks.json");
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

async function runCli(args: string[], cwd: string): Promise<CliResult> {
	const logs: string[] = [];
	const errors: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(" ")));
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => errors.push(parts.map(String).join(" ")));
	const previous = process.exitCode;
	process.exitCode = undefined;
	try {
		expect(await runLingBenchmarkCommand(args, { cwd })).toBe(true);
		return { stdout: logs.join("\n"), stderr: errors.join("\n"), exitCode: process.exitCode };
	} finally {
		process.exitCode = previous;
		vi.restoreAllMocks();
	}
}

describe("ling benchmark", () => {
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

	it("prints help without creating project state", async () => {
		const project = makeProject();
		const result = await runCli(["benchmark", "--help"], project);
		expect(result.stdout).toContain("Project-specific executable benchmarks");
		expect(existsSync(join(project, ".ling"))).toBe(false);
	});
});
