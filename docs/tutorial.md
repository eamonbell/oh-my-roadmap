# TUI Tutorial

This tutorial walks through using `oh-my-roadmap` from the OMP TUI when you have never used it before.

`oh-my-roadmap` is for work that is too large or risky for one prompt. It turns the work into a gated lifecycle:

```text
roadmap -> milestone plan -> implementation waves -> review -> closeout -> complete
```

The main thing to remember: you drive the workflow with slash commands, and the agent records state under `.omr`.

## 1. Start In The Target Project

Open OMP in the repository where you want the roadmap to live.

```sh
cd /path/to/your/project
omp --extension /path/to/oh-my-roadmap
```

If the extension is installed another way in your environment, use that normal startup command instead.

Confirm the extension is loaded:

```text
/extensions
```

You should see `oh-my-roadmap` and its tools.

## 2. Initialize Project Files

Run this once per repository, from your shell (not the OMP TUI):

```sh
omr init
```

This creates or refreshes:

```text
.omr/config.yml
.omp/agents/worker-light.md
.omp/agents/worker.md
.omp/agents/worker-heavy.md
.omp/agents/reviewer.md
.omp/agents/wave-flow-checker.md
.omp/agents/roadmap-milestone-checker.md
```

`omr init` does not start a roadmap. It only prepares the repo.

## 3. Create A Roadmap

Start a new roadmap with a short description of the work:

```text
/omr:rm-new Replace the old workflow system with standalone workflows
```

The agent should interview you. Answer until there are no open questions about:

- goal
- success criteria
- constraints
- non-goals
- relevant existing code
- risks
- milestone breakdown
- external research needs

The agent should inspect the repository before finalizing the roadmap.

At the end of `/omr:rm-new`, the agent should:

- create `.omr/active.yml`
- create `.omr/<roadmap-id>/state.yml`
- generate `.omr/<roadmap-id>/roadmap.md`
- dispatch `roadmap-milestone-checker`
- record the checker result
- ask you to approve the roadmap

Do not approve if the roadmap has vague milestones or unresolved decisions. Ask the agent to revise it.

## 4. Check Status Any Time

Use:

```text
/omr:rm-status
```

This reports the current roadmap phase, active milestone, blockers, validation state, and next legal action.

Use:

```text
/omr:rm-resume
```

This is for orientation after a pause, crash, context loss, or a new session. It should summarize state and propose the next legal action. It should not continue implementation automatically.

Optional dashboard:

```text
/omr:rm-details
```

This shows a local TUI details view when available.

## 5. Plan The First Milestone

After roadmap approval, create the detailed plan for the next roadmap milestone:

```text
/omr:ms-plan
```

The agent should expand one approved roadmap milestone into:

- acceptance criteria
- verification commands
- concrete tasks
- task dependencies
- implementation waves
- file or module ownership
- worker assignment for each task
- wave review checkpoints
- initial progress cursor

The agent should ask what test coverage you want. Be specific about:

- which new tests should be written
- which existing tests are enough
- what is intentionally deferred
- which commands must pass before closeout

Before milestone approval, the agent must dispatch `wave-flow-checker`. If the checker fails, the agent should revise the plan and rerun it.

Approve the milestone only after the plan is specific enough for workers to execute without guessing.

## 6. Implement The Milestone

After milestone approval, run:

```text
/omr:ms-implement
```

The orchestrator should not edit code directly. It should:

1. Read the active progress cursor.
2. Before the first wave, record a verification baseline with `omr_record_verification_baseline` (the plan's verification commands run once, capturing any pre-existing failures) so later reviews can be judged against it instead of an absolute full-suite-green bar.
3. Call `omr_prepare_wave_dispatch`.
4. Dispatch only the active wave assignments.
5. Use each task's exact worker: `worker-light`, `worker`, or `worker-heavy`.
6. Record each worker dispatch immediately.
7. Wait for worker results.
8. Record each result.
9. Dispatch `reviewer` after all active wave tasks complete.
10. Record review.
11. Advance to the next wave only after review passes.

Implementation proceeds one wave at a time.

## 7. Understand Worker Roles

The milestone plan chooses the worker role. You usually do not need to pick manually during implementation.

- `worker-light`: narrow, low-risk, localized edits.
- `worker`: normal bounded implementation.
- `worker-heavy`: broad, risky, cross-module, schema, API, migration, or high-ambiguity work.
- `reviewer`: checks a completed wave.
- `wave-flow-checker`: checks milestone or change plans before approval.
- `roadmap-milestone-checker`: checks roadmap milestone sequencing before roadmap approval.

Workers should stay inside their assigned ownership. If a worker needs unowned files, it should stop and report a blocker.

Workers always run LSP diagnostics on every touched file before yielding. They may also run their own task's verification commands against their owned files, but only in a single-worker wave or a genuine rework dispatch — never the full suite, a whole-project build, or unowned files. Workers record the exact commands they ran in their note (a "Commands run:" section and/or "VERIFIED:" lines); the reviewer treats those as starting-point receipts rather than re-discovering everything from scratch.

## 8. Resume After A Pause Or Crash

If a session crashes or you return later, run:

```text
/omr:rm-resume
```

Read the reported next action.

Common outcomes:

- If it says a wave is ready to dispatch, run `/omr:ms-implement`.
- If it says workers are running, let the orchestrator poll or recover them.
- If it says workers are running but the current session has no matching hub job or peer, run `/omr:ms-implement`; the orchestrator should mark the old run abandoned before redispatching.
- If it says review is needed, run `/omr:ms-implement`.
- If blockers are open, use the blocker commands below.
- If closeout is ready, run `/omr:ms-close`.

The persisted progress cursor is authoritative. Notes are supporting evidence, not the source of truth.

## 9. Handle Blockers

Not every failed review finding becomes a blocker. Reviewers submit structured findings with a severity: `pass` and `advisory` findings are informational and never block; `blocking_worker_fixable` findings (a concrete fix a worker can make without a user decision) become an item in the wave's rework queue instead of a blocker, so the wave can be unblocked by dispatching the worker to fix it and re-reviewing; only `blocking_needs_user` findings (something that genuinely needs a user decision) open a canonical blocker. The commands below apply to canonical blockers.

List blockers:

```text
/omr:blk-list
```

Check blocker state:

```text
/omr:blk-status
```

Resolve a blocker when the issue is fixed:

```text
/omr:blk-resolve <blocker-id> <resolution>
```

Example:

```text
/omr:blk-resolve blk_123 Fixed the stale API route and reran go test ./actn/... -run '^$' -count=1.
```

A deferred blocker can later be resolved with `/omr:blk-resolve` once the deferred issue is actually fixed — deferring is not a dead end.

Defer a blocker only when you intentionally accept the risk:

```text
/omr:blk-defer <blocker-id> <reason>
```

Example:

```text
/omr:blk-defer blk_456 User approved deferring artifact behavior coverage to the artifact integration milestone.
```

After resolving or deferring blockers, run:

```text
/omr:rm-resume
```

Then continue with the reported next action.

## 10. Transport Failures And Duplicate Workers

Sometimes a worker job may fail because the socket closed or the transport died. Treat that as an orchestration interruption, not an implementation blocker.

The orchestrator should:

1. Mark the run as `transport_failed`.
2. Prefer waking the existing worker: list peers with the `hub` tool (`op:list`), and if the worker is still a peer, `hub op:send` it a narrow "resume from your existing transcript" message rather than starting over.
3. If it responds, collect the result.
4. If it does not respond after 2 minutes, mark it `abandoned`.
5. Redispatch only that task with `omr_prepare_worker_redispatch`, which accepts a run recorded as either `transport_failed` or `abandoned`.

A transport error never becomes a blocker: it is recorded as `transport_failed`, not as a wave result. Only a real implementation failure the worker reports opens a blocker.

Only wait when the worker exists in the current session as a hub job or peer. If you resumed in a new session, the old subagent no longer exists as a peer, so the orchestrator should mark the old run `abandoned` immediately and redispatch instead of polling or waiting.

Do not manually start a duplicate worker for the same task if an active run exists.

If you see `active_runs` in dispatch output, the orchestrator should poll or probe those runs instead of spawning new workers.

## 11. Review Waves

After every wave, the orchestrator dispatches `reviewer` and records the dispatch with `omr_record_reviewer_dispatch` so the reviewer's identity persists.

A passed review lets the workflow advance to the next wave automatically; no separate transition is needed before the next `omr_prepare_wave_dispatch`.

The reviewer package includes the verification baseline recorded at the start of implementation (see step 6) and, when workers reported their own verification commands, their command receipts. The reviewer verifies those receipts rather than re-running everything from scratch, then runs the plan's milestone-level verification commands once for the whole wave, judging results against the baseline (no new failures, no lost passes) rather than an absolute full-suite-green bar.

Reviewers submit structured findings with a severity (`pass`, `advisory`, `blocking_worker_fixable`, `blocking_needs_user`) to `omr_record_wave_review`; a plain string `findings` list is still accepted. When review finds problems the original worker can simply fix (`blocking_worker_fixable` — a concrete code correction, no user decision needed), the finding becomes an item in the wave's rework queue rather than a blocker, and the orchestrator wakes that worker over the `hub` tool (recording the redispatch with `reworkOf` set to the rework-queue item's id) to rework in-context and re-reviews — without a user blocker round-trip. If the original worker is gone (for example after resuming in a new session), it spawns a fresh worker seeded with the findings and the task's worker notes. For re-review, a failed `omr_prepare_wave_review` returns the prior reviewer's identity and findings, and the orchestrator wakes that same reviewer rather than spawning a new one.

A failed review only opens a canonical blocker for a `blocking_needs_user` finding — something that genuinely needs a user decision (ambiguous acceptance, scope/approval, or risk disposition). `pass`, `advisory`, and `blocking_worker_fixable` findings do not open blockers. If blockers are opened, use:

```text
/omr:blk-list
```

Then resolve or defer them before continuing.

## 12. Close The Milestone

When all waves pass review, run:

```text
/omr:ms-close
```

The agent should inspect:

- milestone plan
- worker notes
- review notes
- changed code
- verification evidence
- unresolved risks

Closeout requires structured evidence for every acceptance criterion and verification command. Each item must be:

- `passed`, or
- `deferred` with a reason and approver

Approve closeout only when the evidence is accurate.

After closeout is recorded, the agent can complete the milestone.

## 13. Plan The Next Milestone

If the roadmap has more planned milestones, run:

```text
/omr:ms-plan
```

The workflow repeats:

```text
plan milestone -> approve -> implement waves -> review -> close milestone
```

Continue until all roadmap milestones are complete.

## 14. Make A Post-Implementation Change

If implementation, review, or closeout reveals needed follow-up work, create a change request:

```text
/omr:chg-request Add validation for missing workflow input mappings
```

The agent should plan the change like a smaller milestone:

- acceptance criteria
- verification
- tasks
- ownership
- waves
- wave-flow check
- approval

Implement it with:

```text
/omr:ms-implement
```

Check change status:

```text
/omr:chg-status
```

Close it with:

```text
/omr:chg-close
```

## 15. Complete The Roadmap

After every roadmap milestone is complete and no active change request remains, use:

```text
/omr:rm-status
```

If the next action says the roadmap is complete or ready to finish, follow the reported instruction. The final state should have:

- no open blocking blockers
- no active implementation wave
- milestone closeout evidence recorded
- all roadmap milestones complete

## 16. Common Command Sequence

For a normal roadmap:

```text
omr init
/omr:rm-new <goal>
/omr:rm-status
/omr:ms-plan
/omr:ms-implement
/omr:ms-close
/omr:ms-plan
/omr:ms-implement
/omr:ms-close
/omr:rm-status
```

For recovery:

```text
/omr:rm-resume
/omr:blk-list
/omr:blk-resolve <id> <resolution>
/omr:rm-resume
/omr:ms-implement
```

For a post-implementation change:

```text
/omr:chg-request <requested change>
/omr:ms-implement
/omr:chg-close
```

## 17. What Good Output Looks Like

Good `/omr:rm-status` or `/omr:rm-resume` output tells you:

- active roadmap
- phase
- active milestone
- active wave
- active task
- blocker count
- validation state
- implementation gate state
- next legal action

Good `/omr:ms-implement` behavior:

- uses the active wave from state
- dispatches only current-wave tasks
- records worker dispatches
- records worker results
- dispatches reviewer
- advances only after review passes

Good blocker handling:

- lists exact blocker IDs
- asks before resolving or deferring
- records resolution or defer reason
- validates after mutation
- tells you to resume

## 18. Set And Recover Execution Budgets

Budgets are optional. Configure only the threshold policy in `.omr/config.yml`; set individual active roadmap or milestone ceilings from the TUI:

```yaml
budgets:
  thresholds:
    warn: 75
    soft: 90
    hard: 100
```

Threshold values are percentages. If omitted, warn is `75`, soft is disabled, and hard is `100`. An unlimited ceiling never breaches.

Use these native TUI commands:

```text
/omr:budget-show
/omr:budget-show roadmap
/omr:budget-set roadmap tokens 2500
/omr:budget-set milestone time 1h30m
/omr:budget-set roadmap cost unlimited
/omr:budget-override raise roadmap tokens 4000 capacity needed for release
/omr:budget-override one-shot roadmap --by operator finish the current dispatch
```

`/omr:budget-show [roadmap|milestone]` scopes the summary when needed. With no reportable ceilings or overrides, it returns `No active budget ceilings or overrides.`

`/omr:budget-set <roadmap|milestone> <tokens|cost|time> <value|unlimited>` creates, lowers, or clears one active ceiling. `unlimited` clears that dimension.

`/omr:budget-override raise <roadmap|milestone> <tokens|cost|time> <value> [--by <actor>] <reason>` raises a finite ceiling. `/omr:budget-override one-shot <roadmap|milestone> [--by <actor>] <reason>` grants a one-shot continue. An override requires a non-empty reason. The actor defaults to `user`; place `--by <actor>` before the reason to record another actor.

```text
/omr:budget-override raise milestone cost 25.00 provider pricing changed
```

The summary labels are exact. For example:

```text
Budget roadmap tokens: spent 1,000 tokens; ceiling 2,500 tokens; remaining 1,500 tokens; 40% used; level none
```

When one or more request costs are unavailable, the cost line explicitly preserves that uncertainty:

```text
Budget roadmap cost: spent $2.5000 + unknown; ceiling $10.0000; remaining unknown; percentage unknown; level unknown (some request costs unavailable)
```

At a soft threshold, new-wave dispatch pauses. Raise the affected ceiling, or grant a one-shot continue, then run `/omr:ms-implement` to resume the recorded workflow. A soft-recovery one-shot remains available.

At a hard threshold, new-wave dispatch is refused. Raise the ceiling to restore capacity, or grant a one-shot continue:

```text
/omr:budget-override one-shot roadmap complete the next dispatch
```

The hard-recovery one-shot permits exactly one new-wave dispatch and is then consumed. `/omr:budget-show` includes the override audit state. A terminal findings report automatically adds a `## Budget` section when there is an active reportable budget; it leaves findings unchanged when there is none.

## 19. Safety Rules

Keep these rules in mind:

- Do not edit code outside an approved implementation phase.
- Do not approve vague roadmaps or milestone plans.
- Do not manually skip review.
- Do not start later waves while the current wave has blockers.
- Do not dispatch duplicate workers for the same active task.
- Do not use bypasses casually. A bypass should have a clear reason, scope, risk, and approval.
- Treat `/omr:rm-resume` as orientation. Use `/omr:ms-implement` to continue implementation.

## 20. Quick Troubleshooting

No active roadmap:

```text
/omr:rm-new <goal>
```

Roadmap exists but you are unsure what to do:

```text
/omr:rm-resume
```

Implementation gate is closed by blockers:

```text
/omr:blk-list
/omr:blk-resolve <id> <resolution>
/omr:rm-resume
```

A worker transport failed:

```text
/omr:rm-resume
```

Then let `/omr:ms-implement` recover through the recorded worker-run flow.

A milestone needs more work after review:

```text
/omr:chg-request <what needs to change>
```

The agent tries to continue implementation during `/omr:rm-resume`:

Stop it and run:

```text
/omr:ms-implement
```

`/omr:rm-resume` should report the next legal action; `/omr:ms-implement` should perform it.
