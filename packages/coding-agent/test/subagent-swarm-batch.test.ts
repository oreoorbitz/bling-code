import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultIsRateLimitError,
	resolveSwarmMaxConcurrency,
	SWARM_MAX_CONCURRENCY_ENV,
	SwarmBatch,
	type SwarmBatchAbandonedEvent,
	type SwarmBatchLauncher,
	type SwarmBatchRunResult,
	type SwarmBatchSuspendedEvent,
	type SwarmBatchTask,
	userCancellationReason,
} from "../src/core/subagents/swarm-batch.ts";

class MockRateLimitError extends Error {
	readonly status = 429;

	constructor(message = "Rate limited") {
		super(message);
		this.name = "MockRateLimitError";
	}
}

type MockOutcome =
	| { readonly status: "completed"; readonly result?: string }
	| { readonly status: "failed"; readonly error?: string }
	| { readonly type: "rate_limited"; readonly error?: string };

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface MockAttempt {
	readonly task: SwarmBatchTask<number>;
	readonly attempt: number;
	readonly previousAttemptId: string | undefined;
	ready: boolean;
	readonly markReady: () => void;
	readonly outcome: Deferred<MockOutcome>;
}

interface MockSwarmRunnerOptions {
	readonly onSuspended?: (event: SwarmBatchSuspendedEvent<number>) => void;
	readonly onAbandoned?: (event: SwarmBatchAbandonedEvent<number>) => void;
	readonly readyDelay?: (attemptIndex: number) => number | undefined;
	readonly maxConcurrency?: number;
}

function createMockSwarmRunner(options: MockSwarmRunnerOptions = {}) {
	const attempts: MockAttempt[] = [];

	const launcher: SwarmBatchLauncher<number, string> = {
		launch: async (launchOptions) => {
			const outcome = deferred<MockOutcome>();
			const attemptIndex = attempts.length;
			const record: MockAttempt = {
				task: launchOptions.task,
				attempt: launchOptions.attempt,
				previousAttemptId: launchOptions.previousAttemptId,
				ready: false,
				markReady: () => {
					record.ready = true;
					launchOptions.onReady();
				},
				outcome,
			};
			attempts.push(record);

			const delay = options.readyDelay?.(attemptIndex);
			if (delay !== undefined) setTimeout(record.markReady, delay);

			return {
				id: mockAttemptId(launchOptions.task, attemptIndex),
				completion: completionFromOutcome(outcome, launchOptions.signal),
			};
		},
		suspended: (event) => {
			options.onSuspended?.(event);
		},
		abandoned: (event) => {
			options.onAbandoned?.(event);
		},
	};

	return {
		attempts,
		runBatch(
			tasks: readonly SwarmBatchTask<number>[],
			runOptions: {
				readonly signal?: AbortSignal;
				readonly maxConcurrency?: number;
				readonly isRateLimitError?: (error: unknown) => boolean;
				readonly isUserCancellation?: (reason: unknown) => boolean;
				readonly maxRateLimitRetries?: number;
				readonly admit?: (task: SwarmBatchTask<unknown>) => (() => void) | undefined;
				readonly subscribeCapacity?: (listener: () => void) => () => void;
			} = {},
		): Promise<Array<SwarmBatchRunResult<number, string>>> {
			return new SwarmBatch<number, string>(launcher, tasks, {
				maxConcurrency: options.maxConcurrency,
				...runOptions,
			}).run();
		},
	};
}

function completionFromOutcome(outcome: Deferred<MockOutcome>, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(signal.reason ?? new Error("Aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
		outcome.promise.then(
			(result) => {
				signal.removeEventListener("abort", abort);
				if ("type" in result) {
					reject(new MockRateLimitError(result.error));
					return;
				}
				if (result.status === "completed") {
					resolve(result.result ?? "done");
					return;
				}
				reject(new Error(result.error ?? result.status));
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function mockAttemptId(task: SwarmBatchTask<number>, attemptIndex: number): string {
	if (typeof task.data === "number") return `agent-${task.data}`;
	return `agent-${attemptIndex + 1}`;
}

function queuedTask(index: number): SwarmBatchTask<number> {
	return { data: index };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("resolveSwarmMaxConcurrency", () => {
	it("names the variable from APP_NAME", () => {
		expect(SWARM_MAX_CONCURRENCY_ENV).toBe("BLING_SWARM_MAX_CONCURRENCY");
	});

	it("returns undefined when the variable is unset", () => {
		expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
	});

	it("returns undefined for empty or whitespace-only values", () => {
		expect(resolveSwarmMaxConcurrency({ [SWARM_MAX_CONCURRENCY_ENV]: "" })).toBeUndefined();
		expect(resolveSwarmMaxConcurrency({ [SWARM_MAX_CONCURRENCY_ENV]: "   " })).toBeUndefined();
	});

	it("throws for non-positive, non-integer, or non-numeric values", () => {
		for (const raw of ["0", "-1", "2.5", "abc"]) {
			expect(() => resolveSwarmMaxConcurrency({ [SWARM_MAX_CONCURRENCY_ENV]: raw })).toThrow(
				/BLING_SWARM_MAX_CONCURRENCY.*positive integer/,
			);
		}
	});

	it("returns the integer for a positive integer value", () => {
		expect(resolveSwarmMaxConcurrency({ [SWARM_MAX_CONCURRENCY_ENV]: "3" })).toBe(3);
		expect(resolveSwarmMaxConcurrency({ [SWARM_MAX_CONCURRENCY_ENV]: " 8 " })).toBe(8);
	});

	it("reads process.env by default", () => {
		vi.stubEnv(SWARM_MAX_CONCURRENCY_ENV, "4");
		expect(resolveSwarmMaxConcurrency()).toBe(4);
	});
});

describe("defaultIsRateLimitError", () => {
	it("matches 429 statuses and rate-limit messages", () => {
		expect(defaultIsRateLimitError({ status: 429 })).toBe(true);
		expect(defaultIsRateLimitError({ statusCode: 429 })).toBe(true);
		expect(defaultIsRateLimitError(new Error("Provider rate limit reached"))).toBe(true);
		expect(defaultIsRateLimitError("rate limit")).toBe(true);
	});

	it("does not match quota exhaustion, other errors, or empty values", () => {
		expect(defaultIsRateLimitError(Object.assign(new Error("insufficient_quota"), { status: 429 }))).toBe(false);
		expect(defaultIsRateLimitError({ status: 500 })).toBe(false);
		expect(defaultIsRateLimitError({ code: "invalid_request_error" })).toBe(false);
		expect(defaultIsRateLimitError(new Error("boom"))).toBe(false);
		expect(defaultIsRateLimitError(null)).toBe(false);
		expect(defaultIsRateLimitError(undefined)).toBe(false);
	});
});

describe("SwarmBatch construction", () => {
	it("rejects a non-positive or non-integer maxConcurrency", () => {
		const launcher: SwarmBatchLauncher<number, string> = { launch: async () => neverLaunches() };
		for (const maxConcurrency of [0, -1, 2.5]) {
			expect(() => new SwarmBatch(launcher, [queuedTask(1)], { maxConcurrency })).toThrow(
				/maxConcurrency must be a positive integer/,
			);
		}
	});

	it("resolves an empty batch immediately and guards against a second run", async () => {
		const launcher: SwarmBatchLauncher<number, string> = { launch: async () => neverLaunches() };
		const batch = new SwarmBatch(launcher, []);
		await expect(batch.run()).resolves.toEqual([]);
		expect(() => batch.run()).toThrow(/can only be called once/);
	});

	it("rejects the run when the batch signal is already aborted without a cancellation reason", async () => {
		const controller = new AbortController();
		controller.abort();
		const { runBatch } = createMockSwarmRunner();
		await expect(runBatch([queuedTask(1)], { signal: controller.signal })).rejects.toThrow();
	});
});

function neverLaunches(): never {
	throw new Error("unexpected launch");
}

describe("SwarmBatch scheduling contract", () => {
	it("normal phase starts five tasks immediately, then one task every 700ms", async () => {
		vi.useFakeTimers();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)),
			{ signal: new AbortController().signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(699);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(6);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(7);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(8);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(9);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(9);

		attempts.forEach((attempt, index) => {
			attempt.outcome.resolve({ status: "completed", result: `result ${index + 1}` });
		});
		const results = await running;

		expect(results).toHaveLength(9);
		expect(results.every((result) => result.status === "completed")).toBe(true);
		expect(results.map((result) => result.result)).toEqual(
			Array.from({ length: 9 }, (_, index) => `result ${index + 1}`),
		);
	});

	it("returns results in task order even when later tasks finish first", async () => {
		vi.useFakeTimers();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch([queuedTask(1), queuedTask(2)], { signal: new AbortController().signal });

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(2);

		attempts[1]!.outcome.resolve({ status: "completed", result: "second" });
		await vi.advanceTimersByTimeAsync(0);
		attempts[0]!.outcome.resolve({ status: "completed", result: "first" });

		const results = await running;
		expect(results.map((result) => result.result)).toEqual(["first", "second"]);
	});

	it("user cancellation returns completed, started, and not-started task results", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 6 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		attempts[0]!.outcome.resolve({ status: "completed", result: "completed 1" });
		await vi.advanceTimersByTimeAsync(0);

		controller.abort(userCancellationReason());
		const results = await running;

		expect(
			results.map((result) => ({
				data: result.task.data,
				attemptId: result.attemptId,
				status: result.status,
				state: result.state,
				result: result.result,
				error: result.error,
			})),
		).toEqual([
			{
				data: 1,
				attemptId: "agent-1",
				status: "completed",
				state: undefined,
				result: "completed 1",
				error: undefined,
			},
			{
				data: 2,
				attemptId: "agent-2",
				status: "aborted",
				state: "started",
				result: undefined,
				error: "The user manually interrupted this subagent batch before this subagent finished.",
			},
			{
				data: 3,
				attemptId: "agent-3",
				status: "aborted",
				state: "started",
				result: undefined,
				error: "The user manually interrupted this subagent batch before this subagent finished.",
			},
			{
				data: 4,
				attemptId: "agent-4",
				status: "aborted",
				state: "started",
				result: undefined,
				error: "The user manually interrupted this subagent batch before this subagent finished.",
			},
			{
				data: 5,
				attemptId: "agent-5",
				status: "aborted",
				state: "started",
				result: undefined,
				error: "The user manually interrupted this subagent batch before this subagent finished.",
			},
			{
				data: 6,
				attemptId: undefined,
				status: "aborted",
				state: "not_started",
				result: undefined,
				error: "The user manually interrupted this subagent batch before this subagent was started.",
			},
		]);
	});

	it("rejects the batch when the batch signal aborts without a user-cancellation reason", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 4 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(4);

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("normal phase keeps processing completions while waiting for the next launch", async () => {
		vi.useFakeTimers();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 6 }, (_, index) => queuedTask(index + 1)),
			{ signal: new AbortController().signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts[0]!.outcome.resolve({ status: "completed", result: "completed 1" });

		await vi.advanceTimersByTimeAsync(699);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(6);

		attempts.slice(1).forEach((attempt, index) => {
			attempt.outcome.resolve({ status: "completed", result: `completed ${index + 2}` });
		});
		await expect(running).resolves.toHaveLength(6);
	});

	it("rate-limit phase starts when the first provider rate limit stops the normal ramp", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});

		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(5);

		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await vi.advanceTimersByTimeAsync(3000);
		expect(attempts).toHaveLength(6);
		expect(attempts[5]!.task.data).toBe(1);
		expect(attempts[5]!.attempt).toBe(2);
		expect(attempts[5]!.previousAttemptId).toBe("agent-1");

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("rate-limit phase requeues rate-limited tasks, emits suspended, and throttles launches", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const onSuspended = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onSuspended });
		const running = runBatch(
			Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		attempts.forEach((attempt) => {
			attempt.markReady();
		});
		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		attempts[1]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);
		expect(onSuspended).toHaveBeenCalledTimes(2);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(500);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(2500);
		expect(attempts).toHaveLength(6);
		expect(attempts[5]!.task.data).toBe(2);
		expect(attempts[5]!.previousAttemptId).toBe("agent-2");

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("retries the last unfinished task on a startup rate limit like any other task", async () => {
		vi.useFakeTimers();
		const onSuspended = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onSuspended });
		const running = runBatch(
			Array.from({ length: 2 }, (_, index) => queuedTask(index + 1)),
			{ signal: new AbortController().signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(2);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});

		attempts[0]!.outcome.resolve({ status: "completed", result: "completed 1" });
		await vi.advanceTimersByTimeAsync(0);

		attempts[1]!.outcome.resolve({ type: "rate_limited", error: "Rate limited" });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onSuspended).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "agent-2" }));
		expect(attempts).toHaveLength(3);
		expect(attempts[2]).toMatchObject({ task: { data: 2 }, attempt: 2, previousAttemptId: "agent-2" });

		attempts[2]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await expect(running).resolves.toMatchObject([
			{ task: { data: 1 }, status: "completed", result: "completed 1" },
			{ task: { data: 2 }, status: "completed", result: "completed 2" },
		]);
	});

	it("fails a task that is still rate limited after maxRateLimitRetries, so the batch always ends", async () => {
		vi.useFakeTimers();
		const onAbandoned = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onAbandoned });
		const running = runBatch([queuedTask(1)], { signal: new AbortController().signal, maxRateLimitRetries: 2 });

		for (let attempt = 0; attempt < 3; attempt++) {
			await vi.advanceTimersByTimeAsync(0);
			expect(attempts).toHaveLength(attempt + 1);
			attempts[attempt]!.outcome.resolve({ type: "rate_limited", error: "Rate limited" });
			await vi.advanceTimersByTimeAsync(20_000);
		}

		await expect(running).resolves.toMatchObject([
			{ task: { data: 1 }, status: "failed", error: "Rate limited (still rate limited after 2 retries)" },
		]);
		expect(attempts).toHaveLength(3);
		expect(onAbandoned).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
	});

	it("rate-limit capacity blocks launches while active attempts fill all slots", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 12 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts.slice(0, 5).forEach((attempt) => {
			attempt.markReady();
		});

		for (let count = 6; count <= 12; count += 1) {
			await vi.advanceTimersByTimeAsync(700);
			expect(attempts).toHaveLength(count);
			attempts[count - 1]!.markReady();
		}

		attempts.slice(0, 12).forEach((attempt) => {
			attempt.markReady();
		});

		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(3000);
		expect(attempts).toHaveLength(12);

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("rate-limit recovery adds one capacity slot after three quiet minutes with queued work", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 6 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});

		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(2000);
		attempts[1]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(2000);
		attempts[2]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(2000);
		attempts[3]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(179_999);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(6);
		expect(attempts[5]!.task.data).toBe(4);
		expect(attempts[5]!.previousAttemptId).toBe("agent-4");

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("rate-limit phase keeps launches bounded after repeated rate limits", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});

		for (let index = 0; index < 3; index += 1) {
			attempts[index]!.outcome.resolve({ type: "rate_limited" });
			await vi.advanceTimersByTimeAsync(0);
		}

		await vi.advanceTimersByTimeAsync(3000);
		expect(attempts).toHaveLength(6);
		expect(attempts[5]!.task.data).toBe(3);
		expect(attempts[5]!.previousAttemptId).toBe("agent-3");

		await vi.advanceTimersByTimeAsync(3000);
		expect(attempts).toHaveLength(7);
		expect(attempts[6]!.task.data).toBe(2);
		expect(attempts[6]!.previousAttemptId).toBe("agent-2");

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("rate-limit phase schedules another launch after starting while capacity remains", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});

		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		attempts[2]!.outcome.resolve({ status: "completed", result: "completed 3" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(2_999);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(6);
		expect(attempts[5]!.task.data).toBe(1);
		expect(attempts[5]!.previousAttemptId).toBe("agent-1");

		await vi.advanceTimersByTimeAsync(2_999);
		expect(attempts).toHaveLength(6);

		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(7);
		expect(attempts[6]!.task.data).toBe(6);
		expect(attempts[6]!.previousAttemptId).toBeUndefined();

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("task timeout fails only that task", async () => {
		vi.useFakeTimers();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch([{ ...queuedTask(1), timeout: 10_000 }], {
			signal: new AbortController().signal,
		});

		await vi.advanceTimersByTimeAsync(0);
		attempts[0]!.markReady();

		await vi.advanceTimersByTimeAsync(9999);
		expect(attempts).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		await expect(running).resolves.toMatchObject([
			{
				task: { data: 1 },
				attemptId: "agent-1",
				status: "failed",
				state: "started",
				error: "Subagent timed out.",
			},
		]);
	});

	it("a non-positive task timeout means unbounded", async () => {
		vi.useFakeTimers();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch([{ ...queuedTask(1), timeout: 0 }], {
			signal: new AbortController().signal,
		});

		await vi.advanceTimersByTimeAsync(0);
		attempts[0]!.markReady();
		await vi.advanceTimersByTimeAsync(60_000);

		attempts[0]!.outcome.resolve({ status: "completed", result: "done" });
		await vi.advanceTimersByTimeAsync(0);
		await expect(running).resolves.toMatchObject([{ task: { data: 1 }, attemptId: "agent-1", status: "completed" }]);
	});

	it("does not spend task timeout while the task is queued", async () => {
		vi.useFakeTimers();
		let settled = false;
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			[...Array.from({ length: 5 }, (_, index) => queuedTask(index + 1)), { ...queuedTask(6), timeout: 1000 }],
			{ signal: new AbortController().signal },
		);
		void running.finally(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(699);
		expect(attempts).toHaveLength(5);

		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(6);

		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);

		attempts.slice(0, 5).forEach((attempt, index) => {
			attempt.outcome.resolve({ status: "completed", result: `completed ${index + 1}` });
		});
		await vi.advanceTimersByTimeAsync(1);

		await expect(running).resolves.toMatchObject([
			{ task: { data: 1 }, status: "completed" },
			{ task: { data: 2 }, status: "completed" },
			{ task: { data: 3 }, status: "completed" },
			{ task: { data: 4 }, status: "completed" },
			{ task: { data: 5 }, status: "completed" },
			{
				task: { data: 6 },
				attemptId: "agent-6",
				status: "failed",
				state: "started",
				error: "Subagent timed out.",
			},
		]);
	});

	it("rate-limit phase continues launching after rate-limited attempts settle", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner({
			readyDelay: (attemptIndex) => (attemptIndex >= 7 ? 100 : undefined),
		});

		const running = runBatch(
			Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		attempts.slice(0, 5).forEach((attempt) => {
			attempt.markReady();
		});

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(6);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(7);

		attempts[5]!.outcome.resolve({ type: "rate_limited" });
		attempts[6]!.outcome.resolve({ type: "rate_limited" });
		attempts[0]!.outcome.resolve({ status: "completed", result: "completed 1" });
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await vi.advanceTimersByTimeAsync(12_000);
		expect(attempts).toHaveLength(8);
		expect(attempts[7]!.task.data).toBe(7);
		expect(attempts[7]!.previousAttemptId).toBe("agent-7");

		controller.abort();
		await expect(running).rejects.toThrow();
	});

	it("treats a completion rejection as a plain failure when the classifier does not match", async () => {
		vi.useFakeTimers();
		const onSuspended = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onSuspended });
		const running = runBatch([queuedTask(1), queuedTask(2)], {
			signal: new AbortController().signal,
			isRateLimitError: () => false,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(2);

		attempts[0]!.outcome.resolve({ type: "rate_limited", error: "Rate limited" });
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });

		await expect(running).resolves.toMatchObject([
			{ task: { data: 1 }, status: "failed", state: "started", error: "Rate limited" },
			{ task: { data: 2 }, status: "completed", result: "completed 2" },
		]);
		expect(onSuspended).not.toHaveBeenCalled();
	});

	it("aborts only the task whose own signal fires and keeps the batch running", async () => {
		vi.useFakeTimers();
		const taskController = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch([{ ...queuedTask(1), signal: taskController.signal }, queuedTask(2)], {
			signal: new AbortController().signal,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(2);

		taskController.abort(userCancellationReason());
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });

		await expect(running).resolves.toMatchObject([
			{
				task: { data: 1 },
				attemptId: "agent-1",
				status: "aborted",
				state: "started",
				error: "The user manually interrupted this subagent batch.",
			},
			{ task: { data: 2 }, status: "completed", result: "completed 2" },
		]);
	});
});

describe("SwarmBatch max concurrency cap", () => {
	it("caps in-flight tasks at maxConcurrency during the normal phase", async () => {
		vi.useFakeTimers();
		const { runBatch, attempts } = createMockSwarmRunner({ maxConcurrency: 3 });
		const running = runBatch(
			Array.from({ length: 9 }, (_, index) => queuedTask(index + 1)),
			{ signal: new AbortController().signal },
		);
		const resolved = new Set<number>();
		const resolveOne = (index: number) => {
			const attempt = attempts[index]!;
			resolved.add(index);
			attempt.outcome.resolve({ status: "completed", result: `result ${index + 1}` });
		};
		const inFlight = () => attempts.length - resolved.size;

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(3);
		expect(inFlight()).toBe(3);

		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(3);

		resolveOne(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(4);
		expect(inFlight()).toBeLessThanOrEqual(3);

		resolveOne(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		expect(inFlight()).toBeLessThanOrEqual(3);

		resolveOne(2);
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(5);
		await vi.advanceTimersByTimeAsync(700);
		expect(attempts).toHaveLength(6);
		expect(inFlight()).toBeLessThanOrEqual(3);

		for (let index = 3; index < 9; index += 1) {
			resolveOne(index);
			await vi.advanceTimersByTimeAsync(700);
			expect(inFlight()).toBeLessThanOrEqual(3);
		}

		const results = await running;
		expect(results).toHaveLength(9);
		expect(results.every((result) => result.status === "completed")).toBe(true);
	});

	it("keeps the hard cap after rate-limit capacity grows beyond it", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner({ maxConcurrency: 2 });
		const running = runBatch(
			Array.from({ length: 8 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(2);
		for (let index = 0; index < 3; index += 1) {
			attempts[index]!.markReady();
			attempts[index]!.outcome.resolve({ status: "completed", result: `result ${index + 1}` });
			await vi.advanceTimersByTimeAsync(0);
			attempts[index + 2]!.markReady();
		}
		expect(attempts).toHaveLength(5);

		attempts[3]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(3000);
		expect(attempts).toHaveLength(6);

		await vi.advanceTimersByTimeAsync(3000);
		expect(attempts).toHaveLength(6);

		controller.abort(userCancellationReason());
		await expect(running).resolves.toHaveLength(8);
	});
});

describe("SwarmBatch suspended and abandoned callbacks", () => {
	it("user cancellation abandons rate-limit-suspended agents without touching active or completed ones", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const onAbandoned = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onAbandoned });
		const running = runBatch(
			Array.from({ length: 4 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(4);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});

		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await vi.advanceTimersByTimeAsync(0);

		controller.abort(userCancellationReason());
		const results = await running;

		expect(results.map((result) => ({ data: result.task.data, status: result.status }))).toEqual([
			{ data: 1, status: "aborted" },
			{ data: 2, status: "completed" },
			{ data: 3, status: "aborted" },
			{ data: 4, status: "aborted" },
		]);
		expect(onAbandoned).toHaveBeenCalledTimes(1);
		expect(onAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ attemptId: "agent-1", task: expect.objectContaining({ data: 1 }) }),
		);
	});

	it("abandons rate-limit-suspended agents when the batch aborts without a user-cancellation reason", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const onAbandoned = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onAbandoned });
		const running = runBatch(
			Array.from({ length: 3 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});
		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await vi.advanceTimersByTimeAsync(0);

		controller.abort();
		await expect(running).rejects.toThrow();
		expect(onAbandoned).toHaveBeenCalledTimes(1);
		expect(onAbandoned).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "agent-1" }));
	});

	it("abandons a rate-limited task that is relaunched but not yet ready when the batch is cancelled", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const onAbandoned = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onAbandoned });
		const running = runBatch(
			Array.from({ length: 2 }, (_, index) => queuedTask(index + 1)),
			{ signal: controller.signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});
		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(attempts).toHaveLength(3);
		expect(attempts[2]!.previousAttemptId).toBe("agent-1");
		expect(attempts[2]!.ready).toBeFalsy();

		controller.abort(userCancellationReason());
		await running;

		expect(onAbandoned).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "agent-1", outcome: "cancelled" }));
	});

	it("does not abandon agents when a rate-limited task retries successfully", async () => {
		vi.useFakeTimers();
		const onAbandoned = vi.fn();
		const { runBatch, attempts } = createMockSwarmRunner({ onAbandoned });
		const running = runBatch(
			Array.from({ length: 2 }, (_, index) => queuedTask(index + 1)),
			{ signal: new AbortController().signal },
		);

		await vi.advanceTimersByTimeAsync(0);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});
		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		attempts[1]!.outcome.resolve({ status: "completed", result: "completed 2" });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(attempts).toHaveLength(3);
		expect(attempts[2]!.previousAttemptId).toBe("agent-1");

		attempts[2]!.outcome.resolve({ status: "completed", result: "recovered 1" });
		await expect(running).resolves.toMatchObject([
			{ task: { data: 1 }, attemptId: "agent-1", status: "completed", result: "recovered 1" },
			{ task: { data: 2 }, attemptId: "agent-2", status: "completed", result: "completed 2" },
		]);
		expect(onAbandoned).not.toHaveBeenCalled();
	});

	it("emits suspended with the requeue reason on every rate-limited task", async () => {
		vi.useFakeTimers();
		const onSuspended = vi.fn();
		const controller = new AbortController();
		const { runBatch, attempts } = createMockSwarmRunner({ onSuspended });
		const running = runBatch([queuedTask(1), queuedTask(2)], { signal: controller.signal });
		void running.catch(() => {});

		await vi.advanceTimersByTimeAsync(0);
		attempts.forEach((attempt) => {
			attempt.markReady();
		});
		attempts[0]!.outcome.resolve({ type: "rate_limited" });
		await vi.advanceTimersByTimeAsync(0);

		expect(onSuspended).toHaveBeenCalledWith(
			expect.objectContaining({
				attemptId: "agent-1",
				reason: "Provider rate limit; subagent requeued for retry.",
			}),
		);

		controller.abort();
		await expect(running).rejects.toThrow();
	});
});

describe("SwarmBatch shared capacity gate", () => {
	it("launches only admitted tasks and resumes when the gate frees a slot", async () => {
		vi.useFakeTimers();
		let free = 1;
		const listeners = new Set<() => void>();
		const admit = () => {
			if (free === 0) return undefined;
			free -= 1;
			return () => {
				free += 1;
				for (const listener of [...listeners]) listener();
			};
		};
		const { runBatch, attempts } = createMockSwarmRunner();
		const running = runBatch(
			Array.from({ length: 3 }, (_, index) => queuedTask(index + 1)),
			{
				admit,
				subscribeCapacity: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(attempts).toHaveLength(1);
		attempts[0]!.outcome.resolve({ status: "completed", result: "one" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(2);
		attempts[1]!.outcome.resolve({ status: "completed", result: "two" });
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toHaveLength(3);
		attempts[2]!.outcome.resolve({ status: "completed", result: "three" });

		await expect(running).resolves.toHaveLength(3);
		expect(free).toBe(1);
		expect(listeners.size).toBe(0);
	});
});
