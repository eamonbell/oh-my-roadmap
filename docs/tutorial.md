# TUI Tutorial

This tutorial walks through using `roadmap-engineer` from the OMP TUI when you have never used it before.

`roadmap-engineer` is for work that is too large or risky for one prompt. It turns the work into a gated lifecycle:

```text
roadmap -> milestone plan -> implementation waves -> review -> closeout -> complete
```

The main thing to remember: you drive the workflow with slash commands, and the agent records state under `.roadmaps`.

## 1. Start In The Target Project

Open OMP in the repository where you want the roadmap to live.

```sh
cd /path/to/your/project
omp --extension /path/to/roadmap-engineer
```

If the extension is installed another way in your environment, use that normal startup command instead.

Confirm the extension is loaded:

```text
/extensions
```

You should see `roadmap-engineer` and its tools.

## 2. Initialize Project Files

Run this once per repository:

```text
/roadmap:init
```

This creates or refreshes:

```text
.roadmaps/config.yml
.omp/agents/worker-light.md
.omp/agents/worker.md
.omp/agents/worker-heavy.md
.omp/agents/reviewer.md
.omp/agents/wave-flow-checker.md
.omp/agents/roadmap-milestone-checker.md
```

`/roadmap:init` does not start a roadmap. It only prepares the repo.

## 3. Create A Roadmap

Start a new roadmap with a short description of the work:

```text
/roadmap:new Replace the old workflow system with standalone workflows
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

At the end of `/roadmap:new`, the agent should:

- create `.roadmaps/active.yml`
- create `.roadmaps/<roadmap-id>/state.yml`
- generate `.roadmaps/<roadmap-id>/roadmap.md`
- dispatch `roadmap-milestone-checker`
- record the checker result
- ask you to approve the roadmap

Do not approve if the roadmap has vague milestones or unresolved decisions. Ask the agent to revise it.

## 4. Check Status Any Time

Use:

```text
/roadmap:status
```

This reports the current roadmap phase, active milestone, blockers, validation state, and next legal action.

Use:

```text
/roadmap:resume
```

This is for orientation after a pause, crash, context loss, or a new session. It should summarize state and propose the next legal action. It should not continue implementation automatically.

Optional dashboard:

```text
/roadmap:details
```

This shows a local TUI details view when available.

## 5. Plan The First Milestone

After roadmap approval, create the detailed plan for the next roadmap milestone:

```text
/milestone:plan
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
/milestone:implement
```

The orchestrator should not edit code directly. It should:

1. Read the active progress cursor.
2. Call `roadmap_engineer_prepare_wave_dispatch`.
3. Dispatch only the active wave assignments.
4. Use each task's exact worker: `worker-light`, `worker`, or `worker-heavy`.
5. Record each worker dispatch immediately.
6. Wait for worker results.
7. Record each result.
8. Dispatch `reviewer` after all active wave tasks complete.
9. Record review.
10. Advance to the next wave only after review passes.

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

## 8. Resume After A Pause Or Crash

If a session crashes or you return later, run:

```text
/roadmap:resume
```

Read the reported next action.

Common outcomes:

- If it says a wave is ready to dispatch, run `/milestone:implement`.
- If it says workers are running, let the orchestrator poll or recover them.
- If it says workers are running but the current session has no matching background job or IRC peer, run `/milestone:implement`; the orchestrator should mark the old run abandoned before redispatching.
- If it says review is needed, run `/milestone:implement`.
- If blockers are open, use the blocker commands below.
- If closeout is ready, run `/milestone:close`.

The persisted progress cursor is authoritative. Notes are supporting evidence, not the source of truth.

## 9. Handle Blockers

List blockers:

```text
/blocker:list
```

Check blocker state:

```text
/blocker:status
```

Resolve a blocker when the issue is fixed:

```text
/blocker:resolve <blocker-id> <resolution>
```

Example:

```text
/blocker:resolve blk_123 Fixed the stale API route and reran go test ./actn/... -run '^$' -count=1.
```

Defer a blocker only when you intentionally accept the risk:

```text
/blocker:defer <blocker-id> <reason>
```

Example:

```text
/blocker:defer blk_456 User approved deferring artifact behavior coverage to the artifact integration milestone.
```

After resolving or deferring blockers, run:

```text
/roadmap:resume
```

Then continue with the reported next action.

## 10. Transport Failures And Duplicate Workers

Sometimes a worker job may fail because the socket closed or the transport died. Treat that as an orchestration interruption, not an implementation blocker.

The orchestrator should:

1. Mark the run as `transport_failed`.
2. Probe the original worker or job.
3. If it responds, collect the result.
4. If it does not respond after 2 minutes, mark it `abandoned`.
5. Redispatch only that abandoned task.

Only wait when the worker exists in the current session as a background job or IRC peer. If you resumed in a new session and there is no matching job and no matching peer, the orchestrator should mark the old run `abandoned` immediately instead of polling or waiting.

Do not manually start a duplicate worker for the same task if an active run exists.

If you see `active_runs` in dispatch output, the orchestrator should poll or probe those runs instead of spawning new workers.

## 11. Review Waves

After every wave, the orchestrator dispatches `reviewer`.

A passed review lets the workflow advance to the next wave.

A failed review opens blockers for real blocking findings. Positive findings such as `PASS:` or informational findings should not block. If blockers are opened, use:

```text
/blocker:list
```

Then resolve or defer them before continuing.

## 12. Close The Milestone

When all waves pass review, run:

```text
/milestone:close
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
/milestone:plan
```

The workflow repeats:

```text
plan milestone -> approve -> implement waves -> review -> close milestone
```

Continue until all roadmap milestones are complete.

## 14. Make A Post-Implementation Change

If implementation, review, or closeout reveals needed follow-up work, create a change request:

```text
/change:request Add validation for missing workflow input mappings
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
/milestone:implement
```

Check change status:

```text
/change:status
```

Close it with:

```text
/change:close
```

## 15. Complete The Roadmap

After every roadmap milestone is complete and no active change request remains, use:

```text
/roadmap:status
```

If the next action says the roadmap is complete or ready to finish, follow the reported instruction. The final state should have:

- no open blocking blockers
- no active implementation wave
- milestone closeout evidence recorded
- all roadmap milestones complete

## 16. Common Command Sequence

For a normal roadmap:

```text
/roadmap:init
/roadmap:new <goal>
/roadmap:status
/milestone:plan
/milestone:implement
/milestone:close
/milestone:plan
/milestone:implement
/milestone:close
/roadmap:status
```

For recovery:

```text
/roadmap:resume
/blocker:list
/blocker:resolve <id> <resolution>
/roadmap:resume
/milestone:implement
```

For a post-implementation change:

```text
/change:request <requested change>
/milestone:implement
/change:close
```

## 17. What Good Output Looks Like

Good `/roadmap:status` or `/roadmap:resume` output tells you:

- active roadmap
- phase
- active milestone
- active wave
- active task
- blocker count
- validation state
- implementation gate state
- next legal action

Good `/milestone:implement` behavior:

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

## 18. Safety Rules

Keep these rules in mind:

- Do not edit code outside an approved implementation phase.
- Do not approve vague roadmaps or milestone plans.
- Do not manually skip review.
- Do not start later waves while the current wave has blockers.
- Do not dispatch duplicate workers for the same active task.
- Do not use bypasses casually. A bypass should have a clear reason, scope, risk, and approval.
- Treat `/roadmap:resume` as orientation. Use `/milestone:implement` to continue implementation.

## 19. Quick Troubleshooting

No active roadmap:

```text
/roadmap:new <goal>
```

Roadmap exists but you are unsure what to do:

```text
/roadmap:resume
```

Implementation gate is closed by blockers:

```text
/blocker:list
/blocker:resolve <id> <resolution>
/roadmap:resume
```

A worker transport failed:

```text
/roadmap:resume
```

Then let `/milestone:implement` recover through the recorded worker-run flow.

A milestone needs more work after review:

```text
/change:request <what needs to change>
```

The agent tries to continue implementation during `/roadmap:resume`:

Stop it and run:

```text
/milestone:implement
```

`/roadmap:resume` should report the next legal action; `/milestone:implement` should perform it.
