import { describe, it, expect } from "vitest";
import {
  DeployChecklistConfigSchema,
  type DeployChecklistConfig,
} from "../../src/schemas/config.js";

describe("DeployChecklistConfigSchema", () => {
  it("parses a complete valid config", () => {
    const input = {
      version: 1,
      settings: {
        analyze_drafts: true,
        ignore_authors: ["dependabot[bot]"],
        target_branches: ["main"],
        post_empty_checklist: false,
        max_diff_size: 50000,
      },
      rules: [
        {
          id: "test-rule",
          description: "Test rule",
          trigger: { paths: ["src/**"] },
          checks: ["Check something"],
        },
      ],
      context: "Test context",
    };

    const result = DeployChecklistConfigSchema.parse(input);

    expect(result.version).toBe(1);
    expect(result.settings.analyze_drafts).toBe(true);
    expect(result.settings.ignore_authors).toEqual(["dependabot[bot]"]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe("test-rule");
    expect(result.context).toBe("Test context");
  });

  it("applies defaults for missing optional fields", () => {
    const result = DeployChecklistConfigSchema.parse({});

    expect(result.version).toBe(1);
    expect(result.settings.analyze_drafts).toBe(false);
    expect(result.settings.ignore_authors).toEqual([]);
    expect(result.settings.target_branches).toEqual([]);
    expect(result.settings.post_empty_checklist).toBe(false);
    expect(result.settings.max_diff_size).toBe(100000);
    expect(result.rules).toEqual([]);
  });

  it("applies setting defaults when settings is partial", () => {
    const result = DeployChecklistConfigSchema.parse({
      settings: { analyze_drafts: true },
    });

    expect(result.settings.analyze_drafts).toBe(true);
    expect(result.settings.ignore_authors).toEqual([]);
    expect(result.settings.max_diff_size).toBe(100000);
  });

  it("rejects invalid types", () => {
    expect(() =>
      DeployChecklistConfigSchema.parse({ version: "not a number" })
    ).toThrow();
  });

  it("rejects rules with missing required fields", () => {
    expect(() =>
      DeployChecklistConfigSchema.parse({
        rules: [{ id: "incomplete" }],
      })
    ).toThrow();
  });

  it("accepts rules with missing_companion trigger", () => {
    const result = DeployChecklistConfigSchema.parse({
      rules: [
        {
          id: "companion-trigger",
          description: "Has missing_companion",
          trigger: {
            paths: ["**/entities/**"],
            missing_companion: ["**/migrations/**"],
          },
          checks: ["Check migration exists"],
        },
      ],
    });

    expect(result.rules[0].trigger.missing_companion).toEqual([
      "**/migrations/**",
    ]);
  });

  it("accepts rules with include_full_files trigger", () => {
    const result = DeployChecklistConfigSchema.parse({
      rules: [
        {
          id: "full-files-trigger",
          description: "Has include_full_files",
          trigger: {
            paths: ["**/entities/**"],
            include_full_files: true,
          },
          checks: ["Check framework"],
        },
      ],
    });

    expect(result.rules[0].trigger.include_full_files).toBe(true);
  });

  it("accepts rules with both path and content triggers", () => {
    const result = DeployChecklistConfigSchema.parse({
      rules: [
        {
          id: "combo-trigger",
          description: "Has both triggers",
          trigger: {
            paths: ["src/**"],
            content: ["process\\.env"],
          },
          checks: ["Check it"],
        },
      ],
    });

    expect(result.rules[0].trigger.paths).toEqual(["src/**"]);
    expect(result.rules[0].trigger.content).toEqual(["process\\.env"]);
  });
});

