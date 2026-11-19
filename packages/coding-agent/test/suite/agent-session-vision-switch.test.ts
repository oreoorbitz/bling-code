import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LING_PROFILES } from "../../src/core/ling-models.ts";
import { createHarness, type Harness } from "./harness.ts";

const processImage = vi.hoisted(() =>
	vi.fn(async (_bytes: Uint8Array, mimeType: string) => ({
		ok: true as const,
		data: Buffer.from("normalized").toString("base64"),
		mimeType,
		hints: [],
	})),
);
vi.mock("../../src/utils/image-process.ts", () => ({ processImage }));

const LING_31 = LING_PROFILES["3.1"].openRouterModelId;
const LING_32 = LING_PROFILES["3.2"].openRouterModelId;
const IMAGE = { type: "image" as const, mimeType: "image/png", data: "ZmFrZQ==" };

describe("automatic vision switch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function lingHarness(): Promise<Harness> {
		const harness = await createHarness({
			provider: "openrouter",
			models: [
				{ id: LING_31, input: ["text"] },
				{ id: LING_32, input: ["text", "image"] },
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it("serves only the image turn with pinned Ling 3.2, then returns to the configured model", async () => {
		const harness = await lingHarness();
		const served: Model<string>[] = [];
		const record = (_context: unknown, _options: unknown, _state: unknown, model: Model<string>) => {
			served.push(model);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([record, record]);

		await harness.session.prompt("what is in this picture?", { images: [IMAGE] });
		await harness.session.prompt("thanks, now plain text");

		expect(served.map((model) => model.id)).toEqual([LING_32, LING_31]);
		// The switched request carries the 3.2 profile's pin and sampling, not unpinned catalog routing.
		expect((served[0]!.compat as { openRouterRouting?: unknown } | undefined)?.openRouterRouting).toEqual({
			only: [LING_PROFILES["3.2"].openRouterUpstream],
			allow_fallbacks: false,
		});
		expect(served[0]!.samplingParams).toEqual(LING_PROFILES["3.2"].samplingParams);
		expect(harness.session.model?.id).toBe(LING_31);
		// Both switches are recorded, so a resumed session restores the configured model.
		const changes = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "model_change")
			.map((entry) => (entry as { modelId: string }).modelId);
		expect(changes.slice(-2)).toEqual([LING_32, LING_31]);
		expect(harness.settingsManager.getDefaultModel()).not.toBe(LING_32);
	});

	it("does not switch when autoVisionSwitch is off", async () => {
		const harness = await lingHarness();
		harness.settingsManager.applyOverrides({ images: { autoVisionSwitch: false } });
		const served: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				served.push(model.id);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("what is in this picture?", { images: [IMAGE] });

		expect(served).toEqual([LING_31]);
	});
});
