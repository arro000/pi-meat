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
	const normalized = input.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	if (!normalized) return { lines: [], files: [] };
	const rawLines = normalized.split("\n");
	const lines: DiffLine[] = [];
	const files: DiffFile[] = [];
	let fileIndex = -1;
	let insideHunk = false;

	for (const text of rawLines) {
		if (text.startsWith("diff --git ")) {
			if (fileIndex >= 0) files[fileIndex]!.end = lines.length;
			fileIndex = files.length;
			insideHunk = false;
			files.push({
				path: pathFromHeader(text),
				start: lines.length,
				end: lines.length,
				added: 0,
				removed: 0,
			});
		} else if (fileIndex < 0 && isFileMarker(text, "---")) {
			fileIndex = 0;
			files.push({
				path: pathFromFileMarker(text.slice(4)),
				start: lines.length,
				end: lines.length,
				added: 0,
				removed: 0,
			});
		}

		const kind = classifyLine(text, insideHunk);
		if (kind === "hunk") insideHunk = true;
		if (fileIndex >= 0) {
			const file = files[fileIndex]!;
			if (kind === "add") file.added++;
			if (kind === "remove") file.removed++;
			if (!insideHunk && isFileMarker(text, "+++")) {
				const path = pathFromFileMarker(text.slice(4));
				if (path && path !== "/dev/null") file.path = path;
			}
		}
		lines.push({ text, kind, fileIndex });
	}

	if (fileIndex >= 0) files[fileIndex]!.end = lines.length;
	return { lines, files };
}

function pathFromHeader(header: string): string {
	const match = header.match(
		/^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/,
	);
	if (!match?.[2]) return header.slice("diff --git ".length);
	return stripSidePrefix(decodeGitPath(match[2]));
}

function pathFromFileMarker(value: string): string {
	return stripSidePrefix(decodeGitPath(value));
}

function decodeGitPath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) return value;
	const source = value.slice(1, -1);
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	const escapes: Record<string, number> = {
		a: 0x07,
		b: 0x08,
		t: 0x09,
		n: 0x0a,
		v: 0x0b,
		f: 0x0c,
		r: 0x0d,
		'"': 0x22,
		"\\": 0x5c,
	};
	for (let index = 0; index < source.length; ) {
		if (source[index] === "\\") {
			const octal = source.slice(index + 1, index + 4);
			if (/^[0-7]{3}$/.test(octal)) {
				bytes.push(Number.parseInt(octal, 8));
				index += 4;
				continue;
			}
			const escaped = source[index + 1];
			if (escaped !== undefined && escapes[escaped] !== undefined) {
				bytes.push(escapes[escaped]);
				index += 2;
				continue;
			}
		}
		const codePoint = source.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		bytes.push(...encoder.encode(character));
		index += character.length;
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

function stripSidePrefix(path: string): string {
	return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function classifyLine(line: string, insideHunk: boolean): DiffLineKind {
	if (line.startsWith("@@")) return "hunk";
	if (
		(!insideHunk && (isFileMarker(line, "---") || isFileMarker(line, "+++"))) ||
		line.startsWith("diff ") ||
		isMetadata(line)
	)
		return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "remove";
	return "context";
}

function isFileMarker(line: string, marker: "---" | "+++"): boolean {
	return line.startsWith(`${marker} `);
}

function isMetadata(line: string): boolean {
	return /^(index |commit |Author:|AuthorDate:|Commit:|CommitDate:|new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |\\ No newline at end of file)/.test(
		line,
	);
}
