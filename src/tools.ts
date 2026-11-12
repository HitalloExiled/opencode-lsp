import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { record, requestWithRetry, type LspClient } from "./client.js";
import {
  displayPath,
  formatCall,
  formatCallItem,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatWorkspaceSymbols,
} from "./format.js";
import { resolveProjectFile } from "./paths.js";
import type { LspPool } from "./pool.js";
import type { Settings } from "./settings.js";

type ToolResult = { content: string; metadata?: Record<string, unknown> };

const path = z
  .string()
  .min(1)
  .describe("Absolute or project-relative path to the file.");
const line = z.number().int().min(1).describe("1-based line, as shown in editors.");
const character = z
  .number()
  .int()
  .min(1)
  .describe("1-based UTF-16 character offset, as shown in editors.");

const positionInput = z.object({ path, line, character });
const symbolsInput = z.object({
  path,
  scope: z
    .enum(["document", "workspace"])
    .default("document")
    .describe("'document' lists this file's symbols; 'workspace' searches the project."),
  query: z.string().optional().describe("Filter for scope=workspace; empty requests all symbols."),
});
const callsInput = z.object({
  path,
  line,
  character,
  direction: z
    .enum(["prepare", "incoming", "outgoing"])
    .default("incoming")
    .describe("'prepare' lists the callable at the position; 'incoming'/'outgoing' follow it."),
});

interface PositionInput {
  path: string;
  line: number;
  character: number;
}

function position(input: PositionInput) {
  return { line: input.line - 1, character: input.character - 1 };
}

async function navigate(
  pool: LspPool,
  root: string,
  input: PositionInput,
  capability: string,
  send: (client: LspClient, file: string, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<{ file: string; results: unknown[] }> {
  const file = await resolveProjectFile(root, input.path);
  const results = await pool.request(file, capability, (client) => send(client, file, signal), signal);
  return { file, results };
}

function output(operation: string, file: string, root: string, lines: string[]): ToolResult {
  return {
    content: lines.length > 0 ? lines.join("\n") : `No results found for ${operation}`,
    metadata: { operation, path: displayPath(file, root) },
  };
}

async function guard(operation: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return {
      content: `LSP error: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { operation, error: true },
    };
  }
}

function definitionTool(pool: LspPool, root: string) {
  return {
    name: "definition",
    description: "Find where a symbol is defined, using the language server.",
    input: positionInput,
    options: { namespace: "lsp", pinned: true, permission: "lsp" },
    async execute(input: z.infer<typeof positionInput>, ctx: ToolContext): Promise<ToolResult> {
      return guard("goToDefinition", async () => {
        const { file, results } = await navigate(
          pool,
          root,
          input,
          "definitionProvider",
          (client, current, signal) =>
            requestWithRetry(
              client,
              "textDocument/definition",
              { textDocument: { uri: pathToFileURL(current).href }, position: position(input) },
              signal,
            ),
          ctx.signal,
        );
        return output("goToDefinition", file, root, formatLocations(results, root));
      });
    },
  };
}

function implementationsTool(pool: LspPool, root: string) {
  return {
    name: "implementations",
    description: "Find implementations of an interface or abstract method.",
    input: positionInput,
    options: { namespace: "lsp", permission: "lsp" },
    async execute(input: z.infer<typeof positionInput>, ctx: ToolContext): Promise<ToolResult> {
      return guard("goToImplementation", async () => {
        const { file, results } = await navigate(
          pool,
          root,
          input,
          "implementationProvider",
          (client, current, signal) =>
            requestWithRetry(
              client,
              "textDocument/implementation",
              { textDocument: { uri: pathToFileURL(current).href }, position: position(input) },
              signal,
            ),
          ctx.signal,
        );
        return output("goToImplementation", file, root, formatLocations(results, root));
      });
    },
  };
}

function referencesTool(pool: LspPool, root: string) {
  return {
    name: "references",
    description: "Find all references to a symbol, including its declaration.",
    input: positionInput,
    options: { namespace: "lsp", pinned: true, permission: "lsp" },
    async execute(input: z.infer<typeof positionInput>, ctx: ToolContext): Promise<ToolResult> {
      return guard("findReferences", async () => {
        const { file, results } = await navigate(
          pool,
          root,
          input,
          "referencesProvider",
          (client, current, signal) =>
            requestWithRetry(
              client,
              "textDocument/references",
              {
                textDocument: { uri: pathToFileURL(current).href },
                position: position(input),
                context: { includeDeclaration: true },
              },
              signal,
            ),
          ctx.signal,
        );
        return output("findReferences", file, root, formatLocations(results, root));
      });
    },
  };
}

function hoverTool(pool: LspPool, root: string) {
  return {
    name: "hover",
    description: "Get hover information (documentation, type) for a symbol.",
    input: positionInput,
    options: { namespace: "lsp", pinned: true, permission: "lsp" },
    async execute(input: z.infer<typeof positionInput>, ctx: ToolContext): Promise<ToolResult> {
      return guard("hover", async () => {
        const { file, results } = await navigate(
          pool,
          root,
          input,
          "hoverProvider",
          (client, current, signal) =>
            requestWithRetry(
              client,
              "textDocument/hover",
              { textDocument: { uri: pathToFileURL(current).href }, position: position(input) },
              signal,
            ),
          ctx.signal,
        );
        const text = formatHover(results);
        return output("hover", file, root, text ? [text] : []);
      });
    },
  };
}

function symbolsTool(pool: LspPool, root: string, settings: Settings) {
  return {
    name: "symbols",
    description:
      "List symbols in a document, or project-wide symbols matching a query.",
    input: symbolsInput,
    options: { namespace: "lsp", pinned: true, permission: "lsp" },
    async execute(input: z.infer<typeof symbolsInput>, ctx: ToolContext): Promise<ToolResult> {
      return guard("symbols", async () => {
        const file = await resolveProjectFile(root, input.path);
        const uri = pathToFileURL(file).href;
        if (input.scope === "workspace") {
          const results = await pool.request(
            file,
            "workspaceSymbolProvider",
            (client) =>
              requestWithRetry(client, "workspace/symbol", { query: input.query ?? "" }, ctx.signal),
            ctx.signal,
          );
          return output(
            "workspaceSymbol",
            file,
            root,
            formatWorkspaceSymbols(results, root, settings.maxWorkspaceSymbols),
          );
        }
        const results = await pool.request(
          file,
          "documentSymbolProvider",
          (client) =>
            requestWithRetry(client, "textDocument/documentSymbol", { textDocument: { uri } }, ctx.signal),
          ctx.signal,
        );
        return output("documentSymbol", file, root, formatDocumentSymbols(results, root));
      });
    },
  };
}

function callsTool(pool: LspPool, root: string) {
  return {
    name: "calls",
    description:
      "Inspect the call hierarchy at a position: the callable itself, its callers or its callees.",
    input: callsInput,
    options: { namespace: "lsp", permission: "lsp" },
    async execute(input: z.infer<typeof callsInput>, ctx: ToolContext): Promise<ToolResult> {
      return guard("callHierarchy", async () => {
        const file = await resolveProjectFile(root, input.path);
        const uri = pathToFileURL(file).href;
        const lines = await pool.request(
          file,
          "callHierarchyProvider",
          async (client) => {
            const items = await requestWithRetry(
              client,
              "textDocument/prepareCallHierarchy",
              { textDocument: { uri }, position: position(input) },
              ctx.signal,
            );
            if (!Array.isArray(items)) return [];
            if (input.direction === "prepare") {
              return items.flatMap((item) => formatCallItem(item, root) ?? []);
            }
            const method =
              input.direction === "incoming"
                ? "callHierarchy/incomingCalls"
                : "callHierarchy/outgoingCalls";
            const results = await Promise.all(
              items.map((item) => requestWithRetry(client, method, { item }, ctx.signal)),
            );
            return results.flatMap((result, index) => {
              const prepared = record(items[index]);
              const caller =
                typeof prepared?.uri === "string" && prepared.uri.startsWith("file:")
                  ? fileURLToPath(prepared.uri)
                  : file;
              return Array.isArray(result)
                ? result.flatMap(
                    (call) => formatCall(call, input.direction === "incoming", caller, root) ?? [],
                  )
                : [];
            });
          },
          ctx.signal,
        );
        return output("callHierarchy", file, root, lines as string[]);
      });
    },
  };
}

/** The navigation tools, in catalog order. */
export function lspTools(pool: LspPool, root: string, settings: Settings) {
  return [
    definitionTool(pool, root),
    referencesTool(pool, root),
    hoverTool(pool, root),
    symbolsTool(pool, root, settings),
    implementationsTool(pool, root),
    callsTool(pool, root),
  ];
}

/** Register the tools under the `lsp` namespace (`tools.lsp.*` in Code Mode). */
export function registerTools(
  ctx: Plugin.Context,
  pool: LspPool,
  root: string,
  settings: Settings,
) {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "lsp",
      description:
        "Language-server navigation: definitions, references, hover, symbols, implementations and call hierarchy. Diagnostics arrive with file edits.",
    });
    // Add each tool separately so TypeScript keeps its own input schema.
    editor.add(definitionTool(pool, root));
    editor.add(referencesTool(pool, root));
    editor.add(hoverTool(pool, root));
    editor.add(symbolsTool(pool, root, settings));
    editor.add(implementationsTool(pool, root));
    editor.add(callsTool(pool, root));
  });
}
