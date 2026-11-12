import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { BUILTIN_SERVERS } from "./catalog.js";
import { parseJsonc } from "./jsonc.js";

export interface ServerConfig {
  readonly id: string;
  readonly command: string[];
  /** Lowercased dotted extensions (`.ts`) or exact lowercased file names (`dockerfile`). */
  readonly extensions: string[];
  readonly env: Record<string, string>;
  readonly initialization?: Record<string, unknown>;
}

export interface Settings {
  readonly servers: ServerConfig[];
  readonly diagnostics: boolean;
  /** LSP severities to report: 1 error, 2 warning, 3 info, 4 hint. */
  readonly severities: number[];
  readonly diagnosticsTimeoutMs: number;
  readonly initializeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /** How long a cold navigation waits for the server's first analysis. */
  readonly warmupTimeoutMs: number;
  /** Stop an unused server after this long; 0 keeps it for the plugin's lifetime. */
  readonly idleShutdownMs: number;
  readonly maxErrorsPerFile: number;
  readonly maxOtherFiles: number;
  readonly maxWorkspaceSymbols: number;
  readonly debug: boolean;
}

const NAMES = ["opencode.json", "opencode.jsonc"] as const;

const SEVERITIES: Record<string, number> = {
  error: 1,
  warning: 2,
  warn: 2,
  info: 3,
  hint: 4,
};

/**
 * Resolve the effective settings for a project.
 *
 * OpenCode V2 does not expose its merged config to plugins, so this reads the
 * same sources in the same order and applies the plugin `options` last.
 */
export function resolveSettings(
  directory: string,
  options: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  let lsp: unknown;
  for (const document of configDocuments(directory, env)) {
    if (document.lsp !== undefined) lsp = mergeLsp(lsp, document.lsp, env);
  }
  if (options.lsp !== undefined) lsp = mergeLsp(lsp, options.lsp, env);

  const debug = options.debug === true;
  return {
    servers: resolveServers(lsp, env, debug),
    diagnostics: options.diagnostics !== false,
    severities: severities(options.severities),
    diagnosticsTimeoutMs: positive(options.diagnosticsTimeoutMs, 5_000),
    initializeTimeoutMs: positive(options.initializeTimeoutMs, 45_000),
    requestTimeoutMs: positive(options.requestTimeoutMs, 15_000),
    warmupTimeoutMs: positive(options.warmupTimeoutMs, 6_000),
    idleShutdownMs: nonNegative(options.idleShutdownMs, 600_000),
    maxErrorsPerFile: integer(options.maxErrorsPerFile, 20, 1),
    maxOtherFiles: integer(options.maxOtherFiles, 5, 0),
    maxWorkspaceSymbols: integer(options.maxWorkspaceSymbols, 20, 1),
    debug,
  };
}

/** Config documents from lowest to highest precedence. */
export function configDocuments(
  directory: string,
  env: NodeJS.ProcessEnv,
): Record<string, unknown>[] {
  const documents: Record<string, unknown>[] = [];
  const push = (document: Record<string, unknown> | undefined) => {
    if (document) documents.push(document);
  };

  const global = env.OPENCODE_CONFIG_DIR
    ? resolve(env.OPENCODE_CONFIG_DIR)
    : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  for (const name of NAMES) push(readDocument(join(global, name), env));
  if (env.OPENCODE_CONFIG) push(readDocument(resolve(env.OPENCODE_CONFIG), env));

  const projectDisabled = truthy(env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG);
  if (!projectDisabled && canonical(directory) !== canonical(global)) {
    const globalFiles = new Set(NAMES.map((name) => canonical(join(global, name))));
    const ancestors: string[] = [];
    for (let current = resolve(directory); ; current = dirname(current)) {
      ancestors.push(current);
      if (dirname(current) === current) break;
    }
    ancestors.reverse();
    // Direct files first, farthest directory first, then `.opencode` files.
    for (const ancestor of ancestors) {
      for (const name of NAMES) {
        const file = join(ancestor, name);
        if (!globalFiles.has(canonical(file))) push(readDocument(file, env));
      }
    }
    for (const ancestor of ancestors) {
      const project = join(ancestor, ".opencode");
      if (canonical(project) === canonical(global)) continue;
      for (const name of NAMES) push(readDocument(join(project, name), env));
    }
  }

  if (env.OPENCODE_CONFIG_CONTENT) {
    push(parseDocument(env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT", directory, env));
  }
  return documents;
}

function readDocument(path: string, env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseDocument(readFileSync(path, "utf8"), path, dirname(path), env);
  } catch (error) {
    console.error(`[lsp] cannot read ${path}: ${message(error)}`);
    return undefined;
  }
}

function parseDocument(
  text: string,
  source: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> | undefined {
  try {
    const parsed = parseJsonc(substitute(text, dir, env));
    if (isRecord(parsed)) return parsed;
    console.error(`[lsp] ${source} is not a JSON object`);
  } catch (error) {
    console.error(`[lsp] cannot parse ${source}: ${message(error)}`);
  }
  return undefined;
}

/**
 * OpenCode's substitution, applied to the raw text before parsing: `{env:VAR}`
 * becomes the variable or nothing, `{file:path}` becomes the trimmed file,
 * escaped for a JSON string, relative to `dir` unless absolute or `~/`.
 * Tokens on `//` comment lines are left alone.
 */
export function substitute(text: string, dir: string, env: NodeJS.ProcessEnv): string {
  return text
    .replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? "")
    .replace(/\{file:[^}]+\}/g, (token: string, offset: number, whole: string) => {
      const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
      if (whole.slice(lineStart, offset).trimStart().startsWith("//")) return token;
      const path = token.slice("{file:".length, -1);
      const file = resolve(dir, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
      return JSON.stringify(readFileSync(file, "utf8").trim()).slice(1, -1);
    });
}

/**
 * `false` disables every server; `true` enables the built-ins whose default
 * command is on `PATH`. Server objects merge deeply, arrays are replaced.
 */
export function mergeLsp(previous: unknown, next: unknown, env: NodeJS.ProcessEnv): unknown {
  if (next === false) return false;
  if (next === true) {
    const base = expandBuiltins(env);
    return isRecord(previous) ? mergeDeep(base, previous) : base;
  }
  if (!isRecord(next)) return previous;
  return isRecord(previous) ? mergeDeep(previous, next) : next;
}

/** `{ id: {} }` for every built-in whose default command resolves. */
export function expandBuiltins(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const enabled: Record<string, unknown> = {};
  for (const [id, server] of Object.entries(BUILTIN_SERVERS)) {
    const command = server.command[0];
    if (command && commandExists(command, env)) enabled[id] = {};
  }
  return enabled;
}

/** Whether an executable is on `PATH` (or an absolute path is executable). */
export function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
    return isExecutable(command);
  }
  const path = env.PATH ?? env.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (isExecutable(join(dir, command + extension))) return true;
    }
  }
  return false;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveServers(
  lsp: unknown,
  env: NodeJS.ProcessEnv,
  debug: boolean,
): ServerConfig[] {
  if (!isRecord(lsp)) return [];
  const servers: ServerConfig[] = [];
  for (const [id, entry] of Object.entries(lsp)) {
    if (!isRecord(entry) || entry.disabled === true) continue;
    const builtin = BUILTIN_SERVERS[id];
    const declaredCommand = strings(entry.command);
    const command = declaredCommand.length > 0 ? declaredCommand : [...(builtin?.command ?? [])];
    if (command.length === 0) {
      if (debug) console.error(`[lsp] ${id} has no command; skipping`);
      continue;
    }
    const declaredExtensions = strings(entry.extensions);
    const extensions = normalizeExtensions(
      declaredExtensions.length > 0 ? declaredExtensions : (builtin?.extensions ?? []),
    );
    if (extensions.length === 0) {
      console.error(
        `[lsp] ${id} has no extensions and is not a known built-in; it matches no files`,
      );
      continue;
    }
    servers.push({
      id,
      command,
      extensions,
      env: stringRecord(entry.env),
      initialization: isRecord(entry.initialization) ? entry.initialization : undefined,
    });
  }
  return servers;
}

function normalizeExtensions(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function mergeDeep(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    const before = merged[key];
    merged[key] = isRecord(before) && isRecord(value) ? mergeDeep(before, value) : value;
  }
  return merged;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function severities(value: unknown): number[] {
  if (!Array.isArray(value)) return [1];
  const out = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && item >= 1 && item <= 4) out.add(Math.trunc(item));
    else if (typeof item === "string") {
      const severity = SEVERITIES[item.toLowerCase()];
      if (severity) out.add(severity);
    }
  }
  return [...out].sort();
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function integer(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
