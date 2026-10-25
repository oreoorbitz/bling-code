import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type Api,
	type FauxProviderRegistration,
	type Model,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import type { SubagentRoleConfig } from "../src/core/settings-schema.ts";
import { type ResolvedRole, type RoleKind, resolveRole } from "../src/core/subagents/roles.ts";
import type { SubagentModelStreamer } from "../src/core/subagents/runner.ts";

export interface UsagePatch {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	/** Reasoning tokens (a subset of output). Left undefined on the usage when not given. */
	reasoning?: number;
	responseProvider?: string;
}

/** A model streamer backed by the registered faux provider. */
export function fauxStreamer(): SubagentModelStreamer {
	return { streamSimple: (model, context, options) => streamSimple(model, context, options) };
}

/**
 * Wraps a streamer and replaces the usage (and served host) of the final message of request N with `patches[N]`.
 * The faux provider estimates usage itself, so budget tests need exact numbers.
 */
export function withUsage(inner: SubagentModelStreamer, patches: UsagePatch[]): SubagentModelStreamer {
	let call = 0;
	return {
		streamSimple(model, context, options) {
			const patch = patches[Math.min(call, patches.length - 1)] ?? {};
			call += 1;
			const apply = (message: AssistantMessage): AssistantMessage => {
				const input = patch.input ?? message.usage.input;
				const output = patch.output ?? message.usage.output;
				const cacheRead = patch.cacheRead ?? 0;
				const cacheWrite = patch.cacheWrite ?? 0;
				const cost = patch.cost ?? 0;
				return {
					...message,
					usage: {
						input,
						output,
						cacheRead,
						cacheWrite,
						totalTokens: input + output + cacheRead + cacheWrite,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
						...(patch.reasoning === undefined ? {} : { reasoning: patch.reasoning }),
					},
					...(patch.responseProvider === undefined ? {} : { responseProvider: patch.responseProvider }),
				};
			};
			const source = inner.streamSimple(model, context, options);
			const out = createAssistantMessageEventStream();
			void (async () => {
				for await (const event of source) {
					if (event.type === "done") out.push({ ...event, message: apply(event.message) });
					else if (event.type === "error") out.push({ ...event, error: apply(event.error) });
					else out.push(event);
				}
				out.end();
			})();
			return out;
		},
	};
}

export function registerFaux(options: Parameters<typeof registerFauxProvider>[0] = {}): FauxProviderRegistration {
	return registerFauxProvider(options);
}

export function roleConfig(kind: RoleKind, overrides: Partial<SubagentRoleConfig> = {}): SubagentRoleConfig {
	return {
		kind,
		provider: "openrouter",
		model: "faux-1",
		upstream: "novita",
		sampling: { temperature: 0.2 },
		...overrides,
	};
}

/** Resolves a role onto the faux model, with the pin and sampling a real resolution would apply. */
export function makeRole(
	faux: FauxProviderRegistration,
	kind: RoleKind,
	overrides: Partial<SubagentRoleConfig> = {},
	name = `${kind}-test`,
): ResolvedRole {
	const base = faux.getModel() as Model<Api>;
	return resolveRole(
		kind,
		{ active: { [kind]: name }, roles: { [name]: roleConfig(kind, overrides) } },
		{ find: () => base, hasConfiguredAuth: () => true },
		{},
	);
}
