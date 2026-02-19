import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  blockPR,
  approvePR,
  dismissStaleReviews,
  postErrorComment,
} from "../../src/services/review-manager.js";

function createMockContext() {
  return {
    octokit: {
      rest: {
        pulls: {
          createReview: vi.fn().mockResolvedValue({}),
          listReviews: vi.fn().mockResolvedValue({ data: [] }),
          dismissReview: vi.fn().mockResolvedValue({}),
        },
        apps: {
          getAuthenticated: vi.fn().mockResolvedValue({
            data: { slug: "deploy-checklist-bot" },
          }),
        },
        issues: {
          createComment: vi.fn().mockResolvedValue({}),
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

describe("blockPR", () => {
  it("creates a REQUEST_CHANGES review", async () => {
    const context = createMockContext();

    await blockPR(context, "owner", "repo", 1, "Please address items.");

    expect(context.octokit.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 1,
      event: "REQUEST_CHANGES",
      body: "Please address items.",
    });
  });

  it("dismisses stale reviews before blocking", async () => {
    const context = createMockContext();

    context.octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        {
          id: 42,
          user: { login: "deploy-checklist-bot[bot]" },
          state: "CHANGES_REQUESTED",
        },
      ],
    });

    await blockPR(context, "owner", "repo", 1, "Blocked.");

    expect(context.octokit.rest.pulls.dismissReview).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 1,
      review_id: 42,
      message: "Superseded by updated checklist analysis.",
    });
  });
});

describe("approvePR", () => {
  it("creates an APPROVE review with default message", async () => {
    const context = createMockContext();

    await approvePR(context, "owner", "repo", 1);

    expect(context.octokit.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 1,
      event: "APPROVE",
      body: "All deploy checklist items have been addressed. Ready to merge.",
    });
  });

  it("creates an APPROVE review with custom message", async () => {
    const context = createMockContext();

    await approvePR(context, "owner", "repo", 1, "Looks good!");

    expect(context.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "APPROVE",
        body: "Looks good!",
      })
    );
  });
});

describe("dismissStaleReviews", () => {
  it("only dismisses bot reviews, not human reviews", async () => {
    const context = createMockContext();

    context.octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        {
          id: 1,
          user: { login: "deploy-checklist-bot[bot]" },
          state: "CHANGES_REQUESTED",
        },
        {
          id: 2,
          user: { login: "human-reviewer" },
          state: "CHANGES_REQUESTED",
        },
      ],
    });

    await dismissStaleReviews(context, "owner", "repo", 1);

    expect(context.octokit.rest.pulls.dismissReview).toHaveBeenCalledTimes(1);
    expect(context.octokit.rest.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 1 })
    );
  });

  it("does not throw on API errors", async () => {
    const context = createMockContext();

    context.octokit.rest.pulls.listReviews.mockRejectedValue(
      new Error("API error")
    );

    await expect(
      dismissStaleReviews(context, "owner", "repo", 1)
    ).resolves.not.toThrow();

    expect(context.log.warn).toHaveBeenCalled();
  });
});

describe("postErrorComment", () => {
  it("posts a warning comment that does not block the PR", async () => {
    const context = createMockContext();

    await postErrorComment(context, "owner", "repo", 1, "Analysis timed out.");

    expect(context.octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        issue_number: 1,
      })
    );

    const body =
      context.octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("not");
    expect(body).toContain("blocked");
  });

  it("handles comment creation failure gracefully", async () => {
    const context = createMockContext();
    context.octokit.rest.issues.createComment.mockRejectedValue(
      new Error("API failure")
    );

    await expect(
      postErrorComment(context, "owner", "repo", 1, "Error")
    ).resolves.not.toThrow();

    expect(context.log.error).toHaveBeenCalled();
  });
});
