import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { COMMAND_OUTPUT_LIMIT_CHARS, isolatedEnvironment, runCommand } from "../command-runner.ts";
import type { HarnessProfile } from "../settings-manager.ts";
import { ENV_BENCHMARK_ARM, ENV_BENCHMARK_RUN_ID } from "../subagents/roles.ts";
import {
	canonicalJson,
	createBenchmarkAction,
	deterministicId,
	type LearningBenchmarkAction,
	ProjectActionStore,
} from "./action-store.ts";
import { withFileLock } from "./file-lock.ts";

export const DEFAULT_BENCHMARK_TIMEOUT_MS = 120_000;
export const BENCHMARK_OUTPUT_LIMIT_CHARS = COMMAND_OUTPUT_LIMIT_CHARS;

export interface BenchmarkOracle {
	exitCode?: number;
	stdoutIncludes?: string[];
	stderrIncludes?: string[];
	outputIncludes?: string[];
	outputExcludes?: string[];
}

export type BenchmarkEnvironmentMode = "isolated" | "inherit";

export interface BenchmarkControl {
	command: string;
	args?: string[];
}

export interface BenchmarkValidation {
	positive: BenchmarkControl;
	negative: BenchmarkControl;
}

export interface ProjectBenchmarkDefinition {
	name: string;
	description?: string;
	command: string;
	args?: string[];
	cwd?: string;
	timeoutMs?: number;
	environmentMode?: BenchmarkEnvironmentMode;
	envAllowlist?: string[];
	validation?: BenchmarkValidation;
	oracle?: BenchmarkOracle;
}

export interface ProjectBenchmark extends ProjectBenchmarkDefinition {
	id: string;
	definitionHash: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	environmentMode: BenchmarkEnvironmentMode;
	envAllowlist: string[];
	oracle: BenchmarkOracle;
}

interface BenchmarkFile {
	version: 1;
	benchmarks: ProjectBenchmarkDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be an array of strings`);
	}
	return value;
}

function validateControl(value: unknown, label: string): BenchmarkControl {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	if (typeof value.command !== "string" || !value.command.trim()) {
		throw new Error(`${label}.command must be nonempty`);
	}
	return {
		command: value.command.trim(),
		args: optionalStringArray(value.args, `${label}.args`),
	};
}

function validateDefinition(value: unknown): ProjectBenchmarkDefinition {
	if (!isRecord(value)) throw new Error("Each project benchmark must be an object");
	const name = value.name;
	if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
		throw new Error("Benchmark name must be a lowercase hyphenated name of at most 64 characters");
	}
	if (typeof value.command !== "string" || !value.command.trim())
		throw new Error("Benchmark command must be nonempty");
	if (value.description !== undefined && typeof value.description !== "string") {
		throw new Error("Benchmark description must be a string");
	}
	if (value.cwd !== undefined && (typeof value.cwd !== "string" || isAbsolute(value.cwd))) {
		throw new Error("Benchmark cwd must be a project-relative path");
	}
	if (
		value.timeoutMs !== undefined &&
		(typeof value.timeoutMs !== "number" ||
			!Number.isInteger(value.timeoutMs) ||
			value.timeoutMs < 1 ||
			value.timeoutMs > 600_000)
	) {
		throw new Error("Benchmark timeoutMs must be an integer between 1 and 600000");
	}
	if (
		value.environmentMode !== undefined &&
		value.environmentMode !== "isolated" &&
		value.environmentMode !== "inherit"
	) {
		throw new Error("Benchmark environmentMode must be isolated or inherit");
	}
	const envAllowlist = optionalStringArray(value.envAllowlist, "Benchmark envAllowlist") ?? [];
	if (envAllowlist.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
		throw new Error("Benchmark envAllowlist entries must be valid environment variable names");
	}
	if (new Set(envAllowlist).size !== envAllowlist.length) {
		throw new Error("Benchmark envAllowlist entries must be unique");
	}
	let validation: BenchmarkValidation | undefined;
	if (value.validation !== undefined) {
		if (!isRecord(value.validation)) throw new Error("Benchmark validation must be an object");
		validation = {
			positive: validateControl(value.validation.positive, "Benchmark validation.positive"),
			negative: validateControl(value.validation.negative, "Benchmark validation.negative"),
		};
	}
	const oracle = value.oracle ?? {};
	if (!isRecord(oracle)) throw new Error("Benchmark oracle must be an object");
	if (oracle.exitCode !== undefined && (typeof oracle.exitCode !== "number" || !Number.isInteger(oracle.exitCode))) {
		throw new Error("Benchmark oracle.exitCode must be an integer");
	}
	const validated: ProjectBenchmarkDefinition = {
		name,
		command: value.command.trim(),
		...(value.description === undefined ? {} : { description: value.description }),
		args: optionalStringArray(value.args, "Benchmark args"),
		...(value.cwd === undefined ? {} : { cwd: value.cwd }),
		...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
		...(value.environmentMode === undefined ? {} : { environmentMode: value.environmentMode }),
		...(value.envAllowlist === undefined ? {} : { envAllowlist }),
		...(validation === undefined ? {} : { validation }),
		oracle: {
			...(oracle.exitCode === undefined ? {} : { exitCode: oracle.exitCode }),
			stdoutIncludes: optionalStringArray(oracle.stdoutIncludes, "oracle.stdoutIncludes"),
			stderrIncludes: optionalStringArray(oracle.stderrIncludes, "oracle.stderrIncludes"),
			outputIncludes: optionalStringArray(oracle.outputIncludes, "oracle.outputIncludes"),
			outputExcludes: optionalStringArray(oracle.outputExcludes, "oracle.outputExcludes"),
		},
	};
	return validated;
}

function materializeDefinition(definition: ProjectBenchmarkDefinition): ProjectBenchmark {
	const normalized = validateDefinition(definition);
	return {
		...normalized,
		id: deterministicId("bench", normalized),
		definitionHash: createHash("sha256").update(canonicalJson(normalized)).digest("hex"),
		args: normalized.args ?? [],
		cwd: normalized.cwd ?? ".",
		timeoutMs: normalized.timeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS,
		environmentMode: normalized.environmentMode ?? "isolated",
		envAllowlist: normalized.envAllowlist ?? [],
		oracle: normalized.oracle ?? {},
	};
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function resolveBenchmarkCwd(projectCwd: string, benchmark: ProjectBenchmark): string {
	const resolvedProject = resolve(projectCwd);
	const resolved = resolve(resolvedProject, benchmark.cwd);
	const rel = relative(resolvedProject, resolved);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Benchmark cwd must stay inside the project");
	}
	return resolved;
}

/** Harness-injected variables (run id, arm, role overrides). They are added after allowlisting and are not user-allowlisted. */
function benchmarkEnvironment(
	benchmark: ProjectBenchmark,
	injected: Record<string, string>,
): { env: NodeJS.ProcessEnv; keys: string[] } {
	const base =
		benchmark.environmentMode === "inherit" ? { ...process.env } : isolatedEnvironment(benchmark.envAllowlist).env;
	const env: NodeJS.ProcessEnv = { ...base, ...injected };
	return { env, keys: Object.keys(env).sort() };
}

export interface BenchmarkRunOptions {
	harnessProfile?: HarnessProfile;
	/** Arm identity stored on the record and exported to the child as BLING_BENCHMARK_ARM. */
	armId?: string;
	/** Extra harness-injected child variables, such as the BLING_SUBAGENT_* role overrides. */
	childEnv?: Record<string, string>;
}

async function definitionFileHash(projectCwd: string): Promise<string> {
	const content = await readFile(join(projectCwd, CONFIG_DIR_NAME, "benchmarks.json"), "utf8");
	return createHash("sha256").update(content).digest("hex");
}

async function executeBenchmark(
	projectCwd: string,
	benchmark: ProjectBenchmark,
	control?: { command: string; args: string[]; purpose: "positive-control" | "negative-control" },
	options: BenchmarkRunOptions = {},
): Promise<LearningBenchmarkAction> {
	const { harnessProfile, armId } = options;
	const runId = randomUUID();
	const startedAt = Date.now();
	const cwd = resolveBenchmarkCwd(projectCwd, benchmark);
	const definitionHashBefore = await definitionFileHash(projectCwd);
	const { env, keys: environmentKeys } = benchmarkEnvironment(benchmark, {
		...options.childEnv,
		[ENV_BENCHMARK_RUN_ID]: runId,
		...(armId === undefined ? {} : { [ENV_BENCHMARK_ARM]: armId }),
	});
	const { exitCode, stdout, stderr, timedOut, spawnError, durationMs } = await runCommand({
		command: control?.command ?? benchmark.command,
		args: control?.args ?? benchmark.args,
		cwd,
		env,
		timeoutMs: benchmark.timeoutMs,
		outputLimitChars: BENCHMARK_OUTPUT_LIMIT_CHARS,
	});
	let definitionHashAfter: string | undefined;
	let integrityPassed = true;
	try {
		definitionHashAfter = await definitionFileHash(projectCwd);
		integrityPassed = definitionHashAfter === definitionHashBefore;
	} catch {
		integrityPassed = false;
	}
	const checks = [
		{
			name: "exitCode",
			expected: benchmark.oracle.exitCode ?? 0,
			passed: exitCode === (benchmark.oracle.exitCode ?? 0),
		},
		...(benchmark.oracle.stdoutIncludes ?? []).map((expected) => ({
			name: "stdoutIncludes",
			expected,
			passed: stdout.includes(expected),
		})),
		...(benchmark.oracle.stderrIncludes ?? []).map((expected) => ({
			name: "stderrIncludes",
			expected,
			passed: stderr.includes(expected),
		})),
		...(benchmark.oracle.outputIncludes ?? []).map((expected) => ({
			name: "outputIncludes",
			expected,
			passed: `${stdout}\n${stderr}`.includes(expected),
		})),
		...(benchmark.oracle.outputExcludes ?? []).map((expected) => ({
			name: "outputExcludes",
			expected,
			passed: !`${stdout}\n${stderr}`.includes(expected),
		})),
	];
	checks.push({ name: "definitionUnchanged", expected: definitionHashBefore, passed: integrityPassed });
	if (timedOut) checks.push({ name: "timeout", expected: benchmark.timeoutMs, passed: false });
	if (spawnError) checks.push({ name: "spawn", expected: "successful process start", passed: false });
	return createBenchmarkAction(projectCwd, {
		benchmarkId: benchmark.id,
		benchmarkName: benchmark.name,
		definitionHash: benchmark.definitionHash,
		command: control?.command ?? benchmark.command,
		args: control?.args ?? benchmark.args,
		cwd,
		startedAt,
		durationMs,
		exitCode,
		timedOut,
		stdout,
		stderr,
		passed: checks.every((check) => check.passed),
		checks,
		purpose: control?.purpose ?? "benchmark",
		environmentMode: benchmark.environmentMode,
		environmentKeys,
		definitionFileHashBefore: definitionHashBefore,
		...(definitionHashAfter === undefined ? {} : { definitionFileHashAfter: definitionHashAfter }),
		integrityPassed,
		...(spawnError ? { error: spawnError } : {}),
		...(harnessProfile === undefined ? {} : { harnessProfile }),
		runId,
		...(armId === undefined ? {} : { armId }),
	});
}

async function readDefinitions(cwd: string): Promise<ProjectBenchmarkDefinition[]> {
	const path = join(resolve(cwd), CONFIG_DIR_NAME, "benchmarks.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Failed to read project benchmarks: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.benchmarks)) {
		throw new Error("benchmarks.json must contain version 1 and a benchmarks array");
	}
	const definitions = parsed.benchmarks.map(validateDefinition);
	const names = new Set<string>();
	for (const definition of definitions) {
		if (names.has(definition.name)) throw new Error(`Duplicate benchmark name: ${definition.name}`);
		names.add(definition.name);
	}
	return definitions;
}

export interface BenchmarkValidationResult {
	benchmark: ProjectBenchmark;
	passed: boolean;
	positive: LearningBenchmarkAction;
	negative: LearningBenchmarkAction;
}

export class ProjectBenchmarkStore {
	readonly cwd: string;
	readonly path: string;
	private definitions: ProjectBenchmarkDefinition[];

	private constructor(cwd: string, definitions: ProjectBenchmarkDefinition[]) {
		this.cwd = resolve(cwd);
		this.path = join(this.cwd, CONFIG_DIR_NAME, "benchmarks.json");
		this.definitions = definitions;
	}

	static async open(cwd: string): Promise<ProjectBenchmarkStore> {
		return new ProjectBenchmarkStore(cwd, await readDefinitions(cwd));
	}

	list(): ProjectBenchmark[] {
		return this.definitions.map(materializeDefinition);
	}

	get(nameOrId: string): ProjectBenchmark {
		const matches = this.list().filter(
			(benchmark) => benchmark.name === nameOrId || benchmark.id === nameOrId || benchmark.id.startsWith(nameOrId),
		);
		if (matches.length !== 1) {
			throw new Error(matches.length ? "Benchmark ID prefix is ambiguous" : `Benchmark not found: ${nameOrId}`);
		}
		return matches[0];
	}

	async add(definition: ProjectBenchmarkDefinition): Promise<ProjectBenchmark> {
		const validated = validateDefinition(definition);
		return withFileLock(
			join(this.cwd, CONFIG_DIR_NAME, "benchmarks.lock"),
			async () => {
				const definitions = await readDefinitions(this.cwd);
				if (definitions.some((existing) => existing.name === validated.name)) {
					throw new Error(`Benchmark already exists: ${validated.name}`);
				}
				definitions.push(validated);
				this.definitions = definitions;
				await this.persist();
				return materializeDefinition(validated);
			},
			"Another project benchmark mutation is already running",
			{ wait: true },
		);
	}

	async remove(nameOrId: string): Promise<ProjectBenchmark> {
		return withFileLock(
			join(this.cwd, CONFIG_DIR_NAME, "benchmarks.lock"),
			async () => {
				this.definitions = await readDefinitions(this.cwd);
				const target = this.get(nameOrId);
				this.definitions = this.definitions.filter((definition) => definition.name !== target.name);
				await this.persist();
				return target;
			},
			"Another project benchmark mutation is already running",
			{ wait: true },
		);
	}

	async run(nameOrId: string, options: BenchmarkRunOptions = {}): Promise<LearningBenchmarkAction> {
		this.definitions = await readDefinitions(this.cwd);
		const benchmark = this.get(nameOrId);
		const action = await executeBenchmark(this.cwd, benchmark, undefined, options);
		await ProjectActionStore.open(this.cwd).append(action);
		return action;
	}

	async validate(nameOrId: string, options: BenchmarkRunOptions = {}): Promise<BenchmarkValidationResult> {
		this.definitions = await readDefinitions(this.cwd);
		const benchmark = this.get(nameOrId);
		if (!benchmark.validation) throw new Error(`Benchmark has no validation controls: ${benchmark.name}`);
		const actionStore = ProjectActionStore.open(this.cwd);
		const positive = await executeBenchmark(
			this.cwd,
			benchmark,
			{
				command: benchmark.validation.positive.command,
				args: benchmark.validation.positive.args ?? [],
				purpose: "positive-control",
			},
			options,
		);
		await actionStore.append(positive);
		const negative = await executeBenchmark(
			this.cwd,
			benchmark,
			{
				command: benchmark.validation.negative.command,
				args: benchmark.validation.negative.args ?? [],
				purpose: "negative-control",
			},
			options,
		);
		await actionStore.append(negative);
		const negativeExecuted = negative.exitCode !== null && !negative.timedOut && !negative.error;
		return {
			benchmark,
			positive,
			negative,
			passed:
				positive.passed &&
				positive.integrityPassed === true &&
				!negative.passed &&
				negative.integrityPassed === true &&
				negativeExecuted,
		};
	}

	private async persist(): Promise<void> {
		const file: BenchmarkFile = { version: 1, benchmarks: this.definitions };
		await atomicWrite(this.path, `${JSON.stringify(file, null, 2)}\n`);
	}
}
