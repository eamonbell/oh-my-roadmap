# REC-PROMPT — reusable prompt for implementing RECOMMENDED-IMPROVEMENTS in batches

Paste the **Prompt** section below to plan and implement the next batch of recommendations from
`RECOMMENDED-IMPROVEMENTS.md`. It generalizes the original first-batch request and bakes in the
conventions that batch established (see **Conventions** and **Context for the assistant** below).

---

## Prompt (copy–paste)

> Read @RECOMMENDED-IMPROVEMENTS.md. Ignore any recommendation already marked
> `✅ Implemented` — those are done. From what remains, propose the **next batch** to implement,
> grouped **by likeness and impact** (prefer a coherent, low-coupling cluster that can ship as one
> reviewable unit; respect the doc's own §5 "Suggested sequencing" and the dependency notes
> between recommendations). Tell me which recommendations you're proposing and why, and which you
> are explicitly deferring.
>
> Then create a plan to implement the batch. Organize the work into **dependency-ordered waves**
> where no two tasks in a wave edit the same file, assign each task a worker tier matching its
> complexity, and gate every wave behind a reviewer pass (fix→re-review until PASS). The plan must
> **conclude with a set of tasks to**: update the docs and README for any behavior that changed;
> mark each implemented recommendation in `RECOMMENDED-IMPROVEMENTS.md` as completed with a
> `✅ Implemented (Wave N)` tag on its heading and its §5 ranked-table row; and write a new
> `WAVE-N-IMPROVEMENTS-SUMMARY.md` at the repo root summarizing the work completed, the key
> decisions made, the regression tests added (mapped to each recommendation's validation signal),
> and what was deferred and why.
>
> Ask me lots of questions and make no assumptions. Gaps or open questions are hard acceptance
> blockers — resolve every scope/approach ambiguity with me (via the question tool, in plan mode)
> **before** finalizing the plan. Do not begin implementation until I approve the plan.
>
> Use `N` = the next unused wave number (this repo has completed **Wave 1**; the next batch is
> **Wave 2**, and so on).

---

## Conventions (established in Wave 1 — keep these consistent)

- **Batch selection:** group by likeness + impact into an independently-shippable unit. The doc's
  §5 sequencing is the default guide. The remaining heavy cluster **R1 + R4 + R8** is the intended
  "state-integrity wave" and should be planned together with regression tests keyed to the
  transcript signals. Don't silently pull in unrelated recs.
- **Marking completed:** append `✅ Implemented (Wave N)` to the recommendation's `####` heading
  **and** to its row in the §5 ranked-summary table. Never rewrite recommendation content — only
  add the status marker. Leave deferred recs unmarked.
- **Summary doc:** `WAVE-N-IMPROVEMENTS-SUMMARY.md` at repo root, with sections: intro/result,
  per-recommendation what-changed + key decisions, "Key design decisions", "Validation signals now
  covered by tests" (cite the *actual* test files/names — verify them), and "Deferred / follow-ups"
  (with rationale). Don't overclaim work that wasn't done.
- **Test bar:** a regression test for each behavioral/core change, keyed to that recommendation's
  "Validation signal" line in the doc. Copy-only changes (prose/skills) get a drift/consistency
  test where meaningful. Prefer new focused test files over bloating large existing ones.
- **Prose is duplicated** between `packages/extension/src/extension/commands/prompts.ts` and the
  `SKILL.md` files. Wave 1 extracted the worker/reviewer-rework and scout rules to
  `packages/extension/src/extension/commands/rule-text.ts` with a drift test
  (`test/skill-rule-drift.test.ts`). Any further rule edits should go through that single source
  and keep the drift test green; extend the same pattern for newly-single-sourced rules.

## Verification constraints (project — non-negotiable)

- Verify with `bun test` (full suite, top-level `test/`) and `bun run check` (`tsc --noEmit`) only.
- **Do NOT run the OMR extension under an OMP session** to verify. Static + unit verification only.
- Full suite must be green and typecheck clean before a wave passes review and at final closeout.
- The IDE occasionally emits stale mid-edit TS diagnostics; trust `bun run check` as ground truth.

## Repo facts (verify before relying on them)

- Bun workspace: `packages/core` (`@oh-my-roadmap/core`), `packages/extension`
  (`@oh-my-roadmap/extension`), `packages/cli` (`@oh-my-roadmap/cli`). (No `packages/omr-cli`.)
- Tests live at **top-level `test/`** (`test/state/`, `test/tools/`); fixtures in
  `test/state/helpers.ts` (`approvedMilestone()`) and `test/tools/helpers.ts`. Runner: `bun test`.
- Tool registration: `packages/extension/src/tools/register/*.ts`; receipt helpers `textResult` /
  `receiptResult` in `register/shared.ts`; rich `TransitionReceipt` in `packages/core/src/store/`.
- Skills: `packages/extension/skills/{roadmap-planner,milestone-planner,implementation-orchestrator}/SKILL.md`.
  Agent templates: `packages/core/agent-templates/*/AGENT.md` (some mirrored under `.omp/agents/`).
- User docs: `README.md`, `docs/{tutorial,design,irc}.md`.

## Status ledger (update as batches land)

- **Wave 1 (done):** R2, R5, R6, R7, R9, R10, R13, R14, R15, R18 — see `WAVE-1-IMPROVEMENTS-SUMMARY.md`.
- **Remaining (unimplemented):** R1, R3, R4, R8, R11, R12, R16, R17, R19, R20, R21, R22, R23, R24,
  F1, F2, F3, F4. (R1+R4+R8 = the state-integrity wave; R21–R24 = context-delivery addendum;
  F1–F4 = maintainer-endorsed features.) Confirm against the `✅` tags in the doc before selecting.
