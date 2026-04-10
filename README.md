# pi-sandbox-core

A shared orchestration library for building [Pi](https://pi.dev) sandbox extensions — the glue between a sandbox backend and Pi's subagent execution model.

Every sandbox extension for pi follows the same pattern: create a sandbox, set up auth, prepare a workspace, run pi inside it, capture the diff, and tear it down. The only thing that changes between backends is *how you run commands in a box*. Everything else is identical. This library extracts that shared orchestration so you only implement the backend-specific parts.

## How it works

The library is split into two layers:

**Layer 1 — `SandboxProvider`** (you implement this). A minimal interface with 5 required methods that answer one question: *how do I run commands in your sandbox?* Create, exec, writeFile, destroy, cleanup. That's it.

**Layer 2 — `PiOrchestrator`** (this library provides). Built on top of Layer 1, these shared functions handle the full subagent pipeline — syncing auth, preparing the workspace, invoking pi, capturing diffs, and formatting results. Written once, reused by every provider.

```
Your Extension
  │
  │  initialize provider ──► register tool ──► cleanup on shutdown
  │                                │
  │            executeSubagent(provider, params, ...)
  │                                │
  ▼                                ▼
┌──────────────────────────────────────────────┐
│  PiOrchestrator (shared)                     │
│  ┌──────────────────────────────────────┐    │
│  │ 1. provider.create()                 │    │
│  │ 2. provider.setupEnvironment?()      │    │
│  │ 3. syncPiAuth()  +  setupGhAuth()    │    │
│  │ 4. provider.prepareWorkspace?()      │    │
│  │ 5. runPi() ──► provider.exec()       │    │
│  │ 6. captureDiff() ──► provider.exec() │    │
│  │ 7. provider.destroy()                │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

## Installation

```bash
bun add @alexanderfortin/pi-sandbox-core
```

## Quick start

### 1. Implement the provider (5 methods)

```typescript
import {
  type SandboxProvider,
  type SandboxHandle,
  type ExecResult,
  ProviderUnavailableError,
} from "@alexanderfortin/pi-sandbox-core";

class MyProvider implements SandboxProvider {
  async initialize() {
    // Verify your backend is available and authenticated.
    // Throw ProviderUnavailableError with a clear message if not.
  }

  async create(options) {
    // Spin up a sandbox. Return an opaque handle.
    return { id: "sandbox-abc123" } as SandboxHandle;
  }

  async destroy(handle: SandboxHandle) {
    // Tear down the sandbox. Best-effort — don't throw.
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    options?: { workdir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult> {
    // Execute a command inside the sandbox.
    // Return buffered { exitCode, stdout, stderr }. Do NOT throw on non-zero exit.
  }

  async writeFile(handle: SandboxHandle, path: string, content: string) {
    // Write a file inside the sandbox.
  }

  async cleanup() {
    // Destroy all sandboxes created during this session. Best-effort.
  }
}
```

### 2. Wire it into your extension

```typescript
import { executeSubagent, ProviderUnavailableError } from "@alexanderfortin/pi-sandbox-core";

export default function (pi: ExtensionAPI) {
  const provider = new MyProvider();

  pi.on("session_start", async (_event, ctx) => {
    try {
      await provider.initialize();
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        ctx.ui.notify(`[my-sandbox] ${error.message}`, "warning");
      }
      return;
    }
  });

  pi.registerTool({
    name: "my_sandbox",
    description: "Run a subagent in an isolated sandbox",
    parameters: { /* your tool schema */ },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeSubagent(provider, params, signal, onUpdate, {
        cwd: ctx.cwd,
        workspacePath: "/workspace",
        envPrefix: "MY_SANDBOX_ENV_",
        envExclude: new Set(),
        ui: ctx.ui,
      });
    },
  });

  pi.on("session_shutdown", async () => {
    await provider.cleanup();
  });
}
```

That's the whole extension. The orchestrator handles the 7-step pipeline.

## Streaming (optional)

If your sandbox backend supports real-time output (TTY, WebSocket, etc.), implement `execStream` to get live progress updates:

```typescript
class MyProvider implements SandboxProvider {
  // ... same 5 required methods ...

  async *execStream(handle: SandboxHandle, command: string, options?) {
    yield { type: "stdout", data: '{"type":"message_update",...}\n' };
    yield { type: "stderr", data: "warning\n" };
    yield { type: "exit", exitCode: 0 };
  }
}
```

The orchestrator detects `execStream` automatically and parses pi's JSON output incrementally, surfacing thinking, text, and tool calls via `onUpdate` in real-time. No extra wiring needed. Providers without `execStream` fall back to buffered execution — same result, just no live progress.

## Optional provider hooks

Two hooks let you customize behavior that varies between backends:

### `setupEnvironment(handle, env)`

Called after sandbox creation, before auth sync. Use it to inject environment variables in a backend-specific way (e.g., writing a wrapper script, setting container env vars).

Default: no-op. Environment variables are passed via the `env` option on each `exec` call instead.

### `prepareWorkspace(handle, params)`

Called after auth sync, before running pi. Use it for backend-specific workspace strategies (e.g., bind-mounting a host directory, pre-seeding a cache).

Default: `git clone` if a `gitUrl` is provided, otherwise `mkdir -p`.

Both return the same `WorkspaceResult`:

```typescript
type WorkspaceResult =
  | { ok: true }
  | { ok: false; content: string; exitCode: number | null };
```

## What this library handles for you

| Step | What happens | Function |
|------|-------------|----------|
| **Create** | Spin up a fresh sandbox | `provider.create()` |
| **Environment** | Forward env vars from host | `provider.setupEnvironment?()` |
| **Auth** | Sync pi credentials + gh CLI token | `syncPiAuth()` + `setupGhAuth()` |
| **Workspace** | Clone repo or create directory | `provider.prepareWorkspace?()` |
| **Execute** | Run pi in JSON mode inside the sandbox | `runPi()` |
| **Diff** | Capture git diff of any changes | `captureDiff()` |
| **Cleanup** | Destroy the sandbox | `provider.destroy()` |
| **Abort** | Handle cancellation gracefully | Built into `executeSubagent` |

## API reference

### `SandboxProvider` interface

| Method | Required | Description |
|--------|----------|-------------|
| `initialize()` | ✅ | Verify backend + prepare session resources. Throw `ProviderUnavailableError` to gracefully disable. |
| `create(options)` | ✅ | Spin up sandbox, return handle |
| `destroy(handle)` | ✅ | Tear down sandbox (best-effort) |
| `exec(handle, cmd, opts)` | ✅ | Execute command, return buffered `{ exitCode, stdout, stderr }` |
| `writeFile(handle, path, content)` | ✅ | Write a file inside the sandbox |
| `cleanup()` | ✅ | Destroy all session sandboxes (best-effort) |
| `execStream?(handle, cmd, opts)` | ❌ | Stream command output as `AsyncIterable<ExecChunk>` |
| `setupEnvironment?(handle, env)` | ❌ | Custom environment setup |
| `prepareWorkspace?(handle, params)` | ❌ | Custom workspace preparation |

### Orchestrator functions

| Function | Description |
|----------|-------------|
| `executeSubagent(provider, params, signal, onUpdate, ctx)` | Full 7-step pipeline |
| `runPi(provider, handle, options)` | Run `pi --mode json` (streaming-aware) |
| `syncPiAuth(provider, handle)` | Sync `~/.pi/agent/auth.json` into sandbox |
| `setupGhAuth(provider, handle, token)` | Authenticate `gh` CLI inside sandbox |
| `captureDiff(provider, handle, cwd)` | Capture git diff from sandbox workspace |
| `defaultPrepareWorkspace(provider, handle, params)` | Default workspace prep (git clone or mkdir) |

### Helpers

| Function | Description |
|----------|-------------|
| `parseJsonlOutput(stdout, stderr, exitCode)` | Parse buffered JSONL into `PiRunResult` |
| `buildPiArgs(options)` | Build pi CLI argument array |
| `escapeShellArg(value)` | Shell-escape a value using single quotes |
| `parseGitStatus(output)` | Parse `git status --porcelain` into file list |
| `collectForwardedEnv(prefix, exclude)` | Collect env vars to forward from host |
| `buildSystemPrompt(cwd, userPrompt?)` | Build system prompt with project context |
| `resolveModel(params, ctx)` | Resolve model from params or current context |
| `formatSuccessResult(id, result, diff)` | Format successful execution result |
| `formatCancelledResult(id)` | Format cancelled execution result |
| `formatFailureResult(id, failure)` | Format failed workspace preparation result |

### Key types

```typescript
// Opaque handle — your provider decides what goes in here
interface SandboxHandle {
  id: string;
  [key: string]: unknown;
}

// Streaming chunks from execStream()
type ExecChunk =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number | null };

// Parsed events from pi's JSON streaming output
type PiStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "message_end"; message: PiMessage }
  | { type: "turn_end" };

// Result details returned to the LLM
interface SubagentDetails {
  sandboxId: string;
  exitCode: number | null;
  usage: UsageStats;
  diff?: string;
  changedFiles?: string[];
  stderr: string;
  cancelled?: boolean;
}
```

## Development

```bash
bun install          # Install dependencies
bun test             # Run tests (86 passing, 100% coverage)
bun run build        # Build for distribution
bun run validate     # Type-check + lint + format check
```

## License

MIT
