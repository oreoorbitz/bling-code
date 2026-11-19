import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { LING_PROFILES } from "../src/core/ling-models.ts";
import {
	extractImageUrls,
	fetchPromptImages,
	LING_VISION_MODEL_ID,
	needsVisionSwitch,
	pinnedVisionModel,
	VISION_FETCH_MAX_IMAGES,
} from "../src/core/ling-vision.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.close();
		await once(server, "close").catch(() => {});
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function lingModel(id: string, input: ("text" | "image")[]): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<Api>;
}

describe("extractImageUrls", () => {
	test("matches image extensions with query strings and fragments", () => {
		expect(extractImageUrls("see https://example.test/a.png?w=2#frag and http://x.test/b.JPG")).toEqual([
			"https://example.test/a.png?w=2#frag",
			"http://x.test/b.JPG",
		]);
	});

	test("strips trailing punctuation and deduplicates", () => {
		expect(extractImageUrls("(https://example.test/a.png), https://example.test/a.png.")).toEqual([
			"https://example.test/a.png",
		]);
	});

	test("ignores pages, extensionless URLs, and non-http schemes", () => {
		expect(
			extractImageUrls(
				"https://example.test/page https://example.test/img ftp://example.test/a.png data:image/png;base64,xx",
			),
		).toEqual([]);
	});

	test("caps the number of URLs", () => {
		const text = Array.from({ length: 10 }, (_, i) => `https://example.test/${i}.png`).join(" ");
		expect(extractImageUrls(text)).toHaveLength(VISION_FETCH_MAX_IMAGES);
		expect(extractImageUrls(text, 2)).toHaveLength(2);
	});
});

describe("needsVisionSwitch", () => {
	test("switches only OpenRouter Ling text models", () => {
		expect(needsVisionSwitch(lingModel("inclusionai/ling-3.1-flash", ["text"]))).toBe(true);
		expect(needsVisionSwitch(lingModel("inclusionai/ling-3.0-flash", ["text"]))).toBe(true);
		expect(needsVisionSwitch(undefined)).toBe(false);
	});

	test("leaves vision-capable, non-Ling, and self-hosted models alone", () => {
		expect(needsVisionSwitch(lingModel(LING_VISION_MODEL_ID, ["text", "image"]))).toBe(false);
		expect(needsVisionSwitch(lingModel("inclusionai/ling-3.0-flash-vl", ["text", "image"]))).toBe(false);
		expect(needsVisionSwitch(lingModel("openai/gpt-oss-20b", ["text"]))).toBe(false);
		const selfHosted = lingModel("Ling-3.1-flash", ["text"]);
		selfHosted.provider = "ling";
		expect(needsVisionSwitch(selfHosted)).toBe(false);
		const otherProvider = lingModel("inclusionai/ling-3.1-flash", ["text"]);
		otherProvider.provider = "custom";
		expect(needsVisionSwitch(otherProvider)).toBe(false);
	});
});

describe("fetchPromptImages", () => {
	async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
		const server = http.createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	test("attaches a fetched PNG and reports it", async () => {
		const base = await startServer((_req, res) => {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(TINY_PNG_BYTES);
		});
		const result = await fetchPromptImages([`${base}/a.png`]);
		expect(result.images).toHaveLength(1);
		expect(result.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.hints[0]).toContain("Fetched 1 image");
	});

	test("degrades failures to hints without failing", async () => {
		const base = await startServer((req, res) => {
			if (req.url === "/404.png") {
				res.writeHead(404).end();
			} else if (req.url === "/page.png") {
				res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
			} else if (req.url === "/junk.png") {
				res.writeHead(200, { "content-type": "image/png" }).end("not image bytes");
			} else {
				res.writeHead(200, { "content-type": "image/png", "content-length": "99999999" }).end("short");
			}
		});
		const result = await fetchPromptImages(
			[`${base}/404.png`, `${base}/page.png`, `${base}/junk.png`, `${base}/big.png`],
			{ maxBytes: 1024 },
		);
		expect(result.images).toEqual([]);
		expect(result.hints).toHaveLength(4);
		expect(result.hints.join("\n")).toContain("HTTP 404");
		expect(result.hints.join("\n")).toContain("not an image");
		expect(result.hints.join("\n")).toContain("exceeds size limit");
	});

	test("times out a hanging server", async () => {
		const base = await startServer(() => {});
		const result = await fetchPromptImages([`${base}/slow.png`], { timeoutMs: 50 });
		expect(result.images).toEqual([]);
		expect(result.hints.join("\n")).toContain("timed out");
	});
});

describe("automatic vision switch in AgentSession", () => {
	const streamFn: StreamFn = (model) => {
		const stream = createAssistantMessageEventStream();
		const message = { ...fauxAssistantMessage("done"), model: model.id };
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};

	async function createVisionSession(options?: { startingModelId?: string; autoVisionSwitch?: boolean }) {
		const dir = await mkdtemp(join(tmpdir(), "ling-vision-"));
		tempDirs.push(dir);
		const credentials = AuthStorage.inMemory();
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: join(dir, "models.json"),
			allowModelNetwork: false,
		});
		const model = modelRuntime.getModel(
			"openrouter",
			options?.startingModelId ?? LING_PROFILES["3.1"].openRouterModelId,
		);
		if (!model) throw new Error("starting model missing from catalog");
		const settingsManager = SettingsManager.create(dir, dir);
		if (options?.autoVisionSwitch === false) {
			settingsManager.applyOverrides({ images: { autoVisionSwitch: false } });
		}
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn,
			initialState: { model, systemPrompt: "Be concise.", tools: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: dir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	/** Model of each assistant message: the model that served it. */
	function servedModelIds(session: AgentSession): string[] {
		return session.messages.flatMap((entry) => (entry.role === "assistant" ? [entry.model] : []));
	}

	function userText(session: AgentSession): string {
		const message = session.messages.find((entry) => entry.role === "user");
		if (!message || typeof message.content === "string") return "";
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}

	test("switches a Ling text session to 3.2 when images are attached", async () => {
		const session = await createVisionSession();
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 }];

		await session.prompt("describe this", { images });
		await session.agent.waitForIdle();

		expect(servedModelIds(session)).toEqual([LING_VISION_MODEL_ID]);
		expect(session.model?.id).toBe(LING_PROFILES["3.1"].openRouterModelId);
		expect(userText(session)).toContain(
			`[Switched to openrouter/${LING_VISION_MODEL_ID} for this image turn; the session returns to openrouter/${LING_PROFILES["3.1"].openRouterModelId} afterwards.]`,
		);
		session.dispose();
	});

	test("fetches an image link, attaches it, and switches", async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(TINY_PNG_BYTES);
		});
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/shot.png`;

		const session = await createVisionSession();
		await session.prompt(`what is in ${url} ?`);
		await session.agent.waitForIdle();

		expect(servedModelIds(session)).toEqual([LING_VISION_MODEL_ID]);
		expect(userText(session)).toContain("[Fetched 1 image from links.]");
		session.dispose();
	});

	test("leaves text-only turns on the starting model", async () => {
		const session = await createVisionSession();
		await session.prompt("reply concisely");
		await session.agent.waitForIdle();

		expect(session.model?.id).toBe(LING_PROFILES["3.1"].openRouterModelId);
		session.dispose();
	});

	test("honors the autoVisionSwitch toggle", async () => {
		const session = await createVisionSession({ autoVisionSwitch: false });
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 }];

		await session.prompt("describe this", { images });
		await session.agent.waitForIdle();

		expect(session.model?.id).toBe(LING_PROFILES["3.1"].openRouterModelId);
		session.dispose();
	});
});

describe("pinnedVisionModel", () => {
	const vision = {
		id: LING_PROFILES["3.2"].openRouterModelId,
		provider: "openrouter",
		input: ["text", "image"],
	} as unknown as Model<Api>;

	test("adds the 3.2 profile pin and sampling when models.json sets none", () => {
		const pinned = pinnedVisionModel(vision);
		expect((pinned.compat as { openRouterRouting?: unknown }).openRouterRouting).toEqual({
			only: [LING_PROFILES["3.2"].openRouterUpstream],
			allow_fallbacks: false,
		});
		expect(pinned.samplingParams).toEqual(LING_PROFILES["3.2"].samplingParams);
	});

	test("keeps a configured pin and sampling", () => {
		const configured = {
			...vision,
			samplingParams: { temperature: 0.5 },
			compat: { openRouterRouting: { only: ["other"], allow_fallbacks: false } },
		} as unknown as Model<Api>;
		const pinned = pinnedVisionModel(configured);
		expect((pinned.compat as { openRouterRouting?: unknown }).openRouterRouting).toEqual({
			only: ["other"],
			allow_fallbacks: false,
		});
		expect(pinned.samplingParams).toEqual({ temperature: 0.5 });
	});
});
