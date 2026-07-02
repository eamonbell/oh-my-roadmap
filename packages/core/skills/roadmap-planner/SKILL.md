---
name: roadmap-planner
description: Use when creating or amending a oh-my-roadmap roadmap for a complex feature or refactor.
---

# Roadmap Planner

Create a detailed roadmap with concrete milestone outlines, not milestone implementation plans.

Required process:

- Inspect the repo and relevant project documentation before drafting.
- When amending or reopening an existing roadmap, orient with `omr_read_state` scope `roadmap` (not the full compact dump) and use `omr_search_context` for prior decisions, risks, and notes before reading full context.
- Use the built-in `ask` tool to interview the user until no material unknowns, decisions, tradeoffs, approvals, scope gaps, milestone-substance gaps, or roadmap approval questions remain.
- Capture useful existing code references and documentation references in the roadmap artifact with concrete paths or source names and short notes.
- Record whether external research is required and whether it has been completed.
- Define goals, non-goals, constraints, success criteria, evidence, risks, and concrete roadmap milestones.
- Each roadmap milestone must include goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent.
- Each roadmap milestone must contain multiple meaningful deliverables or workstreams that belong together. If a candidate milestone is only one small edit, isolated cleanup, or one narrow task, fold it into another milestone instead of preserving it as a separate milestone.
- Treat reopened roadmaps as roadmap planning: confirm the reopen reason, update the full structured roadmap, and require explicit reapproval before milestone planning resumes.
- Use `omr_update_roadmap` to generate the final `roadmap.md` before asking for roadmap approval.
- Dispatch roadmap-milestone-checker after omr_update_roadmap writes the finalized roadmap and before asking for roadmap approval.
- Record the checker result with omr_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with omr_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Use omr_validate only after the recorded roadmap-milestone check has passed, then ask for roadmap approval.
- Do not create milestone plans, tasks, waves, workers, or ownership during roadmap planning. Those belong to `milestone-planner`.
- Use `.roadmaps` state through `omr_init`, `omr_update_roadmap`, `omr_amend`, and `omr_validate`.
- Do not approve a roadmap while discovery is missing, research is required but missing, or material questions remain.
