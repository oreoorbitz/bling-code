import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

// Bling pins subagent roles to one OpenRouter upstream; the pin is only real if every routing field reaches the
// request body as the OpenRouter `provider` object.

const mockState = vi.hoisted(() => ({
	params: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: Record<string, unknown>) => {
					mockState.params = params;
					const chunks = [
						{ id: "c1", choices: [{ index: 0, delta: { content: "ok" } }] },
						{
							id: "c1",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 1, completion_tokens: 1 },
						},
					];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function pinnedModel(): Model<"openai-completions"> {
	return {
		id: "z-ai/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		compat: {
			openRouterRouting: {
				only: ["wafer/nvfp4"],
				allow_fallbacks: false,
				require_parameters: true,
				zdr: true,
				data_collection: "deny",
			},
		},
	};
}

describe("openai-completions OpenRouter routing", () => {
	beforeEach(() => {
		mockState.params = undefined;
	});

	it("sends every routing field as the request body provider object", async () => {
		await complete(
			pinnedModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(mockState.params?.provider).toEqual({
			only: ["wafer/nvfp4"],
			allow_fallbacks: false,
			require_parameters: true,
			zdr: true,
			data_collection: "deny",
		});
	});
});
