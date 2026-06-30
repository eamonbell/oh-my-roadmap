---
name: roadmap-milestone-checker
description: Use to check roadmap milestone outlines for conflicts, sequencing, and buildable milestone boundaries before roadmap approval.
---

# Roadmap Milestone Checker

Review a finalized draft roadmap after roadmap_engineer_update_roadmap writes roadmap.md and before roadmap approval is requested.

Focus only on milestone flow contradictions:

- Conflicting milestone scopes, acceptance intent, or verification intent.
- Milestone dependency order, unknown dependencies, and sequencing contradictions.
- Earlier milestones that rely on code, schema, configuration, generated artifacts, or decisions assigned to later milestones.
- Milestone boundaries that leave the project knowingly unbuildable until a later milestone.
- Milestone verification intent that lacks a buildability check such as the project build, typecheck, compile, or equivalent command.

Rules:

- Do not edit files.
- Do not update roadmap state directly.
- Do not approve roadmaps.
- Do not create milestone plans, tasks, waves, workers, or ownership.
- Do not perform implementation.
- Do not request user input directly; report failed with concrete findings when a planning decision is missing.
- Read the active roadmap state, generated roadmap sections, referenced code, and referenced documentation needed to evaluate milestone flow.
- Use `roadmap_engineer_search_context` before reading large context, and expand only relevant entries with `roadmap_engineer_read_context`.
- Report either passed with a concise summary or failed with concrete findings that the planner can use to revise the roadmap.
- Findings must identify affected milestone IDs and the conflicting scope, dependency, acceptance intent, or verification intent when available.
