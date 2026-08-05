import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text, type Terminal } from "@earendil-works/pi-tui";
import { runBridge } from "./bridge.ts";
import {
	artifactPaths,
	artifactRoot,
	persistArtifacts,
	readCache,
	secureCacheTree,
} from "./cache.ts";
import {
	toPiContext,
	type GenerateRequest,
	type MeatResult,
	PROTOCOL_VERSION,
} from "./protocol.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import { MeatDiffViewer, type ViewerAction } from "./viewer.ts";
import {
	loadMeatSettings,
	openMeatSettings,
	resolveMeatModel,
} from "./settings.ts";

const BRAND = "🥩 pi-meat";
const CACHE_VERSION = `bridge-${PROTOCOL_VERSION}-diff-only-v2`;

interface ArtifactEntry {
	summary: string;
	source: string;
	model: string;
	readingPath: string;
	originalPath: string;
	inputTokens: number;
	outputTokens: number;
	cached: boolean;
}

type MeatAction = "explore" | "review";

const SOURCE_OPTIONS = [
	"Latest commit (HEAD)",
	"Staged changes",
	"Unstaged changes",
	"All local changes",
	"Commit range",
	"Branch compared with main",
	"Custom revision or range",
];

function sourceFromMenuChoice(choice: string): string | undefined {
	switch (choice) {
		case "Latest commit (HEAD)":
			return "HEAD";
		case "Staged changes":
			return "staged";
		case "Unstaged changes":
			return "worktree";
		case "All local changes":
			return "all";
		case "Branch compared with main":
			return "main...HEAD";
	}
	return undefined;
}

async function chooseMeatSource(
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const choice = await ctx.ui.select(
		"What do you want to examine?",
		SOURCE_OPTIONS,
	);
	if (!choice) return undefined;
	const source = sourceFromMenuChoice(choice);
	if (source) return source;
	const placeholder =
		choice === "Commit range"
			? "e.g. v1.2.0..HEAD or main...HEAD"
			: "e.g. HEAD~3, feature...main, or a commit SHA";
	return (
		(await ctx.ui.input("Enter a revision or range", placeholder))?.trim() ||
		undefined
	);
}

async function chooseMeatAction(
	ctx: ExtensionCommandContext,
): Promise<MeatAction | undefined> {
	const choice = await ctx.ui.select("What do you want to do?", [
		"Explore changes",
		"Review changes with Pi",
	]);
	if (choice === "Review changes with Pi") return "review";
	if (choice === "Explore changes") return "explore";
	return undefined;
}

export default function piMeat(pi: ExtensionAPI) {
	pi.registerEntryRenderer("pi-meat-result", (entry, _options, theme) => {
		const data = entry.data as ArtifactEntry;
		return new Text(
			`${theme.fg("accent", theme.bold(BRAND))} ${theme.fg("muted", data.cached ? "cached" : `${data.inputTokens + data.outputTokens} tokens`)}\n` +
				`${theme.fg("text", sanitizeTerminalText(data.summary))}\n${theme.fg("dim", sanitizeTerminalText(`${data.source} · ${data.model} · ${data.readingPath}`))}`,
			1,
			0,
		);
	});

	pi.registerCommand("meat", {
		description:
			"Open a navigable Meat reading diff using your configured Pi model",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"pi-meat currently requires Pi's interactive TUI",
					"error",
				);
				return;
			}
			if (args.trim() === "settings") {
				await openMeatSettingsSafely(ctx);
				return;
			}

			try {
				const menuRequested = args.trim() === "" || args.trim() === "--fresh";
				const parsedArgs = parseArgs(args);
				const selectedSource = menuRequested
					? await chooseMeatSource(ctx)
					: parsedArgs.source;
				if (!selectedSource) return;
				const selectedAction: MeatAction | undefined = menuRequested
					? await chooseMeatAction(ctx)
					: "explore";
				if (!selectedAction) return;

				const settings = await loadMeatSettings();
				const model = await resolveMeatModel(ctx, settings.defaultModel);
				if (!model) {
					ctx.ui.notify(
						"Select and authenticate a Pi model first (/meat-settings)",
						"error",
					);
					return;
				}
				const repoRoot = await gitRoot(pi, ctx);
				const { diff, source } = await readGitDiff(
					pi,
					repoRoot,
					selectedSource,
				);
				if (!diff.trim()) throw new Error(`No changes found for ${source}`);

				const modelLabel = `${model.provider}/${model.id}`;
				const key = createHash("sha256")
					.update(CACHE_VERSION)
					.update("\0")
					.update(modelLabel)
					.update("\0")
					.update(diff)
					.digest("hex");
				const cacheRoot = artifactRoot(key);
				await secureCacheTree(dirname(cacheRoot));
				const cacheEntry = parsedArgs.fresh
					? undefined
					: await readCache(cacheRoot);
				let result = cacheEntry?.result;
				let paths = cacheEntry?.paths;
				const cached = result !== undefined;

				if (!result) {
					const computed = await runWithLoader(
						ctx,
						source,
						modelLabel,
						async (signal, progress) => {
							const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
							if (!auth.ok) throw new Error(auth.error);

							const nestedSessionId = randomUUID();
							return runBridge({
								diff,
								signal,
								onProgress: progress,
								onGenerate: async (request: GenerateRequest) => {
									const meatContext = toPiContext(request);
									const response = await completeSimple(
										model,
										{ systemPrompt: request.system, ...meatContext },
										{
											apiKey: auth.apiKey,
											headers: auth.headers,
											env: auth.env,
											signal,
											reasoning:
												ctx.thinkingLevel === "off"
													? undefined
													: ctx.thinkingLevel,
											cacheRetention: "short",
											sessionId: nestedSessionId,
										},
									);
									if (response.stopReason === "error")
										throw new Error(
											response.errorMessage ?? "Pi model call failed",
										);
									if (response.stopReason === "aborted")
										throw new Error("Meat model call cancelled");
									return response;
								},
							});
						},
					);
					if (!computed) return;
					result = computed;
					paths = artifactPaths(cacheRoot, randomUUID());
					await persistArtifacts(paths, result, diff, {
						source,
						model: modelLabel,
					});
				}
				if (!paths) throw new Error("pi-meat cache paths are unavailable");

				const artifact: ArtifactEntry = {
					summary: result.summary,
					source,
					model: modelLabel,
					readingPath: paths.reading,
					originalPath: paths.original,
					inputTokens: result.inputTokens,
					outputTokens: result.outputTokens,
					cached,
				};
				pi.appendEntry("pi-meat-result", artifact);

				const finalResult = result;
				if (!finalResult) return;
				const action = await ctx.ui.custom<ViewerAction>(
					(tui, theme, _keybindings, done) => {
						const viewer = new MeatDiffViewer({
							theme,
							summary: finalResult.summary,
							originalDiff: diff,
							readingDiff: finalResult.smartDiff,
							modelLabel,
							viewportHeight: () => Math.max(8, tui.terminal.rows - 9),
							done,
						});
						const stopMouseReporting = startMouseReporting(tui.terminal);
						return {
							render: (width) => viewer.render(width),
							handleInput: (data) => {
								viewer.handleInput(data);
								tui.requestRender();
							},
							invalidate: () => viewer.invalidate(),
							dispose: () => {
								stopMouseReporting();
								viewer.dispose();
							},
						};
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "top-left",
							row: 0,
							col: 0,
							width: "100%",
							maxHeight: "100%",
						},
					},
				);

				if (selectedAction === "review" || action === "review") {
					pi.sendUserMessage(
						`Review the ${source} changes. Meat's reading diff is at ${paths.reading}; the immutable original diff is at ${paths.original}. Start from the reading diff for intent, but verify every finding against the original diff and repository source. Focus on correctness, regressions, security, and architectural consequences rather than style.`,
					);
				}
			} catch (error) {
				ctx.ui.setStatus("pi-meat", undefined);
				ctx.ui.notify(
					sanitizeTerminalText(
						error instanceof Error ? error.message : String(error),
					),
					"error",
				);
			}
		},
	});

	pi.registerCommand("meat-settings", {
		description: "Configure pi-meat model in TUI",
		handler: async (_args, ctx) => {
			await openMeatSettingsSafely(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Open pi-meat settings",
		handler: async (ctx) => {
			await openMeatSettingsSafely(ctx);
		},
	});
}

function startMouseReporting(terminal: Terminal): () => void {
	let active = true;
	const stop = () => {
		if (!active) return;
		active = false;
		terminal.write("\x1b[?1002l\x1b[?1006l");
	};
	// Button-event tracking reports wheel events, including horizontal wheels.
	// 1000 is not enough in terminals that expose tilt wheels as button events.
	terminal.write("\x1b[?1002h\x1b[?1006h");
	process.once("exit", stop);
	return () => {
		process.removeListener("exit", stop);
		stop();
	};
}

async function openMeatSettingsSafely(ctx: ExtensionContext): Promise<void> {
	try {
		await openMeatSettings(ctx);
	} catch (error) {
		ctx.ui.notify(
			sanitizeTerminalText(
				error instanceof Error ? error.message : String(error),
			),
			"error",
		);
	}
}

async function runWithLoader(
	ctx: ExtensionCommandContext,
	source: string,
	model: string,
	run: (
		signal: AbortSignal,
		progress: (message: string) => void,
	) => Promise<MeatResult>,
): Promise<MeatResult | null> {
	const result = await ctx.ui.custom<MeatResult | null>(
		(tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(
				tui,
				theme,
				`${BRAND} · abridging ${sanitizeTerminalText(source)} with ${sanitizeTerminalText(model)}`,
				{ cancellable: true },
			);
			loader.onAbort = () => done(null);
			const progress = (message: string) =>
				ctx.ui.setStatus("pi-meat", `🥩 ${sanitizeTerminalText(message)}`);
			run(loader.signal, progress)
				.then(done)
				.catch((error) => {
					if (!loader.signal.aborted)
						ctx.ui.notify(
							sanitizeTerminalText(
								error instanceof Error ? error.message : String(error),
							),
							"error",
						);
					done(null);
				});
			return loader;
		},
	);
	ctx.ui.setStatus("pi-meat", undefined);
	return result ?? null;
}

async function gitRoot(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd: ctx.cwd,
	});
	if (result.code !== 0)
		throw new Error("pi-meat must run inside a Git repository");
	return result.stdout.trim();
}

async function readGitDiff(
	pi: ExtensionAPI,
	cwd: string,
	source: string,
): Promise<{ diff: string; source: string }> {
	if (source.startsWith("-"))
		throw new Error("Git source cannot start with '-'");
	let args: string[];
	if (source === "staged")
		args = ["diff", "--staged", "--no-ext-diff", "--no-color"];
	else if (source === "worktree")
		args = ["diff", "--no-ext-diff", "--no-color"];
	else if (source === "all")
		args = ["diff", "HEAD", "--no-ext-diff", "--no-color"];
	else if (source.includes(".."))
		args = ["diff", "--no-ext-diff", "--no-color", source];
	else
		args = [
			"show",
			"--format=fuller",
			"-m",
			"--first-parent",
			"--no-ext-diff",
			"--no-color",
			source,
		];
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0)
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return { diff: result.stdout, source };
}

function parseArgs(raw: string): { source: string; fresh: boolean } {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const freshIndex = tokens.indexOf("--fresh");
	const fresh = freshIndex >= 0;
	if (fresh) tokens.splice(freshIndex, 1);
	if (tokens.length > 1)
		throw new Error(
			"Usage: /meat [HEAD|revision|range|staged|worktree|all] [--fresh]",
		);
	const value = tokens[0] ?? "HEAD";
	return { source: value === "w" ? "worktree" : value, fresh };
}
