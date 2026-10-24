import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowNetwork } from "./test-network-env.ts";

const MODEL_ID = "inclusionai/ling-3.1-flash";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const readTool: Tool = {
	name: "read",
	description: "Read a file from disk",
	parameters: Type.Object({ path: Type.String() }),
};

/** Mirrors the provider entry written by `bling configure` (see src/cli/ling-configure.ts). */
function lingModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: MODEL_ID,
		name: "Ling 3.1 Flash",
		api: "openai-completions",
		provider: "ling",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "qwen-chat-template",
		},
		samplingParams: { temperature: 1, top_p: 0.95, top_k: 20 },
	};
}

interface ChatCompletionChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: Record<string, unknown>;
		finish_reason: string | null;
	}>;
	usage?: { prompt_tokens: number; completion_tokens: number };
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): ChatCompletionChunk {
	return {
		id: "chatcmpl-ling-test",
		object: "chat.completion.chunk",
		created: 0,
		model: MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

interface ChatCompletionsRequestBody {
	model: string;
	messages: Array<Record<string, unknown>>;
	stream: boolean;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	chat_template_kwargs?: Record<string, unknown>;
	tools?: Array<{ type: string; function: { name: string } }>;
}

interface MockLingServer {
	port: number;
	requestBodies: ChatCompletionsRequestBody[];
	close: () => Promise<void>;
}

/** Local stand-in for a Ling OpenAI-compatible endpoint. Each POST consumes the next chunk set. */
async function startMockLingServer(chunkSets: ChatCompletionChunk[][]): Promise<MockLingServer> {
	const requestBodies: ChatCompletionsRequestBody[] = [];
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/chat/completions") {
			res.writeHead(404).end();
			return;
		}

		let body = "";
		for await (const part of req) {
			body += part.toString();
		}
		requestBodies.push(JSON.parse(body) as ChatCompletionsRequestBody);

		const chunks = chunkSets.shift();
		if (!chunks) {
			res.writeHead(500).end("unexpected extra request");
			return;
		}

		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const chunkData of chunks) {
			res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;

	return {
		port,
		requestBodies,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
	const done = events.at(-1);
	if (done?.type !== "done") {
		throw new Error(`expected done event, got ${done?.type}`);
	}
	return done.message;
}

const reasoningThenToolCallChunks: ChatCompletionChunk[] = [
	chunk({ role: "assistant", reasoning_content: "I need to read the file." }),
	chunk({ reasoning_content: " Calling read now." }),
	chunk({
		tool_calls: [
			{
				index: 0,
				id: "call_read_1",
				type: "function",
				function: { name: "read", arguments: '{"path":' },
			},
		],
	}),
	chunk({
		tool_calls: [{ index: 0, function: { arguments: '"/tmp/notes.txt"}' } }],
	}),
	{ ...chunk({}, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 9 } },
];

describe("ling openai-compatible endpoint", () => {
	beforeEach(() => {
		allowNetwork();
	});

	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("sends qwen chat-template thinking kwargs and ling sampling params, parses reasoning_content and tool_calls", async () => {
		const server = await startMockLingServer([[...reasoningThenToolCallChunks], [...reasoningThenToolCallChunks]]);
		try {
			const model = lingModel(`http://127.0.0.1:${server.port}`);
			const context = normalizeContext({
				messages: [{ role: "user", content: "read /tmp/notes.txt", timestamp: 1 }],
				tools: [readTool],
			} satisfies Context);

			const events = await collectEvents(
				streamOpenAICompletions(model, context, {
					apiKey: "test-key",
					reasoningEffort: "high",
					maxTokens: 8192,
				}),
			);

			expect(server.requestBodies).toHaveLength(1);
			const body = server.requestBodies[0];
			expect(body.model).toBe(MODEL_ID);
			expect(body.stream).toBe(true);
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
			expect(body.temperature).toBe(1);
			expect(body.top_p).toBe(0.95);
			expect(body.top_k).toBe(20);
			expect(body.max_tokens).toBe(8192);
			expect(body.max_completion_tokens).toBeUndefined();
			expect(body.tools?.map((tool) => tool.function.name)).toEqual(["read"]);

			const thinkingDeltas = events.flatMap((event) => (event.type === "thinking_delta" ? [event.delta] : []));
			expect(thinkingDeltas).toEqual(["I need to read the file.", " Calling read now."]);

			const message = doneMessage(events);
			expect(message.stopReason).toBe("toolUse");
			const thinking = message.content.find((block) => block.type === "thinking") as ThinkingContent;
			expect(thinking.thinking).toBe("I need to read the file. Calling read now.");
			expect(thinking.thinkingSignature).toBe("reasoning_content");
			const toolCall = message.content.find((block) => block.type === "toolCall") as ToolCall;
			expect(toolCall.id).toBe("call_read_1");
			expect(toolCall.name).toBe("read");
			expect(toolCall.arguments).toEqual({ path: "/tmp/notes.txt" });
			expect(message.usage.input).toBe(12);
			expect(message.usage.output).toBe(9);

			// Without a reasoning effort the same endpoint must get enable_thinking: false.
			await collectEvents(streamOpenAICompletions(model, context, { apiKey: "test-key", maxTokens: 8192 }));
			expect(server.requestBodies).toHaveLength(2);
			expect(server.requestBodies[1].chat_template_kwargs).toEqual({
				enable_thinking: false,
				preserve_thinking: true,
			});
		} finally {
			await server.close();
		}
	});

	it("streams a final text answer after a tool result round-trip", async () => {
		const finalAnswerChunks: ChatCompletionChunk[] = [
			chunk({ role: "assistant", content: "The file " }),
			chunk({ content: "says hello." }),
			{ ...chunk({}, "stop"), usage: { prompt_tokens: 30, completion_tokens: 5 } },
		];
		const server = await startMockLingServer([finalAnswerChunks]);
		try {
			const model = lingModel(`http://127.0.0.1:${server.port}`);
			const priorAssistant: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "I need to read the file. Calling read now.",
						thinkingSignature: "reasoning_content",
					},
					{ type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "/tmp/notes.txt" } },
				],
				api: "openai-completions",
				provider: "ling",
				model: MODEL_ID,
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: 2,
			};
			const context = normalizeContext({
				messages: [
					{ role: "user", content: "read /tmp/notes.txt", timestamp: 1 },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_read_1",
						toolName: "read",
						content: [{ type: "text", text: "hello" }],
						isError: false,
						timestamp: 3,
					},
				],
				tools: [readTool],
			} satisfies Context);

			const events = await collectEvents(
				streamOpenAICompletions(model, context, {
					apiKey: "test-key",
					reasoningEffort: "high",
					maxTokens: 8192,
				}),
			);

			expect(server.requestBodies).toHaveLength(1);
			const messages = server.requestBodies[0].messages;
			expect(messages[1]).toMatchObject({
				role: "assistant",
				reasoning_content: "I need to read the file. Calling read now.",
				tool_calls: [
					{
						id: "call_read_1",
						type: "function",
						function: { name: "read", arguments: '{"path":"/tmp/notes.txt"}' },
					},
				],
			});
			expect(messages[2]).toEqual({ role: "tool", content: "hello", tool_call_id: "call_read_1" });

			const message = doneMessage(events);
			expect(message.stopReason).toBe("stop");
			const text = message.content.find((block) => block.type === "text") as TextContent;
			expect(text.text).toBe("The file says hello.");
			expect(message.content.some((block) => block.type === "toolCall")).toBe(false);
		} finally {
			await server.close();
		}
	});
});
