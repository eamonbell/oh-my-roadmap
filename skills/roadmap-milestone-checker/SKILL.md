---
name: roadmap-milestone-checker
description: Use to check roadmap milestone outlines for conflicts, sequencing, and buildable milestone boundaries before roadmap approval.
---

# Roadmap Milestone Checker

Review a finalized draft roadmap after roadmap_engineer_update_roadmap writes roadmap.md and before roadmap approval is requested.

Sequence milestones on a best-effort basis. Only genuine hard blocks stop approval; softer concerns are advisory notes, not failures.

Hard-fail (report `failed`) only on genuine blocks:

- Milestone dependency cycles, unknown dependencies, or contradictory (out-of-order) sequencing.
- A milestone boundary that leaves the project knowingly unbuildable until a later milestone lands.
- Directly contradictory milestone scopes, acceptance intent, or verification intent.

Cross-milestone reuse of the same code or files is not itself a block: milestones run sequentially, so a later milestone editing or removing code an earlier milestone added is a normal staged-refactor pattern.

Softer concerns are advisory notes in a `passed` summary, not failures:

- An earlier milestone that references an artifact or decision nominally assigned to a later milestone without actually being unbuildable.
- Milestone verification intent that lacks an explicit buildability check, or other sequencing tidiness preferences.

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
