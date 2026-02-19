import { describe, it, expect } from "vitest";
import { truncateDiff } from "../../src/utils/diff-truncation.js";
import type { Rule } from "../../src/schemas/config.js";

const migrationRule: Rule = {
  id: "migration",
  description: "Migration check",
  trigger: { paths: ["migrations/**"] },
  checks: ["Check migration"],
};

const srcRule: Rule = {
  id: "src-check",
  description: "Source check",
  trigger: { paths: ["src/**"] },
  checks: ["Check source"],
};

function buildDiff(files: { name: string; lines: number }[]): string {
  return files
    .map(({ name, lines }) => {
      const content = Array.from(
        { length: lines },
        (_, i) => `+line ${i + 1}`
      ).join("\n");
      return (
        `diff --git a/${name} b/${name}\n` +
        `--- a/${name}\n` +
        `+++ b/${name}\n` +
        `@@ -0,0 +1,${lines} @@\n` +
        content
      );
    })
    .join("\n");
}

describe("truncateDiff", () => {
  it("returns diff unchanged when under max size", () => {
    const diff = buildDiff([{ name: "small.txt", lines: 5 }]);
    const result = truncateDiff(diff, 100000, []);

    expect(result.truncated).toBe(false);
    expect(result.diff).toBe(diff);
    expect(result.filesSummarized).toEqual([]);
  });

  it("truncates when diff exceeds max size", () => {
    const diff = buildDiff([
      { name: "migrations/001.sql", lines: 50 },
      { name: "README.md", lines: 500 },
    ]);

    const result = truncateDiff(diff, 500, [migrationRule]);
    expect(result.truncated).toBe(true);
  });

  it("prioritizes files matching rule triggers", () => {
    const diff = buildDiff([
      { name: "README.md", lines: 200 },
      { name: "migrations/001.sql", lines: 50 },
    ]);

    const result = truncateDiff(diff, 800, [migrationRule]);

    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("migrations/001.sql");
    expect(result.filesSummarized).toContain("README.md");
  });

  it("lists summarized files when they don't fit", () => {
    const diff = buildDiff([
      { name: "migrations/001.sql", lines: 10 },
      { name: "src/big-file.ts", lines: 500 },
      { name: "docs/notes.md", lines: 500 },
    ]);

    const result = truncateDiff(diff, 1000, [migrationRule]);

    expect(result.truncated).toBe(true);
    expect(result.filesSummarized.length).toBeGreaterThan(0);
  });

  it("handles empty diff", () => {
    const result = truncateDiff("", 100000, [migrationRule]);

    expect(result.truncated).toBe(false);
    expect(result.diff).toBe("");
  });

  it("prioritizes files from missing_companion patterns", () => {
    const companionRule: Rule = {
      id: "entity-check",
      description: "Entity check",
      trigger: {
        paths: ["**/entities/**"],
        missing_companion: ["**/migrations/**"],
      },
      checks: ["Check entity"],
    };

    const diff = buildDiff([
      { name: "README.md", lines: 200 },
      { name: "src/entities/User.ts", lines: 50 },
      { name: "migrations/001.sql", lines: 50 },
    ]);

    const result = truncateDiff(diff, 1000, [companionRule]);

    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("src/entities/User.ts");
    expect(result.diff).toContain("migrations/001.sql");
    expect(result.filesSummarized).toContain("README.md");
  });

  it("handles diff with no triggered files", () => {
    const diff = buildDiff([
      { name: "README.md", lines: 10 },
      { name: "docs/guide.md", lines: 10 },
    ]);

    const result = truncateDiff(diff, 100000, [migrationRule]);

    expect(result.truncated).toBe(false);
    expect(result.diff).toContain("README.md");
    expect(result.diff).toContain("docs/guide.md");
  });
});
