import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type {
	ExecOptions,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { abridgeTarget, readAbridged } from "../extensions/pi-meat/abridge.ts";
import { readGitDiff } from "../extensions/pi-meat/git.ts";
import { CommitWarmer, isCommitCommand } from "../extensions/pi-meat/warm.ts";

const run = promisify(execFile);

test("recognizes commit-producing commands only", () => {
	for (const command of [
		"git commit -m 'x'",
		"git -c user.name=x commit --amend",
		"git merge feature",
		"git rebase -i main",
		"git cherry-pick abc123",
		"git revert HEAD",
		"git am patch.diff",
	])
		assert.equal(isCommitCommand(command), true, command);
	for (const command of [
		"git status",
		"git log --oneline",
		"git commit-graph write",
		"npm test",
		"git difftool --commit",
	])
		assert.equal(isCommitCommand(command), false, command);
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { cwd });
	return stdout;
}

async function createRepository(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await run("git", ["init", "--quiet", "--initial-branch=main"], {
		cwd: directory,
	});
	await run("git", ["config", "user.email", "pi-meat@example.test"], {
		cwd: directory,
	});
	await run("git", ["config", "user.name", "pi-meat test"], { cwd: directory });
	await git(directory, "commit", "--quiet", "--allow-empty", "-m", "initial");
}

const MEAT_MODEL = {
	provider: "test",
	id: "model",
	name: "Test",
	reasoning: true,
};

function fakeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		model: MEAT_MODEL,
		isIdle: () => true,
		ui: { setStatus: () => undefined, notify: () => undefined },
		modelRegistry: {
			getAvailable: () => [MEAT_MODEL],
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "test-key",
				headers: {},
				env: {},
			}),
		},
	} as unknown as ExtensionContext;
}

function fakePi(): ExtensionAPI {
	return {
		exec: async (file: string, args: string[], options?: ExecOptions) => {
			try {
				const { stdout, stderr } = await run(file, args, {
					cwd: options?.cwd,
					encoding: "utf8",
				});
				return { code: 0, stdout, stderr };
			} catch (error) {
				const failure = error as {
					code?: number;
					stdout?: string;
					stderr?: string;
				};
				return {
					code: typeof failure.code === "number" ? failure.code : 1,
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? "",
				};
			}
		},
	} as unknown as ExtensionAPI;
}

interface Fixture {
	directory: string;
	repository: string;
	cache: string;
	settings: string;
	restore: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-warm-"));
	const repository = join(directory, "repo");
	const cache = join(directory, "cache");
	const settings = join(directory, "pi-meat.json");
	await createRepository(repository);
	const executable = join(directory, "fake-bridge.cjs");
	// The bridge answers without requesting a generation, so no model call runs.
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "result", summary: "warmed", smart_diff: "reading", input_tokens: 1, output_tokens: 2 }) + "\\n", () => process.exit(0));
});
`,
	);
	await chmod(executable, 0o755);
	const previous = {
		cache: process.env.PI_MEAT_CACHE,
		settings: process.env.PI_MEAT_SETTINGS,
		bridge: process.env.PI_MEAT_BRIDGE,
	};
	process.env.PI_MEAT_CACHE = cache;
	process.env.PI_MEAT_SETTINGS = settings;
	process.env.PI_MEAT_BRIDGE = executable;
	return {
		directory,
		repository,
		cache,
		settings,
		restore: async () => {
			for (const [key, value] of [
				["PI_MEAT_CACHE", previous.cache],
				["PI_MEAT_SETTINGS", previous.settings],
				["PI_MEAT_BRIDGE", previous.bridge],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function cacheRoots(cache: string): Promise<string[]> {
	try {
		const entries = await readdir(cache, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

test("pre-processes a new commit into the cache the viewer reads", async () => {
	const context = await fixture();
	try {
		await writeFile(context.settings, '{"backgroundPreprocess":true}\n');
		const pi = fakePi();
		const ctx = fakeContext(context.repository);
		const warmer = new CommitWarmer(pi);
		try {
			await git(
				context.repository,
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"second",
			);
			warmer.arm(ctx);
			await warmer.checkOnce();

			const roots = await cacheRoots(context.cache);
			assert.equal(roots.length, 1);

			const { diff, source } = await readDiff(pi, context.repository);
			const target = abridgeTarget(diff, ctx.model as never, "medium");
			const cached = await readAbridged(target);
			assert.equal(cached?.result.summary, "warmed");
			assert.equal(cached?.result.smartDiff, "reading");
			assert.equal(source, "HEAD");
		} finally {
			await warmer.dispose();
		}
	} finally {
		await context.restore();
	}
});

test("does nothing while the setting is off", async () => {
	const context = await fixture();
	try {
		await writeFile(context.settings, "{}\n");
		const warmer = new CommitWarmer(fakePi());
		try {
			const ctx = fakeContext(context.repository);
			await git(
				context.repository,
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"second",
			);
			warmer.arm(ctx);
			const before = pollDelay(warmer);
			await warmer.checkOnce();
			assert.deepEqual(await cacheRoots(context.cache), []);
			// The poll stays armed so a toggle takes effect live, but it must back
			// off instead of re-reading settings every few seconds forever.
			assert.ok(
				pollDelay(warmer) > before,
				"disabled pre-processing must back off",
			);
		} finally {
			await warmer.dispose();
		}
	} finally {
		await context.restore();
	}
});

function pollDelay(warmer: CommitWarmer): number {
	return (warmer as unknown as { delay: number }).delay;
}

test("skips revisions that are already cached", async () => {
	const context = await fixture();
	try {
		await writeFile(context.settings, '{"backgroundPreprocess":true}\n');
		const pi = fakePi();
		const ctx = fakeContext(context.repository);
		const warmer = new CommitWarmer(pi);
		try {
			await git(
				context.repository,
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"second",
			);
			warmer.arm(ctx);
			await warmer.checkOnce();
			const afterFirst = await cacheRoots(context.cache);
			assert.equal(afterFirst.length, 1);

			// A new warmer over the same revision must reuse the artifact.
			const second = new CommitWarmer(pi);
			try {
				second.arm(ctx);
				await second.checkOnce();
			} finally {
				await second.dispose();
			}
			assert.deepEqual(await cacheRoots(context.cache), afterFirst);
		} finally {
			await warmer.dispose();
		}
	} finally {
		await context.restore();
	}
});

test("never pre-processes while the agent is busy", async () => {
	const context = await fixture();
	try {
		await writeFile(context.settings, '{"backgroundPreprocess":true}\n');
		const warmer = new CommitWarmer(fakePi());
		try {
			const ctx = fakeContext(context.repository);
			await git(
				context.repository,
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"second",
			);
			(ctx as unknown as { isIdle: () => boolean }).isIdle = () => false;
			warmer.arm(ctx);
			await warmer.checkOnce();
			assert.deepEqual(await cacheRoots(context.cache), []);
		} finally {
			await warmer.dispose();
		}
	} finally {
		await context.restore();
	}
});

async function readDiff(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ diff: string; source: string }> {
	return readGitDiff(pi, cwd, "HEAD");
}
