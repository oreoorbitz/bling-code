/**
 * Clears old tool results from the model context before full compaction is needed. Ported from
 * qwen-code's size-based microcompaction (`packages/core/src/services/microcompaction/microcompact.ts`).
 *
 * When the tool results in the context exceed a character threshold, the oldest are replaced with a
 * short placeholder until the rest fit in half the threshold. Clearing to half rather than just
 * under the threshold means it triggers rarely: each clearing changes the prompt prefix and costs a
 * provider prompt-cache miss, so it should not happen every request. The tool calls and their
 * arguments stay, as do errors, the most recent results, and results of tools that cannot simply be
 * run again (subagents, for example).
 *
 * Pi applies this to the context sent to the model only; the saved session keeps every result. The
 * cleared set only grows, so the context stays stable between clearings.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const CLEARED_TOOL_RESULT = "[Old tool result content cleared]";

/** Tools whose results can be reproduced by calling them again. */
export const CLEARABLE_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"powershell",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
]);

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

function resultChars(message: ToolResult): number {
	let chars = 0;
	for (const part of message.content) chars += part.type === "text" ? part.text.length : part.data.length;
	return chars;
}

export interface ClearedResult {
	toolCallId: string;
	toolName: string;
}

export class ToolResultClearing {
	private readonly cleared = new Set<string>();

	/** Forget everything cleared (a new session or branch). */
	reset(): void {
		this.cleared.clear();
	}

	/**
	 * The context with old results cleared, or undefined when nothing has ever been cleared.
	 * `newlyCleared` lists the results cleared by this call, so caches that point at their content
	 * can drop them.
	 */
	apply(
		messages: readonly AgentMessage[],
		thresholdChars: number,
		keepRecent: number,
	): { messages: AgentMessage[] | undefined; newlyCleared: ClearedResult[] } {
		const newlyCleared: ClearedResult[] = [];
		const candidates: Array<{ message: ToolResult; chars: number }> = [];
		let total = 0;
		for (const message of messages) {
			if (message.role !== "toolResult" || this.cleared.has(message.toolCallId)) continue;
			if (message.isError || !CLEARABLE_TOOLS.has(message.toolName)) continue;
			const chars = resultChars(message);
			if (chars === 0) continue;
			candidates.push({ message, chars });
			total += chars;
		}
		if (thresholdChars > 0 && total > thresholdChars) {
			const lowWatermark = Math.floor(thresholdChars / 2);
			const clearable = candidates.slice(0, Math.max(0, candidates.length - keepRecent));
			for (const { message, chars } of clearable) {
				if (total <= lowWatermark) break;
				this.cleared.add(message.toolCallId);
				newlyCleared.push({ toolCallId: message.toolCallId, toolName: message.toolName });
				total -= chars;
			}
		}
		if (this.cleared.size === 0) return { messages: undefined, newlyCleared };
		return {
			messages: messages.map((message) =>
				message.role === "toolResult" && this.cleared.has(message.toolCallId)
					? {
							...message,
							content: [
								{ type: "text" as const, text: CLEARED_TOOL_RESULT },
								...message.content.flatMap((part) =>
									part.type === "image"
										? [{ type: "text" as const, text: `[Old inline media cleared: ${part.mimeType}]` }]
										: [],
								),
							],
						}
					: message,
			),
			newlyCleared,
		};
	}
}
