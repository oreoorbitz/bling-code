import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { checkForNewPiVersion } from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

function isPiDevHost(url: string): boolean {
	const hostname = new URL(url).hostname;
	return hostname === "pi.dev" || hostname.endsWith(".pi.dev");
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function spyOnFetch(): string[] {
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		urls.push(requestUrl(input));
		return new Response("not found", { status: 404 });
	});
	return urls;
}

async function refreshRuntime(): Promise<void> {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: true,
	});
	// Only providers with a credential are refreshed over the network.
	await runtime.setRuntimeApiKey("openrouter", "test-key");
	await runtime.setRuntimeApiKey("anthropic", "test-key");
	await runtime.refresh({ allowNetwork: true, force: true });
}

beforeEach(() => {
	allowNetwork();
	vi.stubEnv("BLING_REMOTE_CATALOG", undefined);
	vi.stubEnv("BLING_UPDATE_CHECK", undefined);
	vi.stubEnv("PI_SKIP_VERSION_CHECK", undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("no upstream network in the default configuration", () => {
	it("does not contact any pi.dev host when refreshing models", async () => {
		const urls = spyOnFetch();

		await refreshRuntime();

		expect(urls.length).toBeGreaterThan(0);
		expect(urls.filter(isPiDevHost)).toEqual([]);
	});

	it("does not run the startup update check", async () => {
		const urls = spyOnFetch();

		await expect(checkForNewPiVersion("1.0.0")).resolves.toBeUndefined();

		expect(urls).toEqual([]);
	});

	it("checks only the npm registry when BLING_UPDATE_CHECK is set", async () => {
		vi.stubEnv("BLING_UPDATE_CHECK", "1");
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			urls.push(requestUrl(input));
			return Response.json({ version: "9.9.9", packageName: "@earendil-works/pi-coding-agent" });
		});

		const release = await checkForNewPiVersion("1.0.0");

		expect(urls).toEqual([`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`]);
		expect(release).toEqual({ version: "9.9.9" });
		expect(release).not.toHaveProperty("packageName");
	});

	it("requests the pi.dev catalog when BLING_REMOTE_CATALOG is set", async () => {
		vi.stubEnv("BLING_REMOTE_CATALOG", "1");
		const urls = spyOnFetch();

		await refreshRuntime();

		expect(urls.some((url) => url.startsWith("https://pi.dev/api/models/providers/"))).toBe(true);
	});
});

describe("source guard", () => {
	const srcDir = fileURLToPath(new URL("../src", import.meta.url));
	// Files allowed to mention the pi.dev API path or install reporting.
	const allowlist = new Set<string>([
		// Builds /api/models/providers/<id> against the caller-supplied (opt-in) catalog origin.
		"core/remote-catalog-provider.ts",
	]);

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return entry.name.endsWith(".ts") ? [path] : [];
		});
	}

	it("keeps pi.dev API paths and install reporting out of the source", () => {
		const offenders = sourceFiles(srcDir)
			.map((path) => relative(srcDir, path).split("\\").join("/"))
			.filter((file) => !allowlist.has(file))
			.filter((file) => {
				const text = readFileSync(join(srcDir, file), "utf-8");
				return text.includes("pi.dev/api/") || text.includes("report-install");
			});
		expect(offenders).toEqual([]);
	});
});
