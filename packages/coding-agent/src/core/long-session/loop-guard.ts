/**
 * Repeated-tool-call protection for one agent run (a prompt plus its tool-result continuations).
 * Ported from qwen-code's always-on loop safeties (`packages/core/src/services/loopDetectionService.ts`
 * and `loop-protection.ts`): each detector reminds the model first and only stops at a later point.
 *
 * - Identical calls: the same tool with identical arguments several times in a row returns the same
 *   result, so it is never productive. Reminder at 3, stop at 5.
 * - Repository inspection: consecutive bash commands that only run `git status`, an overview
 *   `git diff`, or `git ls-files`. Reminder at 6, stop at 8.
 * - Turn cap: past 100 calls in one run, a call repeated 4 times anywhere in the run gets a
 *   reminder and 6 times stops; past 1000 calls the run stops regardless (a budget, so it stops
 *   even in "warn" mode).
 */

import { createHash } from "node:crypto";

export type LoopProtectionMode = "off" | "warn" | "stop";

export const IDENTICAL_CALL_REMINDER_AT = 3;
export const IDENTICAL_CALL_STOP_AT = 5;
export const SHELL_INSPECTION_REMINDER_AT = 6;
export const SHELL_INSPECTION_STOP_AT = 8;
export const SOFT_TOOL_CALL_CAP = 100;
export const HARD_TOOL_CALL_CAP = 1_000;
export const CAP_REPEAT_REMINDER_AT = 4;
export const CAP_REPEAT_STOP_AT = 6;

export type LoopPattern = "identical_calls" | "shell_inspection" | "turn_cap";

/** What to do with one tool call. Both fields absent means proceed normally. */
export interface LoopVerdict {
	pattern?: LoopPattern;
	count?: number;
	/** Text appended to the call's result. */
	reminder?: string;
	/** Block the call and end the run, with this reason as the call's result. */
	stop?: string;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function isGitRevisionToken(token: string): boolean {
	return (
		token === "HEAD" ||
		token === "@" ||
		/^(?:HEAD|@)(?:[~^]\d*)+$/.test(token) ||
		/^[0-9a-f]{7,40}$/i.test(token) ||
		/^[^\s]+\.{2,3}[^\s]+$/.test(token)
	);
}

/**
 * Whether every segment of a shell command is an overview `git status`, `git diff` without paths,
 * or `git ls-files`. A chain that also stages, commits, runs anything else, or diffs specific files
 * is making progress and does not count.
 */
export function isGitOverviewInspection(command: string): boolean {
	const segments = command
		.split(/&&|\|\||[;&|\n]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every((segment) => {
		const match = /^git(?:\s+(?:-C\s+\S+|--no-pager))*\s+(status|diff|ls-files)\b/i.exec(segment);
		if (!match) return false;
		if (match[1]?.toLowerCase() !== "diff") return true;
		const args = segment.slice(match[0].length).trim();
		if (!args) return true;
		const tokens = args.split(/\s+/);
		const separator = tokens.indexOf("--");
		if (separator !== -1 && separator < tokens.length - 1) return false;
		return tokens.every((token) => token === "--" || token.startsWith("-") || isGitRevisionToken(token));
	});
}

export class LoopGuard {
	private readonly mode: LoopProtectionMode;
	private lastKey: string | undefined;
	private identicalStreak = 0;
	private identicalReminded = false;
	private inspectionStreak = 0;
	private inspectionReminded = false;
	private total = 0;
	private readonly keyCounts = new Map<string, number>();
	private capReminded = false;

	constructor(mode: LoopProtectionMode) {
		this.mode = mode;
	}

	/** Start a new agent run. */
	reset(): void {
		this.lastKey = undefined;
		this.identicalStreak = 0;
		this.identicalReminded = false;
		this.inspectionStreak = 0;
		this.inspectionReminded = false;
		this.total = 0;
		this.keyCounts.clear();
		this.capReminded = false;
	}

	/** Record one tool call about to run, and decide whether it gets a reminder or stops the run. */
	observe(toolName: string, input: unknown): LoopVerdict {
		if (this.mode === "off") return {};
		// Arguments can be large (whole file contents), so the key is a digest.
		const key = createHash("sha256")
			.update(`${toolName}\0${stableJson(input)}`)
			.digest("hex");
		const tool = `\`${toolName}\``;

		if (key === this.lastKey) this.identicalStreak += 1;
		else {
			this.lastKey = key;
			this.identicalStreak = 1;
			this.identicalReminded = false;
		}
		const command = toolName === "bash" ? (input as { command?: unknown } | undefined)?.command : undefined;
		if (typeof command === "string" && isGitOverviewInspection(command)) this.inspectionStreak += 1;
		else {
			this.inspectionStreak = 0;
			this.inspectionReminded = false;
		}
		this.total += 1;
		const repeats = (this.keyCounts.get(key) ?? 0) + 1;
		this.keyCounts.set(key, repeats);

		if (this.total > HARD_TOOL_CALL_CAP) {
			return {
				pattern: "turn_cap",
				count: this.total,
				stop: `System: This turn has made more than ${HARD_TOOL_CALL_CAP} tool calls, so it stops here. Summarize what is done and what remains.`,
			};
		}
		const identical = this.check(
			"identical_calls",
			this.identicalStreak,
			IDENTICAL_CALL_REMINDER_AT,
			IDENTICAL_CALL_STOP_AT,
			this.identicalReminded,
			`${tool} has been called ${this.identicalStreak} times in a row with identical arguments, so its result will not change. Use the result you already have, or change the approach.`,
			" Repeating the same call stops this turn.",
		);
		if (identical) {
			this.identicalReminded = true;
			return identical;
		}
		const inspection = this.check(
			"shell_inspection",
			this.inspectionStreak,
			SHELL_INSPECTION_REMINDER_AT,
			SHELL_INSPECTION_STOP_AT,
			this.inspectionReminded,
			`The last ${this.inspectionStreak} shell commands only inspected the repository (git status, diff or ls-files) without acting on the result. Act on what they showed, or explain what is blocking you.`,
			" More of the same inspection stops this turn.",
		);
		if (inspection) {
			this.inspectionReminded = true;
			return inspection;
		}
		if (this.total > SOFT_TOOL_CALL_CAP) {
			const cap = this.check(
				"turn_cap",
				repeats,
				CAP_REPEAT_REMINDER_AT,
				CAP_REPEAT_STOP_AT,
				this.capReminded,
				`This turn has made more than ${SOFT_TOOL_CALL_CAP} tool calls and has called ${tool} ${repeats} times with identical arguments. Stop repeating it: use the results you have, change the approach, or explain what is blocking you.`,
				" Repeating it further stops this turn.",
			);
			if (cap) {
				this.capReminded = true;
				return cap;
			}
		}
		return {};
	}

	/**
	 * One detector's decision: a single reminder in the window before the stop point, then at the
	 * stop point a stop under "stop" or another reminder under "warn".
	 */
	private check(
		pattern: LoopPattern,
		count: number,
		remindAt: number,
		stopAt: number,
		reminded: boolean,
		text: string,
		stopSuffix: string,
	): LoopVerdict | undefined {
		if (count >= stopAt) {
			if (this.mode === "stop") return { pattern, count, stop: `System: ${text}${stopSuffix}` };
			return { pattern, count, reminder: `System: ${text}` };
		}
		if (count >= remindAt && !reminded) {
			const suffix = this.mode === "stop" ? stopSuffix : "";
			return { pattern, count, reminder: `System: ${text}${suffix}` };
		}
		return undefined;
	}
}
