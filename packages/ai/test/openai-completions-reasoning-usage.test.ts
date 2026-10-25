import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterModel(): Model<"openai-completions"> {
	return {
		id: "inclusionai/ling-3.1-flash",
		name: "Ling",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

async function usageFor(usage: unknown) {
	mockState.chunks = [
		{ id: "c1", choices: [{ index: 0, delta: { content: "hi" } }] },
		{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
	];
	const message = await complete(
		openRouterModel(),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test" },
	);
	return message.usage;
}

describe("openai-completions reasoning token usage", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("reads completion_tokens_details.reasoning_tokens as a subset of output", async () => {
		const usage = await usageFor({
			prompt_tokens: 10,
			completion_tokens: 100,
			completion_tokens_details: { reasoning_tokens: 60 },
		});
		expect(usage.output).toBe(100);
		expect(usage.reasoning).toBe(60);
		expect(usage.totalTokens).toBe(110);
	});

	it("keeps an explicit zero distinct from not reported", async () => {
		const zero = await usageFor({
			prompt_tokens: 10,
			completion_tokens: 5,
			completion_tokens_details: { reasoning_tokens: 0 },
		});
		expect(zero.reasoning).toBe(0);
		const absent = await usageFor({ prompt_tokens: 10, completion_tokens: 5 });
		expect("reasoning" in absent).toBe(false);
	});
});
