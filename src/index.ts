import type { Probot } from "probot";
import { handlePullRequest } from "./handlers/pull-request.js";
import { handleIssueCommentEdited } from "./handlers/issue-comment.js";

export default function app(probotApp: Probot): void {
  probotApp.log.info("Deploy Checklist Bot is running!");

  // Pull request events trigger diff analysis
  probotApp.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
      "pull_request.ready_for_review",
    ],
    handlePullRequest
  );

  // Comment edits trigger checkbox completion evaluation
  probotApp.on("issue_comment.edited", handleIssueCommentEdited);
}
