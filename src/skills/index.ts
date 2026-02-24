import { minimatch } from "minimatch";

// ─────────────────────────────────────────────────────────────────────────────
// Skill Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  detect: (filesChanged: string[], diffContent: string) => boolean;
  systemContext: string;  // multi-framework domain knowledge for Claude
  checks: string[];
  paths: string[];            // for truncateDiff prioritization
  companionPaths?: string[];  // for missing-companion detection
  includeFullFiles?: boolean; // for fetchTriggeredFileContents
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: path matching
// ─────────────────────────────────────────────────────────────────────────────

function matchesPaths(filesChanged: string[], patterns: string[]): boolean {
  return filesChanged.some((file) =>
    patterns.some((pattern) => minimatch(file, pattern, { dot: true }))
  );
}

function matchesContent(diffContent: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const iFlag = pattern.startsWith("(?i)");
    const src = iFlag ? pattern.slice(4) : pattern;
    return new RegExp(src, iFlag ? "i" : "").test(diffContent);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 14 Built-in Skills
// ─────────────────────────────────────────────────────────────────────────────

const SKILLS: Skill[] = [
  // ── 1. migration-entity ──────────────────────────────────────────────────
  {
    id: "migration-entity",
    name: "Entity/Model Change Without Migration",
    paths: [
      "**/entities/**",
      "**/models/**",
      "**/entity/**",
      "**/model/**",
    ],
    companionPaths: [
      "**/migrations/**",
      "**/migrate/**",
      "db/migrate/**",
      "alembic/versions/**",
    ],
    includeFullFiles: true,
    detect(filesChanged, diffContent) {
      const pathMatch = matchesPaths(filesChanged, this.paths);
      const contentMatch = matchesContent(diffContent, [
        "@Column",
        "@Entity",
        "@Table",
        "createTable",
        "addColumn",
        "Schema\\.define",
        "models\\.Model",
        "DataTypes\\.",
      ]);
      return pathMatch || contentMatch;
    },
    systemContext: `Entity/model change detected. Determine if a database migration is required.
Different ORMs and frameworks handle migrations differently:
- TypeORM (@Entity, @Column decorators): check for a new migration file in migrations/
- Django (models.py, models.Model): check for manage.py makemigrations output in migrations/
- Sequelize (DataTypes, queryInterface): check for a new migration file in migrations/ or db/migrate/
- Rails (ActiveRecord): check for a new file in db/migrate/
- Prisma (schema.prisma changes): check that prisma migrate has been run and migration file exists
- SQLAlchemy/Alembic: check for a new file in alembic/versions/
- Raw SQL createTable/addColumn: check for a corresponding migration script

Look at the file extension and imports to identify the framework.
If the entity/model change requires a schema change (new column, renamed column, changed type,
new table) and no migration file is present in the PR, flag this as a deploy risk.
If the change is purely logic (no schema impact), note that no migration is needed.`,
    checks: [
      "Determine if the entity/model changes require a new database migration",
      "If a migration is needed, verify one exists in this PR — flag if missing",
      "Check for backward compatibility: can old code run against the new schema?",
    ],
  },

  // ── 2. migration-review ──────────────────────────────────────────────────
  {
    id: "migration-review",
    name: "Database Migration Safety",
    paths: [
      "**/migrations/**",
      "db/migrate/**",
      "alembic/versions/**",
      "**/migrate/**",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `Database migration detected. Different frameworks have different rollback patterns:
- Django: RunSQL needs reverse_sql param; atomic=False required for large tables (>1M rows);
  check that the migration does not drop columns that the currently-deployed code still reads
- Prisma: check schema.prisma for breaking type changes; verify client is regenerated in the PR;
  Prisma migrations are not reversible by default — flag if rollback script is absent
- Rails: check for down method or reversible block in the change method; ensure no
  irreversible operations (remove_column, change_column) without explicit down
- Alembic: check downgrade() function exists and correctly reverses the upgrade()
- Raw SQL: check for explicit rollback/down script in the same PR or documented procedure
- Sequelize: check that down() function is implemented and tested

Large table concerns (any framework):
- Adding a non-nullable column without a default to a large table causes lock
- Adding an index without CONCURRENTLY (PostgreSQL) can lock the table
- Renaming/dropping columns is a two-phase deploy (deploy new code first, then migrate)

Look at the file extension and content to identify the framework, then apply checks.`,
    checks: [
      "Verify rollback strategy exists (down() / downgrade() / reverse migration)",
      "Check that the migration is backward-compatible with currently running code",
      "Flag any operations that could cause table locks on large tables",
      "Confirm irreversible operations (drop column, change type) are intentional",
    ],
  },

  // ── 3. env-vars ───────────────────────────────────────────────────────────
  {
    id: "env-vars",
    name: "New Environment Variables",
    paths: [],
    detect(_filesChanged, diffContent) {
      return matchesContent(diffContent, [
        "process\\.env\\.",
        "os\\.environ",
        "ENV\\[",
        "getenv\\(",
        "dotenv",
        "config\\(\\)",
      ]);
    },
    systemContext: `Environment variable usage detected in the diff.
Focus on NEW variables being introduced (added lines starting with +), not existing ones.
Check:
- Is this a new env var reference that does not exist in .env.example or deployment config?
- Is the var optional (with a default/fallback) or required at startup?
- If required and missing from a deployment target, the service will crash on boot
- Check if a .env.example, docker-compose.yml, or deployment YAML was also updated with the new var
- Check if secrets management (Vault, AWS SSM, GCP Secret Manager) needs updating

Distinguish between:
- config references like process.env.NODE_ENV (likely already set) — lower risk
- new feature flags or service URLs being introduced — flag for deployment config update`,
    checks: [
      "Confirm new environment variables are set in all deployment targets (staging, prod)",
      "Verify .env.example or deployment documentation is updated with new vars",
      "Check if new vars are required at startup — missing required vars cause boot failures",
    ],
  },

  // ── 4. secrets ────────────────────────────────────────────────────────────
  {
    id: "secrets",
    name: "Credential or Secret Exposure Risk",
    paths: [],
    detect(_filesChanged, diffContent) {
      return matchesContent(diffContent, [
        "(?i)(api[_-]?key|access[_-]?token|secret[_-]?key|private[_-]?key|client[_-]?secret)",
        "(?i)(password|passwd|pwd)\\s*[=:]\\s*['\"][^'\"]{6,}",
        "BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY",
        "sk-[a-zA-Z0-9]{20,}",
        "ghp_[a-zA-Z0-9]{36}",
        "vault\\.read|secretsmanager|aws_secret",
      ]);
    },
    systemContext: `Look for patterns that suggest credential exposure or rotation needs:
- Hardcoded API keys, tokens, passwords, private keys in the diff (added lines starting with +)
- New references to secrets managers (Vault, AWS Secrets Manager, GCP Secret Manager)
  without corresponding secret creation in the same PR
- Removed secret references that may still be needed by running code
- Rotation triggers: if a secret-reading mechanism changed, the secret may need rotation

Distinguish between:
- Config references using env vars or secrets manager paths (safe) — these are correct patterns
- Hardcoded credential values in source code (dangerous) — must be flagged immediately
- Test fixtures with fake credentials (acceptable if clearly fake/test-only)

Common false positives to recognize: variable names like "apiKey" without values,
placeholder strings like "YOUR_API_KEY_HERE", and test data with obviously fake values.`,
    checks: [
      "Check for hardcoded credentials, tokens, or private keys in added lines",
      "Verify new secrets manager references have corresponding secrets provisioned",
      "Confirm removed secret references are not still needed by any running code",
    ],
  },

  // ── 5. api-contract ───────────────────────────────────────────────────────
  {
    id: "api-contract",
    name: "API Contract Change",
    paths: [
      "**/routes/**",
      "**/api/**",
      "**/controllers/**",
      "**/*.proto",
      "**/schema.graphql",
      "**/graphql/schema/**",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `API contract changes are either breaking or non-breaking.

BREAKING (requires consumer notification + versioning strategy):
  - Removing or renaming an endpoint or field
  - Changing a parameter from optional to required
  - Changing response structure or types
  - Changing authentication requirements
  - Changing HTTP methods or status codes
  - Changing error response formats

NON-BREAKING (safe to ship without consumer coordination):
  - Adding new optional endpoints
  - Adding new optional response fields
  - Relaxing validation rules
  - Adding new optional query parameters

If breaking AND consumed by a frontend, flag for frontend team review.
If a proto/GraphQL schema change, verify generated clients are regenerated in the same PR.
Check the HTTP method being used — REST conventions matter for caching and idempotency.`,
    checks: [
      "Classify each endpoint change as breaking or non-breaking",
      "For breaking changes, verify consumer teams (frontend, other services) are notified",
      "Check that generated clients (proto, GraphQL) are regenerated in this PR",
      "Verify backward compatibility or versioning strategy for breaking changes",
    ],
  },

  // ── 6. api-schema ─────────────────────────────────────────────────────────
  {
    id: "api-schema",
    name: "API Schema File Change",
    paths: [
      "openapi.yml",
      "openapi.yaml",
      "swagger.yml",
      "swagger.yaml",
      "**/openapi/**",
      "**/swagger/**",
      "**/*.proto",
      "**/schema.graphql",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `API schema definition file changed (OpenAPI/Swagger, Protobuf, GraphQL schema).
These files are often the source of truth for generated code and consumer contracts.

Check for:
- Breaking changes in the schema: removed fields, changed types, removed operations
- Whether code generation needs to be re-run (protoc, swagger-codegen, graphql-codegen)
- Whether the schema version was bumped appropriately
- Whether SDK or client library updates are needed for consumers
- Whether documentation was updated to reflect schema changes
- For OpenAPI/Swagger: check deprecated fields are properly marked before removal

Proto files: check that the wire format is backward compatible (field numbers not reused,
old fields not removed, only adding new fields with new numbers).
GraphQL: check that no previously-existing types or fields are removed without a deprecation period.`,
    checks: [
      "Verify breaking schema changes are intentional and consumers are prepared",
      "Check that code generation has been re-run and generated files are committed",
      "Confirm schema version is bumped appropriately for breaking changes",
    ],
  },

  // ── 7. configuration ──────────────────────────────────────────────────────
  {
    id: "configuration",
    name: "Configuration or Feature Flag Change",
    paths: [
      "**/config/**",
      "*.config.ts",
      "*.config.js",
      "*.config.mjs",
      "app.yml",
      "app.yaml",
      "settings.py",
      "application.yml",
      "application.yaml",
      "appsettings.json",
    ],
    detect(filesChanged, diffContent) {
      const pathMatch = matchesPaths(filesChanged, this.paths);
      const contentMatch = matchesContent(diffContent, [
        "feature[_-]?flag",
        "featureFlag",
        "FEATURE_",
        "LaunchDarkly",
        "unleash",
        "flipper",
        "rollout",
      ]);
      return pathMatch || contentMatch;
    },
    systemContext: `Configuration or feature flag change detected.
Configuration changes can affect runtime behavior in ways that aren't obvious from the diff.

Check for:
- New configuration keys that must be set in all environments before deployment
- Changed default values that affect existing behavior for all users
- Feature flags: are they defaulting to on or off? Is the rollout strategy intentional?
- Removed configuration that dependent code still references
- Environment-specific overrides that may behave differently in production vs staging
- Secrets or sensitive values accidentally placed in configuration files

Feature flag patterns to watch:
- Flags that default to enabled affect all users immediately on deploy
- Flags tied to specific user segments need the targeting rules deployed first
- Removing a flag requires ensuring the code path for both branches is removed`,
    checks: [
      "Verify new configuration keys are set in all target environments",
      "Check that changed defaults are intentional and documented",
      "For feature flags, confirm rollout strategy (default on/off, targeting) is intentional",
      "Ensure removed configuration is not still referenced by running code",
    ],
  },

  // ── 8. data-access ────────────────────────────────────────────────────────
  {
    id: "data-access",
    name: "Database Query Safety",
    paths: [],
    detect(_filesChanged, diffContent) {
      return matchesContent(diffContent, [
        "SELECT .* FROM",
        "INSERT INTO",
        "UPDATE .* SET",
        "DELETE FROM",
        "\\.findAll\\(",
        "\\.findMany\\(",
        "\\.query\\(",
        "WHERE .* LIKE",
        "for.*await.*find",
        "forEach.*query",
        "N\\+1",
      ]);
    },
    systemContext: `Database query patterns detected in the diff.
Review for common data access antipatterns that cause production incidents:

N+1 query problem:
- A loop that runs a query on each iteration (forEach + findOne, for + await query())
- ORM lazy loading triggered in a loop
- Fix: eager load with include/join, or batch with IN clause

Missing indexes:
- WHERE clauses on columns that may not be indexed (check schema or migration for index)
- ORDER BY on unindexed columns causes full table scan
- JOIN conditions on non-primary-key columns

Query safety:
- Raw SQL with string interpolation is SQL injection risk — must use parameterized queries
- LIKE '%value%' causes full table scan — consider full-text search for large tables
- SELECT * fetches unnecessary columns — prefer explicit column selection

Transaction safety:
- Multiple writes that should be atomic but are not wrapped in a transaction
- Long-running transactions that hold locks`,
    checks: [
      "Check for N+1 query patterns (queries inside loops)",
      "Verify WHERE clause columns have appropriate indexes",
      "Confirm raw SQL uses parameterized queries, not string interpolation",
      "Check that related writes are wrapped in transactions where appropriate",
    ],
  },

  // ── 9. authentication ─────────────────────────────────────────────────────
  {
    id: "authentication",
    name: "Authentication or Authorization Change",
    paths: [
      "**/auth/**",
      "**/middleware/**",
      "**/guards/**",
      "**/interceptors/**",
    ],
    detect(filesChanged, diffContent) {
      const pathMatch = matchesPaths(filesChanged, this.paths);
      const contentMatch = matchesContent(diffContent, [
        "authenticate",
        "authorize",
        "jwt\\.verify",
        "jwt\\.sign",
        "session\\.",
        "passport\\.",
        "requireAuth",
        "@Auth",
        "RBAC",
        "permission",
        "role\\.",
      ]);
      return pathMatch || contentMatch;
    },
    systemContext: `Authentication or authorization logic changed.
Auth bugs are high-severity — they can allow unauthorized access or break login for all users.

Check for:
AUTH BYPASS RISKS:
- Removed or weakened authentication checks on protected routes
- Logic errors in permission checks (AND vs OR, negation errors)
- New code paths that skip middleware/guards
- Fallthrough cases in switch/if chains that grant access unintentionally

SESSION/TOKEN CHANGES:
- JWT secret rotation: old tokens become invalid — all users get logged out
- Session configuration changes: may invalidate existing sessions
- Token expiration changes: shorter = more secure but more friction; longer = less secure
- Cookie security attributes (httpOnly, secure, sameSite) being weakened

SAFE CHANGES (lower risk):
- Adding new optional scopes or permissions
- Tightening validation (making checks stricter)
- Logging additions to auth flows

Always verify: is there a test covering the auth logic change?`,
    checks: [
      "Verify no authentication checks are removed or bypassed",
      "Check for logic errors in permission/role checks",
      "Confirm token/session changes are backward compatible with active user sessions",
      "Verify cookie security attributes are not weakened",
    ],
  },

  // ── 10. infrastructure ────────────────────────────────────────────────────
  {
    id: "infrastructure",
    name: "Infrastructure as Code Change",
    paths: [
      "**/*.tf",
      "**/*.tfvars",
      "**/k8s/**",
      "**/kubernetes/**",
      "**/helm/**",
      "**/ansible/**",
      "**/terraform/**",
      "**/*.hcl",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `Infrastructure as code change detected.
IaC changes can have large blast radius — always require plan/preview before apply.

Terraform:
- Check if terraform plan has been run and output is in the PR or linked
- Destructive operations: resource deletion/replacement (shown as "-/+" in plan)
- State changes that affect running resources (VPC, database, load balancer)
- Variable changes that cascade to multiple resources
- Provider version bumps that may have breaking changes

Kubernetes / Helm:
- Deployment changes: image, replicas, resource limits, health check thresholds
- Service changes: port, selector label changes can cause traffic drops
- ConfigMap/Secret changes: pods need restart to pick up changes
- RBAC changes: new ClusterRole or RoleBinding — check what permissions are being granted
- Ingress changes: host/path changes affect routing; TLS changes affect certificates

Ansible:
- Check idempotency — running twice should not break things
- Check for tasks that could destroy data (file removal, database operations)

General:
- Does this change require coordination with another team (networking, security, DBA)?
- Are monitoring and alerting updated to reflect new resource names/labels?`,
    checks: [
      "Verify terraform plan / dry-run output has been reviewed before applying",
      "Check for destructive operations (resource deletion, replacement) in the plan",
      "Confirm Kubernetes pod restart is triggered for ConfigMap/Secret changes",
      "Verify RBAC changes grant only the minimum necessary permissions",
    ],
  },

  // ── 11. ci-cd ─────────────────────────────────────────────────────────────
  {
    id: "ci-cd",
    name: "CI/CD Pipeline Change",
    paths: [
      ".github/workflows/**",
      ".gitlab-ci.yml",
      "Jenkinsfile",
      ".circleci/**",
      ".buildkite/**",
      "azure-pipelines.yml",
      "**/.drone.yml",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `CI/CD pipeline configuration changed.
Pipeline changes can affect every future deployment — review carefully.

Check for:
SECURITY:
- New secrets being used — are they provisioned in the CI secret store?
- Third-party actions being pinned to a commit SHA (best practice) vs a mutable tag
- New upload/publish steps that could expose artifacts or tokens
- Self-hosted runner usage — are the runners trusted?

CORRECTNESS:
- Branch filters: will this pipeline run on the right branches?
- Changed deployment targets or environments
- Removed required status checks — can PRs now be merged without passing tests?
- Changed test steps — are the same tests still running?

SIDE EFFECTS:
- New scheduled jobs that weren't running before
- Changed notification settings (who gets alerted on failure?)
- Artifact retention changes
- Cache invalidation (cache key changes cause cold start)

If the pipeline change affects deployment steps, verify staging is tested before prod.`,
    checks: [
      "Verify new secrets referenced in the pipeline are provisioned in the CI secret store",
      "Check that third-party actions are pinned to a commit SHA, not a mutable tag",
      "Confirm required status checks are not removed or weakened",
      "Verify the pipeline runs on the correct branches for the intended trigger",
    ],
  },

  // ── 12. dependencies ──────────────────────────────────────────────────────
  {
    id: "dependencies",
    name: "Dependency Lockfile Change",
    paths: [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "poetry.lock",
      "go.sum",
      "Gemfile.lock",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "Cargo.lock",
      "composer.lock",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `Dependency lockfile changed.
Dependency changes can introduce security vulnerabilities or breaking behavior changes.

Check for:
SECURITY:
- Was npm audit / pip-audit / bundle-audit / go mod verify run?
- Are there known CVEs in the updated packages? (Check package advisories)
- New packages being added — are they from a trusted source?
- Packages with unusual post-install scripts

VERSION CONCERNS:
- Major version bumps may have breaking API changes
- Transitive dependency changes (indirect dependencies) can also introduce issues
- Downgraded packages may remove security fixes

SUPPLY CHAIN:
- New packages that were recently published or have very few downloads
- Packages with typosquatting names similar to popular packages
- Packages that have changed owners recently

BEST PRACTICE:
- Lock file should be committed to ensure reproducible builds
- Direct dependency version in package.json/pyproject.toml should match intent`,
    checks: [
      "Verify a security audit (npm audit, pip-audit) was run and issues addressed",
      "Review major version bumps for breaking changes in the changelog",
      "Check newly added packages for trustworthiness and necessity",
    ],
  },

  // ── 13. docker ────────────────────────────────────────────────────────────
  {
    id: "docker",
    name: "Docker Configuration Change",
    paths: [
      "Dockerfile",
      "Dockerfile.*",
      "**/Dockerfile",
      "**/Dockerfile.*",
      "docker-compose.yml",
      "docker-compose.yaml",
      "docker-compose.*.yml",
      "docker-compose.*.yaml",
      ".dockerignore",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `Docker configuration changed.

IMAGE HYGIENE:
- Base image changes: is the new image pinned to a digest or mutable tag (e.g., :latest)?
  Pinning to digest (sha256:...) ensures reproducible builds; mutable tags can change silently
- New packages installed: are they minimal? Do they introduce vulnerabilities?
- Multi-stage build: is the final stage lean (no build tools, source code)?
- Non-root user: is the container running as a non-root user?

SECRETS IN LAYERS:
- Build arguments (ARG) should not contain secrets — they are baked into the image history
- COPY of .env or credentials files is dangerous — check .dockerignore
- Environment variables with secrets in the Dockerfile — use secrets at runtime instead

HEALTH CHECKS:
- Is a HEALTHCHECK instruction present? Required for proper orchestration signals
- Does the health check path actually reflect application health?

COMPOSE CHANGES:
- Port mapping changes: is a new port being exposed publicly?
- Volume mount changes: data persistence impact
- Network changes: service-to-service connectivity
- Changed entrypoint or command`,
    checks: [
      "Verify base image is pinned to a digest or specific version tag, not :latest",
      "Check that no secrets are baked into image layers (ARG, COPY of .env files)",
      "Confirm a HEALTHCHECK instruction exists and points to the correct endpoint",
      "Review port and volume changes for unintended exposure or data loss risk",
    ],
  },

  // ── 14. api-routes ────────────────────────────────────────────────────────
  {
    id: "api-routes",
    name: "API Route Change",
    paths: [
      "**/routes/**",
      "**/api/**",
      "**/controllers/**",
      "**/views/**",
      "**/endpoints/**",
    ],
    detect(filesChanged) {
      return matchesPaths(filesChanged, this.paths);
    },
    systemContext: `API route or controller change detected.
Route-level concerns not fully covered by api-contract or api-schema skills.

Check for:
INPUT VALIDATION:
- New parameters accepted without validation — can users send arbitrary data?
- Missing rate limiting on new public endpoints
- Missing authentication/authorization on new endpoints

ERROR HANDLING:
- New error paths that could leak stack traces or internal details to clients
- Missing error handlers that could cause 500s on invalid input

PERFORMANCE:
- New endpoints that perform expensive operations (large queries, external calls) without caching
- Missing pagination on endpoints that return potentially large datasets
- Synchronous operations that should be async (file processing, email sending)

IDEMPOTENCY:
- POST endpoints that should be PUT/PATCH for idempotent operations
- Missing idempotency keys for payment or critical mutation endpoints`,
    checks: [
      "Verify all new parameters are validated before use",
      "Check that new public endpoints have appropriate rate limiting and authentication",
      "Confirm error responses do not leak sensitive internal information",
      "Review endpoints returning lists for missing pagination",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Public Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run each skill's detect() against the changed files and diff content.
 * Returns only skills that match — this is the pre-filtering step before Claude.
 */
export function detectActiveSkills(
  filesChanged: string[],
  diffContent: string
): Skill[] {
  return SKILLS.filter((skill) => skill.detect(filesChanged, diffContent));
}

/**
 * A file is "covered" if at least one active skill's paths or companionPaths
 * matches it via minimatch.
 *
 * Content-only skills (env-vars, secrets, data-access) have no paths and
 * contribute no path coverage — files they trigger on may still appear in
 * uncovered_files. This is acceptable for V1.
 */
export function computeUncoveredFiles(
  filesChanged: string[],
  activeSkills: Skill[]
): string[] {
  const allCoveredPatterns: string[] = [];

  for (const skill of activeSkills) {
    allCoveredPatterns.push(...skill.paths);
    if (skill.companionPaths) {
      allCoveredPatterns.push(...skill.companionPaths);
    }
  }

  if (allCoveredPatterns.length === 0) {
    return filesChanged;
  }

  return filesChanged.filter(
    (file) =>
      !allCoveredPatterns.some((pattern) =>
        minimatch(file, pattern, { dot: true })
      )
  );
}
