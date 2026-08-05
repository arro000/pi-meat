export function sanitizeTerminalText(value: string): string {
	return value
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gi, "�");
}
