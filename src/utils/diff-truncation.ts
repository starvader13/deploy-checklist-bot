import { minimatch } from "minimatch";
import type { Rule } from "../schemas/config.js";

interface DiffFile {
  filename: string;
  content: string;
}

interface TruncationResult {
  diff: string;
  truncated: boolean;
  filesSummarized: string[];
}

/**
 * Parse a unified diff into per-file sections.
 * Splits on "diff --git" headers, re-attaching the header to each section.
 */
function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  // Split removes the "diff --git " prefix — we re-add it below
  const fileSections = diff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const headerMatch = section.match(/a\/(.+?) b\//);
    const filename = headerMatch ? headerMatch[1] : "unknown";
    files.push({ filename, content: `diff --git ${section}` });
  }

  return files;
}

/**
 * Check if a file matches any rule trigger paths.
 * Checks both trigger.paths AND missing_companion patterns — both indicate
 * the file is relevant to a rule and should be prioritized in truncation.
 */
function fileMatchesRules(filename: string, rules: Rule[]): boolean {
  for (const rule of rules) {
    const paths = rule.trigger.paths ?? [];
    const companionPaths = rule.trigger.missing_companion ?? [];
    for (const pattern of [...paths, ...companionPaths]) {
      if (minimatch(filename, pattern, { dot: true })) {
        return true;
      }
    }
  }
  return false;
}

/** Truncate a single file's diff content to maxLines. */
function truncateFileContent(
  content: string,
  maxLines: number = 100
): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + "\n... (truncated)";
}

/**
 * Smart diff truncation that fits a large diff within maxSize characters.
 * Strategy: include rule-triggered files first (they matter most for analysis),
 * then fill remaining space with non-triggered files. Files that don't fit
 * are listed as summaries so Claude knows they exist.
 */
export function truncateDiff(
  diff: string,
  maxSize: number,
  rules: Rule[]
): TruncationResult {
  if (diff.length <= maxSize) {
    return { diff, truncated: false, filesSummarized: [] };
  }

  const files = parseDiffFiles(diff);

  // Separate files by rule relevance — triggered files get priority in the budget
  const triggered: DiffFile[] = [];
  const nonTriggered: DiffFile[] = [];

  for (const file of files) {
    if (fileMatchesRules(file.filename, rules)) {
      triggered.push(file);
    } else {
      nonTriggered.push(file);
    }
  }

  const parts: string[] = [];
  let currentSize = 0;
  const summarized: string[] = [];

  // Triggered files first — they're most relevant for rule evaluation.
  // Each file can use up to 50% of budget; stop adding full files at 90% to leave room for summaries.
  for (const file of triggered) {
    const maxFileSize = Math.floor(maxSize * 0.5);
    const content =
      file.content.length > maxFileSize
        ? truncateFileContent(file.content, 100)
        : file.content;

    if (currentSize + content.length < maxSize * 0.9) {
      parts.push(content);
      currentSize += content.length;
    } else {
      // Over 90% budget — still include triggered file but aggressively truncate to 50 lines
      parts.push(truncateFileContent(file.content, 50));
      currentSize += parts[parts.length - 1].length;
    }
  }

  // Non-triggered files if space remains
  for (const file of nonTriggered) {
    if (currentSize + file.content.length < maxSize) {
      parts.push(file.content);
      currentSize += file.content.length;
    } else {
      summarized.push(file.filename);
    }
  }

  // Append a summary of omitted files so Claude knows what else changed (filenames only)
  if (summarized.length > 0) {
    const summary = `\n# Files omitted from diff (not matching rule triggers):\n${summarized.map((f) => `# - ${f}`).join("\n")}\n`;
    parts.push(summary);
  }

  return {
    diff: parts.join("\n"),
    truncated: true,
    filesSummarized: summarized,
  };
}
