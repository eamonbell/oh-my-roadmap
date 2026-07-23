---
roadmap_id: execution-budgets
milestone_id: ms-operator-surface
title: Operator controls & surfacing
status: milestone_approved
approvals:
  - by: user
    at: 2026-07-22T23:38:40.282Z
    summary: "Approved ms-operator-surface plan: native budget slash commands,
      lock-safe baseline/override controls, configured-dimension status/usage
      reporting, automatic findings budget summary, full focused tests,
      integration verification, and documentation across three dependency-safe
      waves."
open_questions: []
verification_commands:
  - bun run check
  - bun test test/budget-controls.test.ts test/budget-report.test.ts
    test/budget-commands.test.ts test/tools/findings-report-tool.test.ts
    test/budget-operator-integration.test.ts test/usage.test.ts
    test/commands.test.ts
  - bun test
acceptance_criteria:
  - /omr:budget-show is a native command that displays each configured roadmap
    and milestone budget dimension as spent, ceiling, remaining, percentage, and
    threshold state; it marks over-budget values clearly, includes an
    estimated-cost/unknown-cost disclaimer, reports override
    availability/history compactly, and reports no configured budgets without
    starting an agent turn.
  - /omr:budget-set <roadmap|milestone> <tokens|cost|time> <value|unlimited>
    changes exactly one active-scope ceiling per call using the delivered
    human-friendly parsers; it may create, keep, lower, or clear a ceiling,
    preserves time tracking and override history, and rejects any increase with
    guidance to use /omr:budget-override raise.
  - /omr:budget-override supports audited raise-ceiling and one-shot-continue
    mutations, requires a non-empty reason, defaults granted_by to user when no
    actor is supplied, permits an optional explicit actor, persists the full
    existing audit fields, and leaves dispatch re-lock behavior unchanged.
  - /omr:rm-status and /omr:rm-usage include configured-dimension budget lines
    for active roadmap and milestone scopes, while their output remains
    unchanged when no ceilings or overrides are configured.
  - omr_submit_findings_report automatically appends a generated Budget section
    when budgets or overrides exist, including spent versus ceiling, breached
    thresholds, and override summary; submitted markdown remains unchanged when
    no budget state is configured.
  - The end-to-end core integration covers baseline set, consumption, threshold
    surfacing, rejected ordinary raise, audited raise, one-shot grant, and
    no-budget backward compatibility without requiring a live OMP session.
  - docs/design.md and docs/tutorial.md document budget threshold configuration,
    command syntax, baseline-versus-override governance, output meaning,
    unknown-cost behavior, and recovery from soft/hard limits using the
    implemented behavior.
cleanup_policy: approval-gated
user_interview:
  - The operator surface remains OMP slash commands after researching a CLI-only
    alternative; CLI-only was rejected because the user chose to keep the
    approved slash-command scope.
  - Commands must execute as native extension handlers rather than prompt-backed
    agent turns.
  - budget-set changes one dimension per call; configured-dimension output is
    one compact line per scope and dimension.
  - Findings reports must gain budget summaries automatically in
    omr_submit_findings_report.
  - Override audit defaults actor to user, requires a reason, and all increases
    to an existing ceiling must use the audited override path.
  - "Test coverage is full focused coverage: command behavior,
    report/status/usage formatting, findings append behavior, core lifecycle
    integration, full suite, and typecheck."
relevant_existing_code:
  - packages/core/src/budget.ts — budget dimensions, human-friendly parsers,
    consumption results, override records, and state normalization.
  - packages/core/src/enforcement.ts — active-scope evaluation plus persisted
    raise-ceiling and one-shot APIs; operator mutations must preserve these
    semantics and become lock-safe.
  - packages/core/src/store/persistence.ts and packages/core/src/lock.ts —
    roadmap/milestone budget files and the store write-lock used for atomic
    read-modify-write operations.
  - packages/core/src/report/shared.ts and packages/core/src/report/render.ts —
    usage/status text surfaces and no-budget compatibility boundary.
  - packages/extension/src/extension/commands/catalog.ts, register.ts, usage.ts,
    and messages.ts — native command registration, rm-usage behavior, and custom
    command-result delivery.
  - packages/extension/src/tools/register/findings-report-tool.ts and
    packages/extension/src/findings.ts — terminal findings tool and report tile.
  - test/budget.test.ts, test/enforcement.test.ts, test/budget-override.test.ts,
    test/usage.test.ts, test/commands.test.ts, and
    test/tools/findings-report-tool.test.ts — established test patterns and
    delivered budget contracts.
relevant_documentation:
  - docs/design.md — workflow, storage, command, and gating architecture.
  - docs/tutorial.md — shell-versus-TUI command guidance and operator workflow
    examples.
  - Roadmap section roadmap:ms-operator-surface-operator-controls-surfacing —
    approved milestone scope and acceptance intent.
  - Roadmap amendment 'Use native handlers for budget slash commands' in
    .omr/execution-budgets/decisions.md — approved removal of prompt-template
    work while retaining slash command names.
  - node_modules/commander/Readme.md was consulted only for the rejected CLI
    alternative; no Commander changes remain in this plan.
decisions:
  - Retain /omr:budget-show, /omr:budget-set, and /omr:budget-override; do not
    add CLI equivalents.
  - Implement all three as native handlers that send immediate command-result
    messages and never queue model prompts.
  - "Command contracts: budget-show accepts optional roadmap or milestone scope
    and defaults to all active scopes; budget-set accepts scope, dimension, and
    one value or unlimited; budget-override accepts scope plus raise <dimension>
    <value> or one-shot, a free-form non-empty reason, and optional --by
    <actor>."
  - "Treat budget-set as baseline governance: creating/lowering/clearing is
    allowed, increasing an existing finite ceiling is rejected. Use
    budget-override raise for every increase so it is audited."
  - Default missing override actor to user; never default or fabricate the
    reason.
  - Render one line per configured dimension only. Tokens use integers, cost
    uses USD with + unknown/unknown headroom when usd_unavailable is true, and
    time uses human-readable duration. Include explicit over-budget or threshold
    level labels.
  - Share one core budget-summary model/formatter across budget-show, rm-status,
    rm-usage, and findings to prevent output-semantic drift; findings adds
    compact override counts/latest audit context.
  - "No-budget state is a strict compatibility boundary: no extra budget
    headings, blank lines, or changed usage/status text."
  - "Assumptions & External Dependencies: no new external APIs, SDKs, or
    dependencies are required. The plan relies only on the existing OMP native
    command handler API already used by rm-usage and the existing core state
    store."
dependency_analysis:
  - "budget-control and budget-reporting are independent wave-1 foundations:
    control owns mutation/locking semantics; reporting owns read-only summary
    and formatting. They share delivered budget types but do not edit
    overlapping files."
  - budget-commands depends on both foundations because show consumes the shared
    formatter and set/override consume the mutation APIs.
  - findings-budget depends only on budget-reporting and can run concurrently
    with budget-commands because their owned files do not overlap.
  - integration-docs depends on all operator surfaces so its lifecycle scenario
    and documentation describe verified final behavior rather than design
    intent.
  - Waves are strictly sequential; same-wave tasks have disjoint file ownership
    and no dependency edge between them.
tasks:
  - id: budget-control
    title: Implement lock-safe baseline and override controls
    objective: Provide active-scope core mutations for one-dimension baseline
      changes and audited overrides, enforcing that ordinary set operations
      cannot increase an existing ceiling.
    implementation_notes:
      - Add a focused active-scope mutation API using the existing budget
        parsers, BudgetScopeState model, and roadmap/milestone persistence
        paths.
      - Wrap every budget read-modify-write sequence, including the existing
        raise and one-shot functions, in the store write lock so native commands
        cannot lose concurrent updates.
      - Preserve time_tracking and overrides on baseline create/lower/clear;
        remove only the selected ceiling for unlimited.
      - Reject an ordinary finite value greater than an existing finite ceiling
        with actionable guidance to use the audited raise override; allow
        initial set, equal value, lower value, and clear.
      - Keep existing one-shot consumption/re-lock semantics unchanged and
        return structured results suitable for command messages.
    done_criteria:
      - Core exposes one active-scope function for baseline set/clear and
        retains callable raise/one-shot functions.
      - Ordinary increases are rejected; initial/equal/lower/clear operations
        persist correctly for roadmap and milestone scopes.
      - All mutations are atomic under the store lock and preserve unrelated
        budget state.
      - New focused tests cover both scopes, all three dimensions, unlimited,
        increase rejection, audit defaults passed by callers, missing active
        scope, and concurrent read-modify-write behavior.
    verification_commands:
      - bun test test/budget-controls.test.ts test/budget-override.test.ts
    worker: worker-heavy
    depends_on: []
    owned_files:
      - packages/core/src/enforcement.ts
      - test/budget-controls.test.ts
      - test/budget-override.test.ts
    owned_modules: []
    shared_interfaces:
      - Exports baseline set/clear plus existing audited raise and one-shot
        functions from @oh-my-roadmap/core/enforcement.
      - Structured mutation results identify scope, dimension, prior/new
        ceiling, and persisted budget state for command rendering.
  - id: budget-reporting
    title: Build shared budget summary and report integration
    objective: Create one read-only budget summary/formatter and integrate
      configured-dimension lines into status and usage output without changing
      no-budget output.
    implementation_notes:
      - Load active roadmap/milestone budget state and usage once into a typed
        summary covering configured dimensions, threshold level, remaining
        headroom, over-budget state, unknown-cost status, and override summary.
      - Format tokens, USD, and elapsed time for operators; when usd_unavailable
        is true, show known cost plus unknown and mark
        remaining/percentage/threshold as unknown rather than presenting false
        precision.
      - Extend status and rm-usage through the shared formatter while preserving
        their existing byte-for-byte output when neither ceilings nor overrides
        exist.
      - "Keep override detail compact: totals, available one-shots, and latest
        audit context; do not add the roadmap-details UI to this milestone."
    done_criteria:
      - A shared core summary/formatter returns no lines for empty budget state
        and deterministic lines for configured roadmap/milestone dimensions.
      - Status and rm-usage show spent, ceiling, remaining, percentage,
        level/over-budget state, and cost disclaimer as specified.
      - Output tests cover tokens/cost/time, both scopes, over-budget values,
        unknown cost, override summary, scope filtering, and exact no-budget
        compatibility.
      - Existing usage and warning output remains ordered and readable.
    verification_commands:
      - bun test test/budget-report.test.ts test/usage.test.ts
        test/budget-override.test.ts
    worker: worker-heavy
    depends_on: []
    owned_files:
      - packages/core/src/budget-report.ts
      - packages/core/src/report/shared.ts
      - packages/core/src/report/render.ts
      - packages/extension/src/extension/commands/usage.ts
      - test/budget-report.test.ts
      - test/usage.test.ts
    owned_modules: []
    shared_interfaces:
      - Exports typed budget summary loading and compact line/Markdown
        formatters from @oh-my-roadmap/core/budget-report.
      - No-budget formatter contract is an empty result, allowing callers to
        preserve existing output exactly.
  - id: budget-commands
    title: Register native budget slash commands
    objective: Deliver immediate native show, set, and override command handlers
      with strict argument validation and actionable results.
    implementation_notes:
      - Register the three approved names outside the prompt-backed COMMANDS
        loop, following the rm-usage native-handler pattern and diagnostic
        timing conventions.
      - Implement a small direct parser for raw command arguments; treat
        override reason as the remaining non-option text so shell-style quote
        parsing is unnecessary, and support optional --by <actor> with default
        user.
      - budget-show defaults to all active scopes and may filter to roadmap or
        milestone; budget-set accepts exactly one scope, dimension, and
        value/unlimited; budget-override accepts raise or one-shot and requires
        a reason.
      - Use the core formatter/control APIs and send custom command-result
        messages for success and actionable validation failures; do not queue an
        agent prompt or submit a findings tile for these native commands.
    done_criteria:
      - All three commands are registered with accurate descriptions and execute
        without sendUserMessage.
      - Valid show/set/override inputs call the shared core APIs and produce
        readable results.
      - Malformed scope, dimension, unit, missing reason, missing active
        milestone, attempted ordinary increase, and unknown extra arguments
        produce actionable errors without mutation.
      - Command tests verify registration, idle/busy behavior independence,
        parsing boundaries, persisted effects, default actor user, optional
        actor, and no prompt dispatch.
    verification_commands:
      - bun test test/budget-commands.test.ts test/commands.test.ts
    worker: worker
    depends_on:
      - budget-control
      - budget-reporting
    owned_files:
      - packages/extension/src/extension/commands/budget.ts
      - packages/extension/src/extension/commands/catalog.ts
      - packages/extension/src/extension/commands/register.ts
      - test/budget-commands.test.ts
      - test/commands.test.ts
    owned_modules: []
    shared_interfaces:
      - Consumes @oh-my-roadmap/core/enforcement budget mutation APIs.
      - Consumes @oh-my-roadmap/core/budget-report summary and line formatter.
      - Publishes the exact native command argument grammar documented in task
        decisions.
  - id: findings-budget
    title: Append budget summary to terminal findings
    objective: Make every submitted terminal findings report automatically include
      current budget state when relevant, with no caller prompt changes.
    implementation_notes:
      - At findings-tool execution, load the shared budget summary and append a
        generated Markdown Budget section only when ceilings or overrides exist.
      - Include configured-dimension spend/ceiling/headroom/level lines,
        breached thresholds, and compact override information from the same
        formatter used by status and usage.
      - Preserve the caller's markdown exactly when no budget state exists; keep
        UI-unavailable and error behavior unchanged.
      - Do not require orchestrators to remember an extra tool call or duplicate
        budget text in command prompts.
    done_criteria:
      - Findings tool appends exactly one generated Budget section for relevant
        budget state.
      - No-budget submissions are unchanged and existing widget lifecycle
        behavior remains intact.
      - Tests cover configured dimensions, breach/over-budget label, override
        summary, no-budget identity, UI unavailable, and repeated independent
        submissions.
    verification_commands:
      - bun test test/tools/findings-report-tool.test.ts
    worker: worker
    depends_on:
      - budget-reporting
    owned_files:
      - packages/extension/src/tools/register/findings-report-tool.ts
      - test/tools/findings-report-tool.test.ts
    owned_modules: []
    shared_interfaces:
      - Consumes @oh-my-roadmap/core/budget-report Markdown formatter.
      - Maintains omr_submit_findings_report input and result schemas unchanged.
  - id: integration-docs
    title: Verify lifecycle and document operator workflow
    objective: Defend the complete operator-visible lifecycle and document the
      implemented configuration, commands, outputs, and recovery flow.
    implementation_notes:
      - Add a core-function integration scenario that creates active
        roadmap/milestone state, sets baseline ceilings, records usage, observes
        thresholds, rejects an ordinary raise, applies an audited raise, grants
        a one-shot, and verifies no-budget compatibility.
      - Update the design document with budget files, threshold semantics,
        native command architecture, lock-safe mutations, and automatic findings
        behavior.
      - Update the tutorial with .omr/config.yml examples and exact
        show/set/override syntax, including unlimited, default actor, required
        reason, unknown-cost output, and soft/hard recovery.
      - Document only observed implemented behavior and keep examples minimal.
    done_criteria:
      - The integration test covers set → consume → enforce/surface → rejected
        set increase → audited raise → one-shot and the no-budget path.
      - Design and tutorial references match command grammar and output labels
        exactly.
      - No CLI budget commands or prompt-template instructions are documented.
      - Focused suite, full suite, and typecheck provide closeout evidence.
    verification_commands:
      - bun test test/budget-operator-integration.test.ts
      - bun run check
      - bun test
    worker: worker
    depends_on:
      - budget-commands
      - findings-budget
    owned_files:
      - test/budget-operator-integration.test.ts
      - docs/design.md
      - docs/tutorial.md
    owned_modules: []
    shared_interfaces:
      - Consumes the finalized native command grammar and shared budget summary
        semantics.
      - Provides end-to-end evidence for the milestone acceptance criteria
        without a live OMP session.
waves:
  - id: wave-1
    goal: Establish atomic operator mutations and one shared budget
      summary/formatter.
    exit_criteria:
      - Baseline set/clear and audited override APIs are lock-safe and enforce
        the raise boundary.
      - Configured-dimension budget summaries render correctly for roadmap and
        milestone scopes.
      - Status and usage preserve exact no-budget compatibility.
    review_checkpoint: Review mutation atomicity, baseline-versus-override
      enforcement, unit formatting, unknown-cost honesty, both-scope behavior,
      and no-budget output before exposing commands.
    tasks:
      - budget-control
      - budget-reporting
  - id: wave-2
    goal: Expose native slash commands and automatic terminal findings surfacing.
    exit_criteria:
      - All three native commands register, validate, mutate/report correctly,
        and never queue model prompts.
      - Findings submissions append one generated Budget section only when
        relevant.
      - Command and findings tests cover success, failure, audit, and no-budget
        paths.
    review_checkpoint: Exercise command handlers through the extension harness,
      inspect persisted audit fields and error messages, and verify findings
      Markdown/widget behavior without regressions.
    tasks:
      - budget-commands
      - findings-budget
  - id: wave-3
    goal: Prove the full operator lifecycle and publish accurate operator
      documentation.
    exit_criteria:
      - Integration coverage demonstrates baseline set, consumption/enforcement,
        audited raise, one-shot, and backward compatibility.
      - Design and tutorial documentation match verified syntax and output.
      - Typecheck, focused tests, and the full suite pass.
    review_checkpoint: Run the exact focused integration test, typecheck, and full
      suite; compare documentation examples to registered command grammar and
      rendered output.
    tasks:
      - integration-docs
---

# Operator controls & surfacing
## Summary
Milestone: ms-operator-surface
Title: Operator controls & surfacing
Status: milestone_approved
## User Interview
- The operator surface remains OMP slash commands after researching a CLI-only alternative; CLI-only was rejected because the user chose to keep the approved slash-command scope.
- Commands must execute as native extension handlers rather than prompt-backed agent turns.
- budget-set changes one dimension per call; configured-dimension output is one compact line per scope and dimension.
- Findings reports must gain budget summaries automatically in omr_submit_findings_report.
- Override audit defaults actor to user, requires a reason, and all increases to an existing ceiling must use the audited override path.
- Test coverage is full focused coverage: command behavior, report/status/usage formatting, findings append behavior, core lifecycle integration, full suite, and typecheck.
## Context
### Relevant Existing Code
- packages/core/src/budget.ts — budget dimensions, human-friendly parsers, consumption results, override records, and state normalization.
- packages/core/src/enforcement.ts — active-scope evaluation plus persisted raise-ceiling and one-shot APIs; operator mutations must preserve these semantics and become lock-safe.
- packages/core/src/store/persistence.ts and packages/core/src/lock.ts — roadmap/milestone budget files and the store write-lock used for atomic read-modify-write operations.
- packages/core/src/report/shared.ts and packages/core/src/report/render.ts — usage/status text surfaces and no-budget compatibility boundary.
- packages/extension/src/extension/commands/catalog.ts, register.ts, usage.ts, and messages.ts — native command registration, rm-usage behavior, and custom command-result delivery.
- packages/extension/src/tools/register/findings-report-tool.ts and packages/extension/src/findings.ts — terminal findings tool and report tile.
- test/budget.test.ts, test/enforcement.test.ts, test/budget-override.test.ts, test/usage.test.ts, test/commands.test.ts, and test/tools/findings-report-tool.test.ts — established test patterns and delivered budget contracts.
### Relevant Documentation
- docs/design.md — workflow, storage, command, and gating architecture.
- docs/tutorial.md — shell-versus-TUI command guidance and operator workflow examples.
- Roadmap section roadmap:ms-operator-surface-operator-controls-surfacing — approved milestone scope and acceptance intent.
- Roadmap amendment 'Use native handlers for budget slash commands' in .omr/execution-budgets/decisions.md — approved removal of prompt-template work while retaining slash command names.
- node_modules/commander/Readme.md was consulted only for the rejected CLI alternative; no Commander changes remain in this plan.
### Decisions
- Retain /omr:budget-show, /omr:budget-set, and /omr:budget-override; do not add CLI equivalents.
- Implement all three as native handlers that send immediate command-result messages and never queue model prompts.
- Command contracts: budget-show accepts optional roadmap or milestone scope and defaults to all active scopes; budget-set accepts scope, dimension, and one value or unlimited; budget-override accepts scope plus raise <dimension> <value> or one-shot, a free-form non-empty reason, and optional --by <actor>.
- Treat budget-set as baseline governance: creating/lowering/clearing is allowed, increasing an existing finite ceiling is rejected. Use budget-override raise for every increase so it is audited.
- Default missing override actor to user; never default or fabricate the reason.
- Render one line per configured dimension only. Tokens use integers, cost uses USD with + unknown/unknown headroom when usd_unavailable is true, and time uses human-readable duration. Include explicit over-budget or threshold level labels.
- Share one core budget-summary model/formatter across budget-show, rm-status, rm-usage, and findings to prevent output-semantic drift; findings adds compact override counts/latest audit context.
- No-budget state is a strict compatibility boundary: no extra budget headings, blank lines, or changed usage/status text.
- Assumptions & External Dependencies: no new external APIs, SDKs, or dependencies are required. The plan relies only on the existing OMP native command handler API already used by rm-usage and the existing core state store.
## Required Work
### budget-control - Implement lock-safe baseline and override controls

Worker: worker-heavy
Objective: Provide active-scope core mutations for one-dimension baseline changes and audited overrides, enforcing that ordinary set operations cannot increase an existing ceiling.

Implementation Notes:
- Add a focused active-scope mutation API using the existing budget parsers, BudgetScopeState model, and roadmap/milestone persistence paths.
- Wrap every budget read-modify-write sequence, including the existing raise and one-shot functions, in the store write lock so native commands cannot lose concurrent updates.
- Preserve time_tracking and overrides on baseline create/lower/clear; remove only the selected ceiling for unlimited.
- Reject an ordinary finite value greater than an existing finite ceiling with actionable guidance to use the audited raise override; allow initial set, equal value, lower value, and clear.
- Keep existing one-shot consumption/re-lock semantics unchanged and return structured results suitable for command messages.

Done Criteria:
- Core exposes one active-scope function for baseline set/clear and retains callable raise/one-shot functions.
- Ordinary increases are rejected; initial/equal/lower/clear operations persist correctly for roadmap and milestone scopes.
- All mutations are atomic under the store lock and preserve unrelated budget state.
- New focused tests cover both scopes, all three dimensions, unlimited, increase rejection, audit defaults passed by callers, missing active scope, and concurrent read-modify-write behavior.

Verification Commands:
- bun test test/budget-controls.test.ts test/budget-override.test.ts

Depends On:
- (none)

Owned Files:
- packages/core/src/enforcement.ts
- test/budget-controls.test.ts
- test/budget-override.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Exports baseline set/clear plus existing audited raise and one-shot functions from @oh-my-roadmap/core/enforcement.
- Structured mutation results identify scope, dimension, prior/new ceiling, and persisted budget state for command rendering.

### budget-reporting - Build shared budget summary and report integration

Worker: worker-heavy
Objective: Create one read-only budget summary/formatter and integrate configured-dimension lines into status and usage output without changing no-budget output.

Implementation Notes:
- Load active roadmap/milestone budget state and usage once into a typed summary covering configured dimensions, threshold level, remaining headroom, over-budget state, unknown-cost status, and override summary.
- Format tokens, USD, and elapsed time for operators; when usd_unavailable is true, show known cost plus unknown and mark remaining/percentage/threshold as unknown rather than presenting false precision.
- Extend status and rm-usage through the shared formatter while preserving their existing byte-for-byte output when neither ceilings nor overrides exist.
- Keep override detail compact: totals, available one-shots, and latest audit context; do not add the roadmap-details UI to this milestone.

Done Criteria:
- A shared core summary/formatter returns no lines for empty budget state and deterministic lines for configured roadmap/milestone dimensions.
- Status and rm-usage show spent, ceiling, remaining, percentage, level/over-budget state, and cost disclaimer as specified.
- Output tests cover tokens/cost/time, both scopes, over-budget values, unknown cost, override summary, scope filtering, and exact no-budget compatibility.
- Existing usage and warning output remains ordered and readable.

Verification Commands:
- bun test test/budget-report.test.ts test/usage.test.ts test/budget-override.test.ts

Depends On:
- (none)

Owned Files:
- packages/core/src/budget-report.ts
- packages/core/src/report/shared.ts
- packages/core/src/report/render.ts
- packages/extension/src/extension/commands/usage.ts
- test/budget-report.test.ts
- test/usage.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Exports typed budget summary loading and compact line/Markdown formatters from @oh-my-roadmap/core/budget-report.
- No-budget formatter contract is an empty result, allowing callers to preserve existing output exactly.

### budget-commands - Register native budget slash commands

Worker: worker
Objective: Deliver immediate native show, set, and override command handlers with strict argument validation and actionable results.

Implementation Notes:
- Register the three approved names outside the prompt-backed COMMANDS loop, following the rm-usage native-handler pattern and diagnostic timing conventions.
- Implement a small direct parser for raw command arguments; treat override reason as the remaining non-option text so shell-style quote parsing is unnecessary, and support optional --by <actor> with default user.
- budget-show defaults to all active scopes and may filter to roadmap or milestone; budget-set accepts exactly one scope, dimension, and value/unlimited; budget-override accepts raise or one-shot and requires a reason.
- Use the core formatter/control APIs and send custom command-result messages for success and actionable validation failures; do not queue an agent prompt or submit a findings tile for these native commands.

Done Criteria:
- All three commands are registered with accurate descriptions and execute without sendUserMessage.
- Valid show/set/override inputs call the shared core APIs and produce readable results.
- Malformed scope, dimension, unit, missing reason, missing active milestone, attempted ordinary increase, and unknown extra arguments produce actionable errors without mutation.
- Command tests verify registration, idle/busy behavior independence, parsing boundaries, persisted effects, default actor user, optional actor, and no prompt dispatch.

Verification Commands:
- bun test test/budget-commands.test.ts test/commands.test.ts

Depends On:
- budget-control
- budget-reporting

Owned Files:
- packages/extension/src/extension/commands/budget.ts
- packages/extension/src/extension/commands/catalog.ts
- packages/extension/src/extension/commands/register.ts
- test/budget-commands.test.ts
- test/commands.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Consumes @oh-my-roadmap/core/enforcement budget mutation APIs.
- Consumes @oh-my-roadmap/core/budget-report summary and line formatter.
- Publishes the exact native command argument grammar documented in task decisions.

### findings-budget - Append budget summary to terminal findings

Worker: worker
Objective: Make every submitted terminal findings report automatically include current budget state when relevant, with no caller prompt changes.

Implementation Notes:
- At findings-tool execution, load the shared budget summary and append a generated Markdown Budget section only when ceilings or overrides exist.
- Include configured-dimension spend/ceiling/headroom/level lines, breached thresholds, and compact override information from the same formatter used by status and usage.
- Preserve the caller's markdown exactly when no budget state exists; keep UI-unavailable and error behavior unchanged.
- Do not require orchestrators to remember an extra tool call or duplicate budget text in command prompts.

Done Criteria:
- Findings tool appends exactly one generated Budget section for relevant budget state.
- No-budget submissions are unchanged and existing widget lifecycle behavior remains intact.
- Tests cover configured dimensions, breach/over-budget label, override summary, no-budget identity, UI unavailable, and repeated independent submissions.

Verification Commands:
- bun test test/tools/findings-report-tool.test.ts

Depends On:
- budget-reporting

Owned Files:
- packages/extension/src/tools/register/findings-report-tool.ts
- test/tools/findings-report-tool.test.ts

Owned Modules:
- (none)

Shared Interfaces:
- Consumes @oh-my-roadmap/core/budget-report Markdown formatter.
- Maintains omr_submit_findings_report input and result schemas unchanged.

### integration-docs - Verify lifecycle and document operator workflow

Worker: worker
Objective: Defend the complete operator-visible lifecycle and document the implemented configuration, commands, outputs, and recovery flow.

Implementation Notes:
- Add a core-function integration scenario that creates active roadmap/milestone state, sets baseline ceilings, records usage, observes thresholds, rejects an ordinary raise, applies an audited raise, grants a one-shot, and verifies no-budget compatibility.
- Update the design document with budget files, threshold semantics, native command architecture, lock-safe mutations, and automatic findings behavior.
- Update the tutorial with .omr/config.yml examples and exact show/set/override syntax, including unlimited, default actor, required reason, unknown-cost output, and soft/hard recovery.
- Document only observed implemented behavior and keep examples minimal.

Done Criteria:
- The integration test covers set → consume → enforce/surface → rejected set increase → audited raise → one-shot and the no-budget path.
- Design and tutorial references match command grammar and output labels exactly.
- No CLI budget commands or prompt-template instructions are documented.
- Focused suite, full suite, and typecheck provide closeout evidence.

Verification Commands:
- bun test test/budget-operator-integration.test.ts
- bun run check
- bun test

Depends On:
- budget-commands
- findings-budget

Owned Files:
- test/budget-operator-integration.test.ts
- docs/design.md
- docs/tutorial.md

Owned Modules:
- (none)

Shared Interfaces:
- Consumes the finalized native command grammar and shared budget summary semantics.
- Provides end-to-end evidence for the milestone acceptance criteria without a live OMP session.
## Dependency Analysis
- budget-control and budget-reporting are independent wave-1 foundations: control owns mutation/locking semantics; reporting owns read-only summary and formatting. They share delivered budget types but do not edit overlapping files.
- budget-commands depends on both foundations because show consumes the shared formatter and set/override consume the mutation APIs.
- findings-budget depends only on budget-reporting and can run concurrently with budget-commands because their owned files do not overlap.
- integration-docs depends on all operator surfaces so its lifecycle scenario and documentation describe verified final behavior rather than design intent.
- Waves are strictly sequential; same-wave tasks have disjoint file ownership and no dependency edge between them.
## Execution Waves
### wave-1

Goal: Establish atomic operator mutations and one shared budget summary/formatter.
Review Checkpoint: Review mutation atomicity, baseline-versus-override enforcement, unit formatting, unknown-cost honesty, both-scope behavior, and no-budget output before exposing commands.

Tasks:
- budget-control
- budget-reporting

Exit Criteria:
- Baseline set/clear and audited override APIs are lock-safe and enforce the raise boundary.
- Configured-dimension budget summaries render correctly for roadmap and milestone scopes.
- Status and usage preserve exact no-budget compatibility.

### wave-2

Goal: Expose native slash commands and automatic terminal findings surfacing.
Review Checkpoint: Exercise command handlers through the extension harness, inspect persisted audit fields and error messages, and verify findings Markdown/widget behavior without regressions.

Tasks:
- budget-commands
- findings-budget

Exit Criteria:
- All three native commands register, validate, mutate/report correctly, and never queue model prompts.
- Findings submissions append one generated Budget section only when relevant.
- Command and findings tests cover success, failure, audit, and no-budget paths.

### wave-3

Goal: Prove the full operator lifecycle and publish accurate operator documentation.
Review Checkpoint: Run the exact focused integration test, typecheck, and full suite; compare documentation examples to registered command grammar and rendered output.

Tasks:
- integration-docs

Exit Criteria:
- Integration coverage demonstrates baseline set, consumption/enforcement, audited raise, one-shot, and backward compatibility.
- Design and tutorial documentation match verified syntax and output.
- Typecheck, focused tests, and the full suite pass.
## Verification
### Acceptance Criteria
- /omr:budget-show is a native command that displays each configured roadmap and milestone budget dimension as spent, ceiling, remaining, percentage, and threshold state; it marks over-budget values clearly, includes an estimated-cost/unknown-cost disclaimer, reports override availability/history compactly, and reports no configured budgets without starting an agent turn.
- /omr:budget-set <roadmap|milestone> <tokens|cost|time> <value|unlimited> changes exactly one active-scope ceiling per call using the delivered human-friendly parsers; it may create, keep, lower, or clear a ceiling, preserves time tracking and override history, and rejects any increase with guidance to use /omr:budget-override raise.
- /omr:budget-override supports audited raise-ceiling and one-shot-continue mutations, requires a non-empty reason, defaults granted_by to user when no actor is supplied, permits an optional explicit actor, persists the full existing audit fields, and leaves dispatch re-lock behavior unchanged.
- /omr:rm-status and /omr:rm-usage include configured-dimension budget lines for active roadmap and milestone scopes, while their output remains unchanged when no ceilings or overrides are configured.
- omr_submit_findings_report automatically appends a generated Budget section when budgets or overrides exist, including spent versus ceiling, breached thresholds, and override summary; submitted markdown remains unchanged when no budget state is configured.
- The end-to-end core integration covers baseline set, consumption, threshold surfacing, rejected ordinary raise, audited raise, one-shot grant, and no-budget backward compatibility without requiring a live OMP session.
- docs/design.md and docs/tutorial.md document budget threshold configuration, command syntax, baseline-versus-override governance, output meaning, unknown-cost behavior, and recovery from soft/hard limits using the implemented behavior.
### Verification Commands
- bun run check
- bun test test/budget-controls.test.ts test/budget-report.test.ts test/budget-commands.test.ts test/tools/findings-report-tool.test.ts test/budget-operator-integration.test.ts test/usage.test.ts test/commands.test.ts
- bun test
