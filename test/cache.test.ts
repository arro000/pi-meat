import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	artifactPaths,
	persistArtifacts,
	readCache,
	secureCacheTree,
} from "../extensions/pi-meat/cache.ts";

const posix = process.platform !== "win32";
const mode = (value: number) => value & 0o777;

test("persists cache with owner-only permissions", {
	skip: !posix,
}, async () => {
	const base = await mkdtemp(join(tmpdir(), "pi-meat-cache-"));
	const root = join(base, "key");
	const paths = artifactPaths(root, "generation-1");
	try {
		await persistArtifacts(
			paths,
			{
				summary: "summary",
				smartDiff: "reading",
				inputTokens: 1,
				outputTokens: 2,
			},
			"original",
			{ source: "HEAD", model: "provider/model" },
		);
		for (const directory of [base, root, join(root, "generations"), paths.root])
			assert.equal(mode((await stat(directory)).mode), 0o700);
		for (const file of [
			join(root, "current.json"),
			paths.result,
			paths.reading,
			paths.original,
		])
			assert.equal(mode((await stat(file)).mode), 0o600);
		const cached = await readCache(root);
		assert.equal(cached?.result.summary, "summary");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("tightens legacy cache trees without following symlinks", {
	skip: !posix,
}, async () => {
	const base = await mkdtemp(join(tmpdir(), "pi-meat-cache-legacy-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-meat-cache-outside-"));
	const legacy = join(base, "legacy");
	const file = join(legacy, "original.diff");
	const outsideFile = join(outside, "outside.txt");
	try {
		await mkdir(legacy, { mode: 0o755 });
		await writeFile(file, "private diff", { mode: 0o644 });
		await writeFile(outsideFile, "outside", { mode: 0o644 });
		await chmod(base, 0o755);
		await chmod(outsideFile, 0o644);
		await symlink(outsideFile, join(base, "outside-link"));
		await secureCacheTree(base);
		assert.equal(mode((await stat(base)).mode), 0o700);
		assert.equal(mode((await stat(legacy)).mode), 0o700);
		assert.equal(mode((await stat(file)).mode), 0o600);
		assert.equal(mode((await stat(outsideFile)).mode), 0o644);
	} finally {
		await rm(base, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
