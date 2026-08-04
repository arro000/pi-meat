import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSplitRows } from "../extensions/pi-meat/diff-layout.ts";
import { MeatDiffViewer } from "../extensions/pi-meat/viewer.ts";
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
	const layoutColumn = visibleWidth("🥩 pi-meat  READING  ORIGINAL  ") + 1;
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
	viewer.handleInput("\x1b[<0;2;8M");
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
	assert.ok(lines.some((line) => line.includes("col 7-45/45")));
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
