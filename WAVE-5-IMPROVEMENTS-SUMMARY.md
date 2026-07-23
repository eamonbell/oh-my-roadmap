# Wave 5 Implementation Summary

## Intro / result

Wave 5 shipped four improvements from RECOMMENDED-IMPROVEMENTS.md, each deliberately scoped tighter than its original spec: **R17(b+c)** (xd:// transport invocation examples + per-operation phase preconditions baked into tool descriptions, skipping the JSON repair pass which lives upstream), **R19** (per-role model-tier guidance in docs, skipping the escalate-on-failure hook), **R20** (a core-enforced `orchestration.max_review_cycles` cap that halts the reviewer/rework loop and mints a needs-user blocker with accumulated findings history), and **R22** (a new `omr_task_briefing` read tool that assembles a one-call context pack of file sizes, head excerpts, and a one-hop import graph for owned/dependency files). All four shipped cleanly: `bun run check` exits 0 (no TypeScript errors), and `bun test` shows 605 pass / 0 fail across 63 test files (21.26s).

---

## Per-recommendation: what changed & key decisions

### R17 (b+c) — xd:// transport invocation examples + phase preconditions

**Delivered behavior:**
- `omr_transition`'s tool description (`packages/extension/src/tools/register/transition-tools.ts`) now states, in prose, the phase precondition for every operation that has one — e.g. `record_discovery requires phase discovery or roadmap_draft`, `approve_roadmap requires phase roadmap_draft (and recorded discovery, resolved open questions)`, `start_milestone_planning requires phase roadmap_approved or complete`, `start_closeout requires phase reviewing (call start_reviewing first if not)` — so a model can self-check preconditions before calling rather than discovering them via a thrown error.
- The same description carries a canonical invocation example: `write xd://omr_transition {"operation":"record_discovery","discovery":{"recorded":true}} — emit exactly one JSON args object with only the fields listed for that operation; no markdown fences, comments, or trailing text.`
- `omr_init` and `omr_update_roadmap` (`packages/extension/src/tools/register/roadmap-tools.ts`) each got their own canonical-invocation-example sentence in the same style (`write xd://omr_init {...}`, `write xd://omr_update_roadmap {...}`).
- The session-start prompt (`packages/extension/src/extension/commands/prompts.ts:195`) gained a generic xd:// invocation example line covering all `omr_*` write tools, independent of any one tool's description.

**Notable choices:**
- **R17(a) — the transport-side JSON repair/tolerance pass — was deliberately NOT built this wave.** That logic lives in the upstream `@oh-my-pi/pi-coding-agent` package (the xd:// transport itself), not in this repo, so it's out of scope for an OMR-side change; only the description-level guidance (b, c) was implementable here.
- Preconditions and invocation examples are baked directly into tool `description` strings (read at registration time), not into a separate reference doc — this keeps the guidance visible to the model at the point of the tool call rather than requiring a prior read.
- The `omr_transition` precondition list only documents phase-gated operations; operations with no roadmap-phase requirement (e.g. `update_task_status`, `request_bypass`) are called out as such rather than omitted, so the description reads as exhaustive.

### R19 (docs only) — per-role model-tier guidance

**Delivered behavior:** README.md (`README.md:179-184`) now documents, under a "Per-role model tiers (recommendation, not a hard default)" heading, that `worker-light`/`style-scout` are fine on the cheapest tier, `worker` is the general default, `worker-heavy` should get the strongest/most expensive tier for architecture and cross-cutting work, and — the key addition — `reviewer`, `wave-flow-checker`, and `roadmap-milestone-checker` are judgment-heavy verifier roles that should be kept at least at `worker` tier, since an under-powered checker tends to produce a false PASS instead of a caught defect.

**Notable choices:**
- **The escalate-on-failure core hook (auto-bumping a checker's model tier after a missed defect) was deliberately deferred.** This wave shipped guidance-only prose; there's no runtime enforcement or config-driven tier escalation.
- No new behavior ships with R19 — it's a documentation change validated by a docs/config consistency test (`test/docs-config-sample.test.ts`, created by a sibling task in this same wave) rather than a new code path in core or the extension.

### R20 (core cap) — review-cycle cap with needs-user blocker

**Delivered behavior:**
- A new `orchestration.max_review_cycles` config key (`packages/core/src/project-init.ts`), default `2` (`DEFAULT_MAX_REVIEW_CYCLES`), validated as a positive integer and rejected with a specific error message (`orchestration.max_review_cycles must be a positive integer`) otherwise.
- `recordWaveReview` in `packages/core/src/wave-orchestration/review.ts` now counts failed-review cycles for the active wave and, once the count reaches the configured cap, refuses to enqueue another rework round. Instead it mints exactly one needs-user blocker (via the existing R1 blocker machinery, `created_by: 'orchestrator'`, title `Wave <id> review failed`) whose description carries the accumulated findings text from every cycle (not just the last one) plus a sentence naming the cap that was hit (`review-cycle cap of N`).
- The halt is surfaced in the review result's `next_actions` (pointing at `omr_list_blockers`), and the wave transitions to `blocked` status with the canonical blocker open.
- The `REVIEWER_REWORK_RULE` prose (`packages/extension/src/extension/commands/rule-text.ts:44-51`) was updated to state the cap in the reviewer/rework loop instructions (`...core caps this loop: after max_review_cycles failed reviews of the same wave (default 2), omr_record_wave_review stops enqueuing rework and auto-mints a needs-user blocker carrying the accumulated findings history from every cycle...`), and the `implementation-orchestrator` SKILL.md copy of the same rule was updated in lockstep.

**Notable choices:**
- The cap is **config-driven, not hardcoded** — `test/state/review-loop-cap.test.ts` exercises cap values of 1, 2 (default), and 3, confirming the threshold moves with `orchestration.max_review_cycles` rather than being baked into `review.ts`.
- The needs-user blocker reuses the **existing R1 blocker machinery** rather than introducing a new blocker type or halt mechanism — this keeps the halt path consistent with other needs-user blockers already surfaced elsewhere in the workflow.
- The blocker's findings history is **cumulative across all cycles**, not just the cycle that tripped the cap — a reviewer/user picking up the blocker sees the full arc of what was tried and flagged.
- The **dogfood soft-budget recommendation (using this cap in this very repo) is docs/sample-config only** — this repo's own live `.omr/config.yml` was intentionally left unchanged; the cap is available to any project that opts in via config, but this repo doesn't self-apply a non-default value.
- Drift between the `rule-text.ts` prose and the `implementation-orchestrator` SKILL.md copy is guarded by a dedicated test (see below) that would catch a future edit to one without the other.

### R22 (new tool) — `omr_task_briefing`

**Delivered behavior:**
- A new core module `packages/core/src/task-briefing.ts` exports `buildTaskBriefing(cwd, input)`, which takes `ownedPaths` and optional `dependencyPaths`, confines every requested path to the repo root via `fs.realpath` + prefix check (paths outside the root, missing, or not-a-file are reported in a `skipped` array with a reason rather than throwing), and returns a `TaskBriefing`: per-file `size_bytes`, a truncated head `excerpt` (UTF-8-safe truncation, no split multi-byte characters) with `excerpt_truncated`, a one-hop `import_edges` graph (relative-specifier imports/requires resolved in-repo; bare/external specifiers ignored), and a fixed `lsp_note` pointing callers at their own `xd://lsp` for symbol outlines/diagnostics.
- `response_format: "concise" | "detailed"` controls three caps simultaneously: excerpt byte cap (1024 vs 4096), file count cap (20 vs 60), and import-edge count cap (40 vs 120); anything beyond the cap is dropped and counted in `truncated_files`/`truncated_edges` rather than silently omitted.
- The tool is registered as `omr_task_briefing` in `packages/extension/src/tools/register/context-tools.ts` with `approval: 'read'` (never a write-gated tool) and a description telling callers to call it once at the start of a task instead of many exploratory reads.
- The `implementation-orchestrator` dispatch prompt (`packages/core/src/wave-orchestration/dispatch.ts:295`) gained a line instructing workers to call `omr_task_briefing` once with their owned files and dependencies before their first edit.

**Notable choices:**
- **Path confinement is realpath-based, not string-prefix-based** — symlink escapes are caught because the confinement check runs on the resolved real path, not the raw requested path.
- **Symbol outlines and diagnostics were explicitly punted** to the caller's own `xd://lsp` calls (`lsp_note`) rather than building an in-repo LSP client — there's no existing LSP integration in this repo to build on, and adding one was out of scope for this wave.
- Import-edge resolution only follows **relative specifiers** (`./`, `../`) through a fixed extension/index-file resolution list; bare package specifiers (e.g. `react`) are silently ignored rather than attempting node_modules resolution — this keeps the one-hop graph cheap and scoped to in-repo code the worker is likely to touch.
- The tool is **read-only** (`approval: 'read'`) — it never touches the write-gate, so it's safe to call speculatively/early without any task/wave dispatch bookkeeping.

---

## Key design decisions

**Confirmed design choices** (all deliberate, per specification):
- R17 guidance lives **in tool `description` strings**, not a separate reference doc — visible to the model exactly when it's about to call the tool.
- R19 is **guidance-only, in docs**, not enforced by any runtime hook or config validation this wave.
- R20's cap is **config-driven** (`orchestration.max_review_cycles`, default 2), validated as a positive integer, and read via `loadMergedConfig` at review time — not a hardcoded constant in `review.ts`.
- R20's halt **reuses the existing R1 blocker machinery** (`created_by: 'orchestrator'`, needs-user blocker, `next_actions` pointing at `omr_list_blockers`) rather than inventing a new halt/blocker type.
- R20's blocker description is **cumulative across all failed cycles**, not just the final one, so the user sees the whole rework arc.
- R20 prose is **duplicated deliberately** across `rule-text.ts` (`REVIEWER_REWORK_RULE`) and the `implementation-orchestrator` SKILL.md, with a drift-guard test enforcing the two stay in lockstep.
- R22's confinement is **realpath + inside-root check**, closing the symlink-escape class of bug rather than relying on string prefix matching.
- R22 is **read-only** (`approval: 'read'`) — no write-gate interaction, no dispatch/task bookkeeping required to call it.
- R22's caps (excerpt bytes, file count, edge count) are **format-tiered** (concise vs detailed), mirroring the render-cap idiom already used elsewhere in the repo (`repo-primer.ts`, `wave-orchestration/context-seeding.ts`).

**Deliberately NOT built** (scope-limited design):
- R17(a) — the xd:// transport JSON repair/tolerance pass. This is a transport-layer concern owned by upstream `@oh-my-pi/pi-coding-agent`, not something this repo's tool-description layer can implement.
- R19's escalate-on-failure hook — no runtime mechanism auto-escalates a checker's model tier after a missed defect; this wave is prose guidance only.
- R20's dogfooding of a non-default cap value in this repo's own live `.omr/config.yml` — the sample/docs recommend a soft budget, but this repo's actual config was intentionally left untouched.
- R22's symbol outlines/diagnostics — explicitly out of scope; callers are pointed at their own `xd://lsp` calls instead of an in-repo LSP client.
- R22's non-relative (bare/package) import resolution — the import graph only follows relative specifiers; no node_modules resolution was added.

---

## Validation signals now covered by tests

### test/tools/tool-docs.test.ts

**R17 signals:**
- `omr_transition description states phase preconditions for representative operations` — validates that `record_discovery requires phase discovery or roadmap_draft`, `start_milestone_planning requires phase roadmap_approved or complete`, `approve_roadmap requires phase roadmap_draft`, and `start_closeout requires phase reviewing` all appear in the tool's description text.
- `high-friction write tools document a canonical xd:// invocation example` — validates that `omr_transition`, `omr_init`, and `omr_update_roadmap` descriptions each contain a `write xd://<toolName>` invocation example.

### test/state/review-loop-cap.test.ts

**R20 signals:**
- `default cap (2): first failure reworks, the second mints a needs-user blocker carrying the findings history` — validates that at the default cap of 2, the first failed review enqueues rework (no blocker) and the second failed review mints exactly one needs-user blocker (`created_by: 'orchestrator'`, title `Wave w01 review failed`) whose description contains both cycles' findings text and the `review-cycle cap of 2` sentence, with the wave transitioning to `blocked`.
- `cap of 1 (from config): the very first failed review mints the needs-user blocker with no rework` — validates that a configured cap of 1 skips rework entirely and mints the blocker on the first failure.
- `cap of 3 (from config): the threshold moves — two rework rounds precede the cap on the third failure` — validates that a configured cap of 3 allows two rework rounds before the third failed review mints the blocker, with the description accumulating all three cycles' findings text.

### test/skill-rule-drift.test.ts

**R20 signals:**
- `reviewer rule states the R20 review-cycle cap and needs-user blocker` — validates that `REVIEWER_REWORK_RULE` contains `after max_review_cycles failed reviews of the same wave (default 2)` and `auto-mints a needs-user blocker carrying the accumulated findings history`, and that the `implementation-orchestrator` SKILL.md copy also contains the cap sentence (lockstep check).
- `the R20 cap drift guard detects a divergence` — validates that a mutated cap sentence (default 2 → default 5) no longer matches the SKILL.md copy, proving the drift guard would actually catch a real divergence.

### test/tools/task-briefing.test.ts

**R22 signals:**
- `registers as a read-only tool` — validates `omr_task_briefing` registers with `approval: 'read'`.
- `assembles sizes, excerpts, import edges, skips out-of-repo paths, and caps by response_format` — validates per-file `size_bytes` and truncated `excerpt`/`excerpt_truncated`, a resolved `import_edges` entry for a relative import (`src/a.ts` → `src/b.ts`), that both a relative-outside-root path (`../outside.ts`) and an absolute-outside-root path are recorded in `skipped` (and never leak into `files`), the presence of an `lsp_note` string mentioning `xd://lsp`, and that `response_format: "detailed"` yields a strictly longer excerpt than `"concise"` for the same file.

### test/docs-config-sample.test.ts (sibling task, R19)

**R19 signals:**
- `agents: sample role keys are a subset of the real ROLE_NAMES` — validates that every role key documented in README.md's illustrative `agents:` YAML config sample (the block that carries the per-role model-tier guidance) is a real, recognized role name from `ROLE_NAMES`, guarding against the doc's sample drifting from the actual role set the code accepts.

---

## Deferred / follow-ups

The following items remain deferred with rationale:

- **R17(a)** (xd:// transport JSON repair/tolerance pass) — lives in upstream `@oh-my-pi/pi-coding-agent`, which owns the transport itself; not implementable as an in-repo OMR change.
- **R19 escalate-on-failure hook** (auto-bump a checker's model tier after a missed defect) — deferred; this wave chose docs-guidance-only, leaving the runtime-enforcement variant for a future wave.
- **R22 symbol outlines / diagnostics** — punted to the worker's own `xd://lsp` calls; no in-repo LSP client exists to build a symbol-outline feature on.
- **F2** (rm-retro retrospective analytics) — a separate product module requiring an event ledger or equivalent; out of scope for this wave.
- **F3** (predictive cost estimates) — requires durable token-count history and a pricing engine; deferred as a separate feature.
- **F4** (persistent workers across waves) — cross-wave worker rehiring requires context-size guardrails and leasing discipline beyond this wave's scope.

---

## Test results

- **`bun run check`** — Exit code: **0** (no TypeScript errors)
- **`bun test`** — **605 pass**, 0 fail, 3037 expect() calls, across 63 test files (21.26s), including the sibling `test/docs-config-sample.test.ts` (R19 docs/config consistency check), which was present at run time.
