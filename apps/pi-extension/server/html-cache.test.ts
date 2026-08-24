import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPlanReviewServer } from "../server.ts";

const originalCwd = process.cwd();
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalRemote = process.env.PLANNOTATOR_REMOTE;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

afterEach(() => {
	process.chdir(originalCwd);
	if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
	else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
	if (originalRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
	else process.env.PLANNOTATOR_REMOTE = originalRemote;
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Pi application HTML caching", () => {
	test("revalidates the static shell while keeping the plan API dynamic", async () => {
		const projectRoot = makeTempDir("plannotator-pi-html-project-");
		process.chdir(projectRoot);
		process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-pi-html-data-");
		process.env.PLANNOTATOR_REMOTE = "0";

		const htmlContent = "<!doctype html><html><body>cached shell ✓</body></html>";
		const server = await startPlanReviewServer({
			plan: "# Current plan",
			origin: "pi",
			htmlContent,
		});

		try {
			const first = await fetch(server.url);
			expect(first.status).toBe(200);
			expect(first.headers.get("cache-control")).toBe("private, no-cache");
			expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
			expect(first.headers.get("content-length")).toBe(String(Buffer.byteLength(htmlContent)));
			const etag = first.headers.get("etag");
			expect(etag).toMatch(/^"sha256-[A-Za-z0-9_-]+"$/);
			expect(await first.text()).toBe(htmlContent);

			const unchanged = await fetch(server.url, {
				headers: { "If-None-Match": etag! },
			});
			expect(unchanged.status).toBe(304);
			expect(unchanged.headers.get("etag")).toBe(etag);
			expect(unchanged.headers.get("cache-control")).toBe("private, no-cache");
			expect(await unchanged.text()).toBe("");

			const weakListMatch = await fetch(server.url, {
				headers: { "If-None-Match": `"another-build", W/${etag}` },
			});
			expect(weakListMatch.status).toBe(304);

			const stale = await fetch(server.url, {
				headers: { "If-None-Match": '"sha256-stale"' },
			});
			expect(stale.status).toBe(200);
			expect(await stale.text()).toBe(htmlContent);

			const head = await fetch(server.url, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(head.headers.get("etag")).toBe(etag);
			expect(await head.text()).toBe("");

			const plan = await fetch(`${server.url}/api/plan`, {
				headers: { "If-None-Match": etag! },
			});
			expect(plan.status).toBe(200);
			expect(plan.headers.get("etag")).toBeNull();
			expect(await plan.json()).toMatchObject({ plan: "# Current plan", origin: "pi" });
		} finally {
			server.stop();
		}
	});
});
