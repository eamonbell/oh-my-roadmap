# Wave 3 Improvements Summary

## Result

Wave 3 implements R11, R16, R21, and R23 as one context-delivery release. Planning now records exact per-task code references and interface contracts. Planners and checkers receive those structured task records plus compact repository-primer context; workers and reviewers receive the fuller seeded package of verified references, resolved contracts, matching scout findings, style guidance, and the primer when available. Review packages also distinguish active-wave gates from later-wave ownership. Live repository sources remain authoritative, and unavailable or stale context is omitted or explicitly warned about rather than becoming a workflow gate.

The recorded evidence contains a `reviewer_pass` for each implementation wave from Wave 1 through Wave 5, with `bun test` and `bun run check` both exiting successfully at every gate.

**Wave 5 observed post-implementation** — `bun test`: 545 pass, 0 fail; `bun run check`: exit 0.

These changes establish validation signals for reduced repeated discovery and fewer future-scope review findings. They do not measure transcript size, token use, exploratory read counts, or first-pass review rate.

## R11 — Reviewer visibility into later-wave ownership

### What changed

- `PrepareWaveReviewResult` now requires active task `done_criteria` and an ordered `remaining_waves` map. Each remaining-wave entry carries its goal and exit criteria plus task titles, owned files/modules, shared-interface identities, and done criteria.
- Only incomplete plan waves strictly after the active wave are included. The active wave and completed later-position waves are excluded; the final wave receives an empty map. Unknown task references in a remaining wave fail package construction with the wave and task identified.
- Review prompts make the gate explicit: reviewers judge the active wave exit criteria and active task done criteria. Plan-wide milestone acceptance appears under `Milestone acceptance context (non-gating for this wave; final disposition is closeout)`, while `remaining_waves` is an informational ownership map.
- The reviewer template directs reviewers to use the informational future map and assembled seeded context before broad rediscovery, without performing a separate style lookup.

### Key decisions

- Future-wave scope is informational, not a current-wave gate. A reviewer must not fail the active wave solely because a requirement or file is owned by `remaining_waves`.
- Plan-wide acceptance is retained for orientation rather than removed, but its final disposition remains closeout.
- Fresh review and re-review share the required package contract and assembly path, while live sources are refreshed and seeded context is rebuilt on every prepare operation.

## R16 — Worker context-hygiene rules

### What changed

All three worker tiers—`worker-light`, `worker`, and `worker-heavy`—now carry the same three substantive rules:

1. Batch related reads before editing.
2. Trust successful edit receipts instead of reading back an applied edit.
3. Re-read only when the file changed or when the next unseen hunk must be grounded.

The rule lives in the worker role templates rather than being duplicated in each dispatch prompt. Generated worker roles also consume `seeded_context.style_guidance`; an explicit “No recorded code-style guidance for these files.” is authoritative and does not trigger another style lookup.

### Key decisions

- The wording is identical across worker tiers so worker selection does not alter context hygiene.
- The policy avoids unconditional re-reads while preserving re-reading when state changed or an unseen edit location still needs grounding.
- Benefits are represented by drift and role-generation tests; no reduction in actual read count or token use is claimed.

## R21 — Structured seeded context from planning through dispatch and review

### What changed

- Every milestone, change-request, and ad-hoc task now requires structured `relevant_existing_code` and `shared_interface_contracts` arrays. Relevant-code records carry a repository-relative path, optional line/symbol, note, capture time, and source mtime. Interface contracts carry a name, normalized-match signature, source path, optional line, and planned-source metadata.
- Task context is captured on plan creation/update. Existing paths must resolve to regular files inside the repository, line numbers must be valid, and existing interface signatures must match after whitespace normalization. A `planned: true` interface must identify an owning producer task in a strictly earlier wave.
- This is a clean schema cutover. Milestone, change-request, and ad-hoc legacy task shapes are rejected with `Task <id> uses the pre-Wave-3 context schema; re-plan with the current task context schema.` There is no string parser, compatibility default, migration shim, or plan-wide evidence fallback.
- Planner-facing roadmap, active milestone, active change, roadmap-checker, and wave-flow-checker packages carry compact primer context where applicable. Task projections preserve the structured arrays, while narrow scopes such as phase, progress, and quality gates remain compact. Planning/checker instructions require roles to use delivered primer facts first, pass the compact primer into delegated scout prompts, verify structured pointers against live sources, and scout only uncovered gaps.
- `loadWaveContextSources` is the single aggregation provider. Once per prepare operation it refreshes the primer, loads non-stale scout findings, assembles style guidance for the active ownership set, and rechecks task sources. Pure slicers then create task-specific worker context or a deduplicated active-wave reviewer context.
- Each worker assignment requires `seeded_context`, and the same compact JSON is rendered in its prompt. Fresh dispatch, abandonment recovery, and genuine rework share the enriched assignment path.
- Review preparation requires one aggregate `seeded_context`, renders the same package in the reviewer prompt, and combines it with R11’s active criteria and informational future map.

### Key decisions

- **Live-source authority:** captured relevant-code references are delivered only while the current mtime equals the captured mtime. Interface contracts—including interfaces planned in an earlier wave—are delivered only when the live source contains the whitespace-normalized signature. Live code remains authoritative after package assembly.
- **Typed omission warnings:** missing, stale, mismatched, or outside-repository items are omitted and reported as `missing_source`, `stale_source`, `signature_mismatch`, or `outside_repo`. Primer failures and truncation use `primer_unavailable`, `primer_refresh_failed`, and `truncated`.
- **Deterministic, bounded delivery:** task packages cap code references and interfaces at 20 each and scout findings at 10. Reviewer packages stably merge and deduplicate active tasks, capping all three categories at 20. Style guidance is capped at 8 KiB, the primer at 12 KiB, and warnings at 20 with a reserved aggregate truncation marker when needed.
- **Path-aware scout matching:** findings match exact, ancestor, or descendant ownership boundaries; pathless findings are repository-wide, stale findings are excluded, and string-prefix false matches are not accepted.
- **Prompt/package parity:** prompts contain the same seeded JSON returned in the typed result. Successful assembly establishes a verified starting point, not permission to ignore later source changes.

## R23 — Persistent per-repository primer

### What changed

- OMR maintains `.omr/repo-primer.yml` with `schema_version: 1`. The primer records a SHA-256 source fingerprint, generation time, package managers, hashed manifests/lockfiles/build inputs, workspace members, detected test/build/typecheck commands, test and module roots, bounded repository-guidance excerpts, and warnings.
- Discovery is deterministic and bounded: candidates use stable lexical ordering and explicit caps; workspace and source realpaths are confined to the repository; escaping symlinks are not followed. JavaScript manager resolution follows explicit `packageManager` and lockfile precedence rules, and commands are emitted only from supported, resolved inputs.
- The fingerprint covers discovered candidate names before caps plus retained file contents. An unchanged fingerprint preserves the existing bytes and `generated_at`; changed inputs refresh the artifact. Writes use atomic persistence.
- Successful `omr_init` calls `refreshRepoPrimer` and reports its refresh status and scan warnings. Planner, dispatch, and review consumers also refresh lazily so a missing or drifted artifact can repair itself.
- Refresh failure is non-gating. `refreshRepoPrimer` returns `stale_fallback` with the last good artifact or `unavailable` without one. Dispatch/review map those outcomes to typed `primer_refresh_failed` or `primer_unavailable` seeded warnings, while planner state reads expose textual `repo_primer_warnings`; roadmap initialization and package preparation continue.

### Key decisions

- The primer is one project-wide persisted source, not a second per-role store or a model-authored repository summary.
- Literal, hashed source facts and bounded guidance excerpts are preferred over inferred commands or unbounded scanning.
- Last-good fallback preserves useful context while making staleness explicit; primer availability never becomes a planning, dispatch, review, or initialization gate.

## Key design decisions

1. **Clean task-schema cutover:** both structured arrays are required everywhere, and all plan producers/loaders enforce the same current schema.
2. **Verified capture, authoritative live source:** planning validates references and signatures, but dispatch/review recheck them. Ordinary typed warnings identify omitted items within the warning cap; the aggregate `truncated` marker accounts for additional omitted warnings or data that are not individually listed.
3. **One provider, pure slices:** each prepare operation performs one shared provider load, then derives deterministic worker or reviewer views without repeating primer, scout, or style loads per role.
4. **Bounded payloads with visible loss:** item, byte, and warning caps are explicit; truncation is counted and surfaced rather than silent.
5. **Non-gating repository primer:** unchanged data is stable, drift refreshes, failures use last-good or omission warnings, and workflow operations continue.
6. **Informational future scope:** later ownership helps reviewers avoid false current-wave findings, while active exit criteria and active task done criteria remain the only wave gates.
7. **No inferred structured evidence:** plan-wide free-form evidence remains available for display but is not converted into task references or interface contracts.

## Validation signals now covered by tests

The following are implementation-level validation signals. They prove package contents, validation boundaries, deterministic caps, prompt contracts, persistence behavior, and non-gating error paths; they do not prove production reductions in reads, tokens, or review iterations.

### R11

- `test/state/reviewer-future-scope.test.ts`
  - `pure reviewer slicing repeats stable active-task-order merge, dedupe, exact caps, and warning reservation`
  - `excludes a completed post-active wave while preserving later incomplete plan order`
  - `delivers active criteria, seeded context, and ordered informational future scope with fresh/re-review parity`
  - `names unknown remaining-wave task references`
  - `returns no remaining waves for the final plan wave`
  - `reviewer template consumes assembled context and contains no style-tool instruction`

These tests cover the later-docs/current-code regression shape, active task done criteria, non-gating prompt text, active/completed exclusions, plan order, unknown-task diagnostics, final-wave behavior, one provider load per review preparation, and re-review parity.

### R16

- `test/skill-rule-drift.test.ts`
  - `all worker templates carry the identical R16 context-hygiene rule`
  - `the R16 drift guard detects a one-word divergence`
- `test/project-init.test.ts`
  - `creates default config and local generated agents`

These tests cover normalized rule equality across all worker tiers, a mutation control that detects one-word drift, and generated worker roles that consume assembled style guidance without an `omr_style_guide` instruction.

### R21

- `test/state/task-context-contracts.test.ts`
  - `captures and persists milestone task references and contracts`
  - `captures and persists change-request task context`
  - `captures on ad-hoc creation and recaptures on draft update`
  - `rejects a legacy milestone plan with the exact re-plan error`
  - `rejects a legacy change-request plan with the exact re-plan error`
  - `rejects a legacy ad-hoc plan with the exact re-plan error`
  - `matches whitespace-normalized signatures and records source metadata`
  - `accepts only a strictly earlier owning producer for planned contracts`
  - `requires both structured arrays in the task Zod schema`
  - `requires exact pointers, contracts, and planned producers in every planning prompt`
- `test/state/context-seeding.test.ts`
  - `loads each provider once and pure task slices boundary-match own, ancestor, descendant, and pathless scouts`
  - `omits stale, missing, mismatched, and realpath-escaping sources while resolving landed planned signatures`
  - `delivers stale fallback primer non-gating and omits unavailable primer with typed warnings`
  - `enforces byte/data caps and reviewer stable first-occurrence dedupe across task order`
  - `reserves reviewer warning slot 20 after stable multi-task merge with exactly 20 ordinary warnings and another truncated field`
- `test/state/dispatch-context-seeding.test.ts`
  - `filters task context, warns without gating, enforces caps, and preserves exact prompt/package parity`
  - `uses one provider load per operation and identical enrichment for abandonment recovery and genuine rework`
- `test/state/reviewer-future-scope.test.ts`
  - `pure reviewer slicing repeats stable active-task-order merge, dedupe, exact caps, and warning reservation`
  - `delivers active criteria, seeded context, and ordered informational future scope with fresh/re-review parity`
- `test/tools/context-tools.test.ts`
  - `narrow read-state scopes return only their own payloads`
  - `ad-hoc wave and checker summaries preserve exact structured task context`
  - `active change summaries preserve exact structured task context`
  - `primer refresh failures warn without failing planner state reads`
- `test/commands.test.ts`
  - `milestone, change, and ad-hoc planning prompts require exact structured task context`
- `test/project-init.test.ts`
  - `creates default config and local generated agents`

Together these tests cover the clean cutover, capture rules, planned-producer constraints, planning/checker delivery, compact narrow scopes, live-source omission warnings, path-boundary filtering, deterministic caps/deduplication, provider-call count, prompt/package parity, and the same enriched package contract/assembly path for fresh dispatch, redispatch, and re-review, with live context rebuilt per operation.

### R23

- `test/repo-primer.test.ts`
  - `detects the bounded mixed ecosystem surface, explicit commands, guidance order, and confined workspaces`
  - `applies workspace, manifest, combined-root, and guidance caps in lexical order`
  - `uses the exact JavaScript package-manager precedence and lockfile ambiguity rules`
  - `persists atomically, preserves bytes and generated_at when unchanged, refreshes drift, and falls back stale`
  - `returns unavailable on an initial malformed scan and renders within a byte budget`
- `test/tools/roadmap-tools.test.ts`
  - `refreshes the repository primer after omr_init and includes its status and warnings in the receipt`
  - `does not gate omr_init when the initial repository scan is unavailable`
- `test/tools/context-tools.test.ts`
  - `narrow read-state scopes return only their own payloads`
  - `primer refresh failures warn without failing planner state reads`
- `test/skill-rule-drift.test.ts`
  - `planner and checker roles carry the canonical repo-primer-use rule`
  - `the repo-primer drift guard detects a one-word divergence`

These tests cover deterministic bounded discovery, realpath confinement, command resolution, fingerprint/lifecycle stability, atomic persistence, last-good and unavailable behavior, byte-bounded rendering, initialization receipts, non-gating lazy refresh, and canonical planner/checker consumption rules.

## Deferred / follow-ups

Wave 3 intentionally leaves the following items unimplemented:

- **R22:** A new source-inspection tool would overlap context now delivered through existing planner/dispatch/review packages and still requires a separate parser/LSP contract.
- **R24 + F1:** Wave diffs and opt-in git checkpoints need one authoritative snapshot/change-manifest design. Implementing R24 alone would duplicate that boundary.
- **R17:** Transport repair is orthogonal to context delivery.
- **R19:** Model-tier documentation is a separate configuration-policy batch, and its escalation policy depends on R20.
- **R20:** The Wave 2 rework queue does not yet contain attempt history, so a loop cap requires a dedicated state/history policy.
- **F2–F4:** Analytics, predictive pricing, and cross-wave worker reuse are independent product features rather than context-delivery work.

Future evaluation may compare exploratory reads, transcript/token cost, and first-pass review outcomes before and after this release. Those are follow-up measurements, not achieved Wave 3 results.
