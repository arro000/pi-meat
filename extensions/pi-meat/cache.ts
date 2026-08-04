import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MeatResult } from "./protocol.ts";

export interface ArtifactPaths {
	root: string;
	cacheRoot: string;
	generation: string;
	result: string;
	reading: string;
	original: string;
}

export function artifactRoot(key: string): string {
	return join(
		process.env.PI_MEAT_CACHE ??
			join(homedir(), ".pi", "agent", "cache", "pi-meat"),
		key,
	);
}

export function artifactPaths(root: string, generation: string): ArtifactPaths {
	const generationRoot = join(root, "generations", generation);
	return {
		root: generationRoot,
		cacheRoot: root,
		generation,
		result: join(generationRoot, "result.json"),
		reading: join(generationRoot, "reading.diff"),
		original: join(generationRoot, "original.diff"),
	};
}

export async function readCache(
	root: string,
): Promise<{ result: MeatResult; paths: ArtifactPaths } | undefined> {
	try {
		await secureDirectory(dirname(root));
		await secureDirectory(root);
		const manifest = JSON.parse(
			await readFile(join(root, "current.json"), "utf8"),
		) as { generation?: unknown };
		if (
			typeof manifest.generation !== "string" ||
			!/^[a-zA-Z0-9-]+$/.test(manifest.generation)
		)
			return undefined;
		const paths = artifactPaths(root, manifest.generation);
		await secureDirectory(dirname(paths.root));
		await secureDirectory(paths.root);
		await Promise.all(
			[paths.result, paths.reading, paths.original].map((path) =>
				chmod(path, 0o600),
			),
		);
		const result = JSON.parse(
			await readFile(paths.result, "utf8"),
		) as MeatResult;
		return typeof result.smartDiff === "string" &&
			typeof result.summary === "string"
			? { result, paths }
			: undefined;
	} catch {
		return undefined;
	}
}

export async function persistArtifacts(
	paths: ArtifactPaths,
	result: MeatResult,
	original: string,
	metadata: { source: string; model: string },
): Promise<void> {
	await secureDirectory(dirname(paths.cacheRoot));
	await secureDirectory(paths.cacheRoot);
	await secureDirectory(dirname(paths.root));
	await secureDirectory(paths.root);
	await Promise.all([
		atomicWrite(paths.reading, result.smartDiff),
		atomicWrite(paths.original, original),
	]);
	await atomicWrite(
		paths.result,
		`${JSON.stringify({ ...result, ...metadata }, null, 2)}\n`,
	);
	// Atomic manifest switch publishes one immutable generation as complete snapshot.
	await atomicWrite(
		join(paths.cacheRoot, "current.json"),
		`${JSON.stringify({ generation: paths.generation })}\n`,
	);
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}

async function secureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

export async function secureCacheTree(path: string): Promise<void> {
	let stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			await secureDirectory(path);
			return;
		}
		throw error;
	}
	if (stats.isSymbolicLink()) return;
	if (!stats.isDirectory()) {
		await chmod(path, 0o600);
		return;
	}
	await chmod(path, 0o700);
	for (const entry of await readdir(path, { withFileTypes: true }))
		await secureCacheTree(join(path, entry.name));
}
