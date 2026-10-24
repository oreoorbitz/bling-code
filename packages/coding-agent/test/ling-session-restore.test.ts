import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Ling session model restore", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "ling-session-restore-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function setup(sessionModel = { provider: "ling", model: "Ling-3.1-flash" }) {
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(fauxProvider({ models: [{ id: "fallback", input: ["text"] }] }).provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		sessionManager.appendMessage({
			...fauxAssistantMessage("previous Ling answer"),
			api: "openai-completions",
			...sessionModel,
		});
		return { modelRuntime, sessionManager };
	}

	it("does not fall through to an authenticated non-Ling provider", async () => {
		const { modelRuntime, sessionManager } = await setup();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());

		expect(session.model?.provider).not.toBe("faux");
		expect(modelFallbackMessage).toContain("Could not restore model ling/Ling-3.1-flash");
		expect(modelFallbackMessage).not.toContain("faux/fallback");
	});

	it("does not fall through when an OpenRouter Ling session is unauthenticated", async () => {
		const { modelRuntime, sessionManager } = await setup({
			provider: "openrouter",
			model: "inclusionai/ling-3.1-flash",
		});
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());

		expect(session.model?.provider).not.toBe("faux");
		expect(modelFallbackMessage).toContain("Could not restore model openrouter/inclusionai/ling-3.1-flash");
	});

	it("allows an explicit non-Ling override on resume", async () => {
		const { modelRuntime, sessionManager } = await setup();
		const explicit = modelRuntime.getModel("faux", "fallback");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: explicit,
			modelRuntime,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());

		expect(session.model).toBe(explicit);
	});
});
