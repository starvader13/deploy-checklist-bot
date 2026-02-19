import type { DeployChecklistConfig, Rule } from "../schemas/config.js";
import type { PRMetadata } from "../schemas/analysis-result.js";

export const SYSTEM_PROMPT = `You are a deploy checklist analyzer. You examine pull request diffs against a set of deployment rules and determine which checklist items apply.

You respond ONLY with valid JSON matching the specified schema. Do not include any text before or after the JSON. Do not wrap in markdown code fences.`;

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
 * Build the complete user prompt for Claude analysis.
 * Assembles sections: context → rules → PR info → file contents → diff → instructions.
 * The order matters — Claude sees rules before the diff, so it knows what to look for.
 */
export function buildUserPrompt(
  config: DeployChecklistConfig,
  prMeta: PRMetadata,
  diff: string,
  strict: boolean = false,
  fileContents?: Map<string, string>
): string {
  const sections: string[] = [];

  // Optional user-provided context (e.g. "This is a Django monorepo with PostgreSQL")
  if (config.context) {
    sections.push(`## Repository Context\n${config.context}`);
  }

  const rulesText = config.rules.map(formatRule).join("\n\n");
  sections.push(`## Rules\n${rulesText}`);

  sections.push(
    `## PR Information\n` +
      `Title: ${prMeta.title}\n` +
      `Description: ${prMeta.body || "(no description)"}\n` +
      `Base branch: ${prMeta.baseBranch}\n` +
      `Files changed: ${prMeta.filesChanged.join(", ")}`
  );

  // Full file contents for triggered rules (opt-in via include_full_files)
  if (fileContents && fileContents.size > 0) {
    const fileSections: string[] = [
      "## Full File Contents (for context)",
      "The following files triggered a rule. Full content provided so you can identify",
      "the framework/ORM and assess whether changes affect the database schema.",
    ];
    for (const [filePath, content] of fileContents) {
      fileSections.push(`\n### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
    sections.push(fileSections.join("\n"));
  }

  sections.push(`## Diff\n\`\`\`diff\n${diff}\n\`\`\``);

  let instructions =
    `## Instructions\n` +
    `Analyze the diff against each rule. For each rule whose trigger ` +
    `conditions match files in the diff, evaluate each check and determine ` +
    `if it is relevant to the actual changes.\n\n` +
    `Respond with JSON matching this schema:\n` +
    `{\n` +
    `  "items": [\n` +
    `    {\n` +
    `      "rule_id": "string — the rule ID that triggered this item",\n` +
    `      "check": "string — the specific check from the rule",\n` +
    `      "description": "string — a concise, actionable checklist item specific to this PR (reference exact files/lines)",\n` +
    `      "reasoning": "string — brief explanation of why this check is relevant to the changes in this diff",\n` +
    `      "priority": "high | medium | low"\n` +
    `    }\n` +
    `  ],\n` +
    `  "summary": "string — one sentence summarizing overall deploy risk"\n` +
    `}\n\n` +
    `For every rule whose trigger conditions match files in the diff, you MUST ` +
    `include ALL checks from that rule in the output — do not skip any. ` +
    `Even if a check seems already addressed, include it so the deployer can ` +
    `explicitly confirm. Be specific — reference actual file names, function ` +
    `names, and line numbers from the diff.`;

  // On retry attempts, add strict JSON instructions to reduce parse failures
  if (strict) {
    instructions +=
      `\n\nIMPORTANT: Your response must be ONLY valid JSON. ` +
      `No markdown, no code fences, no explanatory text. ` +
      `Start with { and end with }. ` +
      `If no items apply, return: {"items": [], "summary": "No deploy checklist items needed."}`;
  }

  sections.push(instructions);

  return sections.join("\n\n");
}
