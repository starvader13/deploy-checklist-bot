import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "probot";
import {
  AnalysisResultSchema,
  type AnalysisResult,
  type PRMetadata,
} from "../schemas/analysis-result.js";
import type { DeployChecklistConfig, Rule } from "../schemas/config.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompts/analysis.js";
import { truncateDiff } from "../utils/diff-truncation.js";
import { minimatch } from "minimatch";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function createAnthropicClient(): Anthropic {
  return new Anthropic();
}

/** Fetch the raw unified diff for a PR using the GitHub diff media type. */
export async function fetchPRDiff(
  context: Context,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string> {
  // mediaType: "diff" tells GitHub to return raw unified diff text instead of JSON
  const response = await context.octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });

  // Octokit types this as PullRequest JSON, but with diff format it's actually a string
  return response.data as unknown as string;
}

/** Extract file paths from diff --git headers. */
export function extractFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  const regex = /^diff --git a\/(.+?) b\//gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(diff)) !== null) {
    files.push(match[1]);
  }

  return [...new Set(files)];
}

/**
 * Parse Claude's response into a validated AnalysisResult.
 * Claude sometimes wraps JSON in markdown code fences despite being told not to — strip them first.
 * Zod validation ensures the response matches the expected schema; throws on invalid shape.
 */
function parseAnalysisResponse(responseText: string): AnalysisResult {
  let cleaned = responseText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned);
  return AnalysisResultSchema.parse(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full file content fetching
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FULL_FILES = 5;
const MAX_LINES_PER_FILE = 500;

/**
 * Fetch full file contents for files that triggered rules with `include_full_files: true`.
 * Returns Map<filename, content> — max 5 files, 500 lines each, 404s silently skipped.
 */
export async function fetchTriggeredFileContents(
  context: Context,
  owner: string,
  repo: string,
  ref: string,
  rules: Rule[],
  filesChanged: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  // Collect path patterns from rules with include_full_files
  const patterns: string[] = [];
  for (const rule of rules) {
    if (rule.trigger.include_full_files && rule.trigger.paths?.length) {
      patterns.push(...rule.trigger.paths);
    }
  }

  if (patterns.length === 0) return result;

  // Find changed files matching those patterns, capped at MAX_FULL_FILES
  const matchingFiles = filesChanged.filter((file) =>
    patterns.some((pattern) => minimatch(file, pattern, { dot: true }))
  );
  const filesToFetch = matchingFiles.slice(0, MAX_FULL_FILES);

  // Fetch each file via GitHub Contents API, base64-decode, and truncate
  for (const filePath of filesToFetch) {
    try {
      const response = await context.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      });

      // GitHub Contents API returns file content as base64-encoded string for files,
      // but returns an array for directories — the "content" check filters to files only
      const data = response.data;
      if ("content" in data && typeof data.content === "string") {
        const fullContent = Buffer.from(data.content, "base64").toString("utf-8");
        const lines = fullContent.split("\n");
        const truncated =
          lines.length > MAX_LINES_PER_FILE
            ? lines.slice(0, MAX_LINES_PER_FILE).join("\n") +
              `\n... (truncated, ${lines.length - MAX_LINES_PER_FILE} more lines)`
            : fullContent;
        result.set(filePath, truncated);
      }
    } catch (error: unknown) {
      // 404 = file was deleted or doesn't exist at this ref — skip silently
      // Any other error (permissions, network) should propagate
      if (
        error instanceof Error &&
        "status" in error &&
        (error as { status: number }).status === 404
      ) {
        continue;
      }
      throw error;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a PR diff to Claude for analysis and get back structured checklist items.
 * Returns null on unrecoverable failure — caller should post error comment, not block PR.
 */
export async function analyzeDiff(
  context: Context,
  diff: string,
  config: DeployChecklistConfig,
  prMeta: PRMetadata,
  repoInfo: { owner: string; repo: string; ref: string }
): Promise<AnalysisResult | null> {
  const anthropic = createAnthropicClient();
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  // Truncate diff to fit within the token budget
  const { diff: truncatedDiff } = truncateDiff(
    diff,
    config.settings.max_diff_size,
    config.rules
  );

  // Extract file paths from diff for pattern matching and file fetching
  const filesChanged = extractFilesFromDiff(diff);

  // Fetch full file contents for rules with include_full_files (e.g. entity/model files)
  const fileContents = await fetchTriggeredFileContents(
    context,
    repoInfo.owner,
    repoInfo.repo,
    repoInfo.ref,
    config.rules,
    filesChanged
  );

  // Try analysis with retries on parse failures
  let lastError: Error | null = null;

  // Retry loop: on parse failures, re-prompt with strict JSON instructions.
  // Auth errors (401/403) are unrecoverable, so we break immediately.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // isRetry=true adds strict "respond with JSON only" instructions to reduce parse failures
      const isRetry = attempt > 0;
      const userPrompt = buildUserPrompt(
        config,
        prMeta,
        truncatedDiff,
        isRetry,
        fileContents
      );

      const response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      });

      // Claude response has content blocks (text, tool_use, etc.) — extract the text block
      const textBlock = response.content.find(
        (block) => block.type === "text"
      );
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text content in Claude response");
      }

      // Parse the JSON response and validate against the Zod schema
      return parseAnalysisResponse(textBlock.text);
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      context.log.warn(
        `Analysis attempt ${attempt + 1} failed: ${lastError.message}`
      );

      // Don't retry on auth errors
      if (
        lastError.message.includes("401") ||
        lastError.message.includes("403")
      ) {
        break;
      }
    }
  }

  context.log.error(
    `Analysis failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`
  );
  return null;
}
