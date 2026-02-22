import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Schema
// ─────────────────────────────────────────────────────────────────────────────

export const TriggerSchema = z.object({
  // Glob patterns matched against changed file paths
  paths: z.array(z.string()).optional(),

  // Regex patterns matched against diff content
  content: z.array(z.string()).optional(),

  // Glob patterns for expected companion files — trigger fires when these are MISSING
  missing_companion: z.array(z.string()).optional(),

  // When true, fetch full file contents for matching trigger paths so Claude
  // can identify frameworks/ORMs from imports and decorators (max 5 files, 500 lines each)
  include_full_files: z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule Schema
// ─────────────────────────────────────────────────────────────────────────────

export const RuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  trigger: TriggerSchema,
  checks: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings Schema
// ─────────────────────────────────────────────────────────────────────────────

export const SettingsSchema = z.object({
  analyze_drafts: z.boolean().default(false),
  ignore_authors: z.array(z.string()).default([]),
  target_branches: z.array(z.string()).default([]),
  post_empty_checklist: z.boolean().default(false),
  max_diff_size: z.number().default(100000),
});

// ─────────────────────────────────────────────────────────────────────────────
// Top-Level Config Schema
// ─────────────────────────────────────────────────────────────────────────────

export const DeployChecklistConfigSchema = z.object({
  version: z.number().default(1),

  // Factory function default — Zod needs a new object per parse call, not a shared reference
  settings: SettingsSchema.default(() => ({
    analyze_drafts: false,
    ignore_authors: [],
    target_branches: [],
    post_empty_checklist: false,
    max_diff_size: 100000,
  })),

  rules: z.array(RuleSchema).default([]),
  context: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Inferred TypeScript Types
// ─────────────────────────────────────────────────────────────────────────────

export type Trigger = z.infer<typeof TriggerSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type DeployChecklistConfig = z.infer<typeof DeployChecklistConfigSchema>;

