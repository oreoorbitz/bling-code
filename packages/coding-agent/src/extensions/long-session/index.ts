import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { type LongSessionConfig, longSessionConfig } from "../../core/long-session/config.ts";
import { LoopGuard } from "../../core/long-session/loop-guard.ts";
import { ReadCache, unchangedReadNote } from "../../core/long-session/read-cache.ts";
import { ToolResultClearing } from "../../core/long-session/tool-result-clearing.ts";
import type { Settings } from "../../core/settings-manager.ts";
import { harnessProfileOf } from "../../core/settings-schema.ts";
import { resolveReadPathAsync } from "../../core/tools/path-utils.ts";

function configOf(settings: Settings): LongSessionConfig {
	return longSessionConfig(harnessProfileOf(settings), settings.longSession);
}

/**
 * Long-session guards for a cheap model running long: repeated-tool-call protection, clearing of old
 * tool results from the context, and a read cache for unchanged files. See `src/core/long-session/`.
 */
export function createLongSessionExtension(): ExtensionFactory {
	return (pi) => {
		let guard = new LoopGuard("off");
		const clearing = new ToolResultClearing();
		const readCache = new ReadCache();
		/** Reminders to append to the results of calls the loop guard flagged, by tool call id. */
		const reminders = new Map<string, string>();
		const resetContextState = () => {
			clearing.reset();
			readCache.clear();
		};

		pi.on("agent_start", () => {
			guard = new LoopGuard(configOf(pi.getSettings()).loopProtection);
			reminders.clear();
		});

		pi.on("tool_call", (event) => {
			// Calls issued by another tool (codemode scripts) are that tool's business.
			if (event.parentToolCallId !== undefined) return undefined;
			const verdict = guard.observe(event.toolName, event.input);
			if (verdict.stop !== undefined) return { block: true, reason: verdict.stop, terminate: true };
			if (verdict.reminder !== undefined) reminders.set(event.toolCallId, verdict.reminder);
			return undefined;
		});

		pi.on("tool_result", async (event, ctx) => {
			const reminder = reminders.get(event.toolCallId);
			reminders.delete(event.toolCallId);
			let content = event.content;
			let replaced = false;
			if (
				event.toolName === "read" &&
				!event.isError &&
				event.parentToolCallId === undefined &&
				configOf(pi.getSettings()).readCache &&
				content.every((part) => part.type === "text")
			) {
				const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
				if (typeof input.path === "string") {
					try {
						const absolute = await resolveReadPathAsync(input.path, ctx.cwd);
						const stats = await stat(absolute);
						const range = {
							offset: typeof input.offset === "number" ? input.offset : undefined,
							limit: typeof input.limit === "number" ? input.limit : undefined,
						};
						if (readCache.isUnchanged(stats, range)) {
							content = [{ type: "text", text: unchangedReadNote(relative(ctx.cwd, absolute) || absolute) }];
							replaced = true;
						} else {
							readCache.record(stats, range, event.toolCallId);
						}
					} catch {
						// The file vanished or cannot be stat'ed after the read; keep the result as read.
					}
				}
			}
			if (reminder !== undefined) {
				content = [...content, { type: "text", text: reminder }];
				replaced = true;
			}
			return replaced ? { content } : undefined;
		});

		pi.on("context", (event) => {
			const config = configOf(pi.getSettings());
			if (config.clearToolResultsChars === 0) return undefined;
			const { messages, newlyCleared } = clearing.apply(
				event.messages,
				config.clearToolResultsChars,
				config.keepRecentToolResults,
			);
			if (newlyCleared.length > 0) readCache.evict(new Set(newlyCleared.map((result) => result.toolCallId)));
			return messages === undefined ? undefined : { messages };
		});

		// After a compaction or a branch switch the context no longer holds what the cache points at.
		pi.on("session_start", resetContextState);
		pi.on("session_compact", resetContextState);
		pi.on("session_tree", resetContextState);
	};
}

export default createLongSessionExtension();
