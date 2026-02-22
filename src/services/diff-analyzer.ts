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
import {
  detectActiveSkills,
  computeUncoveredFiles,
  type Skill,
} from "../skills/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

// ─────────────────────────────────────────────────────────────────────────────
// Tool use definition — submitted to Claude to enforce structured output
// ─────────────────────────────────────────────────────────────────────────────

const SUBMIT_ANALYSIS_TOOL = {
  name: "submit_analysis",
  description: "Submit the structured deploy checklist analysis for this PR.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rule_id:     { type: "string" },
            check:       { type: "string" },
            description: { type: "string" },
            reasoning:   { type: "string" },
            priority:    { type: "string", enum: ["high", "medium", "low"] as string[] },
          },
          required: ["rule_id", "check", "description", "reasoning", "priority"] as string[],
        },
      },
      summary:         { type: "string" },
      uncovered_files: { type: "array", items: { type: "string" } },
      open_concerns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file:    { type: "string" },
            concern: { type: "string" },
          },
          required: ["file", "concern"] as string[],
        },
      },
    },
    required: ["items", "summary"] as string[],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function createAnthropicClient(): Anthropic {
  return new Anthropic();
}

/**
 * Convert Skill[] to Rule[] so truncateDiff and fetchTriggeredFileContents
 * need zero signature changes.
 */
function skillsToRules(skills: Skill[]): Rule[] {
  return skills.map((skill) => ({
    id: skill.id,
    description: skill.name,
    trigger: {
      paths: skill.paths,
      missing_companion: skill.companionPaths,
      include_full_files: skill.includeFullFiles,
    },
    checks: skill.checks,
  }));
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

  // Extract file paths from diff for skill detection and file fetching
  const filesChanged = extractFilesFromDiff(diff);

  // Detect which skills apply to this diff (pre-filtering before Claude)
  const activeSkills = detectActiveSkills(filesChanged, diff);

  // Compute files not covered by any skill's path patterns
  const uncoveredFiles = computeUncoveredFiles(filesChanged, activeSkills);

  // Merge skill-derived rules with user config rules for truncation + file fetching
  const skillRules = skillsToRules(activeSkills);
  const allRulesForTruncation = [...skillRules, ...config.rules];

  // Truncate diff to fit within the token budget, prioritizing skill-matched paths
  const { diff: truncatedDiff } = truncateDiff(
    diff,
    config.settings.max_diff_size,
    allRulesForTruncation
  );

  // Fetch full file contents for skills/rules with include_full_files
  const fileContents = await fetchTriggeredFileContents(
    context,
    repoInfo.owner,
    repoInfo.repo,
    repoInfo.ref,
    allRulesForTruncation,
    filesChanged
  );

  try {
    const userPrompt = buildUserPrompt(
      config,
      prMeta,
      truncatedDiff,
      activeSkills,
      uncoveredFiles,
      fileContents
    );

    const response = await anthropic.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      tools: [SUBMIT_ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: "submit_analysis" },
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === "tool_use"
    );
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      throw new Error("No tool_use block in Claude response");
    }

    // toolUseBlock.input is already a parsed object — no JSON.parse, no fence stripping
    return AnalysisResultSchema.parse(toolUseBlock.input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.log.error(`Analysis failed: ${message}`);
    return null;
  }
}
