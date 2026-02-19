import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/config-loader.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../src/services/diff-analyzer.js", () => ({
  fetchPRDiff: vi.fn(),
  analyzeDiff: vi.fn(),
  extractFilesFromDiff: vi.fn(),
}));

vi.mock("../../src/services/checklist.js", () => ({
  generateChecklist: vi.fn(),
  parseChecklist: vi.fn(),
  mergeChecklist: vi.fn(),
  isComplete: vi.fn(),
  BOT_MARKER: "<!-- deploy-checklist-bot:v1 -->",
}));

vi.mock("../../src/services/review-manager.js", () => ({
  blockPR: vi.fn(),
  approvePR: vi.fn(),
  postErrorComment: vi.fn(),
}));

vi.mock("../../src/utils/debounce.js", () => ({
  debouncePR: vi.fn((key, delay, callback) => callback()),
  debounceKey: vi.fn(() => "owner/repo#1"),
}));

import { handlePullRequest } from "../../src/handlers/pull-request.js";
import { loadConfig } from "../../src/services/config-loader.js";
import {
  fetchPRDiff,
  analyzeDiff,
  extractFilesFromDiff,
} from "../../src/services/diff-analyzer.js";
import { generateChecklist } from "../../src/services/checklist.js";
import {
  blockPR,
  approvePR,
  postErrorComment,
} from "../../src/services/review-manager.js";

const defaultConfig = {
  config: {
    version: 1,
    settings: {
      analyze_drafts: false,
      ignore_authors: ["dependabot[bot]"],
      target_branches: ["main"],
      post_empty_checklist: false,
      max_diff_size: 100000,
    },
    rules: [],
  },
};

function createMockContext(overrides: Record<string, any> = {}) {
  return {
    payload: {
      action: overrides.action ?? "opened",
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "Test description",
        draft: overrides.draft ?? false,
        user: { login: overrides.author ?? "developer" },
        head: { sha: "abc123" },
        base: { ref: overrides.baseBranch ?? "main" },
        ...overrides.pr,
      },
      repository: {
        owner: { login: "owner" },
        name: "repo",
      },
    },
    octokit: {
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({}),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          updateComment: vi.fn().mockResolvedValue({}),
        },
      },
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (loadConfig as any).mockResolvedValue(defaultConfig);
  (fetchPRDiff as any).mockResolvedValue("diff content");
  (extractFilesFromDiff as any).mockReturnValue(["src/file.ts"]);
  (generateChecklist as any).mockReturnValue("## Deploy Checklist\n...");
});

describe("handlePullRequest — filtering", () => {
  it("skips draft PRs when analyze_drafts is false", async () => {
    const context = createMockContext({ draft: true });
    await handlePullRequest(context);
    expect(analyzeDiff).not.toHaveBeenCalled();
  });

  it("skips PRs from ignored authors", async () => {
    const context = createMockContext({ author: "dependabot[bot]" });
    await handlePullRequest(context);
    expect(analyzeDiff).not.toHaveBeenCalled();
  });

  it("skips PRs targeting non-configured branches", async () => {
    const context = createMockContext({ baseBranch: "develop" });
    await handlePullRequest(context);
    expect(analyzeDiff).not.toHaveBeenCalled();
  });

  it("processes PRs targeting configured branches", async () => {
    const context = createMockContext({ baseBranch: "main" });
    (analyzeDiff as any).mockResolvedValue({
      items: [],
      summary: "Clean",
    });

    await handlePullRequest(context);
    expect(analyzeDiff).toHaveBeenCalled();
  });
});

describe("handlePullRequest — opened event", () => {
  it("posts checklist and blocks PR when items are found", async () => {
    const context = createMockContext();
    (analyzeDiff as any).mockResolvedValue({
      items: [
        {
          rule_id: "test",
          check: "Check",
          description: "Do something",
          reasoning: "Because",
          priority: "high",
        },
      ],
      summary: "Some risk.",
    });

    await handlePullRequest(context);

    expect(context.octokit.rest.issues.createComment).toHaveBeenCalled();
    expect(blockPR).toHaveBeenCalled();
  });

  it("approves PR when no checklist items are found", async () => {
    const context = createMockContext();
    (analyzeDiff as any).mockResolvedValue({
      items: [],
      summary: "No issues.",
    });

    await handlePullRequest(context);

    expect(approvePR).toHaveBeenCalled();
    expect(blockPR).not.toHaveBeenCalled();
  });

  it("posts error comment and does not block on analysis failure", async () => {
    const context = createMockContext();
    (analyzeDiff as any).mockResolvedValue(null);

    await handlePullRequest(context);

    expect(postErrorComment).toHaveBeenCalled();
    expect(blockPR).not.toHaveBeenCalled();
  });
});

describe("handlePullRequest — ignored actions", () => {
  it("ignores unhandled action types", async () => {
    const context = createMockContext({ action: "closed" });
    await handlePullRequest(context);
    expect(analyzeDiff).not.toHaveBeenCalled();
  });
});
