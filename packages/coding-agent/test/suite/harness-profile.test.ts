import { fauxAssistantMessage, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectLearningExtension } from "../../src/extensions/learning/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// Control-harness regression test: the "stock" profile must not leak Bling additions into a real request.
describe("harness profile", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runOnce(profile: "bling" | "stock") {
		const harness = await createHarness({
			settings: { harness: { profile } },
			extensionFactories: [createProjectLearningExtension()],
		});
		harnesses.push(harness);
		const prompts: string[] = [];
		harness.setResponses([
			(context: TranscriptContext) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");
		return { prompt: prompts[0] ?? "", tools: harness.session.getActiveToolNames() };
	}

	it("keeps Bling additions and project_memory by default profile", async () => {
		const { prompt, tools } = await runOnce("bling");
		expect(prompt).toContain("<verification_discipline>");
		expect(prompt).toContain("operating inside Bling Code");
		expect(prompt).toContain("project_memory");
		expect(tools).toContain("project_memory");
	});

	it("removes Bling additions and the project_memory tool for stock", async () => {
		const { prompt, tools } = await runOnce("stock");
		expect(prompt).not.toContain("<verification_discipline>");
		expect(prompt).not.toContain("Bling Code");
		expect(prompt).toContain("operating inside pi, a coding agent harness");
		expect(prompt).not.toContain("project_memory");
		expect(tools).not.toContain("project_memory");
	});
});
