import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Claude Response Schemas (validated at runtime)
// ─────────────────────────────────────────────────────────────────────────────

export const ChecklistItemSchema = z.object({
  rule_id: z.string(),
  check: z.string(),
  description: z.string(),
  reasoning: z.string(),
  priority: z.enum(["high", "medium", "low"]),
});

export const AnalysisResultSchema = z.object({
  items: z.array(ChecklistItemSchema),
  summary: z.string(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Inferred TypeScript Types
// ─────────────────────────────────────────────────────────────────────────────

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Plain TypeScript Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface ChecklistItemState {
  item: ChecklistItem;
  checked: boolean;
}

export interface ChecklistState {
  sha: string;
  items: ChecklistItemState[];
  allComplete: boolean;
}

export interface PRMetadata {
  title: string;
  body: string;
  baseBranch: string;
  headSha: string;
  author: string;
  isDraft: boolean;
  filesChanged: string[];
}
