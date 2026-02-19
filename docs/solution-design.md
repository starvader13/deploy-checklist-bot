# Deploy Checklist Bot — Solution Design

## 1. Problem Statement & Goals

### Problem

Manual pre-deploy checklists are error-prone and inconsistently applied. Engineers forget to check for database migrations, environment variable changes, feature flag updates, or breaking API changes before merging pull requests. Code review catches logic bugs but routinely misses operational concerns — the "did you remember to..." class of issues that cause incidents after deploy.

Common failure modes:
- A migration is merged without a corresponding rollback plan
- An environment variable is referenced in code but never added to production config
- A breaking API change ships without consumer notification or versioning
- Cache invalidation logic changes without verifying TTL behavior
- Feature flags are added in code but never created in the flag management system

### Goals

1. **Automated analysis**: Use Claude AI to analyze PR diffs against configurable rules and generate a deploy checklist tailored to the actual changes.
2. **Repo-configurable**: Each repository defines its own rules (e.g., "if a migration file is added, require a rollback plan item"). No one-size-fits-all.
3. **Merge-blocking**: The bot posts a PR review with "Request Changes" status. Merging is blocked until every checklist item is checked off.
4. **Low friction**: Checklist items are actionable, specific to the diff, and only appear when relevant. Engineers never see irrelevant items.
5. **Transparent reasoning**: Each checklist item includes a brief explanation of why it was triggered, so engineers learn the rules over time.

---

## 2. Architecture Overview

### High-Level Flow

```
┌─────────────┐       Webhook        ┌──────────────────┐       API       ┌───────────┐
│   GitHub    │ ───────────────────► │  Bot Server      │ ──────────────► │  Claude   │
│  (PR event) │                      │  (Node/Probot)   │ ◄────────────── │  API      │
│             │ ◄─────────────────── │                  │                 │           │
│             │   Review + Comment   │                  │                 └───────────┘
└─────────────┘                      └──────────────────┘
                                             │
                                             │ reads
                                             ▼
                                      ┌──────────────────┐
                                      │ .github/         │
                                      │ deploy-checklist │
                                      │ .yml             │
                                      └──────────────────┘
```

### Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Bot Server                            │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │ Webhook Handlers │───►│ Diff Analyzer   │                 │
│  │                 │    │ Service         │                 │
│  │ - onPROpened    │    │                 │──► Claude API    │
│  │ - onPRSynced    │    │ - fetchDiff()   │                 │
│  │ - onCommentEdit │    │ - buildPrompt() │                 │
│  └────────┬────────┘    │ - parseResult() │                 │
│           │             └────────┬────────┘                 │
│           │                      │                           │
│           ▼                      ▼                           │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │ Config Loader   │    │ Checklist       │                 │
│  │                 │    │ Service         │                 │
│  │ - loadConfig()  │    │                 │                 │
│  │ - validate()    │    │ - generate()    │                 │
│  │ - defaults()    │    │ - parse()       │                 │
│  └─────────────────┘    │ - evaluate()    │                 │
│                          └────────┬────────┘                 │
│                                   │                           │
│                                   ▼                           │
│                          ┌─────────────────┐                 │
│                          │ Review Manager  │                 │
│                          │                 │                 │
│                          │ - block()       │──► GitHub API   │
│                          │ - approve()     │                 │
│                          │ - update()      │                 │
│                          └─────────────────┘                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer         | Choice                | Rationale                                   |
|---------------|----------------------|---------------------------------------------|
| Framework     | Probot (Node.js)     | Purpose-built for GitHub Apps, handles auth  |
| Language      | TypeScript           | Type safety for API contracts                |
| AI            | Claude API (Anthropic SDK) | Strong reasoning for code analysis     |
| Runtime       | Node.js 20+         | LTS, native fetch, Probot requirement        |
| Testing       | Vitest               | Fast, TypeScript-native, compatible with ESM |
| Hosting       | Fly.io / Railway     | Simple deploy, persistent process for webhooks |

---

## 3. Webhook Event Flow

### Flow 1: PR Opened or Reopened

```
Developer          GitHub              Bot Server            Claude API
    │                  │                    │                     │
    │  Open PR         │                    │                     │
    ├─────────────────►│                    │                     │
    │                  │  pull_request      │                     │
    │                  │  (opened)          │                     │
    │                  ├───────────────────►│                     │
    │                  │                    │                     │
    │                  │                    │  GET config file    │
    │                  │◄───────────────────┤                     │
    │                  ├───────────────────►│                     │
    │                  │                    │                     │
    │                  │                    │  GET PR diff        │
    │                  │◄───────────────────┤                     │
    │                  ├───────────────────►│                     │
    │                  │                    │                     │
    │                  │                    │  Analyze diff       │
    │                  │                    ├────────────────────►│
    │                  │                    │  Checklist items    │
    │                  │                    │◄────────────────────┤
    │                  │                    │                     │
    │                  │  POST review       │                     │
    │                  │  (REQUEST_CHANGES) │                     │
    │                  │◄───────────────────┤                     │
    │                  │                    │                     │
    │  PR blocked      │                    │                     │
    │◄─────────────────┤                    │                     │
    │                  │                    │                     │
```

### Flow 2: Checklist Item Checked Off

```
Developer          GitHub              Bot Server
    │                  │                    │
    │  Edit comment    │                    │
    │  (check box)     │                    │
    ├─────────────────►│                    │
    │                  │  issue_comment     │
    │                  │  (edited)          │
    │                  ├───────────────────►│
    │                  │                    │
    │                  │                    │── Parse markdown
    │                  │                    │── Count checked vs total
    │                  │                    │
    │                  │                    │── All checked?
    │                  │                    │
    │                  │  POST review       │
    │                  │  (APPROVE)         │
    │                  │◄───────────────────┤
    │                  │                    │
    │  PR unblocked    │                    │
    │◄─────────────────┤                    │
    │                  │                    │
```

### Flow 3: New Commits Pushed to PR

```
Developer          GitHub              Bot Server            Claude API
    │                  │                    │                     │
    │  Push commits    │                    │                     │
    ├─────────────────►│                    │                     │
    │                  │  pull_request      │                     │
    │                  │  (synchronize)     │                     │
    │                  ├───────────────────►│                     │
    │                  │                    │                     │
    │                  │                    │  GET updated diff   │
    │                  │◄───────────────────┤                     │
    │                  ├───────────────────►│                     │
    │                  │                    │                     │
    │                  │                    │  Re-analyze diff    │
    │                  │                    ├────────────────────►│
    │                  │                    │  Updated items      │
    │                  │                    │◄────────────────────┤
    │                  │                    │                     │
    │                  │  PATCH comment     │                     │
    │                  │  (update checklist)│                     │
    │                  │◄───────────────────┤                     │
    │                  │                    │                     │
    │                  │  POST review       │                     │
    │                  │  (REQUEST_CHANGES) │                     │
    │                  │◄───────────────────┤                     │
    │                  │                    │                     │
```

**Re-analysis strategy**: On new commits, the bot re-analyzes the full diff. It preserves check state for items that still apply (matched by item text) and adds/removes items as needed. This prevents annoying resets while keeping the checklist accurate.

---

## 4. Core Components

### 4.1 Config Loader

**Responsibility**: Read and validate per-repo configuration.

**Config file resolution order**:
1. `.github/deploy-checklist.yml`
2. `.github/deploy-checklist.yaml`
3. `.deploy-checklist.json` (repo root)
4. Fall back to built-in defaults

**Key behaviors**:
- Caches config per repo+ref for the duration of a single webhook handling
- Validates against a JSON Schema; posts a warning comment if invalid
- Merges user config with defaults (user rules extend, not replace)

### 4.2 Diff Analyzer

**Responsibility**: Fetch the PR diff, construct a Claude prompt, and parse the structured response.

**Key behaviors**:
- Fetches diff via GitHub API (`GET /repos/{owner}/{repo}/pulls/{pull_number}` with `Accept: application/vnd.github.diff`)
- Truncates diffs exceeding token budget (see Section 6)
- Builds a prompt combining the diff, repo rules, and file context
- Parses Claude's JSON response into typed checklist items
- Retries on malformed responses (up to 2 retries with stricter formatting instructions)

### 4.3 Checklist Service

**Responsibility**: Generate and parse markdown checklists, track completion state.

**Markdown format**:
```markdown
## Deploy Checklist

<!-- deploy-checklist-bot:v1 -->
<!-- sha:abc123 -->

The following items were identified for this PR. Check each item to confirm
it has been addressed before merging.

- [ ] **Add `DATABASE_URL` to production environment** — New env var
  referenced in `src/db/connection.ts:14`. Ensure it is set in all
  deployment targets.
  _Rule: env-var-check_

- [ ] **Verify migration rollback** — New migration file
  `migrations/20240115_add_users.sql` detected. Confirm rollback SQL
  is tested.
  _Rule: migration-safety_

---
_Generated by Deploy Checklist Bot | [Config docs](link) | Re-analyze: push a new commit_
```

**Key behaviors**:
- Embeds metadata in HTML comments (bot version, SHA analyzed)
- Parses checked/unchecked state from existing comment body
- On re-analysis, merges old check state with new items (match by rule ID + file reference)
- Exposes `isComplete()` to determine if all items are checked

### 4.4 Review Manager

**Responsibility**: Manage GitHub PR review status.

**Key behaviors**:
- Posts `REQUEST_CHANGES` review when checklist has unchecked items
- Posts `APPROVE` review when all items are checked
- Dismisses its own stale reviews before posting new ones
- Only operates on reviews authored by the bot (never touches human reviews)
- If no checklist items are generated (clean diff), posts an approving review with a short note

### 4.5 Webhook Handlers

**Events handled**:

| Event                              | Action                                       |
|------------------------------------|----------------------------------------------|
| `pull_request.opened`              | Full analysis → post checklist → block        |
| `pull_request.reopened`            | Full analysis → post checklist → block        |
| `pull_request.synchronize`         | Re-analysis → update checklist → re-evaluate  |
| `issue_comment.edited`             | Parse checklist → evaluate → approve/block    |
| `pull_request.ready_for_review`    | Full analysis (if was draft, now ready)        |

**Filtering logic**:
- Ignore draft PRs (analyze on `ready_for_review`)
- Ignore bot-authored PRs (configurable)
- Ignore PRs targeting excluded branches (configurable)
- Only process `issue_comment.edited` for comments authored by the bot

---

## 5. Config Schema

### Full Schema

```yaml
# .github/deploy-checklist.yml

# Schema version (for future migrations)
version: 1

# Global settings
settings:
  # Whether to analyze draft PRs immediately or wait for ready_for_review
  analyze_drafts: false          # default: false

  # Skip analysis for PRs opened by these accounts
  ignore_authors:
    - dependabot[bot]
    - renovate[bot]

  # Only analyze PRs targeting these branches (empty = all branches)
  target_branches:
    - main
    - production

  # Post a comment even when no checklist items are generated
  post_empty_checklist: false    # default: false

  # Maximum diff size (in characters) to send to Claude
  max_diff_size: 100000          # default: 100000

# Rules define what the bot looks for in diffs
rules:
  # Each rule has a unique ID
  - id: migration-safety
    # Human-readable description shown in checklist
    description: "Database migration detected"
    # When this rule triggers (glob patterns against changed file paths)
    trigger:
      paths:
        - "migrations/**"
        - "db/migrate/**"
        - "**/migrations/*.sql"
        - "**/migrations/*.py"
    # What to check for — sent to Claude as instructions
    checks:
      - "Verify a corresponding rollback/down migration exists"
      - "Check that the migration is backward-compatible with the current running code"
      - "Confirm the migration has been tested against a production-like dataset"

  - id: env-var-check
    description: "Environment variable change detected"
    trigger:
      # Content-based trigger: regex patterns matched against diff content
      content:
        - "process\\.env\\."
        - "os\\.environ"
        - "ENV\\['"
    checks:
      - "Verify new environment variables are documented"
      - "Confirm variables are set in all deployment environments"
      - "Check that sensible defaults or error messages exist for missing vars"

  - id: api-breaking-change
    description: "API route change detected"
    trigger:
      paths:
        - "src/routes/**"
        - "src/api/**"
        - "app/controllers/**"
    checks:
      - "Verify the change is backward-compatible or versioned"
      - "Check that API documentation is updated"
      - "Confirm downstream consumers have been notified if breaking"

  - id: docker-change
    description: "Docker configuration changed"
    trigger:
      paths:
        - "Dockerfile*"
        - "docker-compose*.yml"
        - ".dockerignore"
    checks:
      - "Verify base image versions are pinned"
      - "Confirm health checks are defined"
      - "Check that no secrets are baked into the image"

# Freeform instructions sent to Claude alongside rules
# Use this for repo-specific context that doesn't fit into rules
context: |
  This is a Node.js backend service deployed on Kubernetes.
  We use PostgreSQL and Redis. Deployments are blue-green.
  The service handles payment processing — extra caution on
  anything touching the payments module.
```

### Default Rules (No Config File)

When no config file is found, the bot applies a minimal set of sensible defaults:

```yaml
rules:
  - id: default-migration
    description: "Database migration detected"
    trigger:
      paths: ["**/migrations/**"]
    checks:
      - "Verify rollback strategy exists"

  - id: default-env
    description: "Environment variable change"
    trigger:
      content: ["process\\.env\\.", "os\\.environ"]
    checks:
      - "Confirm new env vars are set in deployment targets"

  - id: default-ci
    description: "CI/CD configuration changed"
    trigger:
      paths: [".github/workflows/**", ".gitlab-ci.yml", "Jenkinsfile"]
    checks:
      - "Review CI/CD changes for unintended side effects"

  - id: default-deps
    description: "Dependency change detected"
    trigger:
      paths: ["package-lock.json", "yarn.lock", "Gemfile.lock", "poetry.lock", "go.sum"]
    checks:
      - "Review dependency changes for security advisories"
```

### Example: Frontend Repo Config

```yaml
version: 1
settings:
  target_branches: [main]
  ignore_authors: [renovate[bot]]

rules:
  - id: bundle-size
    description: "Potential bundle size impact"
    trigger:
      paths: ["src/**/*.tsx", "src/**/*.ts", "package.json"]
      content: ["import .* from '[^.]"]  # new external imports
    checks:
      - "Check bundle size impact with `npm run analyze`"
      - "Verify new dependencies support tree-shaking"

  - id: accessibility
    description: "UI component changed"
    trigger:
      paths: ["src/components/**"]
    checks:
      - "Verify ARIA attributes are correct"
      - "Test with keyboard navigation"
      - "Check color contrast ratios"

context: |
  React 18 app with Next.js. Deployed to Vercel.
  We target WCAG 2.1 AA compliance.
```

### Example: Monorepo Config

```yaml
version: 1
settings:
  analyze_drafts: false
  target_branches: [main, release/*]

rules:
  - id: cross-package-dep
    description: "Cross-package dependency changed"
    trigger:
      paths: ["packages/*/package.json"]
    checks:
      - "Verify version bumps are consistent across packages"
      - "Run integration tests for affected packages"

  - id: shared-schema
    description: "Shared schema/types changed"
    trigger:
      paths: ["packages/shared/**", "packages/types/**"]
    checks:
      - "Verify all consuming packages are compatible"
      - "Check that generated clients are regenerated"

  - id: infra-change
    description: "Infrastructure change"
    trigger:
      paths: ["infra/**", "terraform/**", "k8s/**"]
    checks:
      - "Run `terraform plan` and review output"
      - "Verify changes are applied in staging first"

context: |
  Monorepo with Turborepo. Services: api, web, worker, shared.
  Each service deploys independently.
```

---

## 6. Claude AI Integration

### Prompt Design Strategy

The prompt follows a structured format to produce reliable, parseable output:

```
System prompt:
  You are a deploy checklist analyzer. You examine pull request diffs
  against a set of deployment rules and determine which checklist items
  apply. You respond ONLY with valid JSON matching the specified schema.

User prompt:
  ## Repository Context
  {config.context}

  ## Rules
  {formatted rules with IDs, triggers, and checks}

  ## PR Information
  Title: {pr.title}
  Description: {pr.body}
  Base branch: {pr.base.ref}
  Files changed: {file list}

  ## Diff
  ```diff
  {truncated diff}
  ```

  ## Instructions
  Analyze the diff against each rule. For each rule whose trigger
  conditions match files in the diff, evaluate each check and determine
  if it is relevant to the actual changes.

  Respond with JSON matching this schema:
  {
    "items": [
      {
        "rule_id": "string — the rule ID that triggered this item",
        "check": "string — the specific check from the rule",
        "description": "string — a concise, actionable checklist item
                        specific to this PR (reference exact files/lines)",
        "reasoning": "string — brief explanation of why this check is
                      relevant to the changes in this diff",
        "priority": "high | medium | low"
      }
    ],
    "summary": "string — one sentence summarizing overall deploy risk"
  }

  Only include items that are genuinely relevant to the diff. Do NOT
  include items for rules whose triggers don't match. Be specific —
  reference actual file names, function names, and line numbers from
  the diff.
```

### Token Budget & Truncation Strategy

| Component       | Approximate tokens | Strategy                           |
|-----------------|-------------------|------------------------------------|
| System prompt   | ~200              | Fixed                              |
| Rules + context | ~500–2000         | Scales with config size            |
| PR metadata     | ~200              | Fixed                              |
| Diff            | Remainder         | Truncated to fit budget            |
| Response        | ~2000 reserved    | Structured JSON                    |

**Total budget**: ~100K tokens (using `claude-sonnet-4-5-20250929` for cost efficiency).

**Diff truncation approach**:
1. Calculate available tokens after system prompt, rules, and metadata
2. If full diff fits, use it entirely
3. If it exceeds budget, apply smart truncation:
   - Prioritize files matching rule trigger paths
   - Include full hunks for triggered files
   - Summarize or omit non-triggered files (just file names + stats)
   - Truncate extremely large individual files (keep first N lines of each hunk)
4. Always include the file list even if diff content is truncated

**Cost estimate**: ~$0.01–0.05 per PR analysis (Sonnet-class pricing). At 100 PRs/day, ~$1.50–5.00/day.

### Response Parsing

- Parse Claude response as JSON
- Validate against expected schema using Zod
- On parse failure, retry once with a more explicit formatting instruction appended
- On second failure, post a comment indicating analysis failed and link to manual checklist

---

## 7. Data Flow & API Contracts

### GitHub API Endpoints Used

| Endpoint                                              | Method | Purpose                       |
|-------------------------------------------------------|--------|-------------------------------|
| `/repos/{owner}/{repo}/pulls/{number}`                | GET    | PR metadata (with diff accept header) |
| `/repos/{owner}/{repo}/contents/{path}`               | GET    | Read config file              |
| `/repos/{owner}/{repo}/pulls/{number}/reviews`        | GET    | List existing bot reviews     |
| `/repos/{owner}/{repo}/pulls/{number}/reviews`        | POST   | Create review (approve/block) |
| `/repos/{owner}/{repo}/pulls/{number}/reviews/{id}/dismissals` | PUT | Dismiss stale bot review |
| `/repos/{owner}/{repo}/issues/{number}/comments`      | GET    | Find existing bot comment     |
| `/repos/{owner}/{repo}/issues/{number}/comments`      | POST   | Post checklist comment        |
| `/repos/{owner}/{repo}/issues/comments/{id}`          | PATCH  | Update checklist comment      |

### GitHub App Permissions Required

| Permission         | Access     | Reason                              |
|--------------------|-----------|--------------------------------------|
| Pull requests      | Read/Write | Read diffs, post reviews            |
| Issues             | Read/Write | Post/edit comments (PRs use Issues API) |
| Contents (single file) | Read  | Read config file from repo          |
| Metadata           | Read       | Required baseline                    |

**Webhook subscriptions**: `pull_request`, `issue_comment`

### Claude API Request Format

```typescript
// Request to Anthropic SDK
{
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 2000,
  system: SYSTEM_PROMPT,
  messages: [
    { role: "user", content: constructedPrompt }
  ]
}
```

### Internal TypeScript Interfaces

```typescript
// --- Config types ---

interface DeployChecklistConfig {
  version: number;
  settings: Settings;
  rules: Rule[];
  context?: string;
}

interface Settings {
  analyze_drafts: boolean;
  ignore_authors: string[];
  target_branches: string[];
  post_empty_checklist: boolean;
  max_diff_size: number;
}

interface Rule {
  id: string;
  description: string;
  trigger: Trigger;
  checks: string[];
}

interface Trigger {
  paths?: string[];
  content?: string[];
}

// --- Analysis types ---

interface AnalysisResult {
  items: ChecklistItem[];
  summary: string;
}

interface ChecklistItem {
  rule_id: string;
  check: string;
  description: string;
  reasoning: string;
  priority: "high" | "medium" | "low";
}

// --- Checklist state ---

interface ChecklistState {
  sha: string;
  items: ChecklistItemState[];
  allComplete: boolean;
}

interface ChecklistItemState {
  item: ChecklistItem;
  checked: boolean;
}

// --- Service interfaces ---

interface ConfigLoader {
  load(owner: string, repo: string, ref: string): Promise<DeployChecklistConfig>;
}

interface DiffAnalyzer {
  analyze(
    diff: string,
    config: DeployChecklistConfig,
    prMeta: PRMetadata
  ): Promise<AnalysisResult>;
}

interface ChecklistService {
  generate(result: AnalysisResult, sha: string): string;
  parse(commentBody: string): ChecklistState;
  merge(oldState: ChecklistState, newResult: AnalysisResult, newSha: string): string;
  isComplete(commentBody: string): boolean;
}

interface ReviewManager {
  blockPR(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
  approvePR(owner: string, repo: string, prNumber: number): Promise<void>;
  dismissStaleReviews(owner: string, repo: string, prNumber: number): Promise<void>;
}

interface PRMetadata {
  title: string;
  body: string;
  baseBranch: string;
  headSha: string;
  author: string;
  isDraft: boolean;
  filesChanged: string[];
}
```

---

## 8. Edge Cases & Error Handling

### Large Diffs (Token Limits)

| Scenario                          | Handling                                            |
|-----------------------------------|-----------------------------------------------------|
| Diff > `max_diff_size`            | Smart truncation (prioritize triggered files)        |
| Single file > 50% of budget       | Truncate file, keep first/last hunks                 |
| 500+ files changed                | Only include files matching rule triggers + summary  |
| Binary files in diff              | Exclude from diff, note in file list                 |

### Config File Issues

| Scenario                          | Handling                                            |
|-----------------------------------|-----------------------------------------------------|
| No config file found              | Use default rules, post note about custom config     |
| Config file has YAML syntax error | Post warning comment with parse error, use defaults  |
| Config file fails schema validation | Post warning with specific validation errors, use defaults |
| Config file is empty              | Use defaults                                         |

### Claude API Failures

| Scenario                          | Handling                                            |
|-----------------------------------|-----------------------------------------------------|
| API timeout (>30s)                | Retry once with exponential backoff                  |
| Rate limited (429)               | Retry after `Retry-After` header value               |
| Malformed JSON response           | Retry once with stricter prompt; on second failure, post error comment |
| API key invalid/expired           | Log error, post generic "analysis unavailable" comment, do NOT block PR |
| Service outage (5xx)             | Retry up to 3 times with backoff; post error comment on exhaustion |

**Critical principle**: On unrecoverable failure, the bot must NOT block the PR. It should post an informational comment and either skip the review or post an APPROVE to avoid being a merge blocker.

### Race Conditions

| Scenario                          | Handling                                            |
|-----------------------------------|-----------------------------------------------------|
| Rapid successive pushes            | Debounce: delay analysis by 5s, use latest SHA only |
| Checkbox edited during re-analysis | Re-analysis result takes precedence, re-merge states |
| Concurrent webhook deliveries      | Use comment metadata (SHA) as optimistic lock        |
| Comment deleted by user            | Re-create on next event                              |

### Special PR Types

| Scenario                          | Handling                                            |
|-----------------------------------|-----------------------------------------------------|
| Draft PRs                         | Skip unless `analyze_drafts: true` in config         |
| Bot-authored PRs                  | Skip if author is in `ignore_authors`                |
| PRs targeting excluded branches   | Skip silently                                        |
| Force-pushed PRs                  | Treat as `synchronize` — full re-analysis            |
| PRs with no code changes          | No checklist items → approve (or skip per config)    |
| Merge commits / merge queue       | Analyze the resulting diff, not individual commits   |

---

## 9. Deployment & Infrastructure

### Hosting Options

| Option      | Pros                               | Cons                                | Recommended For       |
|-------------|------------------------------------|------------------------------------|----------------------|
| **Fly.io**  | Persistent process, easy deploy, affordable | Minor config learning curve | Small-medium teams   |
| **Railway** | One-click deploy, good DX          | Can get expensive at scale          | Quick start          |
| **Vercel**  | Free tier, serverless              | 10s function timeout (too short)    | NOT recommended      |
| **Self-hosted** | Full control, no egress costs  | Ops burden, TLS management          | Enterprise/air-gapped |

**Recommendation**: Fly.io for production deployments. Railway for quick evaluation.

### Environment Variables

| Variable                | Required | Description                              |
|------------------------|----------|------------------------------------------|
| `APP_ID`               | Yes      | GitHub App ID                             |
| `PRIVATE_KEY`          | Yes      | GitHub App private key (PEM format)       |
| `WEBHOOK_SECRET`       | Yes      | GitHub webhook secret for verification    |
| `ANTHROPIC_API_KEY`    | Yes      | Claude API key                            |
| `CLAUDE_MODEL`         | No       | Model override (default: `claude-sonnet-4-5-20250929`) |
| `LOG_LEVEL`            | No       | Logging verbosity (default: `info`)       |
| `WEBHOOK_PROXY_URL`    | No       | smee.io URL for local development         |
| `NODE_ENV`             | No       | `production` / `development`              |
| `ANALYSIS_DEBOUNCE_MS` | No       | Debounce delay for rapid pushes (default: 5000) |

### GitHub App Setup

1. Create a new GitHub App at `https://github.com/settings/apps/new`
2. Set:
   - **Webhook URL**: `https://<your-domain>/api/webhooks`
   - **Webhook secret**: a strong random string
   - **Permissions**: Pull requests (R/W), Issues (R/W), Contents (Read), Metadata (Read)
   - **Subscribe to events**: Pull request, Issue comment
3. Generate a private key and download the PEM file
4. Install the app on target repositories

### Scaling Considerations

- **Webhook queue**: At low-medium volume (<100 PRs/day), direct handling is fine. At higher volume, consider a job queue (BullMQ + Redis) to decouple webhook receipt from processing.
- **Claude API concurrency**: Anthropic rate limits apply. For high-volume orgs, request a rate limit increase or implement request queuing.
- **Statelessness**: The bot is stateless — all state lives in GitHub (comments, reviews). This means horizontal scaling is straightforward (multiple instances behind a load balancer, though webhook delivery is serial per event).
- **Caching**: Config files can be cached per repo+SHA with a short TTL (5 min) to avoid redundant API calls on rapid pushes.

---

## 10. Security Considerations

### Webhook Signature Verification

- **Mandatory**: Every incoming webhook must be verified using the `X-Hub-Signature-256` header and the shared webhook secret.
- Probot handles this automatically when configured with `WEBHOOK_SECRET`.
- Reject any request with missing or invalid signature with `401 Unauthorized`.

### API Key Management

- `ANTHROPIC_API_KEY` and `PRIVATE_KEY` must never be logged, committed, or exposed in error messages.
- Use environment variables or a secrets manager (e.g., Fly.io secrets, Railway variables).
- Rotate keys on a regular schedule and immediately on suspected compromise.
- The GitHub App private key should have the minimum scope needed.

### Diff Content Sent to External LLM

- **Data sensitivity**: PR diffs may contain proprietary code, secrets accidentally committed, or sensitive business logic. All of this is sent to the Claude API for analysis.
- **Mitigations**:
  - Document this data flow clearly for users during app installation
  - Anthropic's API data retention policy: data is not used for training (with API usage)
  - Consider offering a config option to exclude specific file paths from analysis (`exclude_paths`)
  - For highly sensitive repos, support self-hosted LLM backends as a future option
  - Strip obvious secrets (regex for API keys, tokens) from diffs before sending

### Permission Scoping

- The GitHub App requests only the permissions it needs (see Section 7)
- No admin-level permissions are requested
- Contents permission is Read-only (the bot never writes to the repo)
- The bot only interacts with PRs, never pushes code, creates branches, or modifies repo settings

### Additional Security Measures

- **Rate limiting**: Implement per-repo rate limiting to prevent abuse (e.g., max 10 analyses per minute per repo)
- **Input validation**: Validate all webhook payloads beyond signature verification (expected fields, reasonable sizes)
- **Dependency security**: Run `npm audit` in CI, use Dependabot/Renovate for dependency updates
- **Logging**: Log webhook events and analysis requests (without sensitive content) for audit trail
- **Error messages**: Never expose internal errors, stack traces, or configuration details in GitHub comments

---

## Appendix: Project Structure

```
deploy-checklist-bot/
├── docs/
│   └── solution-design.md          # This document
├── src/
│   ├── index.ts                    # Probot app entry point
│   ├── handlers/
│   │   ├── pull-request.ts         # PR opened/synced/ready handlers
│   │   └── issue-comment.ts        # Comment edited handler
│   ├── services/
│   │   ├── config-loader.ts        # Config file loading & validation
│   │   ├── diff-analyzer.ts        # Claude integration & diff analysis
│   │   ├── checklist.ts            # Markdown generation & parsing
│   │   └── review-manager.ts       # GitHub review management
│   ├── prompts/
│   │   └── analysis.ts             # Claude prompt templates
│   ├── schemas/
│   │   ├── config.ts               # Zod schema for config validation
│   │   └── analysis-result.ts      # Zod schema for Claude response
│   └── utils/
│       ├── diff-truncation.ts      # Smart diff truncation logic
│       └── debounce.ts             # Webhook debouncing
├── test/
│   ├── fixtures/
│   │   ├── diffs/                  # Sample diffs for testing
│   │   ├── configs/                # Sample config files
│   │   └── payloads/               # Sample webhook payloads
│   ├── handlers/
│   │   ├── pull-request.test.ts
│   │   └── issue-comment.test.ts
│   └── services/
│       ├── config-loader.test.ts
│       ├── diff-analyzer.test.ts
│       ├── checklist.test.ts
│       └── review-manager.test.ts
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```
