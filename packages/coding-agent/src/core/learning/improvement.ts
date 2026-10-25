import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	type Context,
	contentText,
	type Model,
} from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { loadSkillsFromDir } from "../skills.ts";
import {
	canonicalJson,
	createMessageAction,
	deterministicId,
	getLearningPaths,
	type LearningActionRecord,
	ProjectActionStore,
	redactSensitive,
} from "./action-store.ts";
import { withFileLock } from "./file-lock.ts";
import { ProjectMemoryStore } from "./memory-store.ts";

export const IMPROVEMENT_PROMPT_VERSION = 1;
export const DEFAULT_REVIEW_BATCH_ACTIONS = 80;
export const DEFAULT_REVIEW_MAX_INPUT_TOKENS = 180_000;
export const DEFAULT_DECIDER_THRESHOLD_CHARS = 32_000;
export const DEFAULT_DECIDER_MODEL = "perplexity/pplx-decider-v1.2";
export const DEFAULT_DECIDER_PROVIDER = "openrouter";
export const DEFAULT_DECIDER_MIN_PROBABILITY = 0.55;

export type ProposalStatus = "pending" | "rejected" | "applied";
export type ProposalEvidenceClass = "executed" | "observed" | "inferred" | "human";

export interface ProposalEvidence {
	actionId: string;
	evidenceClass: ProposalEvidenceClass;
}

interface ProposalBase {
	id: string;
	reviewId: string;
	title: string;
	rationale: string;
	evidenceActionIds: string[];
	evidence: ProposalEvidence[];
	status: ProposalStatus;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryAddProposal extends ProposalBase {
	kind: "memory";
	operation: "add";
	content: string;
}

export interface MemoryPatchProposal extends ProposalBase {
	kind: "memory";
	operation: "patch";
	targetId: string;
	oldText: string;
	newText: string;
}

export interface MemoryRemoveProposal extends ProposalBase {
	kind: "memory";
	operation: "remove";
	targetId: string;
}

export interface SkillProposal extends ProposalBase {
	kind: "skill";
	operation: "create" | "update";
	name: string;
	content: string;
	baseHash?: string;
}

export type ImprovementProposal = MemoryAddProposal | MemoryPatchProposal | MemoryRemoveProposal | SkillProposal;

export interface ImprovementDecision {
	provider: string;
	model: string;
	probability: number;
	priority?: string;
	thresholdChars: number;
	stateChars: number;
	result: ClassifierResult;
	/** Provider-returned failure retained for audit; failed decisions are never cached for reuse. */
	error?: string;
}

export interface ImprovementReview {
	type: "review";
	reviewId: string;
	createdAt: number;
	actionIds: string[];
	provider: string;
	model: string;
	response: AssistantMessage;
	proposalIds: string[];
	decision?: ImprovementDecision;
	/** Set when the provider response was retained but its proposal JSON could not be accepted. */
	error?: string;
}

export interface ImprovementDecisionRecord {
	type: "decision";
	reviewId: string;
	createdAt: number;
	actionIds: string[];
	decision: ImprovementDecision;
}

export type ImprovementHistoryRecord = ImprovementReview | ImprovementDecisionRecord;

export interface ImprovementRuntime {
	complete(model: Model<Api>, context: Context, options?: { maxTokens?: number }): Promise<AssistantMessage>;
	classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext): Promise<ClassifierResult>;
	getModelOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
}

export interface ReviewBatchOptions {
	cwd: string;
	maxBatchActions?: number;
	maxInputTokens?: number;
}

export interface RunImprovementReviewOptions extends ReviewBatchOptions {
	runtime: ImprovementRuntime;
	model: Model<Api>;
	useDecider?: boolean;
	deciderProvider?: string;
	deciderModel?: string;
	deciderThresholdChars?: number;
	deciderMinProbability?: number;
	/** Record gate decisions but always run the generative review for calibration. */
	deciderShadow?: boolean;
}

export type ImprovementReviewResult =
	| { status: "empty"; actionCount: 0 }
	| { status: "gated"; reviewId: string; actionCount: number; decision: ImprovementDecision }
	| { status: "created" | "cached"; reviewId: string; actionCount: number; proposals: ImprovementProposal[] };

interface ReviewCursor {
	lastActionId: string;
	updatedAt: number;
}

interface SkillSnapshot {
	name: string;
	hash: string;
	content: string;
}

interface RawProposal {
	kind: "memory" | "skill";
	operation: "add" | "patch" | "remove" | "create" | "update";
	title: string;
	rationale: string;
	evidenceActionIds: string[];
	content?: string;
	targetId?: string;
	oldText?: string;
	newText?: string;
	name?: string;
	baseHash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function ensureLearningLayout(cwd: string): Promise<void> {
	const { root } = getLearningPaths(cwd);
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeFile(join(root, ".gitignore"), "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
}

async function appendHistory(cwd: string, record: ImprovementHistoryRecord): Promise<void> {
	const { reviews } = getLearningPaths(cwd);
	await ensureLearningLayout(cwd);
	await writeFile(reviews, `${canonicalJson(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

export async function listImprovementHistory(cwd: string): Promise<ImprovementHistoryRecord[]> {
	const { reviews } = getLearningPaths(cwd);
	try {
		const text = await readFile(reviews, "utf8");
		return text
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as ImprovementHistoryRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function parseRawProposal(value: unknown, evidenceIds: Set<string>): RawProposal {
	if (!isRecord(value)) throw new Error("Each improvement proposal must be an object");
	const kind = requiredString(value.kind, "proposal.kind");
	if (kind !== "memory" && kind !== "skill") throw new Error(`Unsupported proposal kind: ${kind}`);
	const operation = requiredString(value.operation, "proposal.operation");
	const allowed = kind === "memory" ? ["add", "patch", "remove"] : ["create", "update"];
	if (!allowed.includes(operation)) throw new Error(`Unsupported ${kind} proposal operation: ${operation}`);
	const rawEvidence = value.evidenceActionIds;
	if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
		throw new Error("Every proposal must cite at least one action ID");
	}
	const evidenceActionIds = rawEvidence.map((id) => requiredString(id, "evidenceActionIds entry"));
	for (const id of evidenceActionIds) {
		if (!evidenceIds.has(id)) throw new Error(`Proposal cites action outside this review: ${id}`);
	}
	return {
		kind,
		operation: operation as RawProposal["operation"],
		title: requiredString(value.title, "proposal.title"),
		rationale: requiredString(value.rationale, "proposal.rationale"),
		evidenceActionIds,
		content: optionalString(value.content),
		targetId: optionalString(value.targetId),
		oldText: optionalString(value.oldText),
		newText: optionalString(value.newText),
		name: optionalString(value.name),
		baseHash: optionalString(value.baseHash),
	};
}

function proposalEvidence(action: LearningActionRecord): ProposalEvidenceClass {
	if (action.kind === "benchmark") return "executed";
	if (action.kind === "tool" || action.kind === "subagent" || action.kind === "subagent_verdict") return "observed";
	return action.sessionId === "project-memory-tool" ? "human" : "inferred";
}

function materializeProposal(
	raw: RawProposal,
	reviewId: string,
	now: number,
	actions: readonly LearningActionRecord[] = [],
): ImprovementProposal {
	const byId = new Map(actions.map((action) => [action.actionId, action]));
	const base = {
		id: deterministicId("prop", { reviewId, proposal: raw }),
		reviewId,
		title: raw.title,
		rationale: raw.rationale,
		evidenceActionIds: raw.evidenceActionIds,
		evidence: raw.evidenceActionIds.map((actionId) => {
			const action = byId.get(actionId);
			return { actionId, evidenceClass: action ? proposalEvidence(action) : "inferred" };
		}),
		status: "pending" as const,
		createdAt: now,
		updatedAt: now,
	};
	if (raw.kind === "memory") {
		if (raw.operation === "add") {
			return { ...base, kind: "memory", operation: "add", content: requiredString(raw.content, "memory content") };
		}
		const targetId = requiredString(raw.targetId, "memory targetId");
		if (raw.operation === "remove") return { ...base, kind: "memory", operation: "remove", targetId };
		return {
			...base,
			kind: "memory",
			operation: "patch",
			targetId,
			oldText: requiredString(raw.oldText, "memory oldText"),
			newText: requiredString(raw.newText, "memory newText"),
		};
	}
	const operation = raw.operation === "create" ? "create" : "update";
	const baseHash = operation === "update" ? requiredString(raw.baseHash, "skill baseHash") : undefined;
	return {
		...base,
		kind: "skill",
		operation,
		name: requiredString(raw.name, "skill name"),
		content: requiredString(raw.content, "skill content"),
		...(baseHash ? { baseHash } : {}),
	};
}

/** Parse and validate the model's visible JSON, rejecting unverifiable evidence and unsupported edits. */
export function parseImprovementResponse(
	response: AssistantMessage,
	actionIds: readonly string[],
	reviewId: string,
	now = Date.now(),
	actions: readonly LearningActionRecord[] = [],
): ImprovementProposal[] {
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Improvement review ${response.stopReason}`);
	}
	const visible = contentText(response.content).trim();
	if (!visible) throw new Error("Improvement review returned no proposal JSON");
	const unfenced = visible.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)?.[1] ?? visible;
	let parsed: unknown;
	try {
		parsed = JSON.parse(unfenced);
	} catch {
		throw new SyntaxError("Improvement review returned invalid proposal JSON");
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) {
		throw new Error("Improvement review must return an object with a proposals array");
	}
	if (parsed.proposals.length > 8) throw new Error("Improvement review returned more than 8 proposals");
	const ids = new Set(actionIds);
	const proposals = parsed.proposals.map((raw) =>
		materializeProposal(parseRawProposal(redactSensitive(raw), ids), reviewId, now, actions),
	);
	return [...new Map(proposals.map((proposal) => [proposal.id, proposal])).values()];
}

async function skillSnapshots(cwd: string): Promise<SkillSnapshot[]> {
	const root = join(cwd, CONFIG_DIR_NAME, "skills");
	const loaded = loadSkillsFromDir({ dir: root, source: "project" });
	const snapshots: SkillSnapshot[] = [];
	for (const skill of loaded.skills) {
		const content = await readFile(skill.filePath, "utf8");
		snapshots.push({ name: skill.name, hash: hashContent(content), content });
	}
	return snapshots.sort((a, b) => a.name.localeCompare(b.name));
}

function compactAction(action: LearningActionRecord, maxChars: number): Record<string, unknown> {
	const serialized = canonicalJson(action);
	if (serialized.length <= maxChars) return action as unknown as Record<string, unknown>;
	return {
		actionId: action.actionId,
		kind: action.kind,
		truncated: true,
		originalChars: serialized.length,
		serializedPrefix: serialized.slice(0, maxChars),
	};
}

function buildReviewState(
	actions: readonly LearningActionRecord[],
	memory: Awaited<ReturnType<ProjectMemoryStore["list"]>>,
	skills: readonly SkillSnapshot[],
	maxChars: number,
): { state: Record<string, unknown>; actions: LearningActionRecord[]; serialized: string } {
	const selected = [...actions];
	const includedMemory = [...memory];
	const includedSkills = [...skills];
	let compactBase = false;
	let actionMaxChars = 24_000;
	const build = () => ({
		task: "Review these project-local agent actions and propose only durable, evidence-backed improvements.",
		promptVersion: IMPROVEMENT_PROMPT_VERSION,
		projectMemory: includedMemory.map((entry) => ({
			...entry,
			content: compactBase ? entry.content.slice(0, 1000) : entry.content,
			...(compactBase && entry.content.length > 1000 ? { contentTruncated: true } : {}),
		})),
		existingSkills: includedSkills.map((skill) => ({
			...skill,
			content: compactBase ? skill.content.slice(0, 1000) : skill.content,
			...(compactBase && skill.content.length > 1000 ? { contentTruncated: true } : {}),
		})),
		...(compactBase && (includedMemory.length !== memory.length || includedSkills.length !== skills.length)
			? {
					omittedBaseEntries: {
						projectMemory: memory.length - includedMemory.length,
						existingSkills: skills.length - includedSkills.length,
					},
				}
			: {}),
		actions: selected.map((action) => compactAction(action, actionMaxChars)),
	});
	let state = build();
	let serialized = canonicalJson(state);
	while (selected.length > 1 && serialized.length > maxChars) {
		selected.pop();
		state = build();
		serialized = canonicalJson(state);
	}
	if (serialized.length > maxChars) {
		compactBase = true;
		actionMaxChars = 1000;
		state = build();
		serialized = canonicalJson(state);
		while (serialized.length > maxChars && (includedSkills.length > 0 || includedMemory.length > 0)) {
			if (includedSkills.length > 0) includedSkills.pop();
			else includedMemory.pop();
			state = build();
			serialized = canonicalJson(state);
		}
	}
	if (selected.length === 0) throw new Error("Cannot build an empty review state");
	if (serialized.length > maxChars) {
		throw new Error(`Review state cannot fit the configured ${maxChars}-character input budget`);
	}
	return { state, actions: selected, serialized };
}

function reviewSystemPrompt(): string {
	return `You review a coding agent's project-local history to improve future work.
Return ONLY JSON: {"proposals":[...]} with at most 8 proposals; return {"proposals":[]} when nothing durable is justified.
Every proposal needs kind, operation, title, rationale, and evidenceActionIds copied exactly from the supplied actions.
Benchmark records are executed project evidence: distinguish PASS/FAIL and comparable definitionHash values; never infer improvement from prose or from different oracles.
Memory operations: add requires content; patch requires targetId, oldText, newText; remove requires targetId. Memory is for concise durable project facts, never a user/global profile.
Skill operations: create or update requires name and complete SKILL.md content with YAML frontmatter name and description. Updates require the exact baseHash supplied in existingSkills. Skills encode reusable procedures, not one-off task diaries.
Do not propose source-code edits, credential changes, global settings, model/provider changes, or automatic application. Do not include secrets or reasoning copied wholesale into memory. Prefer no proposal over speculation.`;
}

function reviewIdFor(model: Model<Api>, serialized: string): string {
	return deterministicId("rev", {
		model: `${model.provider}/${model.id}`,
		promptVersion: IMPROVEMENT_PROMPT_VERSION,
		stateHash: hashContent(serialized),
	});
}

async function runDecider(
	options: RunImprovementReviewOptions,
	actionIds: readonly string[],
	serialized: string,
): Promise<ImprovementDecision> {
	const provider = options.deciderProvider ?? DEFAULT_DECIDER_PROVIDER;
	const modelId = options.deciderModel ?? DEFAULT_DECIDER_MODEL;
	const model = options.runtime.getModelOfType("classifier", provider, modelId);
	if (!model) throw new Error(`Decision model is not configured: ${provider}/${modelId}`);
	const thresholdChars = options.deciderThresholdChars ?? DEFAULT_DECIDER_THRESHOLD_CHARS;
	const state: ClassifierContext["state"] = {
		actionCount: actionIds.length,
		serializedChars: serialized.length,
		actionIds,
		reviewExcerpt: serialized.slice(0, 24_000),
	};
	const questions: ClassifierContext["questions"] = {
		shouldReview: {
			type: "bool",
			instructions:
				"Does this batch contain enough evidence of a durable project lesson to justify a full generative review?",
			criteria: {
				true: "Repeated friction, a verified correction, or a reusable workflow is visible.",
				false: "The batch is routine, insufficient, ephemeral, or already covered by memory and skills.",
			},
		},
		priority: {
			type: "choice",
			instructions: "Which improvement category best fits the visible evidence?",
			criteria: {
				reliability: "Failures, unverified claims, or incorrect recovery",
				efficiency: "Repeated avoidable work or tool calls",
				workflow: "Reusable project procedure or convention",
				none: "No durable improvement is supported",
			},
		},
	};
	const result = await options.runtime.classify(model, { state, questions });
	const shouldReview = result.answers.shouldReview;
	const error =
		result.stopReason !== "stop"
			? result.errorMessage || "Decision model request failed"
			: !shouldReview || shouldReview.type !== "bool"
				? "Decision model returned no shouldReview probability"
				: undefined;
	const priority = result.answers.priority;
	return {
		provider,
		model: modelId,
		probability: shouldReview?.type === "bool" ? shouldReview.probability : 0,
		...(priority?.type === "choice" ? { priority: priority.choice } : {}),
		thresholdChars,
		stateChars: serialized.length,
		result,
		...(error ? { error } : {}),
	};
}

async function prepareReviewBatch(options: ReviewBatchOptions) {
	const store = ProjectActionStore.open(options.cwd);
	const allActions = await store.list();
	const cursor = await readJsonFile<ReviewCursor>(getLearningPaths(options.cwd).cursor);
	let start = 0;
	if (cursor) {
		const index = allActions.findIndex((action) => action.actionId === cursor.lastActionId);
		if (index === -1)
			throw new Error("Review cursor no longer exists in actions.jsonl; repair or reset it explicitly");
		start = index + 1;
	}
	const pending = allActions.slice(start);
	if (pending.length === 0) return undefined;
	const maxBatchActions = Math.max(1, options.maxBatchActions ?? DEFAULT_REVIEW_BATCH_ACTIONS);
	const maxChars = Math.max(4000, (options.maxInputTokens ?? DEFAULT_REVIEW_MAX_INPUT_TOKENS) * 3);
	const memoryStore = await ProjectMemoryStore.open(options.cwd, { allowOverBudget: true });
	const [memory, skills] = await Promise.all([memoryStore.list(), skillSnapshots(options.cwd)]);
	const batch = buildReviewState(pending.slice(0, maxBatchActions), memory, skills, maxChars);
	return { batch, actionIds: batch.actions.map((action) => action.actionId) };
}

async function withReviewLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
	await ensureLearningLayout(cwd);
	return withFileLock(
		join(getLearningPaths(cwd).root, "review.lock"),
		operation,
		"Another improvement review is already running for this project",
	);
}

export async function runImprovementReview(options: RunImprovementReviewOptions): Promise<ImprovementReviewResult> {
	return withReviewLock(options.cwd, () => runImprovementReviewUnlocked(options));
}

async function runImprovementReviewUnlocked(options: RunImprovementReviewOptions): Promise<ImprovementReviewResult> {
	const prepared = await prepareReviewBatch(options);
	if (!prepared) return { status: "empty", actionCount: 0 };
	const { batch, actionIds } = prepared;
	const history = await listImprovementHistory(options.cwd);
	const stateHash = hashContent(batch.serialized);
	let decision: ImprovementDecision | undefined;
	const threshold = options.deciderThresholdChars ?? DEFAULT_DECIDER_THRESHOLD_CHARS;
	if (options.useDecider && batch.serialized.length > threshold) {
		const provider = options.deciderProvider ?? DEFAULT_DECIDER_PROVIDER;
		const model = options.deciderModel ?? DEFAULT_DECIDER_MODEL;
		const minProbability = options.deciderMinProbability ?? DEFAULT_DECIDER_MIN_PROBABILITY;
		const decisionReviewId = deterministicId("dec", {
			provider,
			model,
			promptVersion: IMPROVEMENT_PROMPT_VERSION,
			stateHash,
			thresholdChars: threshold,
			minProbability,
		});
		const priorDecision = history.find(
			(record): record is ImprovementDecisionRecord =>
				record.type === "decision" && record.reviewId === decisionReviewId && !record.decision.error,
		);
		decision = priorDecision?.decision ?? (await runDecider(options, actionIds, batch.serialized));
		if (!priorDecision) {
			await appendHistory(options.cwd, {
				type: "decision",
				reviewId: decisionReviewId,
				createdAt: Date.now(),
				actionIds,
				decision,
			});
		}
		if (decision.error) throw new Error(decision.error);
		if (!options.deciderShadow && decision.probability < minProbability) {
			await atomicWrite(
				getLearningPaths(options.cwd).cursor,
				`${canonicalJson({ lastActionId: actionIds.at(-1), updatedAt: Date.now() })}\n`,
			);
			return { status: "gated", reviewId: decisionReviewId, actionCount: actionIds.length, decision };
		}
	}
	const reviewId = reviewIdFor(options.model, batch.serialized);
	const prior = history.find(
		(record): record is ImprovementReview =>
			record.type === "review" && record.reviewId === reviewId && !record.error,
	);
	const proposalStore = await ImprovementProposalStore.open(options.cwd);
	if (prior) {
		await atomicWrite(
			getLearningPaths(options.cwd).cursor,
			`${canonicalJson({ lastActionId: actionIds.at(-1), updatedAt: Date.now() })}\n`,
		);
		return {
			status: "cached",
			reviewId,
			actionCount: actionIds.length,
			proposals: await proposalStore.forReview(reviewId),
		};
	}
	const response = await options.runtime.complete(
		options.model,
		{
			systemPrompt: reviewSystemPrompt(),
			messages: [{ role: "user", content: batch.serialized, timestamp: Date.now() }],
		},
		{ maxTokens: Math.min(options.model.maxTokens, 16_384) },
	);
	const recordedResponse = redactSensitive(response) as AssistantMessage;
	let proposals: ImprovementProposal[];
	try {
		proposals = parseImprovementResponse(response, actionIds, reviewId, Date.now(), batch.actions);
	} catch (error) {
		await appendHistory(options.cwd, {
			type: "review",
			reviewId,
			createdAt: Date.now(),
			actionIds,
			provider: options.model.provider,
			model: options.model.id,
			response: recordedResponse,
			proposalIds: [],
			error: error instanceof Error ? error.message : String(error),
			...(decision ? { decision } : {}),
		});
		throw error;
	}
	await proposalStore.add(proposals);
	await appendHistory(options.cwd, {
		type: "review",
		reviewId,
		createdAt: Date.now(),
		actionIds,
		provider: options.model.provider,
		model: options.model.id,
		response: recordedResponse,
		proposalIds: proposals.map((proposal) => proposal.id),
		...(decision ? { decision } : {}),
	});
	await atomicWrite(
		getLearningPaths(options.cwd).cursor,
		`${canonicalJson({ lastActionId: actionIds.at(-1), updatedAt: Date.now() })}\n`,
	);
	return { status: "created", reviewId, actionCount: actionIds.length, proposals };
}

/** Advance past exactly the next deterministic batch without calling a model. */
export async function skipImprovementBatch(
	options: ReviewBatchOptions,
): Promise<{ actionCount: number; lastActionId?: string }> {
	return withReviewLock(options.cwd, async () => {
		const prepared = await prepareReviewBatch(options);
		if (!prepared) return { actionCount: 0 };
		const lastActionId = prepared.actionIds.at(-1);
		await atomicWrite(
			getLearningPaths(options.cwd).cursor,
			`${canonicalJson({ lastActionId, updatedAt: Date.now() })}\n`,
		);
		return { actionCount: prepared.actionIds.length, ...(lastActionId ? { lastActionId } : {}) };
	});
}

/** Remove only the review cursor; actions, history, and proposals remain intact. */
export async function resetImprovementCursor(cwd: string): Promise<boolean> {
	return withReviewLock(cwd, async () => {
		try {
			await rm(getLearningPaths(cwd).cursor);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	});
}

function validateSkillProposal(proposal: SkillProposal): void {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposal.name) || proposal.name.length > 64) {
		throw new Error(`Invalid skill name: ${proposal.name}`);
	}
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(proposal.content);
	if (frontmatter.name !== proposal.name) throw new Error("SKILL.md frontmatter name must match the proposal name");
	if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
		throw new Error("SKILL.md requires a non-empty frontmatter description");
	}
}

export class ImprovementProposalStore {
	readonly cwd: string;
	readonly path: string;
	private proposals: ImprovementProposal[];
	private queue: Promise<void> = Promise.resolve();

	private constructor(cwd: string, path: string, proposals: ImprovementProposal[]) {
		this.cwd = cwd;
		this.path = path;
		this.proposals = proposals;
	}

	static async open(cwd: string): Promise<ImprovementProposalStore> {
		const path = getLearningPaths(cwd).proposals;
		return new ImprovementProposalStore(cwd, path, (await readJsonFile<ImprovementProposal[]>(path)) ?? []);
	}

	list(): ImprovementProposal[] {
		return structuredClone(this.proposals);
	}

	forReview(reviewId: string): ImprovementProposal[] {
		return this.list().filter((proposal) => proposal.reviewId === reviewId);
	}

	get(idOrPrefix: string): ImprovementProposal {
		const matches = this.proposals.filter(
			(proposal) => proposal.id === idOrPrefix || proposal.id.startsWith(idOrPrefix),
		);
		if (matches.length !== 1)
			throw new Error(matches.length ? "Proposal ID prefix is ambiguous" : "Proposal not found");
		return structuredClone(matches[0]);
	}

	private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
		const run = this.queue.then(() =>
			withFileLock(
				join(getLearningPaths(this.cwd).root, "proposals.lock"),
				async () => {
					await ensureLearningLayout(this.cwd);
					this.proposals = (await readJsonFile<ImprovementProposal[]>(this.path)) ?? [];
					const result = await operation();
					await atomicWrite(this.path, `${JSON.stringify(this.proposals, null, 2)}\n`);
					return result;
				},
				"Another improvement proposal mutation is already running",
				{ wait: true },
			),
		);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	add(proposals: readonly ImprovementProposal[]): Promise<void> {
		return this.mutate(() => {
			const byId = new Map(this.proposals.map((proposal) => [proposal.id, proposal]));
			for (const proposal of proposals) if (!byId.has(proposal.id)) this.proposals.push(structuredClone(proposal));
		});
	}

	async reject(idOrPrefix: string): Promise<ImprovementProposal> {
		if (!existsSync(this.path)) this.get(idOrPrefix);
		return this.mutate(() => {
			const target = this.get(idOrPrefix);
			if (target.status !== "pending") throw new Error(`Proposal is ${target.status}, not pending`);
			target.status = "rejected";
			target.updatedAt = Date.now();
			this.proposals = this.proposals.map((proposal) => (proposal.id === target.id ? target : proposal));
			return target;
		});
	}

	async approve(idOrPrefix: string): Promise<ImprovementProposal> {
		if (!existsSync(this.path)) this.get(idOrPrefix);
		return this.mutate(async () => {
			const target = this.get(idOrPrefix);
			if (target.status !== "pending") throw new Error(`Proposal is ${target.status}, not pending`);
			const memory = await ProjectMemoryStore.open(this.cwd);
			if (target.kind === "memory") {
				if (target.operation === "add") await memory.add(target.content, "review");
				else if (target.operation === "patch") await memory.patch(target.targetId, target.oldText, target.newText);
				else await memory.remove(target.targetId);
			} else {
				validateSkillProposal(target);
				const path = join(this.cwd, CONFIG_DIR_NAME, "skills", target.name, "SKILL.md");
				const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				});
				if (target.operation === "create" && current !== undefined)
					throw new Error("Skill already exists; propose an update");
				if (target.operation === "update") {
					if (current === undefined) throw new Error("Skill no longer exists");
					if (!target.baseHash || hashContent(current) !== target.baseHash) {
						throw new Error("Skill changed after review; reject this proposal and review again");
					}
				}
				await atomicWrite(path, target.content.endsWith("\n") ? target.content : `${target.content}\n`);
			}
			target.status = "applied";
			target.updatedAt = Date.now();
			this.proposals = this.proposals.map((proposal) => (proposal.id === target.id ? target : proposal));
			return target;
		});
	}
}

/** Create a reviewable memory proposal from the foreground project_memory tool. */
export async function stageMemoryProposal(
	cwd: string,
	input: {
		operation: "add" | "patch" | "remove";
		content?: string;
		targetId?: string;
		oldText?: string;
		newText?: string;
	},
): Promise<ImprovementProposal> {
	const action = createMessageAction(cwd, "project-memory-tool", {
		role: "user",
		content: canonicalJson(input),
		timestamp: 0,
	} as AgentMessage);
	const raw = parseRawProposal(
		redactSensitive({
			kind: "memory",
			...input,
			title: `${input.operation} project memory`,
			rationale: "Explicit foreground project_memory tool request",
			evidenceActionIds: [action.actionId],
		}),
		new Set([action.actionId]),
	);
	const proposal = materializeProposal(raw, deterministicId("memreview", input), Date.now(), [action]);
	const actions = ProjectActionStore.open(cwd);
	await actions.append(action);
	const store = await ImprovementProposalStore.open(cwd);
	await store.add([proposal]);
	return proposal;
}
