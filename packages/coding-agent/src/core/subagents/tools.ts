import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access as fsAccess, lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import * as Diff from "diff";
import { type Static, Type } from "typebox";
import { isolatedEnvironment, runCommand } from "../command-runner.ts";
import type { SubagentScriptConfig } from "../settings-schema.ts";
import { generateUnifiedPatch } from "../tools/edit-diff.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../tools/index.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { DENIED_EXCLUDE_GLOBS, type ProjectScope, ScopeError, type WriteScope } from "./path-scope.ts";
import type { CoderEscalation, CoderReport, OracleRunResult, ScoutReport } from "./types.ts";

export const SCOUT_TOOL_NAMES = ["read", "grep", "find", "ls", "run_script", "report"] as const;
export const CODER_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"run_oracle",
	"finish",
	"escalate",
] as const;

export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
export const MAX_DIFF_CHARS = 20_000;
const TOOL_OUTPUT_LIMIT_CHARS = 8_000;
const ORACLE_TAIL_CHARS = 2_000;
const MAX_VERIFIED_FILE_BYTES = 5_000_000;
const GIT_TIMEOUT_MS = 10_000;
const GIT_SNAPSHOT_ENTRY_LIMIT = 2_000;

export type BeforeToolCall = (context: BeforeToolCallContext) => Promise<{ block: true; reason: string } | undefined>;

export interface ChildCounters {
	scopeViolations: number;
}

function textResult(text: string, extra: { isError?: boolean; terminate?: boolean } = {}) {
	return { content: [{ type: "text" as const, text }], details: undefined, ...extra };
}

function tail(text: string, limit: number): string {
	return text.length <= limit ? text : `[truncated]\n${text.slice(text.length - limit)}`;
}

function formatCommandOutput(result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }) {
	const parts = [
		`exit code: ${result.exitCode === null ? "none" : result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
	];
	if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
	if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
	return tail(parts.join("\n"), TOOL_OUTPUT_LIMIT_CHARS);
}

/** Read-only tools confined to the project root. Scope errors are counted in `counters`. */
function createConfinedReadTools(project: ProjectScope, counters: ChildCounters): AgentTool<any>[] {
	const accessible = (path: string): string => {
		try {
			return project.resolveAccessible(path);
		} catch (error) {
			if (error instanceof ScopeError) counters.scopeViolations += 1;
			throw error;
		}
	};
	// grep and find spawn ripgrep/fd, which read and list files themselves. They get the denylist as exclusion
	// globs (never enter .git, .ssh, ...) and every path they report is re-checked against the scope, so a glob
	// or path argument cannot surface a denied or out-of-project file. Verdicts are cached per path.
	const verdicts = new Map<string, boolean>();
	const isPathAllowed = (absolutePath: string): boolean => {
		let verdict = verdicts.get(absolutePath);
		if (verdict === undefined) {
			verdict = project.isAllowed(absolutePath);
			verdicts.set(absolutePath, verdict);
		}
		return verdict;
	};
	return [
		createReadTool(project.root, {
			operations: {
				readFile: async (path) => readFile(accessible(path)),
				access: async (path) => fsAccess(accessible(path), constants.R_OK),
			},
		}),
		createGrepTool(project.root, {
			excludeGlobs: DENIED_EXCLUDE_GLOBS,
			isPathAllowed,
			operations: {
				isDirectory: async (path) => (await stat(accessible(path))).isDirectory(),
				readFile: async (path) => readFile(accessible(path), "utf-8"),
			},
		}),
		createFindTool(project.root, { excludeGlobs: DENIED_EXCLUDE_GLOBS, isPathAllowed }),
		createLsTool(project.root, {
			operations: {
				exists: async (path) => {
					try {
						await fsAccess(accessible(path));
						return true;
					} catch (error) {
						if (error instanceof ScopeError) throw error;
						return false;
					}
				},
				// Entries of a listing are stat-ed one by one. An entry that links out of the project is described by the
				// link itself (not followed) and is not a violation; the directory being listed is checked by `readdir`.
				stat: async (path) => {
					try {
						return await stat(project.resolveAccessible(path));
					} catch (error) {
						if (!(error instanceof ScopeError)) throw error;
						return lstat(path);
					}
				},
				readdir: async (path) => readdir(accessible(path)),
			},
		}),
	];
}

function pathArgument(args: unknown): string {
	const path = (args as { path?: unknown } | null)?.path;
	return typeof path === "string" && path.length > 0 ? path : ".";
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Second enforcement layer. Blocks read-tool paths outside the project and, when `write` is given, edit/write outside the target. */
function createBeforeToolCall(project: ProjectScope, counters: ChildCounters, write?: WriteScope): BeforeToolCall {
	return async (context) => {
		const name = context.toolCall.name;
		try {
			if (READ_TOOLS.has(name)) {
				project.resolveAccessible(pathArgument(context.args));
			} else if (write && (name === "edit" || name === "write")) {
				write.assertTarget(resolveToCwd(pathArgument(context.args), project.root));
			}
		} catch (error) {
			if (!(error instanceof ScopeError)) throw error;
			counters.scopeViolations += 1;
			return { block: true, reason: error.message };
		}
		return undefined;
	};
}

const confidenceSchema = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);

const reportSchema = Type.Object({
	findings: Type.Array(
		Type.Object({
			claim: Type.String({ maxLength: 1000 }),
			evidence: Type.Array(
				Type.Object({
					path: Type.String({ maxLength: 500, description: "Project-relative path you observed." }),
					startLine: Type.Integer({ minimum: 1 }),
					endLine: Type.Integer({ minimum: 1 }),
					quote: Type.Optional(Type.String({ maxLength: 500 })),
				}),
				{ maxItems: 10 },
			),
			confidence: confidenceSchema,
		}),
		{ maxItems: 30 },
	),
	unresolved: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }),
	suggestedNextAction: Type.Optional(Type.String({ maxLength: 1000 })),
	confidence: confidenceSchema,
});

export type RawScoutReport = Static<typeof reportSchema>;

const runScriptSchema = Type.Object({
	name: Type.String({ description: "Name of a configured script." }),
	args: Type.Optional(
		Type.Array(Type.String(), { description: "Extra arguments, only for scripts that allow them." }),
	),
});

export interface ScoutChild {
	tools: AgentTool<any>[];
	terminalTools: readonly string[];
	beforeToolCall: BeforeToolCall;
	counters: ChildCounters;
	/** The report the scout submitted, if any. */
	getReport(): RawScoutReport | undefined;
}

export function createScoutChild(options: {
	project: ProjectScope;
	scripts: Record<string, SubagentScriptConfig>;
}): ScoutChild {
	const { project, scripts } = options;
	const counters: ChildCounters = { scopeViolations: 0 };
	let submitted: RawScoutReport | undefined;
	const runScript: AgentTool<typeof runScriptSchema> = {
		name: "run_script",
		label: "run_script",
		description: `Run a project script by name and return its output. Available scripts: ${Object.keys(scripts).join(", ") || "none"}.`,
		parameters: runScriptSchema,
		async execute(_toolCallId, params, signal) {
			const script = Object.hasOwn(scripts, params.name) ? scripts[params.name] : undefined;
			if (!script) return textResult(`Unknown script: ${params.name}`, { isError: true });
			if (params.args && params.args.length > 0 && !script.allowArgs) {
				return textResult(`Script ${params.name} does not accept extra arguments`, { isError: true });
			}
			let cwd: string;
			try {
				cwd = project.resolveAccessible(script.cwd ?? ".");
			} catch (error) {
				if (!(error instanceof ScopeError)) throw error;
				return textResult(`Script cwd is not accessible: ${error.message}`, { isError: true });
			}
			const result = await runCommand({
				command: script.command,
				args: [...(script.args ?? []), ...(params.args ?? [])],
				cwd,
				env: isolatedEnvironment().env,
				timeoutMs: script.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
				signal,
			});
			if (result.spawnError) return textResult(`Failed to start script: ${result.spawnError}`, { isError: true });
			return textResult(formatCommandOutput(result));
		},
	};
	const report: AgentTool<typeof reportSchema> = {
		name: "report",
		label: "report",
		description:
			"Submit the final report and end the investigation. Every finding needs evidence with the file path and line range you observed.",
		parameters: reportSchema,
		async execute(_toolCallId, params) {
			submitted = params;
			return textResult("Report recorded.", { terminate: true });
		},
	};
	return {
		tools: [...createConfinedReadTools(project, counters), runScript, report],
		terminalTools: ["report"],
		beforeToolCall: createBeforeToolCall(project, counters),
		counters,
		getReport: () => submitted,
	};
}

const finishSchema = Type.Object({
	summary: Type.String({ maxLength: 2000, description: "What you changed, or why you could not." }),
	uncertainties: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }),
	interfaceChanges: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }),
});

export type RawFinish = Static<typeof finishSchema>;

const escalateSchema = Type.Object({
	reason: Type.Union(
		[Type.Literal("scope_expansion"), Type.Literal("unresolved_failure"), Type.Literal("ambiguous_spec")],
		{
			description:
				"scope_expansion: the task needs a change outside the target file. unresolved_failure: you could not make the change work within the target. ambiguous_spec: the brief does not say what to do.",
		},
	),
	detail: Type.String({ maxLength: 2000, description: "What blocks you, concretely." }),
	filesNeeded: Type.Optional(
		Type.Array(Type.String({ maxLength: 500 }), {
			maxItems: 20,
			description: "Project-relative files that would need to change or be known.",
		}),
	),
});

export interface OracleCommand {
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface CoderChild {
	tools: AgentTool<any>[];
	terminalTools: readonly string[];
	beforeToolCall: BeforeToolCall;
	counters: ChildCounters;
	getFinish(): RawFinish | undefined;
	/** The escalation the child submitted, if any. */
	getEscalation(): CoderEscalation | undefined;
	/** How many times the child ran the oracle. */
	getOracleRuns(): number;
}

export function createCoderChild(options: {
	project: ProjectScope;
	scope: WriteScope;
	oracle: OracleCommand;
	maxOracleRuns: number;
}): CoderChild {
	const { project, scope, oracle } = options;
	const counters: ChildCounters = { scopeViolations: 0 };
	let finished: RawFinish | undefined;
	let escalation: CoderEscalation | undefined;
	let oracleRuns = 0;
	const assertTarget = (path: string): void => {
		try {
			scope.assertTarget(path);
		} catch (error) {
			if (error instanceof ScopeError) counters.scopeViolations += 1;
			throw error;
		}
	};
	const targetDirectory = dirname(scope.targetPath);
	const edit = createEditTool(project.root, {
		operations: {
			readFile: async (path) => {
				assertTarget(path);
				return readFile(path);
			},
			writeFile: async (path, content) => {
				assertTarget(path);
				await writeFile(path, content, "utf-8");
			},
			access: async (path) => {
				assertTarget(path);
				await fsAccess(path, constants.R_OK | constants.W_OK);
			},
		},
	});
	const write = createWriteTool(project.root, {
		operations: {
			writeFile: async (path, content) => {
				assertTarget(path);
				await writeFile(path, content, "utf-8");
			},
			mkdir: async (dir) => {
				if (resolve(dir) !== targetDirectory) {
					counters.scopeViolations += 1;
					throw new ScopeError("Directories cannot be created");
				}
			},
		},
	});
	const runOracle: AgentTool = {
		name: "run_oracle",
		label: "run_oracle",
		description: `Run the oracle command given in the brief (${options.maxOracleRuns} run${options.maxOracleRuns === 1 ? "" : "s"} allowed). No other command can be run.`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			if (oracleRuns >= options.maxOracleRuns) {
				return textResult(`Oracle run limit reached (${options.maxOracleRuns})`, { isError: true });
			}
			oracleRuns += 1;
			const result = await runCommand({
				command: oracle.command,
				args: oracle.args,
				cwd: project.root,
				env: isolatedEnvironment().env,
				timeoutMs: oracle.timeoutMs,
				signal,
			});
			if (result.spawnError) return textResult(`Failed to start oracle: ${result.spawnError}`, { isError: true });
			return textResult(formatCommandOutput(result));
		},
	};
	const finish: AgentTool<typeof finishSchema> = {
		name: "finish",
		label: "finish",
		description:
			"Finish the task. Give a summary, your uncertainties, and any interface changes. Call it once; there is no retry.",
		parameters: finishSchema,
		async execute(_toolCallId, params) {
			finished = params;
			return textResult("Finished.", { terminate: true });
		},
	};
	const escalate: AgentTool<typeof escalateSchema> = {
		name: "escalate",
		label: "escalate",
		description:
			"Stop and hand the decision back to the requester instead of working around a limit. Use it when the task needs a change outside the target file, when you cannot make the change work within the target, or when the brief is ambiguous. Terminal: call it once; there is no retry.",
		parameters: escalateSchema,
		async execute(_toolCallId, params) {
			escalation = {
				reason: params.reason,
				detail: params.detail,
				...(params.filesNeeded === undefined ? {} : { filesNeeded: params.filesNeeded }),
			};
			return textResult("Escalated.", { terminate: true });
		},
	};
	return {
		tools: [...createConfinedReadTools(project, counters), edit, write, runOracle, finish, escalate],
		terminalTools: ["finish", "escalate"],
		beforeToolCall: createBeforeToolCall(project, counters, scope),
		counters,
		getFinish: () => finished,
		getEscalation: () => escalation,
		getOracleRuns: () => oracleRuns,
	};
}

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n").length;
	return content.endsWith("\n") ? lines - 1 : lines;
}

/** Marks each cited range `verified` when the file exists inside the project and the range is within it. */
export async function verifyScoutReport(raw: RawScoutReport, project: ProjectScope): Promise<ScoutReport> {
	const counts = new Map<string, number | undefined>();
	const countFor = async (path: string): Promise<number | undefined> => {
		if (counts.has(path)) return counts.get(path);
		let count: number | undefined;
		try {
			const absolute = project.resolveAccessible(path);
			const info = await stat(absolute);
			if (info.isFile() && info.size <= MAX_VERIFIED_FILE_BYTES)
				count = lineCount(await readFile(absolute, "utf-8"));
		} catch {
			count = undefined;
		}
		counts.set(path, count);
		return count;
	};
	const findings: ScoutReport["findings"] = [];
	for (const finding of raw.findings) {
		const evidence: ScoutReport["findings"][number]["evidence"] = [];
		for (const item of finding.evidence) {
			const count = await countFor(item.path);
			evidence.push({
				path: item.path,
				startLine: item.startLine,
				endLine: item.endLine,
				...(item.quote === undefined ? {} : { quote: item.quote }),
				verified:
					count !== undefined && item.startLine >= 1 && item.startLine <= item.endLine && item.endLine <= count,
			});
		}
		findings.push({ claim: finding.claim, evidence, confidence: finding.confidence });
	}
	return {
		findings,
		unresolved: raw.unresolved,
		...(raw.suggestedNextAction === undefined ? {} : { suggestedNextAction: raw.suggestedNextAction }),
		confidence: raw.confidence,
	};
}

export function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export interface FileSnapshot {
	content: string | undefined;
	sha256: string | undefined;
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
	try {
		const buffer = await readFile(path);
		return { content: buffer.toString("utf-8"), sha256: sha256(buffer) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: undefined, sha256: undefined };
		throw error;
	}
}

/** Lines added plus lines removed between two snapshots of the target (0 when unchanged). */
export function countChangedLines(before: FileSnapshot, after: FileSnapshot): number {
	if (before.sha256 === after.sha256) return 0;
	let total = 0;
	for (const part of Diff.diffLines(before.content ?? "", after.content ?? "")) {
		if (part.added || part.removed) total += part.count ?? 0;
	}
	return total;
}

/** Unified diff of the target, capped at {@link MAX_DIFF_CHARS}. */
export function diffTarget(path: string, before: FileSnapshot, after: FileSnapshot): string {
	if (before.sha256 === after.sha256) return "";
	const diff = generateUnifiedPatch(path, before.content ?? "", after.content ?? "");
	return diff.length <= MAX_DIFF_CHARS ? diff : `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`;
}

/** The oracle run that decides `passed`. The harness runs it after the child stops. */
export async function runAuthoritativeOracle(options: {
	oracle: OracleCommand;
	cwd: string;
	childRuns: number;
	signal?: AbortSignal;
}): Promise<OracleRunResult> {
	const result = await runCommand({
		command: options.oracle.command,
		args: options.oracle.args,
		cwd: options.cwd,
		env: isolatedEnvironment().env,
		timeoutMs: options.oracle.timeoutMs,
		signal: options.signal,
	});
	const output = [result.stdout, result.stderr, result.spawnError ?? ""].filter((part) => part.length > 0).join("\n");
	return {
		command: options.oracle.command,
		args: options.oracle.args,
		exitCode: result.exitCode,
		passed: result.exitCode === 0 && !result.timedOut && !result.spawnError,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
		outputTail: tail(output, ORACLE_TAIL_CHARS),
		childRuns: options.childRuns,
	};
}

/** `git status` entries, each with a state key that changes when status, size or mtime changes. */
export interface GitSnapshot {
	/** Repository root; porcelain paths are relative to it. */
	root: string;
	entries: Map<string, string>;
}

/** Returns undefined when `cwd` is not a git work tree or git is unavailable. Informational only. */
export async function snapshotGitStatus(cwd: string, signal?: AbortSignal): Promise<GitSnapshot | undefined> {
	const env = isolatedEnvironment().env;
	const top = await runCommand({
		command: "git",
		args: ["rev-parse", "--show-toplevel"],
		cwd,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		signal,
	});
	if (top.exitCode !== 0 || top.spawnError) return undefined;
	const root = top.stdout.trim();
	const result = await runCommand({
		command: "git",
		args: ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
		cwd,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		signal,
	});
	if (result.exitCode !== 0 || result.spawnError) return undefined;
	const parts = result.stdout.split("\0").filter((entry) => entry.length > 0);
	const entries = new Map<string, string>();
	for (let index = 0; index < parts.length && entries.size < GIT_SNAPSHOT_ENTRY_LIMIT; index++) {
		const part = parts[index];
		const status = part.slice(0, 2);
		const path = part.slice(3);
		if (status.startsWith("R") || status.startsWith("C")) index += 1;
		let state: string;
		try {
			const info = await stat(resolve(root, path));
			state = `${status}:${info.size}:${Math.round(info.mtimeMs)}`;
		} catch {
			state = `${status}:missing`;
		}
		entries.set(path, state);
	}
	return { root, entries };
}

/** Project-relative paths whose git state differs between two snapshots. */
export function changedPaths(before: GitSnapshot, after: GitSnapshot, projectRoot: string): string[] {
	const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
	return [...paths]
		.filter((path) => before.entries.get(path) !== after.entries.get(path))
		.map((path) => relative(projectRoot, resolve(after.root, path)))
		.sort();
}

export function assembleCoderReport(options: {
	project: ProjectScope;
	scope: WriteScope;
	before: FileSnapshot;
	after: FileSnapshot;
	finish: RawFinish | undefined;
	escalation?: CoderEscalation;
	oracle: OracleRunResult | undefined;
	outsideTargetChanges: string[] | undefined;
}): CoderReport {
	const path = relative(options.project.root, options.scope.targetPath);
	return {
		path,
		changed: options.before.sha256 !== options.after.sha256,
		diff: diffTarget(path, options.before, options.after),
		beforeSha256: options.before.sha256,
		afterSha256: options.after.sha256,
		diffLines: countChangedLines(options.before, options.after),
		summary: options.finish?.summary ?? options.escalation?.detail ?? "The child did not call finish.",
		uncertainties: options.finish?.uncertainties ?? [],
		interfaceChanges: options.finish?.interfaceChanges ?? [],
		...(options.oracle === undefined ? {} : { oracle: options.oracle }),
		...(options.escalation === undefined ? {} : { escalation: options.escalation }),
		...(options.outsideTargetChanges === undefined ? {} : { outsideTargetChanges: options.outsideTargetChanges }),
	};
}
