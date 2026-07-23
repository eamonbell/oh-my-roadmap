---
name: milestone-planner
description: Use when planning a oh-my-roadmap milestone or post-implementation change request.
---

# Milestone Planner

Produce a decision-complete plan for one milestone or change request.

Required process:

- Read active roadmap state, closeout evidence, and amendments with `omr_read_state` scope `active_milestone` for milestone/implementation work (
  `roadmap` scope for roadmap-level questions); avoid full-roadmap/compact dumps when a focused scope answers the question.
- Use `omr_search_context` for decisions, risks, and previous notes before reading full context; expand only relevant entries with `omr_read_context`.
- Select one approved roadmap milestone outline and expand that outline into the milestone plan. Do not invent milestone scope that is not grounded in
  the approved roadmap.
- Do not pad a milestone plan with filler tasks to make the milestone feel larger; every task must directly implement the approved roadmap milestone
  scope.
- Inspect relevant existing code and project documentation before planning ownership, waves, or verification.
- Before dispatching broad scout agents for a subsystem, call `omr_list_scout_findings` filtered by subsystem and milestone when known, and pass any
  relevant prior summaries to the new scouts. At the end of discovery and planning, record a compact finding with `omr_record_scout_finding` covering
  durable repo-structure discoveries (test layout and runner, key module map, cross-cutting conventions), whether scouting was inline or delegated to
  scout agents and regardless of whether a scout agent was ever dispatched.
- Use the built-in `ask` tool to interview the user until implementation decisions, acceptance gaps, verification gaps, ownership gaps, cleanup policy
  questions, and approval questions are closed.
- Interview for intent, not just mechanics. Beyond "how would you like to handle X" questions, explore the user's underlying goals when they are
  relevant: why this milestone matters and what success looks like; the desired user experience or layout for user-facing work; the preferred
  structure for new modules or packages; and how much room to grow to build in so likely near-term changes are easier — without over-engineering.
  These are illustrative examples, not a checklist and not universally applicable: pursue the ones that fit plus any other questions needed to
  understand the full picture, and skip the ones that do not apply.
- Never guess about out-of-project resources. When a task touches an SDK, dependency, API, CLI, or other external resource, do not assume the shape of
  a response, the functions or types it exposes, or that an endpoint or option exists. Ask the user for documentation links or file paths and ground
  the plan in them; record what you consulted and what is still needed. Widely known, stable concepts are exempt. State assumptions and unknowns
  explicitly.
- Explicitly ask the user what they want for test coverage before finalizing the plan: which areas or tasks should create tests, which should only run
  existing tests, what detail each test should cover, and any areas where tests are intentionally deferred or not required.
- Include useful existing code references and documentation references in the milestone or change plan with concrete paths or source names and short
  notes.
- Identify drift from the roadmap and require an approved roadmap amendment when drift is material.
- Resolve all material open questions before approval.
- Define exact verification commands and acceptance criteria. Frame per-wave acceptance as no regressions versus the verification baseline captured at
  implementation start (no new failures, no lost passes), not as an absolute "existing tests remain green" bar — a fresh full-suite-green run is a
  closeout concern, not a per-wave one.
- Convert the user's test coverage decisions into task-level verification commands and done criteria, making clear which tests are new, which are
  existing, and which task owns each test obligation.
- Define concrete executable tasks before dependency analysis or wave creation.
- For every task, include objective, implementation notes, done criteria, task-level verification commands, dependencies, exclusive file/module
  ownership, shared interfaces, and worker assignment.
- Write implementation notes at the approach and intent level: describe what the task must achieve and the constraints on it, not a rigid line-by-line
  script. Keep exclusive file/module ownership exact (it is required for safe parallel waves), but leave the worker room to make the concrete edits,
  and expect new areas of impact, issues, or revelations to surface during implementation — those are handled in-flight unless they invalidate the
  milestone and require a roadmap amendment.
- Assign every implementation task to exactly one of `worker-light`, `worker`, or `worker-heavy` using this rubric: use `worker-light` for narrow,
  low-risk, localized edits; use `worker` for normal bounded implementation with moderate reasoning; use `worker-heavy` for cross-module, API/schema,
  concurrency, migration, high-risk, or high-ambiguity work.
- Perform dependency analysis over the concrete task list; explain why dependencies exist and which tasks can safely run concurrently.
- Divide already-defined tasks into waves.
- For every wave, include goal, exit criteria, review checkpoint, and task IDs.
- Ensure same-wave tasks do not overlap owned files/modules.
- Initialize implementation progress to the first wave with step `not_started`, empty active tasks, and a current timestamp.
- Create or update the draft plan with `omr_transition` or `omr_create_change_request`.
- Dispatch `wave-flow-checker` to review the draft waves before asking for approval.
- After dispatching `wave-flow-checker` and recording its job id, wait once with a meaningful blocking hub `op:wait` for the checker result; do not loop
  short polls. Use hub messaging only when a live checker peer already has context, or after a timeout/interruption.
- Record the checker result with `omr_transition` operation `record_wave_flow_check`.
- If the checker fails, revise the draft plan with `update_milestone_plan` or `update_change_request_plan`, rerun `wave-flow-checker`, and record the
  new result.
- Use `omr_validate` only after the wave-flow check passes, then ask for approval.
