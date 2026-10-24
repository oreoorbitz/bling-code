import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	canonicalJson,
	createMessageAction,
	createToolAction,
	deterministicId,
	getLearningPaths,
	getProjectId,
	LEARNING_DIRECTORY,
	ProjectActionStore,
	REDACTED,
	redactSensitive,
} from "../src/core/learning/action-store.ts";

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp: number, model = "Ling-3.1-flash"): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: `call_${timestamp}`, name: "bash", arguments: { command: "ls" } },
		],
		api: "openai-completions",
		provider: "ling",
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

describe("learning action store", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-learning-action-store-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("paths and canonicalization", () => {
		test("learning paths live under the project config dir", () => {
			const paths = getLearningPaths(tempDir);
			expect(LEARNING_DIRECTORY).toBe("learning");
			expect(paths.root).toBe(join(tempDir, CONFIG_DIR_NAME, "learning"));
			expect(paths.actions).toBe(join(paths.root, "actions.jsonl"));
			expect(paths.memory).toBe(join(paths.root, "memory.json"));
			expect(paths.reviews).toBe(join(paths.root, "reviews.jsonl"));
			expect(paths.proposals).toBe(join(paths.root, "proposals.json"));
			expect(paths.cursor).toBe(join(paths.root, "cursor.json"));
		});

		test("canonicalJson sorts object keys recursively", () => {
			expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
			expect(canonicalJson([{ z: 1, y: [3, { b: 2, a: 1 }] }])).toBe('[{"y":[3,{"a":1,"b":2}],"z":1}]');
			expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		});

		test("deterministicId is stable, prefixed, and 32 hex chars", () => {
			const identity = { sessionId: "s1", role: "user", content: "hello" };
			const id = deterministicId("msg", identity);
			expect(id).toBe(deterministicId("msg", { content: "hello", role: "user", sessionId: "s1" }));
			expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
			expect(id).not.toBe(deterministicId("msg", { ...identity, content: "other" }));
			expect(id).not.toBe(deterministicId("tool", identity));
		});

		test("projectId is a deterministic hash of the resolved cwd", () => {
			expect(getProjectId(tempDir)).toBe(getProjectId(tempDir));
			expect(getProjectId(tempDir)).toMatch(/^[0-9a-f]{32}$/);
			expect(getProjectId(tempDir)).not.toBe(getProjectId(join(tempDir, "other")));
		});
	});

	describe("redactSensitive", () => {
		test("redacts credential-shaped keys recursively and preserves reasoning", () => {
			const input = {
				apiKey: "sk-real-secret",
				nested: {
					authorization: "Bearer abc.def.ghi",
					reasoning: "I used the API key from the environment because the endpoint requires it",
				},
				list: [{ password: "hunter2", note: "keep me" }, "plain text mentioning token and password"],
				config: { "x-api-key": "abc", baseUrl: "http://localhost:30000/v1" },
			};
			const output = redactSensitive(input) as Record<string, unknown>;
			expect(output.apiKey).toBe(REDACTED);
			const nested = output.nested as Record<string, unknown>;
			expect(nested.authorization).toBe(REDACTED);
			expect(nested.reasoning).toBe(input.nested.reasoning);
			const list = output.list as unknown[];
			expect((list[0] as Record<string, unknown>).password).toBe(REDACTED);
			expect((list[0] as Record<string, unknown>).note).toBe("keep me");
			expect(list[1]).toBe("plain text mentioning token and password");
			const config = output.config as Record<string, unknown>;
			expect(config["x-api-key"]).toBe(REDACTED);
			expect(config.baseUrl).toBe("http://localhost:30000/v1");
			// Input is not mutated.
			expect(input.apiKey).toBe("sk-real-secret");
			expect(input.nested.authorization).toBe("Bearer abc.def.ghi");
		});

		test("redacts credential material pasted into free-form strings", () => {
			// All fixtures below are fake values shaped like real credentials.
			const fakeOpenRouterKey = "sk-or-v1-0123456789abcdef0123456789abcdef";
			const fakeBearerToken = "faketoken1234567890abcdef";
			const fakePem =
				"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nfakefakefakefakefakefake\n-----END PRIVATE KEY-----";

			const reasoning = `The request failed, so I pasted Authorization: Bearer ${fakeBearerToken} into the header`;
			const withKey = `endpoint rejected ${fakeOpenRouterKey} with 401`;
			const withPem = `signing failed for\n${fakePem}\nplease rotate`;

			expect(redactSensitive(reasoning)).toBe(
				`The request failed, so I pasted Authorization: ${REDACTED} into the header`,
			);
			expect(redactSensitive(withKey)).toBe(`endpoint rejected ${REDACTED} with 401`);
			expect(redactSensitive(withPem)).toBe(`signing failed for\n${REDACTED}\nplease rotate`);

			// Embedded in structures.
			const nested = redactSensitive({ output: [withKey, { text: reasoning }] }) as {
				output: [string, { text: string }];
			};
			expect(nested.output[0]).toBe(`endpoint rejected ${REDACTED} with 401`);
			expect(nested.output[1].text).toContain(REDACTED);
		});

		test("redacts common provider token and JWT shapes in free-form strings", () => {
			// Fake credential-shaped fixtures only; none is a real secret.
			const fixtures = [
				`github=${"ghp_0123456789abcdef0123456789abcdef0123"}`,
				`fineGrained=${"github_pat_11ABCDEFG_0123456789abcdef0123456789abcdef"}`,
				`gitlab=${"glpat-0123456789abcdefghij"}`,
				`slack=${"xoxb-123456789012-abcdefghijkl"}`,
				`aws=${"AKIA0123456789ABCDEF"}`,
				`jwt=${"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fake_signature_123456"}`,
			];
			for (const fixture of fixtures) {
				const redacted = redactSensitive(fixture);
				expect(redacted).toContain(REDACTED);
				expect(redacted).not.toBe(fixture);
			}
		});

		test("leaves prose that merely mentions credentials unchanged", () => {
			const prose = [
				"I used the API key from the environment because the endpoint requires it",
				"Bearer authentication is required for this API",
				"keys with the sk- prefix must stay out of the ledger",
				"the token and password belong in a secret manager",
				"short fragments like Bearer abc.def and sk-test are not credentials",
			];
			for (const text of prose) {
				expect(redactSensitive(text)).toBe(text);
			}
		});
	});

	describe("action creation", () => {
		test("message actions are stable on replay and distinct at distinct timestamps", () => {
			const message = userMessage("hello", 1000);
			const first = createMessageAction(tempDir, "session-1", message);
			const second = createMessageAction(tempDir, "session-1", userMessage("hello", 1000));
			expect(first.actionId).toBe(second.actionId);
			expect(first).toEqual(second);

			const later = createMessageAction(tempDir, "session-1", userMessage("hello", 2000));
			expect(later.actionId).not.toBe(first.actionId);

			const otherSession = createMessageAction(tempDir, "session-2", message);
			expect(otherSession.actionId).not.toBe(first.actionId);

			expect(first.kind).toBe("message");
			expect(first.actionId).toMatch(/^act_[0-9a-f]{32}$/);
			expect(first.version).toBe(1);
			expect(first.timestamp).toBe(1000);
			expect(first.projectId).toBe(getProjectId(tempDir));
		});

		test("assistant message identity includes tool call ids and model metadata", () => {
			const base = createMessageAction(tempDir, "s", assistantMessage("running", 10));
			const sameContentOtherModel = createMessageAction(
				tempDir,
				"s",
				assistantMessage("running", 10, "Ling-3.0-flash"),
			);
			expect(base.actionId).not.toBe(sameContentOtherModel.actionId);
		});

		test("tool actions exclude wall-clock time from the ID", () => {
			const event = {
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "ls" },
				result: { output: "file.txt" },
				isError: false,
			};
			const first = createToolAction(tempDir, "session-1", { ...event, timestamp: 111 });
			const second = createToolAction(tempDir, "session-1", { ...event, timestamp: 222 });
			expect(first.actionId).toBe(second.actionId);
			expect(first.timestamp).toBe(111);
			expect(second.timestamp).toBe(222);

			const errored = createToolAction(tempDir, "session-1", { ...event, isError: true });
			expect(errored.actionId).not.toBe(first.actionId);
			const otherResult = createToolAction(tempDir, "session-1", { ...event, result: { output: "changed" } });
			expect(otherResult.actionId).not.toBe(first.actionId);

			expect(first.kind).toBe("tool");
			expect(first.actionId).toMatch(/^tool_[0-9a-f]{32}$/);
			expect(first.toolCallId).toBe("call_1");
			expect(first.isError).toBe(false);
		});

		test("action payloads are sanitized", () => {
			const action = createToolAction(tempDir, "s", {
				toolCallId: "c",
				toolName: "read",
				args: { path: ".env", apiKey: "sk-secret" },
				result: { content: "the API key belongs in the environment", token: "abc" },
				isError: false,
			});
			expect((action.args as Record<string, unknown>).apiKey).toBe(REDACTED);
			expect((action.args as Record<string, unknown>).path).toBe(".env");
			expect((action.result as Record<string, unknown>).token).toBe(REDACTED);
			expect((action.result as Record<string, unknown>).content).toBe("the API key belongs in the environment");
		});
	});

	describe("ProjectActionStore", () => {
		test("append persists records, dedupes, and list reads them back in order", async () => {
			const store = ProjectActionStore.open(tempDir);
			expect(store.cwd).toBe(tempDir);
			expect(store.projectId).toBe(getProjectId(tempDir));

			const message = createMessageAction(tempDir, "s", userMessage("first", 1));
			const tool = createToolAction(tempDir, "s", {
				toolCallId: "c1",
				toolName: "bash",
				args: { command: "ls" },
				result: "ok",
				isError: false,
			});

			expect(await store.append(message)).toBe(true);
			expect(await store.append(message)).toBe(false);
			expect(await store.append(tool)).toBe(true);
			await store.flush();

			const records = await store.list();
			expect(records).toHaveLength(2);
			expect(records[0]).toEqual(message);
			expect(records[1]).toEqual(tool);

			const lines = readFileSync(store.paths.actions, "utf-8").trim().split("\n");
			expect(lines).toHaveLength(2);
			// Ledger lines are canonical JSON with sorted keys.
			expect(lines[0]).toBe(canonicalJson(message));
		});

		test("dedupe works across store instances on the same project", async () => {
			const action = createMessageAction(tempDir, "s", userMessage("shared", 5));
			const first = ProjectActionStore.open(tempDir);
			expect(await first.append(action)).toBe(true);
			const second = ProjectActionStore.open(tempDir);
			expect(await second.append(action)).toBe(false);
			expect(await second.list()).toHaveLength(1);
		});

		test("an external append cannot be hidden by a stale post-write file snapshot", async () => {
			const store = ProjectActionStore.open(tempDir);
			const first = createMessageAction(tempDir, "s", userMessage("first", 1));
			const external = createMessageAction(tempDir, "s", userMessage("external", 2));
			const last = createMessageAction(tempDir, "s", userMessage("last", 3));

			await store.append(first);
			appendFileSync(store.paths.actions, `${canonicalJson(external)}\n`);
			await store.append(last);
			expect(await store.append(external)).toBe(false);
			expect((await store.list()).map((action) => action.actionId)).toEqual([
				first.actionId,
				external.actionId,
				last.actionId,
			]);
		});

		test("concurrent appends are serialized and both land once", async () => {
			const store = ProjectActionStore.open(tempDir);
			const a = createMessageAction(tempDir, "s", userMessage("a", 1));
			const b = createMessageAction(tempDir, "s", userMessage("b", 2));
			const results = await Promise.all([store.append(a), store.append(b), store.append(a)]);
			expect(results).toEqual([true, true, false]);
			expect(await store.list()).toHaveLength(2);
		});

		test("cross-instance concurrent replay appends the same action exactly once", async () => {
			const action = createMessageAction(tempDir, "s", userMessage("shared replay", 9));
			const results = await Promise.all(
				Array.from({ length: 20 }, () => ProjectActionStore.open(tempDir).append(action)),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(await ProjectActionStore.open(tempDir).list()).toEqual([action]);
			expect(existsSync(join(tempDir, CONFIG_DIR_NAME, "learning", "actions.lock"))).toBe(false);
		});

		test("search is case-insensitive, deterministic, and limited", async () => {
			const store = ProjectActionStore.open(tempDir);
			await store.append(createMessageAction(tempDir, "s", userMessage("Fix the LOGIN timeout", 1)));
			await store.append(createMessageAction(tempDir, "s", userMessage("login page styling", 2)));
			await store.append(createMessageAction(tempDir, "s", userMessage("unrelated", 3)));

			const matches = await store.search("login");
			expect(matches).toHaveLength(2);
			expect((matches[0] as { message: AgentMessage }).message).toEqual(userMessage("Fix the LOGIN timeout", 1));
			expect((matches[1] as { message: AgentMessage }).message).toEqual(userMessage("login page styling", 2));

			expect(await store.search("login", 1)).toHaveLength(1);
			expect(await store.search("missing-term")).toHaveLength(0);
			// Multiple terms must all match.
			expect(await store.search("login styling")).toHaveLength(1);
		});

		test("project isolation: separate cwds have separate ledgers and projectIds", async () => {
			const otherDir = mkdtempSync(join(tmpdir(), "pi-learning-action-store-other-"));
			try {
				const first = ProjectActionStore.open(tempDir);
				const second = ProjectActionStore.open(otherDir);
				expect(first.projectId).not.toBe(second.projectId);

				await first.append(createMessageAction(tempDir, "s", userMessage("project a note", 1)));
				expect(await first.list()).toHaveLength(1);
				expect(await second.list()).toHaveLength(0);
				expect(await second.search("note")).toHaveLength(0);
			} finally {
				rmSync(otherDir, { recursive: true, force: true });
			}
		});

		test("writes .gitignore covering the ledger and keeps file modes private", async () => {
			const store = ProjectActionStore.open(tempDir);
			await store.append(createMessageAction(tempDir, "s", userMessage("hi", 1)));

			const gitignore = join(store.paths.root, ".gitignore");
			expect(existsSync(gitignore)).toBe(true);
			const content = readFileSync(gitignore, "utf-8");
			expect(content).toContain("\n*\n".slice(1));
			expect(content).toContain("!.gitignore");

			if (process.platform !== "win32") {
				expect(statSync(store.paths.actions).mode & 0o777).toBe(0o600);
			}
		});

		test("list returns empty for a project without a ledger", async () => {
			const store = ProjectActionStore.open(tempDir);
			expect(await store.list()).toEqual([]);
			await store.flush();
		});
	});
});
