import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const width = 1200;
const height = 630;
const pixels = Buffer.alloc(width * height * 4);

const colors = {
	background: [14, 17, 23, 255],
	panel: [24, 29, 39, 255],
	text: [242, 244, 248, 255],
	muted: [159, 169, 185, 255],
	red: [145, 59, 68, 255],
	green: [48, 122, 84, 255],
	accent: [238, 113, 92, 255],
};

const font = {
	" ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
	"-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
	"+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
	".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
	0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
	1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
	2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
	3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
	4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
	5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
	6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
	7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
	8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
	9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
	C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
	G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
	J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
	K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
	L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
	M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
	N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
	W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
	X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
	Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
	Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function rect(x, y, w, h, color) {
	for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
		for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) {
			pixels.set(color, (row * width + col) * 4);
		}
	}
}

function text(value, x, y, scale, color) {
	let cursor = x;
	for (const character of value.toUpperCase()) {
		const glyph = font[character] ?? font[" "];
		for (let row = 0; row < glyph.length; row++) {
			for (let col = 0; col < glyph[row].length; col++) {
				if (glyph[row][col] === "1")
					rect(cursor + col * scale, y + row * scale, scale, scale, color);
			}
		}
		cursor += 6 * scale;
	}
}

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const name = Buffer.from(type);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, checksum]);
}

rect(0, 0, width, height, colors.background);
rect(48, 48, width - 96, height - 96, colors.panel);
rect(48, 48, 14, height - 96, colors.accent);
text("PI-MEAT", 112, 105, 12, colors.text);
text("READ THE CHANGE. SKIP THE GRISTLE.", 116, 228, 5, colors.muted);
rect(116, 334, 350, 54, colors.red);
rect(116, 406, 500, 54, colors.green);
text("- NOISE", 140, 345, 4, colors.text);
text("+ SIGNAL", 140, 417, 4, colors.text);
text("NAVIGABLE READING DIFFS FOR PI", 600, 354, 3, colors.text);
text("POWERED BY MEAT", 600, 418, 3, colors.muted);

const raw = Buffer.alloc((width * 4 + 1) * height);
for (let row = 0; row < height; row++) {
	const target = row * (width * 4 + 1);
	raw[target] = 0;
	pixels.copy(raw, target + 1, row * width * 4, (row + 1) * width * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(raw, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../assets/pi-meat-preview.png", import.meta.url), png);
process.stdout.write(
	`wrote assets/pi-meat-preview.png (${png.length} bytes)\n`,
);
