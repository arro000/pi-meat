import {
	getLanguageFromPath,
	highlightCode,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	Input,
	Key,
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	parseUnifiedDiff,
	type DiffFile,
	type DiffLine,
	type ParsedDiff,
} from "../../internal/diff.ts";
import {
	buildSplitRows,
	fileLines,
	type NumberedDiffLine,
	type SplitDiffRow,
} from "./diff-layout.ts";
import { sanitizeTerminalText } from "./terminal.ts";

export type ViewerAction = "close" | "review";
type ViewMode = "reading" | "original";
type LayoutMode = "split" | "unified";
const COMMENT_ICON = "💬";

export interface DiffComment {
	id: string;
	filePath: string;
	side: "old" | "new";
	line: number;
	text: string;
	snippet: string;
}

export interface CommentAnchor {
	filePath: string;
	side: "old" | "new";
	line: number;
	snippet: string;
}

export interface MeatDiffViewerOptions {
	theme: Theme;
	summary: string;
	originalDiff: string;
	readingDiff?: string;
	modelLabel: string;
	viewportHeight: () => number;
	done: (action: ViewerAction) => void;
	requestComment?: (
		anchor: CommentAnchor,
		currentText: string | undefined,
	) => Promise<string | undefined>;
	requestRender?: () => void;
	onDemand?: boolean;
	startReading?: () => void;
}

export class MeatDiffViewer {
	private mode: ViewMode = "reading";
	private layout: LayoutMode = "split";
	private selectedFile = 0;
	private scroll = 0;
	private horizontalScroll = 0;
	private sidebarScroll = 0;
	private help = false;
	private collapsed = false;
	private lastLayout: LayoutMode = "split";
	private lastBodyHeight = 8;
	private lastContentWidth = 88;
	private lastSidebarWidth = 0;
	private lastBodyStartRow = 5;
	private hoverAnchor: CommentAnchor | undefined;
	private pendingComment = false;
	private comments: DiffComment[] = [];
	private reading: ParsedDiff | undefined;
	private readonly original: ParsedDiff;
	private readonly options: MeatDiffViewerOptions;
	private summary: string;
	private progressMessage = "Starting Meat…";
	private readingError: string | undefined;
	private readingStarted: boolean;

	constructor(options: MeatDiffViewerOptions) {
		this.options = options;
		this.original = parseUnifiedDiff(options.originalDiff);
		this.reading =
			options.readingDiff === undefined
				? undefined
				: parseUnifiedDiff(options.readingDiff);
		this.summary = options.summary;
		this.readingStarted = Boolean(this.reading) || !options.onDemand;
		if (!this.reading) this.mode = "original";
	}

	setProgress(message: string): void {
		this.readingStarted = true;
		if (!this.reading && !this.readingError) this.progressMessage = message;
	}

	setReading(readingDiff: string, summary: string): void {
		const path = this.active.files[this.selectedFile]?.path;
		this.reading = parseUnifiedDiff(readingDiff);
		this.summary = summary;
		this.readingError = undefined;
		if (this.mode === "reading" && path) {
			const match = this.reading.files.findIndex((file) => file.path === path);
			if (match >= 0) this.selectedFile = match;
		}
		this.scroll = 0;
		this.horizontalScroll = 0;
	}

	setReadingError(message: string): void {
		if (!this.reading) this.readingError = message;
	}

	handleInput(data: string): void {
		const mouse = parseMouseEvent(data);
		if (mouse) {
			this.handleMouse(mouse);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.options.done("close");
			return;
		}
		if (data === "r") {
			this.options.done("review");
			return;
		}
		if (data === "c") {
			this.startCommentAt(this.selectedContentPosition());
			return;
		}
		if (data === "?") {
			this.help = !this.help;
			return;
		}
		if (data === "s") {
			this.layout = this.layout === "split" ? "unified" : "split";
			this.scroll = 0;
			this.horizontalScroll = 0;
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.toggleMode();
			return;
		}
		if (
			matchesKey(data, Key.enter) &&
			this.mode === "reading" &&
			!this.reading &&
			!this.readingError &&
			!this.readingStarted
		) {
			this.readingStarted = true;
			this.options.startReading?.();
			return;
		}
		if (data === "n") {
			this.selectFile(1);
			return;
		}
		if (data === "p") {
			this.selectFile(-1);
			return;
		}
		if (data === "h" || matchesKey(data, Key.left)) {
			this.scrollHorizontally(-4);
			return;
		}
		if (data === "l" || matchesKey(data, Key.right)) {
			this.scrollHorizontally(4);
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.collapsed = !this.collapsed;
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp))
			this.scrollBy(-(this.lastBodyHeight - 1));
		else if (matchesKey(data, Key.pageDown))
			this.scrollBy(this.lastBodyHeight - 1);
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = this.maxScroll;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const theme = this.options.theme;
		this.ensureSelection();
		const sidebarWidth = this.sidebarWidth(w);
		const contentWidth = Math.max(
			1,
			w - (sidebarWidth > 0 ? sidebarWidth + 3 : 0),
		);
		const effectiveLayout: LayoutMode =
			this.layout === "split" && contentWidth >= 88 ? "split" : "unified";
		const bodyHeight = Math.max(
			5,
			this.options.viewportHeight() - (this.help ? 3 : 0),
		);
		this.lastLayout = effectiveLayout;
		this.lastBodyHeight = bodyHeight;
		this.lastContentWidth = contentWidth;
		this.lastSidebarWidth = sidebarWidth;
		this.lastBodyStartRow = 5 + (this.help ? 3 : 0);
		this.horizontalScroll = clamp(
			this.horizontalScroll,
			0,
			this.maxHorizontalScroll,
		);
		const content = this.renderContent(
			contentWidth,
			bodyHeight,
			effectiveLayout,
		);
		const sidebar =
			sidebarWidth > 0 ? this.renderSidebar(sidebarWidth, bodyHeight) : [];
		const lines = this.renderHeader(w, effectiveLayout);

		if (this.help) lines.push(...this.renderHelp(w));
		for (let row = 0; row < bodyHeight; row++) {
			const contentLine = content[row] ?? "";
			if (sidebarWidth === 0) lines.push(fit(contentLine, w));
			else
				lines.push(
					`${pad(sidebar[row] ?? "", sidebarWidth)} ${theme.fg("borderMuted", "│")} ${fit(contentLine, contentWidth)}`,
				);
		}
		lines.push(fit(theme.fg("borderMuted", "─".repeat(w)), w));
		lines.push(...this.renderFooter(w, effectiveLayout, contentWidth));
		return lines;
	}

	private renderFooter(
		width: number,
		layout: LayoutMode,
		contentWidth: number,
	): string[] {
		const theme = this.options.theme;
		const file = this.active.files[this.selectedFile];
		const position = file
			? `${this.selectedFile + 1}/${this.active.files.length} · ${sanitizeTerminalText(file.path)}`
			: "No changed files";
		const sourceWidth = this.sourceViewportWidth(layout, contentWidth);
		const sourceLength = Math.max(sourceWidth, this.maxSourceWidth);
		const columnEnd = Math.min(
			sourceLength,
			this.horizontalScroll + sourceWidth,
		);
		let commentCount = "";
		if (this.comments.length > 0) {
			const noun = this.comments.length === 1 ? "comment" : "comments";
			commentCount = ` · ${this.comments.length} ${noun}`;
		}
		return [
			fit(
				`${theme.fg("accent", position)} ${theme.fg("dim", `· line ${this.scroll + 1}/${Math.max(1, this.contentLength)} · col ${this.horizontalScroll + 1}-${Math.max(this.horizontalScroll + 1, columnEnd)}/${sourceLength}`)}`,
				width,
			),
			fit(
				theme.fg(
					"dim",
					`j/k ↑/↓ vertical · h/l ←/→ horizontal · c comment · r review · ? help${commentCount}`,
				),
				width,
			),
		];
	}

	invalidate(): void {}
	dispose(): void {}

	private get active(): ParsedDiff {
		return this.mode === "reading" && this.reading
			? this.reading
			: this.original;
	}
	private get selectedLines(): DiffLine[] {
		return fileLines(this.active, this.selectedFile);
	}
	private get contentLength(): number {
		if (this.collapsed) return 1;
		return this.lastLayout === "split"
			? this.splitContentLength()
			: this.selectedLines.length;
	}
	private get maxScroll(): number {
		return Math.max(0, this.contentLength - this.lastBodyHeight);
	}
	private get maxSourceWidth(): number {
		let width = 0;
		if (this.lastLayout === "split") {
			for (const row of buildSplitRows(this.active, this.selectedFile)) {
				if (row.kind !== "pair") continue;
				width = Math.max(
					width,
					sourceWidth(row.left?.text),
					sourceWidth(row.right?.text),
				);
			}
			return width;
		}
		for (const line of this.selectedLines) {
			if (!isUnifiedSourceLine(line)) continue;
			width = Math.max(width, sourceWidth(stripDiffMarker(line.text)));
		}
		return width;
	}
	private get maxHorizontalScroll(): number {
		return Math.max(
			0,
			this.maxSourceWidth -
				this.sourceViewportWidth(this.lastLayout, this.lastContentWidth),
		);
	}
	private get lineNumberWidth(): number {
		let width = 4;
		for (const row of buildSplitRows(this.active, this.selectedFile)) {
			if (row.kind !== "pair") continue;
			for (const line of [row.left, row.right]) {
				if (line?.number !== undefined)
					width = Math.max(width, String(line.number).length);
			}
		}
		return width;
	}

	private splitContentLength(): number {
		let count = 1; // OLD / NEW header
		for (const row of buildSplitRows(this.active, this.selectedFile)) {
			if (row.kind !== "meta" || showSplitMetadata(row)) count++;
		}
		return count;
	}

	private renderHeader(width: number, effectiveLayout: LayoutMode): string[] {
		const theme = this.options.theme;
		const readingLabel = this.reading ? "READING ✨" : "READING";
		const reading =
			this.mode === "reading"
				? theme.fg("accent", theme.bold(readingLabel))
				: theme.fg("dim", readingLabel);
		const original =
			this.mode === "original"
				? theme.fg("accent", theme.bold("ORIGINAL"))
				: theme.fg("dim", "ORIGINAL");
		const layout = effectiveLayout === "split" ? "SIDE-BY-SIDE" : "UNIFIED";
		let detail = this.readingStarted
			? `◌ Meat is processing · ${this.progressMessage}`
			: "○ Meat is on demand · open Reading and press Enter to start";
		if (this.reading) detail = `● ${this.summary || "Reading diff ready"}`;
		else if (this.readingError)
			detail = `× Reading diff failed: ${this.readingError}`;
		const path = sanitizeTerminalText(
			this.active.files[this.selectedFile]?.path ?? "No file selected",
		);
		const border = (left: string, fill: string, right: string) =>
			fit(
				theme.fg(
					"borderMuted",
					width > 1 ? `${left}${fill.repeat(width - 2)}${right}` : fill,
				),
				width,
			);
		const edge = theme.fg("borderMuted", "│");
		const fileLabel = `${theme.fg("accent", theme.bold("FILE"))}  ${theme.fg("text", path)}`;
		const pathLine =
			width > 1
				? `${edge}${pad(` ${fileLabel} `, width - 2)}${edge}`
				: fit(fileLabel, width);
		return [
			fit(
				`${theme.fg("accent", theme.bold("🥩 pi-meat"))}  ${reading}  ${original}  ${theme.fg("muted", layout)}`,
				width,
			),
			fit(
				`${theme.fg("text", sanitizeTerminalText(detail))} ${theme.fg("dim", `· ${sanitizeTerminalText(this.options.modelLabel)}`)}`,
				width,
			),
			border("┌", "─", "┐"),
			pathLine,
			border("└", "─", "┘"),
		];
	}

	private renderHelp(width: number): string[] {
		const muted = (text: string) =>
			fit(this.options.theme.fg("muted", text), width);
		return [
			muted("j/k ↑/↓ vertical · h/l ←/→ horizontal · n/p previous/next file"),
			muted(
				"PgUp/PgDn page · Home/End · Tab reading/original · Enter start on demand · s layout",
			),
			muted(
				"Space fold file · c comment on line · r review with Pi · ? help · q/Esc close",
			),
		];
	}

	private renderSidebar(width: number, height: number): string[] {
		const theme = this.options.theme;
		const files = this.active.files;
		const visibleCount = Math.max(1, height - 2);
		this.sidebarScroll = clamp(
			this.sidebarScroll,
			0,
			Math.max(0, files.length - visibleCount),
		);
		if (this.selectedFile < this.sidebarScroll)
			this.sidebarScroll = this.selectedFile;
		if (this.selectedFile >= this.sidebarScroll + visibleCount)
			this.sidebarScroll = this.selectedFile - visibleCount + 1;
		const lines = [
			theme.fg("accent", theme.bold(`FILES ${files.length}`)),
			theme.fg("borderMuted", "─".repeat(width)),
		];
		for (
			let index = this.sidebarScroll;
			index < Math.min(files.length, this.sidebarScroll + visibleCount);
			index++
		) {
			const file = files[index];
			if (!file) continue;
			lines.push(
				this.renderSidebarFile(file, index === this.selectedFile, width),
			);
		}
		return lines;
	}

	private renderSidebarFile(
		file: DiffFile,
		selected: boolean,
		width: number,
	): string {
		const theme = this.options.theme;
		const commentCount = this.comments.filter(
			(comment) => comment.filePath === file.path,
		).length;
		const counts = `+${file.added} -${file.removed}${commentCount ? ` ${COMMENT_ICON}${commentCount}` : ""}`;
		const marker = selected ? "▶ " : "  ";
		const pathWidth = Math.max(
			4,
			width - visibleWidth(marker) - visibleWidth(counts) - 1,
		);
		const label = `${marker}${truncateStartToWidth(sanitizeTerminalText(file.path), pathWidth)} ${counts}`;
		return fit(
			selected
				? theme.bg("selectedBg", theme.fg("text", label))
				: theme.fg("muted", label),
			width,
		);
	}

	private renderContent(
		width: number,
		height: number,
		layout: LayoutMode,
	): string[] {
		if (this.mode === "reading" && !this.reading) {
			if (!this.readingStarted)
				return [
					this.options.theme.fg("accent", "Start Meat?"),
					this.options.theme.fg(
						"muted",
						"Press Enter to build the reading diff",
					),
				];
			return this.readingError
				? [
						this.options.theme.fg("error", "Reading diff failed"),
						this.options.theme.fg(
							"muted",
							sanitizeTerminalText(this.readingError),
						),
					]
				: [
						this.options.theme.fg("accent", "Meat is processing…"),
						this.options.theme.fg(
							"muted",
							sanitizeTerminalText(this.progressMessage),
						),
					];
		}
		if (!this.active.files[this.selectedFile])
			return [this.options.theme.fg("muted", "No changed files")];
		if (this.collapsed)
			return [
				this.options.theme.fg("muted", "▸ File folded · Space to expand"),
			];
		const all =
			layout === "split" ? this.renderSplit(width) : this.renderUnified(width);
		this.scroll = clamp(this.scroll, 0, Math.max(0, all.length - height));
		return all.slice(this.scroll, this.scroll + height);
	}

	private renderUnified(width: number): string[] {
		const language = getLanguageFromPath(
			this.active.files[this.selectedFile]?.path ?? "",
		);
		const lines = this.selectedLines;
		const highlighted = highlightUnifiedSources(
			lines,
			language,
			this.options.theme,
		);
		return lines.map((line, index) => {
			if (!isUnifiedSourceLine(line))
				return colorText(line.text, line.kind, this.options.theme, width);
			const marker = colorText(
				line.text.slice(0, 1),
				line.kind,
				this.options.theme,
			);
			const oldLine = this.lineNumberForUnified(lines, index, "old");
			const newLine = this.lineNumberForUnified(lines, index, "new");
			const commented =
				(oldLine !== undefined && this.hasComment("old", oldLine)) ||
				(newLine !== undefined && this.hasComment("new", newLine));
			const hovered =
				(oldLine !== undefined && this.isHovered("old", oldLine)) ||
				(newLine !== undefined && this.isHovered("new", newLine));
			const commentMarker = commented
				? this.options.theme.fg("accent", COMMENT_ICON)
				: " ".repeat(visibleWidth(COMMENT_ICON));
			const prefix = `${marker}${commentMarker} `;
			const source = cropHighlightedSource(
				highlighted.get(index) ??
					sanitizeTerminalText(stripDiffMarker(line.text)),
				this.horizontalScroll,
				Math.max(0, width - visibleWidth(prefix)),
			);
			const value = fit(`${prefix}${source}`, width);
			return hovered
				? this.options.theme.bg("selectedBg", pad(value, width))
				: colorLineBackground(value, line.kind, this.options.theme);
		});
	}

	private renderSplit(width: number): string[] {
		const gap = 3;
		const columnWidth = Math.max(1, Math.floor((width - gap) / 2));
		const divider = ` ${this.options.theme.fg("borderMuted", "│")} `;
		const header = `${pad(this.options.theme.fg("error", "OLD"), columnWidth)}${divider}${fit(this.options.theme.fg("success", "NEW"), columnWidth)}`;
		const rows = buildSplitRows(this.active, this.selectedFile);
		const language = getLanguageFromPath(
			this.active.files[this.selectedFile]?.path ?? "",
		);
		const highlighted = highlightSplitSources(
			rows,
			language,
			this.options.theme,
		);
		const numberWidth = this.lineNumberWidth;
		const rendered = rows.flatMap((row, index) =>
			row.kind === "meta" && !showSplitMetadata(row)
				? []
				: [
						this.renderSplitRow(
							row,
							columnWidth,
							divider,
							width,
							numberWidth,
							highlighted.get(index),
						),
					],
		);
		return [header, ...rendered];
	}

	private renderSplitRow(
		row: SplitDiffRow,
		columnWidth: number,
		divider: string,
		width: number,
		numberWidth: number,
		highlighted: HighlightedPair | undefined,
	): string {
		if (row.kind === "meta")
			return fit(colorText(row.text, row.lineKind, this.options.theme), width);
		const left = renderNumbered(
			row.left,
			columnWidth,
			numberWidth,
			this.horizontalScroll,
			highlighted?.left,
			this.options.theme,
			row.left?.number !== undefined && this.hasComment("old", row.left.number),
			row.left?.number !== undefined && this.isHovered("old", row.left.number),
		);
		const right = renderNumbered(
			row.right,
			columnWidth,
			numberWidth,
			this.horizontalScroll,
			highlighted?.right,
			this.options.theme,
			row.right?.number !== undefined &&
				this.hasComment("new", row.right.number),
			row.right?.number !== undefined &&
				this.isHovered("new", row.right.number),
		);
		return `${pad(left, columnWidth)}${divider}${fit(right, columnWidth)}`;
	}

	private sidebarWidth(width: number): number {
		if (this.active.files.length < 2 || width < 120) return 0;
		return clamp(Math.floor(width * 0.22), 24, 32);
	}

	private sourceViewportWidth(layout: LayoutMode, width: number): number {
		if (layout === "split") {
			const columnWidth = Math.max(1, Math.floor((width - 3) / 2));
			return Math.max(
				0,
				columnWidth - this.lineNumberWidth - 3 - visibleWidth(COMMENT_ICON),
			);
		}
		return Math.max(0, width - 2 - visibleWidth(COMMENT_ICON));
	}

	private toggleMode(): void {
		const path = this.active.files[this.selectedFile]?.path;
		this.mode = this.mode === "reading" ? "original" : "reading";
		const match = path
			? this.active.files.findIndex((file) => file.path === path)
			: -1;
		this.selectedFile =
			match >= 0
				? match
				: clamp(
						this.selectedFile,
						0,
						Math.max(0, this.active.files.length - 1),
					);
		this.scroll = 0;
		this.horizontalScroll = 0;
		this.collapsed = false;
	}

	private selectFile(delta: number): void {
		if (this.active.files.length === 0) return;
		this.selectedFile = clamp(
			this.selectedFile + delta,
			0,
			this.active.files.length - 1,
		);
		this.scroll = 0;
		this.horizontalScroll = 0;
		this.collapsed = false;
	}

	private handleMouse(event: MouseEvent): void {
		if (event.action === "wheel-up") {
			this.hoverAnchor = undefined;
			this.scrollBy(-3);
			return;
		}
		if (event.action === "wheel-down") {
			this.hoverAnchor = undefined;
			this.scrollBy(3);
			return;
		}
		if (event.action === "wheel-left") {
			this.hoverAnchor = undefined;
			this.scrollHorizontally(-4);
			return;
		}
		if (event.action === "wheel-right") {
			this.hoverAnchor = undefined;
			this.scrollHorizontally(4);
			return;
		}

		const row = event.y - 1;
		const column = event.x - 1;
		if (event.action === "move") {
			this.hoverAnchor = this.contentPositionForMouse(row, column);
			return;
		}
		if (event.action !== "press") return;
		if (row === 0) {
			this.handleHeaderClick(column);
			return;
		}
		if (this.lastSidebarWidth > 0 && column < this.lastSidebarWidth) {
			const fileRow = row - this.lastBodyStartRow - 2;
			const fileIndex = this.sidebarScroll + fileRow;
			if (fileRow >= 0 && fileIndex < this.active.files.length)
				this.selectFileIndex(fileIndex);
			return;
		}
		const anchor = this.contentPositionForMouse(row, column);
		if (anchor) this.startCommentAt(anchor);
	}

	private contentPositionForMouse(
		row: number,
		column: number,
	): CommentAnchor | undefined {
		if (
			row < this.lastBodyStartRow ||
			row >= this.lastBodyStartRow + this.lastBodyHeight
		)
			return undefined;
		const contentColumn =
			this.lastSidebarWidth > 0 ? column - this.lastSidebarWidth - 3 : column;
		if (contentColumn < 0 || contentColumn >= this.lastContentWidth)
			return undefined;
		return this.contentPositionAt(row, contentColumn);
	}

	private contentPositionAt(
		row: number,
		column: number,
	): CommentAnchor | undefined {
		const contentRow = row - this.lastBodyStartRow;
		if (contentRow < 0) return undefined;
		if (this.lastLayout === "split") {
			const splitRowIndex = this.scroll + contentRow - 1;
			if (splitRowIndex < 0) return undefined;
			const rows = buildSplitRows(this.active, this.selectedFile).filter(
				(item) => item.kind !== "meta" || showSplitMetadata(item),
			);
			const splitRow = rows[splitRowIndex];
			if (!splitRow || splitRow.kind !== "pair") return undefined;
			const columnWidth = Math.max(
				1,
				Math.floor((this.lastContentWidth - 3) / 2),
			);
			const left = column < columnWidth;
			const line = left ? splitRow.left : splitRow.right;
			if (!line?.number) return undefined;
			return this.makeAnchor(left ? "old" : "new", line.number, line.text);
		}
		return this.unifiedContentPositionAt(contentRow);
	}

	private unifiedContentPositionAt(
		contentRow: number,
	): CommentAnchor | undefined {
		const index = this.scroll + contentRow;
		const line = this.selectedLines[index];
		if (!line || !isUnifiedSourceLine(line)) return undefined;
		const defaultSide = line.kind === "remove" ? "old" : "new";
		const otherSide = defaultSide === "old" ? "new" : "old";
		const snippet = stripDiffMarker(line.text);
		let fallback: CommentAnchor | undefined;
		for (const side of [defaultSide, otherSide] as const) {
			const number = this.lineNumberForUnified(this.selectedLines, index, side);
			if (number === undefined) continue;
			const anchor = this.makeAnchor(side, number, snippet);
			fallback ??= anchor;
			if (this.commentAt(anchor)) return anchor;
		}
		return fallback;
	}

	private selectedContentPosition(): CommentAnchor | undefined {
		return this.contentPositionAt(this.lastBodyStartRow, 0);
	}

	private lineNumberForUnified(
		lines: DiffLine[],
		index: number,
		side: "old" | "new",
	): number | undefined {
		let oldLine: number | undefined;
		let newLine: number | undefined;
		for (let cursor = 0; cursor <= index; cursor++) {
			const line = lines[cursor];
			if (!line) continue;
			if (line.kind === "hunk") {
				const match = line.text.match(/^@@ -(\d+)/);
				const newMatch = line.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
				oldLine = match ? Number(match[1]) : oldLine;
				newLine = newMatch ? Number(newMatch[1]) : newLine;
				continue;
			}
			if (cursor === index) break;
			if (line.kind === "remove" && oldLine !== undefined) oldLine++;
			if (line.kind === "add" && newLine !== undefined) newLine++;
			if (line.kind === "context") {
				if (oldLine !== undefined) oldLine++;
				if (newLine !== undefined) newLine++;
			}
		}
		return side === "old" ? oldLine : newLine;
	}

	private makeAnchor(
		side: "old" | "new",
		line: number,
		snippet: string,
	): CommentAnchor {
		return {
			filePath: this.active.files[this.selectedFile]?.path ?? "",
			side,
			line,
			snippet,
		};
	}

	private commentAt(anchor: CommentAnchor): DiffComment | undefined {
		return this.comments.find(
			(comment) =>
				comment.filePath === anchor.filePath &&
				comment.side === anchor.side &&
				comment.line === anchor.line,
		);
	}

	private hasComment(side: "old" | "new", line: number): boolean {
		return this.commentAt(this.makeAnchor(side, line, "")) !== undefined;
	}

	private isHovered(side: "old" | "new", line: number): boolean {
		return (
			this.hoverAnchor?.filePath ===
				this.active.files[this.selectedFile]?.path &&
			this.hoverAnchor.side === side &&
			this.hoverAnchor.line === line
		);
	}

	private startCommentAt(anchor: CommentAnchor | undefined): void {
		if (!anchor || !this.options.requestComment || this.pendingComment) return;
		const existing = this.commentAt(anchor);
		this.pendingComment = true;
		void this.options
			.requestComment(anchor, existing?.text)
			.then((text) => {
				if (text === undefined) return;
				const comment = text.trim();
				if (existing && !comment)
					this.comments.splice(this.comments.indexOf(existing), 1);
				else if (existing) existing.text = comment;
				else if (comment)
					this.comments.push({
						id: `${Date.now()}-${this.comments.length}`,
						...anchor,
						text: comment,
					});
			})
			.catch(() => {})
			.finally(() => {
				this.pendingComment = false;
				this.options.requestRender?.();
			});
	}

	getComments(): DiffComment[] {
		return this.comments.map((comment) => ({ ...comment }));
	}

	private handleHeaderClick(column: number): void {
		const brandWidth = visibleWidth("🥩 pi-meat  ");
		const readingEnd =
			brandWidth + visibleWidth(this.reading ? "READING ✨" : "READING");
		const originalStart = readingEnd + 2;
		const originalEnd = originalStart + visibleWidth("ORIGINAL");
		const layoutStart = originalEnd + 2;
		const layoutEnd =
			layoutStart +
			visibleWidth(this.lastLayout === "split" ? "SIDE-BY-SIDE" : "UNIFIED");
		if (column >= brandWidth && column < readingEnd) {
			if (this.mode !== "reading") this.toggleMode();
		} else if (column >= originalStart && column < originalEnd) {
			if (this.mode !== "original") this.toggleMode();
		} else if (column >= layoutStart && column < layoutEnd) {
			this.layout = this.layout === "split" ? "unified" : "split";
			this.scroll = 0;
			this.horizontalScroll = 0;
		}
	}

	private selectFileIndex(index: number): void {
		if (index === this.selectedFile) return;
		this.selectedFile = index;
		this.scroll = 0;
		this.horizontalScroll = 0;
		this.collapsed = false;
	}

	private scrollBy(delta: number): void {
		this.scroll = clamp(this.scroll + delta, 0, this.maxScroll);
	}
	private scrollHorizontally(delta: number): void {
		this.horizontalScroll = clamp(
			this.horizontalScroll + delta,
			0,
			this.maxHorizontalScroll,
		);
	}
	private ensureSelection(): void {
		this.selectedFile = clamp(
			this.selectedFile,
			0,
			Math.max(0, this.active.files.length - 1),
		);
	}
}

export interface CommentDialogOptions {
	theme: Theme;
	anchor: CommentAnchor;
	currentText: string | undefined;
	done: (text: string | undefined) => void;
	requestRender: () => void;
}

export class CommentDialog implements Focusable {
	private readonly input = new Input();
	private readonly options: CommentDialogOptions;

	constructor(options: CommentDialogOptions) {
		this.options = options;
		this.input.setValue(options.currentText ?? "");
		this.input.handleInput("\u001b[F");
		this.input.onSubmit = (text) => options.done(text);
		this.input.onEscape = () => options.done(undefined);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.options.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const { anchor, currentText, theme } = this.options;
		const title = fit(
			` ${currentText === undefined ? "Add comment" : "Edit comment"} · ${sanitizeTerminalText(anchor.filePath)}:${anchor.line} (${anchor.side}) `,
			innerWidth,
		);
		const input = this.input.render(Math.max(1, innerWidth - 2))[0] ?? "";
		const help =
			currentText === undefined
				? "Enter save · Esc cancel"
				: "Enter save · empty deletes · Esc cancel";
		return [
			theme.fg("border", "╭") +
				theme.fg("accent", title) +
				theme.fg(
					"border",
					`${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}╮`,
				),
			theme.fg("border", "│") +
				pad(` ${input}`, innerWidth) +
				theme.fg("border", "│"),
			theme.fg("border", "│") +
				pad(` ${theme.fg("dim", help)}`, innerWidth) +
				theme.fg("border", "│"),
			theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}
}

type MouseAction =
	| "press"
	| "release"
	| "move"
	| "wheel-up"
	| "wheel-down"
	| "wheel-left"
	| "wheel-right";

interface MouseEvent {
	action: MouseAction;
	x: number;
	y: number;
}

function parseMouseEvent(data: string): MouseEvent | undefined {
	const match = data.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 1 || y < 1)
		return undefined;
	const wheel = button & 0xc3;
	const shifted = (button & 4) !== 0;
	if (wheel === 64)
		return { action: shifted ? "wheel-left" : "wheel-up", x, y };
	if (wheel === 65)
		return { action: shifted ? "wheel-right" : "wheel-down", x, y };
	if (wheel === 66) return { action: "wheel-left", x, y };
	if (wheel === 67) return { action: "wheel-right", x, y };
	if (match[4] === "m") return { action: "release", x, y };
	if ((button & 32) !== 0) return { action: "move", x, y };
	if ((button & 0x23) === 0) return { action: "press", x, y };
	return undefined;
}

function renderNumbered(
	line: NumberedDiffLine | undefined,
	width: number,
	numberWidth: number,
	horizontalScroll: number,
	highlightedSource: string | undefined,
	theme: Theme,
	commented: boolean,
	hovered: boolean,
): string {
	if (!line) return "";
	const number =
		line.number === undefined
			? " ".repeat(numberWidth)
			: String(line.number).padStart(numberWidth);
	let marker = " ";
	if (line.kind === "add") marker = "+";
	else if (line.kind === "remove") marker = "-";
	const commentMarker = commented
		? theme.fg("accent", COMMENT_ICON)
		: " ".repeat(visibleWidth(COMMENT_ICON));
	const prefix = `${theme.fg("muted", number)} ${colorText(marker, line.kind, theme)}${commentMarker} `;
	const source = cropHighlightedSource(
		highlightedSource ?? colorText(line.text, line.kind, theme),
		horizontalScroll,
		Math.max(0, width - visibleWidth(prefix)),
	);
	const value = fit(`${prefix}${source}`, width);
	return hovered
		? theme.bg("selectedBg", pad(value, width))
		: colorLineBackground(value, line.kind, theme);
}

function showSplitMetadata(
	row: Extract<SplitDiffRow, { kind: "meta" }>,
): boolean {
	return (
		row.lineKind === "hunk" ||
		/^(new file mode |deleted file mode |rename from |rename to |Binary files )/.test(
			row.text,
		)
	);
}

function colorText(
	text: string,
	kind: DiffLine["kind"],
	theme: Theme,
	width?: number,
): string {
	const safeText = sanitizeTerminalText(text);
	const value =
		width === undefined ? safeText : truncateToWidth(safeText, width, "…");
	switch (kind) {
		case "add":
			return theme.fg("toolDiffAdded", value);
		case "remove":
			return theme.fg("toolDiffRemoved", value);
		case "hunk":
			return theme.fg("accent", value);
		case "meta":
			return theme.fg("muted", value);
		default:
			return theme.fg("toolDiffContext", value);
	}
}

function colorLineBackground(
	value: string,
	kind: DiffLine["kind"],
	theme: Theme,
): string {
	if (kind === "add") return theme.bg("toolSuccessBg", value);
	if (kind === "remove") return theme.bg("toolErrorBg", value);
	return value;
}

interface SourceEntry {
	index: number;
	source: string;
	kind: DiffLine["kind"];
}

interface HighlightedPair {
	left?: string;
	right?: string;
}

function highlightEntries(
	entries: SourceEntry[],
	language: string | undefined,
	theme: Theme,
): string[] {
	if (entries.length === 0) return [];
	const sources = entries.map((entry) => sanitizeTerminalText(entry.source));
	if (!language)
		return sources.map((source, index) =>
			colorText(source, entries[index]?.kind ?? "context", theme),
		);
	const highlighted = highlightCode(sources.join("\n"), language);
	return sources.map((source, index) => highlighted[index] ?? source);
}

function highlightUnifiedSources(
	lines: DiffLine[],
	language: string | undefined,
	theme: Theme,
): Map<number, string> {
	const result = new Map<number, string>();
	let oldEntries: SourceEntry[] = [];
	let newEntries: SourceEntry[] = [];
	const flush = () => {
		for (const [index, highlighted] of highlightEntries(
			oldEntries,
			language,
			theme,
		).entries()) {
			const entry = oldEntries[index];
			if (entry) result.set(entry.index, highlighted);
		}
		for (const [index, highlighted] of highlightEntries(
			newEntries,
			language,
			theme,
		).entries()) {
			const entry = newEntries[index];
			if (entry) result.set(entry.index, highlighted);
		}
		oldEntries = [];
		newEntries = [];
	};
	for (const [index, line] of lines.entries()) {
		if (line.kind === "hunk") flush();
		if (!isUnifiedSourceLine(line)) continue;
		const entry = {
			index,
			source: stripDiffMarker(line.text),
			kind: line.kind,
		};
		if (line.kind !== "add") oldEntries.push(entry);
		if (line.kind !== "remove") newEntries.push(entry);
	}
	flush();
	return result;
}

function highlightSplitSources(
	rows: SplitDiffRow[],
	language: string | undefined,
	theme: Theme,
): Map<number, HighlightedPair> {
	const result = new Map<number, HighlightedPair>();
	let leftEntries: SourceEntry[] = [];
	let rightEntries: SourceEntry[] = [];
	const flush = () => {
		for (const [index, highlighted] of highlightEntries(
			leftEntries,
			language,
			theme,
		).entries()) {
			const entry = leftEntries[index];
			if (entry)
				result.set(entry.index, {
					...result.get(entry.index),
					left: highlighted,
				});
		}
		for (const [index, highlighted] of highlightEntries(
			rightEntries,
			language,
			theme,
		).entries()) {
			const entry = rightEntries[index];
			if (entry)
				result.set(entry.index, {
					...result.get(entry.index),
					right: highlighted,
				});
		}
		leftEntries = [];
		rightEntries = [];
	};
	for (const [index, row] of rows.entries()) {
		if (row.kind === "meta") {
			flush();
			continue;
		}
		if (row.left)
			leftEntries.push({ index, source: row.left.text, kind: row.left.kind });
		if (row.right)
			rightEntries.push({
				index,
				source: row.right.text,
				kind: row.right.kind,
			});
	}
	flush();
	return result;
}

function isUnifiedSourceLine(line: DiffLine): boolean {
	if (line.kind === "add") return line.text.startsWith("+");
	if (line.kind === "remove") return line.text.startsWith("-");
	return line.kind === "context" && line.text.startsWith(" ");
}

function stripDiffMarker(text: string): string {
	return /^[ +-]/.test(text) ? text.slice(1) : text;
}

function sourceWidth(value: string | undefined): number {
	return value === undefined ? 0 : visibleWidth(sanitizeTerminalText(value));
}

function cropHighlightedSource(
	value: string,
	offset: number,
	width: number,
): string {
	if (width <= 0) return "";
	return sliceByColumn(value, offset, width, true);
}

function truncateStartToWidth(value: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const valueWidth = visibleWidth(value);
	if (valueWidth <= safeWidth) return value;
	if (safeWidth <= 1) return fit("…", safeWidth);
	return `…${sliceByColumn(value, valueWidth - safeWidth + 1, safeWidth - 1, true)}`;
}

function fit(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), "");
}
function pad(value: string, width: number): string {
	const fitted = fit(value, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}
function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
