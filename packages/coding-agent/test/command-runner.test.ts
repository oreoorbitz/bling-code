import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnvironment, runCommand } from "../src/core/command-runner.ts";

const node = process.execPath;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		delete savedEnv[key];
	}
});

function run(script: string, options: { timeoutMs?: number; signal?: AbortSignal; outputLimitChars?: number } = {}) {
	return runCommand({
		command: node,
		args: ["-e", script],
		cwd: process.cwd(),
		env: isolatedEnvironment().env,
		timeoutMs: options.timeoutMs ?? 10_000,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.outputLimitChars ? { outputLimitChars: options.outputLimitChars } : {}),
	});
}

describe("runCommand", () => {
	it("reports exit code and output", async () => {
		const result = await run('console.log("out"); console.error("err"); process.exit(3)');
		expect(result.exitCode).toBe(3);
		expect(result.stdout).toBe("out\n");
		expect(result.stderr).toBe("err\n");
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it("escalates to SIGKILL when the process ignores SIGTERM on timeout", async () => {
		const started = Date.now();
		const result = await run('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)', {
			timeoutMs: 300,
		});
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
	});

	it("bounds output and marks the truncation", async () => {
		const result = await run('process.stdout.write("x".repeat(5000))', { outputLimitChars: 100 });
		expect(result.stdout.length).toBe(100);
		expect(result.stdout.endsWith("[output truncated]")).toBe(true);
	});

	it("terminates the process on abort", async () => {
		const controller = new AbortController();
		const pending = run("setInterval(() => {}, 1000)", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		const result = await pending;
		expect(result.aborted).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBeNull();
	});

	it("terminates immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await run("setInterval(() => {}, 1000)", { signal: controller.signal });
		expect(result.aborted).toBe(true);
	});

	it("reports a spawn error", async () => {
		const result = await runCommand({
			command: "definitely-not-a-command-bling",
			args: [],
			cwd: process.cwd(),
			env: isolatedEnvironment().env,
			timeoutMs: 5000,
		});
		expect(result.spawnError).toContain("ENOENT");
	});
});

describe.skipIf(process.platform === "win32")("process group termination", () => {
	// The child spawns a grandchild that sleeps and holds the inherited pipes open, like the worker under `npm test`.
	const withGrandchild = (grandchildBody: string) =>
		`const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildBody)}], { stdio: "inherit" });
console.log("grandchild " + g.pid);
setInterval(() => {}, 1000);`;
	const isAlive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const waitDead = async (pid: number): Promise<boolean> => {
		for (let attempt = 0; attempt < 40; attempt++) {
			if (!isAlive(pid)) return true;
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		return false;
	};

	it("kills grandchildren on timeout and resolves promptly", async () => {
		const started = Date.now();
		const result = await run(withGrandchild("setInterval(() => {}, 1000)"), { timeoutMs: 500 });
		const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1]);
		expect(pid).toBeGreaterThan(0);
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(2500);
		expect(await waitDead(pid)).toBe(true);
	});

	it("escalates to SIGKILL for a grandchild that ignores SIGTERM", async () => {
		const result = await run(withGrandchild('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), {
			timeoutMs: 500,
		});
		const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1]);
		expect(result.timedOut).toBe(true);
		expect(await waitDead(pid)).toBe(true);
	});

	it("kills grandchildren on abort", async () => {
		const controller = new AbortController();
		const pending = run(withGrandchild("setInterval(() => {}, 1000)"), { signal: controller.signal });
		setTimeout(() => controller.abort(), 500);
		const result = await pending;
		const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1]);
		expect(result.aborted).toBe(true);
		expect(await waitDead(pid)).toBe(true);
	});

	it("does not wait for pipes held open by a grandchild after the child exits", async () => {
		const started = Date.now();
		const result = await run(
			`const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
console.log("grandchild " + g.pid);
process.exit(0);`,
		);
		const pid = Number(/grandchild (\d+)/.exec(result.stdout)?.[1]);
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await waitDead(pid)).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")("parent termination", () => {
	const runnerPath = fileURLToPath(new URL("../src/core/command-runner.ts", import.meta.url));
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const isAlive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const waitFor = async (check: () => boolean): Promise<boolean> => {
		for (let attempt = 0; attempt < 60; attempt++) {
			if (check()) return true;
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		return false;
	};

	// The parent runs a command whose child spawns a sleeping grandchild, prints the grandchild pid, then waits.
	async function startParent(parentPrelude: string) {
		const dir = mkdtempSync(join(tmpdir(), "command-runner-parent-"));
		tempDirs.push(dir);
		const grandchildScript = `const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(process.argv[1], String(g.pid));
setInterval(() => {}, 1000);`;
		const pidFile = join(dir, "grandchild.pid");
		const parentPath = join(dir, "parent.mjs");
		writeFileSync(
			parentPath,
			`import { runCommand } from ${JSON.stringify(runnerPath)};
${parentPrelude}
await runCommand({ command: process.execPath, args: ["-e", ${JSON.stringify(grandchildScript)}, ${JSON.stringify(pidFile)}], cwd: ${JSON.stringify(dir)}, env: process.env, timeoutMs: 60000 });`,
		);
		const parent = spawn(process.execPath, [parentPath], { stdio: "ignore" });
		const ready = await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
		expect(ready).toBe(true);
		return { parent, grandchildPid: Number(readFileSync(pidFile, "utf8")) };
	}

	it("kills the command's process group when the parent receives SIGINT", async () => {
		const { parent, grandchildPid } = await startParent("");
		const exited = new Promise<NodeJS.Signals | null>((resolveExit) =>
			parent.on("exit", (_code, signal) => resolveExit(signal)),
		);
		parent.kill("SIGINT");
		expect(await exited).toBe("SIGINT");
		expect(await waitFor(() => !isAlive(grandchildPid))).toBe(true);
	});

	it("leaves an application's own SIGINT handling in control", async () => {
		const { parent, grandchildPid } = await startParent('process.on("SIGINT", () => {});');
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
			parent.on("exit", (code, signal) => resolveExit({ code, signal })),
		);
		parent.kill("SIGINT");
		expect(await waitFor(() => !isAlive(grandchildPid))).toBe(true);
		// The command was killed, so runCommand returned and the script finished normally instead of being re-signalled.
		expect(await exited).toEqual({ code: 0, signal: null });
	});
});

describe("isolatedEnvironment", () => {
	it("contains only default and allowlisted keys", () => {
		setEnv("BLING_CR_SECRET", "secret");
		setEnv("BLING_CR_ALLOWED", "allowed");
		const plain = isolatedEnvironment();
		expect(plain.env.BLING_CR_SECRET).toBeUndefined();
		expect(plain.env.BLING_CR_ALLOWED).toBeUndefined();
		const allowed = isolatedEnvironment(["BLING_CR_ALLOWED"]);
		expect(allowed.env.BLING_CR_ALLOWED).toBe("allowed");
		expect(allowed.env.BLING_CR_SECRET).toBeUndefined();
		expect(allowed.keys).toEqual(Object.keys(allowed.env).sort());
	});

	it("does not leak secrets to the child process", async () => {
		setEnv("BLING_CR_SECRET", "secret");
		const result = await run("console.log(process.env.BLING_CR_SECRET ?? 'unset')");
		expect(result.stdout.trim()).toBe("unset");
	});
});
