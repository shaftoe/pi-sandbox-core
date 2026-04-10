// ── Usage & Message Types ──────────────────────────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface MessageContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface PiMessage {
	role: string;
	content?: MessageContent[];
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number };
	};
	[key: string]: unknown;
}

// ── Result Types ───────────────────────────────────────────────────────

export interface DiffResult {
	changedFiles: string[];
	diff: string;
}

export interface PiRunResult {
	exitCode: number | null;
	messages: PiMessage[];
	stderr: string;
	usage: UsageStats;
}

/** Environment variable mapping forwarded from host to sandbox. */
export type EnvMapping = Record<string, string>;

// ── Subagent Details (unified) ─────────────────────────────────────────

export interface SubagentDetails {
	sandboxId: string;
	exitCode: number | null;
	usage: UsageStats;
	diff?: string;
	changedFiles?: string[];
	stderr: string;
	cancelled?: boolean;
}

// ── Streaming Types ────────────────────────────────────────────────────

/** Events emitted by pi's JSON streaming output during subagent execution. */
export type PiStreamEvent =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string }
	| { type: "tool_call"; name: string; args: unknown }
	| { type: "tool_result"; name: string; result: unknown }
	| { type: "message_end"; message: PiMessage }
	| { type: "turn_end" };

/** Callback for streaming events from pi inside the sandbox. */
export type OnPiEvent = (event: PiStreamEvent) => void;
