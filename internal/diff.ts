export type DiffLineKind = "meta" | "hunk" | "add" | "remove" | "context";

export interface DiffLine {
	text: string;
	kind: DiffLineKind;
	fileIndex: number;
}

export interface DiffFile {
	path: string;
	start: number;
	end: number;
	added: number;
	removed: number;
}

export interface ParsedDiff {
	lines: DiffLine[];
	files: DiffFile[];
}

export function parseUnifiedDiff(input: string): ParsedDiff {
	const rawLines = input.replace(/\n$/, "").split("\n");
	if (rawLines.length === 1 && rawLines[0] === "") return { lines: [], files: [] };

	const lines: DiffLine[] = [];
	const files: DiffFile[] = [];
	let fileIndex = -1;

	for (const text of rawLines) {
		if (text.startsWith("diff --git ")) {
			if (fileIndex >= 0) files[fileIndex]!.end = lines.length;
			fileIndex++;
			files.push({ path: pathFromHeader(text), start: lines.length, end: lines.length, added: 0, removed: 0 });
		}
		if (fileIndex < 0) {
			fileIndex = 0;
			files.push({ path: "commit", start: 0, end: 0, added: 0, removed: 0 });
		}

		const kind = classifyLine(text);
		if (kind === "add") files[fileIndex]!.added++;
		if (kind === "remove") files[fileIndex]!.removed++;
		lines.push({ text, kind, fileIndex });
	}
	if (fileIndex >= 0) files[fileIndex]!.end = lines.length;
	return { lines, files };
}

function pathFromHeader(header: string): string {
	const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
	return match?.[2] ?? header.slice("diff --git ".length);
}

function classifyLine(line: string): DiffLineKind {
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || isMetadata(line)) {
		return "meta";
	}
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "remove";
	return "context";
}

function isMetadata(line: string): boolean {
	return /^(index |commit |Author:|AuthorDate:|Commit:|CommitDate:|new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to )/.test(line);
}
