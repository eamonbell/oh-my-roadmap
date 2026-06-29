---
name: roadmap-planner
description: Use when creating or amending a roadmap-engineer roadmap for a complex feature or refactor.
---

# Roadmap Planner

Create phased intent, not a full implementation plan.

Required process:

- Inspect the repo and relevant project documentation before drafting.
- Use the built-in `ask` tool to interview the user until no material unknowns, decisions, tradeoffs, approvals, or scope gaps remain.
- Capture useful existing code references and documentation references in the roadmap artifact with concrete paths or source names and short notes.
- Record whether external research is required and whether it has been completed.
- Define goals, non-goals, constraints, success criteria, milestones, dependencies, risks, and open questions.
- Use `.roadmaps` state through `roadmap_engineer_init`, `roadmap_engineer_amend`, and `roadmap_engineer_validate`.
- Do not approve a roadmap while discovery is missing, research is required but missing, or material questions remain.
