import { parse as parseYaml } from "yaml";
import type { Context } from "probot";
import {
  DeployChecklistConfigSchema,
  DEFAULT_RULES,
  type DeployChecklistConfig,
} from "../schemas/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PATHS = [
  ".github/deploy-checklist.yml",
  ".github/deploy-checklist.yaml",
  ".deploy-checklist.json",
];

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch a file from the repo at a given ref. Returns null on 404. */
async function fetchFileContent(
  context: Context,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await context.octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    // GitHub Contents API returns base64-encoded content for files, arrays for directories
    const data = response.data;
    if ("content" in data && typeof data.content === "string") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === 404
    ) {
      return null;
    }
    throw error;
  }
}

/** Parse config content as YAML or JSON based on file extension. */
function parseConfigContent(
  content: string,
  path: string
): Record<string, unknown> {
  if (path.endsWith(".json")) {
    return JSON.parse(content) as Record<string, unknown>;
  }
  return parseYaml(content) as Record<string, unknown>;
}

/** Build a default config using built-in rules. */
function buildDefaultConfig(): DeployChecklistConfig {
  return {
    version: 1,
    settings: {
      analyze_drafts: false,
      ignore_authors: [],
      target_branches: [],
      post_empty_checklist: false,
      max_diff_size: 100000,
    },
    rules: DEFAULT_RULES,
  };
}

/**
 * Merge user rules with defaults — user rules with the same ID override defaults.
 * Defaults not overridden are kept, so the user gets built-in rules for free.
 */
function mergeWithDefaults(
  config: DeployChecklistConfig
): DeployChecklistConfig {
  const userRuleIds = new Set(config.rules.map((r) => r.id));
  const defaultsToKeep = DEFAULT_RULES.filter(
    (r) => !userRuleIds.has(r.id)
  );

  return {
    ...config,
    rules: [...defaultsToKeep, ...config.rules],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the deploy checklist config for a repo.
 * Tries config paths in order, validates with Zod, merges with defaults.
 * Falls back to defaults on any error and returns an optional warning.
 */
export async function loadConfig(
  context: Context,
  owner: string,
  repo: string,
  ref: string
): Promise<{ config: DeployChecklistConfig; warning?: string }> {
  // Try each config path in priority order — first one found wins
  for (const path of CONFIG_PATHS) {
    const content = await fetchFileContent(context, owner, repo, path, ref);
    if (content === null) continue;

    try {
      const raw = parseConfigContent(content, path);

      // Empty config file = use defaults (user might have an empty .yml placeholder)
      if (!raw || Object.keys(raw).length === 0) {
        return { config: buildDefaultConfig() };
      }

      const parsed = DeployChecklistConfigSchema.parse(raw);
      const merged = mergeWithDefaults(parsed);
      return { config: merged };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        config: buildDefaultConfig(),
        warning:
          `⚠️ **Deploy Checklist Bot**: Failed to parse config file \`${path}\`.\n\n` +
          `Error: ${message}\n\n` +
          `Using default rules instead. ` +
          `Please fix the config file to customize behavior.`,
      };
    }
  }

  // No config file found — use defaults
  return { config: buildDefaultConfig() };
}
