import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "../../src/prompts/analysis.js";
import type { DeployChecklistConfig } from "../../src/schemas/config.js";
import type { PRMetadata } from "../../src/schemas/analysis-result.js";
import type { Skill } from "../../src/skills/index.js";

const baseConfig: DeployChecklistConfig = {
  version: 1,
  settings: {
    analyze_drafts: false,
    ignore_authors: [],
    target_branches: [],
    post_empty_checklist: false,
    max_diff_size: 100000,
  },
  rules: [
    {
      id: "test-rule",
      description: "Test rule",
      trigger: { paths: ["src/**"] },
      checks: ["Check something"],
    },
  ],
};

const basePRMeta: PRMetadata = {
  title: "Test PR",
  body: "Test body",
  baseBranch: "main",
  headSha: "abc123",
  author: "dev",
  isDraft: false,
  filesChanged: ["src/file.ts"],
};

describe("buildUserPrompt — file contents", () => {
  it("includes file contents section when fileContents is provided", () => {
    const fileContents = new Map<string, string>();
    fileContents.set(
      "src/models/User.py",
      'from django.db import models\n\nclass User(models.Model):\n    pass\n'
    );

    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      [],
      fileContents
    );

    expect(prompt).toContain("## Full File Contents (for context)");
    expect(prompt).toContain("### src/models/User.py");
    expect(prompt).toContain("from django.db import models");
  });

  it("omits file contents section when no fileContents provided", () => {
    const prompt = buildUserPrompt(baseConfig, basePRMeta, "diff content");
    expect(prompt).not.toContain("## Full File Contents");
  });

  it("omits file contents section when fileContents is empty", () => {
    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      [],
      new Map()
    );
    expect(prompt).not.toContain("## Full File Contents");
  });

  it("includes multiple files in the contents section", () => {
    const fileContents = new Map<string, string>();
    fileContents.set("src/models/User.py", "class User: pass");
    fileContents.set("src/models/Post.py", "class Post: pass");

    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      [],
      fileContents
    );

    expect(prompt).toContain("### src/models/User.py");
    expect(prompt).toContain("### src/models/Post.py");
  });
});

describe("buildUserPrompt — active skills", () => {
  const fakeSkill: Skill = {
    id: "test-skill",
    name: "Test Skill",
    paths: ["src/**"],
    detect: () => true,
    systemContext: "Test system context for the skill.",
    checks: ["Verify something important"],
  };

  it("includes Active Skills section when skills are provided", () => {
    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [fakeSkill],
      []
    );

    expect(prompt).toContain("## Active Skills");
    expect(prompt).toContain("### Skill: test-skill");
    expect(prompt).toContain("Test system context for the skill.");
    expect(prompt).toContain("Verify something important");
  });

  it("omits Active Skills section when no skills provided", () => {
    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      []
    );
    expect(prompt).not.toContain("## Active Skills");
  });
});

describe("buildUserPrompt — uncovered files", () => {
  it("includes uncovered files section when uncoveredFiles is non-empty", () => {
    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      ["src/unusual/file.ts", "src/other.ts"]
    );

    expect(prompt).toContain("## Files Without Skill Coverage");
    expect(prompt).toContain("- src/unusual/file.ts");
    expect(prompt).toContain("- src/other.ts");
  });

  it("omits uncovered files section when uncoveredFiles is empty", () => {
    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      []
    );
    expect(prompt).not.toContain("## Files Without Skill Coverage");
  });
});

describe("buildUserPrompt — custom rules", () => {
  it("includes Custom Rules section when config has rules", () => {
    const prompt = buildUserPrompt(
      baseConfig,
      basePRMeta,
      "diff content",
      [],
      []
    );

    expect(prompt).toContain("## Custom Rules");
    expect(prompt).toContain("### Rule: test-rule");
  });

  it("omits Custom Rules section when config has no rules", () => {
    const configNoRules: DeployChecklistConfig = { ...baseConfig, rules: [] };
    const prompt = buildUserPrompt(
      configNoRules,
      basePRMeta,
      "diff content",
      [],
      []
    );
    expect(prompt).not.toContain("## Custom Rules");
  });
});

describe("buildUserPrompt — instructions", () => {
  it("includes tool use instruction", () => {
    const prompt = buildUserPrompt(baseConfig, basePRMeta, "diff content");
    expect(prompt).toContain("submit_analysis tool");
  });

  it("does not include JSON schema in instructions", () => {
    const prompt = buildUserPrompt(baseConfig, basePRMeta, "diff content");
    expect(prompt).not.toContain('"items"');
    expect(prompt).not.toContain('"summary"');
  });
});
