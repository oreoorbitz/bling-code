import { ProjectActionStore } from "../core/learning/action-store.ts";
import { type ArmReport, buildBenchmarkReport } from "../core/learning/benchmark-report.ts";
import {
	type BenchmarkRunOptions,
	DEFAULT_BENCHMARK_TIMEOUT_MS,
	type ProjectBenchmark,
	type ProjectBenchmarkDefinition,
	ProjectBenchmarkStore,
} from "../core/learning/benchmarks.ts";
import { type HarnessProfile, SettingsManager } from "../core/settings-manager.ts";
import {
	armIdFromSettings,
	ENV_SUBAGENT_ROLE,
	ROLE_DISABLED_VALUE,
	ROLE_KINDS,
	type RoleKind,
} from "../core/subagents/roles.ts";

export function printLingBenchmarkHelp(): void {
	console.log(`Project-specific executable benchmarks

Usage:
  bling benchmark list
  bling benchmark add <name> [--timeout <ms>] [--expect-exit <code>]
                  [--stdout-contains <text>] [--output-excludes <text>]
                  [--allow-env <name>] [--inherit-env] -- <command> [args...]
  bling benchmark run <name|id> [--harness <bling|stock>] [--scout <role|none>] [--coder <role|none>]
  bling benchmark validate <name|id> [--harness <bling|stock>] [--scout <role|none>] [--coder <role|none>]
  bling benchmark runs [name|id]
  bling benchmark report [name|id] [--json]
  bling benchmark remove <name|id>

Definitions live in versionable .bling/benchmarks.json. Runs execute directly without
a shell and are appended to .bling/learning/actions.jsonl with deterministic bench_
and run_ IDs. Child environments are allowlisted by default; --allow-env adds a
named variable and --inherit-env explicitly trusts the full caller environment.
Validation controls can be defined in benchmarks.json. A failed oracle or integrity
check is recorded and sets a failing command exit status. --harness labels the run with
the harness profile arm (default: harness.profile from settings). --scout and --coder
select the subagent role for that run (a name from subagents.roles, or none to disable
the kind) and are part of the arm identity. Each run gets a run ID and arm ID, exported to
the child as BLING_BENCHMARK_RUN_ID and BLING_BENCHMARK_ARM even in isolated mode, so
sessions started inside the run tag their ledger records. report groups runs by arm and
prints cost-of-pass (total cost across roles / passed runs) and p50/p95 wall-clock.`);
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

interface RunFlags {
	rest: string[];
	harness?: HarnessProfile;
	roles: Partial<Record<RoleKind, string>>;
}

function extractRunFlags(args: string[]): RunFlags {
	const rest: string[] = [];
	const roles: Partial<Record<RoleKind, string>> = {};
	let harness: HarnessProfile | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--harness") {
			const value = args[index + 1];
			if (value !== "bling" && value !== "stock") throw new Error("--harness requires bling or stock");
			harness = value;
			index++;
		} else if (arg === "--scout" || arg === "--coder") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a role name or ${ROLE_DISABLED_VALUE}`);
			roles[arg === "--scout" ? "scout" : "coder"] = value;
			index++;
		} else {
			rest.push(arg);
		}
	}
	return { rest, harness, roles };
}

/**
 * Run options for one benchmark invocation: harness profile, arm ID and the harness-injected role overrides.
 * The arm is computed from the environment the child will actually see: only the overrides in isolated mode,
 * the caller environment plus overrides in inherit mode.
 */
function resolveRunOptions(
	flags: RunFlags,
	benchmark: ProjectBenchmark,
	context: { cwd: string; agentDir: string },
): BenchmarkRunOptions {
	const settingsManager = SettingsManager.create(context.cwd, context.agentDir);
	const harnessProfile = flags.harness ?? settingsManager.getHarnessProfile();
	const subagents = settingsManager.getSettings().subagents;
	const childEnv: Record<string, string> = {};
	for (const kind of ROLE_KINDS) {
		const name = flags.roles[kind];
		if (name === undefined) continue;
		if (name !== ROLE_DISABLED_VALUE && !subagents?.roles?.[name]) {
			throw new Error(`--${kind} ${name}: no such role in subagents.roles`);
		}
		childEnv[ENV_SUBAGENT_ROLE[kind]] = name;
	}
	const armEnv = benchmark.environmentMode === "inherit" ? { ...process.env, ...childEnv } : childEnv;
	return { harnessProfile, armId: armIdFromSettings(harnessProfile, subagents, armEnv), childEnv };
}

function formatCost(value: number): string {
	return `$${value.toFixed(6)}`;
}

function formatArm(arm: ArmReport): string {
	const lines = [
		`${arm.armId}`,
		`  runs ${arm.runs}, passed ${arm.passed}, total cost ${formatCost(arm.totalCost)}, cost-of-pass ${arm.costOfPass === null ? "n/a (no passes)" : formatCost(arm.costOfPass)}`,
	];
	const roles = Object.entries(arm.costByRole);
	for (const [role, usage] of roles) {
		lines.push(
			`  ${role}: ${usage.calls} calls, ${formatCost(usage.cost)}, in ${usage.input} out ${usage.output}${usage.reasoning === undefined ? "" : ` (reasoning ${usage.reasoning})`} cacheRead ${usage.cacheRead} cacheWrite ${usage.cacheWrite}`,
		);
	}
	if (roles.length === 0) lines.push("  no linked accounting");
	if (arm.wallClockMs) lines.push(`  wall-clock p50 ${arm.wallClockMs.p50}ms p95 ${arm.wallClockMs.p95}ms`);
	if (arm.passingWallClockMs) {
		lines.push(`  wall-clock (passing) p50 ${arm.passingWallClockMs.p50}ms p95 ${arm.passingWallClockMs.p95}ms`);
	}
	const outcomes = Object.entries(arm.subagentOutcomes);
	if (outcomes.length) lines.push(`  subagent outcomes: ${outcomes.map(([name, n]) => `${name}=${n}`).join(" ")}`);
	for (const [role, stats] of Object.entries(arm.subagentStats)) {
		const rate = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
		const ttft = stats.timeToFirstToolCallMs;
		lines.push(
			`  ${role} behavior: ${stats.runs} runs, acceptance ${rate(stats.acceptanceRate)} (accepted ${stats.accepted}, rejected ${stats.rejected}, unjudged ${stats.unjudged}), escalation ${rate(stats.escalationRate)} (${stats.escalations}), diff too large ${stats.diffTooLarge}, failed tool calls ${stats.failedToolCalls}, scope violations ${stats.scopeViolations}, first tool call ${ttft ? `p50 ${ttft.p50}ms p95 ${ttft.p95}ms` : "n/a"}`,
		);
	}
	for (const [role, hosts] of Object.entries(arm.servedUpstreams)) {
		lines.push(
			`  served upstreams ${role}: ${Object.entries(hosts)
				.map(([host, n]) => `${host}=${n}`)
				.join(" ")}`,
		);
	}
	lines.push(`  upstream mismatches ${arm.upstreamMismatches}`);
	if (arm.zeroCostRoles.length > 0) {
		lines.push(
			`  WARNING zero cost with nonzero tokens (pricing missing? cost figures unreliable): ${arm.zeroCostRoles.join(", ")}`,
		);
	}
	lines.push(`  runs without primary accounting ${arm.runsWithoutPrimaryAccounting}`);
	return lines.join("\n");
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
			const flags = extractRunFlags(rest);
			const positional = flags.rest;
			if (!positional[0]) throw new Error("bling benchmark run requires a name or ID");
			const result = await store.run(positional[0], resolveRunOptions(flags, store.get(positional[0]), context));
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
			const flags = extractRunFlags(rest);
			const positional = flags.rest;
			if (!positional[0]) throw new Error("bling benchmark validate requires a name or ID");
			const result = await store.validate(
				positional[0],
				resolveRunOptions(flags, store.get(positional[0]), context),
			);
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
						`${action.actionId}\t${action.passed ? "PASS" : "FAIL"}\t${action.benchmarkName}\t${action.durationMs}ms\t${new Date(action.startedAt).toISOString()}\t${action.harnessProfile ?? "unrecorded"}\t${action.armId ?? "unrecorded"}`,
					);
				}
			}
			if (benchmarks.length === 0) console.log("No matching benchmark runs.");
			return true;
		}
		if (subcommand === "report") {
			const json = rest.includes("--json");
			const positional = rest.filter((arg) => arg !== "--json");
			const unknown = positional.find((arg) => arg.startsWith("--"));
			if (unknown) throw new Error(`Unknown benchmark report option: ${unknown}`);
			const target = positional[0] ? store.get(positional[0]) : undefined;
			const report = buildBenchmarkReport(
				await ProjectActionStore.open(context.cwd).list(),
				target ? { benchmarkId: target.id } : {},
			);
			if (json) console.log(JSON.stringify(report, null, 2));
			else if (report.arms.length === 0) console.log("No matching benchmark runs.");
			else console.log(report.arms.map(formatArm).join("\n\n"));
			return true;
		}
		throw new Error(`Unknown benchmark subcommand: ${subcommand}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	return true;
}
