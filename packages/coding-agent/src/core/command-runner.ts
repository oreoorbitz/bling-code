import { spawn } from "node:child_process";

export const COMMAND_OUTPUT_LIMIT_CHARS = 64_000;
const TERMINATION_GRACE_MS = 1000;
/** After the direct child exits, how long to wait for its output pipes to close before giving up on them. */
const PIPE_DRAIN_MS = 500;
const USE_PROCESS_GROUP = process.platform !== "win32";

/**
 * A detached child is not in the terminal's foreground process group, so Ctrl-C or a hangup no longer reaches it.
 * Live groups are tracked so they die with this process: on exit, and on SIGINT/SIGTERM/SIGHUP while any are live.
 */
const liveProcessGroups = new Set<number>();
const PARENT_TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function killLiveProcessGroups(): void {
	for (const pid of liveProcessGroups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The group is already gone.
		}
	}
	liveProcessGroups.clear();
}

function onParentTerminationSignal(signal: NodeJS.Signals): void {
	killLiveProcessGroups();
	removeParentHandlers();
	// Keep the default behavior (terminate) unless the application handles this signal itself.
	if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function addParentHandlers(): void {
	process.on("exit", killLiveProcessGroups);
	for (const signal of PARENT_TERMINATION_SIGNALS) process.on(signal, onParentTerminationSignal);
}

function removeParentHandlers(): void {
	process.off("exit", killLiveProcessGroups);
	for (const signal of PARENT_TERMINATION_SIGNALS) process.off(signal, onParentTerminationSignal);
}

function trackProcessGroup(pid: number): void {
	if (liveProcessGroups.size === 0) addParentHandlers();
	liveProcessGroups.add(pid);
}

function untrackProcessGroup(pid: number): void {
	if (!liveProcessGroups.delete(pid)) return;
	if (liveProcessGroups.size === 0) removeParentHandlers();
}

export const DEFAULT_ENVIRONMENT_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
];

/** Child environment with only the default keys plus `allowlist`. */
export function isolatedEnvironment(allowlist: readonly string[] = []): { env: NodeJS.ProcessEnv; keys: string[] } {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [...DEFAULT_ENVIRONMENT_KEYS, ...allowlist]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { env, keys: Object.keys(env).sort() };
}

export interface CommandRunOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	signal?: AbortSignal;
	outputLimitChars?: number;
}

export interface CommandRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	spawnError?: string;
	durationMs: number;
}

function appendBounded(current: string, chunk: string, limit: number): string {
	if (current.length >= limit) return current;
	const marker = "\n[output truncated]";
	const remaining = limit - current.length;
	if (chunk.length <= remaining) return current + chunk;
	return current + chunk.slice(0, Math.max(0, remaining - marker.length)) + marker;
}

/**
 * Run argv without a shell. Bounded output, SIGTERM then SIGKILL on timeout or abort.
 * On POSIX the command runs in its own process group and signals go to the whole group, so grandchildren (for
 * example the worker `npm test` starts) die with it. Windows has no process groups; only the direct child is signalled.
 */
export async function runCommand(options: CommandRunOptions): Promise<CommandRunResult> {
	const limit = options.outputLimitChars ?? COMMAND_OUTPUT_LIMIT_CHARS;
	const started = performance.now();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let aborted = false;
	let spawnError: string | undefined;
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		detached: USE_PROCESS_GROUP,
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout = appendBounded(stdout, chunk, limit);
	});
	child.stderr.on("data", (chunk: string) => {
		stderr = appendBounded(stderr, chunk, limit);
	});
	child.on("error", (error) => {
		spawnError = error.message;
	});
	const groupPid = USE_PROCESS_GROUP ? child.pid : undefined;
	if (groupPid !== undefined) trackProcessGroup(groupPid);
	const signalTree = (signal: NodeJS.Signals) => {
		try {
			if (USE_PROCESS_GROUP && child.pid !== undefined) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			// The process or group is already gone.
		}
	};
	let forceKill: NodeJS.Timeout | undefined;
	const terminate = () => {
		signalTree("SIGTERM");
		forceKill ??= setTimeout(() => signalTree("SIGKILL"), TERMINATION_GRACE_MS);
	};
	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, options.timeoutMs);
	const onAbort = () => {
		aborted = true;
		terminate();
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	let drainTimer: NodeJS.Timeout | undefined;
	let pipesAbandoned = false;
	const exitCode = await new Promise<number | null>((resolveExit) => {
		// 'close' fires when the child has exited and its pipes are closed. A grandchild that outlives the child can
		// hold the pipes open, so 'exit' starts a bounded drain instead of waiting for 'close' forever.
		child.on("close", (code) => resolveExit(code));
		child.on("exit", (code) => {
			drainTimer = setTimeout(() => {
				pipesAbandoned = true;
				child.stdout.destroy();
				child.stderr.destroy();
				resolveExit(code);
			}, PIPE_DRAIN_MS);
		});
	}).finally(() => {
		clearTimeout(timeout);
		if (forceKill) clearTimeout(forceKill);
		if (drainTimer) clearTimeout(drainTimer);
		// Stragglers: descendants that ignored SIGTERM or kept the pipes open.
		if (timedOut || aborted || pipesAbandoned) signalTree("SIGKILL");
		if (groupPid !== undefined) untrackProcessGroup(groupPid);
		options.signal?.removeEventListener("abort", onAbort);
	});
	return {
		exitCode,
		stdout,
		stderr,
		timedOut,
		aborted,
		...(spawnError === undefined ? {} : { spawnError }),
		durationMs: Math.max(0, Math.round(performance.now() - started)),
	};
}
