import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Structured rate-limit signal for a failed subagent run. Only transient provider throttling
 * qualifies. Quota/subscription exhaustion is excluded even though OpenAI-compatible gateways
 * serve it as HTTP 429: backing off and retrying cannot help. Ported from Kimi's
 * `isProviderRateLimitError` and the `APIProviderQuotaExhaustedError` carve-out
 * (agent-core-v2 `llm-adapter/contract/errors.ts`); the quota wording list is aligned with
 * `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` in `packages/ai/src/utils/retry.ts`.
 */
export interface SubagentRateLimit {
	/** The provider error message that matched. */
	message: string;
	/** HTTP status observed on the error, when one was observable (429 for rate limits). */
	statusCode?: number;
	/** Milliseconds the provider asked the caller to wait before retrying, when reported. */
	retryAfterMs?: number;
}

// Kimi agent-core-v2 `PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS`, tested against the lowercased message.
const RATE_LIMIT_MESSAGE_PATTERNS: readonly RegExp[] = [
	/(?:apistatuserror.*429|429.*apistatuserror)/,
	/429.*too many requests/,
	/too many requests/,
	/provider\.rate_limit/,
	/reached .*max rpm/,
	/rate[ _-]?limit(?:ed)?/,
	/rate-limited/,
	// OpenAI SDK text for a bare 429, e.g. "429 Provider returned error" (OpenRouter upstream throttle)
	// or "429 status code (no body)". The status itself is not kept on the assistant message.
	/^429\b/,
];

// Quota/subscription exhaustion wording: a 429-shaped account limit, not a transient throttle.
// The list in `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` (packages/ai/src/utils/retry.ts), plus
// OpenRouter's daily free-model cap ("free-models-per-day"), which only resets the next day.
const QUOTA_EXHAUSTION_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|free-models-per-day/i;

/**
 * HTTP status of a thrown/structured provider error; first numeric hit wins. Covers the SDK
 * field shapes Kimi probes (`statusCode`/`status`, nested `response`) plus the ones bling's
 * `normalizeProviderError` documents (`$metadata.httpStatusCode`, `$response.statusCode`).
 */
export function getErrorStatusCode(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;
	if (typeof record.statusCode === "number") return record.statusCode;
	if (typeof record.status === "number") return record.status;
	const metadata = record.$metadata;
	if (typeof metadata === "object" && metadata !== null) {
		const httpStatusCode = (metadata as Record<string, unknown>).httpStatusCode;
		if (typeof httpStatusCode === "number") return httpStatusCode;
	}
	const response = record.response ?? record.$response;
	if (typeof response === "object" && response !== null) {
		const responseRecord = response as Record<string, unknown>;
		if (typeof responseRecord.statusCode === "number") return responseRecord.statusCode;
		if (typeof responseRecord.status === "number") return responseRecord.status;
	}
	return undefined;
}

/** Provider-requested retry delay in milliseconds, when the error carries it. */
export function getRetryAfterMs(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;
	if (typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs)) {
		return Math.max(0, record.retryAfterMs);
	}
	if (!(record.headers instanceof Headers)) return undefined;
	const retryAfterMs = record.headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) return Math.max(0, millis);
	}
	const retryAfter = record.headers.get("retry-after");
	if (retryAfter === null) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
	return Number.isFinite(delayMs) ? Math.max(0, delayMs) : undefined;
}

/**
 * Port of Kimi's `isProviderRateLimitError`: exclude quota/subscription exhaustion first, then a
 * 429 status where one is observable, then the message patterns. A defined non-429 status decides
 * alone, matching Kimi's status precedence over the message text.
 */
export function classifySubagentRateLimit(error: unknown): SubagentRateLimit | undefined {
	const message = error instanceof Error ? error.message : String(error);
	if (QUOTA_EXHAUSTION_PATTERN.test(message)) return undefined;
	const statusCode = getErrorStatusCode(error);
	if (statusCode !== undefined && statusCode !== 429) return undefined;
	if (statusCode !== 429 && !RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message.toLowerCase()))) {
		return undefined;
	}
	const retryAfterMs = getRetryAfterMs(error);
	return {
		message,
		...(statusCode === undefined ? {} : { statusCode }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

export function isSubagentRateLimitError(error: unknown): boolean {
	return classifySubagentRateLimit(error) !== undefined;
}

/**
 * Rate-limit signal for a finished assistant message: set only when the message ended in a
 * provider error that classifies as transient throttling. Non-error messages never carry one.
 */
export function rateLimitFromAssistantMessage(message: AssistantMessage): SubagentRateLimit | undefined {
	if (message.stopReason !== "error" || message.errorMessage === undefined) return undefined;
	return classifySubagentRateLimit(message.errorMessage);
}
