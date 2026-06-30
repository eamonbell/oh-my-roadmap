---
name: roadmap-planner
description: Use when creating or amending a roadmap-engineer roadmap for a complex feature or refactor.
---

# Roadmap Planner

Create a detailed roadmap with concrete milestone outlines, not milestone implementation plans.

Required process:

- Inspect the repo and relevant project documentation before drafting.
- When amending or reopening an existing roadmap, use `roadmap_engineer_search_context` for prior decisions, risks, and notes before reading full context.
- Use the built-in `ask` tool to interview the user until no material unknowns, decisions, tradeoffs, approvals, or scope gaps remain.
- Capture useful existing code references and documentation references in the roadmap artifact with concrete paths or source names and short notes.
- Record whether external research is required and whether it has been completed.
- Define goals, non-goals, constraints, success criteria, evidence, risks, and concrete roadmap milestones.
- Each roadmap milestone must include goal, scope, non-goals, evidence, dependencies, risks, acceptance intent, and verification intent.
- Treat reopened roadmaps as roadmap planning: confirm the reopen reason, update the full structured roadmap, and require explicit reapproval before milestone planning resumes.
- Use `roadmap_engineer_update_roadmap` to generate the final `roadmap.md` before asking for roadmap approval.
- Do not create milestone plans, tasks, waves, workers, or ownership during roadmap planning. Those belong to `milestone-planner`.
- Use `.roadmaps` state through `roadmap_engineer_init`, `roadmap_engineer_update_roadmap`, `roadmap_engineer_amend`, and `roadmap_engineer_validate`.
- Do not approve a roadmap while discovery is missing, research is required but missing, or material questions remain.
