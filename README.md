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

## Installing language servers

The plugin never installs or downloads a server. Install it yourself and make
sure the command is on the OpenCode service's `PATH` — `lsp: true` only enables
built-ins whose default command resolves there, and `/reload` applies a new
install. A project-local binary is not found by `lsp: true`; point `command` at
it explicitly:

```jsonc
"lsp": {
  "typescript": {
    "command": ["npx", "--no-install", "typescript-language-server", "--stdio"]
  }
}
```

`npm i -g` installs into the active Node prefix, which must be the one the
service sees. Homebrew is only one option; use your distro package when it
exists. Every server below speaks LSP over **stdio**, which is what the plugin
supports.

### JavaScript / TypeScript / web

| ID | Binary | Install |
|---|---|---|
| `typescript` | `typescript-language-server` | `npm i -g typescript-language-server typescript` |
| `deno` | `deno` | install Deno from <https://deno.land> (needs a `deno.json` in the project) |
| `eslint` | `vscode-eslint-language-server` | `npm i -g vscode-langservers-extracted` (needs `eslint` and a config in the project) |
| `biome` | `biome` | `npm i -g @biomejs/biome` |
| `vue` | `vue-language-server` | `npm i -g @vue/language-server` |
| `svelte` | `svelteserver` | `npm i -g svelte-language-server` |
| `astro` | `astro-ls` | `npm i -g @astrojs/language-server` |

The `eslint` server needs `eslint` (9 or 10) and a flat config in the project
(`eslint.config.js`; add `typescript-eslint` to lint TypeScript). The plugin
already supplies the VS Code defaults the server requires (`nodePath`,
`problems`, flat config) and uses `validate: "probe"`, so it only lints files a
project config covers. A server `initialization` object deep-merges over those
defaults. The server asks for the whole configuration (section `""`), so
`initialization` is the flat settings object — not `{ "eslint": { ... } }`:

```jsonc
"eslint": {
  "command": ["vscode-eslint-language-server", "--stdio"],
  "initialization": { "validate": "on", "options": { "rulePaths": ["./rules"] } }
}
```

`typescript-language-server` drives the classic `tsserver.js`. TypeScript 7.0
and 7.1 do not ship it; 7.1's new API (`typescript/sync`, `typescript/async`,
`typescript/ast`, `typescript/fs`, …) is a programmatic compiler API, not the
tsserver protocol, so it is not usable by `typescript-language-server`. If the
workspace or the global `typescript` is 7.x, the server exits with "provides no
tsserver.js". Install TypeScript 5.x/6.x globally (`npm i -g typescript@6`)
or in the project; the server falls back to a valid global install when the
workspace one is unusable. Using 7.1's native LSP needs a different client.

### .NET

| ID | Binary | Install |
|---|---|---|
| `csharp` | `csharp-ls` | `dotnet tool install --global csharp-ls` |
| `fsharp` | `fsautocomplete` | `dotnet tool install --global fsautocomplete` |

Both need the .NET SDK; the tool prefix (`~/.dotnet/tools`) must be on `PATH`.

### JVM

| ID | Binary | Install |
|---|---|---|
| `jdtls` | `jdtls` | `brew install jdtls` or the Eclipse JDT LS release |
| `kotlin-ls` | `kotlin-language-server` | `brew install kotlin-language-server` or the fwcd release |

### Systems

| ID | Binary | Install |
|---|---|---|
| `clangd` | `clangd` | `dnf install clang-tools-extra` / `apt install clangd` / `brew install llvm` |
| `rust` | `rust-analyzer` | `rustup component add rust-analyzer` |
| `gopls` | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| `zls` | `zls` | `brew install zls` or the zigtools release |
| `nixd` | `nixd` | `nix profile install nixpkgs#nixd` |
| `sourcekit-lsp` | `sourcekit-lsp` | ships with the Swift toolchain (Xcode or swift.org) |

`clangd` works best with a `compile_commands.json`; `rust` is widened to the
enclosing Cargo workspace.

### Scripting

| ID | Binary | Install |
|---|---|---|
| `pyright` | `pyright-langserver` | `npm i -g pyright` |
| `ruby-lsp` | `ruby-lsp` | `gem install ruby-lsp` |
| `php` | `intelephense` | `npm i -g intelephense` (premium features need a licence) |
| `lua-ls` | `lua-language-server` | `brew install lua-language-server` or the release |
| `bash` | `bash-language-server` | `npm i -g bash-language-server` |
| `dart` | `dart` | Dart SDK (`dart language-server`) or Flutter |
| `elixir-ls` | `elixir-ls` | `brew install elixir-ls` or the elixir-lsp release |
| `clojure-lsp` | `clojure-lsp` | `brew install clojure-lsp/brew/clojure-lsp-native` or the release |
| `haskell-language-server` | `haskell-language-server-wrapper` | `ghcup install hls` |
| `ocaml-lsp` | `ocamllsp` | `opam install ocaml-lsp-server` |
| `gleam` | `gleam` | install Gleam from <https://gleam.run> (ships `gleam lsp`) |

### Infrastructure / docs / data

| ID | Binary | Install |
|---|---|---|
| `yaml-ls` | `yaml-language-server` | `npm i -g yaml-language-server` |
| `dockerfile` | `docker-langserver` | `npm i -g dockerfile-language-server-nodejs` |
| `terraform` | `terraform-ls` | `brew install terraform-ls` or the HashiCorp release |
| `texlab` | `texlab` | `cargo install texlab` or `brew install texlab` |
| `tinymist` | `tinymist` | `cargo install tinymist` or the release |
| `prisma` | `prisma-language-server` | `npm i -g @prisma/language-server` |

Anything else (Razor, Scala, Perl, R, Julia, PowerShell, SQL, …) works as a
custom entry: declare `command` and `extensions`, and the server runs at the
project directory. Custom IDs have no root rule, so put the server's own root
configuration in the project.

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
