import type { DiffResult, PiRunResult } from "../types";
import { getFinalOutput } from "../utils";
import type { ExecuteReturn } from "./types";
import { textContent } from "./utils";

export function formatSuccessResult(
	sandboxId: string,
	result: PiRunResult,
	diff: DiffResult | null,
): ExecuteReturn {
	const finalOutput = getFinalOutput(result.messages);
	const outputText =
		finalOutput ||
		(result.stderr ? ` stderr:\n${result.stderr}` : "(no output)");
	return {
		content: [textContent(outputText)],
		details: {
			sandboxId,
			exitCode: result.exitCode,
			usage: result.usage,
			diff: diff?.diff ?? "",
			changedFiles: diff?.changedFiles ?? [],
			stderr: result.stderr,
		},
	};
}

export function formatCancelledResult(sandboxId: string): ExecuteReturn {
	return {
		content: [textContent("⚠ Operation cancelled by user")],
		details: {
			sandboxId,
			exitCode: null,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
			},
			diff: "",
			changedFiles: [],
			stderr: "",
			cancelled: true,
		},
	};
}

export function formatFailureResult(
	sandboxId: string,
	failure: { content: string; exitCode: number | null },
): ExecuteReturn {
	return {
		content: [textContent(failure.content)],
		details: {
			sandboxId,
			exitCode: failure.exitCode,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
			},
			diff: "",
			changedFiles: [],
			stderr: "",
		},
	};
}
