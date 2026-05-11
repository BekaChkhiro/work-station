// T13.7 — File extension → Monaco language ID mapping.
//
// Monaco bundles ~80 grammars (see `monaco-editor/esm/vs/basic-languages`).
// We map the extensions we expect to encounter in this project's typical
// workspaces — TypeScript / Rust / Python first-class, then the rest of the
// common neighbourhood. Unknown extensions fall back to `plaintext`, which
// Monaco renders without highlighting.

const EXTENSION_LANGUAGE: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  // Systems
  rs: "rust",
  go: "go",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  scala: "scala",
  clj: "clojure",
  cljs: "clojure",

  // Scripting
  py: "python",
  rb: "ruby",
  pl: "perl",
  lua: "lua",
  php: "php",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  r: "r",

  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",

  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "html",
  svelte: "html",

  // Data / config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  sql: "sql",

  // Docs
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
};

const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  cmakelists: "cpp",
};

/** Strip directory components and return the basename (lower-cased). */
function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (i >= 0 ? path.slice(i + 1) : path).toLowerCase();
}

/**
 * Resolve a Monaco language ID from a filename / path. Returns `"plaintext"`
 * when the extension is unknown — keeps callers from having to special-case
 * scratch buffers or unrecognised files.
 */
export function languageForPath(path: string | null | undefined): string {
  if (!path) return "plaintext";
  const name = basename(path);

  // Bare-name matches (Dockerfile, Makefile, …) before extension lookup so
  // `Dockerfile` (no extension) still resolves.
  const bareHit = FILENAME_LANGUAGE[name];
  if (bareHit) return bareHit;

  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "plaintext";
  const ext = name.slice(dot + 1);
  return EXTENSION_LANGUAGE[ext] ?? "plaintext";
}
