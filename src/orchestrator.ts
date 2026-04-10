import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "./execute/config";
import { CLEANUP_TIMEOUT_MS } from "./execute/constants";
import {
	formatCancelledResult,
	formatFailureResult,
	formatSuccessResult,
} from "./execute/result";
import type {
	ExecuteContext,
	ExecuteParams,
	ExecuteReturn,
	OnUpdate,
} from "./execute/types";
import { isAbortError, textContent } from "./execute/utils";
import {
	buildPiArgs,
	escapeShellArg,
	parseGitStatus,
	parseJsonlOutput,
} from "./helpers";
import type {
	ExecChunk,
	ExecOptions,
	SandboxHandle,
	SandboxProvider,
	WorkspaceParams,
	WorkspaceResult,
} from "./provider";
import type { DiffResult, OnPiEvent, PiMessage, PiRunResult } from "./types";
import { collectForwardedEnv, withTimeout } from "./utils";

// ── Auth ───────────────────────────────────────────────────────────────

/** Sync host ~/.pi/agent/ into sandbox. */
export async function syncPiAuth(
	provider: SandboxProvider,
	handle: SandboxHandle,
	options?: {
		/** Destination directory inside the sandbox. Defaults to "/root/.pi/agent". */
		sandboxAgentDir?: string;
		/** Override the host .pi/agent directory. Defaults to ~/.pi/agent. */
		hostAgentDir?: string;
	},
): Promise<void> {
	const sandboxDir = options?.sandboxAgentDir ?? "/root/.pi/agent";
	const resolvedHostDir =
		options?.hostAgentDir ?? join(homedir(), ".pi", "agent");

	// auth.json is required
	const authPath = join(resolvedHostDir, "auth.json");
	let authContent: string;
	try {
		authContent = readFileSync(authPath, "utf-8");
	} catch {
		throw new Error(
			`Cannot read ${authPath}. Ensure you are logged in (run 'pi' interactively first).`,
		);
	}

	// Create agent dir in sandbox
	await provider.exec(handle, `mkdir -p ${sandboxDir}`);
	await provider.writeFile(handle, `${sandboxDir}/auth.json`, authContent);

	// models.json is optional
	const modelsPath = join(resolvedHostDir, "models.json");
	try {
		const modelsContent = readFileSync(modelsPath, "utf-8");
		await provider.writeFile(
			handle,
			`${sandboxDir}/models.json`,
			modelsContent,
		);
	} catch {
		// optional — skip
	}
}

/** Authenticate gh CLI inside the sandbox. */
export async function setupGhAuth(
	provider: SandboxProvider,
	handle: SandboxHandle,
	token: string,
): Promise<void> {
	const result = await provider.exec(
		handle,
		`echo ${escapeShellArg(token)} | gh auth login --with-token`,
	);
	if (result.exitCode !== 0) {
		throw new Error(`gh auth login failed: ${result.stderr}`);
	}
	await provider.exec(handle, "gh auth setup-git");
}

// ── Pi Execution ───────────────────────────────────────────────────────

/**
 * Run `pi --mode json` inside the sandbox. Streaming-aware:
 *
 * - If the provider implements execStream() and onEvent is provided,
 *   pi's JSONL output is parsed incrementally and surfaced via onEvent.
 * - Otherwise, output is buffered and parsed after completion.
 *
 * Both paths return the same PiRunResult.
 */
export async function runPi(
	provider: SandboxProvider,
	handle: SandboxHandle,
	options: {
		task: string;
		cwd: string;
		systemPrompt?: string;
		model?: string;
		tools?: string[];
		signal?: AbortSignal;
		timeoutMs?: number;
		onEvent?: OnPiEvent;
	},
): Promise<PiRunResult> {
	// 1. Write task and system prompt to files
	await provider.writeFile(handle, "/tmp/pi-task.md", options.task);
	if (options.systemPrompt) {
		await provider.writeFile(handle, "/tmp/pi-system.md", options.systemPrompt);
	}

	// 2. Build pi invocation args
	const piArgs = buildPiArgs(options).join(" ");

	// 3. Streaming path: provider supports real-time output
	if (provider.execStream && options.onEvent) {
		return runPiStreaming(
			handle,
			piArgs,
			{ ...options, onEvent: options.onEvent },
			provider.execStream,
		);
	}

	// 4. Buffered fallback: all providers support this
	const result = await provider.exec(handle, piArgs, {
		workdir: options.cwd,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});

	return parseJsonlOutput(result.stdout, result.stderr, result.exitCode);
}

/** Streaming implementation — parses JSONL incrementally as chunks arrive. */
async function runPiStreaming(
	handle: SandboxHandle,
	piArgs: string,
	options: {
		cwd: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		onEvent: OnPiEvent;
	},
	execStream: (
		handle: SandboxHandle,
		command: string,
		options?: ExecOptions,
	) => AsyncIterable<ExecChunk>,
): Promise<PiRunResult> {
	const result: PiRunResult = {
		exitCode: null,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		},
	};

	let buffer = "";
	const onEvent = options.onEvent;

	for await (const chunk of execStream(handle, piArgs, {
		workdir: options.cwd,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	})) {
		switch (chunk.type) {
			case "stdout":
				buffer += chunk.data;
				// Parse complete JSONL lines from buffer
				while (buffer.includes("\n")) {
					const newlineIdx = buffer.indexOf("\n");
					const line = buffer.slice(0, newlineIdx).trim();
					buffer = buffer.slice(newlineIdx + 1);
					if (!line) continue;
					try {
						const event = JSON.parse(line);
						processStreamEvent(event, onEvent, result);
					} catch {
						// incomplete JSON or non-JSON line — skip
					}
				}
				break;
			case "stderr":
				result.stderr += chunk.data;
				break;
			case "exit":
				result.exitCode = chunk.exitCode;
				break;
		}
	}

	// Parse any remaining buffered content
	if (buffer.trim()) {
		try {
			const event = JSON.parse(buffer.trim());
			processStreamEvent(event, onEvent, result);
		} catch {
			// incomplete — skip
		}
	}

	return result;
}

/**
 * Process a single JSONL event from pi --mode json output.
 * Dispatches to the onEvent callback and accumulates into the result.
 */
function processStreamEvent(
	event: { type: string; [key: string]: unknown },
	onEvent: OnPiEvent,
	result: PiRunResult,
): void {
	switch (event.type) {
		case "message_update": {
			const msg = event.message as PiMessage;
			if (msg.role === "assistant") {
				for (const block of msg.content ?? []) {
					if (block.type === "thinking" && block.text) {
						onEvent({ type: "thinking", text: block.text });
					}
					if (block.type === "text" && block.text) {
						onEvent({ type: "text", text: block.text });
					}
				}
			}
			break;
		}
		case "message_end": {
			const msg = event.message as PiMessage;
			result.messages.push(msg);
			if (msg.role === "assistant") {
				result.usage.turns++;
				const usage = msg.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
				}
				onEvent({ type: "message_end", message: msg });
			}
			break;
		}
		case "tool_execution_start":
			onEvent({
				type: "tool_call",
				name: String(event.toolName ?? ""),
				args: event.args,
			});
			break;
		case "tool_execution_end":
			onEvent({
				type: "tool_result",
				name: String(event.toolName ?? ""),
				result: event.result,
			});
			break;
		case "tool_result_end": {
			// Buffered compatibility: some pi versions emit this instead of tool_execution_end
			const msg = event.message as PiMessage | undefined;
			if (msg) result.messages.push(msg);
			break;
		}
		case "turn_end":
			onEvent({ type: "turn_end" });
			break;
	}
}

// ── Diff Capture ───────────────────────────────────────────────────────

/** Capture git diff from sandbox workspace. Returns null if clean or not a git repo. */
export async function captureDiff(
	provider: SandboxProvider,
	handle: SandboxHandle,
	cwd: string,
	signal?: AbortSignal,
): Promise<DiffResult | null> {
	const check = await provider.exec(
		handle,
		`cd ${cwd} && git rev-parse --is-inside-work-tree`,
		{ signal },
	);
	if (check.exitCode !== 0 || check.stdout.trim() !== "true") return null;

	const status = await provider.exec(
		handle,
		`cd ${cwd} && git status --porcelain`,
		{ signal },
	);
	if (status.exitCode !== 0 || !status.stdout.trim()) return null;

	const diff = await provider.exec(
		handle,
		`cd ${cwd} && git diff && git diff --cached`,
		{ signal },
	);

	const changedFiles = parseGitStatus(status.stdout);
	return { changedFiles, diff: diff.stdout };
}

// ── Default Workspace Preparation ──────────────────────────────────────

/** Default workspace preparation: git clone or mkdir. */
export async function defaultPrepareWorkspace(
	provider: SandboxProvider,
	handle: SandboxHandle,
	params: WorkspaceParams,
): Promise<WorkspaceResult> {
	if (params.gitUrl) {
		let cloneCmd = "git clone --depth 1";
		if (params.branch) cloneCmd += ` --branch ${params.branch}`;
		cloneCmd += ` ${escapeShellArg(params.gitUrl)} ${params.workspacePath}`;
		const result = await provider.exec(handle, cloneCmd);
		if (result.exitCode !== 0) {
			return {
				ok: false,
				content: `Failed to clone: ${result.stderr || "unknown error"}`,
				exitCode: result.exitCode,
			};
		}
		return { ok: true };
	}
	await provider.exec(handle, `mkdir -p ${params.workspacePath}`);
	return { ok: true };
}

// ── Full Pipeline ──────────────────────────────────────────────────────

/**
 * Execute a subagent using the full pipeline.
 * Works with any SandboxProvider implementation.
 */
export async function executeSubagent(
	provider: SandboxProvider,
	params: ExecuteParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate,
	ctx: ExecuteContext,
): Promise<ExecuteReturn> {
	// 1. Create sandbox
	onUpdate?.({
		content: [textContent("Creating sandbox...")],
		details: undefined,
	});
	const handle = await provider.create({
		workspacePath: ctx.workspacePath,
		template: params.template,
	});

	try {
		// 2. Setup environment (env vars) — provider hook or no-op default
		const env = collectForwardedEnv(ctx.envPrefix, ctx.envExclude);
		if (provider.setupEnvironment) {
			await provider.setupEnvironment(handle, env);
		}

		// 3. Auth: pi provider keys + gh CLI
		onUpdate?.({
			content: [textContent("Setting up environment...")],
			details: undefined,
		});
		await syncPiAuth(provider, handle, {
			sandboxAgentDir: ctx.sandboxAgentDir,
			hostAgentDir: ctx.hostAgentDir,
		});
		if (env.GITHUB_TOKEN) {
			await setupGhAuth(provider, handle, env.GITHUB_TOKEN);
		}

		// 4. Prepare workspace — provider hook or default (git clone / mkdir)
		const prepareWorkspace =
			provider.prepareWorkspace ??
			((handle, params) => defaultPrepareWorkspace(provider, handle, params));
		const workspaceResult = await prepareWorkspace(handle, {
			gitUrl: params.gitUrl,
			branch: params.branch,
			workspacePath: ctx.workspacePath,
		});
		if (!workspaceResult.ok) {
			return formatFailureResult(handle.id, workspaceResult);
		}

		// 5. Resolve config (model + system prompt)
		const config = resolveModel(params, ctx);

		// 6. Run pi and capture diff
		const modelLabel = config.model ?? "default";
		onUpdate?.({
			content: [textContent(`Running pi (${modelLabel})...`)],
			details: undefined,
		});

		// Wire up streaming updates if provider supports it
		const onPiEvent = provider.execStream
			? createStreamingUpdate(onUpdate)
			: undefined;

		const result = await runPi(provider, handle, {
			task: config.task,
			cwd: ctx.workspacePath,
			systemPrompt: config.systemPrompt,
			model: config.model,
			tools: config.tools,
			signal,
			timeoutMs: config.timeoutMs,
			onEvent: onPiEvent,
		});

		let diff: DiffResult | null = null;
		if (!signal?.aborted) {
			onUpdate?.({
				content: [textContent("Capturing changes...")],
				details: undefined,
			});
			diff = await captureDiff(provider, handle, ctx.workspacePath, signal);
		}

		// 7. Return success result
		return formatSuccessResult(handle.id, result, diff);
	} catch (error) {
		if (isAbortError(error, signal)) {
			return formatCancelledResult(handle.id);
		}
		throw error;
	} finally {
		// Cleanup. Fire-and-forget on abort so the cancellation result returns instantly.
		if (signal?.aborted) {
			provider
				.destroy(handle)
				.then(() => ctx.ui.notify(`Sandbox ${handle.id} cleaned up`, "info"))
				.catch(() =>
					ctx.ui.notify(
						`Sandbox ${handle.id} cleanup failed (will auto-delete on idle)`,
						"warning",
					),
				);
		} else {
			void withTimeout(
				provider.destroy(handle),
				CLEANUP_TIMEOUT_MS,
				"sandbox cleanup",
			);
		}
	}
}

/**
 * Convert streaming pi events into onUpdate progress messages.
 * Bridges the streaming PiStreamEvent protocol with pi's tool onUpdate callback.
 */
function createStreamingUpdate(onUpdate: OnUpdate): OnPiEvent {
	let lastThinking = "";
	let lastText = "";

	return (event) => {
		switch (event.type) {
			case "thinking":
				// Only emit if meaningfully different from last update
				if (event.text.length - lastThinking.length > 50) {
					lastThinking = event.text;
					onUpdate?.({
						content: [textContent(`💭 Thinking: ${event.text.slice(-200)}...`)],
						details: undefined,
					});
				}
				break;
			case "text":
				if (event.text.length - lastText.length > 100) {
					lastText = event.text;
					onUpdate?.({
						content: [textContent(`📝 ${event.text.slice(-200)}`)],
						details: undefined,
					});
				}
				break;
			case "tool_call":
				onUpdate?.({
					content: [textContent(`🔧 Calling: ${event.name}`)],
					details: undefined,
				});
				break;
			case "turn_end":
				onUpdate?.({
					content: [textContent("Turn completed, continuing...")],
					details: undefined,
				});
				break;
		}
	};
}
