import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { processImage } from "../utils/image-process.ts";
import { isLingModelRef, LING_OPENROUTER_PROVIDER_ID, LING_PROFILES } from "./ling-models.ts";

/** OpenRouter model id used for the automatic vision switch. */
export const LING_VISION_MODEL_ID = LING_PROFILES["3.2"].openRouterModelId;

/** Per-request timeout for fetching linked images. */
export const VISION_FETCH_TIMEOUT_MS = 15_000;
/** Largest single fetched image, before pipeline resize. */
export const VISION_FETCH_MAX_BYTES = 20_000_000;
/** Most linked images fetched for one prompt. */
export const VISION_FETCH_MAX_IMAGES = 5;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
const IMAGE_PATH_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/**
 * Image-looking http(s) URLs in prompt text, deduplicated and capped. Only paths with an image
 * extension qualify; extensionless URLs (photo pages, API responses) are left as text so ordinary
 * links never trigger downloads.
 */
export function extractImageUrls(text: string, max: number = VISION_FETCH_MAX_IMAGES): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(URL_PATTERN)) {
		if (urls.length >= max) break;
		const raw = match[0].replace(/[.,;:!?]+$/, "");
		let pathname: string;
		try {
			pathname = new URL(raw).pathname.toLowerCase();
		} catch {
			continue;
		}
		const dot = pathname.lastIndexOf(".");
		if (dot < 0 || dot < pathname.lastIndexOf("/")) continue;
		if (!IMAGE_PATH_EXTENSIONS.has(pathname.slice(dot + 1))) continue;
		if (seen.has(raw)) continue;
		seen.add(raw);
		urls.push(raw);
	}
	return urls;
}

async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) return undefined;
	const reader = response.body?.getReader();
	if (!reader) return undefined;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export interface FetchedPromptImages {
	images: ImageContent[];
	hints: string[];
}

export interface FetchPromptImagesOptions {
	timeoutMs?: number;
	maxBytes?: number;
	autoResizeImages?: boolean;
}

/**
 * Download image URLs as prompt attachments. Every failure degrades to a hint; a failed fetch
 * never fails the prompt. Responses must be images, arrive within the timeout, and fit the byte
 * cap, then pass through the standard image pipeline (format normalization and resize).
 */
export async function fetchPromptImages(
	urls: readonly string[],
	options?: FetchPromptImagesOptions,
): Promise<FetchedPromptImages> {
	const timeoutMs = options?.timeoutMs ?? VISION_FETCH_TIMEOUT_MS;
	const maxBytes = options?.maxBytes ?? VISION_FETCH_MAX_BYTES;
	const images: ImageContent[] = [];
	const hints: string[] = [];
	for (const url of urls.slice(0, VISION_FETCH_MAX_IMAGES)) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (!response.ok) {
				hints.push(`[Could not fetch image from ${url}: HTTP ${response.status}.]`);
				continue;
			}
			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
			if (!contentType.startsWith("image/")) {
				hints.push(`[Could not fetch image from ${url}: not an image.]`);
				continue;
			}
			const bytes = await readCappedBytes(response, maxBytes);
			if (!bytes) {
				hints.push(`[Could not fetch image from ${url}: exceeds size limit.]`);
				continue;
			}
			const processed = await processImage(bytes, contentType, {
				autoResizeImages: options?.autoResizeImages ?? true,
			});
			if (!processed.ok) {
				hints.push(`[Could not fetch image from ${url}: ${processed.message}]`);
				continue;
			}
			images.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		} catch (error) {
			const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "request failed";
			hints.push(`[Could not fetch image from ${url}: ${reason}.]`);
		}
	}
	if (images.length > 0) {
		hints.unshift(`[Fetched ${images.length} image${images.length === 1 ? "" : "s"} from links.]`);
	}
	return { images, hints };
}

/**
 * Whether the session model needs the automatic vision switch: an OpenRouter Ling model without
 * image input. Other providers, explicit non-Ling models, and self-hosted endpoints are never
 * switched; their image handling is unchanged.
 */
export function needsVisionSwitch(model: Model<Api> | undefined): boolean {
	if (!model || model.provider !== LING_OPENROUTER_PROVIDER_ID) return false;
	if (!isLingModelRef(model.provider, model.id)) return false;
	return !model.input.includes("image");
}

/**
 * The Ling 3.2 model for an automatic vision switch, with the 3.2 profile's upstream pin and sampling
 * where models.json sets none: `bling configure` writes them only for the configured profile, and an
 * unpinned request could be served by any host.
 */
export function pinnedVisionModel(vision: Model<Api>): Model<Api> {
	const profile = LING_PROFILES["3.2"];
	const compat = vision.compat as { openRouterRouting?: unknown } | undefined;
	return {
		...vision,
		samplingParams: vision.samplingParams ?? { ...profile.samplingParams },
		compat: {
			...vision.compat,
			openRouterRouting: compat?.openRouterRouting ?? { only: [profile.openRouterUpstream], allow_fallbacks: false },
		},
	} as Model<Api>;
}
