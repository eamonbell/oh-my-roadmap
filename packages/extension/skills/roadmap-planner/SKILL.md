---
name: roadmap-planner
description: Use when creating or amending a oh-my-roadmap roadmap for a complex feature or refactor.
---

# Roadmap Planner

Create a detailed roadmap with concrete milestone outlines, not milestone implementation plans.

Required process:

- Inspect the repo and relevant project documentation before drafting.
- When amending or reopening an existing roadmap, orient with `omr_read_state` scope `roadmap` (not the full compact dump) and use
  `omr_search_context` for prior decisions, risks, and notes before reading full context.
- Use the built-in `ask` tool to interview the user until no material unknowns, decisions, tradeoffs, approvals, scope gaps, milestone-substance gaps,
  or roadmap approval questions remain.
- Interview for intent, not just mechanics. Beyond "how would you like to handle X" and "do you accept structural change Y" questions, explore the
  user's underlying goals when they are relevant: why this work matters and what success looks like; the desired user experience or page/layout for
  user-facing work; the preferred package, module, or directory structure; and how much room to grow to build in so likely near-term changes are
  easier — without over-engineering for hypothetical needs. These are illustrative examples, not a checklist and not universally applicable: pursue
  the ones that fit plus any other questions needed to understand the full picture, and skip the ones that do not apply.
- Never guess about out-of-project resources. When the work touches an SDK, dependency, API, CLI, or other external resource, do not assume the shape
  of a response, the functions or types it exposes, or that an endpoint or option exists. Ask the user for documentation links or file paths and
  ground the plan in them; record what you consulted and what you still need. Widely known, stable concepts are exempt. State assumptions and unknowns
  explicitly instead of hiding them.
- Capture useful existing code references and documentation references in the roadmap artifact with concrete paths or source names and short notes.
- Keep milestone outlines at the intent and approach level. Reference existing code or docs when it genuinely helps future agents, but do not pin
  outlines to exact files or line-level steps — expanding an outline into concrete, file-owning tasks is the milestone planning step's job.
- Record whether external research is required and whether it has been completed.
- Define goals, non-goals, constraints, success criteria, evidence, risks, and concrete roadmap milestones.
- Each roadmap milestone must include goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent.
- Each roadmap milestone must contain multiple meaningful deliverables or workstreams that belong together. If a candidate milestone is only one small
  edit, isolated cleanup, or one narrow task, fold it into another milestone instead of preserving it as a separate milestone.
- Treat reopened roadmaps as roadmap planning: confirm the reopen reason, update the full structured roadmap, and require explicit reapproval before
  milestone planning resumes.
- Use `omr_update_roadmap` to generate the final `roadmap.md` before asking for roadmap approval.
- Dispatch roadmap-milestone-checker after omr_update_roadmap writes the finalized roadmap and before asking for roadmap approval.
- Record the checker result with omr_transition operation record_roadmap_milestone_check.
- If the checker fails, revise the roadmap with omr_update_roadmap, rerun roadmap-milestone-checker, and record the new result.
- Use omr_validate only after the recorded roadmap-milestone check has passed, then ask for roadmap approval.
- Do not create milestone plans, tasks, waves, workers, or ownership during roadmap planning. Those belong to `milestone-planner`.
- Use `.omr` state through `omr_init`, `omr_update_roadmap`, `omr_amend`, and `omr_validate`.
- Do not approve a roadmap while discovery is missing, research is required but missing, or material questions remain.
