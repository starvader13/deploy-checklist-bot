import { describe, it, expect, vi } from "vitest";
import { fetchTriggeredFileContents } from "../../src/services/diff-analyzer.js";
import type { Rule } from "../../src/schemas/config.js";

function createMockContext(
  getContentFn: (...args: any[]) => any = () => Promise.resolve({ data: {} })
) {
  return {
    octokit: {
      rest: {
        repos: {
          getContent: vi.fn(getContentFn),
        },
      },
    },
  } as any;
}

function toBase64(content: string): string {
  return Buffer.from(content, "utf-8").toString("base64");
}

describe("fetchTriggeredFileContents", () => {
  const ruleWithFullFiles: Rule = {
    id: "entity-migration",
    description: "Entity change may require migration",
    trigger: {
      paths: ["**/entities/**", "**/models/**"],
      include_full_files: true,
    },
    checks: ["Check if migration is needed"],
  };

  const ruleWithoutFullFiles: Rule = {
    id: "env-check",
    description: "Env var change",
    trigger: {
      content: ["process\\.env\\."],
    },
    checks: ["Confirm env vars deployed"],
  };

  it("fetches content for files matching rules with include_full_files", async () => {
    const fileContent = 'from django.db import models\n\nclass User(models.Model):\n    name = models.CharField(max_length=100)\n';
    const context = createMockContext(() =>
      Promise.resolve({ data: { content: toBase64(fileContent) } })
    );

    const result = await fetchTriggeredFileContents(
      context,
      "owner",
      "repo",
      "abc123",
      [ruleWithFullFiles],
      ["src/entities/User.py", "src/services/auth.ts"]
    );

    expect(result.size).toBe(1);
    expect(result.has("src/entities/User.py")).toBe(true);
    expect(result.get("src/entities/User.py")).toContain("django.db");
  });

  it("skips rules without include_full_files", async () => {
    const context = createMockContext();

    const result = await fetchTriggeredFileContents(
      context,
      "owner",
      "repo",
      "abc123",
      [ruleWithoutFullFiles],
      ["src/config.ts"]
    );

    expect(result.size).toBe(0);
    expect(context.octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it("respects 5-file cap", async () => {
    const context = createMockContext(() =>
      Promise.resolve({
        data: { content: toBase64("file content\n") },
      })
    );

    const filesChanged = Array.from(
      { length: 10 },
      (_, i) => `src/entities/Model${i}.ts`
    );

    const result = await fetchTriggeredFileContents(
      context,
      "owner",
      "repo",
      "abc123",
      [ruleWithFullFiles],
      filesChanged
    );

    expect(result.size).toBe(5);
    expect(context.octokit.rest.repos.getContent).toHaveBeenCalledTimes(5);
  });

  it("handles 404 (file not found) gracefully", async () => {
    const error = new Error("Not Found") as Error & { status: number };
    error.status = 404;
    const context = createMockContext(() => Promise.reject(error));

    const result = await fetchTriggeredFileContents(
      context,
      "owner",
      "repo",
      "abc123",
      [ruleWithFullFiles],
      ["src/entities/Deleted.ts"]
    );

    expect(result.size).toBe(0);
  });

  it("truncates files over 500 lines", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const fileContent = lines.join("\n");
    const context = createMockContext(() =>
      Promise.resolve({
        data: { content: toBase64(fileContent) },
      })
    );

    const result = await fetchTriggeredFileContents(
      context,
      "owner",
      "repo",
      "abc123",
      [ruleWithFullFiles],
      ["src/entities/BigModel.ts"]
    );

    const content = result.get("src/entities/BigModel.ts")!;
    expect(content).toContain("line 500");
    expect(content).not.toContain("line 501");
    expect(content).toContain("truncated");
    expect(content).toContain("500 more lines");
  });
});
