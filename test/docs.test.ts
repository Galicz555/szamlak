import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");

const readTree = (dir: string): string =>
  readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");

const CODE = `${readTree("src")}\n${readTree("migrations")}`;

/** Backticked spans in the first `columns` cells of every table row of a Markdown file. */
function tableCodeSpans(file: string, columns: number): string[] {
  return readFileSync(path.join(ROOT, file), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.startsWith("| -"))
    .slice(1)
    .flatMap((line) => line.split("|").slice(1, 1 + columns))
    .flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
}

test("every path and identifier in the AGENTS.md layout table exists", () => {
  for (const span of tableCodeSpans("AGENTS.md", 2)) {
    if (span.endsWith("/") || span.startsWith("src/")) {
      assert.ok(existsSync(path.join(ROOT, span)), span);
    } else if (span.endsWith(".md")) {
      assert.ok(existsSync(path.join(ROOT, "docs", span)), span);
    } else if (span.endsWith("()")) {
      assert.match(CODE, new RegExp(`\\b${span.slice(0, -2)}\\(`), span);
    } else {
      assert.ok(CODE.includes(span), span);
    }
  }
});

test("every code name in the glossary is used in the code or the schema", () => {
  for (const span of tableCodeSpans("docs/glossary.md", 1)) {
    assert.match(CODE, new RegExp(`\\b${span.replaceAll(" ", "_")}\\b`), span);
  }
});
