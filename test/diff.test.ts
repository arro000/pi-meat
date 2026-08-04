import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../internal/diff.ts";

test("parses changed files without exposing commit preamble as a file", () => {
	const parsed = parseUnifiedDiff(
		`commit abc\nAuthor: A\n\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+added\n`,
	);
	assert.equal(parsed.files.length, 2);
	assert.equal(parsed.files[0]?.path, "a.ts");
	assert.deepEqual([parsed.files[0]?.added, parsed.files[0]?.removed], [1, 1]);
	assert.equal(parsed.files[1]?.path, "b.ts");
	assert.deepEqual([parsed.files[1]?.added, parsed.files[1]?.removed], [1, 0]);
});

test("handles CRLF, quoted paths, marker-like code and no-newline metadata", () => {
	const parsed = parseUnifiedDiff(
		[
			'diff --git "a/src/file name.ts" "b/src/file name.ts"',
			'--- "a/src/file name.ts"',
			'+++ "b/src/file name.ts"',
			"@@ -1,2 +1,2 @@",
			"---not a file marker",
			"+++not a file marker",
			"\\ No newline at end of file",
		].join("\r\n"),
	);
	assert.equal(parsed.files[0]?.path, "src/file name.ts");
	assert.deepEqual([parsed.files[0]?.added, parsed.files[0]?.removed], [1, 1]);
	assert.equal(parsed.lines.at(-1)?.kind, "meta");

	const utf8 = parseUnifiedDiff(
		'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n' +
			'--- "a/caf\\303\\251.ts"\n' +
			'+++ "b/caf\\303\\251.ts"\n' +
			"@@ -1 +1 @@\n-old\n+new\n",
	);
	assert.equal(utf8.files[0]?.path, "café.ts");
});

test("returns an empty structure for empty input", () => {
	assert.deepEqual(parseUnifiedDiff(""), { lines: [], files: [] });
});
