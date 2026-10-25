/**
 * Deterministic project-local ledger of LLM actions and reasoning.
 *
 * Records live under <cwd>/<CONFIG_DIR_NAME>/learning/actions.jsonl, one canonical-JSON
 * record per line. Record IDs are content hashes: replaying the same transcript yields the
 * same IDs, so appends are idempotent and the ledger can be rebuilt from a session log
 * without duplication.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { HarnessProfile } from "../settings-manager.ts";
import { withFileLock } from "./file-lock.ts";

/** Directory inside the project config dir that holds all learning state. */
export const LEARNING_DIRECTORY = "learning";

const ACTIONS_FILE_NAME = "actions.jsonl";
const MEMORY_FILE_NAME = "memory.json";
const REVIEWS_FILE_NAME = "reviews.jsonl";
const PROPOSALS_FILE_NAME = "proposals.json";
const CURSOR_FILE_NAME = "cursor.json";
const GITIGNORE_CONTENT = "*\n!.gitignore\n";

/** Replacement marker for redacted sensitive values. */
export const REDACTED = "[REDACTED]";

export interface LearningPaths {
	/** <cwd>/<CONFIG_DIR_NAME>/learning */
	root: string;
	/** Append-only action ledger (JSONL). */
	actions: string;
	/** Curated project memory document (JSON). */
	memory: string;
	/** Append-only review ledger (JSONL). */
	reviews: string;
	/** Improvement proposals document (JSON). */
	proposals: string;
	/** Cursor tracking how far the ledger has been processed. */
	cursor: string;
}

export function getLearningPaths(cwd: string): LearningPaths {
	const root = join(cwd, CONFIG_DIR_NAME, LEARNING_DIRECTORY);
	return {
		root,
		actions: join(root, ACTIONS_FILE_NAME),
		memory: join(root, MEMORY_FILE_NAME),
		reviews: join(root, REVIEWS_FILE_NAME),
		proposals: join(root, PROPOSALS_FILE_NAME),
		cursor: join(root, CURSOR_FILE_NAME),
	};
}

/** Deterministic project identifier: sha256 of the resolved project path. */
export function getProjectId(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 32);
}

function canonicalize(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			const entry = source[key];
			if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
			out[key] = canonicalize(entry);
		}
		return out;
	}
	if (typeof value === "number" && !Number.isFinite(value)) return null;
	if (typeof value === "bigint") return value.toString();
	return value;
}

/** JSON.stringify with recursively sorted object keys, so equal values hash identically. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/** Content-addressed record ID: `${prefix}_${sha256(canonicalJson(identity)).slice(0, 32)}`. */
export function deterministicId(prefix: string, identity: unknown): string {
	const digest = createHash("sha256").update(canonicalJson(identity)).digest("hex");
	return `${prefix}_${digest.slice(0, 32)}`;
}

/**
 * Keys whose values are redacted. Matching is done on the normalized key (lowercase,
 * separators removed) so `api_key`, `apiKey`, and `api-key` are treated the same.
 * Structured key/value fields are redacted together with narrow credential patterns in
 * strings; reasoning text is not rewritten merely for mentioning an API key.
 */
const SENSITIVE_KEYS = new Set([
	"password",
	"passwd",
	"pwd",
	"passphrase",
	"secret",
	"token",
	"apikey",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authtoken",
	"sessiontoken",
	"authorization",
	"proxyauthorization",
	"cookie",
	"setcookie",
	"privatekey",
	"clientsecret",
	"credentials",
	"bearer",
	"xapikey",
]);

const SENSITIVE_KEY_SUFFIXES = ["apikey", "accesstoken", "refreshtoken", "clientsecret", "privatekey", "password"];

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
	if (SENSITIVE_KEYS.has(normalized)) return true;
	return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.length > suffix.length && normalized.endsWith(suffix));
}

/**
 * Narrow string patterns for credential material pasted into otherwise normal text.
 * Each requires a long, token-shaped payload so prose such as "Bearer authentication"
 * or "the sk- prefix" is left untouched.
 */
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g;
const API_KEY_VALUE_PATTERN = /\bsk-(?:[A-Za-z0-9]{2,}-)*[A-Za-z0-9]{16,}\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const GITLAB_TOKEN_PATTERN = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|AGPA)[A-Z0-9]{16}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

function redactString(value: string): string {
	return value
		.replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED)
		.replace(BEARER_TOKEN_PATTERN, REDACTED)
		.replace(API_KEY_VALUE_PATTERN, REDACTED)
		.replace(GITHUB_TOKEN_PATTERN, REDACTED)
		.replace(GITLAB_TOKEN_PATTERN, REDACTED)
		.replace(SLACK_TOKEN_PATTERN, REDACTED)
		.replace(AWS_ACCESS_KEY_PATTERN, REDACTED)
		.replace(JWT_PATTERN, REDACTED);
}

/**
 * Best-effort recursive redaction of obvious credential values. Object entries whose key
 * names a password, API key, token, secret, or authorization value are replaced with
 * "[REDACTED]". Inside strings, only obvious credential material (Bearer tokens,
 * sk-/sk-or-v1-style keys, common GitHub/GitLab/Slack/AWS tokens, JWTs, and PEM
 * private-key blocks) is redacted; reasoning text that merely mentions API keys is
 * preserved. The input is not mutated.
 */
export function redactSensitive(value: unknown): unknown {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map(redactSensitive);
	if (value !== null && typeof value === "object" && !(value instanceof Date)) {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source)) {
			out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(source[key]);
		}
		return out;
	}
	return value;
}

export interface LearningMessageAction {
	version: 1;
	actionId: string;
	projectId: string;
	sessionId: string;
	kind: "message";
	timestamp: number;
	/** Upstream host that served an assistant response (e.g. OpenRouter "Novita"), when reported. */
	upstreamProvider?: string;
	/** Sanitized message as recorded; credential-shaped fields are redacted. */
	message: AgentMessage;
	harnessProfile?: HarnessProfile;
	/** Benchmark run that spawned this session, from BLING_BENCHMARK_RUN_ID. */
	benchmarkRunId?: string /** Active configuration (harness profile, subagent roles, delegation mode) as `armIdFromSettings` renders it. */;
	armId?: string;
}

export interface LearningToolAction {
	version: 1;
	actionId: string;
	projectId: string;
	sessionId: string;
	kind: "tool";
	timestamp: number;
	toolCallId: string;
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	parentToolCallId?: string;
	parentActionId?: string;
	durationMs?: number;
	harnessProfile?: HarnessProfile;
	/** Active configuration (harness profile, subagent roles, delegation mode) as `armIdFromSettings` renders it. */
	armId?: string;
	benchmarkRunId?: string;
}

export interface BenchmarkOracleCheckResult {
	name: string;
	expected: unknown;
	passed: boolean;
}

export interface LearningBenchmarkActionInput {
	benchmarkId: string;
	benchmarkName: string;
	definitionHash: string;
	command: string;
	args: string[];
	cwd: string;
	startedAt: number;
	durationMs: number;
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	passed: boolean;
	checks: BenchmarkOracleCheckResult[];
	error?: string;
	purpose?: "benchmark" | "positive-control" | "negative-control";
	environmentMode?: "isolated" | "inherit";
	environmentKeys?: string[];
	definitionFileHashBefore?: string;
	definitionFileHashAfter?: string;
	integrityPassed?: boolean;
	harnessProfile?: HarnessProfile;
	runId?: string;
	armId?: string;
}

export interface LearningBenchmarkAction extends LearningBenchmarkActionInput {
	version: 1;
	actionId: string;
	projectId: string;
	sessionId: "project-benchmark";
	kind: "benchmark";
	timestamp: number;
}

export interface LearningSubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	/** Reasoning tokens, a subset of `output`. Absent when the provider reported no breakdown. */
	reasoning?: number;
}

export interface LearningSubagentOracle {
	command: string;
	args: string[];
	exitCode: number | null;
	passed: boolean;
	timedOut: boolean;
	durationMs: number;
}

export interface LearningSubagentActionInput {
	runId: string;
	role: "scout" | "coder";
	roleName: string;
	roleIdentityHash: string;
	provider: string;
	model: string;
	requestedUpstream?: string;
	servedUpstreams: string[];
	outcome: string;
	error?: string;
	usage: LearningSubagentUsage;
	turns: number;
	startedAt: number;
	durationMs: number;
	targetPath?: string;
	oracle?: LearningSubagentOracle;
	diffSha256?: string;
	/** Changed lines (added plus removed) in the coder's target. */
	diffLines?: number;
	/** Set when the coder ended with `escalate`. */
	escalationReason?: "scope_expansion" | "unresolved_failure" | "ambiguous_spec";
	scopeViolations: number;
	/** Milliseconds until the first assistant message that contained a tool call. */
	timeToFirstToolCallMs?: number;
	/** Tool calls that errored or were blocked (includes scope violations). */
	failedToolCalls?: number;
	parentSessionId: string;
	parentToolCallId: string;
	parentActionId?: string;
	benchmarkRunId?: string;
	harnessProfile?: HarnessProfile;
	/** Active configuration (harness profile, subagent roles, delegation mode) as `armIdFromSettings` renders it. */
	armId?: string;
}

export interface LearningSubagentAction extends LearningSubagentActionInput {
	version: 1;
	actionId: string;
	projectId: string;
	sessionId: string;
	kind: "subagent";
	timestamp: number;
}

export function createSubagentAction(cwd: string, input: LearningSubagentActionInput): LearningSubagentAction {
	const sanitized = redactSensitive(input) as LearningSubagentActionInput;
	return {
		...sanitized,
		version: 1,
		actionId: deterministicId("sub", {
			runId: sanitized.runId,
			parentSessionId: sanitized.parentSessionId,
			parentToolCallId: sanitized.parentToolCallId,
		}),
		projectId: getProjectId(cwd),
		sessionId: sanitized.parentSessionId,
		kind: "subagent",
		timestamp: input.startedAt,
	};
}

export interface LearningSubagentVerdictActionInput {
	/** The `runId` of the subagent run being judged (see the `subagent` record and the tool result). */
	runId: string;
	verdict: "accepted" | "rejected";
	reason: string;
	role: "scout" | "coder";
	roleName: string;
	/** Wall-clock time of the decision. */
	decidedAt: number;
	/** Session and tool call that recorded the verdict. */
	parentSessionId: string;
	parentToolCallId: string;
	benchmarkRunId?: string;
	harnessProfile?: HarnessProfile;
	/** Active configuration (harness profile, subagent roles, delegation mode) as `armIdFromSettings` renders it. */
	armId?: string;
}

/**
 * Ling's decision on one subagent result. Append-only: a later verdict for the same run supersedes an earlier one
 * (the report uses the latest by timestamp).
 */
export interface LearningSubagentVerdictAction extends LearningSubagentVerdictActionInput {
	version: 1;
	actionId: string;
	projectId: string;
	sessionId: string;
	kind: "subagent_verdict";
	timestamp: number;
}

export function createSubagentVerdictAction(
	cwd: string,
	input: LearningSubagentVerdictActionInput,
): LearningSubagentVerdictAction {
	const sanitized = redactSensitive(input) as LearningSubagentVerdictActionInput;
	return {
		...sanitized,
		version: 1,
		actionId: deterministicId("verdict", {
			runId: sanitized.runId,
			parentSessionId: sanitized.parentSessionId,
			parentToolCallId: sanitized.parentToolCallId,
		}),
		projectId: getProjectId(cwd),
		sessionId: sanitized.parentSessionId,
		kind: "subagent_verdict",
		timestamp: input.decidedAt,
	};
}

export type LearningActionRecord =
	| LearningMessageAction
	| LearningToolAction
	| LearningBenchmarkAction
	| LearningSubagentAction
	| LearningSubagentVerdictAction;

/** Build a deterministic, redacted ledger record for one executed project benchmark. */
export function createBenchmarkAction(cwd: string, input: LearningBenchmarkActionInput): LearningBenchmarkAction {
	const sanitized = redactSensitive(input) as LearningBenchmarkActionInput;
	return {
		...sanitized,
		version: 1,
		actionId: deterministicId("run", sanitized),
		projectId: getProjectId(cwd),
		sessionId: "project-benchmark",
		kind: "benchmark",
		timestamp: input.startedAt,
	};
}

/**
 * Event-shaped input for createToolAction, matching the agent loop's
 * `tool_execution_end` event (plus optional parent/duration metadata).
 */
export interface LearningToolActionInput {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result?: unknown;
	isError: boolean;
	parentToolCallId?: string;
	parentActionId?: string;
	durationMs?: number;
	/** Wall-clock record time; excluded from the action ID. Defaults to Date.now(). */
	timestamp?: number;
	harnessProfile?: HarnessProfile;
	/** Active configuration (harness profile, subagent roles, delegation mode) as `armIdFromSettings` renders it. */
	armId?: string;
	benchmarkRunId?: string;
}

function messageTimestamp(message: AgentMessage): number {
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	return typeof timestamp === "number" ? timestamp : Date.now();
}

function messageIdentity(sessionId: string, message: AgentMessage): Record<string, unknown> {
	const identity: Record<string, unknown> = {
		sessionId,
		role: message.role,
		timestamp: (message as { timestamp?: unknown }).timestamp,
	};
	if ("content" in message) identity.content = message.content;
	if (message.role === "assistant") {
		identity.provider = message.provider;
		identity.model = message.model;
		identity.stopReason = message.stopReason;
		identity.toolCallIds = message.content.filter((part) => part.type === "toolCall").map((part) => part.id);
	}
	if (message.role === "toolResult") {
		identity.toolCallId = message.toolCallId;
		identity.toolName = message.toolName;
	}
	return identity;
}

/**
 * Build a ledger record for a conversation message. The ID covers the session, role,
 * timestamp, content, and (for assistant messages) provider/model/stopReason/tool call
 * IDs, so identical content at distinct timestamps is distinct while replaying the same
 * transcript yields the same IDs.
 */
export function createMessageAction(
	cwd: string,
	sessionId: string,
	message: AgentMessage,
	harnessProfile?: HarnessProfile,
	benchmarkRunId?: string,
	armId?: string,
): LearningMessageAction {
	const sanitized = redactSensitive(message) as AgentMessage;
	const upstreamProvider =
		sanitized.role === "assistant" &&
		typeof sanitized.responseProvider === "string" &&
		sanitized.responseProvider.length > 0
			? sanitized.responseProvider
			: undefined;
	return {
		version: 1,
		actionId: deterministicId("act", messageIdentity(sessionId, sanitized)),
		projectId: getProjectId(cwd),
		sessionId,
		kind: "message",
		timestamp: messageTimestamp(message),
		...(upstreamProvider === undefined ? {} : { upstreamProvider }),
		message: sanitized,
		...(harnessProfile === undefined ? {} : { harnessProfile }),
		...(benchmarkRunId === undefined ? {} : { benchmarkRunId }),
		...(armId === undefined ? {} : { armId }),
	};
}

/**
 * Build a ledger record for a finished tool execution. The ID covers session, toolCallId,
 * result, and isError only; wall-clock time is excluded so replays are stable.
 */
export function createToolAction(cwd: string, sessionId: string, event: LearningToolActionInput): LearningToolAction {
	const args = redactSensitive(event.args ?? null);
	const result = redactSensitive(event.result ?? null);
	const record: LearningToolAction = {
		version: 1,
		actionId: deterministicId("tool", {
			sessionId,
			toolCallId: event.toolCallId,
			result,
			isError: event.isError,
		}),
		projectId: getProjectId(cwd),
		sessionId,
		kind: "tool",
		timestamp: event.timestamp ?? Date.now(),
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args,
		result,
		isError: event.isError,
	};
	if (event.parentToolCallId !== undefined) record.parentToolCallId = event.parentToolCallId;
	if (event.parentActionId !== undefined) record.parentActionId = event.parentActionId;
	if (event.durationMs !== undefined) record.durationMs = event.durationMs;
	if (event.harnessProfile !== undefined) record.harnessProfile = event.harnessProfile;
	if (event.benchmarkRunId !== undefined) record.benchmarkRunId = event.benchmarkRunId;
	if (event.armId !== undefined) record.armId = event.armId;
	return record;
}

// The mode applies only on creation so administrator-managed modes and ACLs remain intact.
const LEDGER_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

type FileState = { size: number; mtimeMs: number };

/**
 * Append-only store for one project's action ledger. Writes are serialized within the
 * instance; duplicates (by actionId) are skipped. No global state is kept, so multiple
 * projects and tests can hold stores concurrently.
 */
export class ProjectActionStore {
	readonly cwd: string;
	readonly projectId: string;
	readonly paths: LearningPaths;

	private writeChain: Promise<void>;
	private layoutEnsured = false;
	private knownIds: Set<string> | undefined;
	private knownFileState: FileState | undefined;

	private constructor(cwd: string) {
		this.cwd = cwd;
		this.projectId = getProjectId(cwd);
		this.paths = getLearningPaths(cwd);
		this.writeChain = Promise.resolve();
	}

	static open(cwd: string): ProjectActionStore {
		return new ProjectActionStore(resolve(cwd));
	}

	/** Append a record. Resolves false when the actionId is already in the ledger. */
	append(action: LearningActionRecord): Promise<boolean> {
		const run = this.writeChain.then(() => this.appendNow(action));
		this.writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Wait for all queued appends to finish. */
	async flush(): Promise<void> {
		await this.writeChain;
	}

	/** All records in append order. */
	async list(): Promise<LearningActionRecord[]> {
		let raw: string;
		try {
			raw = await readFile(this.paths.actions, "utf-8");
		} catch {
			return [];
		}
		const records: LearningActionRecord[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				records.push(JSON.parse(trimmed) as LearningActionRecord);
			} catch {
				// Skip unparseable lines rather than failing the whole read.
			}
		}
		return records;
	}

	/**
	 * Case-insensitive free-text search over canonical record JSON. All whitespace-separated
	 * terms must match. Results keep deterministic append order and are capped at `limit`.
	 */
	async search(query: string, limit = 20): Promise<LearningActionRecord[]> {
		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.filter((term) => term.length > 0);
		const results: LearningActionRecord[] = [];
		for (const record of await this.list()) {
			if (results.length >= limit) break;
			if (terms.length === 0) {
				results.push(record);
				continue;
			}
			const haystack = canonicalJson(record).toLowerCase();
			if (terms.every((term) => haystack.includes(term))) results.push(record);
		}
		return results;
	}

	private async appendNow(action: LearningActionRecord): Promise<boolean> {
		await this.ensureLayout();
		return withFileLock(
			join(this.paths.root, "actions.lock"),
			async () => {
				const ids = await this.loadKnownIds();
				if (ids.has(action.actionId)) return false;
				await appendFile(this.paths.actions, `${canonicalJson(action)}\n`, LEDGER_FILE_WRITE_OPTIONS);
				ids.add(action.actionId);
				// Never cache a post-write stat alongside IDs that may not cover every byte
				// observed by another store before it entered the lock.
				this.knownFileState = undefined;
				return true;
			},
			"Another project action append is already running",
			{ wait: true },
		);
	}

	private async ensureLayout(): Promise<void> {
		if (this.layoutEnsured) return;
		await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
		const gitignorePath = join(this.paths.root, ".gitignore");
		let existing: string | undefined;
		try {
			existing = await readFile(gitignorePath, "utf-8");
		} catch {
			existing = undefined;
		}
		if (existing !== GITIGNORE_CONTENT) {
			await writeFile(gitignorePath, GITIGNORE_CONTENT, LEDGER_FILE_WRITE_OPTIONS);
		}
		this.layoutEnsured = true;
	}

	/**
	 * Known actionIds, refreshed from disk whenever the ledger file changed since the last
	 * read so appends through another store instance are still deduplicated.
	 */
	private async loadKnownIds(): Promise<Set<string>> {
		let fileState: FileState | undefined;
		try {
			const next = await stat(this.paths.actions);
			fileState = { size: next.size, mtimeMs: next.mtimeMs };
		} catch {
			fileState = undefined;
		}
		if (!fileState) {
			this.knownIds = new Set();
			this.knownFileState = undefined;
			return this.knownIds;
		}
		if (
			this.knownIds &&
			this.knownFileState &&
			this.knownFileState.size === fileState.size &&
			this.knownFileState.mtimeMs === fileState.mtimeMs
		) {
			return this.knownIds;
		}
		const ids = new Set<string>();
		const raw = await readFile(this.paths.actions, "utf-8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (parsed !== null && typeof parsed === "object") {
					const actionId = (parsed as { actionId?: unknown }).actionId;
					if (typeof actionId === "string") ids.add(actionId);
				}
			} catch {
				// Ignore unparseable lines when collecting IDs.
			}
		}
		this.knownIds = ids;
		this.knownFileState = fileState;
		return ids;
	}
}
