---
name: milestone-planner
description: Use when planning a roadmap-engineer milestone or post-implementation change request.
---

# Milestone Planner

Produce a decision-complete plan for one milestone or change request.

Required process:

- Read active roadmap state, closeout evidence, and amendments.
- Use `roadmap_engineer_search_context` for decisions, risks, and previous notes before reading full context; expand only relevant entries with `roadmap_engineer_read_context`.
- Select one approved roadmap milestone outline and expand that outline into the milestone plan. Do not invent milestone scope that is not grounded in the approved roadmap.
- Do not pad a milestone plan with filler tasks to make the milestone feel larger; every task must directly implement the approved roadmap milestone scope.
- Inspect relevant existing code and project documentation before planning ownership, waves, or verification.
- Use the built-in `ask` tool to interview the user until implementation decisions, acceptance gaps, verification gaps, ownership gaps, cleanup policy questions, and approval questions are closed.
- Explicitly ask the user what they want for test coverage before finalizing the plan: which areas or tasks should create tests, which should only run existing tests, what detail each test should cover, and any areas where tests are intentionally deferred or not required.
- Include useful existing code references and documentation references in the milestone or change plan with concrete paths or source names and short notes.
- Identify drift from the roadmap and require an approved roadmap amendment when drift is material.
- Resolve all material open questions before approval.
- Define exact verification commands and acceptance criteria.
- Convert the user's test coverage decisions into task-level verification commands and done criteria, making clear which tests are new, which are existing, and which task owns each test obligation.
- Define concrete executable tasks before dependency analysis or wave creation.
- For every task, include objective, implementation notes, done criteria, task-level verification commands, dependencies, exclusive file/module ownership, shared interfaces, and worker assignment.
- Assign every implementation task to exactly one of `worker-light`, `worker`, or `worker-heavy` using this rubric: use `worker-light` for narrow, low-risk, localized edits; use `worker` for normal bounded implementation with moderate reasoning; use `worker-heavy` for cross-module, API/schema, concurrency, migration, high-risk, or high-ambiguity work.
- Perform dependency analysis over the concrete task list; explain why dependencies exist and which tasks can safely run concurrently.
- Divide already-defined tasks into waves.
- For every wave, include goal, exit criteria, review checkpoint, and task IDs.
- Ensure same-wave tasks do not overlap owned files/modules.
- Initialize implementation progress to the first wave with step `not_started`, empty active tasks, and a current timestamp.
- Create or update the draft plan with `roadmap_engineer_transition` or `roadmap_engineer_create_change_request`.
- Dispatch `wave-flow-checker` to review the draft waves before asking for approval.
- Record the checker result with `roadmap_engineer_transition` operation `record_wave_flow_check`.
- If the checker fails, revise the draft plan with `update_milestone_plan` or `update_change_request_plan`, rerun `wave-flow-checker`, and record the new result.
- Use `roadmap_engineer_validate` only after the wave-flow check passes, then ask for approval.
