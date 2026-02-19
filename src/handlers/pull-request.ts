import type { Context } from "probot";
import { loadConfig } from "../services/config-loader.js";
import {
  fetchPRDiff,
  analyzeDiff,
  extractFilesFromDiff,
} from "../services/diff-analyzer.js";
import {
  generateChecklist,
  parseChecklist,
  mergeChecklist,
  BOT_MARKER,
} from "../services/checklist.js";
import {
  blockPR,
  approvePR,
  postErrorComment,
} from "../services/review-manager.js";
import { debouncePR, debounceKey } from "../utils/debounce.js";
import type { PRMetadata, AnalysisResult } from "../schemas/analysis-result.js";
import type { DeployChecklistConfig } from "../schemas/config.js";

type PR = Context<"pull_request">["payload"]["pull_request"];

const DEFAULT_DEBOUNCE_MS = 5000;

/** Fetch diff, build metadata, and run analysis. Returns null on failure. */
async function fetchAndAnalyze(
  context: Context<"pull_request">,
  owner: string,
  repo: string,
  pr: PR,
  config: DeployChecklistConfig
): Promise<AnalysisResult | null> {
  const diff = await fetchPRDiff(context, owner, repo, pr.number);
  const filesChanged = extractFilesFromDiff(diff);

  const prMeta: PRMetadata = {
    title: pr.title,
    body: pr.body ?? "",
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    author: pr.user?.login ?? "",
    isDraft: pr.draft ?? false,
    filesChanged,
  };

  return analyzeDiff(context, diff, config, prMeta, {
    owner,
    repo,
    ref: pr.head.sha,
  });
}

/** Main handler for pull_request webhook events. Applies filters then routes to sub-handler. */
export async function handlePullRequest(
  context: Context<"pull_request">
): Promise<void> {
  const { action } = context.payload;
  const pr = context.payload.pull_request;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;

  context.log.info(
    `Processing pull_request.${action} for ${owner}/${repo}#${pr.number}`
  );

  // Load config from the PR's head commit (not base) so config changes in the PR take effect
  const { config, warning } = await loadConfig(
    context,
    owner,
    repo,
    pr.head.sha
  );

  // Config parse failures return a warning string — post it so the author knows
  if (warning) {
    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: warning,
    });
  }

  // Apply filters — skip PRs that don't need analysis (drafts, ignored authors, non-target branches)
  if (pr.draft && !config.settings.analyze_drafts) {
    context.log.info(`Skipping draft PR #${pr.number}`);
    return;
  }

  const author = pr.user?.login ?? "";
  if (config.settings.ignore_authors.includes(author)) {
    context.log.info(`Skipping PR from ignored author: ${author}`);
    return;
  }

  if (config.settings.target_branches.length > 0) {
    if (!config.settings.target_branches.includes(pr.base.ref)) {
      context.log.info(
        `Skipping PR targeting non-configured branch: ${pr.base.ref}`
      );
      return;
    }
  }

  // Route: opened/reopened/ready_for_review = fresh analysis
  //        synchronize (new commits pushed) = re-analysis with state preservation
  switch (action) {
    case "opened":
    case "reopened":
    case "ready_for_review":
      await handleNewAnalysis(context, owner, repo, pr, config);
      break;
    case "synchronize":
      await handleReanalysis(context, owner, repo, pr, config);
      break;
    default:
      context.log.info(`Ignoring pull_request.${action} event`);
  }
}

/** Handle a new PR: fetch diff → analyze → generate checklist → post comment → submit review */
async function handleNewAnalysis(
  context: Context<"pull_request">,
  owner: string,
  repo: string,
  pr: PR,
  config: DeployChecklistConfig
): Promise<void> {
  try {
    const result = await fetchAndAnalyze(context, owner, repo, pr, config);

    // null result means all retries exhausted — post error but don't block the PR
    if (!result) {
      await postErrorComment(
        context,
        owner,
        repo,
        pr.number,
        "Claude analysis failed after multiple retries."
      );
      return;
    }

    // No checklist items needed — auto-approve (optionally post empty checklist for visibility)
    if (result.items.length === 0) {
      if (config.settings.post_empty_checklist) {
        await context.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body:
            `## Deploy Checklist\n\n${BOT_MARKER}\n\n` +
            `No deploy checklist items identified for this PR. ✅\n\n` +
            `> ${result.summary}`,
        });
      }
      await approvePR(
        context,
        owner,
        repo,
        pr.number,
        "No deploy checklist items needed for this PR."
      );
      return;
    }

    const checklistBody = generateChecklist(result, pr.head.sha);
    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: checklistBody,
    });

    await blockPR(
      context,
      owner,
      repo,
      pr.number,
      `Deploy checklist has ${result.items.length} item(s) to address before merging.`
    );
  } catch (error: unknown) {
    context.log.error(
      `Error in handleNewAnalysis: ${error instanceof Error ? error.message : String(error)}`
    );
    await postErrorComment(
      context,
      owner,
      repo,
      pr.number,
      "An unexpected error occurred during analysis."
    );
  }
}

/**
 * Handle re-analysis when new commits are pushed (synchronize event).
 * Debounces rapid pushes (e.g. force-push + amend) so we only analyze once.
 * Preserves the user's checked items from the existing checklist comment.
 */
async function handleReanalysis(
  context: Context<"pull_request">,
  owner: string,
  repo: string,
  pr: PR,
  config: DeployChecklistConfig
): Promise<void> {
  const debounceMs = parseInt(
    process.env.ANALYSIS_DEBOUNCE_MS ?? String(DEFAULT_DEBOUNCE_MS),
    10
  );

  const key = debounceKey(owner, repo, pr.number);

  // Wrap in debounce — if another push arrives within debounceMs,
  // this callback is cancelled and replaced by the new one
  debouncePR(key, debounceMs, async () => {
    try {
      // Find existing bot comment — we'll merge its check state into the new analysis
      const existingComment = await findBotComment(
        context,
        owner,
        repo,
        pr.number
      );

      const result = await fetchAndAnalyze(context, owner, repo, pr, config);

      if (!result) {
        await postErrorComment(
          context,
          owner,
          repo,
          pr.number,
          "Re-analysis failed after new commits were pushed."
        );
        return;
      }

      // No items after re-analysis — clear the old checklist and approve
      if (result.items.length === 0) {
        if (existingComment) {
          await context.octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existingComment.id,
            body:
              `## Deploy Checklist\n\n${BOT_MARKER}\n\n` +
              `No deploy checklist items identified after re-analysis. ✅\n\n` +
              `> ${result.summary}`,
          });
        }
        await approvePR(
          context,
          owner,
          repo,
          pr.number,
          "No deploy checklist items needed after re-analysis."
        );
        return;
      }

      // Merge old check state with new analysis — preserves user's checked items
      // across re-analyses so they don't lose progress when pushing new commits
      let checklistBody: string;
      if (existingComment) {
        const oldState = parseChecklist(existingComment.body ?? "");
        if (oldState) {
          // Matching items keep their checked state; new items start unchecked
          checklistBody = mergeChecklist(oldState, result, pr.head.sha);
        } else {
          checklistBody = generateChecklist(result, pr.head.sha);
        }

        await context.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: checklistBody,
        });
      } else {
        checklistBody = generateChecklist(result, pr.head.sha);
        await context.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: checklistBody,
        });
      }

      // Block/approve based on checkbox state in the generated markdown
      const hasUnchecked = checklistBody.includes("- [ ]");
      if (hasUnchecked) {
        await blockPR(
          context,
          owner,
          repo,
          pr.number,
          `Deploy checklist updated — ${result.items.length} item(s) to address.`
        );
      } else {
        await approvePR(context, owner, repo, pr.number);
      }
    } catch (error: unknown) {
      context.log.error(
        `Error in handleReanalysis: ${error instanceof Error ? error.message : String(error)}`
      );
      await postErrorComment(
        context,
        owner,
        repo,
        pr.number,
        "An unexpected error occurred during re-analysis."
      );
    }
  });
}

/**
 * Find the bot's existing checklist comment on a PR.
 * Searches by BOT_MARKER (hidden HTML comment) — there should only be one per PR.
 * Returns null if no bot comment exists yet (e.g. first analysis on a new PR).
 */
async function findBotComment(
  context: Context,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ id: number; body: string | undefined } | null> {
  const { data: comments } = await context.octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const botComment = comments.find(
    (c: { body?: string | null }) => c.body && c.body.includes(BOT_MARKER)
  );

  return botComment
    ? { id: botComment.id, body: botComment.body ?? undefined }
    : null;
}
