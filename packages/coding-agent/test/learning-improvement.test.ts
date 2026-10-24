import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	createBenchmarkAction,
	createMessageAction,
	getLearningPaths,
	type LearningActionRecord,
	ProjectActionStore,
} from "../src/core/learning/action-store.ts";
import {
	DEFAULT_DECIDER_MODEL,
	DEFAULT_DECIDER_PROVIDER,
	type ImprovementDecisionRecord,
	ImprovementProposalStore,
	type ImprovementReview,
	type ImprovementRuntime,
	listImprovementHistory,
	parseImprovementResponse,
	type RunImprovementReviewOptions,
	resetImprovementCursor,
	runImprovementReview,
	skipImprovementBatch,
	stageMemoryProposal,
} from "../src/core/learning/improvement.ts";
import { ProjectMemoryStore } from "../src/core/learning/memory-store.ts";

// Fixed clock so review/proposal timestamps are deterministic.
const FIXED_DATE = new Date("2026-02-03T04:05:06.000Z");
const FIXED_MS = FIXED_DATE.getTime();

const REVIEW_MODEL: Model<Api> = {
	id: "faux-ling-3.1",
	name: "Faux Ling",
	api: "openai-completions",
	provider: "faux-provider",
	baseUrl: "http://127.0.0.1:0/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

function fauxClassifierModel(): ClassifierModel<ClassifierApi> {
	return {
		id: DEFAULT_DECIDER_MODEL,
		name: "Faux Decider",
		api: "typesafe-system-one",
		provider: DEFAULT_DECIDER_PROVIDER,
		baseUrl: "http://127.0.0.1:0",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		type: "classifier",
		contextWindow: 128_000,
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: REVIEW_MODEL.api,
		provider: REVIEW_MODEL.provider,
		model: REVIEW_MODEL.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		timestamp: FIXED_MS,
	};
}

/** A review response: optional reasoning block followed by the visible proposal JSON. */
function reviewResponse(proposals: unknown[], thinking?: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking !== undefined) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text: JSON.stringify({ proposals }) });
	return assistantMessage(content);
}

function classifierResult(probability: number, priority = "workflow"): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: DEFAULT_DECIDER_PROVIDER,
		model: DEFAULT_DECIDER_MODEL,
		answers: {
			shouldReview: { type: "bool", probability },
			priority: { type: "choice", choice: priority, probabilities: { [priority]: 1 }, confidence: 0.9 },
		},
		stopReason: "stop",
		timestamp: FIXED_MS,
	};
}

function classifierError(errorMessage: string): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: DEFAULT_DECIDER_PROVIDER,
		model: DEFAULT_DECIDER_MODEL,
		answers: {},
		stopReason: "error",
		errorMessage,
		timestamp: FIXED_MS,
	};
}

interface CompleteCall {
	model: Model<Api>;
	context: Context;
	options?: { maxTokens?: number };
}

interface ClassifyCall {
	model: ClassifierModel<ClassifierApi>;
	context: ClassifierContext;
}

/** Entirely local ImprovementRuntime: counts calls and delegates to swappable handlers. */
interface FauxRuntime {
	runtime: ImprovementRuntime;
	completeCalls: CompleteCall[];
	classifyCalls: ClassifyCall[];
	classifierLookups: { provider: string; modelId: string }[];
	classifierModel: ClassifierModel<ClassifierApi> | undefined;
	onComplete: (call: CompleteCall, index: number) => AssistantMessage | Promise<AssistantMessage>;
	onClassify: (call: ClassifyCall, index: number) => ClassifierResult;
}

function createFauxRuntime(): FauxRuntime {
	const completeCalls: CompleteCall[] = [];
	const classifyCalls: ClassifyCall[] = [];
	const classifierLookups: { provider: string; modelId: string }[] = [];
	const faux: FauxRuntime = {
		runtime: {
			complete: (model, context, options) => {
				const call: CompleteCall = { model, context, ...(options ? { options } : {}) };
				completeCalls.push(call);
				return Promise.resolve(faux.onComplete(call, completeCalls.length - 1));
			},
			classify: (model, context) => {
				const call: ClassifyCall = { model, context };
				classifyCalls.push(call);
				return Promise.resolve(faux.onClassify(call, classifyCalls.length - 1));
			},
			getModelOfType: (_type, provider, modelId) => {
				classifierLookups.push({ provider, modelId });
				return faux.classifierModel;
			},
		},
		completeCalls,
		classifyCalls,
		classifierLookups,
		classifierModel: fauxClassifierModel(),
		onComplete: () => reviewResponse([]),
		onClassify: () => classifierResult(0.9),
	};
	return faux;
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

async function seedActions(cwd: string, texts: string[]): Promise<LearningActionRecord[]> {
	const store = ProjectActionStore.open(cwd);
	const records = texts.map((text, index) => createMessageAction(cwd, "session-1", userMessage(text, index + 1)));
	for (const record of records) await store.append(record);
	await store.flush();
	return records;
}

function runReview(cwd: string, faux: FauxRuntime, overrides: Partial<RunImprovementReviewOptions> = {}) {
	return runImprovementReview({ cwd, runtime: faux.runtime, model: REVIEW_MODEL, ...overrides });
}

function readCursor(cwd: string): { lastActionId: string; updatedAt: number } {
	return JSON.parse(readFileSync(getLearningPaths(cwd).cursor, "utf8")) as { lastActionId: string; updatedAt: number };
}

async function reviewRecords(cwd: string): Promise<ImprovementReview[]> {
	return (await listImprovementHistory(cwd)).filter((record): record is ImprovementReview => record.type === "review");
}

async function decisionRecords(cwd: string): Promise<ImprovementDecisionRecord[]> {
	return (await listImprovementHistory(cwd)).filter(
		(record): record is ImprovementDecisionRecord => record.type === "decision",
	);
}

function memoryAddProposal(evidenceActionIds: string[], content: string): Record<string, unknown> {
	return {
		kind: "memory",
		operation: "add",
		title: "Add project memory",
		rationale: "Durable, evidence-backed project fact",
		evidenceActionIds,
		content,
	};
}

function skillMarkdown(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

describe("learning improvement", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-learning-improvement-"));
		vi.useFakeTimers({ now: FIXED_DATE, toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("runImprovementReview", () => {
		test("empty ledger makes no runtime calls and writes nothing", async () => {
			const faux = createFauxRuntime();
			const result = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });

			expect(result).toEqual({ status: "empty", actionCount: 0 });
			expect(faux.completeCalls).toHaveLength(0);
			expect(faux.classifyCalls).toHaveLength(0);
			expect(faux.classifierLookups).toHaveLength(0);
			expect(await listImprovementHistory(tempDir)).toEqual([]);
			expect(existsSync(getLearningPaths(tempDir).reviews)).toBe(false);
			expect(existsSync(getLearningPaths(tempDir).cursor)).toBe(false);
		});

		test("persists the review with response reasoning in reviews.jsonl", async () => {
			const records = await seedActions(tempDir, ["the build flakes on CI", "pin the toolchain version"]);
			const thinking = 'Line one of reasoning.\nLine two with "quotes" and an API key mention.';
			const faux = createFauxRuntime();
			const response = reviewResponse(
				[memoryAddProposal([records[0].actionId], "CI build flakes unless the toolchain is pinned")],
				thinking,
			);
			faux.onComplete = () => response;

			const result = await runReview(tempDir, faux);
			expect(result.status).toBe("created");
			if (result.status !== "created") return;
			expect(result.actionCount).toBe(2);
			expect(result.proposals).toHaveLength(1);
			expect(result.proposals[0].kind).toBe("memory");
			expect(result.proposals[0].status).toBe("pending");
			expect(result.proposals[0].createdAt).toBe(FIXED_MS);
			expect(result.proposals[0].updatedAt).toBe(FIXED_MS);

			// Raw JSONL on disk: one canonical-JSON line holding the full response, reasoning included.
			const raw = readFileSync(getLearningPaths(tempDir).reviews, "utf8");
			const lines = raw.trim().split("\n");
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0]) as ImprovementReview;
			expect(record.type).toBe("review");
			expect(record.reviewId).toBe(result.reviewId);
			expect(record.createdAt).toBe(FIXED_MS);
			expect(record.provider).toBe(REVIEW_MODEL.provider);
			expect(record.model).toBe(REVIEW_MODEL.id);
			expect(record.actionIds).toEqual(records.map((action) => action.actionId));
			expect(record.proposalIds).toEqual(result.proposals.map((proposal) => proposal.id));
			expect(record.error).toBeUndefined();
			const thinkingBlock = record.response.content.find((part) => part.type === "thinking");
			expect(thinkingBlock).toEqual({ type: "thinking", thinking });
			// The visible text carries the proposal JSON.
			const textBlock = record.response.content.find((part) => part.type === "text");
			expect(textBlock && textBlock.type === "text" ? JSON.parse(textBlock.text) : undefined).toEqual({
				proposals: [memoryAddProposal([records[0].actionId], "CI build flakes unless the toolchain is pinned")],
			});
			expect(record.response).toEqual(response);

			const viaApi = await reviewRecords(tempDir);
			expect(viaApi).toHaveLength(1);
			expect(viaApi[0].response).toEqual(response);
		});

		test("rejects proposals citing evidence outside the batch and retains the failed response", async () => {
			const records = await seedActions(tempDir, ["first action", "second action"]);
			const faux = createFauxRuntime();
			// Batch is capped at one action, so records[1] is in the ledger but outside this review.
			faux.onComplete = () => reviewResponse([memoryAddProposal([records[1].actionId], "out of batch evidence")]);

			await expect(runReview(tempDir, faux, { maxBatchActions: 1 })).rejects.toThrow(
				`Proposal cites action outside this review: ${records[1].actionId}`,
			);

			// The failed response is appended to reviews.jsonl with the error; the cursor is not advanced.
			const history = await reviewRecords(tempDir);
			expect(history).toHaveLength(1);
			expect(history[0].error).toBe(`Proposal cites action outside this review: ${records[1].actionId}`);
			expect(history[0].proposalIds).toEqual([]);
			// The rejected response itself is retained for diagnosis.
			const retainedText = history[0].response.content.find((part) => part.type === "text");
			expect(retainedText && retainedText.type === "text" ? JSON.parse(retainedText.text) : undefined).toEqual({
				proposals: [memoryAddProposal([records[1].actionId], "out of batch evidence")],
			});
			expect(existsSync(getLearningPaths(tempDir).cursor)).toBe(false);
			expect((await ImprovementProposalStore.open(tempDir)).list()).toEqual([]);
		});

		test("benchmark runs are reviewable evidence with deterministic run IDs", async () => {
			const benchmark = createBenchmarkAction(tempDir, {
				benchmarkId: "bench_0123456789abcdef0123456789abcdef",
				benchmarkName: "parser-regression",
				definitionHash: "a".repeat(64),
				command: process.execPath,
				args: ["test.js"],
				cwd: tempDir,
				startedAt: 10,
				durationMs: 25,
				exitCode: 1,
				timedOut: false,
				stdout: "expected parser output",
				stderr: "",
				passed: false,
				checks: [{ name: "exitCode", expected: 0, passed: false }],
			});
			await ProjectActionStore.open(tempDir).append(benchmark);
			const faux = createFauxRuntime();
			faux.onComplete = () =>
				reviewResponse([memoryAddProposal([benchmark.actionId], "Parser benchmark needs investigation")]);

			const result = await runReview(tempDir, faux);
			expect(result.status).toBe("created");
			if (result.status !== "created") return;
			expect(result.actionCount).toBe(1);
			expect(batchPayload(faux.completeCalls[0])).toContain(benchmark.actionId);
			expect(batchPayload(faux.completeCalls[0])).toContain("parser-regression");
			expect(result.proposals[0].evidenceActionIds).toEqual([benchmark.actionId]);
			expect(result.proposals[0].evidence).toEqual([{ actionId: benchmark.actionId, evidenceClass: "executed" }]);
		});

		test("review budget also bounds oversized project memory and skill snapshots", async () => {
			const records = await seedActions(tempDir, ["evidence for a reusable project lesson"]);
			const memory = await ProjectMemoryStore.open(tempDir, { limit: 200_001 });
			await memory.add("m".repeat(200_000));
			const skillDir = join(tempDir, CONFIG_DIR_NAME, "skills", "oversized-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillContent = skillMarkdown("oversized-skill", "Oversized fixture", "s".repeat(200_000));
			writeFileSync(join(skillDir, "SKILL.md"), skillContent);
			const faux = createFauxRuntime();
			faux.onComplete = () => reviewResponse([memoryAddProposal([records[0].actionId], "bounded review")]);

			const result = await runReview(tempDir, faux, { maxInputTokens: 4000 });
			expect(result.status).toBe("created");
			expect(faux.completeCalls).toHaveLength(1);
			const payload = batchPayload(faux.completeCalls[0]);
			expect(payload.length).toBeLessThanOrEqual(12_000);
			const state = JSON.parse(payload) as {
				actions: Array<{ actionId: string }>;
				existingSkills: Array<{ hash: string; content: string }>;
			};
			expect(state.actions.map((action) => action.actionId)).toContain(records[0].actionId);
			if (state.existingSkills.length > 0) {
				expect(state.existingSkills[0].hash).toBe(sha256Hex(skillContent));
				expect(state.existingSkills[0].content.length).toBeLessThan(skillContent.length);
			}
		});

		test("concurrent reviews for one project are mutually exclusive", async () => {
			await seedActions(tempDir, ["evidence"]);
			const faux = createFauxRuntime();
			let start!: () => void;
			let release!: () => void;
			const started = new Promise<void>((resolve) => {
				start = resolve;
			});
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			faux.onComplete = async () => {
				start();
				await blocked;
				return reviewResponse([]);
			};

			const first = runReview(tempDir, faux);
			await started;
			await expect(runReview(tempDir, faux)).rejects.toThrow(/already running/);
			release();
			expect((await first).status).toBe("created");
			expect(faux.completeCalls).toHaveLength(1);
			expect(existsSync(join(getLearningPaths(tempDir).root, "review.lock"))).toBe(false);
		});

		test("a lock left by a dead process is recovered automatically", async () => {
			const records = await seedActions(tempDir, ["evidence after a crashed review"]);
			const lockPath = join(getLearningPaths(tempDir).root, "review.lock");
			writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, hostname: hostname(), createdAt: 1 }));

			const skipped = await skipImprovementBatch({ cwd: tempDir });
			expect(skipped).toEqual({ actionCount: 1, lastActionId: records[0].actionId });
			expect(existsSync(lockPath)).toBe(false);
		});

		test("an explicit skip advances past a poison batch and reset permits cached reprocessing", async () => {
			const records = await seedActions(tempDir, ["malformed batch", "newer evidence"]);
			const skipped = await skipImprovementBatch({ cwd: tempDir, maxBatchActions: 1 });
			expect(skipped).toEqual({ actionCount: 1, lastActionId: records[0].actionId });
			expect(readCursor(tempDir).lastActionId).toBe(records[0].actionId);

			const faux = createFauxRuntime();
			const result = await runReview(tempDir, faux, { maxBatchActions: 1 });
			expect(result.status).toBe("created");
			expect(batchPayload(faux.completeCalls[0])).toContain("newer evidence");
			expect(batchPayload(faux.completeCalls[0])).not.toContain("malformed batch");

			expect(await resetImprovementCursor(tempDir)).toBe(true);
			expect(existsSync(getLearningPaths(tempDir).cursor)).toBe(false);
			expect(await resetImprovementCursor(tempDir)).toBe(false);
		});

		test("cursor advances batch by batch until the ledger is drained", async () => {
			const records = await seedActions(tempDir, ["first", "second", "third"]);
			const faux = createFauxRuntime();

			const first = await runReview(tempDir, faux, { maxBatchActions: 2 });
			expect(first).toMatchObject({ status: "created", actionCount: 2 });
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[1].actionId, updatedAt: FIXED_MS });
			expect(faux.completeCalls).toHaveLength(1);

			const second = await runReview(tempDir, faux, { maxBatchActions: 2 });
			expect(second).toMatchObject({ status: "created", actionCount: 1 });
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[2].actionId, updatedAt: FIXED_MS });
			expect(faux.completeCalls).toHaveLength(2);

			// The second batch contains only the not-yet-reviewed action.
			const secondPayload = batchPayload(faux.completeCalls[1]);
			expect(secondPayload).toContain("third");
			expect(secondPayload).not.toContain('"first"');

			const third = await runReview(tempDir, faux, { maxBatchActions: 2 });
			expect(third).toEqual({ status: "empty", actionCount: 0 });
			expect(faux.completeCalls).toHaveLength(2);
		});

		test("identical review reuses the cached result without a complete call", async () => {
			const records = await seedActions(tempDir, ["repeatable evidence"]);
			const faux = createFauxRuntime();
			faux.onComplete = () => reviewResponse([memoryAddProposal([records[0].actionId], "cache me")]);

			const first = await runReview(tempDir, faux);
			expect(first.status).toBe("created");
			expect(faux.completeCalls).toHaveLength(1);

			// Reset the cursor so the exact same state is reviewed again.
			rmSync(getLearningPaths(tempDir).cursor);

			const second = await runReview(tempDir, faux);
			expect(second.status).toBe("cached");
			if (first.status !== "created" || second.status !== "cached") return;
			expect(second.reviewId).toBe(first.reviewId);
			expect(second.actionCount).toBe(first.actionCount);
			expect(second.proposals).toEqual(first.proposals);
			expect(faux.completeCalls).toHaveLength(1);
			expect(faux.classifyCalls).toHaveLength(0);
			// The cached path still re-advances the cursor.
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[0].actionId, updatedAt: FIXED_MS });
			// No second review record was appended.
			expect(await reviewRecords(tempDir)).toHaveLength(1);
		});

		test("invalid response reasoning is retained in reviews.jsonl and a retry succeeds", async () => {
			const records = await seedActions(tempDir, ["evidence for a durable lesson"]);
			const faux = createFauxRuntime();
			const thinking = "The model reasoned here but produced malformed JSON.";
			faux.onComplete = (_call, index) =>
				index === 0
					? assistantMessage([
							{ type: "thinking", thinking },
							{ type: "text", text: "this is not json" },
						])
					: reviewResponse([memoryAddProposal([records[0].actionId], "recovered on retry")]);

			await expect(runReview(tempDir, faux)).rejects.toThrow(SyntaxError);

			// Failed attempt: full response (with reasoning) persisted alongside the error, no cursor, no proposals.
			let history = await reviewRecords(tempDir);
			expect(history).toHaveLength(1);
			expect(history[0].error).toBeTruthy();
			expect(history[0].proposalIds).toEqual([]);
			expect(history[0].response.content).toContainEqual({ type: "thinking", thinking });
			expect(history[0].response.content).toContainEqual({ type: "text", text: "this is not json" });
			expect(existsSync(getLearningPaths(tempDir).cursor)).toBe(false);
			expect((await ImprovementProposalStore.open(tempDir)).list()).toEqual([]);

			// Retry: the error record does not count as a prior review, so complete runs again.
			const retry = await runReview(tempDir, faux);
			expect(retry.status).toBe("created");
			if (retry.status !== "created") return;
			expect(faux.completeCalls).toHaveLength(2);
			expect(retry.reviewId).toBe(history[0].reviewId);
			expect(retry.proposals).toHaveLength(1);

			history = await reviewRecords(tempDir);
			expect(history).toHaveLength(2);
			expect(history[0].error).toBeTruthy();
			expect(history[1].error).toBeUndefined();
			expect(history[1].reviewId).toBe(retry.reviewId);
			expect(history[1].proposalIds).toEqual(retry.proposals.map((proposal) => proposal.id));
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[0].actionId, updatedAt: FIXED_MS });
			expect((await ImprovementProposalStore.open(tempDir)).list()).toHaveLength(1);
		});
	});

	function batchPayload(call: CompleteCall): string {
		const message = call.context.messages[0];
		return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
	}

	describe("runImprovementReview decider", () => {
		test("decider is not called when the batch is below the char threshold", async () => {
			const records = await seedActions(tempDir, ["small batch"]);
			const faux = createFauxRuntime();
			faux.onComplete = () =>
				reviewResponse([memoryAddProposal([records[0].actionId], "below threshold still reviews")]);

			const result = await runReview(tempDir, faux, {
				useDecider: true,
				deciderThresholdChars: Number.MAX_SAFE_INTEGER,
			});

			expect(result.status).toBe("created");
			expect(faux.classifyCalls).toHaveLength(0);
			expect(faux.classifierLookups).toHaveLength(0);
			expect(faux.completeCalls).toHaveLength(1);

			const history = await listImprovementHistory(tempDir);
			expect(history).toHaveLength(1);
			expect(history[0].type).toBe("review");
			expect("decision" in history[0]).toBe(false);
		});

		test("low probability gates the review, advances the cursor, and newer actions still flow", async () => {
			const records = await seedActions(tempDir, ["routine batch", "nothing durable"]);
			const faux = createFauxRuntime();
			faux.onClassify = () => classifierResult(0.2, "none");

			const first = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(first.status).toBe("gated");
			if (first.status !== "gated") return;
			expect(first.reviewId).toMatch(/^dec_[0-9a-f]{32}$/);
			expect(first.actionCount).toBe(2);
			expect(first.decision.probability).toBe(0.2);
			expect(first.decision.priority).toBe("none");
			expect(first.decision.provider).toBe(DEFAULT_DECIDER_PROVIDER);
			expect(first.decision.model).toBe(DEFAULT_DECIDER_MODEL);
			expect(first.decision.thresholdChars).toBe(1);
			expect(first.decision.stateChars).toBeGreaterThan(1);
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(0);
			expect(faux.classifierLookups).toEqual([
				{ provider: DEFAULT_DECIDER_PROVIDER, modelId: DEFAULT_DECIDER_MODEL },
			]);

			// The gate persisted a decision record; the generative model was never called.
			expect(await decisionRecords(tempDir)).toHaveLength(1);
			expect(await reviewRecords(tempDir)).toHaveLength(0);
			// A gated batch advances the cursor so a full gated batch cannot starve newer actions.
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[1].actionId, updatedAt: FIXED_MS });
			// The decider saw the batch evidence and the gating questions.
			const classifyContext = faux.classifyCalls[0].context;
			const state = classifyContext.state as Record<string, unknown>;
			expect(state.actionIds).toEqual(records.map((action) => action.actionId));
			expect(state.actionCount).toBe(2);
			expect(typeof state.reviewExcerpt).toBe("string");
			expect(Object.keys(classifyContext.questions).sort()).toEqual(["priority", "shouldReview"]);

			// Immediate rerun: nothing pending, so no model is called at all.
			const second = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(second).toEqual({ status: "empty", actionCount: 0 });
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(0);
			expect(await listImprovementHistory(tempDir)).toHaveLength(1);

			// After a new action lands, the next run processes just that action; a high
			// decider probability then lets the review proceed.
			const appended = await seedActions(tempDir, ["a verified correction appears"]);
			faux.onClassify = () => classifierResult(0.9, "workflow");
			faux.onComplete = () => reviewResponse([]);
			const third = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(third.status).toBe("created");
			expect(third.actionCount).toBe(1);
			expect(faux.classifyCalls).toHaveLength(2);
			expect(faux.completeCalls).toHaveLength(1);
			expect(batchPayload(faux.completeCalls[0])).toContain("a verified correction appears");
			expect(batchPayload(faux.completeCalls[0])).not.toContain("routine batch");
			expect(await decisionRecords(tempDir)).toHaveLength(2);
			expect(await reviewRecords(tempDir)).toHaveLength(1);
			expect(readCursor(tempDir)).toEqual({ lastActionId: appended[0].actionId, updatedAt: FIXED_MS });
		});

		test("shadow mode records a low gate probability but still reviews", async () => {
			const records = await seedActions(tempDir, ["calibration batch"]);
			const faux = createFauxRuntime();
			faux.onClassify = () => classifierResult(0.1, "none");
			const result = await runReview(tempDir, faux, {
				useDecider: true,
				deciderThresholdChars: 1,
				deciderShadow: true,
			});
			expect(result.status).toBe("created");
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(1);
			expect(await decisionRecords(tempDir)).toHaveLength(1);
			expect(readCursor(tempDir).lastActionId).toBe(records[0].actionId);

			rmSync(getLearningPaths(tempDir).cursor);
			const enforced = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(enforced.status).toBe("gated");
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(1);
		});

		test("decider cache identity includes character and probability thresholds", async () => {
			await seedActions(tempDir, ["threshold-sensitive batch"]);
			const faux = createFauxRuntime();
			faux.onClassify = () => classifierResult(0.6, "workflow");
			const first = await runReview(tempDir, faux, {
				useDecider: true,
				deciderThresholdChars: 1,
				deciderMinProbability: 0.55,
			});
			expect(first.status).toBe("created");
			const firstDecisionId = (await decisionRecords(tempDir))[0].reviewId;
			rmSync(getLearningPaths(tempDir).cursor);
			const second = await runReview(tempDir, faux, {
				useDecider: true,
				deciderThresholdChars: 2,
				deciderMinProbability: 0.7,
			});
			expect(second.status).toBe("gated");
			expect(faux.classifyCalls).toHaveLength(2);
			if (second.status !== "gated") return;
			const decisions = await decisionRecords(tempDir);
			expect(decisions).toHaveLength(2);
			expect(decisions[1].reviewId).not.toBe(firstDecisionId);
			expect(second.decision.thresholdChars).toBe(2);
		});

		test("gated decision is content-cached so a cursor reset does not re-call classify", async () => {
			const records = await seedActions(tempDir, ["routine batch"]);
			const faux = createFauxRuntime();
			faux.onClassify = () => classifierResult(0.2, "none");

			const first = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(first.status).toBe("gated");
			expect(faux.classifyCalls).toHaveLength(1);

			// Simulate crash/reset recovery: the cursor is lost but the decision record survives.
			rmSync(getLearningPaths(tempDir).cursor);
			const second = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(second.status).toBe("gated");
			if (first.status !== "gated" || second.status !== "gated") return;
			expect(second.reviewId).toBe(first.reviewId);
			expect(second.decision).toEqual(first.decision);
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(0);
			// No duplicate decision record; the cursor is re-advanced from the cached decision.
			expect(await listImprovementHistory(tempDir)).toHaveLength(1);
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[0].actionId, updatedAt: FIXED_MS });
		});

		test("high probability proceeds and a repeat uses both caches without calling either model", async () => {
			const records = await seedActions(tempDir, ["repeated friction with the release script"]);
			const faux = createFauxRuntime();
			faux.onClassify = () => classifierResult(0.9, "reliability");
			faux.onComplete = () => reviewResponse([memoryAddProposal([records[0].actionId], "release script flakes")]);

			const first = await runReview(tempDir, faux, {
				useDecider: true,
				deciderThresholdChars: 1,
				deciderProvider: "faux-decider-provider",
				deciderModel: "faux-decider-9",
				deciderMinProbability: 0.5,
			});
			expect(first.status).toBe("created");
			if (first.status !== "created") return;
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(1);
			expect(faux.classifierLookups).toEqual([{ provider: "faux-decider-provider", modelId: "faux-decider-9" }]);

			// History holds the decision record followed by the review record with the decision embedded.
			const decisions = await decisionRecords(tempDir);
			expect(decisions).toHaveLength(1);
			expect(decisions[0].createdAt).toBe(FIXED_MS);
			expect(decisions[0].actionIds).toEqual(records.map((action) => action.actionId));
			expect(decisions[0].decision.probability).toBe(0.9);
			expect(decisions[0].decision.priority).toBe("reliability");
			expect(decisions[0].decision.provider).toBe("faux-decider-provider");
			expect(decisions[0].decision.model).toBe("faux-decider-9");
			const reviews = await reviewRecords(tempDir);
			expect(reviews).toHaveLength(1);
			expect(reviews[0].decision).toEqual(decisions[0].decision);
			expect(reviews[0].reviewId).toBe(first.reviewId);

			// Reset the cursor: the identical review must hit both caches.
			rmSync(getLearningPaths(tempDir).cursor);
			const second = await runReview(tempDir, faux, {
				useDecider: true,
				deciderThresholdChars: 1,
				deciderProvider: "faux-decider-provider",
				deciderModel: "faux-decider-9",
				deciderMinProbability: 0.5,
			});
			expect(second.status).toBe("cached");
			if (second.status !== "cached") return;
			expect(second.reviewId).toBe(first.reviewId);
			expect(second.proposals).toEqual(first.proposals);
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(1);
			expect(await listImprovementHistory(tempDir)).toHaveLength(2);
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[0].actionId, updatedAt: FIXED_MS });
		});

		test("explicit decider failure is audited, rejects without Ling, and retries the decider", async () => {
			const records = await seedActions(tempDir, ["evidence"]);
			const faux = createFauxRuntime();
			faux.onClassify = (_call, index) =>
				index === 0 ? classifierError("decider exploded") : classifierResult(0.9);

			await expect(runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 })).rejects.toThrow(
				"decider exploded",
			);
			expect(faux.classifyCalls).toHaveLength(1);
			expect(faux.completeCalls).toHaveLength(0);
			// The failure is retained as a decision record with decision.error; the cursor is unchanged.
			let decisions = await decisionRecords(tempDir);
			expect(decisions).toHaveLength(1);
			expect(decisions[0].createdAt).toBe(FIXED_MS);
			expect(decisions[0].actionIds).toEqual(records.map((action) => action.actionId));
			expect(decisions[0].decision.error).toBe("decider exploded");
			expect(decisions[0].decision.result.stopReason).toBe("error");
			expect(await reviewRecords(tempDir)).toHaveLength(0);
			expect(existsSync(getLearningPaths(tempDir).cursor)).toBe(false);

			// Failed decisions are excluded from the cache: a retry calls the decider again,
			// then proceeds through the generative review on success.
			const retry = await runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 });
			expect(retry.status).toBe("created");
			if (retry.status !== "created") return;
			expect(faux.classifyCalls).toHaveLength(2);
			expect(faux.completeCalls).toHaveLength(1);
			decisions = await decisionRecords(tempDir);
			expect(decisions).toHaveLength(2);
			expect(decisions[0].decision.error).toBe("decider exploded");
			expect(decisions[1].decision.error).toBeUndefined();
			expect(decisions[1].reviewId).toBe(decisions[0].reviewId);
			expect(readCursor(tempDir)).toEqual({ lastActionId: records[0].actionId, updatedAt: FIXED_MS });
		});

		test("missing decider model propagates without falling back to the generative model", async () => {
			await seedActions(tempDir, ["evidence"]);
			const faux = createFauxRuntime();
			faux.classifierModel = undefined;

			await expect(runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 })).rejects.toThrow(
				`Decision model is not configured: ${DEFAULT_DECIDER_PROVIDER}/${DEFAULT_DECIDER_MODEL}`,
			);
			expect(faux.classifyCalls).toHaveLength(0);
			expect(faux.completeCalls).toHaveLength(0);
			expect(await listImprovementHistory(tempDir)).toEqual([]);
		});

		test("decider result without a shouldReview probability propagates", async () => {
			await seedActions(tempDir, ["evidence"]);
			const faux = createFauxRuntime();
			faux.onClassify = () => {
				const result = classifierResult(0.9);
				result.answers = {};
				return result;
			};

			await expect(runReview(tempDir, faux, { useDecider: true, deciderThresholdChars: 1 })).rejects.toThrow(
				"Decision model returned no shouldReview probability",
			);
			expect(faux.completeCalls).toHaveLength(0);
			// The malformed decision is audited like any other decider failure; nothing else moved.
			const decisions = await decisionRecords(tempDir);
			expect(decisions).toHaveLength(1);
			expect(decisions[0].decision.error).toBe("Decision model returned no shouldReview probability");
			expect(existsSync(getLearningPaths(tempDir).cursor)).toBe(false);
		});
	});

	describe("parseImprovementResponse", () => {
		const actionIds = ["act_1", "act_2"];

		test("parses fenced proposal JSON, derives evidence, and stamps deterministic ids", () => {
			const raw = {
				...memoryAddProposal(["act_1"], "durable fact"),
				evidence: [{ actionId: "act_1", evidenceClass: "executed" }],
			};
			const fenced = assistantMessage([
				{ type: "text", text: `\`\`\`json\n${JSON.stringify({ proposals: [raw] })}\n\`\`\`` },
			]);
			const first = parseImprovementResponse(fenced, actionIds, "rev_test", 1234);
			expect(first).toHaveLength(1);
			expect(first[0]).toMatchObject({
				kind: "memory",
				operation: "add",
				reviewId: "rev_test",
				status: "pending",
				content: "durable fact",
				createdAt: 1234,
				updatedAt: 1234,
				evidenceActionIds: ["act_1"],
				evidence: [{ actionId: "act_1", evidenceClass: "inferred" }],
			});
			expect(first[0].id).toMatch(/^prop_[0-9a-f]{32}$/);

			// Same input yields the same proposal id; a different review id changes it.
			const second = parseImprovementResponse(fenced, actionIds, "rev_test", 5678);
			expect(second[0].id).toBe(first[0].id);
			const otherReview = parseImprovementResponse(fenced, actionIds, "rev_other", 1234);
			expect(otherReview[0].id).not.toBe(first[0].id);
		});

		test("dedupes identical proposals within one response", () => {
			const raw = memoryAddProposal(["act_1"], "same content");
			const response = reviewResponse([raw, raw]);
			expect(parseImprovementResponse(response, actionIds, "rev_dedupe", 1)).toHaveLength(1);
		});

		test("rejects error and aborted responses", () => {
			expect(() =>
				parseImprovementResponse(
					assistantMessage([], { stopReason: "error", errorMessage: "boom" }),
					actionIds,
					"rev_e",
				),
			).toThrow("boom");
			expect(() =>
				parseImprovementResponse(assistantMessage([], { stopReason: "aborted" }), actionIds, "rev_a"),
			).toThrow("Improvement review aborted");
		});

		test("rejects empty text and malformed payloads", () => {
			expect(() => parseImprovementResponse(assistantMessage([]), actionIds, "rev_empty")).toThrow(
				"Improvement review returned no proposal JSON",
			);
			expect(() =>
				parseImprovementResponse(assistantMessage([{ type: "text", text: '{"nope":[]}' }]), actionIds, "rev_shape"),
			).toThrow("Improvement review must return an object with a proposals array");
		});

		test("does not echo sensitive malformed response excerpts in parse errors", () => {
			const secret = "ghp_0123456789abcdef0123456789abcdef0123";
			const response = assistantMessage([{ type: "text", text: `{"token":"${secret}"` }]);
			expect(() => parseImprovementResponse(response, actionIds, "rev_secret")).toThrow(
				"Improvement review returned invalid proposal JSON",
			);
			try {
				parseImprovementResponse(response, actionIds, "rev_secret");
			} catch (error) {
				expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
			}
		});

		test("rejects more than 8 proposals", () => {
			const raws = Array.from({ length: 9 }, (_unused, index) => memoryAddProposal(["act_1"], `fact ${index}`));
			expect(() => parseImprovementResponse(reviewResponse(raws), actionIds, "rev_many")).toThrow(
				"Improvement review returned more than 8 proposals",
			);
		});

		test("rejects fabricated evidence ids and unsupported operations", () => {
			expect(() =>
				parseImprovementResponse(reviewResponse([memoryAddProposal(["act_fabricated"], "x")]), actionIds, "rev_f"),
			).toThrow("Proposal cites action outside this review: act_fabricated");
			expect(() =>
				parseImprovementResponse(
					reviewResponse([{ ...memoryAddProposal(["act_1"], "x"), kind: "profile" }]),
					actionIds,
					"rev_k",
				),
			).toThrow("Unsupported proposal kind: profile");
			expect(() =>
				parseImprovementResponse(
					reviewResponse([{ ...memoryAddProposal(["act_1"], "x"), operation: "delete" }]),
					actionIds,
					"rev_o",
				),
			).toThrow("Unsupported memory proposal operation: delete");
			expect(() =>
				parseImprovementResponse(
					reviewResponse([{ ...memoryAddProposal(["act_1"], "x"), evidenceActionIds: [] }]),
					actionIds,
					"rev_v",
				),
			).toThrow("Every proposal must cite at least one action ID");
		});
	});

	describe("ImprovementProposalStore memory proposals", () => {
		test("approving a memory add applies it to project memory and persists the status", async () => {
			const records = await seedActions(tempDir, ["toolchain pin evidence"]);
			const faux = createFauxRuntime();
			faux.onComplete = () =>
				reviewResponse([memoryAddProposal([records[0].actionId], "Pin the toolchain to 22.x")]);
			const result = await runReview(tempDir, faux);
			expect(result.status).toBe("created");
			if (result.status !== "created") return;
			const proposal = result.proposals[0];
			expect(proposal).toMatchObject({ kind: "memory", operation: "add", content: "Pin the toolchain to 22.x" });

			const store = await ImprovementProposalStore.open(tempDir);
			const approved = await store.approve(proposal.id);
			expect(approved.status).toBe("applied");
			expect(approved.updatedAt).toBe(FIXED_MS);

			const memory = await ProjectMemoryStore.open(tempDir);
			const entries = memory.list();
			expect(entries).toHaveLength(1);
			expect(entries[0].content).toBe("Pin the toolchain to 22.x");
			expect(entries[0].source).toBe("review");
			expect(entries[0].createdAt).toBe(FIXED_MS);

			// Status is persisted to proposals.json, visible to a fresh store instance.
			const reloaded = await ImprovementProposalStore.open(tempDir);
			expect(reloaded.get(proposal.id).status).toBe("applied");
			const onDisk = JSON.parse(readFileSync(getLearningPaths(tempDir).proposals, "utf8")) as unknown[];
			expect(onDisk).toHaveLength(1);
			expect(onDisk[0]).toMatchObject({ id: proposal.id, status: "applied" });

			// An applied proposal cannot be approved or rejected again.
			await expect(reloaded.approve(proposal.id)).rejects.toThrow("Proposal is applied, not pending");
			await expect(reloaded.reject(proposal.id)).rejects.toThrow("Proposal is applied, not pending");
		});

		test("concurrent proposal stores do not lose independent additions", async () => {
			const first = parseImprovementResponse(
				reviewResponse([memoryAddProposal(["act_1"], "first concurrent proposal")]),
				["act_1"],
				"rev_concurrent_1",
			);
			const second = parseImprovementResponse(
				reviewResponse([memoryAddProposal(["act_1"], "second concurrent proposal")]),
				["act_1"],
				"rev_concurrent_2",
			);
			const stores = await Promise.all([
				ImprovementProposalStore.open(tempDir),
				ImprovementProposalStore.open(tempDir),
			]);
			await Promise.all([stores[0].add(first), stores[1].add(second)]);
			expect((await ImprovementProposalStore.open(tempDir)).list()).toHaveLength(2);
		});

		test("rejecting a memory add leaves project memory untouched", async () => {
			const records = await seedActions(tempDir, ["speculative evidence"]);
			const faux = createFauxRuntime();
			faux.onComplete = () => reviewResponse([memoryAddProposal([records[0].actionId], "Speculative note")]);
			const result = await runReview(tempDir, faux);
			expect(result.status).toBe("created");
			if (result.status !== "created") return;

			const store = await ImprovementProposalStore.open(tempDir);
			const rejected = await store.reject(result.proposals[0].id);
			expect(rejected.status).toBe("rejected");
			expect(rejected.updatedAt).toBe(FIXED_MS);

			const memory = await ProjectMemoryStore.open(tempDir);
			expect(memory.list()).toEqual([]);
			expect(existsSync(getLearningPaths(tempDir).memory)).toBe(false);

			await expect(store.reject(result.proposals[0].id)).rejects.toThrow("Proposal is rejected, not pending");
			await expect(store.approve(result.proposals[0].id)).rejects.toThrow("Proposal is rejected, not pending");
			const reloaded = await ImprovementProposalStore.open(tempDir);
			expect(reloaded.get(result.proposals[0].id).status).toBe("rejected");
		});
	});

	describe("ImprovementProposalStore skill proposals", () => {
		function skillProposalRaw(
			evidenceActionIds: string[],
			operation: "create" | "update",
			name: string,
			content: string,
			baseHash?: string,
		): Record<string, unknown> {
			return {
				kind: "skill",
				operation,
				title: `${operation} skill ${name}`,
				rationale: "Reusable procedure observed in the batch",
				evidenceActionIds,
				name,
				content,
				...(baseHash === undefined ? {} : { baseHash }),
			};
		}

		async function proposeSkill(raw: Record<string, unknown>): Promise<{ proposalId: string; reviewId: string }> {
			const records = await seedActions(tempDir, ["skill evidence"]);
			const faux = createFauxRuntime();
			faux.onComplete = () => reviewResponse([{ ...raw, evidenceActionIds: [records[0].actionId] }]);
			const result = await runReview(tempDir, faux);
			expect(result.status).toBe("created");
			if (result.status !== "created") throw new Error("review was not created");
			return { proposalId: result.proposals[0].id, reviewId: result.reviewId };
		}

		test("approving a skill create writes the project SKILL.md", async () => {
			const content = skillMarkdown("deploy-service", "Deploy the service", "Run the release script.");
			const { proposalId } = await proposeSkill(skillProposalRaw([], "create", "deploy-service", content));

			const store = await ImprovementProposalStore.open(tempDir);
			const approved = await store.approve(proposalId);
			expect(approved).toMatchObject({
				kind: "skill",
				operation: "create",
				name: "deploy-service",
				status: "applied",
			});

			const skillPath = join(tempDir, CONFIG_DIR_NAME, "skills", "deploy-service", "SKILL.md");
			expect(readFileSync(skillPath, "utf8")).toBe(content);
			// Project memory is not touched by a skill approval.
			expect(existsSync(getLearningPaths(tempDir).memory)).toBe(false);
		});

		test("approving a create for an existing skill fails", async () => {
			const skillDir = join(tempDir, CONFIG_DIR_NAME, "skills", "deploy-service");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				skillMarkdown("deploy-service", "Deploy the service", "Existing instructions."),
			);

			const { proposalId } = await proposeSkill(
				skillProposalRaw(
					[],
					"create",
					"deploy-service",
					skillMarkdown("deploy-service", "Deploy the service", "New."),
				),
			);
			const store = await ImprovementProposalStore.open(tempDir);
			await expect(store.approve(proposalId)).rejects.toThrow("Skill already exists; propose an update");
			expect(store.get(proposalId).status).toBe("pending");
		});

		test("approving a skill update with a matching baseHash rewrites the file", async () => {
			const skillDir = join(tempDir, CONFIG_DIR_NAME, "skills", "deploy-service");
			mkdirSync(skillDir, { recursive: true });
			const current = skillMarkdown("deploy-service", "Deploy the service", "v1 instructions.");
			writeFileSync(join(skillDir, "SKILL.md"), current);

			const updated = skillMarkdown("deploy-service", "Deploy the service", "v2 instructions.");
			const { proposalId } = await proposeSkill(
				skillProposalRaw([], "update", "deploy-service", updated, sha256Hex(current)),
			);

			const store = await ImprovementProposalStore.open(tempDir);
			const approved = await store.approve(proposalId);
			expect(approved).toMatchObject({ kind: "skill", operation: "update", status: "applied" });
			expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(updated);
		});

		test("stale baseHash conflict keeps the proposal pending and the file untouched", async () => {
			const skillDir = join(tempDir, CONFIG_DIR_NAME, "skills", "deploy-service");
			mkdirSync(skillDir, { recursive: true });
			const reviewed = skillMarkdown("deploy-service", "Deploy the service", "v1 instructions.");
			writeFileSync(join(skillDir, "SKILL.md"), reviewed);

			const { proposalId } = await proposeSkill(
				skillProposalRaw(
					[],
					"update",
					"deploy-service",
					skillMarkdown("deploy-service", "Deploy the service", "v2 instructions."),
					sha256Hex(reviewed),
				),
			);

			// The skill changed on disk after the review snapshot was taken.
			const drifted = skillMarkdown("deploy-service", "Deploy the service", "v1b instructions edited by hand.");
			writeFileSync(join(skillDir, "SKILL.md"), drifted);

			const store = await ImprovementProposalStore.open(tempDir);
			await expect(store.approve(proposalId)).rejects.toThrow(
				"Skill changed after review; reject this proposal and review again",
			);
			expect(store.get(proposalId).status).toBe("pending");
			expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(drifted);
		});

		test("approving an update for a missing skill fails", async () => {
			const { proposalId } = await proposeSkill(
				skillProposalRaw(
					[],
					"update",
					"ghost-skill",
					skillMarkdown("ghost-skill", "Does not exist", "body"),
					sha256Hex("whatever"),
				),
			);
			const store = await ImprovementProposalStore.open(tempDir);
			await expect(store.approve(proposalId)).rejects.toThrow("Skill no longer exists");
			expect(store.get(proposalId).status).toBe("pending");
		});

		test("invalid skill names and frontmatter mismatches fail validation before any write", async () => {
			const badName = await proposeSkill(
				skillProposalRaw([], "create", "Bad_Name", skillMarkdown("Bad_Name", "desc", "body")),
			);
			const store = await ImprovementProposalStore.open(tempDir);
			await expect(store.approve(badName.proposalId)).rejects.toThrow("Invalid skill name: Bad_Name");
			expect(store.get(badName.proposalId).status).toBe("pending");
			expect(existsSync(join(tempDir, CONFIG_DIR_NAME, "skills"))).toBe(false);
		});

		test("frontmatter name must match the proposal name", async () => {
			const { proposalId } = await proposeSkill(
				skillProposalRaw([], "create", "deploy-service", skillMarkdown("other-name", "Deploy the service", "body")),
			);
			const store = await ImprovementProposalStore.open(tempDir);
			await expect(store.approve(proposalId)).rejects.toThrow(
				"SKILL.md frontmatter name must match the proposal name",
			);
			expect(store.get(proposalId).status).toBe("pending");
			expect(existsSync(join(tempDir, CONFIG_DIR_NAME, "skills"))).toBe(false);
		});
	});

	describe("foreground proposal evidence", () => {
		test("stageMemoryProposal appends the exact action it cites", async () => {
			const proposal = await stageMemoryProposal(tempDir, { operation: "add", content: "Evidence-backed fact" });
			const actions = await ProjectActionStore.open(tempDir).list();
			expect(actions.map((action) => action.actionId)).toContain(proposal.evidenceActionIds[0]);
			expect(proposal.evidence).toEqual([{ actionId: actions[0].actionId, evidenceClass: "human" }]);
			expect(actions).toHaveLength(1);
		});
	});

	describe("project-local writes", () => {
		test("review and approvals only write inside the project config dir", async () => {
			const sandbox = mkdtempSync(join(tmpdir(), "pi-learning-improvement-sandbox-"));
			try {
				const project = join(sandbox, "project");
				mkdirSync(project, { recursive: true });
				const records = await seedActions(project, ["sandbox evidence"]);
				const faux = createFauxRuntime();
				faux.onComplete = () =>
					reviewResponse([
						memoryAddProposal([records[0].actionId], "Sandbox memory"),
						{
							kind: "skill",
							operation: "create",
							title: "create skill sandbox-skill",
							rationale: "Reusable procedure",
							evidenceActionIds: [records[0].actionId],
							name: "sandbox-skill",
							content: skillMarkdown("sandbox-skill", "Sandbox skill", "body"),
						},
					]);

				const result = await runReview(project, faux);
				expect(result.status).toBe("created");
				if (result.status !== "created") return;

				// The review itself stages proposals only: no memory or skill writes before approval.
				const paths = getLearningPaths(project);
				expect(existsSync(paths.memory)).toBe(false);
				expect(existsSync(join(project, CONFIG_DIR_NAME, "skills"))).toBe(false);

				const store = await ImprovementProposalStore.open(project);
				for (const proposal of result.proposals) await store.approve(proposal.id);

				// Every file written anywhere in the sandbox lives under <project>/<CONFIG_DIR_NAME>.
				const configRoot = join(project, CONFIG_DIR_NAME);
				const files = listFilesRecursive(sandbox);
				expect(files.length).toBeGreaterThan(0);
				for (const file of files) {
					expect(file.startsWith(`${configRoot}/`)).toBe(true);
				}
				// Learning state files are exactly where the project paths point.
				for (const key of ["actions", "reviews", "proposals", "cursor", "memory"] as const) {
					expect(paths[key].startsWith(`${configRoot}/`)).toBe(true);
					expect(existsSync(paths[key])).toBe(true);
				}
			} finally {
				rmSync(sandbox, { recursive: true, force: true });
			}
		});
	});
});
