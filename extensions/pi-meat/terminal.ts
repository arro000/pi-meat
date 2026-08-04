export function sanitizeTerminalText(value: string): string {
	return value.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g, "�");
}
