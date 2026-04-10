export function textContent(text: string) {
	return { type: "text" as const, text };
}

export function isAbortError(
	error: unknown,
	signal: AbortSignal | undefined,
): boolean {
	return !!(
		signal?.aborted ||
		(error instanceof DOMException && error.name === "AbortError")
	);
}
