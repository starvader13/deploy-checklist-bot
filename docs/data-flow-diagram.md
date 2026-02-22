# Deploy Checklist Bot — Data Flow Diagram (DFD)

This document describes the complete data flow through the Deploy Checklist Bot
at multiple levels of abstraction, from a high-level context view down to
detailed internal process flows.

---

## Table of Contents

1. [Level 0 — Context Diagram](#level-0--context-diagram)
2. [Level 1 — System Overview](#level-1--system-overview)
3. [Level 2 — Process Decomposition](#level-2--process-decomposition)
   - [2.1 Webhook Handler](#21-webhook-handler)
   - [2.2 Config Loader](#22-config-loader)
   - [2.3 Diff Analyzer](#23-diff-analyzer)
   - [2.4 Checklist Service](#24-checklist-service)
   - [2.5 Review Manager](#25-review-manager)
4. [Data Store Descriptions](#data-store-descriptions)
5. [Data Flow Descriptions](#data-flow-descriptions)
6. [Flow Walkthroughs](#flow-walkthroughs)
   - [Flow A: PR Opened (Full Analysis)](#flow-a-pr-opened-full-analysis)
   - [Flow B: Checklist Item Checked Off](#flow-b-checklist-item-checked-off)
   - [Flow C: New Commits Pushed (Re-analysis)](#flow-c-new-commits-pushed-re-analysis)
7. [Error Flows](#error-flows)

---

## Level 0 — Context Diagram

The highest-level view. Shows the bot as a single process interacting with
three external entities.

```
 ┌────────────────┐                                          ┌────────────────┐
 │                │   D1: Webhook Event                      │                │
 │   Developer    │──(opens/updates PR,──────────────────────│    GitHub      │
 │                │    checks checkbox)                      │   Platform     │
 │                │                                          │                │
 │                │◄──D8: PR Status ─────────────────────────│                │
 │                │   (blocked/approved)                     │                │
 └────────────────┘                                          └───────┬────────┘
                                                                     │
                                                      D2: Webhook    │  D7: Review +
                                                      Payload        │  Comment
                                                         │           │     │
                                                         ▼           │     │
                                                   ┌─────────────┐   │     │
                                                   │             │   │     │
                                                   │  Deploy     │───┘     │
                                                   │  Checklist  │◄────────┘
                                                   │  Bot        │
                                                   │             │──────────────┐
                                                   └──────┬──────┘              │
                                                          │                     │
                                                   D5: Diff +            D3: Config
                                                   Prompt               File Request
                                                          │                     │
                                                          ▼                     ▼
                                                   ┌─────────────┐    ┌────────────────┐
                                                   │  Claude AI  │    │   Repository   │
                                                   │  (Anthropic)│    │   File Store   │
                                                   └─────────────┘    └────────────────┘
                                                          │                     │
                                                   D6: Checklist         D4: Config
                                                   Items (JSON)          Content (YAML/JSON)
```

### External Entities

| Entity              | Description                                                                 |
|---------------------|-----------------------------------------------------------------------------|
| **Developer**       | Human user who opens PRs, pushes commits, and checks off checklist items    |
| **GitHub Platform** | Hosts repositories, sends webhooks, receives API calls for reviews/comments |
| **Claude AI**       | Anthropic's LLM API that analyzes diffs and returns structured checklist items |
| **Repository File Store** | The repo's file tree (accessed via GitHub Contents API for config files) |

### Data Flows (Level 0)

| ID | Flow                    | From → To                  | Description                                                    |
|----|-------------------------|----------------------------|----------------------------------------------------------------|
| D1 | Webhook Event           | Developer → GitHub         | Developer action triggers a GitHub webhook event               |
| D2 | Webhook Payload         | GitHub → Bot               | JSON payload with event type, PR data, comment data            |
| D3 | Config File Request     | Bot → Repository           | GitHub Contents API call to read `.github/deploy-checklist.yml`|
| D4 | Config Content          | Repository → Bot           | Raw YAML/JSON config file content (base64 encoded)             |
| D5 | Diff + Prompt           | Bot → Claude AI            | Structured prompt with diff, rules, and PR metadata            |
| D6 | Checklist Items         | Claude AI → Bot            | JSON response with checklist items, priorities, reasoning       |
| D7 | Review + Comment        | Bot → GitHub               | PR review (APPROVE/REQUEST_CHANGES) and checklist comment       |
| D8 | PR Status               | GitHub → Developer         | Updated merge status (blocked or approved)                      |

---

## Level 1 — System Overview

Decomposes the bot into its five major internal processes and shows
data flowing between them and to/from external entities.

```
                                  D2: Webhook Payload
                                  (PR event or comment edit)
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │  P1: Webhook        │
                              │      Handler        │
                              │                     │
                              │  - Route by event   │
                              │  - Filter (drafts,  │
                              │    authors,branches)│
                              │  - Debounce pushes  │
                              └──┬──────┬───────┬───┘
                                 │      │       │
               ┌─────────────────┘      │       └─────────────────────┐
               │                        │                             │
      D9: Config              D11: PR Number +              D15: Comment Body
      Request                 Diff Request                  (with checkboxes)
               │                        │                             │
               ▼                        ▼                             ▼
    ┌──────────────────┐   ┌──────────────────────┐     ┌──────────────────────┐
    │  P2: Config      │   │  P3: Diff Analyzer   │     │  P4: Checklist       │
    │      Loader      │   │                      │     │      Service         │
    │                  │   │  - Fetch PR diff     │     │                      │
    │  - Resolve file  │   │  - Truncate diff     │     │  - Generate markdown │
    │  - Parse YAML/   │   │  - Build prompt      │     │  - Parse checkboxes  │
    │    JSON          │   │  - Call Claude API   │     │  - Merge old + new   │
    │  - Validate Zod  │   │  - Parse JSON result │     │  - Check completion  │
    │  - Merge defaults│   │  - Retry on failure  │     │                      │
    └────────┬─────────┘   └───┬──────────┬───────┘     └──────────┬───────────┘
             │                 │          │                         │
      D10: Validated      D5: Diff +   D6: Checklist          D16: Checklist
      Config              Prompt       Items (JSON)            State (parsed)
             │                 │          │                         │
             │                 ▼          │                         │
             │          ┌───────────┐     │                         │
             │          │ Claude AI │     │                         │
             │          └───────────┘     │                         │
             │                            │                         │
             │         D13: Analysis      │                         │
             └──────►  Result             │                         │
                       (items + summary)  │                         │
                            │             │                         │
                            ▼             ▼                         ▼
                    ┌───────────────────────────────────────────────────┐
                    │  P5: Review Manager                               │
                    │                                                   │
                    │  - Dismiss stale bot reviews                      │
                    │  - Post REQUEST_CHANGES or APPROVE review         │
                    │  - Post/update checklist comment                  │
                    │  - Post error comments (never block on errors)    │
                    └──────────────────────┬────────────────────────────┘
                                           │
                                    D7: Review + Comment
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │   GitHub    │
                                    │   Platform  │
                                    └─────────────┘
```

### Processes (Level 1)

| Process | Name               | Responsibility                                                          |
|---------|--------------------|-------------------------------------------------------------------------|
| P1      | Webhook Handler    | Receives GitHub webhook events, applies filtering and routing logic     |
| P2      | Config Loader      | Fetches, parses, and validates the repo's deploy-checklist config       |
| P3      | Diff Analyzer      | Fetches PR diffs, sends to Claude for analysis, parses structured output|
| P4      | Checklist Service  | Generates markdown checklists, parses checkbox state, merges old/new    |
| P5      | Review Manager     | Manages GitHub PR reviews (block/approve) and posts/updates comments    |

### Data Flows (Level 1)

| ID  | Flow                    | From → To         | Description                                                       |
|-----|-------------------------|-------------------|-------------------------------------------------------------------|
| D9  | Config Request          | P1 → P2           | Owner, repo, SHA to load config from                              |
| D10 | Validated Config        | P2 → P1, P3       | Parsed `DeployChecklistConfig` with merged defaults               |
| D11 | PR Number + Diff Req    | P1 → P3           | PR identifier for fetching diff from GitHub API                   |
| D12 | Raw Diff                | GitHub → P3       | Unified diff content (via `Accept: application/vnd.github.diff`)  |
| D13 | Analysis Result         | P3 → P4, P5       | `AnalysisResult` with checklist items, priorities, summary        |
| D14 | Checklist Markdown      | P4 → P5           | Rendered markdown string with checkboxes and metadata             |
| D15 | Comment Body            | P1 → P4           | Existing comment text (for parsing on `issue_comment.edited`)     |
| D16 | Checklist State         | P4 → P5           | `ChecklistState` with checked/unchecked items and completion flag |

---

## Level 2 — Process Decomposition

### 2.1 Webhook Handler

Decomposes **P1** into its internal sub-processes.

```
                         D2: Webhook Payload
                                │
                                ▼
                    ┌───────────────────────┐
                    │ P1.1: Event Router    │
                    │                       │
                    │ Routes by event type: │
                    │ - pull_request.*      │
                    │ - issue_comment.edited│
                    └───────┬───────┬───────┘
                            │       │
              ┌─────────────┘       └──────────────┐
              │                                    │
              ▼                                    ▼
  ┌────────────────────────┐          ┌────────────────────────┐
  │ P1.2: PR Event Filter  │          │ P1.5: Comment Filter   │
  │                        │          │                        │
  │ Checks:                │          │ Checks:                │
  │ - Is draft PR?         │          │ - Has BOT_MARKER?      │
  │ - Is ignored author?   │          │ - Is on a PR (not      │
  │ - Is target branch     │          │   a regular issue)?    │
  │   configured?          │          │                        │
  └───────────┬────────────┘          └───────────┬────────────┘
              │                                    │
              │ (passes filter)                    │ (passes filter)
              ▼                                    │
  ┌────────────────────────┐                       │
  │ P1.3: Action Router    │                       │
  │                        │                       │
  │ Routes by PR action:   │                       │
  │ - opened/reopened/     │                       │
  │   ready_for_review     │                       │
  │   → handleNewAnalysis  │                       │
  │ - synchronize          │                       │
  │   → handleReanalysis   │                       │
  └───────┬────────┬───────┘                       │
          │        │                               │
          │        ▼                               │
          │  ┌──────────────────┐                  │
          │  │ P1.4: Debounce   │                  │
          │  │ Manager          │                  │
          │  │                  │                  │
          │  │ - Key: owner/    │                  │
          │  │   repo#number    │                  │
          │  │ - Delay: 5000ms  │                  │
          │  │ - Cancel older   │                  │
          │  │   pending runs   │                  │
          │  └────────┬─────────┘                  │
          │           │                            │
          ▼           ▼                            ▼
      (to P2, P3)  (to P2, P3)              (to P4: parse
                                             checklist state)
```

### Sub-Process Data Flows

| Flow          | Description                                                                      |
|---------------|----------------------------------------------------------------------------------|
| Webhook → P1.1 | Raw webhook JSON payload with `action`, `pull_request`, or `comment` fields     |
| P1.1 → P1.2  | PR payload for filtering (draft status, author login, base branch)               |
| P1.1 → P1.5  | Comment payload for bot-marker and PR-context filtering                          |
| P1.2 → P1.3  | Filtered PR payload (only PRs that pass all filters)                             |
| P1.3 → P1.4  | `synchronize` events go through debounce before re-analysis                      |
| P1.4 → P3    | Debounced signal to proceed with re-analysis (latest SHA only)                   |

---

### 2.2 Config Loader

Decomposes **P2** into its internal sub-processes.

```
         D9: Config Request
         (owner, repo, SHA)
                │
                ▼
    ┌───────────────────────┐
    │ P2.1: File Resolver   │
    │                       │
    │ Tries in order:       │       D3: GitHub Contents API
    │ 1. deploy-checklist   │─────────────────────────────────►  GitHub
    │    .yml               │                                     │
    │ 2. deploy-checklist   │◄────────────────────────────────── D4: File
    │    .yaml              │       Content (base64)              Content
    │ 3. .deploy-checklist  │                                 (or 404)
    │    .json              │
    └───────────┬───────────┘
                │
                │ Raw file content (string)
                │ or null (no file found)
                ▼
    ┌───────────────────────┐
    │ P2.2: Content Parser  │
    │                       │
    │ - Detect format       │
    │   (YAML or JSON)      │
    │ - Parse to JS object  │
    │ - Handle parse errors │
    └───────────┬───────────┘
                │
                │ Parsed JS object (unvalidated)
                ▼
    ┌───────────────────────┐
    │ P2.3: Schema          │
    │       Validator       │
    │                       │
    │ - Validate against    │
    │   Zod schema          │
    │ - Extract validation  │
    │   errors              │
    └───────────┬───────────┘
                │
                │ Valid config or validation errors
                ▼
    ┌───────────────────────┐
    │ P2.4: Default Merger  │
    │                       │
    │ - If no file → use    │
    │   all 4 default rules │
    │ - If valid file →     │
    │   merge user rules    │
    │   with defaults       │
    │ - Same rule ID →      │
    │   user version wins   │
    └───────────┬───────────┘
                │
                ▼
         D10: Validated Config
         (DeployChecklistConfig)
         + optional warning string
```

### Data Stores Involved

| Store                       | Content                                            |
|-----------------------------|-----------------------------------------------------|
| **DS1: Default Rules**      | 4 built-in rules (migration, env-var, CI/CD, deps) stored in `config.ts` |
| **DS2: Zod Schema**         | `DeployChecklistConfigSchema` used for validation   |

---

### 2.3 Diff Analyzer

Decomposes **P3** into its internal sub-processes.

```
         D11: PR Number + Config
                │
                ▼
    ┌───────────────────────┐         D12: Raw Diff
    │ P3.1: Diff Fetcher    │◄─────────────────────── GitHub API
    │                       │────────────────────────► (GET /pulls/{n}
    │ - GET PR diff via     │  Accept: application/     with diff header)
    │   GitHub API          │  vnd.github.diff
    │ - Extract file list   │
    └───────────┬───────────┘
                │
                │ Raw unified diff string
                │ + list of files changed
                ▼
    ┌───────────────────────┐
    │ P3.2: Diff Truncator  │
    │                       │
    │ - Check against       │         ┌──────────────────────┐
    │   max_diff_size       │◄────────│ DS3: Rule Trigger    │
    │ - Split into per-file │         │      Paths           │
    │   sections            │         └──────────────────────┘
    │ - Prioritize files    │
    │   matching triggers   │
    │ - Summarize omitted   │
    │   files               │
    └───────────┬───────────┘
                │
                │ Truncated diff (fits token budget)
                ▼
    ┌───────────────────────┐
    │ P3.3: Prompt Builder  │
    │                       │
    │ Assembles:            │
    │ 1. System prompt      │         ┌──────────────────────┐
    │ 2. Repo context       │◄────────│ DS4: Prompt          │
    │ 3. Formatted rules    │         │      Templates       │
    │ 4. PR metadata        │         └──────────────────────┘
    │ 5. Truncated diff     │
    │ 6. JSON instructions  │
    └───────────┬───────────┘
                │
                │ D5: Complete prompt (system + user message)
                ▼
    ┌───────────────────────┐
    │ P3.4: Claude API      │
    │       Client          │─────────────────────────► Claude AI
    │                       │◄───────────────────────── (Anthropic API)
    │ - Send messages.create│         D6: JSON Response
    │ - model, max_tokens   │
    │ - Handle timeouts     │
    └───────────┬───────────┘
                │
                │ Raw JSON string from Claude
                ▼
    ┌───────────────────────┐
    │ P3.5: Response Parser │
    │       + Validator     │
    │                       │
    │ - Strip markdown      │         ┌──────────────────────┐
    │   fences if present   │◄────────│ DS5: AnalysisResult  │
    │ - JSON.parse()        │         │      Zod Schema      │
    │ - Validate with Zod   │         └──────────────────────┘
    │ - On failure → retry  │
    │   (up to 2 retries    │────┐
    │   with strict=true)   │    │ Retry loop (back to P3.3
    └───────────┬───────────┘    │ with strict=true)
                │                │
                │                └────► P3.3 (retry)
                ▼
         D13: AnalysisResult
         (items[] + summary)
```

### Retry Flow Detail

```
    P3.4 → P3.5 → [Parse fails?]
                       │
                  ┌────┴────┐
                  │ Yes     │ No
                  ▼         ▼
            Attempt < 3?    D13: AnalysisResult ──► (success)
                  │
             ┌────┴────┐
             │ Yes     │ No
             ▼         ▼
        Back to P3.3   Return null
        (strict=true)  (caller posts error comment)
```

---

### 2.4 Checklist Service

Decomposes **P4** into its internal sub-processes.

```
         D13: AnalysisResult              D15: Existing Comment Body
         (from Diff Analyzer)             (from issue_comment.edited)
                │                                    │
                ▼                                    ▼
    ┌───────────────────────┐          ┌───────────────────────┐
    │ P4.1: Checklist       │          │ P4.3: Checklist       │
    │       Generator       │          │       Parser          │
    │                       │          │                       │
    │ - Sort items by       │          │ - Extract BOT_MARKER  │
    │   priority (high →    │          │ - Extract SHA from    │
    │   medium → low)       │          │   <!-- sha:xxx -->    │
    │ - Add priority badges │          │ - Match ITEM_REGEX    │
    │   (high=red, med=     │          │   against each line   │
    │   yellow)             │          │ - Parse checked state │
    │ - Format as markdown  │          │   [ ] vs [x]          │
    │   checkboxes          │          │ - Build items array   │
    │ - Embed BOT_MARKER    │          │ - Calculate           │
    │ - Embed SHA comment   │          │   allComplete flag    │
    │ - Add footer          │          │                       │
    └───────────┬───────────┘          └───────────┬───────────┘
                │                                   │
         D14: Checklist                      D16: ChecklistState
         Markdown (new)                      { sha, items[], allComplete }
                │                                   │
                ▼                                   ▼
    ┌───────────────────────────────────────────────────────────┐
    │ P4.2: Checklist Merger                                    │
    │                                                           │
    │ Input: old ChecklistState + new AnalysisResult + new SHA  │
    │                                                           │
    │ - Build lookup map: key = "rule_id:description"           │
    │ - For each new item:                                      │
    │   - If key exists in old state → preserve checked status  │
    │   - If key is new → unchecked (default)                   │
    │ - Items in old state but not in new → dropped (removed)   │
    │ - Generate new markdown with preserved check states       │
    │                                                           │
    └───────────────────────┬───────────────────────────────────┘
                            │
                     D14: Merged Checklist
                     Markdown (with preserved checks)
```

### Markdown Structure

```
┌─────────────────────────────────────────────────┐
│  ## Deploy Checklist                             │
│                                                  │
│  <!-- deploy-checklist-bot:v1 -->   ← BOT_MARKER│
│  <!-- sha:abc123def -->             ← Commit SHA │
│                                                  │
│  The following items were identified...          │
│                                                  │
│  - [ ] **Description** priority — Reasoning      │ ← ChecklistItem
│    _Rule: rule-id_                               │
│                                                  │
│  - [x] **Description** priority — Reasoning      │ ← Checked item
│    _Rule: rule-id_                               │
│                                                  │
│  ---                                             │
│  _Generated by Deploy Checklist Bot_             │
└─────────────────────────────────────────────────┘
```

---

### 2.5 Review Manager

Decomposes **P5** into its internal sub-processes.

```
         D14: Checklist Markdown          D16: ChecklistState
         (or error message)               { allComplete }
                │                                │
                ▼                                ▼
    ┌───────────────────────┐     ┌───────────────────────┐
    │ P5.1: Comment         │     │ P5.3: Review          │
    │       Manager         │     │       Evaluator       │
    │                       │     │                       │
    │ - POST new comment    │     │ - If allComplete →    │
    │   (createComment)     │     │   signal APPROVE      │
    │ - PATCH existing      │     │ - If !allComplete →   │
    │   comment             │     │   signal BLOCK        │
    │   (updateComment)     │     │ - If error →          │
    │ - Find bot comment    │     │   signal ERROR        │
    │   by BOT_MARKER       │     │   (never block)       │
    └───────────┬───────────┘     └───────────┬───────────┘
                │                              │
                │                              │ Review decision
                │                              ▼
                │                 ┌───────────────────────┐
                │                 │ P5.2: Stale Review    │
                │                 │       Dismisser       │
                │                 │                       │
                │                 │ - GET /pulls/{n}/     │──► GitHub API
                │                 │   reviews             │◄── (list reviews)
                │                 │ - Filter: bot author  │
                │                 │   + CHANGES_REQUESTED │
                │                 │ - PUT /reviews/{id}/  │──► GitHub API
                │                 │   dismissals          │    (dismiss review)
                │                 └───────────┬───────────┘
                │                              │
                │                              │ Stale reviews dismissed
                │                              ▼
                │                 ┌───────────────────────┐
                │                 │ P5.4: Review Poster   │
                │                 │                       │
                │                 │ - POST /pulls/{n}/    │──► GitHub API
                │                 │   reviews             │    (create review)
                │                 │ - event:              │
                │                 │   REQUEST_CHANGES     │
                │                 │   or APPROVE          │
                │                 │ - body: checklist     │
                │                 │   summary             │
                └─────────────────┴───────────┬───────────┘
                                              │
                                       D7: Review + Comment
                                              │
                                              ▼
                                       GitHub Platform
```

### Bot Identity Resolution

```
    P5.2 needs to identify which reviews belong to the bot:

    ┌─────────────────────┐
    │ GitHub API:         │
    │ GET /app            │────► Returns: { slug: "deploy-checklist-bot" }
    └─────────────────────┘
              │
              ▼
    Bot login = "{slug}[bot]"
    e.g. "deploy-checklist-bot[bot]"
              │
              ▼
    Match against review.user.login
    to find bot-authored reviews
```

---

## Data Store Descriptions

| Store | Name                     | Type     | Location                  | Description                                                    |
|-------|--------------------------|----------|---------------------------|----------------------------------------------------------------|
| DS1   | Default Rules            | Static   | `src/schemas/config.ts`   | 4 built-in rules (migration, env-var, CI/CD, deps) used when no config file exists |
| DS2   | Config Zod Schema        | Static   | `src/schemas/config.ts`   | Zod schema definitions for validating repo config files        |
| DS3   | Rule Trigger Paths       | Runtime  | In-memory (from config)   | Glob patterns extracted from rules for diff truncation priority |
| DS4   | Prompt Templates         | Static   | `src/prompts/analysis.ts` | System prompt and user prompt builder for Claude API           |
| DS5   | AnalysisResult Schema    | Static   | `src/schemas/analysis-result.ts` | Zod schema for validating Claude's JSON response        |
| DS6   | Debounce Timer Map       | Runtime  | `src/utils/debounce.ts`   | `Map<string, NodeJS.Timeout>` tracking pending debounce timers |
| DS7   | GitHub Comments          | External | GitHub Platform           | PR comments stored by GitHub, searched for BOT_MARKER          |
| DS8   | GitHub Reviews           | External | GitHub Platform           | PR reviews stored by GitHub, filtered by bot author            |

---

## Data Flow Descriptions

Complete catalog of all data flows in the system.

### External Flows

| ID | Name                  | Data Content                                                        | Protocol/Format       |
|----|-----------------------|---------------------------------------------------------------------|-----------------------|
| D1 | Webhook Event         | Developer action (open PR, push commits, edit comment)              | Browser → GitHub UI   |
| D2 | Webhook Payload       | JSON with event type, action, PR/comment data, repo info            | HTTPS POST (webhook)  |
| D3 | Config File Request   | `GET /repos/{owner}/{repo}/contents/.github/deploy-checklist.yml`   | GitHub REST API       |
| D4 | Config Content        | Base64-encoded YAML/JSON file content (or 404 response)             | GitHub REST API       |
| D5 | Diff + Prompt         | `{ model, max_tokens, system, messages: [{ role, content }] }`      | Anthropic REST API    |
| D6 | Checklist Items       | `{ content: [{ text: "{ items: [...], summary: ... }" }] }`        | Anthropic REST API    |
| D7 | Review + Comment      | PR review creation + comment creation/update API calls              | GitHub REST API       |
| D8 | PR Status             | Merge status indicator (blocked by REQUEST_CHANGES or allowed)      | GitHub UI             |

### Internal Flows

| ID  | Name                  | Data Content                                                       | TypeScript Type            |
|-----|-----------------------|--------------------------------------------------------------------|----------------------------|
| D9  | Config Request        | `{ owner, repo, sha }`                                             | Function parameters        |
| D10 | Validated Config      | Full config with defaults merged                                   | `DeployChecklistConfig`    |
| D11 | PR + Diff Request     | `{ owner, repo, prNumber }` + config for analysis                  | Function parameters        |
| D12 | Raw Diff              | Unified diff text (may be very large)                              | `string`                   |
| D13 | Analysis Result       | Structured checklist items with priorities                         | `AnalysisResult`           |
| D14 | Checklist Markdown    | Rendered markdown with checkboxes, metadata, footer                | `string`                   |
| D15 | Comment Body          | Raw markdown of an edited comment (from webhook payload)           | `string`                   |
| D16 | Checklist State       | Parsed checkbox states + completion flag                           | `ChecklistState`           |

---

## Flow Walkthroughs

### Flow A: PR Opened (Full Analysis)

Step-by-step data flow when a developer opens a new pull request.

```
Step  Process   Action                              Data Flow
────  ───────   ──────                              ─────────
 1    External  Developer opens PR on GitHub         D1: Browser action
 2    GitHub    Sends webhook to bot                 D2: { action: "opened", pull_request: {...} }
 3    P1.1      Routes to PR handler                 Internal routing
 4    P1.2      Checks: not draft, not ignored       Config filter check
                author, target branch matches
 5    P1.3      Routes "opened" → handleNewAnalysis  Internal routing
 6    P2.1      Tries .yml → .yaml → .json           D3: GET /contents/.github/deploy-checklist.yml
 7    P2.1      Receives config file                  D4: { content: "base64...", encoding: "base64" }
 8    P2.2      Parses YAML to JS object              Internal transformation
 9    P2.3      Validates against Zod schema           Internal validation
10    P2.4      Merges user rules with defaults        D10: DeployChecklistConfig
11    P3.1      Fetches PR diff from GitHub            D12: "diff --git a/... b/..."
12    P3.1      Extracts file list from diff            Internal: ["src/db/migration.sql", ...]
13    P3.2      Checks diff size, truncates if needed   Internal: truncated diff string
14    P3.3      Builds prompt with config+diff+meta     D5: { system: "...", messages: [...] }
15    P3.4      Sends to Claude API                     D5 → Claude AI
16    P3.4      Receives Claude response                D6 → { items: [...], summary: "..." }
17    P3.5      Strips fences, parses JSON               Internal transformation
18    P3.5      Validates with Zod                       D13: AnalysisResult
19    P4.1      Generates markdown checklist              D14: "## Deploy Checklist\n..."
20    P5.1      Posts comment on PR                       D7: POST /issues/{n}/comments
21    P5.2      Dismisses any stale bot reviews           D7: PUT /reviews/{id}/dismissals
22    P5.4      Posts REQUEST_CHANGES review               D7: POST /pulls/{n}/reviews
23    GitHub    Updates PR merge status                    D8: PR shows as "Changes requested"
24    External  Developer sees blocked PR                  D8: UI indicator
```

---

### Flow B: Checklist Item Checked Off

Step-by-step data flow when a developer checks a checkbox in the bot's comment.

```
Step  Process   Action                              Data Flow
────  ───────   ──────                              ─────────
 1    External  Developer edits comment, checks box  D1: Browser action (checkbox toggle)
 2    GitHub    Sends webhook to bot                  D2: { action: "edited", comment: { body: "..." } }
 3    P1.1      Routes to comment handler             Internal routing
 4    P1.5      Checks: body contains BOT_MARKER?     Filter: comment.body.includes("<!-- deploy-...")
 5    P1.5      Checks: issue has pull_request field?  Filter: "pull_request" in issue
 6    P4.3      Parses checklist from comment body     D15 → D16: ChecklistState
 7    P4.3      Counts checked items: 5/5              D16: { allComplete: true, items: [...] }
 8    P5.3      Evaluates: allComplete=true → APPROVE  Review decision
 9    P5.2      Dismisses stale CHANGES_REQUESTED      D7: PUT /reviews/{id}/dismissals
10    P5.4      Posts APPROVE review                    D7: POST /pulls/{n}/reviews
11    GitHub    Updates PR merge status                 D8: PR shows as "Approved"
12    External  Developer sees unblocked PR             D8: Merge button becomes green
```

**Alternate path (not all checked):**

```
Step 7a  P4.3   Counts checked items: 3/5            D16: { allComplete: false }
Step 8a  P5.3   Evaluates: !allComplete → BLOCK       Review decision
Step 9a  P5.4   Posts REQUEST_CHANGES review           D7: "2 unchecked item(s)..."
```

---

### Flow C: New Commits Pushed (Re-analysis)

Step-by-step data flow when new commits are pushed to an existing PR.

```
Step  Process   Action                              Data Flow
────  ───────   ──────                              ─────────
 1    External  Developer pushes new commits          D1: git push
 2    GitHub    Sends webhook to bot                  D2: { action: "synchronize", ... }
 3    P1.1      Routes to PR handler                  Internal routing
 4    P1.2      Applies same filters as Flow A        Filter checks
 5    P1.3      Routes "synchronize" → handleReanalysis  Internal routing
 6    P1.4      Debounce check (key: "owner/repo#42")    DS6: debounce timer map
 6a   P1.4      If another push within 5s → cancel this  Timer cancelled
 6b   P1.4      If no new push within 5s → proceed       Timer fires
 7    P5.1      Searches PR comments for BOT_MARKER       D7: GET /issues/{n}/comments
 8    P4.3      Parses old checklist from existing comment D15 → D16: old ChecklistState
 9    P3.1      Fetches updated diff                       D12: new unified diff
10    P3.2-3.5  Full analysis pipeline (same as Flow A)    D5, D6, D13: new AnalysisResult
11    P4.2      Merges: match old items by "rule_id:desc"  D16 (old) + D13 (new)
                - Matching items → preserve checked state
                - New items → unchecked
                - Removed items → dropped
12    P4.2      Generates merged markdown                   D14: merged checklist
13    P5.1      Updates existing comment (PATCH)            D7: PATCH /issues/comments/{id}
14    P5.3      Evaluates: any "- [ ]" in markdown?         Review decision
15a   P5.4      If unchecked items → REQUEST_CHANGES        D7: POST /pulls/{n}/reviews
15b   P5.4      If all checked → APPROVE                    D7: POST /pulls/{n}/reviews
```

---

## Error Flows

### Error Flow 1: Claude API Failure

```
    P3.4 (Claude API Client) ──── API error (timeout, 5xx, rate limit)
         │
         ▼
    Retry up to 2 times with exponential backoff
         │
         ├── Success on retry → continue normal flow
         │
         └── All retries exhausted
              │
              ▼
         P3 returns null (no AnalysisResult)
              │
              ▼
         P5.1: postErrorComment()
              │
              ▼
         Posts informational comment:
         "Claude analysis failed after multiple retries."
         │
         ▼
         PR is NOT blocked (safety principle:
         never block on unrecoverable errors)
```

### Error Flow 2: Malformed Claude Response

```
    P3.5 (Response Parser) ──── JSON.parse() fails or Zod validation fails
         │
         ▼
    Attempt 1: Retry with strict=true prompt
         │
         ├── Valid JSON on retry → continue normal flow
         │
         └── Still invalid
              │
              ▼
         Attempt 2: Retry with strict=true again
              │
              ├── Valid JSON → continue
              │
              └── Still invalid → return null → error comment
```

### Error Flow 3: Config File Issues

```
    P2.1 (File Resolver) ──── All 3 paths return 404
         │
         ▼
    P2.4: Use default rules (no warning)
    ─────────────────────────────────────

    P2.2 (Content Parser) ──── YAML/JSON parse error
         │
         ▼
    Return { config: defaults, warning: "Parse error: ..." }
    Warning is posted as a comment on the PR.
    ─────────────────────────────────────

    P2.3 (Schema Validator) ──── Zod validation fails
         │
         ▼
    Return { config: defaults, warning: "Validation error: ..." }
    Warning is posted as a comment on the PR.
```

### Error Flow 4: Unhandled Exception in Handler

```
    Any handler (handleNewAnalysis / handleReanalysis)
         │
         └── catch (error) block
              │
              ▼
         Log error with context
              │
              ▼
         P5.1: postErrorComment()
         "An unexpected error occurred during analysis."
              │
              ▼
         PR is NOT blocked
```

---

## Summary Matrix

Maps each webhook event to its complete processing pipeline.

| Webhook Event                  | P1 Route      | P2 Config | P3 Analyze | P4 Checklist     | P5 Review        |
|--------------------------------|---------------|-----------|-----------|------------------|------------------|
| `pull_request.opened`          | New analysis  | Load      | Full      | Generate         | Block            |
| `pull_request.reopened`        | New analysis  | Load      | Full      | Generate         | Block            |
| `pull_request.ready_for_review`| New analysis  | Load      | Full      | Generate         | Block            |
| `pull_request.synchronize`     | Re-analysis   | Load      | Full      | Parse + Merge    | Re-evaluate      |
| `issue_comment.edited`         | Comment check | —         | —         | Parse            | Approve or Block |
