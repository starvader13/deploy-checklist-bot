import { describe, it, expect } from "vitest";
import { extractFilesFromDiff } from "../../src/services/diff-analyzer.js";
import { readFileSync } from "fs";
import { join } from "path";

function readFixture(name: string): string {
  return readFileSync(
    join(__dirname, "..", "fixtures", "diffs", name),
    "utf-8"
  );
}

describe("extractFilesFromDiff", () => {
  it("extracts file paths from a migration diff", () => {
    const diff = readFixture("migration-added.diff");
    const files = extractFilesFromDiff(diff);
    expect(files).toContain("migrations/20240115_add_users.sql");
  });

  it("extracts file paths from an env var diff", () => {
    const diff = readFixture("env-var-referenced.diff");
    const files = extractFilesFromDiff(diff);
    expect(files).toContain("src/db/connection.ts");
  });

  it("extracts file paths from an API route diff", () => {
    const diff = readFixture("api-route-changed.diff");
    const files = extractFilesFromDiff(diff);
    expect(files).toContain("src/routes/users.ts");
  });

  it("extracts file paths from a clean diff", () => {
    const diff = readFixture("clean.diff");
    const files = extractFilesFromDiff(diff);
    expect(files).toContain("README.md");
  });

  it("deduplicates file paths", () => {
    const diff = [
      "diff --git a/src/file.ts b/src/file.ts",
      "--- a/src/file.ts",
      "+++ b/src/file.ts",
      "@@ -1,3 +1,3 @@",
      "-old",
      "+new",
      "diff --git a/src/file.ts b/src/file.ts",
      "--- a/src/file.ts",
      "+++ b/src/file.ts",
      "@@ -10,3 +10,3 @@",
      "-old2",
      "+new2",
    ].join("\n");

    const files = extractFilesFromDiff(diff);
    expect(files.filter((f) => f === "src/file.ts")).toHaveLength(1);
  });

  it("returns empty array for empty diff", () => {
    expect(extractFilesFromDiff("")).toEqual([]);
  });

  it("handles multi-file diffs", () => {
    const migrationDiff = readFixture("migration-added.diff");
    const envDiff = readFixture("env-var-referenced.diff");
    const combined = migrationDiff + "\n" + envDiff;

    const files = extractFilesFromDiff(combined);
    expect(files).toContain("migrations/20240115_add_users.sql");
    expect(files).toContain("src/db/connection.ts");
  });
});
