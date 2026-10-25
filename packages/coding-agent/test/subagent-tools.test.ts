import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectScope, createWriteScope, ScopeError } from "../src/core/subagents/path-scope.ts";
import {
	assembleCoderReport,
	CODER_TOOL_NAMES,
	changedPaths,
	countChangedLines,
	createCoderChild,
	createScoutChild,
	diffTarget,
	MAX_DIFF_CHARS,
	runAuthoritativeOracle,
	SCOUT_TOOL_NAMES,
	snapshotFile,
	snapshotGitStatus,
	verifyScoutReport,
} from "../src/core/subagents/tools.ts";

const node = process.execPath;
let root: string;
let outside: string;
let project: ReturnType<typeof createProjectScope>;

beforeEach(() => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "subagent-tools-")));
	root = join(base, "project");
	outside = join(base, "outside");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
	writeFileSync(join(root, "src", "other.ts"), "other\n");
	writeFileSync(join(root, ".env"), "SECRET=1\n");
	writeFileSync(join(outside, "secret.txt"), "outside secret\n");
	symlinkSync(join(outside, "secret.txt"), join(root, "src", "link-out.txt"));
	symlinkSync(outside, join(root, "src", "dir-out"));
	symlinkSync(join(root, "src", "a.ts"), join(root, "src", "alias.ts"));
	project = createProjectScope(root);
});

afterEach(() => {
	rmSync(join(root, ".."), { recursive: true, force: true });
	delete process.env.BLING_TOOLS_SECRET;
});

function call(name: string, args: unknown): BeforeToolCallContext {
	return {
		toolCall: { type: "toolCall", id: "t1", name, arguments: args as Record<string, unknown> },
		args,
	} as unknown as BeforeToolCallContext;
}

function tool(tools: AgentTool<any>[], name: string): AgentTool<any> {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("scout child", () => {
	it("exposes exactly the scout tools", () => {
		const child = createScoutChild({ project, scripts: {} });
		expect(child.tools.map((candidate) => candidate.name)).toEqual([...SCOUT_TOOL_NAMES]);
		expect(child.terminalTools).toEqual(["report"]);
	});

	it("blocks reads that leave the project or hit credentials, and counts them", async () => {
		const child = createScoutChild({ project, scripts: {} });
		const blocked = [
			"../outside/secret.txt",
			join(outside, "secret.txt"),
			"src/link-out.txt",
			"src/dir-out/secret.txt",
			".env",
			"./src/../.env",
			"~/.ssh/id_rsa",
			join(homedir(), ".bashrc"),
		];
		for (const [index, path] of blocked.entries()) {
			const result = await child.beforeToolCall(call("read", { path }));
			expect(result?.block, path).toBe(true);
			expect(child.counters.scopeViolations).toBe(index + 1);
		}
		for (const name of ["grep", "find", "ls"]) {
			const result = await child.beforeToolCall(call(name, { pattern: "x", path: "../outside" }));
			expect(result?.block, name).toBe(true);
		}
		expect(await child.beforeToolCall(call("read", { path: "src/a.ts" }))).toBeUndefined();
		expect(await child.beforeToolCall(call("ls", {}))).toBeUndefined();
		expect(await child.beforeToolCall(call("grep", { pattern: "one" }))).toBeUndefined();
	});

	it("also confines the read tool operations when the hook is bypassed", async () => {
		const child = createScoutChild({ project, scripts: {} });
		const read = tool(child.tools, "read");
		await expect(read.execute("1", { path: "src/link-out.txt" })).rejects.toThrow(/outside the project/);
		await expect(read.execute("2", { path: ".env" })).rejects.toThrow(/not accessible/);
		expect(child.counters.scopeViolations).toBe(2);
		const ok = await read.execute("3", { path: "src/a.ts" });
		expect(textOf(ok)).toContain("two");
		const ls = tool(child.tools, "ls");
		await expect(ls.execute("4", { path: "../outside" })).rejects.toThrow();
	});

	it("lists a directory that contains links out of the project without counting a violation", async () => {
		const child = createScoutChild({ project, scripts: {} });
		const listing = await tool(child.tools, "ls").execute("1", { path: "src" });
		expect(textOf(listing)).toContain("a.ts");
		expect(textOf(listing)).toContain("link-out.txt");
		expect(child.counters.scopeViolations).toBe(0);
	});

	it("runs only configured scripts, with the isolated environment", async () => {
		process.env.BLING_TOOLS_SECRET = "hunter2";
		const child = createScoutChild({
			project,
			scripts: {
				"print-env": { command: node, args: ["-e", "console.log(JSON.stringify(process.env))"] },
				"echo-args": {
					command: node,
					args: ["-e", "console.log(process.argv.slice(1).join(','))", "--"],
					allowArgs: true,
				},
				"escape-cwd": { command: node, args: ["-e", "1"], cwd: "../outside" },
				fail: { command: node, args: ["-e", "process.exit(4)"] },
			},
		});
		const run = tool(child.tools, "run_script");
		const env = await run.execute("1", { name: "print-env" });
		expect(textOf(env)).not.toContain("hunter2");
		expect(textOf(env)).not.toContain("BLING_TOOLS_SECRET");
		expect(textOf(env)).toContain("PATH");

		const unknown = await run.execute("2", { name: "rm-rf" });
		expect(unknown.isError).toBe(true);
		const inherited = await run.execute("3", { name: "constructor" });
		expect(inherited.isError).toBe(true);

		const refused = await run.execute("4", { name: "print-env", args: ["--x"] });
		expect(refused.isError).toBe(true);
		const allowed = await run.execute("5", { name: "echo-args", args: ["a", "b"] });
		expect(allowed.isError).toBeUndefined();
		expect(textOf(allowed)).toContain("a,b");

		const cwd = await run.execute("6", { name: "escape-cwd" });
		expect(cwd.isError).toBe(true);
		const failing = await run.execute("7", { name: "fail" });
		expect(textOf(failing)).toContain("exit code: 4");
	});

	it("records the report and ends the run", async () => {
		const child = createScoutChild({ project, scripts: {} });
		const report = {
			findings: [],
			unresolved: ["x"],
			confidence: "low" as const,
		};
		const result = await tool(child.tools, "report").execute("1", report);
		expect(result.terminate).toBe(true);
		expect(child.getReport()).toEqual(report);
	});
});

describe("verifyScoutReport", () => {
	it("flags fabricated or out-of-range evidence", async () => {
		const verified = await verifyScoutReport(
			{
				findings: [
					{
						claim: "c",
						confidence: "high",
						evidence: [
							{ path: "src/a.ts", startLine: 1, endLine: 3 },
							{ path: "src/a.ts", startLine: 2, endLine: 4 },
							{ path: "src/a.ts", startLine: 3, endLine: 2 },
							{ path: "src/missing.ts", startLine: 1, endLine: 1 },
							{ path: "../outside/secret.txt", startLine: 1, endLine: 1 },
							{ path: ".env", startLine: 1, endLine: 1 },
							{ path: "src", startLine: 1, endLine: 1 },
							{ path: "./src/../src/a.ts", startLine: 3, endLine: 3, quote: "three" },
						],
					},
				],
				unresolved: [],
				suggestedNextAction: "next",
				confidence: "medium",
			},
			project,
		);
		expect(verified.findings[0].evidence.map((item) => item.verified)).toEqual([
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		]);
		expect(verified.suggestedNextAction).toBe("next");
	});
});

function coder(options: { maxOracleRuns?: number; path?: string; args?: string[] } = {}) {
	const scope = createWriteScope(project, options.path ?? "src/a.ts");
	const child = createCoderChild({
		project,
		scope,
		oracle: { command: node, args: options.args ?? ["-e", "console.log('oracle ran')"], timeoutMs: 10_000 },
		maxOracleRuns: options.maxOracleRuns ?? 1,
	});
	return { scope, child };
}

describe("write scope at brief time", () => {
	const rejected: Array<[string, string]> = [
		["outside the project", "../outside/new.txt"],
		["absolute outside", join(tmpdir(), "elsewhere.txt")],
		["credential name", ".env"],
		["symlink target", "src/alias.ts"],
		["symlink to outside", "src/link-out.txt"],
		["symlinked parent", "src/dir-out/new.txt"],
		["missing parent", "nope/new.ts"],
		["home path", "~/new.ts"],
	];
	for (const [name, path] of rejected) {
		it(`rejects ${name}`, () => {
			expect(() => createWriteScope(project, path)).toThrow(ScopeError);
		});
	}

	it("accepts equivalent spellings of the same target", () => {
		const canonical = createWriteScope(project, "src/a.ts").targetPath;
		for (const path of ["./src/a.ts", "src/../src/a.ts", join(root, "src", "a.ts"), "@src/a.ts"]) {
			expect(createWriteScope(project, path).targetPath).toBe(canonical);
		}
	});
});

describe("coder child", () => {
	it("exposes exactly the coder tools", () => {
		const { child } = coder();
		expect(child.tools.map((candidate) => candidate.name)).toEqual([...CODER_TOOL_NAMES]);
		expect(child.terminalTools).toEqual(["finish", "escalate"]);
	});

	it("escalate is terminal, records the escalation, and is separate from finish", async () => {
		const { child } = coder();
		expect(child.getEscalation()).toBeUndefined();
		const result = await tool(child.tools, "escalate").execute("1", {
			reason: "scope_expansion",
			detail: "the caller in src/other.ts must change too",
			filesNeeded: ["src/other.ts"],
		});
		expect(result.terminate).toBe(true);
		expect(result.isError).toBeUndefined();
		expect(child.getEscalation()).toEqual({
			reason: "scope_expansion",
			detail: "the caller in src/other.ts must change too",
			filesNeeded: ["src/other.ts"],
		});
		expect(child.getFinish()).toBeUndefined();
	});

	it("escalate omits filesNeeded when not given and validates the reason", async () => {
		const { child } = coder();
		await tool(child.tools, "escalate").execute("1", { reason: "ambiguous_spec", detail: "which format?" });
		expect(child.getEscalation()).toEqual({ reason: "ambiguous_spec", detail: "which format?" });
		const schema = tool(child.tools, "escalate").parameters as { properties: { reason: { anyOf: unknown[] } } };
		expect(schema.properties.reason.anyOf).toHaveLength(3);
	});

	it("edits the target", async () => {
		const { child } = coder();
		const result = await tool(child.tools, "edit").execute("1", {
			path: "src/a.ts",
			edits: [{ oldText: "two", newText: "TWO" }],
		});
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
		expect(child.counters.scopeViolations).toBe(0);
	});

	it("blocks other paths in every spelling", async () => {
		const { child } = coder();
		const attempts = [
			"src/other.ts",
			"../outside/secret.txt",
			join(root, "src", "other.ts"),
			"src/alias.ts",
			"src/link-out.txt",
			"new.ts",
			"src/a.ts/../other.ts",
		];
		for (const [index, path] of attempts.entries()) {
			for (const name of ["edit", "write"]) {
				const result = await child.beforeToolCall(call(name, { path }));
				expect(result?.block, `${name} ${path}`).toBe(true);
			}
			expect(child.counters.scopeViolations).toBe((index + 1) * 2);
		}
		expect(await child.beforeToolCall(call("write", { path: "./src/../src/a.ts" }))).toBeUndefined();
	});

	it("rejects other paths in the edit and write operations when the hook is bypassed", async () => {
		const { child } = coder();
		await expect(tool(child.tools, "write").execute("1", { path: "src/other.ts", content: "pwned" })).rejects.toThrow(
			/restricted/,
		);
		await expect(
			tool(child.tools, "edit").execute("2", {
				path: "src/other.ts",
				edits: [{ oldText: "other", newText: "pwned" }],
			}),
		).rejects.toThrow(/restricted/);
		await expect(
			tool(child.tools, "write").execute("3", { path: "src/dir-out/new.txt", content: "pwned" }),
		).rejects.toThrow();
		expect(readFileSync(join(root, "src", "other.ts"), "utf-8")).toBe("other\n");
		expect(() => readFileSync(join(outside, "new.txt"))).toThrow();
	});

	it("rejects a target swapped for a symlink after the brief was accepted", async () => {
		const { child } = coder();
		rmSync(join(root, "src", "a.ts"));
		symlinkSync(join(root, "src", "other.ts"), join(root, "src", "a.ts"));
		await expect(tool(child.tools, "write").execute("1", { path: "src/a.ts", content: "pwned" })).rejects.toThrow(
			/symlink/,
		);
		expect(readFileSync(join(root, "src", "other.ts"), "utf-8")).toBe("other\n");
		const blocked = await child.beforeToolCall(call("edit", { path: "src/a.ts" }));
		expect(blocked?.block).toBe(true);
	});

	it("creates a missing target in an existing directory", async () => {
		const { child } = coder({ path: "src/new.ts" });
		const result = await tool(child.tools, "write").execute("1", { path: "src/new.ts", content: "fresh\n" });
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(root, "src", "new.ts"), "utf-8")).toBe("fresh\n");
	});

	it("reads other project files but not credentials or outside paths", async () => {
		const { child } = coder();
		expect(await child.beforeToolCall(call("read", { path: "src/other.ts" }))).toBeUndefined();
		expect((await child.beforeToolCall(call("read", { path: ".env" })))?.block).toBe(true);
		expect((await child.beforeToolCall(call("read", { path: "src/link-out.txt" })))?.block).toBe(true);
	});

	it("runs only the given oracle argv and caps the runs", async () => {
		const { child } = coder({ maxOracleRuns: 1 });
		const oracle = tool(child.tools, "run_oracle");
		expect(oracle.parameters.properties).toEqual({});
		const first = await oracle.execute("1", {});
		expect(textOf(first)).toContain("oracle ran");
		expect(textOf(first)).toContain("exit code: 0");
		const second = await oracle.execute("2", { command: "rm", args: ["-rf", "/"] });
		expect(second.isError).toBe(true);
		expect(textOf(second)).toContain("limit");
		expect(child.getOracleRuns()).toBe(1);
	});

	it("allows no oracle runs when the cap is zero", async () => {
		const { child } = coder({ maxOracleRuns: 0 });
		const result = await tool(child.tools, "run_oracle").execute("1", {});
		expect(result.isError).toBe(true);
		expect(child.getOracleRuns()).toBe(0);
	});

	it("records finish and ends the run", async () => {
		const { child } = coder();
		const finish = { summary: "done", uncertainties: ["u"], interfaceChanges: [] };
		const result = await tool(child.tools, "finish").execute("1", finish);
		expect(result.terminate).toBe(true);
		expect(child.getFinish()).toEqual(finish);
	});
});

describe("coder post-processing", () => {
	it("decides the oracle result from the exit code and timeout", async () => {
		const pass = await runAuthoritativeOracle({
			oracle: { command: node, args: ["-e", "console.log('ok')"], timeoutMs: 10_000 },
			cwd: root,
			childRuns: 1,
		});
		expect(pass).toMatchObject({ passed: true, exitCode: 0, timedOut: false, childRuns: 1 });
		expect(pass.outputTail).toContain("ok");
		const fail = await runAuthoritativeOracle({
			oracle: { command: node, args: ["-e", "process.exit(2)"], timeoutMs: 10_000 },
			cwd: root,
			childRuns: 0,
		});
		expect(fail).toMatchObject({ passed: false, exitCode: 2 });
		const slow = await runAuthoritativeOracle({
			oracle: { command: node, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 200 },
			cwd: root,
			childRuns: 0,
		});
		expect(slow).toMatchObject({ passed: false, timedOut: true });
		const missing = await runAuthoritativeOracle({
			oracle: { command: "no-such-oracle-binary", args: [], timeoutMs: 1000 },
			cwd: root,
			childRuns: 0,
		});
		expect(missing.passed).toBe(false);
		expect(missing.outputTail).toContain("ENOENT");
	});

	it("reports hashes and a capped unified diff", async () => {
		const target = join(root, "src", "a.ts");
		const before = await snapshotFile(target);
		writeFileSync(target, "one\nTWO\nthree\n");
		const after = await snapshotFile(target);
		const diff = diffTarget("src/a.ts", before, after);
		expect(diff).toContain("-two");
		expect(diff).toContain("+TWO");
		expect(before.sha256).not.toBe(after.sha256);
		expect(diffTarget("src/a.ts", after, after)).toBe("");

		writeFileSync(target, `${"line\n".repeat(20_000)}`);
		const big = await snapshotFile(target);
		expect(diffTarget("src/a.ts", before, big).length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 20);

		const report = assembleCoderReport({
			project,
			scope: createWriteScope(project, "src/a.ts"),
			before,
			after,
			finish: undefined,
			oracle: undefined,
			outsideTargetChanges: undefined,
		});
		expect(report).toMatchObject({ path: join("src", "a.ts"), changed: true, uncertainties: [] });
		expect(report.summary).toContain("did not call finish");
	});

	it("counts changed lines as lines added plus lines removed", async () => {
		const snap = (content: string | undefined) => ({ content, sha256: content === undefined ? undefined : content });
		expect(countChangedLines(snap("a\nb\nc\n"), snap("a\nb\nc\n"))).toBe(0);
		expect(countChangedLines(snap("a\nb\nc\n"), snap("a\nB\nc\n"))).toBe(2);
		expect(countChangedLines(snap("a\nb\nc\n"), snap("a\nb\nc\nd\ne\n"))).toBe(2);
		expect(countChangedLines(snap("a\nb\nc\n"), snap("a\n"))).toBe(2);
		expect(countChangedLines(snap(undefined), snap("x\ny\nz\n"))).toBe(3);
	});

	it("assembleCoderReport carries diffLines and the escalation", async () => {
		const target = join(root, "src", "a.ts");
		const before = await snapshotFile(target);
		writeFileSync(target, "one\nTWO\nthree\nfour\n");
		const after = await snapshotFile(target);
		const report = assembleCoderReport({
			project,
			scope: createWriteScope(project, "src/a.ts"),
			before,
			after,
			finish: undefined,
			escalation: { reason: "unresolved_failure", detail: "cannot satisfy the type" },
			oracle: undefined,
			outsideTargetChanges: undefined,
		});
		expect(report.diffLines).toBe(3);
		expect(report.escalation).toEqual({ reason: "unresolved_failure", detail: "cannot satisfy the type" });
		expect(report.summary).toBe("cannot satisfy the type");
	});

	it("reports files changed outside the target in a git work tree", async () => {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q");
		git("-c", "user.email=t@t", "-c", "user.name=t", "add", "src");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
		const before = await snapshotGitStatus(root);
		expect(before).toBeDefined();
		writeFileSync(join(root, "src", "a.ts"), "changed\n");
		writeFileSync(join(root, "src", "other.ts"), "changed too\n");
		writeFileSync(join(root, "src", "untracked.ts"), "new\n");
		const after = await snapshotGitStatus(root);
		expect(changedPaths(before!, after!, root)).toEqual([
			join("src", "a.ts"),
			join("src", "other.ts"),
			join("src", "untracked.ts"),
		]);
		expect(changedPaths(after!, after!, root)).toEqual([]);
	});

	it("returns undefined outside a git work tree", async () => {
		expect(await snapshotGitStatus(outside)).toBeUndefined();
	});
});

describe("executed grep and find honour the credential denylist", () => {
	const secrets = [
		".env",
		".env.local",
		".npmrc",
		".netrc",
		".pypirc",
		"server.key",
		"cert.p12",
		"bundle.pfx",
		"credentials.json",
		"auth.json",
		".git/config",
		".git/HEAD",
		".ssh/id_rsa",
		".aws/config",
		".gnupg/pubring.kbx",
		"src/nested/.ENV",
		"src/nested/.git/config",
		"src/nested/.SSH/key",
	];

	beforeEach(() => {
		for (const name of secrets) {
			mkdirSync(join(root, name, ".."), { recursive: true });
			writeFileSync(join(root, name), "TOPSECRET=hunter2\n");
		}
		writeFileSync(join(root, "src", "public.ts"), "const marker = 'TOPSECRET is not here';\n");
		writeFileSync(join(outside, "secret2.txt"), "TOPSECRET outside\n");
		symlinkSync(join(outside, "secret2.txt"), join(root, "link-secret.txt"));
		symlinkSync(join(root, ".env"), join(root, "link-env.txt"));
		symlinkSync(join(root, ".ssh"), join(root, "link-ssh"));
	});

	async function run(tools: AgentTool<any>[], name: string, args: Record<string, unknown>): Promise<string> {
		try {
			return textOf(await tool(tools, name).execute("t1", args));
		} catch (error) {
			return `ERROR ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	function assertClean(output: string): void {
		expect(output).not.toContain("hunter2");
		for (const name of secrets) expect(output.toLowerCase()).not.toContain(name.toLowerCase());
		expect(output).not.toContain("outside");
		expect(output).not.toContain("link-secret");
		expect(output).not.toContain("link-env");
		expect(output).not.toContain("link-ssh");
	}

	for (const kind of ["scout", "coder"] as const) {
		it(`${kind}: grep never returns denied names or contents, whatever the glob or path`, async () => {
			const tools =
				kind === "scout"
					? createScoutChild({ project, scripts: {} }).tools
					: createCoderChild({
							project,
							scope: createWriteScope(project, "src/a.ts"),
							oracle: { command: node, args: [], timeoutMs: 1000 },
							maxOracleRuns: 1,
						}).tools;
			const plain = await run(tools, "grep", { pattern: "TOPSECRET" });
			expect(plain).toContain("src/public.ts");
			assertClean(plain);
			for (const glob of [
				".env",
				"**/.env*",
				".git/**",
				"!*.ts",
				"*",
				"**/*.key",
				".ssh/*",
				"**/.ENV",
				"credentials*",
			]) {
				assertClean(await run(tools, "grep", { pattern: "TOPSECRET", glob }));
				assertClean(await run(tools, "grep", { pattern: "hunter2", glob, ignoreCase: true, context: 1 }));
			}
			for (const path of [
				".env",
				".git",
				".git/config",
				".ssh",
				"link-ssh",
				"link-env.txt",
				"link-secret.txt",
				"src/nested/.git",
			]) {
				const out = await run(tools, "grep", { pattern: "TOPSECRET", path });
				expect(out).not.toContain("hunter2");
				expect(out).not.toContain("outside");
			}
			const searchingRoot = await run(tools, "grep", { pattern: "hunter2" });
			expect(searchingRoot).toBe("No matches found");
		});

		it(`${kind}: find never lists denied names or directories`, async () => {
			const tools =
				kind === "scout"
					? createScoutChild({ project, scripts: {} }).tools
					: createCoderChild({
							project,
							scope: createWriteScope(project, "src/a.ts"),
							oracle: { command: node, args: [], timeoutMs: 1000 },
							maxOracleRuns: 1,
						}).tools;
			const everything = await run(tools, "find", { pattern: "*" });
			expect(everything).toContain("src/a.ts");
			assertClean(everything);
			for (const pattern of [
				".env*",
				"**/.env*",
				"config",
				"id_rsa",
				"*.key",
				"**/.git/**",
				".ssh/*",
				"**/.ENV",
				"*secret*",
				"**",
			]) {
				assertClean(await run(tools, "find", { pattern }));
			}
			for (const path of [".git", ".ssh", "link-ssh", "src/nested/.git", "src/nested/.SSH"]) {
				const out = await run(tools, "find", { pattern: "*", path });
				expect(out).not.toContain("hunter2");
				expect(out).not.toContain("config");
				expect(out).toMatch(/not accessible|No files found/);
			}
		});
	}
});

describe("credential denylist coverage", () => {
	const denied = [
		".git-credentials",
		".pgpass",
		".htpasswd",
		".dockercfg",
		"infra/terraform.tfstate",
		"infra/terraform.tfstate.backup",
		"keys/release.keystore",
		"keys/app.jks",
		"service-account.json",
		"service-account-prod.json",
		"config/secrets.yml",
		"id_rsa.bak",
		"id_rsa_work",
		".docker/config.json",
		".kube/config",
	];
	const allowed = ["src/secrets.ts", "src/keystore.ts", "docs/terraform.md", "src/identity.ts"];

	it("denies newly listed credential files and directories", () => {
		for (const relativePath of [...denied, ...allowed]) {
			mkdirSync(dirname(join(root, relativePath)), { recursive: true });
			writeFileSync(join(root, relativePath), "x\n");
		}
		for (const relativePath of denied) expect(project.isAllowed(join(root, relativePath)), relativePath).toBe(false);
		for (const relativePath of allowed) expect(project.isAllowed(join(root, relativePath)), relativePath).toBe(true);
	});
});
