import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { languageIdFor } from "../src/catalog.js";
import { extensionKey } from "../src/paths.js";
import { serverRoot } from "../src/pool.js";
import { makeTempDir } from "./tmp.js";

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = makeTempDir("opencode-lsp-catalog-");
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

function cleanup() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

describe("catalog", () => {
  test("derives the extension key", () => {
    expect(extensionKey("/a/b/app.TS")).toBe(".ts");
    expect(extensionKey("/a/b/Dockerfile")).toBe(".dockerfile");
  });

  test("maps extensions to language ids", () => {
    expect(languageIdFor(".tsx")).toBe("typescriptreact");
    expect(languageIdFor(".cs")).toBe("csharp");
    expect(languageIdFor(".unknown")).toBe("unknown");
  });

  test("uses the nearest lockfile as the typescript root", async () => {
    const root = project({
      "package-lock.json": "{}",
      "src/app.ts": "",
    });
    const found = await serverRoot("typescript", join(root, "src/app.ts"), root);
    cleanup();
    expect(found).toBe(root);
  });

  test("skips typescript under a Deno project", async () => {
    const root = project({
      "package-lock.json": "{}",
      "deno.json": "{}",
      "src/app.ts": "",
    });
    const found = await serverRoot("typescript", join(root, "src/app.ts"), root);
    cleanup();
    expect(found).toBeUndefined();
  });

  test("requires a marker for Deno", async () => {
    const root = project({ "src/app.ts": "" });
    const without = await serverRoot("deno", join(root, "src/app.ts"), root);
    cleanup();
    expect(without).toBeUndefined();

    const deno = project({ "deno.json": "{}", "src/app.ts": "" });
    const withMarker = await serverRoot("deno", join(deno, "src/app.ts"), deno);
    cleanup();
    expect(withMarker).toBe(deno);
  });

  test("selects the nearest Python project", async () => {
    const root = project({
      "pyproject.toml": "",
      "sub/pyproject.toml": "",
      "sub/app.py": "",
    });
    const found = await serverRoot("pyright", join(root, "sub/app.py"), root);
    cleanup();
    expect(found).toBe(join(root, "sub"));
  });

  test("widens a Rust crate to its Cargo workspace", async () => {
    const root = project({
      "Cargo.toml": "[workspace]\nmembers = [\"crates/a\"]\n",
      "crates/a/Cargo.toml": "[package]\nname = \"a\"\n",
      "crates/a/src/lib.rs": "",
    });
    const found = await serverRoot("rust", join(root, "crates/a/src/lib.rs"), root);
    cleanup();
    expect(found).toBe(root);
  });

  test("keeps a Rust crate outside any workspace", async () => {
    const root = project({
      "crates/a/Cargo.toml": "[package]\nname = \"a\"\n",
      "crates/a/src/lib.rs": "",
    });
    const found = await serverRoot("rust", join(root, "crates/a/src/lib.rs"), root);
    cleanup();
    expect(found).toBe(join(root, "crates/a"));
  });

  test("runs custom ids at the project directory", async () => {
    const root = project({ "src/app.ts": "" });
    const found = await serverRoot("custom", join(root, "src/app.ts"), root);
    cleanup();
    expect(found).toBe(root);
  });

  test("falls back to the project when a marker is optional", async () => {
    const root = project({ "src/app.cs": "" });
    const found = await serverRoot("csharp", join(root, "src/app.cs"), root);
    cleanup();
    expect(found).toBe(root);
  });
});
