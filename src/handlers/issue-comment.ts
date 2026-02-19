import type { Context } from "probot";
import { BOT_MARKER, isComplete, parseChecklist } from "../services/checklist.js";
import { blockPR, approvePR } from "../services/review-manager.js";

/**
 * Handle issue_comment.edited events.
 * GitHub fires this when someone checks/unchecks a checkbox in a comment.
 * We parse the checklist state and approve or re-block the PR accordingly.
 */
export async function handleIssueCommentEdited(
  context: Context<"issue_comment.edited">
): Promise<void> {
  const { comment, issue } = context.payload;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;

  // Only process bot comments on pull requests
  if (!comment.body?.includes(BOT_MARKER)) {
    return;
  }

  // issue_comment fires for both issues and PRs — skip regular issues
  if (!("pull_request" in issue) || !issue.pull_request) {
    return;
  }

  const prNumber = issue.number;

  context.log.info(
    `Processing checklist edit on ${owner}/${repo}#${prNumber}`
  );

  const state = parseChecklist(comment.body ?? "");
  if (!state) {
    context.log.warn(
      `Could not parse checklist from comment on PR #${prNumber}`
    );
    return;
  }

  const checkedCount = state.items.filter((i) => i.checked).length;
  const totalCount = state.items.length;
  context.log.info(
    `Checklist status: ${checkedCount}/${totalCount} items checked`
  );

  if (state.allComplete) {
    context.log.info(`All items checked on PR #${prNumber} — approving`);
    await approvePR(context, owner, repo, prNumber);
  } else {
    context.log.info(
      `${totalCount - checkedCount} unchecked items on PR #${prNumber} — blocking`
    );
    await blockPR(
      context,
      owner,
      repo,
      prNumber,
      `Deploy checklist has ${totalCount - checkedCount} unchecked item(s). Please address all items before merging.`
    );
  }
}
