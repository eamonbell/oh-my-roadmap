# Milestone Notes

---
kind: worker
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-1
task_id: budget-control
worker_id: worker-heavy
blocking: false
status: resolved
at: 2026-07-22T23:48:22.597Z
---

## budget-control completed: atomic baseline and override mutations

Completed active-scope budget controls. packages/core/src/enforcement.ts now exports setActiveBudgetCeiling plus structured BudgetCeilingMutationResult/BudgetOneShotMutationResult values; baseline values use the existing token/cost/time parsers, unlimited removes only the selected dimension, ordinary finite increases are rejected with audited-raise guidance, and complete read-modify-write sequences for baseline, audited raise, and one-shot grant are serialized with withStoreWriteLock. Existing audit and one-shot state semantics remain intact, while results expose scope, dimension where applicable, previous/new ceiling, and persisted BudgetScopeState. Added test/budget-controls.test.ts covering roadmap and milestone scopes, all dimensions, initial/equal/lower/unlimited behavior, preservation of overrides/time tracking, increase rejection without mutation, missing active roadmap/milestone, caller-supplied default audit actor, and concurrent baseline/raise/one-shot updates. Updated test/budget-override.test.ts for structured results and caller-passed `user` audit identity. Touched: packages/core/src/enforcement.ts, test/budget-controls.test.ts, test/budget-override.test.ts. Context consulted: docs/design.md, docs/tutorial.md, and the approved native-handler decision in .omr/execution-budgets/decisions.md. Verification performed here: TypeScript LSP diagnostics report no errors in all three owned files (test files retain only Bun expect `await has no effect` hints also present in existing tests). Per worker constraints, builds/tests were not run. Reviewer should run: bun test test/budget-controls.test.ts test/budget-override.test.ts. Residual risk: concurrency behavior is covered by the new Promise.all filesystem-lock test but awaits reviewer execution; dispatch-time one-shot consumption/re-lock code was intentionally left unchanged.

---
kind: worker
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-1
task_id: budget-reporting
worker_id: worker-heavy
blocking: false
status: resolved
at: 2026-07-22T23:50:00.661Z
---

## budget-reporting completed: shared summaries and status/usage integration

Completed the shared read-only budget reporting surface. Added packages/core/src/budget-report.ts with typed active roadmap/milestone summaries, configured-dimension consumption, threshold and over-budget state, honest unknown-cost handling, compact override totals/available one-shots/latest audit context, deterministic scope filtering, operator unit formatting, and line/Markdown formatters whose empty-state results are []/empty string. Integrated formatted lines after existing usage output in packages/core/src/report/shared.ts, packages/core/src/report/render.ts, and packages/extension/src/extension/commands/usage.ts. Status warnings now derive from the loaded summary while retaining existing warning text/order; rm-usage Markdown includes budgets while JSON and no-budget output remain unchanged. Added test/budget-report.test.ts and expanded test/usage.test.ts for tokens/cost/time, both scopes, over-budget headroom, unknown USD, override summaries, scope filters, status/usage ordering, and exact no-budget compatibility. Touched: packages/core/src/budget-report.ts; packages/core/src/report/shared.ts; packages/core/src/report/render.ts; packages/extension/src/extension/commands/usage.ts; test/budget-report.test.ts; test/usage.test.ts. Referenced: approved milestone plan, packages/core/src/budget.ts, enforcement.ts, elapsed-time.ts, persistence/loadState and usage contracts, docs/design.md, and docs/tutorial.md. Verification performed within worker constraints: LSP diagnostics are clean for every changed implementation file and test/budget-report.test.ts; test/usage.test.ts has only a pre-existing await-no-effect hint. Reviewer should run: bun test test/budget-report.test.ts test/usage.test.ts test/budget-override.test.ts. Residual risk: runtime assertions await reviewer execution because workers are prohibited from running builds/tests during the concurrent wave.

---
kind: review
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-1
blocking: false
status: resolved
at: 2026-07-22T23:51:20.730Z
---

## wave-1 review: PASSED — atomic controls and shared summaries verified

PASS: Reviewed both worker notes and all wave-owned implementation/tests. `setActiveBudgetCeiling`, `applyBudgetRaiseCeiling`, and `grantBudgetOneShot` serialize the complete active-scope read-modify-write under `withStoreWriteLock`; baseline set/lower/clear preserves unrelated override/time state and rejects a finite ceiling increase with audited-raise guidance. The structured results expose scope, dimension, prior/new ceiling, and persisted state.

PASS: `budget-report` produces deterministic configured-dimension lines for roadmap and milestone scopes, formats tokens/USD/durations, clearly marks overages, suppresses false precision for unknown costs, summarizes overrides, and returns empty formatter output for no-budget state. Status and Markdown usage integrate these lines only when summary state is present; JSON usage remains unchanged.

PASS: `bun run check` passed. The required focused verification invocation passed: 38 tests, 0 failures.

NON_BLOCKING: `bun test` reported 429 pass / 3 fail, all outside this wave: `test/style.test.ts` expects Go global style guidance but receives none, and `test/cli.test.ts` expects top-level global OMP paths but receives the active profile path. No wave-owned path appears in those diagnostics.

NON_BLOCKING: The supplied focused command names `test/budget-commands.test.ts` and `test/budget-operator-integration.test.ts`, but those paths do not exist yet; Bun silently skipped them. They concern later command/integration acceptance and are outside this wave's ownership. No active-wave blocker found.

---
kind: worker
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-2
task_id: findings-budget
worker_id: worker
blocking: false
status: resolved
at: 2026-07-22T23:54:15.168Z
---

## Findings reports now surface shared budget summaries

Completed work:
- `omr_submit_findings_report` now loads the shared budget summary after the existing UI-availability guard and appends the core formatter's generated Markdown section only when it is non-empty.
- Added a pure composition helper so no-budget Markdown is returned byte-for-byte unchanged, including an empty caller body handling path when budget Markdown is present.
- Extended the findings-tool tests for no-budget identity; configured token, cost, and time dimensions; hard/over-budget labels; compact override output; two independent submissions; UI-unavailable behavior; and widget shutdown.

Touched files:
- packages/extension/src/tools/register/findings-report-tool.ts
- test/tools/findings-report-tool.test.ts

Decisions and references:
- Reused `formatBudgetSummaryMarkdown` from `@oh-my-roadmap/core/budget-report`, which is the shared summary formatter consumed by the status/usage surfaces. Reviewed the approved findings-budget plan section, formatter implementation, existing findings/widget lifecycle, and relevant design/tutorial search results.

Verification for reviewer:
- Run `bun test test/tools/findings-report-tool.test.ts`.
- LSP diagnostics report no issues in either touched TypeScript file.

Residual risk:
- Tests were intentionally not executed because wave review owns verification; Markdown widget rendering is covered by the added test but should be confirmed by the assigned command.

---
kind: worker
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-2
task_id: budget-commands
worker_id: worker
blocking: false
status: resolved
at: 2026-07-22T23:55:31.111Z
---

## Registered native budget slash commands

Completed native /omr:budget-show, /omr:budget-set, and /omr:budget-override handlers. Added strict raw-argument parsing, optional --by actor parsing with default user, core control/report integration, diagnostic timing, and custom command-result successes/failures without agent prompt dispatch. Added registration and behavioral tests for busy/idle independence, scope filtering/default show, set/clear effects, override audit actors, parser boundaries, missing milestones, ordinary increases, and no mutations on invalid commands. Touched packages/extension/src/extension/commands/budget.ts, catalog.ts, register.ts, test/budget-commands.test.ts, and test/commands.test.ts. Consulted the approved native-handler decision, docs/design.md, command registration/message conventions, and core enforcement/budget-report APIs. LSP diagnostics are clean for all new/edited source and budget test files; test/commands.test.ts has one pre-existing unrelated await hint. Reviewer verification: bun test test/budget-commands.test.ts test/commands.test.ts. Residual risk: verification command was intentionally not run by this worker per wave policy.

---
kind: review
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-2
blocking: true
blocker_id: blk_fafe35d9-bd66-4459-a5dc-58639f10c356
status: open
at: 2026-07-22T23:56:49.018Z
---

## Wave 2 review failed: budget command expectation and documentation scope

BLOCKING (worker-fixable): `bun test test/budget-controls.test.ts test/budget-report.test.ts test/budget-commands.test.ts test/tools/findings-report-tool.test.ts test/budget-operator-integration.test.ts test/usage.test.ts test/commands.test.ts` fails in `test/budget-commands.test.ts:103`. The shared formatter correctly emits `Budget milestone m01-core time`, but the new command test asserts the non-existent `Budget milestone time`. Update the expected command output to match the shared milestone line format, then rerun the command. `bun test` also fails on that same command test; its other three failures are unrelated pre-existing `style.test.ts` and `cli.test.ts` expectations outside this wave. `bun run check` passes.

BLOCKING (needs-user-decision): The approved acceptance criteria require `docs/design.md` and `docs/tutorial.md` to document budget thresholds, command syntax, governance, output/unknown-cost behavior, and recovery. Neither file is owned by either wave-2 task nor contains any budget guidance. Assign and approve this omitted documentation scope before the wave can meet the stated acceptance criteria.

PASS: Native handlers are registered with diagnostic timing and dispatch custom command-result messages rather than model prompts. Handler parsing invokes core set/raise/one-shot mutations, preserving the core persistence/lock semantics; tests cover default and explicit audit actors, missing milestone, rejected ordinary raise, malformed inputs, and no-prompt behavior. Findings use the shared Markdown formatter and preserve caller Markdown byte-for-byte when no budget summary exists; tests cover configured dimensions, overrides, two independent submissions, UI unavailable, and shutdown cleanup.

NON_BLOCKING: The targeted command excludes `test/budget-operator-integration.test.ts` because that path does not exist, so Bun reported it as skipped; the planned end-to-end integration coverage cannot be confirmed from the supplied path.

---
kind: issue
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-2
task_id: budget-commands
worker_id: worker
blocking: false
blocker_id: blk_71dee48d-5fb3-4fcf-8fa7-4ec2af67c4ac
status: resolved
at: 2026-07-22T23:57:24.227Z
reconciled: true
reconciled_reason: Task budget-commands resolved via another worker; superseded issue retracted.
reconciled_at: 2026-07-22T23:57:54.810Z
---

## Rework edit blocked by implementation gate

Attempted the requested one-line test expectation correction in test/budget-commands.test.ts after confirming the target assertion. The edit gate rejected it because the wave-2 review blocker is still open, even though this is the authorized worker-fixable rework. No files changed. Main/orchestrator should activate or redispatch budget-commands for rework (or otherwise restore its write authorization) and then have this worker apply the exact one-line assertion update. No user decision or unowned file is needed.

---
kind: worker
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-2
task_id: budget-commands
worker_id: worker
blocking: false
status: resolved
at: 2026-07-22T23:57:46.864Z
---

## Corrected milestone budget formatter expectation

Applied the requested one-line worker-fixable review correction only: test/budget-commands.test.ts now expects the shared formatter's actual milestone label, `Budget milestone m01-core time`, for the default all-scopes result. Production command code, docs, and all other assertions were left unchanged. No tests were run per rework instruction. Reviewer verification: bun test test/budget-controls.test.ts test/budget-report.test.ts test/budget-commands.test.ts test/tools/findings-report-tool.test.ts test/budget-operator-integration.test.ts test/usage.test.ts test/commands.test.ts. Residual risk: reviewer command remains unexecuted by this worker.

---
kind: review
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-2
blocking: false
status: resolved
at: 2026-07-22T23:58:36.228Z
---

## Wave 2 re-review passed after command expectation correction

PASS: Re-ran `bun run check` and the prescribed focused command `bun test test/budget-controls.test.ts test/budget-report.test.ts test/budget-commands.test.ts test/tools/findings-report-tool.test.ts test/budget-operator-integration.test.ts test/usage.test.ts test/commands.test.ts`; type checking passed and the focused suite passed 45/45 tests (530 assertions). The corrected command expectation now matches the shared milestone formatter label.

PASS: Active-wave review confirms all three native budget commands register as native custom-result handlers, validate/mutate/report via the core APIs without model prompts, and the tests exercise success, invalid input, rejected ordinary raises, default/explicit override actors, persisted audit behavior, and no-budget output. Findings use the shared Markdown formatter and tests cover conditional single Budget-section composition, configured thresholds/overrides, no-budget identity, widget rendering, UI-unavailable behavior, and cleanup.

NON_BLOCKING: The earlier `bun test` run had unrelated failures in `test/style.test.ts` and `test/cli.test.ts`; they remain outside wave-2. The focused invocation reports `test/budget-operator-integration.test.ts` skipped because the supplied path does not exist, but all discovered focused test files passed. Documentation is explicitly owned by approved wave-3 `integration-docs` and is not evaluated as a wave-2 blocker.

---
kind: worker
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-3
task_id: integration-docs
worker_id: worker
blocking: false
status: resolved
at: 2026-07-23T00:00:53.199Z
---

## Completed budget operator lifecycle evidence and documentation

Touched test/budget-operator-integration.test.ts, docs/design.md, and docs/tutorial.md. Added a core-function integration scenario covering active roadmap/milestone setup, no-budget no-op behavior, roadmap and milestone baselines, persisted usage, hard threshold enforcement and exact summary labels, rejected ordinary raise, audited raise, and one-shot audit state. Documented budget YAML locations, lock-safe mutation behavior, threshold defaults and soft/hard recovery, native TUI command grammar, exact no-budget and unknown-cost output, and automatic findings budget sections. Verified by code review only; per wave constraints no commands were run. Reviewer should run: bun test test/budget-operator-integration.test.ts; bun run check; bun test. Residual risk: integration assertions depend on existing helper milestone id m01-core and formatter output contracts, which the listed suite must confirm.

---
kind: review
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
wave_id: wave-3
task_id: integration-docs
worker_id: WaveThreeReview
blocking: true
blocker_id: blk_b67e2eb1-c074-4991-bdb0-555c074372a8
status: open
at: 2026-07-23T00:02:14.058Z
---

## Wave 3 review: targeted verification passes; full suite blocked by unrelated regressions

PASS: integration-docs stayed within its three owned files and supplied the required worker note. The integration test covers no-budget behavior, roadmap and milestone baseline ceilings, usage consumption, hard threshold reporting, rejected ordinary increase, audited raise, one-shot audit state, and active one-shot availability.
PASS: `bun run check` passed.
PASS: `bun test test/budget-controls.test.ts test/budget-report.test.ts test/budget-commands.test.ts test/tools/findings-report-tool.test.ts test/budget-operator-integration.test.ts test/usage.test.ts test/commands.test.ts` passed: 46 tests, 0 failures. Native command parser grammar and rendered summary behavior agree with docs/design.md and docs/tutorial.md: show optional scope, set three-argument ceiling/unlimited syntax, raise and one-shot override syntax, default/explicit actor, no-budget message, exact standard/unknown-cost summary text, threshold recovery, and findings Budget section behavior.
BLOCKING (worker-fixable): `bun test` failed with 3 failures outside wave-3 ownership: test/style.test.ts expects Go guidance from the global config but `styleGuideForFiles` returns none; test/cli.test.ts expects global config and plugin roots under `<home>/.omp/...` but `initScoped` and `resolvePluginRoot` return `<home>/.omp/profiles/omr/...` without a requested profile. Restore the expected no-profile global paths and global style merge behavior (or update those tests only if the profile behavior is an approved, recorded change). Full-suite exit criterion remains unmet.

---
kind: decision
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
blocking: false
status: resolved
at: 2026-07-23T00:04:05.097Z
---

## Defer unrelated full-suite regressions


## Defer unrelated full-suite regressions

- Scope: milestone
- Material: yes
- Approved by user: User selected 'Defer unrelated failures' in the implementation disposition interview.
- At: 2026-07-23T00:04:05.083Z

During wave-3 review, `bun run check` and all 46 milestone-focused tests passed, but `bun test` reported three unrelated pre-existing global style/profile expectation failures outside every approved task's ownership. The user explicitly approved deferring those failures rather than expanding this budget milestone. Closeout may record the full-suite verification as deferred with this reason; budget feature acceptance remains backed by typecheck, focused tests, integration coverage, and documentation review.
