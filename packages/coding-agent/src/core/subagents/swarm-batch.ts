import { APP_NAME } from "../../config.ts";
import { isSubagentRateLimitError } from "./rate-limit.ts";

/**
 * Generic batch scheduler for running subagent-like tasks with Kimi AgentRunBatch dynamics:
 * an initial launch burst, paced follow-up launches, per-task abort/timeout, provider
 * rate-limit requeue at the front of the queue with exponential backoff, a global retry
 * throttle, and a shrinking/recovering rate-limit capacity.
 *
 * The scheduler is standalone: the launcher starts an attempt and the attempt completion
 * resolves with a caller-defined result. Every retry of a task calls the same launcher again.
 */

/** One unit of work for a {@link SwarmBatch}. */
export interface SwarmBatchTask<T> {
	/** Caller-defined payload; echoed back on results and launcher callbacks. */
	readonly data: T;
	/**
	 * Wall-clock budget of a single attempt in milliseconds. The clock starts when the attempt
	 * launches, not while the task is queued; undefined or a non-positive value means unbounded.
	 */
	readonly timeout?: number;
	/** Optional per-task abort. The batch-level signal applies to every task on top of this. */
	readonly signal?: AbortSignal;
}

/** What the launcher receives for every attempt (first try and rate-limit retries alike). */
export interface SwarmBatchAttemptLaunch<T> {
	readonly task: SwarmBatchTask<T>;
	/** 1-based attempt number; increments on every rate-limit retry of the task. */
	readonly attempt: number;
	/** Id of the rate-limited attempt this launch retries; undefined on the first try. */
	readonly previousAttemptId?: string;
	/** Aborts when the batch aborts, the task signal aborts, or the task times out. */
	readonly signal: AbortSignal;
	/** The launcher calls this once the attempt is genuinely running (past queueing/spawning). */
	readonly onReady: () => void;
}

/** Handle for a started attempt. */
export interface SwarmBatchAttemptHandle<R> {
	/** Attempt identity, echoed back on results and suspended/abandoned events. */
	readonly id: string;
	/** Resolves with the attempt result; on rejection see {@link SwarmBatchOptions.isRateLimitError}. */
	readonly completion: Promise<R>;
}

/** A task attempt stopped on a provider rate limit and requeued for retry. */
export interface SwarmBatchSuspendedEvent<T> {
	readonly task: SwarmBatchTask<T>;
	readonly attemptId: string;
	readonly reason: string;
}

/** A task attempt that will not be retried: terminalized as failed, or dropped on batch abort. */
export interface SwarmBatchAbandonedEvent<T> {
	readonly task: SwarmBatchTask<T>;
	readonly attemptId: string;
	readonly outcome: "cancelled" | "failed";
	readonly error?: string;
}

/**
 * Starts attempts. The scheduler never retries on its own behalf: a rate-limited task is
 * requeued and the launcher is asked to start the next attempt via another `launch` call.
 */
export interface SwarmBatchLauncher<T, R> {
	launch(options: SwarmBatchAttemptLaunch<T>): Promise<SwarmBatchAttemptHandle<R>>;
	suspended?(event: SwarmBatchSuspendedEvent<T>): void;
	abandoned?(event: SwarmBatchAbandonedEvent<T>): void;
}

/** Per-task result of a batch run, in task order. */
export interface SwarmBatchRunResult<T, R> {
	readonly task: SwarmBatchTask<T>;
	readonly attemptId?: string;
	readonly status: "completed" | "failed" | "aborted";
	/** Whether the task ever started an attempt (undefined on plain completions). */
	readonly state?: "started" | "not_started";
	readonly result?: R;
	readonly error?: string;
}

export interface SwarmBatchOptions {
	/** One signal for the whole batch. Aborts every queued and running task. */
	readonly signal?: AbortSignal;
	/** Positive cap on simultaneously running attempts. Undefined means unbounded. */
	readonly maxConcurrency?: number;
	/**
	 * Classifies an attempt-completion rejection as a provider rate limit. Matched rejections
	 * requeue the task at the front of the queue instead of failing it. Defaults to
	 * {@link defaultIsRateLimitError}.
	 */
	readonly isRateLimitError?: (error: unknown) => boolean;
	/**
	 * Classifies the batch-signal abort reason as a user cancellation: the batch resolves with
	 * per-task aborted results instead of rejecting. Defaults to {@link isUserCancellation}.
	 */
	readonly isUserCancellation?: (reason: unknown) => boolean;
	/**
	 * Rate-limit retries allowed per task before it fails with the provider error. Bounds the
	 * batch under a limit that never clears. Defaults to {@link DEFAULT_MAX_RATE_LIMIT_RETRIES}.
	 */
	readonly maxRateLimitRetries?: number;
	/**
	 * Shared capacity gate: returns a release function when the task may launch now, or undefined
	 * when its host has no free slot. When set, it replaces the batch's own rate-limit capacity
	 * (launch pacing and retry backoff stay), so what one batch learns applies to the next.
	 */
	readonly admit?: (task: SwarmBatchTask<unknown>) => (() => void) | undefined;
	/** Subscribe to "a slot may be free" notifications from the {@link admit} gate; returns unsubscribe. */
	readonly subscribeCapacity?: (listener: () => void) => () => void;
}

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;
const RATE_LIMIT_SUSPENDED_REASON = "Provider rate limit; subagent requeued for retry.";
const MAX_TIMER_DELAY_MS = 0x7fffffff;
/** Five retries wait 3 + 6 + 12 + 24 + 48 s, about 1.5 minutes of backoff per task. */
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

/** Env variable that caps swarm concurrency: `<APP_NAME>_SWARM_MAX_CONCURRENCY` (e.g. BLING_SWARM_MAX_CONCURRENCY). */
export const SWARM_MAX_CONCURRENCY_ENV = `${APP_NAME.toUpperCase()}_SWARM_MAX_CONCURRENCY`;

/**
 * Marker abort reason for a batch the user cancelled (as opposed to an internal abort):
 * the batch resolves with per-task aborted results instead of rejecting.
 */
export class UserCancellationError extends Error {
	readonly userCancelled = true;

	constructor() {
		super("Aborted by the user");
		this.name = "AbortError";
	}
}

export function userCancellationReason(): UserCancellationError {
	return new UserCancellationError();
}

export function isUserCancellation(value: unknown): value is UserCancellationError {
	return value instanceof UserCancellationError;
}

/** Default transient provider rate-limit classifier, excluding quota and subscription exhaustion. */
export function defaultIsRateLimitError(error: unknown): boolean {
	return isSubagentRateLimitError(error);
}

/** Resolve the optional positive integer cap from the environment; undefined when unset. */
export function resolveSwarmMaxConcurrency(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
	const raw = env[SWARM_MAX_CONCURRENCY_ENV];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${SWARM_MAX_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`);
	}
	return value;
}

type RateLimitedOutcome = {
	readonly type: "rate_limited";
	readonly attemptId: string;
	readonly error: string;
};

type AttemptOutcome<T, R> = SwarmBatchRunResult<T, R> | RateLimitedOutcome;

type TaskState<T> = {
	readonly index: number;
	readonly task: SwarmBatchTask<T>;
	attemptId?: string;
	retryCount: number;
	retryReadyAt: number;
	started: boolean;
};

type ActiveAttempt<T> = {
	readonly state: TaskState<T>;
	readonly controller: AbortController;
	/** Frees the shared capacity slot this attempt holds. */
	readonly release: () => void;
	cleanup: () => void;
	ready: boolean;
	timedOut: boolean;
};

/**
 * Run a batch of tasks through a {@link SwarmBatchLauncher}. `run()` resolves with one result
 * per task, in task order, once every task is accounted for.
 */
export class SwarmBatch<T, R> {
	private readonly launcher: SwarmBatchLauncher<T, R>;
	private readonly states: Array<TaskState<T>>;
	private readonly pending: Array<TaskState<T>>;
	private readonly results: Array<SwarmBatchRunResult<T, R> | undefined>;
	private readonly active = new Set<ActiveAttempt<T>>();
	private readonly controller = new AbortController();
	private readonly batchSignal: AbortSignal | undefined;
	private readonly batchAbortListener: () => void;
	private readonly isRateLimitError: (error: unknown) => boolean;
	private readonly isUserCancellation: (reason: unknown) => boolean;
	private readonly maxConcurrency: number | undefined;
	private readonly maxRateLimitRetries: number;
	private readonly admit: ((task: SwarmBatchTask<unknown>) => (() => void) | undefined) | undefined;
	private readonly subscribeCapacity: ((listener: () => void) => () => void) | undefined;
	private unsubscribeCapacity: (() => void) | undefined;
	private normalLaunchCount = 0;
	private normalLaunchTimer: ReturnType<typeof setTimeout> | undefined;
	private rateLimitLaunchTimer: ReturnType<typeof setTimeout> | undefined;
	private resolve: ((results: Array<SwarmBatchRunResult<T, R>>) => void) | undefined;
	private reject: ((error: unknown) => void) | undefined;
	private finished = false;
	private started = false;
	private rateLimitMode = false;
	private startedSuccessCount = 0;
	private rateLimitCapacity = 1;
	private lastRateLimitAt: number | undefined;
	private lastCapacityShrinkAt: number | undefined;
	private lastCapacityRecoveryAt: number | undefined;
	private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
	private nextRateLimitLaunchAt = 0;

	constructor(
		launcher: SwarmBatchLauncher<T, R>,
		tasks: readonly SwarmBatchTask<T>[],
		options: SwarmBatchOptions = {},
	) {
		this.launcher = launcher;
		if (
			options.maxConcurrency !== undefined &&
			(!Number.isInteger(options.maxConcurrency) || options.maxConcurrency <= 0)
		) {
			throw new Error(
				`SwarmBatch maxConcurrency must be a positive integer, got ${JSON.stringify(options.maxConcurrency)}.`,
			);
		}
		this.maxConcurrency = options.maxConcurrency;
		this.maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
		this.admit = options.admit;
		this.subscribeCapacity = options.subscribeCapacity;
		this.batchSignal = options.signal;
		this.isRateLimitError = options.isRateLimitError ?? defaultIsRateLimitError;
		this.isUserCancellation = options.isUserCancellation ?? isUserCancellation;
		this.states = tasks.map((task, index) => ({
			index,
			task,
			retryCount: 0,
			retryReadyAt: 0,
			started: false,
		}));
		this.pending = [...this.states];
		this.results = Array.from({ length: tasks.length });
		this.batchAbortListener = () => {
			this.controller.abort(this.batchSignal?.reason);
			if (this.isUserCancellation(this.batchSignal?.reason)) {
				this.finishWithUserCancellation();
			} else {
				this.fail(this.batchSignal?.reason ?? new Error("Aborted"));
			}
		};
	}

	run(): Promise<Array<SwarmBatchRunResult<T, R>>> {
		if (this.started) {
			throw new Error("SwarmBatch.run() can only be called once.");
		}
		this.started = true;

		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;

			if (this.states.length === 0) {
				this.finish([]);
				return;
			}

			if (this.batchSignal?.aborted === true) {
				this.batchAbortListener();
				return;
			}

			this.batchSignal?.addEventListener("abort", this.batchAbortListener, { once: true });
			this.unsubscribeCapacity = this.subscribeCapacity?.(() => this.schedule());
			this.schedule();
		});
	}

	private schedule(): void {
		if (this.finished) return;
		if (this.finishIfComplete()) return;
		if (this.controller.signal.aborted) return;

		if (this.rateLimitMode) {
			this.scheduleRateLimitLaunch();
		} else {
			this.scheduleNormalLaunch();
		}
	}

	private scheduleNormalLaunch(): void {
		while (
			this.normalLaunchCount < INITIAL_LAUNCH_LIMIT &&
			this.pending.length > 0 &&
			!this.rateLimitMode &&
			!this.isAtConcurrencyLimit()
		) {
			// No admissible task: a capacity notification reschedules.
			if (!this.launchNextAdmissible(() => true)) return;
			this.normalLaunchCount += 1;
		}

		if (
			this.pending.length === 0 ||
			this.rateLimitMode ||
			this.normalLaunchTimer !== undefined ||
			this.isAtConcurrencyLimit()
		) {
			return;
		}

		this.normalLaunchTimer = setTimeout(() => {
			this.normalLaunchTimer = undefined;
			if (this.finished || this.rateLimitMode || this.pending.length === 0) return;
			if (this.isAtConcurrencyLimit()) return;
			if (!this.launchNextAdmissible(() => true)) return;
			this.normalLaunchCount += 1;
			this.schedule();
		}, INITIAL_LAUNCH_INTERVAL_MS);
	}

	private isAtConcurrencyLimit(): boolean {
		return this.maxConcurrency !== undefined && this.active.size >= this.maxConcurrency;
	}

	private scheduleRateLimitLaunch(): void {
		this.clearRateLimitTimer();
		if (this.pending.length === 0) return;

		const now = Date.now();
		this.recoverRateLimitCapacity(now);
		if (this.isAtConcurrencyLimit() || this.isAtRateLimitCapacity()) {
			this.scheduleRateLimitWakeup(this.nextRateLimitCapacityRecoveryAt(), now);
			return;
		}

		const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
		const nextWakeupAt = Math.min(nextAllowedAt, this.nextRateLimitCapacityRecoveryAt());
		if (nextWakeupAt > now) {
			this.scheduleRateLimitWakeup(nextWakeupAt, now);
			return;
		}

		if (!this.launchNextAdmissible((state) => state.retryReadyAt <= now)) return;
		this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
		this.scheduleNextRateLimitWakeup(now);
	}

	/** The per-batch rate-limit capacity, unless a shared {@link SwarmBatchOptions.admit} gate replaces it. */
	private isAtRateLimitCapacity(): boolean {
		return this.admit === undefined && this.active.size >= this.rateLimitCapacity;
	}

	/** Launch the first pending task that is ready and admitted by the shared gate; false when none is. */
	private launchNextAdmissible(ready: (state: TaskState<T>) => boolean): boolean {
		for (const [index, state] of this.pending.entries()) {
			if (!ready(state)) continue;
			const release = this.admit === undefined ? () => {} : this.admit(state.task);
			if (release === undefined) continue;
			this.pending.splice(index, 1);
			this.startAttempt(state, release);
			return true;
		}
		return false;
	}

	private startAttempt(state: TaskState<T>, release: () => void): void {
		if (this.finished || this.controller.signal.aborted) {
			release();
			return;
		}

		const attempt: ActiveAttempt<T> = {
			state,
			controller: new AbortController(),
			release,
			cleanup: () => {},
			ready: false,
			timedOut: false,
		};
		attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
		this.active.add(attempt);

		// The shared slot is freed when the attempt's run actually ends, even after the batch finished.
		this.runAttempt(attempt).then(
			(outcome) => {
				attempt.release();
				this.handleAttemptOutcome(attempt, outcome);
			},
			(error) => {
				attempt.release();
				this.handleAttemptError(attempt, error);
			},
		);
	}

	private async runAttempt(attempt: ActiveAttempt<T>): Promise<AttemptOutcome<T, R>> {
		const task = attempt.state.task;
		const launchOptions: SwarmBatchAttemptLaunch<T> = {
			task,
			attempt: attempt.state.retryCount + 1,
			...(attempt.state.attemptId === undefined ? {} : { previousAttemptId: attempt.state.attemptId }),
			signal: attempt.controller.signal,
			onReady: () => {
				this.markAttemptReady(attempt);
			},
		};

		let handle: SwarmBatchAttemptHandle<R>;
		try {
			attempt.controller.signal.throwIfAborted();
			handle = await this.launcher.launch(launchOptions);
		} catch (error) {
			return this.failedAttemptOutcome(attempt, error);
		}

		attempt.state.attemptId = handle.id;
		try {
			const result = await handle.completion;
			return {
				task,
				attemptId: handle.id,
				status: "completed",
				result,
			};
		} catch (error) {
			if (this.isRateLimitError(error)) {
				return {
					type: "rate_limited",
					attemptId: handle.id,
					error: this.attemptErrorMessage(attempt, error, "failed"),
				};
			}

			return this.failedAttemptOutcome(attempt, error);
		}
	}

	private failedAttemptOutcome(attempt: ActiveAttempt<T>, error: unknown): SwarmBatchRunResult<T, R> {
		const status =
			attempt.controller.signal.aborted && this.isUserCancellation(attempt.controller.signal.reason)
				? "aborted"
				: "failed";
		return {
			task: attempt.state.task,
			...(attempt.state.attemptId === undefined ? {} : { attemptId: attempt.state.attemptId }),
			status,
			state: attempt.state.attemptId === undefined ? "not_started" : "started",
			error: this.attemptErrorMessage(attempt, error, status),
		};
	}

	private markAttemptReady(attempt: ActiveAttempt<T>): void {
		if (this.finished || attempt.ready || !this.active.has(attempt)) return;

		attempt.ready = true;
		attempt.state.started = true;
		if (!this.rateLimitMode) {
			this.startedSuccessCount += 1;
		}

		if (this.rateLimitMode) {
			this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
			this.nextRateLimitLaunchAt = Date.now() + this.globalRetryIntervalMs;
			this.schedule();
		}
	}

	private handleAttemptOutcome(attempt: ActiveAttempt<T>, outcome: AttemptOutcome<T, R>): void {
		if (!this.releaseAttempt(attempt)) return;
		if (this.finished) return;

		if ("status" in outcome) {
			this.results[attempt.state.index] = outcome;
		} else if (attempt.state.retryCount >= this.maxRateLimitRetries) {
			const error = `${outcome.error} (still rate limited after ${attempt.state.retryCount} retries)`;
			this.launcher.abandoned?.({
				task: attempt.state.task,
				attemptId: outcome.attemptId,
				outcome: "failed",
				error,
			});
			this.results[attempt.state.index] = {
				task: attempt.state.task,
				attemptId: outcome.attemptId,
				status: "failed",
				state: "started",
				error,
			};
		} else {
			this.requeueRateLimited(attempt, outcome.attemptId);
		}
		this.schedule();
	}

	private handleAttemptError(attempt: ActiveAttempt<T>, error: unknown): void {
		if (!this.releaseAttempt(attempt)) return;
		if (this.finished) return;
		this.results[attempt.state.index] = {
			task: attempt.state.task,
			...(attempt.state.attemptId === undefined ? {} : { attemptId: attempt.state.attemptId }),
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
		this.schedule();
	}

	private releaseAttempt(attempt: ActiveAttempt<T>): boolean {
		if (!this.active.delete(attempt)) return false;
		attempt.cleanup();
		return true;
	}

	private requeueRateLimited(attempt: ActiveAttempt<T>, attemptId: string): void {
		const state = attempt.state;
		this.launcher.suspended?.({
			task: state.task,
			attemptId,
			reason: RATE_LIMIT_SUSPENDED_REASON,
		});

		const now = Date.now();
		this.lastRateLimitAt = now;
		state.retryCount += 1;
		// `retry.createTimeout(attempt, { minTimeout: 3000, factor: 2, randomize: false })` without the dependency.
		const retryDelay = RATE_LIMIT_RETRY_BASE_MS * RATE_LIMIT_RETRY_FACTOR ** Math.max(0, state.retryCount - 1);
		state.retryReadyAt = now + retryDelay;
		this.pending.unshift(state);
		this.enterRateLimitMode(now);

		if (!attempt.ready) {
			this.globalRetryIntervalMs = Math.max(this.globalRetryIntervalMs * 2, retryDelay);
			this.nextRateLimitLaunchAt = Math.max(this.nextRateLimitLaunchAt, now + this.globalRetryIntervalMs);
		} else {
			this.nextRateLimitLaunchAt = Math.max(this.nextRateLimitLaunchAt, now + RATE_LIMIT_RETRY_BASE_MS);
		}
	}

	private enterRateLimitMode(now: number): void {
		if (!this.rateLimitMode) {
			this.rateLimitMode = true;
			this.clearNormalTimer();
			this.rateLimitCapacity = Math.max(1, this.startedSuccessCount);
			this.nextRateLimitLaunchAt = Math.max(this.nextRateLimitLaunchAt, now + RATE_LIMIT_RETRY_BASE_MS);
			this.shrinkRateLimitCapacity(now, true);
			return;
		}

		this.shrinkRateLimitCapacity(now, false);
	}

	private shrinkRateLimitCapacity(now: number, force: boolean): void {
		if (
			!force &&
			this.lastCapacityShrinkAt !== undefined &&
			now - this.lastCapacityShrinkAt < RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
		) {
			return;
		}

		this.rateLimitCapacity = Math.max(1, this.rateLimitCapacity - 1);
		this.lastCapacityShrinkAt = now;
	}

	private recoverRateLimitCapacity(now: number): void {
		const nextRecoveryAt = this.nextRateLimitCapacityRecoveryAt();
		if (nextRecoveryAt > now) return;

		this.rateLimitCapacity += 1;
		this.lastCapacityRecoveryAt = now;
		this.nextRateLimitLaunchAt = Math.min(this.nextRateLimitLaunchAt, now);
	}

	private nextRateLimitCapacityRecoveryAt(): number {
		if (this.pending.length === 0 || this.lastRateLimitAt === undefined) {
			return Number.POSITIVE_INFINITY;
		}

		const latestCapacityChangeAt = Math.max(this.lastRateLimitAt, this.lastCapacityRecoveryAt ?? 0);
		return latestCapacityChangeAt + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
	}

	private scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
		if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
		this.rateLimitLaunchTimer = setTimeout(() => {
			this.rateLimitLaunchTimer = undefined;
			this.schedule();
		}, wakeupAt - now);
	}

	private scheduleNextRateLimitWakeup(now: number): void {
		if (this.pending.length === 0) return;

		const nextWakeupAt =
			this.isAtConcurrencyLimit() || this.isAtRateLimitCapacity()
				? this.nextRateLimitCapacityRecoveryAt()
				: Math.min(
						Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt()),
						this.nextRateLimitCapacityRecoveryAt(),
					);

		this.scheduleRateLimitWakeup(nextWakeupAt, now);
	}

	private nextPendingReadyAt(): number {
		return this.pending.reduce((nextAt, state) => {
			return Math.min(nextAt, state.retryReadyAt);
		}, Number.POSITIVE_INFINITY);
	}

	private finishIfComplete(): boolean {
		if (this.results.every((result) => result !== undefined)) {
			this.finish(this.results as Array<SwarmBatchRunResult<T, R>>);
			return true;
		}
		return false;
	}

	private finishWithUserCancellation(): void {
		if (this.finished) return;
		this.abandonSuspended();

		this.finish(
			this.states.map((state): SwarmBatchRunResult<T, R> => {
				const result = this.results[state.index];
				if (result !== undefined) return result;

				if (state.started || state.attemptId !== undefined) {
					return {
						task: state.task,
						...(state.attemptId === undefined ? {} : { attemptId: state.attemptId }),
						status: "aborted",
						state: "started",
						error: "The user manually interrupted this subagent batch before this subagent finished.",
					};
				}

				return {
					task: state.task,
					status: "aborted",
					state: "not_started",
					error: "The user manually interrupted this subagent batch before this subagent was started.",
				};
			}),
		);
	}

	private finish(results: Array<SwarmBatchRunResult<T, R>>): void {
		if (this.finished) return;
		this.finished = true;
		this.cleanup();
		this.resolve?.(results);
	}

	private fail(error: unknown): void {
		if (this.finished) return;
		this.abandonSuspended();
		this.finished = true;
		this.cleanup();
		this.reject?.(error);
	}

	private abandonSuspended(): void {
		for (const state of this.pending) {
			if (state.attemptId === undefined) continue;
			this.launcher.abandoned?.({ task: state.task, attemptId: state.attemptId, outcome: "cancelled" });
		}
		for (const attempt of this.active) {
			if (attempt.ready) continue;
			const attemptId = attempt.state.attemptId;
			if (attemptId === undefined) continue;
			this.launcher.abandoned?.({ task: attempt.state.task, attemptId, outcome: "cancelled" });
		}
	}

	private cleanup(): void {
		this.batchSignal?.removeEventListener("abort", this.batchAbortListener);
		this.unsubscribeCapacity?.();
		this.clearNormalTimer();
		this.clearRateLimitTimer();
		for (const attempt of this.active.values()) {
			attempt.cleanup();
		}
		this.active.clear();
	}

	private clearNormalTimer(): void {
		if (this.normalLaunchTimer !== undefined) clearTimeout(this.normalLaunchTimer);
		this.normalLaunchTimer = undefined;
	}

	private clearRateLimitTimer(): void {
		if (this.rateLimitLaunchTimer !== undefined) clearTimeout(this.rateLimitLaunchTimer);
		this.rateLimitLaunchTimer = undefined;
	}

	private linkAttemptSignals(attempt: ActiveAttempt<T>, task: SwarmBatchTask<T>): () => void {
		const abortFromBatch = () => {
			attempt.controller.abort(this.controller.signal.reason);
		};
		const abortFromTask = () => {
			attempt.controller.abort(task.signal?.reason);
		};
		const timeout =
			task.timeout === undefined || task.timeout <= 0
				? undefined
				: setTimeout(
						() => {
							attempt.timedOut = true;
							attempt.controller.abort(new Error("Subagent timed out."));
						},
						Math.min(task.timeout, MAX_TIMER_DELAY_MS),
					);

		if (this.controller.signal.aborted) {
			abortFromBatch();
		} else if (task.signal?.aborted === true) {
			abortFromTask();
		} else {
			this.controller.signal.addEventListener("abort", abortFromBatch, { once: true });
			task.signal?.addEventListener("abort", abortFromTask, { once: true });
		}

		return () => {
			if (timeout !== undefined) clearTimeout(timeout);
			this.controller.signal.removeEventListener("abort", abortFromBatch);
			task.signal?.removeEventListener("abort", abortFromTask);
		};
	}

	private attemptErrorMessage(
		attempt: ActiveAttempt<T>,
		error: unknown,
		status: SwarmBatchRunResult<T, R>["status"],
	): string {
		if (attempt.timedOut && attempt.state.task.timeout !== undefined) {
			return "Subagent timed out.";
		}
		if (status === "aborted") return "The user manually interrupted this subagent batch.";
		return error instanceof Error ? error.message : String(error);
	}
}
