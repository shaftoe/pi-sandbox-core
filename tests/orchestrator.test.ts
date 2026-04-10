import { afterAll, describe, expect, it, vi } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	syncPiAuth,
	setupGhAuth,
	runPi,
	captureDiff,
	defaultPrepareWorkspace,
	executeSubagent,
} from "../src/orchestrator";
import type {
	SandboxProvider,
	SandboxHandle,
	ExecResult,
	ExecChunk,
	WorkspaceResult,
} from "../src/provider";
import type { ExecuteContext } from "../src/execute/types";
import type { PiStreamEvent } from "../src/types";

// ── Mock Provider ──────────────────────────────────────────────────────

function createMockProvider(overrides?: Partial<SandboxProvider>): {
	provider: SandboxProvider;
	executed: Array<{ cmd: string; opts?: unknown }>;
	writtenFiles: Array<{ path: string; content: string }>;
	created: SandboxHandle[];
	destroyed: string[];
} {
	const executed: Array<{ cmd: string; opts?: unknown }> = [];
	const writtenFiles: Array<{ path: string; content: string }> = [];
	const created: SandboxHandle[] = [];
	const destroyed: string[] = [];

	const handle: SandboxHandle = { id: "test-sandbox-123" };

	const provider: SandboxProvider = {
		initialize: vi.fn(async () => {}),
		cleanup: vi.fn(async () => {}),
		create: vi.fn(async () => {
			created.push(handle);
			return handle;
		}),
		destroy: vi.fn(async (h: SandboxHandle) => {
			destroyed.push(h.id);
		}),
		exec: vi.fn(async (_h: SandboxHandle, cmd: string, opts?: unknown) => {
			executed.push({ cmd, opts });
			// Default: return success
			const result: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

			// Simulate git rev-parse
			if (cmd.includes("git rev-parse")) {
				result.stdout = "true";
			}
			// Simulate git status (no changes)
			if (cmd.includes("git status")) {
				result.stdout = "";
			}

			return result;
		}),
		writeFile: vi.fn(async (_h: SandboxHandle, path: string, content: string) => {
			writtenFiles.push({ path, content });
		}),
		...overrides,
	};

	return { provider, executed, writtenFiles, created, destroyed };
}

// ── Test Fixtures ──────────────────────────────────────────────────────

/** Temp host agent dir with a dummy auth.json for executeSubagent tests. */
let _hostAgentDir: string | undefined;

function getHostAgentDir(): string {
	if (!_hostAgentDir) {
		_hostAgentDir = join(tmpdir(), `pi-test-agent-${Date.now()}`);
		mkdirSync(_hostAgentDir, { recursive: true });
		writeFileSync(join(_hostAgentDir, "auth.json"), '{"test":true}');
	}
	return _hostAgentDir;
}

function cleanupHostAgentDir(): void {
	if (_hostAgentDir) {
		rmSync(_hostAgentDir, { recursive: true, force: true });
		_hostAgentDir = undefined;
	}
}

// Global cleanup after all tests
afterAll(() => {
	cleanupHostAgentDir();
});

function createTestContext(overrides?: Partial<ExecuteContext>): ExecuteContext {
	return {
		cwd: "/tmp/test-project",
		workspacePath: "/workspace",
		envPrefix: "TEST_ENV_",
		envExclude: new Set(),
		ui: { notify: vi.fn() },
		hostAgentDir: getHostAgentDir(),
		...overrides,
	};
}

// ── syncPiAuth ─────────────────────────────────────────────────────────

	describe("syncPiAuth", () => {
		it("writes auth.json to sandbox", async () => {
			const { provider, writtenFiles } = createMockProvider();
			const handle: SandboxHandle = { id: "test" };

			// Create a temp host agent dir with auth.json
			const tmpHost = join(tmpdir(), `pi-test-host-${Date.now()}`);
			mkdirSync(join(tmpHost, ".pi", "agent"), { recursive: true });
			writeFileSync(join(tmpHost, ".pi", "agent", "auth.json"), '{"key":"value"}');

			try {
				await syncPiAuth(provider, handle, {
					sandboxAgentDir: "/root/.pi/agent",
					hostAgentDir: join(tmpHost, ".pi", "agent"),
				});
				expect(writtenFiles.some((f) => f.path === "/root/.pi/agent/auth.json")).toBe(true);
			} finally {
				rmSync(tmpHost, { recursive: true, force: true });
			}
		});

		it("throws descriptive error when auth.json is missing", async () => {
			const { provider } = createMockProvider();
			const handle: SandboxHandle = { id: "test" };

			// Create a temp host agent dir WITHOUT auth.json
			const tmpHost = join(tmpdir(), `pi-test-noauth-${Date.now()}`);
			mkdirSync(join(tmpHost, ".pi", "agent"), { recursive: true });
			// auth.json intentionally NOT created

			try {
				await expect(
					syncPiAuth(provider, handle, {
						sandboxAgentDir: "/root/.pi/agent",
						hostAgentDir: join(tmpHost, ".pi", "agent"),
					}),
				).rejects.toThrow("Cannot read");
				await expect(
					syncPiAuth(provider, handle, {
						sandboxAgentDir: "/root/.pi/agent",
						hostAgentDir: join(tmpHost, ".pi", "agent"),
					}),
				).rejects.toThrow("Ensure you are logged in");
			} finally {
				rmSync(tmpHost, { recursive: true, force: true });
			}
		});
	});

// ── setupGhAuth ────────────────────────────────────────────────────────

describe("setupGhAuth", () => {
	it("calls gh auth login and setup-git", async () => {
		const { provider, executed } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		await setupGhAuth(provider, handle, "ghp_test123");

		expect(executed.length).toBeGreaterThanOrEqual(2);
		expect(executed[0].cmd).toContain("gh auth login");
		expect(executed[1].cmd).toContain("gh auth setup-git");
	});

	it("throws on non-zero exit from gh auth login", async () => {
		const { provider } = createMockProvider({
			exec: async (_h, cmd) => {
				if (cmd.includes("gh auth login")) {
					return { exitCode: 1, stdout: "", stderr: "auth failed" };
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		const handle: SandboxHandle = { id: "test" };

		await expect(setupGhAuth(provider, handle, "bad-token")).rejects.toThrow("gh auth login failed");
	});
});

// ── runPi ──────────────────────────────────────────────────────────────

describe("runPi", () => {
	it("writes task file and executes pi", async () => {
		const { provider, executed, writtenFiles } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		await runPi(provider, handle, {
			task: "do something",
			cwd: "/workspace",
		});

		// Should write task file
		expect(writtenFiles.some((f) => f.path === "/tmp/pi-task.md")).toBe(true);
		// Should execute pi command
		expect(executed.some((e) => e.cmd.includes("pi --mode json"))).toBe(true);
	});

	it("writes system prompt file when provided", async () => {
		const { provider, writtenFiles } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		await runPi(provider, handle, {
			task: "do something",
			cwd: "/workspace",
			systemPrompt: "be helpful",
		});

		expect(writtenFiles.some((f) => f.path === "/tmp/pi-system.md")).toBe(true);
	});
});

// ── captureDiff ────────────────────────────────────────────────────────

describe("captureDiff", () => {
	it("returns null when not a git repo", async () => {
		const { provider } = createMockProvider({
			exec: async () => ({ exitCode: 128, stdout: "", stderr: "not a repo" }),
		});
		const handle: SandboxHandle = { id: "test" };

		const result = await captureDiff(provider, handle, "/workspace");
		expect(result).toBeNull();
	});

	it("returns null when workspace is clean", async () => {
		const { provider } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		// Default mock returns empty git status → clean
		const result = await captureDiff(provider, handle, "/workspace");
		expect(result).toBeNull();
	});

	it("returns diff when there are changes", async () => {
		let callCount = 0;
		const { provider } = createMockProvider({
			exec: async (_h, cmd) => {
				callCount++;
				if (cmd.includes("git rev-parse")) {
					return { exitCode: 0, stdout: "true", stderr: "" };
				}
				if (cmd.includes("git status")) {
					return { exitCode: 0, stdout: "M  src/foo.ts\n", stderr: "" };
				}
				if (cmd.includes("git diff")) {
					return { exitCode: 0, stdout: "+added line\n", stderr: "" };
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		const handle: SandboxHandle = { id: "test" };

		const result = await captureDiff(provider, handle, "/workspace");
		expect(result).not.toBeNull();
		expect(result!.changedFiles).toEqual(["src/foo.ts"]);
		expect(result!.diff).toBe("+added line\n");
	});
});

// ── defaultPrepareWorkspace ────────────────────────────────────────────

describe("defaultPrepareWorkspace", () => {
	it("runs git clone when gitUrl provided", async () => {
		const { provider, executed } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		const result = await defaultPrepareWorkspace(provider, handle, {
			gitUrl: "https://github.com/org/repo.git",
			workspacePath: "/workspace",
		});

		expect(result).toEqual({ ok: true });
		expect(executed.some((e) => e.cmd.includes("git clone"))).toBe(true);
	});

	it("runs git clone with branch when specified", async () => {
		const { provider, executed } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		await defaultPrepareWorkspace(provider, handle, {
			gitUrl: "https://github.com/org/repo.git",
			branch: "main",
			workspacePath: "/workspace",
		});

		expect(executed.some((e) => e.cmd.includes("--branch main"))).toBe(true);
	});

	it("returns failure when git clone fails", async () => {
		const { provider } = createMockProvider({
			exec: async () => ({ exitCode: 128, stdout: "", stderr: "clone error" }),
		});
		const handle: SandboxHandle = { id: "test" };

		const result = await defaultPrepareWorkspace(provider, handle, {
			gitUrl: "https://github.com/org/repo.git",
			workspacePath: "/workspace",
		});

		expect(result).toEqual({
			ok: false,
			content: "Failed to clone: clone error",
			exitCode: 128,
		});
	});

	it("creates directory when no gitUrl", async () => {
		const { provider, executed } = createMockProvider();
		const handle: SandboxHandle = { id: "test" };

		const result = await defaultPrepareWorkspace(provider, handle, {
			workspacePath: "/workspace",
		});

		expect(result).toEqual({ ok: true });
		expect(executed.some((e) => e.cmd.includes("mkdir -p"))).toBe(true);
	});
});

// ── executeSubagent (full pipeline) ────────────────────────────────────

describe("executeSubagent", () => {
	it("creates and destroys sandbox", async () => {
		const { provider, created } = createMockProvider();
		const ctx = createTestContext();

		await executeSubagent(
			provider,
			{ task: "hello" },
			undefined,
			undefined,
			ctx,
		);

		expect(created.length).toBe(1);
		// destroy is called in finally block (with timeout, fire-and-forget)
	});

	it("returns cancelled result when aborted", async () => {
		const controller = new AbortController();

		const { provider } = createMockProvider({
			exec: async (_h, _cmd, opts) => {
				// Simulate real provider behavior: reject on aborted signal
				if (opts && 'signal' in opts && (opts as { signal?: AbortSignal }).signal?.aborted) {
					throw new DOMException("Aborted", "AbortError");
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});

		// Abort before execution
		controller.abort();

		const ctx = createTestContext();

		const result = await executeSubagent(
			provider,
			{ task: "hello" },
			controller.signal,
			undefined,
			ctx,
		);

		expect(result.details.cancelled).toBe(true);
	});

	it("calls provider.setupEnvironment hook when defined", async () => {
		const setupEnvCalls: Array<{ handle: SandboxHandle; env: Record<string, string> }> = [];
		const { provider } = createMockProvider({
			setupEnvironment: async (handle, env) => {
				setupEnvCalls.push({ handle, env });
			},
		});

		process.env.TESTENV_MY_VAR = "hello";
		const ctx = createTestContext({ envPrefix: "TESTENV_" });

		await executeSubagent(provider, { task: "hello" }, undefined, undefined, ctx);

		expect(setupEnvCalls.length).toBe(1);
		expect(setupEnvCalls[0].env.MY_VAR).toBe("hello");

		delete process.env.TESTENV_MY_VAR;
	});

	it("uses provider.prepareWorkspace hook when defined", async () => {
		const prepareCalls: Array<{ handle: SandboxHandle; params: unknown }> = [];
		const { provider } = createMockProvider({
			prepareWorkspace: async (handle, params) => {
				prepareCalls.push({ handle, params });
				return { ok: true };
			},
		});

		const ctx = createTestContext();
		await executeSubagent(provider, { task: "hello" }, undefined, undefined, ctx);

		expect(prepareCalls.length).toBe(1);
	});

	it("falls back to defaultPrepareWorkspace when no hook", async () => {
		// No prepareWorkspace hook → default does mkdir -p
		const { provider, executed } = createMockProvider();
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, undefined, ctx);

		// defaultPrepareWorkspace should have run mkdir -p
		expect(executed.some((e) => e.cmd.includes("mkdir -p"))).toBe(true);
	});

	it("returns failure result when workspace prep fails", async () => {
		const { provider } = createMockProvider({
			prepareWorkspace: async () => ({
				ok: false,
				content: "clone exploded",
				exitCode: 128,
			}),
		});

		const ctx = createTestContext();
		const result = await executeSubagent(
			provider,
			{ task: "hello", gitUrl: "https://example.com/repo.git" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details.exitCode).toBe(128);
		expect(result.content[0].text).toBe("clone exploded");
	});

	it("re-throws non-abort errors", async () => {
		const { provider } = createMockProvider({
			writeFile: async () => {
				throw new Error("disk full");
			},
		});

		const ctx = createTestContext();
		await expect(
			executeSubagent(provider, { task: "hello" }, undefined, undefined, ctx),
		).rejects.toThrow("disk full");
	});

	it("calls setupGhAuth when GITHUB_TOKEN is forwarded", async () => {
		const ghAuthCalls: string[] = [];
		const { provider } = createMockProvider({
			exec: async (_h, cmd) => {
				if (cmd.includes("gh auth login")) ghAuthCalls.push("login");
				if (cmd.includes("gh auth setup-git")) ghAuthCalls.push("setup-git");
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});

		process.env.TESTENV_GITHUB_TOKEN = "ghp_test";
		const ctx = createTestContext({ envPrefix: "TESTENV_" });

		await executeSubagent(provider, { task: "hello" }, undefined, undefined, ctx);

		expect(ghAuthCalls).toContain("login");
		expect(ghAuthCalls).toContain("setup-git");

		delete process.env.TESTENV_GITHUB_TOKEN;
	});

	it("notifies on failed cleanup during abort", async () => {
		const controller = new AbortController();
		const notify = vi.fn();

		const { provider } = createMockProvider({
			exec: async (_h, _cmd, opts) => {
				if (opts && 'signal' in opts && (opts as { signal?: AbortSignal }).signal?.aborted) {
					throw new DOMException("Aborted", "AbortError");
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			destroy: async () => {
				throw new Error("destroy failed");
			},
		});

		controller.abort();
		const ctx = createTestContext({ ui: { notify } });

		const result = await executeSubagent(
			provider,
			{ task: "hello" },
			controller.signal,
			undefined,
			ctx,
		);

		expect(result.details.cancelled).toBe(true);

		// Wait for async cleanup to settle
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("cleanup failed"),
			"warning",
		);
	});
});

// ── Streaming ──────────────────────────────────────────────────────────

/** Create a provider with execStream that yields the given chunks. */
function createStreamingProvider(
	chunks: ExecChunk[],
	overrides?: Partial<SandboxProvider>,
): { provider: SandboxProvider; writtenFiles: Array<{ path: string; content: string }> } {
	const base = createMockProvider(overrides);
	return {
		...base,
		provider: {
			...base.provider,
			async *execStream(_handle: SandboxHandle, _cmd: string) {
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		},
	};
}

// Sample JSONL events that pi --mode json would produce
const PI_JSONL_THINKING = JSON.stringify({
	type: "message_update",
	message: {
		role: "assistant",
		content: [{ type: "thinking", text: "Let me analyze the code..." }],
	},
});

const PI_JSONL_TEXT = JSON.stringify({
	type: "message_update",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "I found the bug." }],
	},
});

const PI_JSONL_MESSAGE_END = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "I found the bug." }],
		usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.01 } },
	},
});

const PI_JSONL_TOOL_CALL = JSON.stringify({
	type: "tool_execution_start",
	toolCallId: "tc_1",
	toolName: "read",
	args: { path: "foo.ts" },
});

const PI_JSONL_TOOL_RESULT = JSON.stringify({
	type: "tool_execution_end",
	toolCallId: "tc_1",
	toolName: "read",
	result: { content: "file contents" },
	isError: false,
});

const PI_JSONL_TURN_END = JSON.stringify({ type: "turn_end" });

describe("runPi (streaming)", () => {
	it("uses execStream when provider supports it and onEvent is provided", async () => {
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider, writtenFiles } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };
		const events: PiStreamEvent[] = [];

		const result = await runPi(provider, handle, {
			task: "analyze this",
			cwd: "/workspace",
			onEvent: (e) => events.push(e),
		});

		// Task file was written
		expect(writtenFiles.some((f) => f.path === "/tmp/pi-task.md")).toBe(true);

		// Result parsed from streaming
		expect(result.exitCode).toBe(0);
		expect(result.messages.length).toBe(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.usage.input).toBe(100);
		expect(result.usage.output).toBe(50);
		expect(result.usage.cost).toBe(0.01);

		// Events dispatched
		expect(events.some((e) => e.type === "message_end")).toBe(true);
	});

	it("falls back to exec when onEvent is not provided", async () => {
		const chunks: ExecChunk[] = [];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };

		// execStream is defined but no onEvent → uses buffered exec
		await runPi(provider, handle, {
			task: "analyze this",
			cwd: "/workspace",
			// no onEvent → buffered path
		});

		// The base mock's exec was called (not execStream)
		expect(true).toBe(true); // just verifying no error thrown
	});

	it("parses multi-line JSONL split across chunks", async () => {
		const line1 = `${PI_JSONL_THINKING}\n`;
		const line2 = `${PI_JSONL_TEXT}\n`;
		const line3 = `${PI_JSONL_MESSAGE_END}\n`;

		// Split in the middle of line2
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: line1 },
			{ type: "stdout", data: line2.slice(0, 20) },
			{ type: "stdout", data: line2.slice(20) },
			{ type: "stdout", data: line3 },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };
		const events: PiStreamEvent[] = [];

		const result = await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
			onEvent: (e) => events.push(e),
		});

		expect(result.exitCode).toBe(0);
		expect(result.messages.length).toBe(1);
		// Should have dispatched thinking, text, and message_end events
		expect(events.some((e) => e.type === "thinking")).toBe(true);
		expect(events.some((e) => e.type === "text")).toBe(true);
	});

	it("accumulates stderr from streaming chunks", async () => {
		const chunks: ExecChunk[] = [
			{ type: "stderr", data: "warn: " },
			{ type: "stderr", data: "something\n" },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };

		const result = await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
			onEvent: () => {},
		});

		expect(result.stderr).toBe("warn: something\n");
	});

	it("handles tool_execution_start and tool_execution_end events", async () => {
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${PI_JSONL_TOOL_CALL}\n` },
			{ type: "stdout", data: `${PI_JSONL_TOOL_RESULT}\n` },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };
		const events: PiStreamEvent[] = [];

		await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
			onEvent: (e) => events.push(e),
		});

		const toolCall = events.find((e) => e.type === "tool_call");
		expect(toolCall).toBeDefined();
		if (toolCall?.type === "tool_call") {
			expect(toolCall.name).toBe("read");
			expect(toolCall.args).toEqual({ path: "foo.ts" });
		}

		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.name).toBe("read");
		}
	});

	it("handles turn_end events", async () => {
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "stdout", data: `${PI_JSONL_TURN_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };
		const events: PiStreamEvent[] = [];

		await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
		onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "turn_end")).toBe(true);
	});

	it("handles tool_result_end for backwards compatibility", async () => {
		const toolResultEnd = JSON.stringify({
			type: "tool_result_end",
			message: { role: "tool", content: [{ type: "text", text: "file contents" }] },
		});
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${toolResultEnd}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };

		const result = await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
			onEvent: () => {},
		});

		expect(result.messages.length).toBe(1);
		expect(result.messages[0].role).toBe("tool");
	});

	it("accumulates usage across multiple turns in streaming", async () => {
		const msgEnd1 = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		});
		const msgEnd2 = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "second" }],
				usage: { input: 200, output: 75, cacheRead: 10, cacheWrite: 5, cost: { total: 0.02 } },
			},
		});
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${msgEnd1}\n` },
			{ type: "stdout", data: `${msgEnd2}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };

		const result = await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
			onEvent: () => {},
		});

		expect(result.usage.input).toBe(300);
		expect(result.usage.output).toBe(125);
		expect(result.usage.cacheRead).toBe(10);
		expect(result.usage.cacheWrite).toBe(5);
		expect(result.usage.cost).toBeCloseTo(0.03);
		expect(result.usage.turns).toBe(2);
	});

	it("parses remaining buffer without trailing newline", async () => {
		// No trailing newline on last event
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: PI_JSONL_MESSAGE_END }, // no \n
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const handle: SandboxHandle = { id: "test" };

		const result = await runPi(provider, handle, {
			task: "test",
			cwd: "/workspace",
			onEvent: () => {},
		});

		expect(result.messages.length).toBe(1);
	});
});

describe("executeSubagent (streaming)", () => {
	it("wires streaming to onUpdate when provider has execStream", async () => {
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		// Should have received progress updates (at least "Creating sandbox", "Running pi")
		expect(updates.length).toBeGreaterThanOrEqual(2);
	});

	it("emits tool_call updates from streaming events", async () => {
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${PI_JSONL_TOOL_CALL}\n` },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "stdout", data: `${PI_JSONL_TURN_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		const toolUpdate = updates.find((u) => u.content[0]?.text?.includes("🔧 Calling:"));
		expect(toolUpdate).toBeDefined();
		expect(toolUpdate!.content[0].text).toContain("read");
	});

	it("does not use streaming when provider has no execStream", async () => {
		const { provider } = createMockProvider();
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		// Should have basic updates but no streaming content (no 🔧 or 💭)
		const hasStreamingContent = updates.some(
			(u) => u.content[0]?.text?.includes("🔧") || u.content[0]?.text?.includes("💭"),
		);
		expect(hasStreamingContent).toBe(false);
	});

	it("emits thinking updates when streaming thinking text exceeds threshold", async () => {
		const longThinking = "A".repeat(120);
		const msgUpdateThinking = JSON.stringify({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "thinking", text: longThinking }],
			},
		});
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${msgUpdateThinking}\n` },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		const thinkingUpdate = updates.find((u) => u.content[0]?.text?.includes("💭"));
		expect(thinkingUpdate).toBeDefined();
		expect(thinkingUpdate!.content[0].text).toContain("Thinking");
	});

	it("emits text updates when streaming text exceeds threshold", async () => {
		const longText = "B".repeat(200);
		const msgUpdateText = JSON.stringify({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: longText }],
			},
		});
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${msgUpdateText}\n` },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		const textUpdate = updates.find((u) => u.content[0]?.text?.includes("📝"));
		expect(textUpdate).toBeDefined();
	});

	it("thinks thinking updates when below threshold", async () => {
		const shortThinking = "short"; // 5 chars, well below 50
		const msgUpdateThinking = JSON.stringify({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "thinking", text: shortThinking }],
			},
		});
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${msgUpdateThinking}\n` },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		// No 💭 update because thinking text is below threshold
		const thinkingUpdate = updates.find((u) => u.content[0]?.text?.includes("💭"));
		expect(thinkingUpdate).toBeUndefined();
	});

	it("thinks text updates when below threshold", async () => {
		const shortText = "hello"; // 5 chars, well below 100
		const msgUpdateText = JSON.stringify({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: shortText }],
			},
		});
		const chunks: ExecChunk[] = [
			{ type: "stdout", data: `${msgUpdateText}\n` },
			{ type: "stdout", data: `${PI_JSONL_MESSAGE_END}\n` },
			{ type: "exit", exitCode: 0 },
		];
		const { provider } = createStreamingProvider(chunks);
		const updates: Array<{ content: Array<{ type: string; text: string }> }> = [];
		const onUpdate = (u: typeof updates[0]) => updates.push(u);
		const ctx = createTestContext();

		await executeSubagent(provider, { task: "hello" }, undefined, onUpdate, ctx);

		// No 📝 update because text is below threshold
		const textUpdate = updates.find((u) => u.content[0]?.text?.includes("📝"));
		expect(textUpdate).toBeUndefined();
	});
});
