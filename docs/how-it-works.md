# How Deploy Checklist Bot Works

This document explains everything from scratch — what the bot does, how to set it up,
what happens behind the scenes when a PR is opened, and how the bot decides what to check.

---

## What is this bot?

When an engineer opens a pull request, code reviewers focus on logic: is the code correct?
does it make sense? But there's a different class of problem that code review routinely misses
— the "did you remember to..." questions that only matter at deploy time:

- Did you add the new environment variable to the production config?
- Did you write a rollback plan for that database migration?
- Did you tell the frontend team that you renamed that API field?
- Did you check the Docker image for secrets baked into the layers?

These aren't bugs in the code. They're operational concerns that only surface after you deploy
— often as an incident at 2am.

The bot reads every PR diff, identifies which of these concerns apply to the actual changes,
and posts a checklist comment that must be fully checked off before the PR can be merged.

---

## Setting Up the Bot

### Step 1 — Install the GitHub App

Install the Deploy Checklist Bot GitHub App on your repository. This gives the bot permission
to read your PR diffs, post comments, and post reviews (which is what blocks or unblocks merging).

The bot needs these GitHub permissions:
- **Pull requests** — read diffs, post reviews
- **Issues** — post and edit comments (GitHub treats PR comments as issues)
- **Contents** — read your config file from the repo

### Step 2 — Add a config file (optional)

Create `.github/deploy-checklist.yml` in your repo. This is where you tell the bot about
your specific setup — what framework you use, what teams to notify, any concerns unique to
your codebase.

If you don't add a config file, the bot works immediately using only its built-in knowledge
(called skills — more on those below).

Here's a minimal config:

```yaml
# .github/deploy-checklist.yml

version: 1

context: |
  Django monorepo with PostgreSQL on AWS RDS.
  Deployments go through our internal deploy tool — zero-downtime, blue-green.
  The payments module requires extra caution — flag any changes there.
```

That's it. The `context` field is free text that the bot passes to Claude alongside every
analysis. Use it to describe your stack, your deployment process, and anything the bot
should know about your system that it can't figure out from the code alone.

### Step 3 — Open a PR

The bot wakes up automatically. No commands, no triggers. Every PR opened against a watched
branch gets analyzed.

---

## What Happens When You Open a PR

Here is the exact sequence of events, step by step.

```
You open a PR
      │
      ▼
GitHub sends a webhook to the bot server
      │
      ▼
Bot reads your config file from the repo
(or uses defaults if no config file exists)
      │
      ▼
Bot fetches the PR diff from GitHub
(the raw text showing what changed, line by line)
      │
      ▼
Bot runs skill detection against the diff
(14 built-in checks — "does this diff touch migrations?
does it change env vars? does it modify Docker config?")
      │
      ▼
Bot builds a prompt for Claude:
  - What skills fired and their domain knowledge
  - Your custom rules (if any)
  - Your repo context string (if any)
  - The PR title, description, and file list
  - The actual diff content
      │
      ▼
Claude analyzes the diff and returns structured findings
(via tool use — no free-form JSON, no parsing guesswork)
      │
      ▼
Bot posts a checklist comment on the PR
      │
      ▼
Bot posts a "Request Changes" review → PR is blocked from merging
```

Every checklist item must be manually checked off by the engineer before the bot will
approve and unblock the merge.

### What happens when you push new commits

The bot re-analyzes the updated diff. It preserves any checkboxes you already checked
for items that still apply. New items from the new commits appear unchecked. Items that
no longer apply (because you reverted something) disappear. The PR stays blocked until
everything is checked.

### What happens when you check off items

When you tick a checkbox in the bot's comment, GitHub fires an `issue_comment.edited`
webhook. The bot parses the comment, counts checked vs unchecked items. When all items
are checked, the bot posts an approving review and the PR is unblocked.

---

## How Skills Work

Skills are the bot's built-in domain knowledge. They answer the question: "for this specific
type of change, what should an engineer verify before deploying?"

There are 14 built-in skills. Each one handles a category of concern that applies across
all tech stacks — not specific to Django or Rails or Prisma, but to the concern itself.

### How a skill is structured

Every skill has three parts:

**1. A detector** — decides whether this skill applies to the current PR.

The detector looks at the list of changed files and the diff content. It uses file path
patterns (glob matching) and content patterns (regex). It's entirely deterministic —
no AI involved at this stage. Fast, cheap, and reliable.

Example: the `migration-review` skill fires whenever a file in `**/migrations/**`,
`db/migrate/**`, or `alembic/versions/**` is changed.

**2. System context** — domain knowledge sent to Claude when the skill fires.

This is the expertise. The `migration-review` skill's system context reads:

> "Django: RunSQL needs reverse_sql param; atomic=False required for large tables.
> Prisma: check schema.prisma for breaking type changes; verify client is regenerated.
> Rails: check for down method or reversible block in change method.
> Alembic: check downgrade() function exists and is correct."

Claude reads this before it reads your diff. It knows what to look for and how different
frameworks handle the concern — without you having to explain any of this in your config.

**3. Checks** — the specific questions to answer.

These become the checklist items. For `migration-review`:
- Verify rollback strategy exists
- Check that the migration is backward-compatible with currently running code
- Flag any operations that could cause table locks on large tables

### The 14 built-in skills

| Skill | Fires when... | Catches... |
|---|---|---|
| **migration-entity** | entity/model files change | ORM changes that need a migration but don't have one |
| **migration-review** | migration files are added | Rollback safety, backward compat, table lock risk |
| **env-vars** | new `process.env` / `os.environ` references appear | New vars not set in production |
| **secrets** | credential-like patterns appear in the diff | Hardcoded secrets, unprovisioned vault references |
| **api-contract** | routes, controllers, or API files change | Breaking vs non-breaking changes, consumer impact |
| **api-schema** | OpenAPI, Swagger, proto, or GraphQL schema changes | Generated client regeneration, spec versioning |
| **configuration** | config files or feature flag patterns change | New config keys, default value changes |
| **data-access** | raw SQL or ORM query patterns appear | N+1 queries, missing indexes, SQL injection risk |
| **authentication** | auth, middleware, or JWT patterns change | Auth bypass risk, session invalidation |
| **infrastructure** | Terraform, Kubernetes, Helm, or Ansible files change | Destructive infra ops, needs plan before apply |
| **ci-cd** | GitHub Actions, GitLab CI, or Jenkinsfile changes | Unintended side effects, unpinned action versions |
| **dependencies** | lockfiles change | Security advisories, major version breaking changes |
| **docker** | Dockerfile or docker-compose files change | Secrets in layers, unpinned base images, missing healthchecks |
| **api-routes** | route or controller files change | Missing validation, missing auth, missing pagination |

### What "pre-filtering" means

Before calling Claude, the bot runs all 14 skill detectors against the PR. Only the skills
that actually fire are sent to Claude. If a PR only touches migration files, Claude only
sees the `migration-review` skill's context — not all 14 skills. This keeps the prompt
focused and the analysis specific to the actual changes.

---

## Files Without Coverage

Sometimes a PR changes files that no skill recognizes — internal tooling, custom scripts,
domain-specific modules that the built-in skills don't know about.

The bot tracks these as "uncovered files" and asks Claude to scan them for any obvious
deploy risk. If Claude spots something, it appears in a "Needs Manual Review" section at
the bottom of the checklist comment:

```
### Needs Manual Review

The following files are not covered by any skill or rule — review manually:
- src/internal-tool/scheduler.ts

Potential deploy concerns in uncovered files:
- **src/internal-tool/scheduler.ts**: Cron expression changed from every hour to every minute — verify this is intentional, it will run 60x more often in production.
```

These don't have checkboxes — they're informational. The bot is saying "I noticed something
here but I'm not sure enough to make it a required item."

---

## Custom Rules

Skills handle universal concerns. Custom rules handle things only your team knows about.

```yaml
# .github/deploy-checklist.yml

rules:
  - id: payments-module
    description: "Payment processing code changed"
    trigger:
      paths:
        - "src/payments/**"
        - "src/billing/**"
    checks:
      - "Notify the payments team in #payments-alerts before merging"
      - "Verify the change was load-tested against the payment sandbox"
      - "Confirm idempotency keys are used for all new payment operations"
```

Rules use simple glob patterns for path matching and regex for content matching. They don't
have system context — Claude uses only what you write in the `checks` list. For complex
domain knowledge, use the `context` field at the top level of your config.

### How skills and custom rules coexist

When a PR is analyzed, Claude sees:
1. The skills that fired (with their full domain knowledge)
2. Your custom rules (with your checks)
3. Your repo context (your description of the stack and any overrides)

Your repo context comes last in the prompt — this is intentional. If a skill says "flag
missing rollback strategy" but your context says "we use Flyway which handles rollbacks
automatically", Claude reads your context after the skill and understands the correction.
Your repo-specific knowledge overrides the generic skill knowledge.

---

## The Config File Reference

```yaml
# .github/deploy-checklist.yml

version: 1

settings:
  # Analyze draft PRs immediately, or wait until marked ready for review
  analyze_drafts: false

  # Skip analysis for bot-authored PRs (Dependabot, Renovate, etc.)
  ignore_authors:
    - dependabot[bot]
    - renovate[bot]

  # Only analyze PRs targeting these branches (empty = all branches)
  target_branches:
    - main
    - production

  # Post a comment even when no checklist items are generated (clean PRs)
  post_empty_checklist: false

  # Max diff size sent to Claude (characters). Large diffs are smart-truncated.
  max_diff_size: 100000

# Your custom rules — stack on top of built-in skills
rules:
  - id: your-rule-id
    description: "Human-readable description"
    trigger:
      paths:
        - "src/some-path/**"       # glob patterns for file paths
      content:
        - "somePattern\\.here"     # regex patterns matched against diff content
    checks:
      - "First thing to verify"
      - "Second thing to verify"

# Free-text description of your repo sent to Claude on every analysis.
# Use this to describe your stack, deployment process, and anything
# that should override or narrow the built-in skill knowledge.
context: |
  Node.js API deployed on Kubernetes via Helm.
  PostgreSQL on RDS — we use Flyway for migrations, rollbacks are automatic.
  Blue-green deployment — no downtime, but env vars must be set before deploy.
  The /payments route is PCI-scoped — any change there needs security review.
```

---

## Data Flow Summary

```
PR opened
    │
    ├─► GitHub API → config file (.github/deploy-checklist.yml)
    │       └── parsed, validated, defaults applied
    │
    ├─► GitHub API → PR diff (raw unified diff text)
    │       └── truncated if over max_diff_size, prioritizing changed files
    │           that match skill or rule patterns
    │
    ├─► Skill detection (deterministic, no AI)
    │       └── 14 detectors run against file list + diff content
    │           → produces: active skills, uncovered files
    │
    ├─► GitHub API → full file contents (for skills with includeFullFiles)
    │       └── entity/model files fetched so Claude can identify ORM/framework
    │
    ├─► Claude API (tool use)
    │       Input:
    │         - Active skill contexts (domain knowledge)
    │         - Custom rules (from config)
    │         - Repo context string (from config, comes last)
    │         - PR metadata (title, description, file list)
    │         - Full file contents (if fetched)
    │         - Truncated diff
    │       Output (structured, schema-enforced):
    │         - items[]  (checklist items with rule_id, description, priority)
    │         - summary  (one-sentence risk assessment)
    │         - uncovered_files[]
    │         - open_concerns[]
    │
    ├─► Checklist generation
    │       └── markdown comment with checkboxes, sorted by priority
    │
    ├─► GitHub API → POST comment on PR
    │
    └─► GitHub API → POST "Request Changes" review → PR blocked
```