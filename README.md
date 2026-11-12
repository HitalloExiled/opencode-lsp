# opencode-lsp

LSP support for OpenCode V2.

OpenCode V2 keeps the `lsp` config block but ships no LSP runtime: no language
server starts, no diagnostics reach the model and there is no `lsp` tool. This
plugin restores both behaviours for a local V2 install:

- **Navigation** — `tools.lsp.definition`, `references`, `hover`, `symbols`,
  `implementations`, `calls` (regular sessions: `lsp_definition`, …).
- **Diagnostics** — error-level problems from the language server are appended
  to the result of `write`, `edit`, `patch` and `apply_patch`, and exposed as
  `metadata.diagnostics` for the terminal UI.

It is a local plugin: OpenCode loads `index.ts` directly, with no build step.

## Install

```bash
git clone git@github.com:HitalloExiled/opencode-lsp.git "$HOME/opencode-lsp"
npm ci --prefix "$HOME/opencode-lsp" --ignore-scripts
```

Add the clone to `plugins` in `~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/opencode-lsp"]
}
```

Project-local discovery also works: clone into `.opencode/plugins/opencode-lsp`
and omit the `plugins` entry. Language servers are **not** installed by the
plugin; install them yourself and make sure the command is on the OpenCode
service's `PATH` (or use an absolute path).

## Configuration

The plugin reads the V1-shaped `lsp` block from the OpenCode config files, in
the same order OpenCode does (global, `OPENCODE_CONFIG`, project ancestors,
ancestor `.opencode` files, `OPENCODE_CONFIG_CONTENT`), with plugin `options`
taking final precedence:

```jsonc
{
  "lsp": {
    "csharp": { "command": ["/home/you/.dotnet/tools/csharp-ls"] },
    "typescript": { "command": ["typescript-language-server", "--stdio"] },
    "pyright": { "command": ["pyright-langserver", "--stdio"] }
  }
}
```

`lsp: true` enables every built-in server whose default command is on `PATH`;
`lsp: false` disables everything. Built-in IDs supply default extensions, root
rules and commands, so `{ "rust": {} }` is enough when `rust-analyzer` is
installed. Custom IDs must declare `extensions` and `command`.

Optional settings use the object form of the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/opencode-lsp",
      "options": {
        "diagnostics": true,
        "severities": ["error"],
        "diagnosticsTimeoutMs": 5000,
        "initializeTimeoutMs": 45000,
        "requestTimeoutMs": 15000,
        "warmupTimeoutMs": 6000,
        "idleShutdownMs": 600000,
        "maxErrorsPerFile": 20,
        "maxOtherFiles": 5,
        "maxWorkspaceSymbols": 20,
        "debug": false
      }
    }
  ]
}
```

## Limits

- Only errors are appended by default (`severities` accepts `error`, `warning`,
  `info`, `hint`).
- Errors are capped per file (20) and for other files (5); workspace symbols are
  capped at 20.
- All paths must resolve inside the project directory, symlinks included.
- One server process per (server, detected root); servers start lazily, warm up
  on `read`, and shut down after `idleShutdownMs` without use.
- Changes made outside the tools (scripts, git, formatters) are forwarded to
  running servers as `workspace/didChangeWatchedFiles`. A server that ignores
  them can stay stale until the file is read or edited; for bulk rewrites the
  compiler remains the source of truth.
- A server that fails to start, or sends a malformed protocol message, stays
  disabled until the plugin reloads.
- Servers are **not** sandboxed: they inherit the OpenCode environment and OS
  privileges. Only configure commands you trust.
- No formatter, rename, code actions or TCP transport.

## Tests

```bash
bun test test
```

The suite uses a scripted stdio language server; no real server is required.

## Credit

The behaviour and configuration surface follow OpenCode V1's LSP support. This
is an independent implementation; `christensenjairus/opencode-v2-lsp-support`
(MIT) was the first community port and informed the feature list.
