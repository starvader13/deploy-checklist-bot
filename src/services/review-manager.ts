import type { Context } from "probot";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post a REQUEST_CHANGES review to block the PR from merging.
 * Dismisses any existing bot reviews first to avoid stacking multiple reviews.
 */
export async function blockPR(
  context: Context,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  await dismissStaleReviews(context, owner, repo, prNumber);

  await context.octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "REQUEST_CHANGES",
    body,
  });
}

/**
 * Post an APPROVE review to unblock the PR.
 * Dismisses any existing bot CHANGES_REQUESTED reviews first so they don't conflict.
 */
export async function approvePR(
  context: Context,
  owner: string,
  repo: string,
  prNumber: number,
  body?: string
): Promise<void> {
  await dismissStaleReviews(context, owner, repo, prNumber);

  await context.octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "APPROVE",
    body:
      body ||
      "All deploy checklist items have been addressed. Ready to merge.",
  });
}

/**
 * Dismiss all previous CHANGES_REQUESTED reviews authored by this bot.
 * Only touches bot reviews — never human reviews.
 */
export async function dismissStaleReviews(
  context: Context,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  try {
    const { data: reviews } = await context.octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
    });

    // GitHub Apps post reviews as "app-slug[bot]" — look up our app's slug dynamically
    const { data: botUser } =
      await context.octokit.rest.apps.getAuthenticated();
    const botLogin = `${botUser?.slug ?? "deploy-checklist-bot"}[bot]`;

    for (const review of reviews) {
      if (
        review.user?.login === botLogin &&
        review.state === "CHANGES_REQUESTED"
      ) {
        await context.octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id,
          message: "Superseded by updated checklist analysis.",
        });
      }
    }
  } catch (error: unknown) {
    // Non-critical — log and continue
    context.log.warn(
      `Failed to dismiss stale reviews: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Post an error comment without blocking the PR.
 * The bot should never be a merge blocker due to its own failures.
 */
export async function postErrorComment(
  context: Context,
  owner: string,
  repo: string,
  prNumber: number,
  message: string
): Promise<void> {
  try {
    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body:
        `⚠️ **Deploy Checklist Bot**: Analysis could not be completed.\n\n` +
        `${message}\n\n` +
        `The PR has **not** been blocked. Please perform a manual deploy review.\n\n` +
        `_This error has been logged. If it persists, check the bot configuration._`,
    });
  } catch (commentError: unknown) {
    context.log.error(
      `Failed to post error comment: ${commentError instanceof Error ? commentError.message : String(commentError)}`
    );
  }
}
