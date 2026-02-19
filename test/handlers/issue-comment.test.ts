import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/checklist.js", () => ({
  BOT_MARKER: "<!-- deploy-checklist-bot:v1 -->",
  isComplete: vi.fn(),
  parseChecklist: vi.fn(),
}));

vi.mock("../../src/services/review-manager.js", () => ({
  blockPR: vi.fn(),
  approvePR: vi.fn(),
}));

import { handleIssueCommentEdited } from "../../src/handlers/issue-comment.js";
import { parseChecklist } from "../../src/services/checklist.js";
import { blockPR, approvePR } from "../../src/services/review-manager.js";

function createMockContext(overrides: Record<string, any> = {}) {
  return {
    payload: {
      comment: {
        body:
          overrides.commentBody ??
          "<!-- deploy-checklist-bot:v1 -->\n- [x] Item",
        user: { login: "deploy-checklist-bot[bot]" },
      },
      issue: {
        number: 1,
        pull_request: overrides.isPR !== false ? { url: "..." } : undefined,
      },
      repository: {
        owner: { login: "owner" },
        name: "repo",
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
});

describe("handleIssueCommentEdited — filtering", () => {
  it("ignores comments without bot marker", async () => {
    const context = createMockContext({
      commentBody: "Just a regular comment",
    });

    await handleIssueCommentEdited(context);

    expect(parseChecklist).not.toHaveBeenCalled();
    expect(approvePR).not.toHaveBeenCalled();
    expect(blockPR).not.toHaveBeenCalled();
  });

  it("ignores comments on regular issues (not PRs)", async () => {
    const context = createMockContext({ isPR: false });
    await handleIssueCommentEdited(context);
    expect(parseChecklist).not.toHaveBeenCalled();
  });
});

describe("handleIssueCommentEdited — checklist evaluation", () => {
  it("approves PR when all items are checked", async () => {
    const context = createMockContext();
    (parseChecklist as any).mockReturnValue({
      sha: "abc123",
      items: [{ checked: true, item: { rule_id: "test" } }],
      allComplete: true,
    });

    await handleIssueCommentEdited(context);

    expect(approvePR).toHaveBeenCalledWith(context, "owner", "repo", 1);
    expect(blockPR).not.toHaveBeenCalled();
  });

  it("blocks PR when items are unchecked", async () => {
    const context = createMockContext();
    (parseChecklist as any).mockReturnValue({
      sha: "abc123",
      items: [
        { checked: true, item: { rule_id: "test1" } },
        { checked: false, item: { rule_id: "test2" } },
      ],
      allComplete: false,
    });

    await handleIssueCommentEdited(context);

    expect(blockPR).toHaveBeenCalled();
    expect(approvePR).not.toHaveBeenCalled();
  });

  it("does nothing when checklist cannot be parsed", async () => {
    const context = createMockContext();
    (parseChecklist as any).mockReturnValue(null);

    await handleIssueCommentEdited(context);

    expect(approvePR).not.toHaveBeenCalled();
    expect(blockPR).not.toHaveBeenCalled();
  });
});
