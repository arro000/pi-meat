import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import { Text, type Terminal } from "@earendil-works/pi-tui";
import { abridgeTarget, generateAbridged, readAbridged } from "./abridge.ts";
import { gitRoot, readGitDiff } from "./git.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import { CommentDialog, MeatDiffViewer, type ViewerAction } from "./viewer.ts";
import { CommitWarmer } from "./warm.ts";
import {
	loadMeatSettings,
	openMeatSettings,
	resolveMeatModel,
} from "./settings.ts";

const BRAND = "🥩 pi-meat";

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
	const warmer = new CommitWarmer(pi);

	pi.on("session_start", (_event, ctx) => warmer.arm(ctx));
	pi.on("session_shutdown", () => warmer.dispose());
	pi.on("agent_settled", (_event, ctx) => warmer.noteSettled(ctx));

	pi.on("tool_result", (event, ctx) => {
		if (!isBashToolResult(event)) return;
		const command = event.input.command;
		if (typeof command === "string") warmer.noteCommand(ctx, command);
	});

	pi.on("user_bash", (event, ctx) => warmer.noteCommand(ctx, event.command));

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
				// An explicit run owns the bridge; background pre-processing yields.
				warmer.cancel();
				const repoRoot = await gitRoot(pi, ctx.cwd);
				const { diff, source } = await readGitDiff(
					pi,
					repoRoot,
					selectedSource,
				);
				if (!diff.trim()) throw new Error(`No changes found for ${source}`);

				const thinkingLevel = clampThinkingLevel(
					model,
					settings.thinkingLevel ?? ctx.thinkingLevel ?? "medium",
				);
				const target = abridgeTarget(diff, model, thinkingLevel);
				const meatModelLabel = target.label;
				const cacheEntry = parsedArgs.fresh
					? undefined
					: await readAbridged(target);
				let result = cacheEntry?.result;
				let paths = cacheEntry?.paths;
				const cached = result !== undefined;

				let viewer: MeatDiffViewer | undefined;
				let computation: Promise<void> | undefined;
				const controller = new AbortController();
				const action = await ctx.ui.custom<ViewerAction>(
					(tui, theme, _keybindings, done) => {
						let startComputation = () => {};
						const createdViewer = new MeatDiffViewer({
							theme,
							summary: result?.summary ?? "",
							originalDiff: diff,
							readingDiff: result?.smartDiff,
							modelLabel: meatModelLabel,
							onDemand: settings.startupMode === "on-demand" && !result,
							startReading: () => startComputation(),
							viewportHeight: () => Math.max(8, tui.terminal.rows - 9),
							done,
							requestRender: () => tui.requestRender(),
							requestComment: (anchor, currentText) =>
								ctx.ui.custom<string | undefined>(
									(dialogTui, dialogTheme, _dialogKeys, closeDialog) =>
										new CommentDialog({
											theme: dialogTheme,
											anchor,
											currentText,
											done: closeDialog,
											requestRender: () => dialogTui.requestRender(),
										}),
									{
										overlay: true,
										overlayOptions: {
											anchor: "center",
											width: "70%",
											minWidth: 48,
											maxHeight: 4,
											margin: 1,
										},
									},
								),
						});
						viewer = createdViewer;

						startComputation = () => {
							if (result || computation) return;
							createdViewer.setProgress("Starting Meat…");
							ctx.ui.setStatus("pi-meat", "🥩 Starting Meat…");
							computation = (async () => {
								const computed = await generateAbridged({
									ctx,
									model,
									target,
									diff,
									source,
									signal: controller.signal,
									onProgress: (message) => {
										createdViewer.setProgress(message);
										ctx.ui.setStatus(
											"pi-meat",
											`🥩 ${sanitizeTerminalText(message)}`,
										);
										tui.requestRender();
									},
								});
								result = computed.result;
								paths = computed.paths;
								if (!controller.signal.aborted) {
									createdViewer.setReading(
										computed.result.smartDiff,
										computed.result.summary,
									);
									ctx.ui.setStatus("pi-meat", "🥩 Reading diff ready");
									tui.requestRender();
								}
							})().catch((error) => {
								if (controller.signal.aborted) return;
								createdViewer.setReadingError(
									error instanceof Error ? error.message : String(error),
								);
								ctx.ui.setStatus("pi-meat", "🥩 Reading diff failed");
								tui.requestRender();
							});
						};
						if (!result && settings.startupMode !== "on-demand")
							startComputation();

						const stopMouseReporting = startMouseReporting(tui.terminal);
						return {
							render: (width) => createdViewer.render(width),
							handleInput: (data) => {
								createdViewer.handleInput(data);
								tui.requestRender();
							},
							invalidate: () => createdViewer.invalidate(),
							dispose: () => {
								controller.abort();
								stopMouseReporting();
								createdViewer.dispose();
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
				await computation;
				ctx.ui.setStatus("pi-meat", undefined);
				if (!result || !paths) return;

				const artifact: ArtifactEntry = {
					summary: result.summary,
					source,
					model: meatModelLabel,
					readingPath: paths.reading,
					originalPath: paths.original,
					inputTokens: result.inputTokens,
					outputTokens: result.outputTokens,
					cached,
				};
				pi.appendEntry("pi-meat-result", artifact);

				if (selectedAction === "review" || action === "review") {
					const comments = viewer?.getComments() ?? [];
					const commentContext = comments.length
						? `\n\nUser comments to address:\n${comments
								.map(
									(comment, index) =>
										`${index + 1}. ${comment.filePath}:${comment.line} (${comment.side})\n   Code: ${comment.snippet}\n   Comment: ${comment.text}`,
								)
								.join("\n")}`
						: "";
					pi.sendUserMessage(
						`Review the ${source} changes. Meat's reading diff is at ${paths.reading}; the immutable original diff is at ${paths.original}. Start from the reading diff for intent, but verify every finding against the original diff and repository source. Focus on correctness, regressions, security, and architectural consequences rather than style.${commentContext}`,
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
		terminal.write("\x1b[?1003l\x1b[?1006l");
	};
	// Any-event tracking reports hover and wheel events, including tilt wheels.
	terminal.write("\x1b[?1003h\x1b[?1006h");
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
