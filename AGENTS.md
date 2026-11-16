# AGENTS.md — working on `opencode-lsp`

Agent-facing operating notes: how to build, typecheck, test and how the running
OpenCode service hot-reloads the plugin. Read `README.md` for product docs.

## What this is

`opencode-lsp` is a self-contained OpenCode (V2) plugin that restores the LSP
behaviour V2 dropped:

- **Tools** — navigation under the `lsp` namespace (`lsp.definition`,
  `lsp.references`, `lsp.hover`, `lsp.symbols`, `lsp.implementations`,
  `lsp.calls`). Defined in `src/tools.ts`, registered in `index.ts`.
- **Diagnostics** — `execute.after` hook (`src/hook.ts`) appends error
  diagnostics to `write`/`edit`/`patch`/`apply_patch` results and sets
  `metadata.diagnostics`.
- **Runtime** — JSON-RPC over stdio (`src/client.ts`), one process per
  (server, root) in `src/pool.ts`; pull requests live in the pool, the push
  store and quiet-period wait in `src/diagnostics.ts`.

There is no GUI, no database and no external CLI.

## Repo layout

```
index.ts                 Plugin.define: settings → pool → tools + hook → cleanup
src/catalog.ts           built-in servers (extensions, root rule, command), languageId map
src/settings.ts          config reader (JSONC, {env:}/{file:}, precedence, lsp:true/false)
src/jsonc.ts             JSONC parser (comments, trailing commas, BOM)
src/protocol.ts          Content-Length framing + limits
src/client.ts            JSON-RPC stdio client
src/pool.ts              server pool, roots, document sync, pull diagnostics, navigation
src/watcher.ts           recursive project watcher → workspace/didChangeWatchedFiles
src/sync.ts              per-URI queue, document versions, abortable shared work
src/diagnostics.ts       push store, quiet-period wait, merge of other-file reports
src/paths.ts             project boundary, symlink-safe reads, tool path resolution
src/format.ts            locations/hover/symbols/calls/<diagnostics>
src/tools.ts             the six navigation tools (zod)
src/hook.ts              execute.after diagnostics + read warm-up
test/                    bun tests + scripted fake server
```

## Commands

```bash
bun run typecheck     # tsc --noEmit (types resolve from the parent node_modules)
bun test test         # suite with the fake server; no real LSP needed
```

From the parent repo, `bun run typecheck` and `bun test` also cover this
plugin.

`fs.watch` needs inotify instances, which containers and desktop sandboxes can
exhaust (`EMFILE`/`ENOSPC`, or `EINVAL` where recursive watching is rejected).
The watcher degrades gracefully at runtime, so the tests that need a live
watcher skip with the reason instead of failing; `ignored()` is covered by a
pure test that runs everywhere. Do not turn that skip into a pass or drop the
pure test to make a constrained environment green.

## Hard rules

- **Only paths inside the project are read or sent to a server.** Resolve
  symlinks; never relax this to reach dependencies outside the root.
- **Never fail a tool because of LSP.** The diagnostics hook swallows errors and
  logs them under `debug`; navigation returns a clear message instead.
- **Do not spawn a server per file.** One process per (server id, detected
  root), reused until idle shutdown or plugin unload.
- **Document versions are monotonic and per URI.** Sync operations for one file
  are serialized; stale reports must be discarded, never merged.
- **External changes are announced, not silently synced.** The watcher forwards
  `workspace/didChangeWatchedFiles` and re-reads open documents as `didChange`;
  do not add a second sync path or a filesystem poller.
- **The plugin reads config files itself** because V2 does not expose the merged
  config to plugins. Keep the source order in sync with OpenCode.
- **No runtime dependencies beyond zod** (tool schemas). Node built-ins only.
- **Tool descriptions fit the Code Mode catalog budget.** The catalog truncates
  a description around 119 characters, so keep it ≤110 with the load-bearing
  sentence first; parameter descriptions stay ≤6 words. `test/tools.test.ts`
  enforces both.
- Code and log messages are English; there is no user-facing UI copy here.

## Git workflow

The repo is a submodule of `opencode-tools`. Commit here first, push
`origin main`, then bump the pointer in the parent. Never commit parent and
submodule changes in one shot from the parent.
