# AGENTS.md

Working rules for `management_system`, a Next.js App Router / React / TypeScript application using Prisma, PostgreSQL, Auth.js with Feishu OAuth, Tailwind CSS, and Playwright. Its domains are procurement/reimbursement and project/stage/task/approval/progress management.

Business correctness, server-side permissions, auditability, and notification safety take priority over speed or elegance. This file defines repository-wide policy; nested `AGENTS.md` files add directory-specific rules.

## 1. Quick Workflow

1. Check `git status --short` and applicable directory instructions. Preserve existing user changes, including edits in files you also need to modify. Do not reset, stash, commit, or create branches unless requested.
2. Locate the relevant implementation and tests; read only the documentation needed for the affected behavior. Ask about unresolved business or safety decisions, not facts discoverable in the repository.
3. Before editing, define the outcome, acceptance criteria, and risk level. Identify affected roles, routes, state transitions, records, notifications, and audit logs where applicable.
4. Use a brief explicit plan for complex or multi-stage work; handle small, clear changes directly. Choose the smallest coherent change and reuse established patterns.
5. Implement with focused regression coverage; run targeted checks during iteration. Update only documentation affected by the behavior change.
6. Self-review the complete task diff, run the applicable completion gates once the change is stable, and obtain the review required by section 6.
7. Report changes, actual validation results, and remaining risks. Do not fix unrelated failures or broaden scope just to obtain a clean result.

## 2. Read on Demand

| Concern | Sources of truth |
| --- | --- |
| Setup, deployment, user workflows | `README.md` |
| Architecture, infrastructure, data model | `docs/TECH.md`, `prisma/schema.prisma`, relevant `prisma/migrations/` |
| Test setup, runner safety, domain scenarios | `docs/TESTING.md`, affected tests and helpers, `package.json` scripts |
| Notification events, recipients, delivery | `docs/NOTIFICATIONS.md`, affected notification implementation |
| Any behavior change | Existing entry points, domain services, permission helpers, and their direct consumers |

- Do not routinely read all reference documents or scan the whole repository. Expand exploration when a concrete dependency or risk requires it.
- For indexed code, use CodeGraph first as described in the managed block below. Reuse source already returned; fetch only missing context or files changed since the previous read.
- If CodeGraph is unavailable, cannot resolve the target, or misses current symbols, fall back to bounded `rg` searches and targeted file reads. Do not create or rebuild the index without the user's request.
- When implementation and documentation disagree, determine what is outdated. Preserve existing production behavior unless the task changes it; document the resolution rather than silently inventing a rule.

## 3. Non-Negotiable Safety

### Authorization and boundaries

- Treat client input, URL parameters, upload metadata, Feishu callbacks, and external API data as untrusted. Validate at server boundaries, preferably with existing Zod schemas.
- Enforce authentication, authorization, approval, and attachment access on the server using existing permission helpers. Hidden UI controls are not authorization.
- Keep credentials, Prisma access, filesystem operations, and integration secrets server-side; never query the database from client components or import browser-only code into server modules.
- Return understandable Chinese errors without raw validation output, SQL, stack traces, secrets, or internal identifiers. Use the structured logger and existing redaction; do not log full sensitive payloads.

### State, database, and audit

- Validate current state before every workflow transition. Preserve approval and delivery history, activity logs, and required timestamps; no UI-only transition rules.
- Use transactions for writes that must succeed together. Account for stale state, concurrency, duplicate approvals/callbacks, retries, and idempotency.
- Every schema change needs a new migration. Never edit or delete potentially applied migrations. Review existing-data compatibility, seeds, maintenance scripts, tests, and documentation.
- Do not perform destructive reset, truncate, drop, or bulk-delete operations without explicit authorization. Test migrations only against isolated PostgreSQL, never production or the normal development database.

### Feishu and external side effects

- Invoke the approval bot only to submit or request approval. All other Feishu messages use the notification bot; never use the approval bot as their fallback.
- Messages must include the operator, action, affected business entity, relevant status/change, and sufficient context to understand or act without unnecessarily opening the system.
- Never send real Feishu messages during automated tests. Do not bypass `NOTIFICATION_DELIVERY_DISABLED`, recipient allowlists, delivery guards, the outbox, or the official test runner's database, port, and Feishu egress protections.
- Keep business writes and notification records transactionally consistent or safely retryable. Preserve event-key/callback idempotency and tracked delivery/retry history; do not replace outbox delivery with untracked direct sends unless explicitly required.
- Do not hard-code production user/open/union IDs, webhook URLs, tokens, or credentials.

### Uploads and repository data

- Validate file type, size, path, ownership, and attachment access using existing helpers. Prevent path traversal and unsafe filenames; never expose raw filesystem paths to clients.
- Do not commit secrets, `.env` files, uploads, cookies, storage states, screenshots, reports, local databases, or `.tmp/` content.
- Do not remove tests, comments, documentation, or audit records merely to make a change easier; do not fabricate files, APIs, configuration, compatibility claims, or execution results.

## 4. Development Conventions

### Scope and implementation

- Keep changes focused; do not mix unrelated refactors, formatting, dependency upgrades, or renaming into feature work. Fix root causes rather than masking symptoms.
- Reuse components, validation, permissions, and domain services. Extract only for real duplication or a clear correctness benefit; avoid speculative abstractions and forwarding-only wrappers.
- Keep routes/pages/handlers in `app/`, mutation entry points in `app/actions/`, reusable business logic in `lib/`, validation in existing validation modules, and shared UI in `components/ui/`. Reuse the affected domain's existing organization.
- Use clear, strongly typed TypeScript with meaningful names, focused functions, and explicit side effects. Avoid `any`; isolate and explain unavoidable exceptions. Do not swallow exceptions or suppress lint/type errors without a narrow documented reason.
- Comments explain why, not what. Remove temporary debugging output; use the structured logger rather than `console.log`.
- Add dependencies only when the existing stack cannot reasonably solve the need; justify maintenance, licensing, and runtime/bundle cost. Update the lockfile with `package.json` changes.
- Keep user-facing application copy in Chinese unless explicitly requested otherwise.

### UI and accessibility

- Reuse UI primitives; preserve semantic controls, associated labels, keyboard operation, visible focus, and meaningful button names.
- Handle applicable loading, success, empty, disabled, and error states. Show actionable field-level errors and reveal/focus the first invalid field when practical.
- Avoid assumptions about ideal content length or record counts. Preserve stable accessible selectors or intentional `data-testid` values, not fragile CSS structure.
- For affected UI, test Desktop `1440x1000` and Pixel 5. Cover applicable long names/messages, missing data, dense lists, slow/loading states, read-only/denied access, and terminal/exceptional statuses; prevent horizontal overflow.

### Documentation

- Update documentation with behavior: `README.md` for setup/deployment/workflows, `docs/TECH.md` for architecture/configuration/data, `docs/TESTING.md` for verification, and `docs/NOTIFICATIONS.md` for events/recipients/routing/retries.
- Update `.env.example` for environment-variable changes without real secrets. Describe implemented behavior, not imagined design; do not update unrelated documents mechanically.

## 5. Risk-Based Validation

Choose gates by the impact of the whole task, not just the last edited file. Combine applicable rows; use the stricter gate when scope is uncertain. Local task completion and merge/release acceptance are distinct.

| Change | Local completion gate |
| --- | --- |
| Documentation/comments only, no executable behavior change | Task-scoped `git diff --check`; check affected links, paths, commands, and policy consistency. No application tests by default. |
| Local, non-high-risk code or tests | `npm run check` plus affected tests. No full E2E by default. |
| New or changed UI behavior | The code gate plus affected Playwright UI specs in both `desktop` and `mobile`; verify applicable edge states. |
| Authentication/permissions, state transitions, database, notifications, uploads, shared infrastructure, or cross-module behavior | `npm run check` plus full `npm run test:e2e`, with relevant domain/concurrency/side-effect coverage. |
| Merge or release acceptance | `npm run check` plus full `npm run test:e2e` and applicable build/migration/specialist checks; local or smoke results alone do not certify acceptance. |

### Coverage and additional gates

- Every new browser-accessible feature needs Playwright coverage of its primary workflow. Every bug fix needs a regression that fails before and passes after the fix where practical. Use reliable Node or integration coverage when browser coverage does not apply, and explain why.
- Permission changes test allowed and denied paths. State transitions verify UI and persisted state where practical. Notification tests verify outbox/guards without contacting real recipients.
- UI tests check navigation/submission, no server/Next.js error overlay, no new uncaught browser errors, no horizontal scrolling, and the affected states described in section 4.
- Run `npm run build` for build, route-boundary, configuration, deployment, or dependency changes.
- For schema/migration changes, explicitly target isolated PostgreSQL for `npm run db:deploy`, migration compatibility, and schema-drift validation following `docs/TESTING.md`; never inherit a development/production target accidentally.
- Runner or test-safety changes also require `npm run test:playwright-db-lifecycle` and `npm run test:playwright-db-safety`. Preserve applicable specialist migration/release checks and nightly scale coverage in the testing guide.
- Changes only to safety/validation/review policy documents need independent review but do not trigger application tests without executable changes. A documentation-only task cannot certify the underlying application's release readiness.

### Efficient, controlled execution

- Start with affected tests; run the stable-change completion gate once. Reuse a successful result only while its relevant source, tests, dependencies, configuration, and environment remain unchanged; rerun checks affected by subsequent fixes.
- `npm run check` already includes Node tests, application/script type checks, dependency checks, ESLint, and diff checks. Do not separately repeat these on the same unchanged state just for reporting.
- Use `npm run test:node` for the controlled Node suite. Select Playwright specs through `npm run test:e2e -- <related spec paths>`; retain both configured UI projects. Never use raw Playwright or direct Node test invocations to bypass safety guards, including for test collection.
- Database-backed automated tests must use isolated test databases and, where applicable, the official runner's controlled server; never target production or normal development services/data.
- `test:e2e:smoke` is partial coverage; `test:e2e:full` and `test:e2e` are the full entry points. Report selected scope accurately; collection/listing is not test execution.
- Do not run concurrent test commands that contend for a port, database, or shared fixtures. Do not mechanically parallelize existing serial suites or weaken safety guards for speed.
- If a required check fails or cannot run, report the exact command, reason, alternative validation, and remaining risk. Distinguish pre-existing failures from task regressions; do not claim a full gate passed because a targeted fallback passed.

## 6. Review and Delivery

- Self-review the entire task diff, including preservation of pre-existing user changes. Ordinary code changes require one independent subagent/reviewer pass at completion; high-risk work requires a pass for each coherent, independently verifiable stage.
- Pure wording changes normally need only self-review. Changes to safety rules, validation gates, or review policy always require independent review even when documentation-only.
- Give reviewers the task/acceptance criteria, exact diff or baseline, risk level, and validation evidence. Review the task diff and direct dependencies first; expand only for a concrete cross-module risk, not a routine whole-repository audit.
- Review applicable correctness, authorization/data exposure, state/concurrency/transactions, audit/error handling, Feishu/outbox safety, coverage reliability, desktop/mobile edge states, and unnecessary scope/abstraction.
- Fix in-scope actionable findings, rerun affected checks, and request incremental re-review of fixes and affected conclusions until no new actionable issues remain. Reuse prior evidence for unchanged areas; stylistic preference alone is not an actionable finding. Report unrelated issues instead of silently fixing them.
- Do not declare completion with an unresolved in-scope high-severity issue or required gate/review incomplete. If tooling blocks review, report the limitation and unresolved findings explicitly.

Completion requires satisfied acceptance criteria, applicable safety/coverage gates, the required clean review, synchronized documentation, and no introduced secrets, temporary artifacts, debugging output, or unrelated edits.

Keep the final report concise: what changed and which files, important decisions, commands actually run and their results, and remaining risks/limitations/follow-up. Never claim tests passed unless they actually ran successfully.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
