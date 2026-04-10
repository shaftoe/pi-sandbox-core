import type { PiMessage } from "./types";

/** Resolve a promise with a timeout fallback. Never rejects — logs on timeout. */
export async function withTimeout(
	promise: Promise<unknown>,
	ms: number,
	_label: string,
): Promise<void> {
	try {
		await Promise.race([
			promise,
			new Promise<"timeout">((resolve) =>
				setTimeout(() => resolve("timeout"), ms),
			),
		]);
	} catch {
		// best-effort
	}
}

/** Extract the final text output from parsed pi messages. */
export function getFinalOutput(messages: PiMessage[]): string {
	const lastAssistant = [...messages]
		.reverse()
		.find((m) => m.role === "assistant");
	if (!lastAssistant) return "";
	return (
		lastAssistant.content
			?.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n") ?? ""
	);
}

/**
 * Collect environment variables to forward from the host to the sandbox.
 *
 * Two sources are merged (explicit overrides prefix):
 * 1. `<prefix>*` prefix convention — e.g. FREESTYLE_ENV_GITHUB_TOKEN
 *    becomes GITHUB_TOKEN in the sandbox.
 * 2. Explicit `GITHUB_TOKEN` on the host (kept for backwards compatibility).
 *
 * Provider-internal vars are excluded via the exclude set.
 */
export function collectForwardedEnv(
	prefix: string,
	exclude: Set<string>,
): Record<string, string> {
	const env: Record<string, string> = {};

	// Prefix convention: <PREFIX><NAME> → <NAME>
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith(prefix) && value) {
			const varName = key.slice(prefix.length);
			if (varName && !exclude.has(varName)) {
				env[varName] = value;
			}
		}
	}

	// Backwards-compatible: host GITHUB_TOKEN if not already set via prefix
	const ghToken = process.env.GITHUB_TOKEN;
	if (ghToken && !env.GITHUB_TOKEN) {
		env.GITHUB_TOKEN = ghToken;
	}

	return env;
}
