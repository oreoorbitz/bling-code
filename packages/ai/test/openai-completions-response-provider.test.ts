import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

// Router/virtual ids (e.g. OpenRouter `auto`) keep `model` pinned to the
// requested id and surface the routed concrete id on `responseModel`.

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

function openRouterAuto(): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

const finishUsage = {
	prompt_tokens: 1,
	completion_tokens: 1,
	prompt_tokens_details: { cached_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 0 },
};

describe("openai-completions responseProvider", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("captures top-level chunk.provider as responseProvider", async () => {
		mockState.chunks = [
			{ id: "c1", provider: "Novita", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "c1",
				provider: "Novita",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: finishUsage,
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.responseProvider).toBe("Novita");
	});

	it("leaves responseProvider undefined when no chunk reports provider", async () => {
		mockState.chunks = [
			{ id: "c2", choices: [{ index: 0, delta: { content: "hi" } }] },
			{ id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: finishUsage },
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.responseProvider).toBeUndefined();
	});

	it("ignores empty and non-string chunk.provider values", async () => {
		mockState.chunks = [
			{ id: "c3", provider: "", choices: [{ index: 0, delta: { content: "hi" } }] },
			{ id: "c3", provider: 42, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: finishUsage },
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.responseProvider).toBeUndefined();
	});

	it("keeps the first non-empty provider when later chunks differ", async () => {
		mockState.chunks = [
			{ id: "c4", provider: "Novita", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "c4",
				provider: "DeepInfra",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: finishUsage,
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.responseProvider).toBe("Novita");
	});
});
