import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CAPACITY_RECOVERY_INTERVAL_MS,
	CAPACITY_SHRINK_INTERVAL_MS,
	type CapacityEvent,
	type CapacityRelease,
	capacityKey,
	LAUNCH_PAUSE_MS,
	SubagentCapacity,
} from "../src/core/subagents/capacity.ts";

const HOST = capacityKey("openrouter", "inclusionai/ling-3.1-flash", "novita");
const OTHER = capacityKey("openrouter", "z-ai/glm-5.3-flash", "open-inference/fp4");

function setup() {
	let clock = 1_000_000;
	const events: CapacityEvent[] = [];
	const capacity = new SubagentCapacity({ now: () => clock, onEvent: (event) => events.push(event) });
	const take = (key = HOST, count = 1): CapacityRelease[] =>
		Array.from({ length: count }, () => {
			const release = capacity.tryAcquire(key);
			if (!release) throw new Error("expected a slot");
			return release;
		});
	return {
		capacity,
		events,
		take,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SubagentCapacity", () => {
	it("has no learned limit until a host rate limits", () => {
		const { capacity, take } = setup();
		take(HOST, 50);
		expect(capacity.snapshot(HOST)).toEqual({ key: HOST, running: 50 });
	});

	it("learns running minus one on the first rate limit and pauses only that host", () => {
		const { capacity, events, take } = setup();
		take(HOST, 4);
		capacity.reportRateLimited(HOST);
		expect(capacity.snapshot(HOST)).toMatchObject({ limit: 3, running: 4 });
		expect(capacity.snapshot(HOST).pausedUntil).toBeDefined();
		expect(capacity.tryAcquire(HOST)).toBeUndefined();
		expect(capacity.tryAcquire(OTHER)).toBeDefined();
		expect(events.map((event) => event.type)).toEqual(["limit_shrunk", "rate_limited"]);
	});

	it("lifts the pause on a success and then enforces the learned limit", () => {
		const { capacity, events, take } = setup();
		const [first, second, third] = take(HOST, 3);
		capacity.reportRateLimited(HOST);
		capacity.reportSuccess(HOST);
		expect(events.at(-1)?.type).toBe("pause_lifted");
		// Limit 2 with 3 running: nothing new until two finish.
		expect(capacity.tryAcquire(HOST)).toBeUndefined();
		first!();
		expect(capacity.tryAcquire(HOST)).toBeUndefined();
		second!();
		expect(capacity.tryAcquire(HOST)).toBeDefined();
		third!();
	});

	it("ends the pause on its own after LAUNCH_PAUSE_MS", () => {
		const { capacity, advance, take } = setup();
		const [first, second] = take(HOST, 2);
		capacity.reportRateLimited(HOST);
		first!();
		second!();
		expect(capacity.tryAcquire(HOST)).toBeUndefined();
		advance(LAUNCH_PAUSE_MS);
		expect(capacity.tryAcquire(HOST)).toBeDefined();
	});

	it("shrinks by one at most every shrink interval and recovers one per recovery interval", () => {
		const { capacity, advance, take } = setup();
		take(HOST, 6);
		capacity.reportRateLimited(HOST);
		expect(capacity.snapshot(HOST).limit).toBe(5);
		capacity.reportRateLimited(HOST);
		expect(capacity.snapshot(HOST).limit).toBe(5);
		advance(CAPACITY_SHRINK_INTERVAL_MS);
		capacity.reportRateLimited(HOST);
		expect(capacity.snapshot(HOST).limit).toBe(4);
		advance(CAPACITY_RECOVERY_INTERVAL_MS);
		expect(capacity.snapshot(HOST).limit).toBe(5);
	});

	it("waits for a released slot, refuses with a reason after the wait, and rejects on abort", async () => {
		vi.useFakeTimers();
		const { capacity, take } = setup();
		// Limit 1 learned with two running; the waiter gets a slot once both have finished.
		const [first, second] = take(HOST, 2);
		capacity.reportRateLimited(HOST);
		capacity.reportSuccess(HOST);
		first!();

		const waiting = capacity.acquire(HOST, 30_000);
		second!();
		expect(typeof (await waiting)).toBe("function");

		const refused = capacity.acquire(HOST, 30_000);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await refused).toEqual({ refused: expect.stringContaining("learned concurrency limit (1/1 running") });

		const controller = new AbortController();
		const aborted = capacity.acquire(HOST, 30_000, controller.signal);
		controller.abort(new Error("stop"));
		await expect(aborted).rejects.toThrow("stop");
	});

	it("wakes a waiter when a pause ends with nothing running", async () => {
		vi.useFakeTimers();
		let clock = 0;
		const capacity = new SubagentCapacity({ now: () => clock });
		const held = capacity.tryAcquire(HOST)!;
		capacity.reportRateLimited(HOST);
		held();
		const waiting = capacity.acquire(HOST, 2 * LAUNCH_PAUSE_MS);
		clock += LAUNCH_PAUSE_MS;
		await vi.advanceTimersByTimeAsync(LAUNCH_PAUSE_MS);
		expect(typeof (await waiting)).toBe("function");
		capacity.dispose();
	});
});
