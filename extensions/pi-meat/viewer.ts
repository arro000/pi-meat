import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { parseUnifiedDiff, type DiffLine, type ParsedDiff } from "../../internal/diff.ts";

export type ViewerAction = "close" | "review";
type ViewMode = "reading" | "original";

interface DisplayLine {
	line?: DiffLine;
	fileIndex: number;
	label?: string;
}

export class MeatDiffViewer {
	private mode: ViewMode = "reading";
	private selectedFile = 0;
	private scroll = 0;
	private help = false;
	private readonly collapsed = new Set<string>();
	private reading: ParsedDiff;
	private original: ParsedDiff;

	constructor(
		private readonly theme: Theme,
		private readonly summary: string,
		originalDiff: string,
		readingDiff: string,
		private readonly modelLabel: string,
		private readonly viewportHeight: () => number,
		private readonly done: (action: ViewerAction) => void,
	) {
		this.original = parseUnifiedDiff(originalDiff);
		this.reading = parseUnifiedDiff(readingDiff);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.done("close");
		if (matchesKey(data, Key.tab)) {
			const currentPath = this.active.files[this.selectedFile]?.path;
			this.mode = this.mode === "reading" ? "original" : "reading";
			const matchingIndex = currentPath ? this.active.files.findIndex((file) => file.path === currentPath) : -1;
			this.selectedFile = matchingIndex >= 0
				? matchingIndex
				: Math.min(this.selectedFile, Math.max(0, this.active.files.length - 1));
			this.jumpToFile();
			return;
		}
		if (data === "r") return this.done("review");
		if (data === "?") { this.help = !this.help; return; }
		if (data === "n") { this.selectFile(1); return; }
		if (data === "p") { this.selectFile(-1); return; }
		if (matchesKey(data, Key.space)) {
			const file = this.active.files[this.selectedFile];
			if (!file) return;
			const key = `${this.mode}:${file.path}`;
			if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
			this.jumpToFile();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-15);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(15);
		else if (matchesKey(data, Key.home)) { this.scroll = 0; this.syncSelectedFile(); }
		else if (matchesKey(data, Key.end)) { this.scroll = Math.max(0, this.displayLines.length - 1); this.syncSelectedFile(); }
	}

	render(width: number): string[] {
		const w = Math.max(20, width);
		const th = this.theme;
		const tabs = this.mode === "reading"
			? `${th.fg("accent", th.bold(" READING "))}  ${th.fg("dim", " ORIGINAL ")}`
			: `${th.fg("dim", " READING ")}  ${th.fg("accent", th.bold(" ORIGINAL "))}`;
		const file = this.active.files[this.selectedFile];
		const lines: string[] = [
			fit(`${th.fg("accent", th.bold("🥩 pi-meat"))}  ${tabs}`, w),
			fit(`${th.fg("text", this.summary || "Reading diff")} ${th.fg("dim", `· ${this.modelLabel}`)}`, w),
			fit(th.fg("borderMuted", "─".repeat(w)), w),
		];

		if (this.help) {
			lines.push(
				fit(th.fg("muted", "j/k scroll · n/p file · space fold · tab original/reading"), w),
				fit(th.fg("muted", "r review with Pi · ? help · q/esc close"), w),
				fit(th.fg("borderMuted", "─".repeat(w)), w),
			);
		}

		const bodyHeight = Math.max(6, this.viewportHeight() - (this.help ? 2 : 0));
		const display = this.displayLines;
		this.scroll = clamp(this.scroll, 0, Math.max(0, display.length - 1));
		for (const item of display.slice(this.scroll, this.scroll + bodyHeight)) {
			if (item.label !== undefined) {
				const selected = item.fileIndex === this.selectedFile;
				const marker = selected ? "▶" : " ";
				lines.push(fit(selected ? th.fg("accent", th.bold(`${marker} ${item.label}`)) : th.fg("muted", `${marker} ${item.label}`), w));
				continue;
			}
			lines.push(fit(colorDiffLine(item.line!, th), w));
		}
		while (lines.length < bodyHeight + (this.help ? 6 : 4)) lines.push("");

		const position = display.length === 0 ? "empty" : `${Math.min(this.scroll + 1, display.length)}/${display.length}`;
		const filePosition = file ? `${this.selectedFile + 1}/${this.active.files.length} ${file.path}` : "no files";
		lines.push(fit(th.fg("borderMuted", "─".repeat(w)), w));
		lines.push(fit(`${th.fg("accent", filePosition)} ${th.fg("dim", `· ${position} · ? help`)}`, w));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}

	private get active(): ParsedDiff { return this.mode === "reading" ? this.reading : this.original; }

	private get displayLines(): DisplayLine[] {
		const output: DisplayLine[] = [];
		for (let index = 0; index < this.active.files.length; index++) {
			const file = this.active.files[index]!;
			const key = `${this.mode}:${file.path}`;
			const folded = this.collapsed.has(key);
			output.push({
				fileIndex: index,
				label: `${folded ? "▸" : "▾"} ${file.path}  ${this.theme.fg("success", `+${file.added}`)} ${this.theme.fg("error", `-${file.removed}`)}`,
			});
			if (!folded) {
				for (let line = file.start; line < file.end; line++) output.push({ line: this.active.lines[line], fileIndex: index });
			}
		}
		return output;
	}

	private selectFile(delta: number): void {
		if (this.active.files.length === 0) return;
		this.selectedFile = clamp(this.selectedFile + delta, 0, this.active.files.length - 1);
		this.jumpToFile();
	}

	private jumpToFile(): void {
		const index = this.displayLines.findIndex((line) => line.fileIndex === this.selectedFile);
		this.scroll = Math.max(0, index);
	}

	private scrollBy(delta: number): void {
		this.scroll = clamp(this.scroll + delta, 0, Math.max(0, this.displayLines.length - 1));
		this.syncSelectedFile();
	}

	private syncSelectedFile(): void {
		const line = this.displayLines[this.scroll];
		if (line) this.selectedFile = line.fileIndex;
	}
}

function colorDiffLine(line: DiffLine, theme: Theme): string {
	switch (line.kind) {
		case "add": return theme.fg("toolDiffAdded", line.text);
		case "remove": return theme.fg("toolDiffRemoved", line.text);
		case "hunk": return theme.fg("accent", line.text);
		case "meta": return theme.fg("muted", line.text);
		default: return theme.fg("toolDiffContext", line.text);
	}
}

function fit(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return visibleWidth(truncated) > width ? truncateToWidth(truncated, width, "") : truncated;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
