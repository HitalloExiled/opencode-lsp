/**
 * Built-in language servers and the data used to select one for a file.
 *
 * OpenCode V1 shipped this table with its LSP runtime. V2 keeps the config
 * shape but no runtime, so the plugin carries the table itself: an ID such as
 * `rust` supplies default extensions, a root rule and a command, and a custom
 * ID must declare extensions and a command explicitly.
 */

export interface RootRule {
  /** The nearest directory holding one of these is the server's root. */
  readonly markers: readonly string[];
  /** A file below one of these skips the server entirely. */
  readonly exclude?: readonly string[];
  /** Without a marker the server does not apply, instead of using the project directory. */
  readonly required?: boolean;
}

export interface BuiltinServer {
  /** Lowercased dotted extensions (`.ts`) or exact lowercased file names (`dockerfile`). */
  readonly extensions: readonly string[];
  /** Executable and arguments used when the config entry declares no command. */
  readonly command: readonly string[];
  readonly root: RootRule;
}

const LOCKFILES = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

const PYTHON = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "pyrightconfig.json",
] as const;

const TYPESCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

const MARKDOWN_EXTENSIONS = [".md", ".mdx"] as const;

export const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
  astro: {
    extensions: [".astro"],
    command: ["astro-ls", "--stdio"],
    root: { markers: LOCKFILES },
  },
  bash: {
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    command: ["bash-language-server", "start"],
    root: { markers: [] },
  },
  biome: {
    extensions: [
      ...TYPESCRIPT_EXTENSIONS,
      ...MARKDOWN_EXTENSIONS,
      ".json",
      ".jsonc",
      ".vue",
      ".astro",
      ".svelte",
      ".css",
      ".graphql",
      ".gql",
      ".html",
    ],
    command: ["biome", "lsp-proxy"],
    root: { markers: ["biome.json", "biome.jsonc", ...LOCKFILES] },
  },
  clangd: {
    extensions: [
      ".c",
      ".cpp",
      ".cc",
      ".cxx",
      ".c++",
      ".h",
      ".hpp",
      ".hh",
      ".hxx",
      ".h++",
    ],
    command: ["clangd", "--background-index"],
    root: { markers: ["compile_commands.json", "compile_flags.txt", ".clangd"] },
  },
  "clojure-lsp": {
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    command: ["clojure-lsp", "listen"],
    root: { markers: ["deps.edn", "project.clj", "bb.edn"] },
  },
  csharp: {
    extensions: [".cs", ".csx"],
    command: ["csharp-ls"],
    root: { markers: ["global.json"] },
  },
  dart: {
    extensions: [".dart"],
    command: ["dart", "language-server"],
    root: { markers: ["pubspec.yaml", "analysis_options.yaml"] },
  },
  deno: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    command: ["deno", "lsp"],
    root: { markers: ["deno.json", "deno.jsonc"], required: true },
  },
  dockerfile: {
    extensions: [".dockerfile", "dockerfile"],
    command: ["docker-langserver", "--stdio"],
    root: { markers: [] },
  },
  "elixir-ls": {
    extensions: [".ex", ".exs"],
    command: ["elixir-ls"],
    root: { markers: ["mix.exs", "mix.lock"] },
  },
  eslint: {
    extensions: [...TYPESCRIPT_EXTENSIONS, ".vue"],
    command: ["vscode-eslint-language-server", "--stdio"],
    root: { markers: LOCKFILES },
  },
  fsharp: {
    extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
    command: ["fsautocomplete", "--adaptive-lsp-server-enabled"],
    root: { markers: ["global.json"] },
  },
  gleam: {
    extensions: [".gleam"],
    command: ["gleam", "lsp"],
    root: { markers: ["gleam.toml"] },
  },
  gopls: {
    extensions: [".go"],
    command: ["gopls", "serve"],
    root: { markers: ["go.work"] },
  },
  "haskell-language-server": {
    extensions: [".hs", ".lhs"],
    command: ["haskell-language-server-wrapper", "--lsp"],
    root: { markers: ["stack.yaml", "cabal.project", "hie.yaml"] },
  },
  jdtls: {
    extensions: [".java"],
    command: ["jdtls"],
    root: {
      markers: [
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
      ],
    },
  },
  "kotlin-ls": {
    extensions: [".kt", ".kts"],
    command: ["kotlin-language-server"],
    root: { markers: ["settings.gradle.kts", "settings.gradle"] },
  },
  "lua-ls": {
    extensions: [".lua"],
    command: ["lua-language-server"],
    root: {
      markers: [
        ".luarc.json",
        ".luarc.jsonc",
        ".luacheckrc",
        ".stylua.toml",
        "stylua.toml",
        "selene.toml",
        "selene.yml",
      ],
    },
  },
  nixd: {
    extensions: [".nix"],
    command: ["nixd"],
    root: { markers: [] },
  },
  "ocaml-lsp": {
    extensions: [".ml", ".mli"],
    command: ["ocamllsp"],
    root: { markers: ["dune-project", "dune-workspace", ".merlin", "opam"] },
  },
  php: {
    extensions: [".php"],
    command: ["intelephense", "--stdio"],
    root: { markers: ["composer.json", "composer.lock", ".php-version"] },
  },
  prisma: {
    extensions: [".prisma"],
    command: ["prisma-language-server", "--stdio"],
    root: { markers: ["schema.prisma", "prisma"] },
  },
  pyright: {
    extensions: [".py", ".pyi"],
    command: ["pyright-langserver", "--stdio"],
    root: { markers: PYTHON },
  },
  "ruby-lsp": {
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
    command: ["ruby-lsp"],
    root: { markers: ["Gemfile"] },
  },
  rust: {
    extensions: [".rs"],
    command: ["rust-analyzer"],
    root: { markers: ["Cargo.toml", "Cargo.lock"] },
  },
  "sourcekit-lsp": {
    extensions: [".swift", ".objc", ".objcpp"],
    command: ["sourcekit-lsp"],
    root: { markers: ["Package.swift"] },
  },
  svelte: {
    extensions: [".svelte"],
    command: ["svelteserver", "--stdio"],
    root: { markers: LOCKFILES },
  },
  terraform: {
    extensions: [".tf", ".tfvars"],
    command: ["terraform-ls", "serve"],
    root: { markers: [".terraform.lock.hcl", "terraform.tfstate"] },
  },
  texlab: {
    extensions: [".tex", ".bib"],
    command: ["texlab"],
    root: { markers: [".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"] },
  },
  tinymist: {
    extensions: [".typ", ".typc"],
    command: ["tinymist"],
    root: { markers: ["typst.toml"] },
  },
  typescript: {
    extensions: TYPESCRIPT_EXTENSIONS,
    command: ["typescript-language-server", "--stdio"],
    root: { markers: LOCKFILES, exclude: ["deno.json", "deno.jsonc"] },
  },
  vue: {
    extensions: [".vue"],
    command: ["vue-language-server", "--stdio"],
    root: { markers: LOCKFILES },
  },
  "yaml-ls": {
    extensions: [".yaml", ".yml"],
    command: ["yaml-language-server", "--stdio"],
    root: { markers: LOCKFILES },
  },
  zls: {
    extensions: [".zig", ".zon"],
    command: ["zls"],
    root: { markers: ["build.zig"] },
  },
};

/** Extension (or exact file name) to the LSP `languageId` used by `didOpen`. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".json": "json",
  ".jsonc": "jsonc",
  ".css": "css",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".html": "html",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".csx": "csharp",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".objc": "objective-c",
  ".objcpp": "objective-cpp",
  ".swift": "swift",
  ".zig": "zig",
  ".zon": "zig",
  ".lua": "lua",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".ksh": "shellscript",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".ex": "elixir",
  ".exs": "elixir",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".nix": "nix",
  ".tex": "latex",
  ".bib": "bibtex",
  ".typ": "typst",
  ".typc": "typst-code",
  ".dart": "dart",
  ".prisma": "prisma",
  ".gleam": "gleam",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".md": "markdown",
  ".mdx": "markdown",
  ".dockerfile": "dockerfile",
};

/** The LSP `languageId` for an extension key; unknown extensions pass through without the dot. */
export function languageIdFor(extension: string): string {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? extension.replace(/^\./, "");
}
