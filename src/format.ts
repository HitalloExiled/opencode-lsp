import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { record, type Diagnostic } from "./client.js";

const SEVERITY: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" };

// LSP SymbolKind, 1-based.
const SYMBOL_KINDS = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
];

/** Keep only the severities the user asked for; a missing severity counts as an error. */
export function selectedDiagnostics(
  diagnostics: readonly Diagnostic[],
  severities: readonly number[],
): Diagnostic[] {
  return diagnostics.filter((diagnostic) => severities.includes(diagnostic.severity ?? 1));
}

/** OpenCode V1's diagnostics block, capped per file. Empty when there is nothing to report. */
export function diagnosticsReport(
  file: string,
  diagnostics: readonly Diagnostic[],
  max: number,
  severities: readonly number[] = [1],
): string {
  const selected = selectedDiagnostics(diagnostics, severities);
  if (selected.length === 0) return "";
  const lines = selected.slice(0, max).map((diagnostic) => {
    const severity = SEVERITY[diagnostic.severity ?? 1] ?? "ERROR";
    const { line, character } = start(diagnostic.range);
    return `${severity} [${line}:${character}] ${diagnostic.message}`;
  });
  const more = selected.length - max;
  if (more > 0) lines.push(`... and ${more} more`);
  return `<diagnostics file="${file}">\n${lines.join("\n")}\n</diagnostics>`;
}

export function displayPath(uriOrPath: string, root: string): string {
  let file = uriOrPath;
  if (uriOrPath.startsWith("file:")) {
    try {
      file = fileURLToPath(uriOrPath);
    } catch {
      return uriOrPath;
    }
  }
  const rel = relative(root, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

export function formatHover(results: readonly unknown[]): string {
  const sections = results.flatMap((result) => {
    const contents = record(result)?.contents;
    if (contents === undefined || contents === null) return [];
    const text = (Array.isArray(contents) ? contents.map(markup) : [markup(contents)])
      .filter(Boolean)
      .join("\n\n");
    return text ? [text] : [];
  });
  return sections.map((section) => section.trim()).join("\n\n---\n\n");
}

function markup(value: unknown): string {
  if (typeof value === "string") return value;
  const item = record(value);
  if (item && typeof item.value === "string") {
    return typeof item.language === "string"
      ? `\`\`\`${item.language}\n${item.value}\n\`\`\``
      : item.value;
  }
  return "";
}

/** Location, LocationLink and SymbolInformation results as `path:line:character`. */
export function formatLocations(results: readonly unknown[], root: string): string[] {
  const lines: string[] = [];
  for (const item of results) {
    const value = record(item);
    if (!value) continue;
    if (typeof value.targetUri === "string") {
      lines.push(location(value.targetUri, value.targetSelectionRange ?? value.targetRange, root));
    } else if (typeof value.uri === "string") {
      lines.push(location(value.uri, value.range, root));
    }
  }
  return [...new Set(lines)];
}

export function formatDocumentSymbols(results: readonly unknown[], root: string): string[] {
  const lines: string[] = [];
  const walk = (items: readonly unknown[], depth: number) => {
    for (const item of items) {
      const value = record(item);
      if (!value || typeof value.name !== "string") continue;
      const indent = "  ".repeat(depth);
      const detail = typeof value.detail === "string" && value.detail ? ` ${value.detail}` : "";
      if (record(value.location)) {
        // SymbolInformation: flat, with a container name instead of children.
        const container =
          typeof value.containerName === "string" && value.containerName
            ? ` in ${value.containerName}`
            : "";
        lines.push(
          `${indent}${value.name} (${kind(value.kind)})${container} ${location(String(value.location.uri), value.location.range, root)}`,
        );
        continue;
      }
      const { line, character } = start(value.selectionRange ?? value.range);
      lines.push(`${indent}${value.name}${detail} (${kind(value.kind)}) ${line}:${character}`);
      if (Array.isArray(value.children)) walk(value.children, depth + 1);
    }
  };
  walk(results, 0);
  return lines;
}

export function formatWorkspaceSymbols(
  results: readonly unknown[],
  root: string,
  max: number,
): string[] {
  const lines = results.flatMap((item) => {
    const value = record(item);
    if (!value || typeof value.name !== "string" || !record(value.location)) return [];
    const container =
      typeof value.containerName === "string" && value.containerName
        ? ` in ${value.containerName}`
        : "";
    const where =
      typeof value.location.uri === "string"
        ? location(value.location.uri, value.location.range, root)
        : "";
    return [`${value.name} (${kind(value.kind)})${container} ${where}`.trimEnd()];
  });
  // Servers such as gopls return a hundred matches from the standard library.
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `... and ${lines.length - max} more; use a more specific query`];
}

export function formatCallItem(item: unknown, root: string): string | undefined {
  const value = record(item);
  if (!value || typeof value.name !== "string" || typeof value.uri !== "string") return undefined;
  const detail = typeof value.detail === "string" && value.detail ? ` ${value.detail}` : "";
  return `${value.name}${detail} (${kind(value.kind)}) ${location(value.uri, value.selectionRange ?? value.range, root)}`;
}

/** An incoming or outgoing call: the other function, then where the calls happen. */
export function formatCall(
  call: unknown,
  incoming: boolean,
  file: string,
  root: string,
): string | undefined {
  const value = record(call);
  if (!value) return undefined;
  const item = incoming ? value.from : value.to;
  const line = formatCallItem(item, root);
  const from = record(item);
  if (!line || !from || !Array.isArray(value.fromRanges) || value.fromRanges.length === 0) {
    return line;
  }
  // The ranges are in the calling function's file: the other item for incoming
  // calls, the prepared item's file for outgoing ones.
  const caller = incoming ? String(from.uri) : file;
  return `${line} called at ${value.fromRanges
    .map((range) => location(caller, range, root))
    .join(", ")}`;
}

function location(uri: string, range: unknown, root: string): string {
  const { line, character } = start(range);
  return `${displayPath(uri, root)}:${line}:${character}`;
}

/** A range's start, 1-based. */
function start(range: unknown): { line: number; character: number } {
  const position = record(record(range)?.start) ?? {};
  const line = typeof position.line === "number" ? position.line : 0;
  const character = typeof position.character === "number" ? position.character : 0;
  return { line: line + 1, character: character + 1 };
}

function kind(value: unknown): string {
  return (typeof value === "number" && SYMBOL_KINDS[value]) || "symbol";
}
