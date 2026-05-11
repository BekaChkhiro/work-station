// T13.7 — language detection from file path.

import { describe, expect, it } from "vitest";

import { languageForPath } from "./language";

describe("languageForPath", () => {
  it("returns plaintext for null / empty", () => {
    expect(languageForPath(null)).toBe("plaintext");
    expect(languageForPath(undefined)).toBe("plaintext");
    expect(languageForPath("")).toBe("plaintext");
  });

  it("returns plaintext for files without an extension", () => {
    expect(languageForPath("README")).toBe("plaintext");
    expect(languageForPath("LICENSE")).toBe("plaintext");
  });

  it("maps TypeScript variants to typescript", () => {
    expect(languageForPath("foo.ts")).toBe("typescript");
    expect(languageForPath("foo.tsx")).toBe("typescript");
    expect(languageForPath("foo.mts")).toBe("typescript");
    expect(languageForPath("foo.cts")).toBe("typescript");
  });

  it("maps the systems-language trio asked for in T13.7", () => {
    expect(languageForPath("main.rs")).toBe("rust");
    expect(languageForPath("script.py")).toBe("python");
    expect(languageForPath("Cargo.toml")).toBe("ini");
  });

  it("handles absolute paths and back-slashes", () => {
    expect(languageForPath("/Users/foo/bar/baz.rs")).toBe("rust");
    expect(languageForPath("C:\\projects\\app\\src\\main.rs")).toBe("rust");
  });

  it("is case-insensitive on the extension", () => {
    expect(languageForPath("INDEX.HTML")).toBe("html");
    expect(languageForPath("Foo.JSON")).toBe("json");
  });

  it("recognises bare-name files (Dockerfile, Makefile)", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("path/to/Makefile")).toBe("shell");
  });

  it("falls back to plaintext for unknown extensions", () => {
    expect(languageForPath("foo.xyzzy")).toBe("plaintext");
  });
});
