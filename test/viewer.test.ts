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
