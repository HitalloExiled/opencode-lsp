import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSettings } from "../src/settings.js";
import { makeTempDir } from "./tmp.js";

const roots: string[] = [];

function temp(): string {
  const root = makeTempDir("opencode-lsp-settings-");
  roots.push(root);
  return root;
}

function write(root: string, name: string, content: unknown): string {
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function project(files: Record<string, unknown> = {}): string {
  const root = temp();
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  return root;
}

function env(globalDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", OPENCODE_CONFIG_DIR: globalDir, ...extra };
}

function cleanup() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

describe("resolveSettings", () => {
  test("merges the global and project lsp blocks", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", { lsp: { typescript: { command: ["tsls", "--stdio"] } } });
    const root = project({
      "opencode.json": { lsp: { typescript: { env: { X: "1" } } } },
    });

    const settings = resolveSettings(root, {}, env(globalDir));
    cleanup();
    expect(settings.servers).toHaveLength(1);
    expect(settings.servers[0]?.command).toEqual(["tsls", "--stdio"]);
    expect(settings.servers[0]?.extensions).toContain(".ts");
    expect(settings.servers[0]?.env).toEqual({ X: "1" });
  });

  test("plugin options win over every config document", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", { lsp: { typescript: { command: ["global"] } } });
    const root = project({ "opencode.json": { lsp: { pyright: { command: ["project"] } } } });

    const settings = resolveSettings(
      root,
      { lsp: { typescript: { command: ["options"] } } },
      env(globalDir),
    );
    cleanup();
    expect(settings.servers.find((server) => server.id === "typescript")?.command).toEqual([
      "options",
    ]);
    expect(settings.servers.some((server) => server.id === "pyright")).toBe(true);
  });

  test("lsp:false disables every server", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", { lsp: { typescript: { command: ["tsls"] } } });
    const root = project({ "opencode.json": { lsp: false } });
    const settings = resolveSettings(root, {}, env(globalDir));
    cleanup();
    expect(settings.servers).toEqual([]);
  });

  test("lsp:true enables only built-ins whose command is on PATH", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", { lsp: true });
    const bin = temp();
    const executable = join(bin, "typescript-language-server");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const root = project();

    const settings = resolveSettings(root, {}, env(globalDir, { PATH: bin }));
    cleanup();
    expect(settings.servers.map((server) => server.id)).toEqual(["typescript"]);
  });

  test("lsp:true keeps explicit entries for built-ins that are not on PATH", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", { lsp: true });
    const root = project({
      "opencode.json": { lsp: { rust: { command: ["/opt/rust-analyzer"] } } },
    });
    const settings = resolveSettings(root, {}, env(globalDir, { PATH: "" }));
    cleanup();
    expect(settings.servers.map((server) => server.id)).toEqual(["rust"]);
    expect(settings.servers[0]?.command).toEqual(["/opt/rust-analyzer"]);
  });

  test("honours disabled and drops custom ids without extensions", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", {
      lsp: {
        typescript: { command: ["tsls"], disabled: true },
        pyright: { command: ["pyright-langserver"] },
        custom: { command: ["custom-ls"] },
      },
    });
    const settings = resolveSettings(project(), {}, env(globalDir));
    cleanup();
    expect(settings.servers.map((server) => server.id)).toEqual(["pyright"]);
  });

  test("accepts a UTF-8 BOM", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", `\uFEFF${JSON.stringify({ lsp: { gopls: { command: ["gopls"] } } })}`);
    const settings = resolveSettings(project(), {}, env(globalDir));
    cleanup();
    expect(settings.servers.map((server) => server.id)).toEqual(["gopls"]);
  });

  test("substitutes {env:} and {file:} before parsing", () => {
    const globalDir = temp();
    write(globalDir, "command.txt", "my-ls\n");
    write(globalDir, "opencode.json", {
      lsp: {
        typescript: { command: ["{env:LSP_COMMAND}", "--from", "{file:command.txt}"] },
      },
    });
    const settings = resolveSettings(project(), {}, env(globalDir, { LSP_COMMAND: "env-ls" }));
    cleanup();
    expect(settings.servers[0]?.command).toEqual(["env-ls", "--from", "my-ls"]);
  });

  test("OPENCODE_CONFIG_CONTENT overrides project files", () => {
    const globalDir = temp();
    const root = project({ "opencode.json": { lsp: { typescript: { command: ["project"] } } } });
    const settings = resolveSettings(
      root,
      {},
      env(globalDir, {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          lsp: { typescript: { command: ["content"] } },
        }),
      }),
    );
    cleanup();
    expect(settings.servers[0]?.command).toEqual(["content"]);
  });

  test("skips project config when disabled", () => {
    const globalDir = temp();
    const root = project({ "opencode.json": { lsp: { typescript: { command: ["project"] } } } });
    const settings = resolveSettings(
      root,
      {},
      env(globalDir, { OPENCODE_CONFIG_PROJECT_DISABLE: "true" }),
    );
    cleanup();
    expect(settings.servers).toEqual([]);
  });

  test("gives the eslint server the settings its language server needs", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", { lsp: { eslint: {} } });
    const settings = resolveSettings(project(), {}, env(globalDir));
    cleanup();
    const eslint = settings.servers.find((server) => server.id === "eslint");
    expect(eslint?.initialization).toMatchObject({
      nodePath: null,
      validate: "probe",
      problems: { shortenToSingleLine: false },
      experimental: { useFlatConfig: true },
      workingDirectory: { mode: "location" },
    });
  });

  test("user initialization deep-merges over the eslint defaults", () => {
    const globalDir = temp();
    write(globalDir, "opencode.json", {
      lsp: {
        eslint: {
          initialization: {
            validate: "on",
            problems: { shortenToSingleLine: true },
            options: { rulePaths: ["./rules"] },
          },
        },
      },
    });
    const settings = resolveSettings(project(), {}, env(globalDir));
    cleanup();
    const eslint = settings.servers.find((server) => server.id === "eslint");
    expect(eslint?.initialization).toMatchObject({
      nodePath: null,
      validate: "on",
      problems: { shortenToSingleLine: true },
      options: { rulePaths: ["./rules"] },
    });
  });

  test("resolves options and defaults", () => {
    const settings = resolveSettings(
      project(),
      {
        diagnostics: false,
        severities: ["error", "warning", 3],
        diagnosticsTimeoutMs: 123,
        warmupTimeoutMs: 456,
        idleShutdownMs: 0,
        maxErrorsPerFile: 2,
        debug: true,
      },
      env(temp()),
    );
    cleanup();
    expect(settings.diagnostics).toBe(false);
    expect(settings.severities).toEqual([1, 2, 3]);
    expect(settings.diagnosticsTimeoutMs).toBe(123);
    expect(settings.warmupTimeoutMs).toBe(456);
    expect(settings.idleShutdownMs).toBe(0);
    expect(settings.maxErrorsPerFile).toBe(2);
    expect(settings.debug).toBe(true);
    expect(settings.initializeTimeoutMs).toBe(45_000);
  });
});
