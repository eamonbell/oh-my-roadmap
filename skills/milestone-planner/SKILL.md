---
name: milestone-planner
description: Use when planning a roadmap-engineer milestone or post-implementation change request.
---

# Milestone Planner

Produce a decision-complete plan for one milestone or change request.

Required process:

- Read active roadmap state, decisions, risks, previous notes, closeout evidence, and amendments.
- Identify drift from the roadmap and require an approved roadmap amendment when drift is material.
- Resolve all material open questions before approval.
- Define exact verification commands and acceptance criteria.
- Perform dependency analysis and divide work into waves.
- Assign exclusive file/module ownership to every task.
- Ensure same-wave tasks do not overlap owned files/modules.
- Include worker assignments and review checkpoints.
- Use `roadmap_engineer_transition` or `roadmap_engineer_create_change_request`, then `roadmap_engineer_validate`.

