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
- Inspect relevant existing code and project documentation before planning ownership, waves, or verification.
- Use the built-in `ask` tool to interview the user until implementation decisions, acceptance gaps, verification gaps, ownership gaps, cleanup policy questions, and approval questions are closed.
- Include useful existing code references and documentation references in the milestone or change plan with concrete paths or source names and short notes.
- Identify drift from the roadmap and require an approved roadmap amendment when drift is material.
- Resolve all material open questions before approval.
- Define exact verification commands and acceptance criteria.
- Perform dependency analysis and divide work into waves.
- Assign exclusive file/module ownership to every task.
- Ensure same-wave tasks do not overlap owned files/modules.
- Include worker assignments and review checkpoints.
- Use `roadmap_engineer_transition` or `roadmap_engineer_create_change_request`, then `roadmap_engineer_validate`.
