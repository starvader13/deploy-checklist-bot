import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "../../src/prompts/analysis.js";
import type { DeployChecklistConfig } from "../../src/schemas/config.js";
import type { PRMetadata } from "../../src/schemas/analysis-result.js";

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
      false,
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
      false,
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
      false,
      fileContents
    );

    expect(prompt).toContain("### src/models/User.py");
    expect(prompt).toContain("### src/models/Post.py");
  });
});
