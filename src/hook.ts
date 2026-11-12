import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { record, type Diagnostic } from "./client.js";
import { diagnosticsReport, displayPath, selectedDiagnostics } from "./format.js";
import { insideProject, projectPath } from "./paths.js";
import type { LspPool } from "./pool.js";
import type { Settings } from "./settings.js";

const MUTATING_TOOLS = new Set(["write", "edit", "patch", "apply_patch"]);

interface ToolResult {
  output?: unknown;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AfterToolEvent {
  readonly tool: string;
  readonly status: string;
  readonly input: unknown;
  result?: ToolResult;
}

/**
 * After `write`, `edit`, `patch` or `apply_patch`, send each changed file to its
 * servers and append their errors to the result, as OpenCode V1 did. `read`
 * starts the file's servers in the background so the first edit does not wait
 * for a cold start. Deleted and moved-away files are closed so servers stop
 * analyzing their old contents.
 *
 * The hook never fails the tool: every LSP problem is swallowed and, at most,
 * logged by the pool under `debug`.
 */
export function createAfterToolHook(pool: LspPool, root: string, settings: Settings) {
  return async (event: AfterToolEvent): Promise<void> => {
    if (event.status !== "completed" || !event.result) return;
    if (event.tool === "read") {
      warm(pool, root, event.input);
      return;
    }
    if (!MUTATING_TOOLS.has(event.tool)) return;
    const { changed, deleted } = touchedFiles(event, root);
    await Promise.all(deleted.map((file) => pool.close(file).catch(() => undefined)));
    if (settings.diagnostics) await report(pool, root, settings, event, changed);
  };
}

/** Files with a server that resolve inside the project. */
async function checkable(pool: LspPool, root: string, files: string[]): Promise<string[]> {
  const inside = await Promise.all(
    files.map((file) => pool.serversFor(file).length > 0 && insideProject(root, file)),
  );
  return files.filter((_, index) => inside[index]);
}

function warm(pool: LspPool, root: string, input: unknown): void {
  const value = record(input);
  if (!value || typeof value.path !== "string") return;
  const file = projectPath(root, value.path);
  void checkable(pool, root, [file])
    .then(async ([inside]) => {
      if (inside && (await stat(inside)).isFile()) await pool.sync(inside);
    })
    .catch(() => undefined);
}

async function report(
  pool: LspPool,
  root: string,
  settings: Settings,
  event: AfterToolEvent,
  changed: string[],
): Promise<void> {
  const files = await checkable(pool, root, changed);
  if (files.length === 0) return;

  const sections: string[] = [];
  const shown: Record<string, Diagnostic[]> = {};
  const others = new Map<string, Diagnostic[]>();
  const results = await Promise.all(files.map((file) => pool.diagnostics(file)));
  for (const [index, file] of files.entries()) {
    const result = results[index]!;
    for (const [uri, diagnostics] of result.others) {
      others.set(uri, [...(others.get(uri) ?? []), ...diagnostics]);
    }
    const selected = selectedDiagnostics(result.file ?? [], settings.severities);
    if (selected.length === 0) continue;
    const where =
      event.tool === "patch" || event.tool === "apply_patch"
        ? displayPath(file, root)
        : "this file";
    sections.push(
      `LSP errors detected in ${where}, please fix:\n${diagnosticsReport(
        file,
        selected,
        settings.maxErrorsPerFile,
        settings.severities,
      )}`,
    );
    shown[file] = selected;
    shown[displayPath(file, root)] = selected;
  }
  const input = record(event.input);
  if (input && typeof input.path === "string") {
    const errors = shown[projectPath(root, input.path)];
    if (errors) shown[input.path] = errors;
  }

  const elsewhere: string[] = [];
  for (const [uri, diagnostics] of others) {
    if (elsewhere.length >= settings.maxOtherFiles) break;
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      continue; // untitled: and other non-file URIs have no path to report
    }
    if (files.includes(file)) continue;
    const block = diagnosticsReport(
      file,
      diagnostics,
      settings.maxErrorsPerFile,
      settings.severities,
    );
    if (block && (await insideProject(root, file))) elsewhere.push(block);
  }
  if (elsewhere.length > 0) {
    sections.push(`LSP errors detected in other files:\n${elsewhere.join("\n")}`);
  }
  if (sections.length === 0) return;

  // OpenCode's terminal UI shows `metadata.diagnostics[input.path]` under the edit.
  const existing = event.result!.metadata?.diagnostics;
  event.result!.metadata = {
    ...event.result!.metadata,
    diagnostics: { ...(record(existing) ?? {}), ...shown },
  };
  append(event.result!, `\n\n${sections.join("\n\n")}`);
}

/** Files the tool created or changed, and files it deleted, as absolute paths. */
export function touchedFiles(
  event: Pick<AfterToolEvent, "input" | "result">,
  root: string,
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  const add = (list: string[], value: unknown) => {
    if (typeof value !== "string" || value === "") return;
    const file = projectPath(root, value);
    if (!list.includes(file)) list.push(file);
  };

  const output = record(event.result?.output);
  if (output) {
    // write: { target }; patch: { applied: [{ type, target }] }
    add(changed, output.target);
    if (Array.isArray(output.applied)) {
      for (const item of output.applied) {
        const entry = record(item);
        if (entry) add(entry.type === "delete" ? deleted : changed, entry.target);
      }
    }
    if (Array.isArray(output.files)) {
      for (const item of output.files) {
        const entry = record(item);
        if (entry) add(entry.status === "deleted" ? deleted : changed, entry.file);
      }
    }
  }

  const input = record(event.input);
  if (input) {
    add(changed, input.path);
    // A moved file's result names only its destination, so the source comes from the patch text.
    if (typeof input.patchText === "string") {
      for (const [, source] of input.patchText.matchAll(
        /^\*\*\* Update File: (.+?)\r?\n\*\*\* Move to: /gm,
      )) {
        if (source && !changed.includes(projectPath(root, source.trim()))) {
          add(deleted, source.trim());
        }
      }
    }
  }
  return { changed: changed.filter((file) => !deleted.includes(file)), deleted };
}

function append(result: ToolResult, text: string): void {
  if (typeof result.content === "string") result.content += text;
  else if (Array.isArray(result.content)) result.content = [...result.content, { type: "text", text }];
  else if (typeof result.output === "string") result.output += text;
  else result.content = text.trimStart();
}
