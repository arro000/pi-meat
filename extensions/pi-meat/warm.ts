import { dirname } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { abridgeTarget, generateAbridged, readAbridged } from "./abridge.ts";
import { pruneCacheRoots } from "./cache.ts";
import { gitRoot, headRevision, readGitDiff } from "./git.ts";
import { loadMeatSettings, resolveMeatModel } from "./settings.ts";
import { sanitizeTerminalText } from "./terminal.ts";

/**
 * Dedicated status key. `pi-meat` is already owned by the `/meat` loader and by
 * the settings picker, so sharing it would make both flicker.
 */
const STATUS_KEY = "pi-meat-warm";

/** Commands that can produce a new revision worth pre-processing. */
const COMMIT_COMMAND =
	/\bgit\b(?:\s+--?[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+(?:commit|merge|rebase|cherry-pick|am|revert)(?![\w-])/;

export function isCommitCommand(command: string): boolean {
	return COMMIT_COMMAND.test(command);
}

const FIRST_POLL_DELAY_MS = 4_000;
const MAX_POLL_DELAY_MS = 30_000;
const POLL_BACKOFF = 1.5;

/** Content-addressed cache roots retained on disk (one per distinct diff). */
const CACHE_ROOT_LIMIT = 50;

interface ActiveWarm {
	controller: AbortController;
}

/**
 * Background pre-processing for new Git commits.
 *
 * Detection is layered: agent-driven commits are noticed from tool and bash
 * events with no polling cost, while a backed-off poll catches commits made
 * outside Pi. Only immutable revisions (a commit id) are warmed, because
 * worktree-derived sources change on every keystroke and would burn tokens
 * without ever producing a cache hit.
 */
export class CommitWarmer {
	private readonly pi: ExtensionAPI;
	private ctx: ExtensionContext | undefined;
	private timer: NodeJS.Timeout | undefined;
	private delay = FIRST_POLL_DELAY_MS;
	private lastSeenRevision: string | undefined;
	private pendingRevision: string | undefined;
	private inflight: Promise<void> | undefined;
	private active: ActiveWarm | undefined;
	private disposed = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** Arms the poll for the current session. Safe to call repeatedly. */
	arm(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.disposed = false;
		if (this.timer) return;
		this.schedule(this.delay);
	}

	/** Preempts background work so an explicit `/meat` run owns the bridge. */
	cancel(): void {
		this.active?.controller.abort();
	}

	/** Records a command that may create a commit; ignores everything else. */
	noteCommand(ctx: ExtensionContext, command: string): void {
		if (!isCommitCommand(command)) return;
		this.noteActivity(ctx);
	}

	/** Records the end of an agent run, which may have created commits. */
	noteSettled(ctx: ExtensionContext): void {
		this.noteActivity(ctx);
	}

	private noteActivity(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.delay = FIRST_POLL_DELAY_MS;
		void this.checkOnce();
	}

	/** Aborts in-flight work and stops polling for this session. */
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.cancel();
		this.ctx?.ui.setStatus(STATUS_KEY, undefined);
		this.ctx = undefined;
		await this.inflight?.catch(() => undefined);
	}

	private schedule(delay: number): void {
		if (this.disposed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.checkOnce().finally(() => this.schedule(this.delay));
		}, delay);
		// Never hold the process open for background pre-processing.
		this.timer.unref?.();
	}

	private growDelay(): void {
		this.delay = Math.min(MAX_POLL_DELAY_MS, this.delay * POLL_BACKOFF);
	}

	/** Runs a single detection and pre-processing pass. */
	async checkOnce(): Promise<void> {
		const ctx = this.ctx;
		if (!ctx || this.disposed) return;
		// A warm during an active turn competes with the agent for provider
		// rate limits and would run nested model calls while Pi streams.
		if (!ctx.isIdle()) return;
		try {
			const settings = await loadMeatSettings();
			if (!settings.backgroundPreprocess) {
				// Stay armed so the toggle takes effect without a restart, but back
				// off instead of re-reading settings every poll interval.
				this.growDelay();
				return;
			}
			const revision = await headRevision(this.pi, ctx.cwd);
			if (!revision || revision === this.lastSeenRevision) {
				this.growDelay();
				return;
			}
			this.lastSeenRevision = revision;
			this.delay = FIRST_POLL_DELAY_MS;
			await this.warm(ctx, revision);
		} catch {
			// Background work never reports through the transcript.
		}
	}

	private async warm(ctx: ExtensionContext, revision: string): Promise<void> {
		if (this.inflight) {
			// Coalesce: only the newest revision is worth pre-processing.
			this.pendingRevision = revision;
			return;
		}
		this.inflight = this.run(ctx, revision).finally(() => {
			this.inflight = undefined;
			const pending = this.pendingRevision;
			this.pendingRevision = undefined;
			if (pending && pending !== revision && !this.disposed)
				void this.warm(ctx, pending);
		});
		await this.inflight;
	}

	private async run(ctx: ExtensionContext, revision: string): Promise<void> {
		const controller = new AbortController();
		this.active = { controller };
		try {
			const settings = await loadMeatSettings();
			const model = await resolveMeatModel(ctx, settings.defaultModel);
			if (!model) return;
			const root = await gitRoot(this.pi, ctx.cwd);
			const { diff, source } = await readGitDiff(this.pi, root, revision);
			if (!diff.trim()) return;
			// The command derives the same level, so a warmed revision is a cache hit.
			const thinkingLevel = clampThinkingLevel(
				model,
				settings.thinkingLevel ?? ctx.thinkingLevel ?? "medium",
			);
			const target = abridgeTarget(diff, model, thinkingLevel);
			if (await readAbridged(target)) return;
			if (controller.signal.aborted) return;

			ctx.ui.setStatus(
				STATUS_KEY,
				`🥩 pre-processing ${revision.slice(0, 12)}`,
			);
			await generateAbridged({
				ctx,
				model,
				target,
				diff,
				source,
				signal: controller.signal,
				onProgress: (message) =>
					ctx.ui.setStatus(STATUS_KEY, `🥩 ${sanitizeTerminalText(message)}`),
			});
			await pruneCacheRoots(dirname(target.cacheRoot), CACHE_ROOT_LIMIT, [
				target.cacheRoot,
			]);
		} catch {
			// Missing model, Git failure, provider error and cancellation are all
			// silent: pre-processing is opportunistic and must never nag.
		} finally {
			this.active = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}
}
