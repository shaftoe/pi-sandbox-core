import type { SubagentDetails } from "../types";

export interface ExecuteParams {
	task: string;
	gitUrl?: string;
	branch?: string;
	model?: string;
	tools?: string;
	systemPrompt?: string;
	timeout?: number;
	template?: string;
}

export interface ExecuteContext {
	model?: { provider: string; id: string };
	cwd: string;
	workspacePath: string;
	envPrefix: string;
	envExclude: Set<string>;
	ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void };
	/** Override the host .pi/agent directory. Defaults to ~/.pi/agent. */
	hostAgentDir?: string;
	/** Override the agent directory inside the sandbox. Defaults to /root/.pi/agent. */
	sandboxAgentDir?: string;
}

export type OnUpdate =
	| ((update: {
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
	  }) => void)
	| undefined;

export interface ExecuteReturn {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentDetails;
}

export interface RunConfig {
	task: string;
	model: string | undefined;
	systemPrompt: string | undefined;
	tools: string[] | undefined;
	timeoutMs: number | undefined;
}
