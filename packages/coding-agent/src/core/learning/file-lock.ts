import { type FileHandle, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const STALE_LOCK_AGE_MS = 60 * 60 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 10;

interface LockMetadata {
	pid: number;
	hostname: string;
	createdAt: number;
}

async function isStaleLock(path: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return false;
	}
	try {
		const metadata = JSON.parse(raw) as Partial<LockMetadata>;
		if (
			typeof metadata.pid === "number" &&
			Number.isInteger(metadata.pid) &&
			metadata.pid > 0 &&
			metadata.hostname === hostname()
		) {
			try {
				process.kill(metadata.pid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
				return false;
			}
		}
	} catch {
		// A process can die between creating the lock and writing its metadata.
	}
	try {
		const info = await stat(path);
		return Date.now() - info.mtimeMs > STALE_LOCK_AGE_MS;
	} catch {
		return false;
	}
}

/** Serialize a project-local critical section across processes, recovering locks left by dead processes. */
export async function withFileLock<T>(
	path: string,
	operation: () => Promise<T>,
	busyMessage: string,
	options: { wait?: boolean } = {},
): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
	let lock: FileHandle | undefined;
	while (!lock) {
		try {
			lock = await open(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await isStaleLock(path)) {
				await rm(path, { force: true });
				continue;
			}
			if (!options.wait || Date.now() >= deadline) throw new Error(busyMessage);
			await delay(LOCK_RETRY_DELAY_MS);
		}
	}
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now() }));
		return await operation();
	} finally {
		await lock.close();
		await rm(path, { force: true });
	}
}
