import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSplitRows } from "../extensions/pi-meat/diff-layout.ts";
import {
	CommentDialog,
	MeatDiffViewer,
	type CommentAnchor,
} from "../extensions/pi-meat/viewer.ts";
import { parseUnifiedDiff } from "../internal/diff.ts";

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,2 @@
 keep
-old one
-old two
+new one
 tail
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-before
+after
`;

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("aligns replacement blocks and preserves old/new line numbers", () => {
	const rows = buildSplitRows(parseUnifiedDiff(diff), 0);
	const pairs = rows.filter((row) => row.kind === "pair");
	assert.deepEqual(pairs[0], {
		kind: "pair",
		left: { text: "keep", kind: "context", number: 10 },
		right: { text: "keep", kind: "context", number: 10 },
	});
	assert.deepEqual(pairs[1], {
		kind: "pair",
		left: { text: "old one", kind: "remove", number: 11 },
		right: { text: "new one", kind: "add", number: 11 },
	});
	assert.deepEqual(pairs[2], {
		kind: "pair",
		left: { text: "old two", kind: "remove", number: 12 },
		right: undefined,
	});
	assert.deepEqual(pairs[3], {
		kind: "pair",
		left: { text: "tail", kind: "context", number: 13 },
		right: { text: "tail", kind: "context", number: 12 },
	});
});

test("renders bounded side-by-side content with stable file sidebar", () => {
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Focused review",
		originalDiff: diff,
		readingDiff: diff,
		modelLabel: "provider/model",
		viewportHeight: () => 12,
		done: () => {},
	});
	const first = viewer.render(120);
	assert.ok(first.every((line) => visibleWidth(line) <= 120));
	assert.ok(first.some((line) => line.includes("FILES 2")));
	assert.ok(first.some((line) => line.includes("OLD") && line.includes("NEW")));
	assert.ok(
		first.some((line) => line.includes("old one") && line.includes("new one")),
	);

	viewer.handleInput("n");
	const second = viewer.render(120);
	assert.ok(
		second.some((line) => line.includes("before") && line.includes("after")),
	);
	assert.ok(second.some((line) => line.includes("2/2 · src/b.ts")));
});

test("keeps the useful path tail in the sidebar and labels the full path", () => {
	const longPath = "packages/application/src/features/review/long-file-name.ts";
	const longPathDiff = diff.replaceAll("src/a.ts", longPath);
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Long path",
		originalDiff: longPathDiff,
		readingDiff: longPathDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 10,
		done: () => {},
	});

	const lines = viewer.render(140);
	assert.ok(lines.some((line) => line.includes(`FILE  ${longPath}`)));
	assert.ok(
		lines.some(
			(line) =>
				line.includes("…") &&
				line.includes("long-file-name.ts") &&
				line.includes("+1 -2"),
		),
	);
});

test("shows Meat progress until the reading diff is ready", () => {
	const viewer = new MeatDiffViewer({
		theme,
		summary: "",
		originalDiff: diff,
		modelLabel: "provider/model · thinking:high",
		viewportHeight: () => 10,
		done: () => {},
	});

	assert.ok(viewer.render(98).some((line) => line.includes("old one")));
	viewer.handleInput("\t");
	viewer.setProgress("chunk 2/3: thinking (turn 4)");
	const pending = viewer.render(98);
	assert.ok(pending.some((line) => line.includes("Meat is processing")));
	assert.ok(
		pending.some((line) => line.includes("chunk 2/3: thinking (turn 4)")),
	);

	viewer.setReading(diff, "Focused review");
	const ready = viewer.render(98);
	assert.ok(ready.some((line) => line.includes("READING ✨")));
	assert.ok(ready.some((line) => line.includes("Focused review")));
	assert.ok(ready.some((line) => line.includes("old one")));
});

test("starts Meat only when requested from the on-demand reading view", () => {
	let starts = 0;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "",
		originalDiff: diff,
		modelLabel: "provider/model",
		onDemand: true,
		startReading: () => starts++,
		viewportHeight: () => 10,
		done: () => {},
	});

	assert.ok(
		viewer.render(98).some((line) => line.includes("Meat is on demand")),
	);
	viewer.handleInput("\t");
	assert.ok(viewer.render(98).some((line) => line.includes("Start Meat?")));
	viewer.handleInput("\r");
	viewer.handleInput("\r");
	assert.equal(starts, 1);
	assert.ok(
		viewer.render(98).some((line) => line.includes("Meat is processing")),
	);

	viewer.setReading(diff, "Ready on demand");
	assert.ok(viewer.render(98).some((line) => line.includes("READING ✨")));
});

test("keeps the original diff available when reading generation fails", () => {
	const viewer = new MeatDiffViewer({
		theme,
		summary: "",
		originalDiff: diff,
		modelLabel: "provider/model",
		viewportHeight: () => 10,
		done: () => {},
	});

	viewer.handleInput("\t");
	viewer.setReadingError("provider failed\u001b[31m");
	const failed = viewer.render(98);
	assert.ok(failed.some((line) => line.includes("Reading diff failed")));
	assert.ok(failed.every((line) => !line.includes("\u001b")));

	viewer.handleInput("\t");
	assert.ok(viewer.render(98).some((line) => line.includes("old one")));
});

test("adds subtle backgrounds to added and removed lines", () => {
	const backgrounds: string[] = [];
	const backgroundTheme = {
		fg: (_color: string, text: string) => text,
		bg: (color: string, text: string) => {
			backgrounds.push(color);
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	const viewer = new MeatDiffViewer({
		theme: backgroundTheme,
		summary: "Backgrounds",
		originalDiff: diff,
		readingDiff: diff,
		modelLabel: "provider/model",
		viewportHeight: () => 10,
		done: () => {},
	});

	viewer.render(120);
	assert.ok(backgrounds.includes("toolErrorBg"));
	assert.ok(backgrounds.includes("toolSuccessBg"));
});

test("highlights the code line under the mouse", () => {
	const hoverTheme = {
		...theme,
		bg: (color: string, text: string) =>
			color === "selectedBg" ? `[hover]${text}` : text,
	} as unknown as Theme;
	const viewer = new MeatDiffViewer({
		theme: hoverTheme,
		summary: "Hover",
		originalDiff: diff,
		readingDiff: diff,
		modelLabel: "provider/model",
		viewportHeight: () => 10,
		done: () => {},
	});

	viewer.render(98);
	viewer.handleInput("\x1b[<35;10;8M");
	const hovered = viewer.render(98);
	assert.ok(
		hovered.some((line) => line.includes("[hover]") && line.includes("keep")),
	);
	assert.ok(
		hovered.every(
			(line) => !line.includes("[hover]") || !line.includes("old one"),
		),
	);
});

test("toggles side-by-side and unified layout with s", () => {
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Layout",
		originalDiff: diff,
		readingDiff: diff,
		modelLabel: "provider/model",
		viewportHeight: () => 10,
		done: () => {},
	});
	assert.ok(viewer.render(98).some((line) => line.includes("SIDE-BY-SIDE")));
	viewer.handleInput("s");
	assert.ok(viewer.render(98).some((line) => line.includes("UNIFIED")));
	const layoutColumn = visibleWidth("🥩 pi-meat  READING ✨  ORIGINAL  ") + 1;
	viewer.handleInput(`\x1b[<0;${layoutColumn};1M`);
	assert.ok(viewer.render(98).some((line) => line.includes("SIDE-BY-SIDE")));
});

test("selects sidebar files and scrolls diff with SGR mouse input", () => {
	const body = Array.from(
		{ length: 30 },
		(_, index) => ` line ${index + 1}`,
	).join("\n");
	const mouseDiff = `${diff}diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1,30 +1,30 @@\n${body}\n`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Mouse",
		originalDiff: mouseDiff,
		readingDiff: mouseDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	viewer.render(120);
	viewer.handleInput("\x1b[<0;2;10M");
	assert.ok(viewer.render(120).some((line) => line.includes("3/3 · src/c.ts")));
	viewer.handleInput("\x1b[<65;80;8M");
	const scrolled = viewer.render(120);
	assert.ok(scrolled.some((line) => line.includes("line 4/")));
	assert.ok(scrolled.some((line) => line.includes("line 2")));
});

test("scrolls long source lines horizontally with synchronized split panes", () => {
	const oldSource = `const oldValue = "${"a".repeat(100)}OLD_END";`;
	const newSource = `const newValue = "${"b".repeat(100)}NEW_END";`;
	const longDiff = `diff --git a/src/long.ts b/src/long.ts\n--- a/src/long.ts\n+++ b/src/long.ts\n@@ -1 +1 @@\n-${oldSource}\n+${newSource}\n`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Long lines",
		originalDiff: longDiff,
		readingDiff: longDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});

	const initial = viewer.render(98);
	assert.ok(initial.some((line) => line.includes("h/l ←/→ horizontal")));
	assert.ok(initial.some((line) => line.includes("? help")));
	assert.ok(initial.every((line) => !line.includes("OLD_END")));
	assert.ok(initial.every((line) => !line.includes("NEW_END")));

	for (let index = 0; index < 40; index++) viewer.handleInput("\u001b[C");
	const scrolled = viewer.render(98);
	assert.ok(
		scrolled.some(
			(line) => line.includes("OLD_END") && line.includes("NEW_END"),
		),
	);
	assert.ok(scrolled.some((line) => /col [2-9][0-9]+-/.test(line)));
	assert.ok(scrolled.every((line) => visibleWidth(line) <= 98));
});

test("anchors clicks to the visible split line and edits comments in a dialog", async () => {
	const requests: Array<{
		anchor: CommentAnchor;
		currentText: string | undefined;
	}> = [];
	const responses = ["Needs better handling", "Handle the error", ""];
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Comments",
		originalDiff: diff,
		readingDiff: diff,
		modelLabel: "provider/model",
		viewportHeight: () => 10,
		done: () => {},
		requestComment: async (anchor, currentText) => {
			requests.push({ anchor, currentText });
			return responses.shift();
		},
	});
	viewer.render(98);
	viewer.handleInput("\x1b[<0;10;8M");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests[0]?.anchor.line, 10);
	assert.equal(requests[0]?.anchor.snippet, "keep");
	assert.equal(requests[0]?.currentText, undefined);
	assert.equal(viewer.getComments()[0]?.text, "Needs better handling");
	assert.ok(
		viewer
			.render(120)
			.some((line) => line.includes("src/a.ts") && line.includes("💬1")),
	);
	assert.ok(
		viewer
			.render(98)
			.some((line) => line.includes("💬") && line.includes("keep")),
	);

	viewer.handleInput("\x1b[<0;10;8M");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests[1]?.currentText, "Needs better handling");
	assert.equal(viewer.getComments()[0]?.text, "Handle the error");

	viewer.handleInput("\x1b[<0;10;8M");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(viewer.getComments().length, 0);
});

test("comment dialog submits or cancels the overlaid input", () => {
	const results: Array<string | undefined> = [];
	const dialog = new CommentDialog({
		theme,
		anchor: { filePath: "src/a.ts", line: 10, side: "old", snippet: "keep" },
		currentText: "Existing comment",
		done: (text) => results.push(text),
		requestRender: () => {},
	});
	dialog.focused = true;
	assert.ok(dialog.render(60).some((line) => line.includes("Edit comment")));
	dialog.handleInput("\x15");
	dialog.handleInput("Updated comment");
	dialog.handleInput("\r");
	assert.deepEqual(results, ["Updated comment"]);
});

test("supports native and shifted horizontal mouse wheels", () => {
	const source = `${"0123456789".repeat(12)}END`;
	const longDiff = `diff --git a/src/wheel.ts b/src/wheel.ts\n--- a/src/wheel.ts\n+++ b/src/wheel.ts\n@@ -1 +1 @@\n-${source}\n+${source}\n`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Horizontal wheel",
		originalDiff: longDiff,
		readingDiff: longDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});

	viewer.render(72);
	viewer.handleInput("\x1b[<67;40;5M");
	assert.ok(viewer.render(72).some((line) => line.includes("col 5-")));
	viewer.handleInput("\x1b[<69;40;5M");
	assert.ok(viewer.render(72).some((line) => line.includes("col 9-")));
	viewer.handleInput("\x1b[<66;40;5M");
	assert.ok(viewer.render(72).some((line) => line.includes("col 5-")));
	viewer.handleInput("\x1b[<68;40;5M");
	assert.ok(viewer.render(72).some((line) => line.includes("col 1-")));
});

test("keeps binary metadata intact in unified layout", () => {
	const binaryDiff = `diff --git a/image.png b/image.png\nindex 111..222 100644\nBinary files a/image.png and b/image.png differ\n`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Binary",
		originalDiff: binaryDiff,
		readingDiff: binaryDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	const lines = viewer.render(72);
	assert.ok(lines.some((line) => line.includes("Binary files a/image.png")));
	assert.ok(lines.every((line) => !line.includes("B Binary files")));
});

test("preserves final columns with five-digit split line numbers", () => {
	const source = `${"x".repeat(44)}Z`;
	const numberedDiff = `diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -10000 +10000 @@\n-${source}\n+${source}\n`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Large line numbers",
		originalDiff: numberedDiff,
		readingDiff: numberedDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	viewer.render(98);
	for (let index = 0; index < 20; index++) viewer.handleInput("l");
	const lines = viewer.render(98);
	assert.ok(lines.some((line) => line.includes("Z") && line.includes("10000")));
	assert.ok(lines.some((line) => line.includes("col 9-45/45")));
});

test("reaches long-line tails in very narrow terminals", () => {
	const source = `${"x".repeat(24)}Z`;
	const narrowDiff = `diff --git a/narrow.ts b/narrow.ts\n--- a/narrow.ts\n+++ b/narrow.ts\n@@ -1 +1 @@\n-${source}\n+${source}\n`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Narrow",
		originalDiff: narrowDiff,
		readingDiff: narrowDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	viewer.render(10);
	for (let index = 0; index < 20; index++) viewer.handleInput("l");
	const lines = viewer.render(10);
	assert.ok(lines.some((line) => line.includes("Z")));
	assert.ok(lines.every((line) => visibleWidth(line) <= 10));
});

test("keeps every responsive layout within terminal width", () => {
	for (const width of [23, 60, 71, 72, 97, 98, 120]) {
		const viewer = new MeatDiffViewer({
			theme,
			summary: "Focused review",
			originalDiff: diff,
			readingDiff: diff,
			modelLabel: "provider/model",
			viewportHeight: () => 10,
			done: () => {},
		});
		const lines = viewer.render(width);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`render overflow at width ${width}`,
		);
		if (width >= 40 && width < 88)
			assert.ok(lines.some((line) => line.includes("UNIFIED")));
		if (width < 120)
			assert.ok(lines.every((line) => !line.includes("FILES 2")));
	}
});

test("sanitizes control characters decoded from quoted Git paths", () => {
	const pathDiff =
		'diff --git "a/evil\\nname.ts" "b/evil\\nname.ts"\n' +
		'--- "a/evil\\nname.ts"\n' +
		'+++ "b/evil\\nname.ts"\n' +
		"@@ -1 +1 @@\n-old\n+new\n";
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Path controls",
		originalDiff: pathDiff,
		readingDiff: pathDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	const lines = viewer.render(72);
	assert.ok(lines.some((line) => line.includes("evil�name.ts")));
	assert.ok(lines.every((line) => !line.includes("\n")));

	const c1Diff =
		'diff --git "a/evil\\302\\23331m.ts" "b/evil\\302\\23331m.ts"\n' +
		'--- "a/evil\\302\\23331m.ts"\n' +
		'+++ "b/evil\\302\\23331m.ts"\n' +
		"@@ -1 +1 @@\n-old\n+new\n";
	const c1Viewer = new MeatDiffViewer({
		theme,
		summary: "C1 path controls",
		originalDiff: c1Diff,
		readingDiff: c1Diff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	const c1Lines = c1Viewer.render(72);
	assert.ok(c1Lines.some((line) => line.includes("evil�31m.ts")));
	assert.ok(c1Lines.every((line) => !line.includes("\u009b")));

	const bidiDiff = pathDiff.replaceAll("name.ts", "\u202ename.ts");
	const bidiViewer = new MeatDiffViewer({
		theme,
		summary: "Bidi path controls",
		originalDiff: bidiDiff,
		readingDiff: bidiDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	const bidiLines = bidiViewer.render(72);
	assert.ok(bidiLines.some((line) => line.includes("evil��name.ts")));
	assert.ok(bidiLines.every((line) => !line.includes("\u202e")));
});

test("reaches final unified line and sanitizes terminal controls", () => {
	const body = Array.from(
		{ length: 30 },
		(_, index) => ` line ${index + 1}`,
	).join("\n");
	const longDiff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,30 +1,30 @@\n${body}\n line\t30\u001b[31m`;
	const viewer = new MeatDiffViewer({
		theme,
		summary: "Focused review",
		originalDiff: longDiff,
		readingDiff: longDiff,
		modelLabel: "provider/model",
		viewportHeight: () => 8,
		done: () => {},
	});
	viewer.render(72);
	for (let index = 0; index < 100; index++) viewer.handleInput("j");
	const lines = viewer.render(72);
	assert.ok(lines.some((line) => line.includes("line    30�[31m")));
	assert.ok(
		lines.every((line) => !line.includes("\t") && !line.includes("\u001b")),
	);
});
