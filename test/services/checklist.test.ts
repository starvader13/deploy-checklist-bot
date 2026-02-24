import { describe, it, expect } from "vitest";
import {
  generateChecklist,
  parseChecklist,
  mergeChecklist,
  isComplete,
  BOT_MARKER,
} from "../../src/services/checklist.js";
import type { AnalysisResult } from "../../src/schemas/analysis-result.js";

const sampleResult: AnalysisResult = {
  items: [
    {
      rule_id: "migration-safety",
      check: "Verify rollback exists",
      description: "Verify migration rollback for migrations/20240115_add_users.sql",
      reasoning: "New migration file detected. Confirm rollback SQL is tested.",
      priority: "high",
    },
    {
      rule_id: "env-var-check",
      check: "Confirm env vars set",
      description: "Add DATABASE_URL to production environment",
      reasoning: "New env var referenced in src/db/connection.ts:14.",
      priority: "medium",
    },
  ],
  summary: "Medium risk — database migration and new env var detected.",
  uncovered_files: [],
  open_concerns: [],
};

const emptyResult: AnalysisResult = {
  items: [],
  summary: "No deploy checklist items needed.",
  uncovered_files: [],
  open_concerns: [],
};

describe("generateChecklist", () => {
  it("generates markdown with bot marker and SHA metadata", () => {
    const md = generateChecklist(sampleResult, "abc123");

    expect(md).toContain(BOT_MARKER);
    expect(md).toContain("<!-- sha:abc123 -->");
    expect(md).toContain("## Deploy Checklist");
  });

  it("includes all checklist items as unchecked checkboxes with check as title", () => {
    const md = generateChecklist(sampleResult, "abc123");

    expect(md).toContain("- [ ] **Verify rollback exists**");
    expect(md).toContain("- [ ] **Confirm env vars set**");
    // Description + reasoning on the next line
    expect(md).toContain("Verify migration rollback for migrations/20240115_add_users.sql — New migration file detected.");
    expect(md).toContain("Add DATABASE_URL to production environment — New env var referenced");
  });

  it("includes rule IDs for each item", () => {
    const md = generateChecklist(sampleResult, "abc123");

    expect(md).toContain("_Rule: migration-safety_");
    expect(md).toContain("_Rule: env-var-check_");
  });

  it("includes the risk summary as a blockquote", () => {
    const md = generateChecklist(sampleResult, "abc123");
    expect(md).toContain("> Medium risk");
  });

  it("sorts items by priority (high first)", () => {
    const md = generateChecklist(sampleResult, "abc123");

    const migrationPos = md.indexOf("migration-safety");
    const envPos = md.indexOf("env-var-check");
    expect(migrationPos).toBeLessThan(envPos);
  });

  it("includes footer with re-analysis instructions", () => {
    const md = generateChecklist(sampleResult, "abc123");
    expect(md).toContain("Re-analyze: push a new commit");
  });
});

describe("parseChecklist", () => {
  it("returns null for non-bot comments", () => {
    expect(parseChecklist("Just a regular comment")).toBeNull();
  });

  it("parses unchecked items correctly", () => {
    const md = generateChecklist(sampleResult, "abc123");
    const state = parseChecklist(md);

    expect(state).not.toBeNull();
    expect(state!.sha).toBe("abc123");
    expect(state!.items).toHaveLength(2);
    expect(state!.items.every((i) => !i.checked)).toBe(true);
    expect(state!.allComplete).toBe(false);
  });

  it("parses checked items correctly", () => {
    let md = generateChecklist(sampleResult, "abc123");
    md = md.replace(/- \[ \]/g, "- [x]");

    const state = parseChecklist(md);

    expect(state).not.toBeNull();
    expect(state!.items.every((i) => i.checked)).toBe(true);
    expect(state!.allComplete).toBe(true);
  });

  it("handles partially checked checklists", () => {
    let md = generateChecklist(sampleResult, "abc123");
    md = md.replace("- [ ]", "- [x]");

    const state = parseChecklist(md);

    expect(state).not.toBeNull();
    expect(state!.items.filter((i) => i.checked)).toHaveLength(1);
    expect(state!.items.filter((i) => !i.checked)).toHaveLength(1);
    expect(state!.allComplete).toBe(false);
  });

  it("extracts the SHA from metadata", () => {
    const md = generateChecklist(sampleResult, "def456");
    const state = parseChecklist(md);
    expect(state!.sha).toBe("def456");
  });
});

describe("mergeChecklist", () => {
  it("preserves check state for items that still apply", () => {
    let md = generateChecklist(sampleResult, "abc123");
    md = md.replace("- [ ]", "- [x]");
    const oldState = parseChecklist(md)!;

    const merged = mergeChecklist(oldState, sampleResult, "def456");

    expect(merged).toContain("- [x]");
    expect(merged).toContain("<!-- sha:def456 -->");
  });

  it("adds new items as unchecked", () => {
    const md = generateChecklist(sampleResult, "abc123");
    const oldState = parseChecklist(md)!;

    const newResult: AnalysisResult = {
      items: [
        ...sampleResult.items,
        {
          rule_id: "docker-change",
          check: "Verify base image",
          description: "Check Docker base image is pinned",
          reasoning: "Dockerfile modified.",
          priority: "low",
        },
      ],
      summary: "Updated analysis.",
      uncovered_files: [],
      open_concerns: [],
    };

    const merged = mergeChecklist(oldState, newResult, "def456");

    expect(merged).toContain("docker-change");
    expect(merged).toContain("- [ ] **Verify base image**");
  });

  it("removes items that no longer apply", () => {
    const md = generateChecklist(sampleResult, "abc123");
    const oldState = parseChecklist(md)!;

    const newResult: AnalysisResult = {
      items: [sampleResult.items[1]],
      summary: "Reduced risk.",
      uncovered_files: [],
      open_concerns: [],
    };

    const merged = mergeChecklist(oldState, newResult, "def456");

    expect(merged).not.toContain("migration-safety");
    expect(merged).toContain("env-var-check");
  });
});

describe("isComplete", () => {
  it("returns true when all items are checked", () => {
    let md = generateChecklist(sampleResult, "abc123");
    md = md.replace(/- \[ \]/g, "- [x]");
    expect(isComplete(md)).toBe(true);
  });

  it("returns false when some items are unchecked", () => {
    const md = generateChecklist(sampleResult, "abc123");
    expect(isComplete(md)).toBe(false);
  });

  it("returns true for empty checklists", () => {
    expect(isComplete("no checklist here")).toBe(true);
  });
});
