import type { DeployChecklistConfig, Rule } from "../schemas/config.js";
import type { PRMetadata } from "../schemas/analysis-result.js";
import type { Skill } from "../skills/index.js";

export const SYSTEM_PROMPT = `You are a deploy checklist analyzer. You examine pull request diffs and determine which checklist items apply based on active skills and custom rules.

Use the submit_analysis tool to return your findings. Only include items genuinely relevant to the actual changes in the diff.`;

/**
 * Format a single rule into a human-readable string for the prompt.
 * Only includes trigger fields that are set — keeps the prompt clean for simple rules.
 */
function formatRule(rule: Rule): string {
  const parts = [`### Rule: ${rule.id}`, `Description: ${rule.description}`];

  if (rule.trigger.paths?.length) {
    parts.push(`Trigger paths: ${rule.trigger.paths.join(", ")}`);
  }
  if (rule.trigger.content?.length) {
    parts.push(
      `Trigger content patterns: ${rule.trigger.content.join(", ")}`
    );
  }
  // missing_companion tells Claude which companion files are expected alongside trigger files
  // (e.g. migrations alongside entity changes) — always included so Claude can check for them
  if (rule.trigger.missing_companion?.length) {
    parts.push(
      `Expected companion files: ${rule.trigger.missing_companion.join(", ")}`
    );
  }

  parts.push(`Checks:`);
  for (const check of rule.checks) {
    parts.push(`  - ${check}`);
  }

  return parts.join("\n");
}

/**
 * Format a single skill into a human-readable string for the prompt.
 * Includes the systemContext (multi-framework domain knowledge) and checks.
 */
function formatSkill(skill: Skill): string {
  const parts = [`### Skill: ${skill.id}`, skill.systemContext, `Checks:`];
  for (const check of skill.checks) {
    parts.push(`  - ${check}`);
  }
  if (skill.companionPaths?.length) {
    parts.push(
      `Expected companion files: ${skill.companionPaths.join(", ")}`
    );
  }
  return parts.join("\n");
}

/**
 * Build the complete user prompt for Claude analysis.
 * Assembles sections: context → active skills → custom rules → PR info → file contents
 *                    → uncovered files → diff → instructions.
 * The order matters — Claude sees skills/rules before the diff, so it knows what to look for.
 */
export function buildUserPrompt(
  config: DeployChecklistConfig,
  prMeta: PRMetadata,
  diff: string,
  activeSkills: Skill[] = [],
  uncoveredFiles: string[] = [],
  fileContents?: Map<string, string>
): string {
  const sections: string[] = [];

  // Active skills — pre-filtered to only those matching this diff
  if (activeSkills.length > 0) {
    const skillsText = activeSkills.map(formatSkill).join("\n\n");
    sections.push(`## Active Skills\n${skillsText}`);
  }

  // Custom rules from user config (backward compat) — omitted when empty
  if (config.rules.length > 0) {
    const rulesText = config.rules.map(formatRule).join("\n\n");
    sections.push(`## Custom Rules\n${rulesText}`);
  }

  // User-provided repo context comes after skills so it acts as a correction layer —
  // repo-specific facts (e.g. "we use Flyway, rollbacks are automatic") override
  // the generic skill knowledge via recency bias.
  if (config.context) {
    sections.push(`## Repository Context\n${config.context}`);
  }

  sections.push(
    `## PR Information\n` +
      `Title: ${prMeta.title}\n` +
      `Description: ${prMeta.body || "(no description)"}\n` +
      `Base branch: ${prMeta.baseBranch}\n` +
      `Files changed: ${prMeta.filesChanged.join(", ")}`
  );

  // Full file contents for triggered skills/rules (opt-in via includeFullFiles)
  if (fileContents && fileContents.size > 0) {
    const fileSections: string[] = [
      "## Full File Contents (for context)",
      "The following files triggered a skill. Full content provided so you can identify",
      "the framework/ORM and assess whether changes affect the database schema.",
    ];
    for (const [filePath, content] of fileContents) {
      fileSections.push(`\n### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
    sections.push(fileSections.join("\n"));
  }

  // Files not matched by any skill or custom rule — Claude should flag deploy risks
  if (uncoveredFiles.length > 0) {
    const uncoveredSection = [
      "## Files Without Skill Coverage",
      "The following changed files were not matched by any skill or custom rule.",
      "For each, add an entry to open_concerns if you spot a deploy risk:",
      "",
      ...uncoveredFiles.map((f) => `- ${f}`),
    ];
    sections.push(uncoveredSection.join("\n"));
  }

  sections.push(`## Diff\n\`\`\`diff\n${diff}\n\`\`\``);

  sections.push(
    `## Instructions\n` +
      `Use the submit_analysis tool to return your findings.\n` +
      `For each active skill, evaluate its checks against the diff.\n` +
      `Only include items genuinely relevant to the actual changes.\n` +
      `Be specific — reference actual file names, function names, and line numbers from the diff.\n` +
      `For uncovered files, add to open_concerns only if you spot a real deploy risk.`
  );

  return sections.join("\n\n");
}
