# Engineering Guide

This document is for engineers working on the bot itself — understanding the codebase,
tracing how data flows through the system, and knowing how to extend it.

For user-facing setup and concepts, see [how-it-works.md](./how-it-works.md).
For high-level architecture, see [solution-design.md](./solution-design.md).

---

## Getting Started

```bash
# Install dependencies
npm install

# Copy env vars and fill in your credentials
cp .env.example .env

# Run in dev mode (watches for file changes)
npm run dev

# Type check
npm run build

# Run tests
npm test
```

**Required env vars for local development:**

| Var | How to get it |
|---|---|
| `APP_ID` | GitHub App settings page |
| `PRIVATE_KEY` | Generated PEM from GitHub App settings |
| `WEBHOOK_SECRET` | Set when creating the GitHub App |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `WEBHOOK_PROXY_URL` | `npx smee -u $(npx smee --url)` — forwards GitHub webhooks to localhost |

---

## Module Map

Every file has a single, narrow responsibility. Here's the full map:

```
src/
├── index.ts                   Entry point — wires Probot to handlers
├── handlers/
│   ├── pull-request.ts        Receives pull_request webhooks, applies filters, routes
│   └── issue-comment.ts       Receives issue_comment.edited, drives approve/block
├── services/
│   ├── config-loader.ts       Reads .github/deploy-checklist.yml from the repo
│   ├── diff-analyzer.ts       Orchestrates skill detection → Claude → parsed result
│   ├── checklist.ts           Generates/parses/merges the markdown checklist comment
│   └── review-manager.ts      Posts GitHub reviews (REQUEST_CHANGES / APPROVE)
├── skills/
│   └── index.ts               14 built-in skills + detectActiveSkills() + computeUncoveredFiles()
├── prompts/
│   └── analysis.ts            Assembles the Claude prompt from skills, rules, diff, context
├── schemas/
│   ├── config.ts              Zod schema for the user's YAML config file
│   └── analysis-result.ts     Zod schema for Claude's tool use response
└── utils/
    ├── diff-truncation.ts     Smart truncation — prioritizes skill-matched files
    └── debounce.ts            Prevents re-analysis on rapid successive pushes
```

---

## Complete Data Flow

This traces the exact function call chain for the most common event: a PR is opened.

### 1. Webhook arrives → `src/index.ts`

Probot receives the `pull_request.opened` webhook and calls `handlePullRequest`.

```
handlePullRequest(context)          handlers/pull-request.ts:56
```

### 2. Load config → `config-loader.ts`

```
loadConfig(context, owner, repo, pr.head.sha)     config-loader.ts:110
  └─► fetchFileContent(...)                        config-loader.ts:23
        GitHub API: GET /repos/{owner}/{repo}/contents/.github/deploy-checklist.yml
        Returns null on 404 → falls back to buildDefaultConfig()
  └─► parseConfigContent(content, path)            config-loader.ts:57
        YAML or JSON parse depending on file extension
  └─► DeployChecklistConfigSchema.parse(raw)        schemas/config.ts
        Zod validation — throws on invalid shape
  └─► returns { config, warning? }
```

Config is read at `pr.head.sha` (the PR's head commit), not the base branch. This means
if the PR itself adds or changes `.github/deploy-checklist.yml`, those changes take effect
immediately during analysis.

### 3. Filter → `handlers/pull-request.ts`

Before doing any real work, three fast checks happen:

```
pr.draft && !config.settings.analyze_drafts   → skip
config.settings.ignore_authors.includes(author) → skip
!config.settings.target_branches.includes(pr.base.ref) → skip (if list is non-empty)
```

### 4. Fetch diff → `diff-analyzer.ts`

```
fetchPRDiff(context, owner, repo, pr.number)     diff-analyzer.ts:92
  └─► GitHub API: GET /repos/{owner}/{repo}/pulls/{number}
        with mediaType: { format: "diff" }
        returns raw unified diff text (not JSON)
```

The `Accept: application/vnd.github.diff` header is what makes GitHub return plain text
instead of a JSON object. Octokit types the response as a `PullRequest` object, so the
return value is cast with `as unknown as string`.

### 5. Skill detection → `skills/index.ts`

```
extractFilesFromDiff(diff)                        diff-analyzer.ts:111
  └─► regex /^diff --git a\/(.+?) b\//gm over the diff text
      returns string[] of changed file paths

detectActiveSkills(filesChanged, diff)            skills/index.ts
  └─► runs each of 14 skills' detect() functions
      detect() combines minimatch (paths) + RegExp (content) as needed
      returns Skill[] — only the skills that matched

computeUncoveredFiles(filesChanged, activeSkills) skills/index.ts
  └─► collects all paths + companionPaths from active skills
      returns files not matched by any of them
```

This step is entirely deterministic and involves no API calls. It happens before any
communication with Claude.

### 6. Build rules for truncation

```
skillsToRules(activeSkills)                       diff-analyzer.ts:78
  └─► converts Skill[] → Rule[] (adapter pattern)
      so truncateDiff() and fetchTriggeredFileContents() don't need new signatures

allRulesForTruncation = [...skillRules, ...config.rules]
```

### 7. Truncate diff → `utils/diff-truncation.ts`

```
truncateDiff(diff, config.settings.max_diff_size, allRulesForTruncation)
  └─► parseDiffFiles(diff)              splits on "diff --git " headers
  └─► fileMatchesRules(filename, rules) checks trigger.paths + missing_companion
  └─► separates files into triggered[] and nonTriggered[]
  └─► fills budget: triggered files first (up to 90% of max_diff_size)
                    then non-triggered files with remaining space
                    summarized filenames appended as comments for omitted files
  └─► returns { diff: string, truncated: boolean, filesSummarized: string[] }
```

The truncation budget (`max_diff_size`) is in characters, not tokens. The default (100,000)
leaves comfortable headroom within Claude's context window.

### 8. Fetch full file contents → `diff-analyzer.ts`

```
fetchTriggeredFileContents(context, owner, repo, ref, allRulesForTruncation, filesChanged)
  └─► collects paths from rules where trigger.include_full_files === true
      (currently: migration-entity skill sets includeFullFiles: true)
  └─► matches changed files against those patterns
  └─► fetches up to MAX_FULL_FILES (5) files via GitHub Contents API
        base64 decodes the content
        truncates to MAX_LINES_PER_FILE (500) lines
        404s are silently skipped (file deleted or not yet at this ref)
  └─► returns Map<filepath, content>
```

Full file contents are fetched because the diff alone doesn't show enough context to
identify the ORM or framework. Seeing `@Entity` in a diff doesn't tell you if it's
TypeORM or Hibernate — the full file's imports do.

### 9. Build prompt → `prompts/analysis.ts`

```
buildUserPrompt(config, prMeta, truncatedDiff, activeSkills, uncoveredFiles, fileContents)
  └─► sections assembled in this order:
      1. ## Active Skills       (each with systemContext + checks, only matched skills)
      2. ## Custom Rules        (config.rules, omitted if empty)
      3. ## Repository Context  (config.context, omitted if undefined — comes LAST for recency)
      4. ## PR Information      (title, description, base branch, files changed)
      5. ## Full File Contents  (only if fileContents.size > 0)
      6. ## Files Without Skill Coverage  (only if uncoveredFiles.length > 0)
      7. ## Diff                (truncated diff)
      8. ## Instructions        (use submit_analysis tool, be specific)
```

The ordering of sections 1–3 is intentional. Skills come first (general knowledge),
custom rules second, repo context last. LLMs have recency bias — later content overrides
earlier content when they conflict. The user's repo context is therefore the "final word"
on how to interpret the findings.

### 10. Call Claude → `diff-analyzer.ts`

```
anthropic.messages.create({
  model,
  max_tokens: 4000,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: userPrompt }],
  tools: [SUBMIT_ANALYSIS_TOOL],
  tool_choice: { type: "tool", name: "submit_analysis" },
})
```

`tool_choice: { type: "tool", name: "submit_analysis" }` forces Claude to call exactly
that tool — it cannot respond with a text block. The response is guaranteed to contain
a `tool_use` content block whose `input` is already a parsed JavaScript object matching
the tool's `input_schema`.

```
response.content.find(block => block.type === "tool_use")
  └─► toolUseBlock.input  ← already a JS object, no JSON.parse needed

AnalysisResultSchema.parse(toolUseBlock.input)
  └─► Zod validates shape and applies .default([]) for optional fields
  └─► returns typed AnalysisResult
```

The entire call is wrapped in a single `try/catch`. On any error — network, auth, schema
mismatch — `analyzeDiff` returns `null`. The caller (`handleNewAnalysis`) posts an
informational comment and does not block the PR.

### 11. Generate checklist → `services/checklist.ts`

```
generateChecklist(result, pr.head.sha)
  └─► sorts items by priority (high → medium → low)
  └─► renders each item as:
        - [ ] **{description}** {priorityBadge} — {reasoning}
          _Rule: {rule_id}_
  └─► if result.uncovered_files or result.open_concerns are non-empty:
        appends "### Needs Manual Review" section (no checkboxes)
  └─► embeds BOT_MARKER and <!-- sha:{sha} --> in HTML comments
        BOT_MARKER = "<!-- deploy-checklist-bot:v1 -->"
        used to identify the bot's comment later without querying the API for the author
```

### 12. Post comment + review → GitHub API

```
octokit.rest.issues.createComment(...)     posts the checklist markdown
blockPR(context, owner, repo, pr.number, ...)
  └─► dismissStaleReviews(...)              dismisses any existing bot CHANGES_REQUESTED review
  └─► octokit.rest.pulls.createReview(...)  posts REQUEST_CHANGES review → PR is blocked
```

---

## The Re-analysis Flow (push to existing PR)

When a developer pushes new commits, the `synchronize` event fires. The key difference
from a new PR is **state preservation** — items the engineer already checked should
not reset.

```
handleReanalysis(...)
  └─► debouncePR(key, debounceMs, callback)      utils/debounce.ts
        if another push arrives within debounceMs (default 5s), cancel this callback
        prevents hammering Claude on a rapid-fire rebase or force-push

  └─► findBotComment(...)
        lists all PR comments, finds the one containing BOT_MARKER
        returns { id, body } or null

  └─► fetchAndAnalyze(...)                        same path as new PR

  └─► parseChecklist(existingComment.body)        checklist.ts
        regex over the markdown, extracts { rule_id, description, checked } per item

  └─► mergeChecklist(oldState, newResult, newSha) checklist.ts
        builds lookup: "rule_id:description" → wasChecked
        new items that match an old item by that key inherit its checked state
        new items not in the old checklist start unchecked
        old items not in the new result are dropped

  └─► octokit.rest.issues.updateComment(...)      PATCH — updates existing comment in place
  └─► blockPR or approvePR based on whether "- [ ]" still exists in the markdown
```

---

## The Checkbox Flow (engineer checks off items)

```
handleIssueCommentEdited(context)           handlers/issue-comment.ts:10
  └─► filter: comment must contain BOT_MARKER, issue must be a PR
  └─► parseChecklist(comment.body)
        SHA_REGEX extracts the sha from <!-- sha:abc123 -->
        ITEM_REGEX (global) extracts all checklist items:
          /- \[([ x])\] \*\*(.+?)\*\*(?:\s*[^\n—]*)— (.+?)\n\s+_Rule: (.+?)_/g
        returns { sha, items: ChecklistItemState[], allComplete }
  └─► state.allComplete → approvePR()
      else              → blockPR()
```

The regex does not parse the "Needs Manual Review" section — those lines don't match
`- [ ]` so they're invisible to the completion check. The PR can be approved even if
open concerns exist.

---

## Key Design Decisions

### Tool use instead of JSON prompting

The previous implementation asked Claude to respond with a JSON blob in a text block.
Claude would sometimes wrap it in markdown fences despite being told not to, causing
parse failures that required a retry loop with increasingly strict instructions.

Tool use (`tool_choice: { type: "tool", name: "submit_analysis" }`) solves this at
the API level. Claude cannot produce a text block — the response is always a structured
`tool_use` block whose `input` the Anthropic API already parsed. No regex, no fences,
no retry loop.

### Skills are deterministic pre-filters, not AI

All 14 `detect()` functions are pure synchronous code — minimatch and RegExp. They run
before any API call and cost nothing. This means the Claude prompt only contains
knowledge relevant to the current PR. A PR that only changes CSS files will not send
migration expertise to Claude.

### The adapter pattern — `skillsToRules()`

`truncateDiff` and `fetchTriggeredFileContents` were written to accept `Rule[]` from
the user config schema. Rather than rewriting them to accept a union type, `skillsToRules`
converts `Skill[]` to `Rule[]` at call time. This keeps both functions unchanged and their
tests valid.

### Prompt section ordering — recency bias

The prompt ends with repo context, not starts. In autoregressive LLMs, later tokens
in the context carry more weight when the model generates its response. By putting
the user's `context` string after the skill system contexts, the user's repo-specific
knowledge acts as a correction layer — "we use Flyway so rollbacks are automatic" will
override the migration skill's generic "flag if no rollback exists."

### The bot never blocks its own failures

`analyzeDiff` returns `null` on any unrecoverable error. The handler catches `null`,
posts an informational comment, and returns without calling `blockPR`. The engineer
sees a warning but can still merge. The bot being a merge blocker due to its own
infrastructure failures is a worse outcome than a missed checklist.

### Comment identity via `BOT_MARKER`

The bot identifies its own comment by searching for the hidden HTML string
`<!-- deploy-checklist-bot:v1 -->` in comment bodies. It does not query the GitHub
API for the comment author (which would require an extra round trip and depends
on the bot's authenticated identity). The marker approach is faster and works
regardless of how the app is installed or named.

---

## How to Add a New Skill

Open `src/skills/index.ts` and add a new entry to the `SKILLS` array.

Every skill needs:

```typescript
{
  id: "your-skill-id",           // unique, kebab-case
  name: "Human Readable Name",   // shown in the prompt as "### Skill: your-skill-id"
  paths: [                       // glob patterns for path-based coverage
    "**/some-path/**",
  ],
  companionPaths: [              // optional — expected companion files
    "**/expected-companion/**",
  ],
  includeFullFiles: true,        // optional — fetch full file contents for these paths
  detect(filesChanged, diffContent) {
    // Return true if this skill should fire for this PR.
    // Use matchesPaths() and matchesContent() helpers defined at the top of the file.
    return matchesPaths(filesChanged, this.paths) ||
           matchesContent(diffContent, ["yourPattern"]);
  },
  systemContext: `
    Multi-framework domain knowledge goes here.
    This is what Claude reads before looking at the diff.
    Be specific about what varies by framework and how to identify it.
  `,
  checks: [
    "First specific thing to verify",
    "Second specific thing to verify",
  ],
}
```

**Coverage**: `paths` and `companionPaths` define what counts as "covered" in
`computeUncoveredFiles`. Content-only skills (no paths) contribute no path coverage —
files they trigger on may still appear in uncovered_files.

**Testing**: Add a test in `test/services/diff-analyzer.test.ts` or a dedicated skill
test file verifying that `detectActiveSkills` returns your skill for the right inputs
and doesn't return it for unrelated ones.

---

## How the Zod Schemas Fit Together

**`schemas/config.ts`** — validates the user's YAML config file. Has a `rules: []` default
so a config with no `rules` key is valid. The `context` field is optional.

**`schemas/analysis-result.ts`** — validates Claude's tool use response. The two new fields
(`uncovered_files`, `open_concerns`) use `.default([])` so existing test fixtures and
callers that don't provide them still parse cleanly.

Both schemas use `z.infer<typeof Schema>` to derive TypeScript types, so the runtime
validation and compile-time types are always in sync.

---

## Testing Approach

Tests live in `test/` and mirror the `src/` structure. The framework is Vitest.

```bash
npm test              # run all tests
npm test -- --watch   # watch mode
npm test -- path/to/specific.test.ts  # single file
```

**What's unit-tested:**
- `config-loader.test.ts` — schema validation edge cases
- `diff-analyzer.test.ts` — `extractFilesFromDiff`, `fetchTriggeredFileContents`
- `diff-analyzer-companion.test.ts` — companion path detection via `skillsToRules`
- `diff-truncation.test.ts` — truncation budget, priority ordering, summarized files
- `checklist.test.ts` — markdown generation, parsing, merging, completion detection
- `analysis.test.ts` — prompt assembly, section presence/absence by input
- `review-manager.test.ts` — approve/block/dismiss logic
- `handlers/pull-request.test.ts` — filter logic, routing to sub-handlers
- `handlers/issue-comment.test.ts` — BOT_MARKER filtering, approve/block decisions

**What's not unit-tested:**
- Claude API calls (would require real credentials and real diffs)
- GitHub API calls (mocked via Probot's test utilities in handler tests)
- The skill `detect()` functions themselves (covered indirectly through diff-analyzer tests)

**Fixtures for analysis result:** `checklist.test.ts` and others use an `AnalysisResult`
fixture. It must include `uncovered_files: []` and `open_concerns: []` — these are
required by the Zod schema's `.default([])` only when parsing, not when constructing
objects in TypeScript directly.

---

## Common Gotchas

**Config is read from `pr.head.sha`, not base branch.** If someone changes the config
in the PR itself, the new config is used for that PR's analysis. This is intentional —
it lets you test config changes in a PR before merging.

**`ITEM_REGEX` is stateful.** It uses the global `/g` flag. The `lastIndex` must be
reset to 0 before calling `exec()` in a loop, otherwise it skips matches on the second
call with the same regex instance. See `checklist.ts:88`.

**`dismissStaleReviews` only dismisses `CHANGES_REQUESTED` reviews**, not `APPROVED`.
If the bot approved and then a new push triggers a block, the approve is not dismissed —
the new `REQUEST_CHANGES` supersedes it in GitHub's merge-blocking logic.

**The debounce is fire-and-forget.** `debouncePR` does not return a Promise. Errors
inside the debounced callback are caught and logged but not propagated to the webhook
handler. This is intentional — the webhook response (200 OK) is sent immediately; the
actual work happens asynchronously.

**`minimatch` requires `{ dot: true }` for dotfiles.** Without it, patterns like
`.github/workflows/**` won't match `.github/workflows/ci.yml` because minimatch treats
leading dots as hidden by default. All path matching in the codebase passes `{ dot: true }`.
