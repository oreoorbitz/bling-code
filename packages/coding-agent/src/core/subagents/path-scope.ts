import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveToCwd } from "../tools/path-utils.ts";

export class ScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScopeError";
	}
}

/**
 * Credential-looking file names (globs; only `*` is special) subagents may not read, write, list or search.
 * Matched case-insensitively against every path component that is a file name.
 */
export const DENIED_NAME_GLOBS: readonly string[] = [
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"*.keystore",
	"*.jks",
	"id_rsa*",
	"id_dsa*",
	"id_ecdsa*",
	"id_ed25519*",
	"auth.json",
	".npmrc",
	".netrc",
	".pypirc",
	".pgpass",
	".htpasswd",
	".git-credentials",
	".dockercfg",
	"*.tfstate",
	"*.tfstate.*",
	"service-account*.json",
	"secrets.json",
	"secrets.yml",
	"secrets.yaml",
	"secrets.toml",
	"secrets.env",
	"credentials*",
];

/** Directories that are denied wholesale: matched against every path segment below the project root. */
export const DENIED_DIRECTORY_NAMES: readonly string[] = [".ssh", ".aws", ".gnupg", ".git", ".docker", ".kube"];

function globToRegExp(glob: string): RegExp {
	const source = glob
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

const DENIED_NAMES: readonly RegExp[] = DENIED_NAME_GLOBS.map(globToRegExp);
const DENIED_DIRECTORIES: ReadonlySet<string> = new Set(DENIED_DIRECTORY_NAMES);

/**
 * ripgrep/fd exclusion globs equivalent to the denylist. A glob without a slash matches at any depth, and an
 * excluded directory is never entered.
 */
export const DENIED_EXCLUDE_GLOBS: readonly string[] = [...DENIED_NAME_GLOBS, ...DENIED_DIRECTORY_NAMES];

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether any component of `path` (relative to `root`) is a denied directory or a denied file name. */
function deniedComponent(root: string, path: string): string | undefined {
	if (!isInside(root, path)) return undefined;
	for (const segment of relative(root, path).split(sep)) {
		if (segment === "") continue;
		if (DENIED_DIRECTORIES.has(segment.toLowerCase()) || DENIED_NAMES.some((pattern) => pattern.test(segment)))
			return segment;
	}
	return undefined;
}

function assertAllowedPath(root: string, path: string): void {
	const denied = deniedComponent(root, path);
	if (denied !== undefined) throw new ScopeError(`Path is not accessible to subagents: ${denied}`);
}

/** realpath of the longest existing prefix, with the missing tail re-appended. */
function realpathExisting(path: string): string {
	let current = path;
	const missing: string[] = [];
	for (;;) {
		try {
			return resolve(realpathSync(current), ...[...missing].reverse());
		} catch (error) {
			const parent = dirname(current);
			if (parent === current) throw error;
			missing.push(basename(current));
			current = parent;
		}
	}
}

export interface ProjectScope {
	/** realpath of the project root. */
	root: string;
	/** Absolute path the tools will use for `path`; throws ScopeError when it leaves the root or is denied. */
	resolveAccessible(path: string): string;
	/** Whether `absolutePath` is inside the root, not denied, and (after symlinks) still inside and not denied. */
	isAllowed(absolutePath: string): boolean;
}

export function createProjectScope(cwd: string): ProjectScope {
	const root = realpathSync(resolve(cwd));
	return {
		root,
		resolveAccessible(path: string): string {
			const absolute = resolveToCwd(path, root);
			const real = realpathExisting(absolute);
			if (!isInside(root, real)) throw new ScopeError(`Path is outside the project: ${path}`);
			assertAllowedPath(root, absolute);
			assertAllowedPath(root, real);
			return absolute;
		},
		isAllowed(absolutePath: string): boolean {
			try {
				this.resolveAccessible(absolutePath);
				return true;
			} catch {
				return false;
			}
		},
	};
}

export interface WriteScope {
	/** Absolute target path. */
	targetPath: string;
	/** Throws ScopeError unless `absolutePath` is the target and still resolves to it through the filesystem. */
	assertTarget(absolutePath: string): void;
}

export function createWriteScope(project: ProjectScope, path: string): WriteScope {
	const target = resolveToCwd(path, project.root);
	if (!isInside(project.root, target)) throw new ScopeError(`Target is outside the project: ${path}`);
	assertAllowedPath(project.root, target);
	try {
		if (lstatSync(target).isSymbolicLink()) throw new ScopeError("Target must not be a symlink");
	} catch (error) {
		if (error instanceof ScopeError) throw error;
	}
	if (!statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory()) {
		throw new ScopeError("Target parent directory must already exist");
	}
	if (realpathExisting(target) !== target) throw new ScopeError("Target path must not traverse symlinks");
	return {
		targetPath: target,
		assertTarget(absolutePath: string): void {
			const candidate = resolveToCwd(absolutePath, project.root);
			if (candidate !== target) throw new ScopeError(`Writes are restricted to ${relative(project.root, target)}`);
			if (realpathExisting(candidate) !== target) throw new ScopeError("Target path now traverses a symlink");
		},
	};
}
