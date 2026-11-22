/**
 * Session-wide subagent concurrency, learned per host from provider rate limits. Ported from Kimi's
 * `RateLimitCapacityGovernor` and `TowerRateLimitService` (agent-core-v2 `features/tower`), with two
 * differences: capacity is kept per host (a model on one pinned upstream) rather than globally, because
 * hosts throttle independently, and every subagent request reports its result, which Kimi left unwired.
 *
 * A host starts with no learned limit (only {@link MAX_RUNNING_PER_HOST}). The first rate limit sets
 * the limit to the number of runs in flight minus one and pauses new launches on that host; a success
 * lifts the pause early, later rate limits shrink the limit by one at most every
 * {@link CAPACITY_SHRINK_INTERVAL_MS}, and quiet periods grow it back by one every
 * {@link CAPACITY_RECOVERY_INTERVAL_MS}.
 */

export const CAPACITY_SHRINK_INTERVAL_MS = 2_000;
export const CAPACITY_RECOVERY_INTERVAL_MS = 180_000;
export const LAUNCH_PAUSE_MS = 60_000;
export const MAX_RUNNING_PER_HOST = 256;

/** The capacity key of a role: provider, model, and pinned upstream, e.g. `openrouter/inclusionai/ling-3.1-flash@novita`. */
export function capacityKey(provider: string, model: string, upstream: string | undefined): string {
	return `${provider}/${model}@${upstream ?? "any"}`;
}

/** What Ling and the ledger see of one host's capacity. */
export interface CapacitySnapshot {
	key: string;
	/** Learned limit; undefined until the host has rate limited (then only the hard ceiling applies). */
	limit?: number;
	running: number;
	/** Launches on this host wait until this time (epoch ms) unless a success lifts the pause first. */
	pausedUntil?: number;
}

export type CapacityEventType = "rate_limited" | "limit_shrunk" | "limit_recovered" | "pause_lifted";

/** One change of a host's capacity, for the ledger. */
export interface CapacityEvent extends CapacitySnapshot {
	type: CapacityEventType;
	at: number;
}

interface HostState {
	key: string;
	limit: number;
	running: number;
	pausedUntil: number | undefined;
	lastRateLimitAt: number | undefined;
	lastShrinkAt: number | undefined;
	lastRecoveryAt: number | undefined;
	wakeup: ReturnType<typeof setTimeout> | undefined;
}

export interface SubagentCapacityOptions {
	now?: () => number;
	/** Launch pause after a rate limit; defaults to {@link LAUNCH_PAUSE_MS}. */
	pauseMs?: number;
	onEvent?: (event: CapacityEvent) => void;
}

/** A held slot. Releasing twice is harmless. */
export type CapacityRelease = () => void;

export class SubagentCapacity {
	private readonly hosts = new Map<string, HostState>();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly pauseMs: number;
	private readonly onEvent: ((event: CapacityEvent) => void) | undefined;

	constructor(options: SubagentCapacityOptions = {}) {
		this.now = options.now ?? Date.now;
		this.pauseMs = options.pauseMs ?? LAUNCH_PAUSE_MS;
		this.onEvent = options.onEvent;
	}

	/** Take a slot on `key` now, or return undefined when the host is paused or at its limit. */
	tryAcquire(key: string): CapacityRelease | undefined {
		const host = this.host(key);
		this.recover(host);
		const now = this.now();
		if (host.pausedUntil !== undefined && now < host.pausedUntil) return undefined;
		if (host.pausedUntil !== undefined) this.liftPause(host);
		if (host.running >= Math.min(host.limit, MAX_RUNNING_PER_HOST)) return undefined;
		host.running += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			host.running = Math.max(0, host.running - 1);
			this.notify();
		};
	}

	/**
	 * Wait for a slot on `key` for at most `maxWaitMs`. Resolves with the release function, or with
	 * the reason the slot was refused (shown to Ling). Rejects only when `signal` aborts.
	 */
	acquire(key: string, maxWaitMs: number, signal?: AbortSignal): Promise<CapacityRelease | { refused: string }> {
		const immediate = this.tryAcquire(key);
		if (immediate) return Promise.resolve(immediate);
		return new Promise((resolve, reject) => {
			const settle = () => {
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				settle();
				reject(signal?.reason ?? new Error("Aborted"));
			};
			const unsubscribe = this.subscribe(() => {
				const release = this.tryAcquire(key);
				if (!release) return;
				settle();
				resolve(release);
			});
			const timer = setTimeout(() => {
				settle();
				resolve({ refused: this.refusalReason(key, maxWaitMs) });
			}, maxWaitMs);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** A run on `key` hit a provider rate limit. Call while its slot is still held. */
	reportRateLimited(key: string): void {
		const host = this.host(key);
		const now = this.now();
		if (host.running > 0) {
			if (host.lastRateLimitAt === undefined) {
				host.limit = Math.max(1, host.running - 1);
				host.lastShrinkAt = now;
				this.emit("limit_shrunk", host);
			} else if (host.lastShrinkAt === undefined || now - host.lastShrinkAt >= CAPACITY_SHRINK_INTERVAL_MS) {
				if (host.limit > 1) {
					host.limit -= 1;
					host.lastShrinkAt = now;
					this.emit("limit_shrunk", host);
				}
			}
		}
		host.lastRateLimitAt = now;
		host.pausedUntil = now + this.pauseMs;
		this.emit("rate_limited", host);
		this.scheduleWakeup(host);
	}

	/** A request on `key` got a response: lifts a launch pause early and lets the limit recover on schedule. */
	reportSuccess(key: string): void {
		const host = this.host(key);
		if (host.pausedUntil !== undefined) this.liftPause(host);
		this.recover(host);
		this.notify();
	}

	snapshot(key: string): CapacitySnapshot {
		const host = this.host(key);
		this.recover(host);
		return this.snapshotOf(host);
	}

	/** Called whenever a slot may have become available. Returns the unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		// Nothing else wakes a waiter on a paused host with no runs in flight.
		for (const host of this.hosts.values()) if (host.wakeup === undefined) this.scheduleWakeup(host);
		return () => this.listeners.delete(listener);
	}

	/** Stop all timers (session end). Learned limits are kept. */
	dispose(): void {
		for (const host of this.hosts.values()) {
			if (host.wakeup !== undefined) clearTimeout(host.wakeup);
			host.wakeup = undefined;
		}
		this.listeners.clear();
	}

	private refusalReason(key: string, waitedMs: number): string {
		const snapshot = this.snapshot(key);
		const seconds = Math.round(waitedMs / 1000);
		if (snapshot.pausedUntil !== undefined) {
			const resume = Math.max(0, Math.ceil((snapshot.pausedUntil - this.now()) / 1000));
			return `${key} rate limited recently; new subagents on it are paused for about ${resume}s more (waited ${seconds}s). A successful request lifts the pause early. Wait for running subagents, or retry later.`;
		}
		return `${key} is at its learned concurrency limit (${snapshot.running}/${snapshot.limit ?? MAX_RUNNING_PER_HOST} running; waited ${seconds}s). Wait for running subagents to finish, then retry.`;
	}

	private host(key: string): HostState {
		let host = this.hosts.get(key);
		if (!host) {
			host = {
				key,
				limit: Number.POSITIVE_INFINITY,
				running: 0,
				pausedUntil: undefined,
				lastRateLimitAt: undefined,
				lastShrinkAt: undefined,
				lastRecoveryAt: undefined,
				wakeup: undefined,
			};
			this.hosts.set(key, host);
		}
		return host;
	}

	private recover(host: HostState): void {
		if (host.lastRateLimitAt === undefined || host.limit === Number.POSITIVE_INFINITY) return;
		const now = this.now();
		if (this.nextRecoveryAt(host) > now) return;
		host.limit += 1;
		host.lastRecoveryAt = now;
		if (host.limit >= MAX_RUNNING_PER_HOST) {
			// Fully recovered: forget the rate limit, as if the host had never throttled.
			host.limit = Number.POSITIVE_INFINITY;
			host.lastRateLimitAt = undefined;
			host.lastShrinkAt = undefined;
			host.lastRecoveryAt = undefined;
		}
		this.emit("limit_recovered", host);
	}

	private nextRecoveryAt(host: HostState): number {
		if (host.lastRateLimitAt === undefined) return Number.POSITIVE_INFINITY;
		return Math.max(host.lastRateLimitAt, host.lastRecoveryAt ?? 0) + CAPACITY_RECOVERY_INTERVAL_MS;
	}

	private liftPause(host: HostState): void {
		host.pausedUntil = undefined;
		this.emit("pause_lifted", host);
	}

	/** Wake waiters when the pause ends or the limit is due to recover, whichever comes first. */
	private scheduleWakeup(host: HostState): void {
		if (host.wakeup !== undefined) clearTimeout(host.wakeup);
		host.wakeup = undefined;
		const at = Math.min(host.pausedUntil ?? Number.POSITIVE_INFINITY, this.nextRecoveryAt(host));
		if (!Number.isFinite(at)) return;
		host.wakeup = setTimeout(
			() => {
				host.wakeup = undefined;
				this.recover(host);
				this.notify();
				// Recovery is otherwise lazy; keep a timer only while someone waits.
				if (this.listeners.size > 0) this.scheduleWakeup(host);
			},
			Math.max(0, at - this.now()),
		);
		host.wakeup.unref?.();
	}

	private snapshotOf(host: HostState): CapacitySnapshot {
		return {
			key: host.key,
			...(host.limit === Number.POSITIVE_INFINITY ? {} : { limit: host.limit }),
			running: host.running,
			...(host.pausedUntil === undefined ? {} : { pausedUntil: host.pausedUntil }),
		};
	}

	private emit(type: CapacityEventType, host: HostState): void {
		this.onEvent?.({ type, at: this.now(), ...this.snapshotOf(host) });
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
