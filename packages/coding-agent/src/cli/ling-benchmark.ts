import { ProjectActionStore } from "../core/learning/action-store.ts";
import {
	DEFAULT_BENCHMARK_TIMEOUT_MS,
	type ProjectBenchmarkDefinition,
	ProjectBenchmarkStore,
} from "../core/learning/benchmarks.ts";
import { type HarnessProfile, SettingsManager } from "../core/settings-manager.ts";

export function printLingBenchmarkHelp(): void {
	console.log(`Project-specific executable benchmarks

Usage:
  bling benchmark list
  bling benchmark add <name> [--timeout <ms>] [--expect-exit <code>]
                  [--stdout-contains <text>] [--output-excludes <text>]
                  [--allow-env <name>] [--inherit-env] -- <command> [args...]
  bling benchmark run <name|id> [--harness <bling|stock>]
  bling benchmark validate <name|id> [--harness <bling|stock>]
  bling benchmark runs [name|id]
  bling benchmark remove <name|id>

Definitions live in versionable .bling/benchmarks.json. Runs execute directly without
a shell and are appended to .bling/learning/actions.jsonl with deterministic bench_
and run_ IDs. Child environments are allowlisted by default; --allow-env adds a
named variable and --inherit-env explicitly trusts the full caller environment.
Validation controls can be defined in benchmarks.json. A failed oracle or integrity
check is recorded and sets a failing command exit status. --harness labels the run with
the harness profile arm (default: harness.profile from settings).`);
}

function parseInteger(value: string | undefined, label: string): number {
	if (!value || !/^\d+$/.test(value)) throw new Error(`${label} requires a non-negative integer`);
	return Number(value);
}

function parseDefinition(args: string[]): ProjectBenchmarkDefinition {
	const [name, ...rest] = args;
	if (!name) throw new Error("bling benchmark add requires a name");
	const separator = rest.indexOf("--");
	if (separator < 0 || separator === rest.length - 1) {
		throw new Error("bling benchmark add requires -- followed by a command");
	}
	const optionArgs = rest.slice(0, separator);
	const [command, ...commandArgs] = rest.slice(separator + 1);
	let timeoutMs: number | undefined;
	let exitCode: number | undefined;
	const stdoutIncludes: string[] = [];
	const outputExcludes: string[] = [];
	const envAllowlist: string[] = [];
	let inheritEnv = false;
	for (let index = 0; index < optionArgs.length; index++) {
		const option = optionArgs[index];
		const value = optionArgs[index + 1];
		if (option === "--timeout") {
			timeoutMs = parseInteger(value, "--timeout");
			if (timeoutMs < 1) throw new Error("--timeout must be greater than zero");
			index++;
		} else if (option === "--expect-exit") {
			exitCode = parseInteger(value, "--expect-exit");
			index++;
		} else if (option === "--stdout-contains") {
			if (!value) throw new Error("--stdout-contains requires text");
			stdoutIncludes.push(value);
			index++;
		} else if (option === "--output-excludes") {
			if (!value) throw new Error("--output-excludes requires text");
			outputExcludes.push(value);
			index++;
		} else if (option === "--allow-env") {
			if (!value) throw new Error("--allow-env requires a variable name");
			envAllowlist.push(value);
			index++;
		} else if (option === "--inherit-env") {
			inheritEnv = true;
		} else {
			throw new Error(`Unknown benchmark add option: ${option}`);
		}
	}
	if (inheritEnv && envAllowlist.length > 0) {
		throw new Error("--allow-env cannot be combined with --inherit-env");
	}
	return {
		name,
		command,
		args: commandArgs,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(inheritEnv ? { environmentMode: "inherit" as const } : {}),
		...(envAllowlist.length ? { envAllowlist } : {}),
		oracle: {
			...(exitCode === undefined ? {} : { exitCode }),
			...(stdoutIncludes.length ? { stdoutIncludes } : {}),
			...(outputExcludes.length ? { outputExcludes } : {}),
		},
	};
}

function extractHarness(args: string[]): { rest: string[]; harness?: HarnessProfile } {
	const rest: string[] = [];
	let harness: HarnessProfile | undefined;
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "--harness") {
			rest.push(args[index]);
			continue;
		}
		const value = args[index + 1];
		if (value !== "bling" && value !== "stock") throw new Error("--harness requires bling or stock");
		harness = value;
		index++;
	}
	return { rest, harness };
}

function resolveProfile(context: { cwd: string; agentDir: string }): HarnessProfile {
	return SettingsManager.create(context.cwd, context.agentDir).getHarnessProfile();
}

export async function runLingBenchmarkCommand(
	args: string[],
	context: { cwd: string; agentDir: string },
): Promise<boolean> {
	if (args[0] !== "benchmark") return false;
	if (args.includes("--help") || args.includes("-h")) {
		printLingBenchmarkHelp();
		return true;
	}
	try {
		const [subcommand = "list", ...rest] = args.slice(1);
		const store = await ProjectBenchmarkStore.open(context.cwd);
		if (subcommand === "list") {
			const benchmarks = store.list();
			for (const benchmark of benchmarks) {
				console.log(
					`${benchmark.name}\t${benchmark.id}\t${benchmark.command} ${benchmark.args.join(" ")}\t${benchmark.timeoutMs}ms`,
				);
			}
			if (benchmarks.length === 0)
				console.log("No project benchmarks. Add one with: bling benchmark add <name> -- <command>");
			return true;
		}
		if (subcommand === "add") {
			const benchmark = await store.add(parseDefinition(rest));
			console.log(
				`Added ${benchmark.name} (${benchmark.id}); timeout ${benchmark.timeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS}ms.`,
			);
			return true;
		}
		if (subcommand === "remove") {
			if (!rest[0]) throw new Error("bling benchmark remove requires a name or ID");
			console.log(`Removed ${(await store.remove(rest[0])).name}`);
			return true;
		}
		if (subcommand === "run") {
			const { rest: positional, harness } = extractHarness(rest);
			if (!positional[0]) throw new Error("bling benchmark run requires a name or ID");
			const result = await store.run(positional[0], { harnessProfile: harness ?? resolveProfile(context) });
			console.log(
				`${result.passed ? "PASS" : "FAIL"} ${result.benchmarkName} ${result.actionId} exit=${result.exitCode ?? "none"} duration=${result.durationMs}ms`,
			);
			for (const check of result.checks.filter((entry) => !entry.passed)) {
				console.log(`Failed ${check.name}: ${JSON.stringify(check.expected)}`);
			}
			if (!result.passed) process.exitCode = 1;
			return true;
		}
		if (subcommand === "validate") {
			const { rest: positional, harness } = extractHarness(rest);
			if (!positional[0]) throw new Error("bling benchmark validate requires a name or ID");
			const result = await store.validate(positional[0], { harnessProfile: harness ?? resolveProfile(context) });
			console.log(
				`${result.passed ? "VALID" : "INVALID"} ${result.benchmark.name} positive=${result.positive.actionId} negative=${result.negative.actionId}`,
			);
			if (!result.positive.passed) console.log("Positive control did not satisfy the oracle.");
			if (result.negative.passed) console.log("Negative control unexpectedly satisfied the oracle.");
			if (!result.passed) process.exitCode = 1;
			return true;
		}
		if (subcommand === "runs") {
			const actions = await ProjectActionStore.open(context.cwd).list();
			let benchmarks = actions.filter((action) => action.kind === "benchmark");
			if (rest[0]) {
				const target = store.get(rest[0]);
				benchmarks = benchmarks.filter((action) => action.kind === "benchmark" && action.benchmarkId === target.id);
			}
			for (const action of benchmarks.slice(-20).reverse()) {
				if (action.kind === "benchmark") {
					console.log(
						`${action.actionId}\t${action.passed ? "PASS" : "FAIL"}\t${action.benchmarkName}\t${action.durationMs}ms\t${new Date(action.startedAt).toISOString()}\t${action.harnessProfile ?? "unrecorded"}`,
					);
				}
			}
			if (benchmarks.length === 0) console.log("No matching benchmark runs.");
			return true;
		}
		throw new Error(`Unknown benchmark subcommand: ${subcommand}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	return true;
}
