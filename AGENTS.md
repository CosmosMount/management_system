# AGENTS.md

This document defines the working rules for AI coding agents and developers contributing to `management_system`.

## 1. Project Overview

`management_system` is a full-stack RoboMaster management system built with Next.js. It currently includes two major business domains:

- Procurement and reimbursement management
- Project, stage, task, approval, and progress management

The main technical stack is:

- Next.js App Router, React, and TypeScript
- Prisma and PostgreSQL
- Auth.js with Feishu OAuth
- Feishu bots, interactive cards, and notification outbox delivery
- Tailwind CSS and shared UI components
- Playwright end-to-end testing

Business correctness, permission enforcement, auditability, and notification safety take priority over code elegance or implementation speed.

## 2. Sources of Truth

Before making changes, inspect the relevant code and documentation instead of relying on assumptions.

Use the following files as primary references:

- `README.md`: setup, deployment, and user-facing workflows
- `docs/TECH.md`: architecture, data model, infrastructure, and implementation notes
- `docs/TESTING.md`: testing procedures and expected business flows
- `docs/NOTIFICATIONS.md`: notification events and delivery behavior
- `prisma/schema.prisma`: current database model
- `prisma/migrations/`: database migration history
- Existing implementation and tests for the affected feature

When documentation and implementation disagree, do not silently choose one. Determine whether the code or documentation is outdated, preserve existing production behavior unless the task explicitly changes it, and update the relevant documentation as part of the change.

## 3. Requirements Before Implementation

Do not start implementing a feature until its intended behavior is clear.

Before editing code:

1. Identify the exact user-visible and system-visible outcome.
2. Define the acceptance criteria.
3. Identify the affected users, roles, permissions, routes, state transitions, database records, notifications, and audit logs.
4. Inspect the existing implementation paths and reuse established patterns where appropriate.
5. Determine the smallest coherent change that satisfies the requirement.

For a large or multi-stage task, write a brief implementation plan before changing code. Do not invent missing APIs, data models, environment variables, or business rules.

## 4. Change Scope and Design Rules

### 4.1 Prefer Minimal, Focused Changes

- Make the smallest change that fully solves the requested problem.
- Do not modify unrelated files or behavior.
- Do not combine feature work, broad refactoring, formatting, and dependency upgrades in the same change unless they are inseparable.
- Preserve existing naming, directory structure, API conventions, and business workflows unless there is a clear reason to change them.
- Do not rewrite working code only to make it stylistically preferable.

### 4.2 Reuse Without Over-Abstraction

- Reuse existing components, utilities, validation schemas, permission helpers, and domain services when they already match the requirement.
- Do not duplicate domain rules in multiple routes or components.
- Do not create an abstraction only because code might be reused in the future.
- Extract shared code when there is real duplication, a stable shared concept, or a clear correctness benefit.
- Avoid wrapper layers that merely rename or forward arguments without adding meaningful behavior.

### 4.3 Dependencies

- Do not add a dependency when the existing stack can reasonably implement the feature.
- Any new dependency must have a clear purpose, active maintenance, compatible licensing, and acceptable bundle or runtime cost.
- Changes to `package.json` must include the corresponding lockfile update.

## 5. Repository Architecture Conventions

Follow the existing repository organization:

- `app/`: routes, pages, layouts, route handlers, and server actions
- `app/actions/`: mutation entry points and server-side orchestration
- `components/`: feature and shared React components
- `components/ui/`: reusable UI primitives
- `lib/`: domain logic, permissions, integrations, validation helpers, and infrastructure
- `lib/validations/`: reusable input validation schemas
- `prisma/`: schema, migrations, and seed logic
- `scripts/`: operational, migration, cron, and maintenance scripts
- `tests/`: Playwright E2E, integration, and regression tests
- `docs/`: technical, testing, notification, and workflow documentation

Additional rules:

- Keep browser-only code out of server modules.
- Keep secrets, Prisma access, filesystem operations, and Feishu credentials on the server.
- Do not access the database directly from client components.
- Keep reusable business rules in `lib/` rather than duplicating them across pages or server actions.
- Keep user-facing application copy in Chinese unless the task explicitly requires another language.

## 6. Backend and Business Logic Rules

### 6.1 Validation and Authorization

- Treat all client input, URL parameters, uploaded file metadata, Feishu callbacks, and external API data as untrusted.
- Validate input at the server boundary, preferably with existing Zod schemas or a new schema in `lib/validations/`.
- Enforce authorization on the server even when the UI hides an action.
- Reuse the existing permission helpers instead of reimplementing role logic locally.
- Error messages shown to users must be understandable Chinese messages and must not expose stack traces, raw Zod output, SQL, secrets, or internal identifiers.

### 6.2 State Transitions

- Treat project, stage, task, procurement, approval, and notification statuses as explicit state machines.
- Verify that the current state permits the requested transition before writing data.
- Preserve approval history, delivery history, activity logs, timestamps, and other audit records required by the existing workflow.
- Make repeated submissions, approvals, callbacks, and notification attempts idempotent where practical.
- Do not add a UI-only state transition that can be bypassed through direct server action invocation.

### 6.3 Database Changes

- Use Prisma and PostgreSQL conventions already present in the repository.
- Create a new migration for every schema change.
- Never edit or delete a migration that may already have been applied.
- Do not use destructive reset, truncate, drop, or bulk-delete operations without explicit authorization.
- Use a transaction when a business operation requires multiple writes to succeed or fail together.
- Consider concurrency, duplicate approval, stale state, and retry behavior for workflow changes.
- When changing the schema, also review seed scripts, maintenance scripts, tests, documentation, and existing data compatibility.

## 7. Feishu, Notifications, and External Side Effects

Feishu messages and external side effects require special care.

- The system uses two distinct Feishu bots: an approval bot and a notification bot. The approval bot may only be invoked when submitting or requesting an approval. All other Feishu messages must be sent through the notification bot. Do not use the approval bot as a fallback for ordinary notifications.
- Every Feishu message must be as complete and informative as reasonably possible. Include the operator, the action performed, the affected project, procurement request, task, or other business entity, the relevant status or status change, and any additional context needed for the recipient to understand and act on the message without opening the system unnecessarily.
- Never send real Feishu messages during automated tests.
- Do not bypass `NOTIFICATION_DELIVERY_DISABLED`, recipient allowlists, delivery guards, or the notification outbox.
- Do not replace retryable outbox delivery with an untracked direct send unless explicitly required.
- Notification event keys and callback handling must remain idempotent.
- A business state change and its notification record should be transactionally consistent or safely retryable.
- Never hard-code production user IDs, open IDs, union IDs, webhook URLs, tokens, or credentials.
- Do not log secrets or full sensitive payloads. Use the existing structured logger and redaction behavior.
- Tests must use the controlled Playwright server and isolated test database. Never point tests at production or the normal development database.

## 8. File Upload and Data Safety

- Validate file type, size, path, and ownership using the existing upload helpers.
- Enforce attachment authorization on the server.
- Do not expose raw filesystem paths to clients.
- Prevent path traversal and unsafe filename handling.
- Do not commit uploaded files, cookies, storage states, screenshots, generated reports, local databases, `.env` files, or `.tmp/` content.

## 9. Frontend and UI Rules

- Reuse existing UI primitives and feature patterns before creating new ones.
- Preserve accessibility: semantic controls, associated labels, keyboard operation, visible focus states, and meaningful button names.
- Every asynchronous interaction must handle loading, success, empty, disabled, and error states where applicable.
- Forms must display actionable field-level errors and focus or reveal the first relevant invalid field when practical.
- Avoid layouts that depend on ideal content length or a fixed amount of data.
- Do not introduce horizontal overflow at the supported desktop and mobile viewports.
- Preserve stable selectors through accessible roles, visible names, or intentional `data-testid` values. Do not write tests that depend on fragile CSS structure.

For new or changed styles, explicitly test extreme states such as:

- Very long project, task, user, item, and file names
- Empty lists and missing optional data
- Large record counts or dense tables
- Long validation and server error messages
- Slow loading and disabled actions
- Narrow mobile screens
- Permission-restricted and read-only states
- Completed, rejected, canceled, archived, overdue, and other terminal or exceptional states

## 10. Code Quality Rules

- Write clear, direct, strongly typed TypeScript.
- Avoid `any`; when unavoidable, isolate it and explain why.
- Use names that reflect business meaning. Avoid unclear abbreviations.
- Keep functions focused on one responsibility.
- Prefer explicit return values and side effects.
- Comments should explain why a decision exists, not restate what the code does.
- Do not silently swallow exceptions.
- Use the existing structured logger instead of temporary `console.log` debugging.
- Remove temporary debugging code before completion.
- Do not suppress lint or type errors without a narrow, documented reason.

## 11. Testing Requirements

### 11.1 Mandatory Tests

- Every newly added feature must include Playwright E2E coverage for its primary user workflow.
- Every bug fix must include a regression test that fails before the fix and passes after it whenever technically practical.
- Permission-sensitive changes must test both an allowed and a denied path.
- State-transition changes must verify both the UI result and the persisted database state when practical.
- Notification changes must verify outbox or delivery-guard behavior without contacting real recipients.
- Database migrations must be tested against an isolated PostgreSQL database.

When a change cannot reasonably be exercised through a browser, add the closest reliable automated integration or domain-level regression test and explain why browser coverage is not applicable.

### 11.2 UI Test Coverage

All new or modified frontend behavior must be tested with Playwright at both configured projects:

- Desktop: `1440x1000`
- Mobile: Pixel 5 profile

Tests should verify, as applicable:

- No server error or Next.js error overlay
- No new uncaught browser errors
- No unexpected horizontal scrolling
- Correct loading, empty, error, disabled, and success states
- Correct behavior with long and edge-case content
- Correct role and permission behavior
- Stable navigation and form submission

### 11.3 Required Validation Commands

Run the following before declaring a change complete:

```bash
npm run check
npm run test:e2e
```

Also run the relevant commands when the change affects them:

```bash
npm run build             # Build, route boundary, configuration, or deployment changes
npm run db:deploy         # Prisma schema or migration changes
```

Targeted tests may be used during development, but a workflow-wide or shared-infrastructure change requires the relevant full regression suite before completion.

If a required command cannot be run, report:

- The exact command not run
- The reason it could not be run
- What was validated instead
- The remaining risk

Never claim that a test passed unless it was actually executed successfully.

## 12. Review Rules

After completing each coherent feature stage:

1. Perform a self-review of the complete diff.
2. Run the relevant checks and tests.
3. Ask a separate subagent or reviewer to inspect the change.
4. Fix every actionable issue found.
5. Re-run affected checks and tests.
6. Request another review.
7. Repeat until the reviewer reports no new actionable issues.

The review must consider at least:

- Functional correctness and acceptance criteria
- Authorization and data exposure
- State-transition validity
- Database consistency and concurrency
- Feishu and notification side effects
- Error handling and auditability
- Test completeness and reliability
- Desktop, mobile, and extreme UI states
- Unnecessary abstraction, duplication, or unrelated changes

Do not mark work complete while a known high-severity issue remains unresolved. If review cannot continue because of a tool or environment limitation, report that limitation and all known unresolved findings explicitly.

## 13. Documentation Rules

Update documentation in the same change when behavior changes.

- Update `README.md` for user-visible setup, deployment, or workflow changes.
- Update `docs/TECH.md` for architecture, configuration, data model, or infrastructure changes.
- Update `docs/TESTING.md` for new test setup or manual verification procedures.
- Update `docs/NOTIFICATIONS.md` for new or changed notification events, recipients, routing, or retry behavior.
- Update `.env.example` when adding or changing environment variables. Never add real secrets.

Documentation must describe the implemented behavior, not a planned or imagined design.

## 14. Prohibited Actions

Unless explicitly requested and justified, do not:

- Bypass authentication, authorization, approval, or attachment permission checks
- Disable or weaken Playwright database, port, notification, or recipient safety guards
- Run automated tests against production services or data
- Send real Feishu notifications as part of testing
- Edit applied migration history
- Perform destructive database operations
- Hard-code secrets or production identities
- Introduce broad formatting or refactoring unrelated to the task
- Remove tests, comments, documentation, or audit records merely to make a change easier
- Hide failures by catching and ignoring errors
- Fabricate files, APIs, configuration, execution results, or compatibility claims

## 15. Completion Report

When finishing a task, provide a concise report containing:

1. What changed
2. Which files were changed
3. Important implementation decisions
4. Tests and commands actually run
5. Remaining risks, limitations, or follow-up work

## 16. Definition of Done

A change is complete only when all applicable items are true:

- The requested behavior and acceptance criteria are satisfied.
- Authorization is enforced on the server.
- Relevant state transitions and side effects are correct.
- Database changes include safe migrations and compatibility review.
- Required Playwright and regression tests exist.
- New or changed UI has been checked on desktop, mobile, and extreme states.
- `npm run check` passes.
- Relevant E2E tests pass.
- Required build or migration validation passes.
- A subagent review reports no new actionable issues.
- Documentation is updated.
- No secrets, temporary files, debug output, or unrelated changes are included.