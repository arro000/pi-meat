import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
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

export type ViewerAction = "close" | "review";
type ViewMode = "reading" | "original";
type LayoutMode = "split" | "unified";

export interface MeatDiffViewerOptions {
	theme: Theme;
	summary: string;
	originalDiff: string;
	readingDiff: string;
	modelLabel: string;
	viewportHeight: () => number;
	done: (action: ViewerAction) => void;
}

export class MeatDiffViewer {
	private mode: ViewMode = "reading";
	private layout: LayoutMode = "split";
	private selectedFile = 0;
	private scroll = 0;
	private sidebarScroll = 0;
	private help = false;
	private collapsed = false;
	private lastLayout: LayoutMode = "split";
	private lastBodyHeight = 8;
	private readonly reading: ParsedDiff;
	private readonly original: ParsedDiff;
	private readonly options: MeatDiffViewerOptions;

	constructor(options: MeatDiffViewerOptions) {
		this.options = options;
		this.original = parseUnifiedDiff(options.originalDiff);
		this.reading = parseUnifiedDiff(options.readingDiff);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q")
			return this.options.done("close");
		if (data === "r") return this.options.done("review");
		if (data === "?") {
			this.help = !this.help;
			return;
		}
		if (data === "s") {
			this.layout = this.layout === "split" ? "unified" : "split";
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.toggleMode();
			return;
		}
		if (data === "n" || matchesKey(data, Key.right)) {
			this.selectFile(1);
			return;
		}
		if (data === "p" || matchesKey(data, Key.left)) {
			this.selectFile(-1);
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
		const file = this.active.files[this.selectedFile];
		const sidebarWidth = this.sidebarWidth(w);
		const contentWidth = Math.max(
			20,
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
		const position = file
			? `${this.selectedFile + 1}/${this.active.files.length} · ${sanitizeText(file.path)}`
			: "No changed files";
		lines.push(
			fit(
				`${theme.fg("accent", position)} ${theme.fg("dim", `· ${this.scroll + 1}/${Math.max(1, this.contentLength)} · ? help`)}`,
				w,
			),
		);
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}

	private get active(): ParsedDiff {
		return this.mode === "reading" ? this.reading : this.original;
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

	private splitContentLength(): number {
		let count = 1; // OLD / NEW header
		for (const row of buildSplitRows(this.active, this.selectedFile)) {
			if (row.kind !== "meta" || showSplitMetadata(row)) count++;
		}
		return count;
	}

	private renderHeader(width: number, effectiveLayout: LayoutMode): string[] {
		const theme = this.options.theme;
		const reading =
			this.mode === "reading"
				? theme.fg("accent", theme.bold("READING"))
				: theme.fg("dim", "READING");
		const original =
			this.mode === "original"
				? theme.fg("accent", theme.bold("ORIGINAL"))
				: theme.fg("dim", "ORIGINAL");
		const layout = effectiveLayout === "split" ? "SIDE-BY-SIDE" : "UNIFIED";
		return [
			fit(
				`${theme.fg("accent", theme.bold("🥩 pi-meat"))}  ${reading}  ${original}  ${theme.fg("muted", layout)}`,
				width,
			),
			fit(
				`${theme.fg("text", sanitizeText(this.options.summary || "Reading diff"))} ${theme.fg("dim", `· ${sanitizeText(this.options.modelLabel)}`)}`,
				width,
			),
			fit(theme.fg("borderMuted", "─".repeat(width)), width),
		];
	}

	private renderHelp(width: number): string[] {
		const muted = (text: string) =>
			fit(this.options.theme.fg("muted", text), width);
		return [
			muted("j/k ↑/↓ scroll · n/p ←/→ file · PgUp/PgDn page · Home/End"),
			muted("Tab reading/original · s side-by-side/unified · Space fold file"),
			muted("r review with Pi · ? help · q/Esc close"),
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
		const counts = `+${file.added} -${file.removed}`;
		const marker = selected ? "▶ " : "  ";
		const pathWidth = Math.max(
			4,
			width - visibleWidth(marker) - visibleWidth(counts) - 1,
		);
		const label = `${marker}${truncateToWidth(sanitizeText(file.path), pathWidth, "…")} ${counts}`;
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
		return this.selectedLines.map((line) =>
			colorText(line.text, line.kind, this.options.theme, width),
		);
	}

	private renderSplit(width: number): string[] {
		const gap = 3;
		const columnWidth = Math.max(20, Math.floor((width - gap) / 2));
		const divider = ` ${this.options.theme.fg("borderMuted", "│")} `;
		const header = `${pad(this.options.theme.fg("error", "OLD"), columnWidth)}${divider}${fit(this.options.theme.fg("success", "NEW"), columnWidth)}`;
		const rows = buildSplitRows(this.active, this.selectedFile).flatMap(
			(row) =>
				row.kind === "meta" && !showSplitMetadata(row)
					? []
					: [this.renderSplitRow(row, columnWidth, divider, width)],
		);
		return [header, ...rows];
	}

	private renderSplitRow(
		row: SplitDiffRow,
		columnWidth: number,
		divider: string,
		width: number,
	): string {
		if (row.kind === "meta")
			return fit(colorText(row.text, row.lineKind, this.options.theme), width);
		const left = renderNumbered(row.left, columnWidth, this.options.theme);
		const right = renderNumbered(row.right, columnWidth, this.options.theme);
		return `${pad(left, columnWidth)}${divider}${fit(right, columnWidth)}`;
	}

	private sidebarWidth(width: number): number {
		if (this.active.files.length < 2 || width < 120) return 0;
		return clamp(Math.floor(width * 0.22), 24, 32);
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
		this.collapsed = false;
	}

	private scrollBy(delta: number): void {
		this.scroll = clamp(this.scroll + delta, 0, this.maxScroll);
	}
	private ensureSelection(): void {
		this.selectedFile = clamp(
			this.selectedFile,
			0,
			Math.max(0, this.active.files.length - 1),
		);
	}
}

function renderNumbered(
	line: NumberedDiffLine | undefined,
	width: number,
	theme: Theme,
): string {
	if (!line) return "";
	const number =
		line.number === undefined ? "    " : String(line.number).padStart(4);
	return colorText(`${number} ${line.text}`, line.kind, theme, width);
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
	const safeText = sanitizeText(text);
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

function sanitizeText(value: string): string {
	return value.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "�");
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
