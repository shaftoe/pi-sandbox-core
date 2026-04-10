// ── Provider Error ─────────────────────────────────────────────────────

/** Thrown by initialize() when the provider can't be used. */
export class ProviderUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderUnavailableError";
	}
}

// ── Handle ─────────────────────────────────────────────────────────────

/** Opaque handle to a running sandbox. Backend-specific metadata via extras. */
export interface SandboxHandle {
	id: string; // vmId, sandboxName, podName, etc.
	[key: string]: unknown; // Provider-specific: vm, namespace, etc.
}

// ── Provider Interface ─────────────────────────────────────────────────

/**
 * Minimal interface for sandbox backends.
 *
 * Lifecycle:
 *   1. construct   → new XxxProvider(config)
 *   2. initialize  → verify + pre-bake resources (once per session)
 *   3. create      → spin up sandbox (per subagent)
 *   4. exec/writeFile → run commands, put files (per subagent)
 *   5. destroy     → tear down sandbox (per subagent)
 *   6. cleanup     → destroy all remaining sandboxes (once per session)
 */
export interface SandboxProvider<T extends SandboxHandle = SandboxHandle> {
	// ── Session lifecycle ──

	/**
	 * Verify the provider is available and prepare session-scoped resources.
	 * Called once at session start. Throws ProviderUnavailableError if the
	 * provider can't be used (missing CLI, bad credentials, etc.).
	 */
	initialize(): Promise<void>;

	/**
	 * Destroy all sandboxes created during this session and release
	 * provider-held resources. Called once at session shutdown.
	 * Best-effort — should not throw.
	 */
	cleanup(): Promise<void>;

	// ── Sandbox primitives (per-subagent) ──

	/** Create a sandbox and return a handle. */
	create(options: SandboxCreateOptions): Promise<T>;

	/** Destroy a sandbox. Best-effort. */
	destroy(handle: T): Promise<void>;

	/** Execute a command inside the sandbox. Returns raw result — does NOT throw on non-zero exit. */
	exec(handle: T, command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Stream the execution of a command inside the sandbox.
	 * Returns an async iterable that yields chunks as they arrive,
	 * enabling real-time output — TTY-level streaming.
	 *
	 * Optional: providers that don't support streaming fall back to exec()
	 * automatically.
	 */
	execStream?(
		handle: T,
		command: string,
		options?: ExecOptions,
	): AsyncIterable<ExecChunk>;

	/** Write a file inside the sandbox. */
	writeFile(handle: T, path: string, content: string): Promise<void>;

	// ── Optional hooks for provider-specific behavior ──

	/**
	 * Set up environment variables inside the sandbox.
	 * Called after create, before auth sync and workspace prep.
	 * Default: no-op.
	 */
	setupEnvironment?(handle: T, env: Record<string, string>): Promise<void>;

	/**
	 * Prepare the workspace inside the sandbox.
	 * Called after environment setup and auth sync.
	 * Default: git clone if gitUrl provided, mkdir -p otherwise.
	 */
	prepareWorkspace?(
		handle: T,
		params: WorkspaceParams,
	): Promise<WorkspaceResult>;
}

// ── Option Types ───────────────────────────────────────────────────────

export interface SandboxCreateOptions {
	workspacePath?: string;
	template?: string;
	idleTimeoutSeconds?: number;
	[key: string]: unknown;
}

export interface ExecOptions {
	workdir?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Streaming chunk from execStream().
 * Streams stdout/stderr as they arrive, followed by a final exit event.
 */
export type ExecChunk =
	| { type: "stdout"; data: string }
	| { type: "stderr"; data: string }
	| { type: "exit"; exitCode: number | null };

export interface WorkspaceParams {
	gitUrl?: string;
	branch?: string;
	workspacePath: string;
}

export type WorkspaceResult =
	| { ok: true }
	| { ok: false; content: string; exitCode: number | null };
