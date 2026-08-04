import type { DiffLine, ParsedDiff } from "../../internal/diff.ts";

export interface NumberedDiffLine {
	text: string;
	kind: DiffLine["kind"];
	number?: number;
}

export type SplitDiffRow =
	| { kind: "meta"; text: string; lineKind: DiffLine["kind"] }
	| { kind: "pair"; left?: NumberedDiffLine; right?: NumberedDiffLine };

export function fileLines(diff: ParsedDiff, fileIndex: number): DiffLine[] {
	const file = diff.files[fileIndex];
	return file ? diff.lines.slice(file.start, file.end) : [];
}

export function buildSplitRows(
	diff: ParsedDiff,
	fileIndex: number,
): SplitDiffRow[] {
	const lines = fileLines(diff, fileIndex);
	const rows: SplitDiffRow[] = [];
	let oldLine: number | undefined;
	let newLine: number | undefined;

	for (let index = 0; index < lines.length; ) {
		const line = lines[index]!;
		if (line.kind === "hunk") {
			const range = parseHunkRange(line.text);
			oldLine = range?.oldStart;
			newLine = range?.newStart;
			rows.push({ kind: "meta", text: line.text, lineKind: line.kind });
			index++;
			continue;
		}

		if (line.kind === "remove" || line.kind === "add") {
			const removed: DiffLine[] = [];
			const added: DiffLine[] = [];
			while (index < lines.length && lines[index]?.kind === "remove")
				removed.push(lines[index++]!);
			while (index < lines.length && lines[index]?.kind === "add")
				added.push(lines[index++]!);
			if (removed.length === 0 && added.length === 0) continue;
			const count = Math.max(removed.length, added.length);
			for (let offset = 0; offset < count; offset++) {
				const leftLine = removed[offset];
				const rightLine = added[offset];
				rows.push({
					kind: "pair",
					left: leftLine
						? {
								text: stripMarker(leftLine.text),
								kind: leftLine.kind,
								number: oldLine,
							}
						: undefined,
					right: rightLine
						? {
								text: stripMarker(rightLine.text),
								kind: rightLine.kind,
								number: newLine,
							}
						: undefined,
				});
				if (leftLine && oldLine !== undefined) oldLine++;
				if (rightLine && newLine !== undefined) newLine++;
			}
			continue;
		}

		if (
			line.kind === "context" &&
			oldLine !== undefined &&
			newLine !== undefined
		) {
			const text = stripContextMarker(line.text);
			rows.push({
				kind: "pair",
				left: { text, kind: line.kind, number: oldLine++ },
				right: { text, kind: line.kind, number: newLine++ },
			});
		} else {
			rows.push({ kind: "meta", text: line.text, lineKind: line.kind });
		}
		index++;
	}
	return rows;
}

function parseHunkRange(
	line: string,
): { oldStart: number; newStart: number } | undefined {
	const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!match) return undefined;
	return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function stripMarker(text: string): string {
	return text.slice(1);
}

function stripContextMarker(text: string): string {
	return text.startsWith(" ") ? text.slice(1) : text;
}
