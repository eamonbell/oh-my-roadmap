# Wave 4 Implementation Summary

## Intro / result

Wave 4 implemented two improvements from RECOMMENDED-IMPROVEMENTS.md in a deliberately slimmed design: **R24** (wave diff package for reviewers) and **F1** (git wave checkpoints). R24 computes git-backed changed-file lists and per-file diffs on demand whenever the cwd is a git repo, independent of any flag; F1 enables optional wave checkpoints via project-local `orchestration.git_checkpoints` (default off), committing only a wave's owned paths on passed review via a temp index that honors hooks and signing, with idempotence via HEAD `OMR-Wave` trailer and skips-with-warning on unusable git. Both shipped cleanly: `bun run check` exits 0, `bun test` shows 595 pass / 0 fail across 59 test files.

---

## Per-recommendation: what changed & key decisions

### R24 — Wave diff package for reviewers

**Delivered behavior:** `prepareWaveReview` now returns a `wave_changes` field containing:
- `available` (boolean) — indicates whether git is usable in the cwd
- `start_head` (string | null) — the git ref at wave-start, used to compute the diff boundary
- `files` (array) — per-owned-file status/patches: each file carries `path`, `status` (added/modified/deleted/renamed), and for text files a unified `patch`; binary files are metadata-only (no patch or line counts)
- `warnings` (array) — informational issues (e.g., pre-existing uncommitted changes in owned paths)
- `additions` / `deletions` (number) — aggregate line counts, excluding binary files

**Notable choices:**
- Diffs are **independent of the `git_checkpoints` flag**. They're always computed on demand; checkpoints optionally *commit* the same diff boundary.
- The diff package is built from the **wave-start git boundary captured at dispatch time** (R24's primary data source), not from HEAD — this ensures the review diffs are scoped to changes made *during the wave*, even if the user commits other changes in parallel.
- Binary files are detected via git's own heuristics and exclude patch/line-count data, reducing package bloat for non-text waves.
- The package is on-demand: if git is unavailable, the field still exists but `available: false` and the reviewer can proceed without it (never blocking).

### F1 — Git wave checkpoints (opt-in via config)

**Delivered behavior:** After each **passed** wave review, if `orchestration.git_checkpoints: true` in `.omr/config.yml`:
1. The system commits the wave's changes using `git commit`, scoped to the wave's owned paths only, via a temp index that doesn't touch the user's real staging area.
2. The commit message is structured: subject line `omr(waveId): waveGoal`, trailers carrying workflow/roadmap/milestone/wave/task IDs (OMR-Wave, OMR-Roadmap, OMR-Milestone, OMR-Tasks, OMR-Workflow).
3. The commit honors installed **pre-commit hooks and GPG signing** (ordinary `git commit` path).
4. **Idempotence** is enforced via the HEAD commit's `OMR-Wave` trailer: a retry of the same wave ID returns the prior commit SHA without creating a second commit.
5. On **detached HEAD** or other git issues, the checkpoint is skipped with a warning (never blocks the wave from completing).
6. **Pre-existing dirty owned paths** (detected via wave-start boundary) trigger a warning in the checkpoint receipt but don't block.
7. The checkpoint result (status/commit SHA/warnings) is persisted in wave runtime as `wave.git.checkpoint`, independent of any plan schema.

**Notable choices:**
- **Opt-in only** (default off in config). The feature is discoverable but doesn't activate without explicit user configuration.
- **Owned-paths-only commit scope:** the system determines which files to stage from the diff boundary (R24), not from declared ownership alone — this allows a wave to legally touch files owned by non-concurrent waves without committing them.
- **Temp index isolation:** the user's real git index is untouched. Staged changes outside the wave stay staged; OMR changes are committed independently.
- **Current-branch-only:** checkpoints are created only on a real branch HEAD, not detached. This eliminates a class of state ambiguity at milestone/roadmap boundaries.
- **Skip-don't-block:** checkpoints never prevent wave completion. Detached HEAD, hook failures, and other issues record a skipped status with a warning, allowing the wave to advance.

---

## Key design decisions

**Confirmed design choices** (all deliberate, per specification):
- Project-local flag **default-off**: users opt into checkpoints explicitly via config; the system never auto-activates without clear user intent.
- Diffs **independent of checkpoint flag**: `wave_changes` is computed for every wave review in any git repo, checkbox or not.
- Skip+warn (never block) on **unusable git / detached HEAD**: ensures the workflow doesn't stall on edge cases; warnings surface the issue.
- **Wave-runtime-only record**: checkpoint state lives in `runtime.yml`, never in `plan.md`. Plans remain checkpoint-agnostic.
- **Ordinary `git commit` honoring hooks+signing via temp index**: no custom commit logic; respects the user's pre-commit hooks and GPG configuration.
- **Idempotence via HEAD `OMR-Wave` trailer**: a second `commitWaveCheckpoint` call with the same waveId detects the trailer on HEAD and returns the prior commit SHA.
- **Owned-paths-only commit scope**: files are staged from the actual diff (R24 wave-start boundary), not from declared task ownership.
- **Current-branch-only**: no per-milestone-branches variant (F1 addendum deferred); always commits to the current branch.

**Deliberately NOT built** (scope-limited design):
- Review tokens, fingerprints, retention refs: checkpoint idempotence is via git trailers, not cryptographic state.
- Checkpoint state machine: no explicit state transitions; a checkpoint is either created, skipped, or has no_changes.
- Concurrency arbitration: no locking or arbiter; users are responsible for avoiding concurrent waves.
- Event ledger / adhoc-events: no separate event stream; checkpoint outcomes surface in wave runtime and tool receipts.
- Caller migration (e.g., new `recordWaveCheckpoint` signature): the checkpoint is produced automatically as a side-effect of `recordWaveReview(passed)` — no new tool call or signature change.

---

## Validation signals now covered by tests

### git-engine.test.ts (resolveGitBoundary, captureWaveGitStart, buildWaveChanges, commitWaveCheckpoint)

**R24 signals:**
- `buildWaveChanges: reports added/modified/deleted/renamed scoped to owned pathspecs with text patches` — validates that diffs are scoped to owned paths and text files include patches.
- `buildWaveChanges: binary files are metadata-only: no patch and no line counts` — validates binary file detection and metadata-only output.
- `buildWaveChanges: unavailable git returns available:false with a warning` — validates graceful degradation when git is unavailable.
- `buildWaveChanges: unborn repo diffs new files against the empty tree` — validates diff correctness in unborn (no-commit) repos.

**F1 signals:**
- `resolveGitBoundary: fresh repo with a commit reports available, non-detached, real head` — validates git boundary detection in normal state.
- `resolveGitBoundary: detached HEAD is reported as detached` — validates detached HEAD detection (reason for skip-with-warning).
- `commitWaveCheckpoint: creates a checkpoint scoped to owned pathspecs` — validates commit creation, trailers, and ownership scoping.
- `commitWaveCheckpoint: leaves the user real index untouched (temp index isolation)` — validates temp index isolation.
- `commitWaveCheckpoint: honors an installed pre-commit hook (failing hook aborts the commit)` — validates hook execution.
- `commitWaveCheckpoint: honors a passing pre-commit hook` — validates hook compliance.
- `commitWaveCheckpoint: unborn repo produces a root commit` — validates first-time (unborn repo) checkpoint.
- `commitWaveCheckpoint: no owned changes returns no_changes without committing` — validates no-op case.
- `commitWaveCheckpoint: is idempotent for the same waveId (no second commit, same sha)` — validates idempotence via trailer detection.
- `commitWaveCheckpoint: warns when a predirty owned path is swept into the checkpoint` — validates pre-existing dirty path detection.
- `commitWaveCheckpoint: skips on detached HEAD` — validates detached HEAD skip-with-warning.

### wave-git-runtime.test.ts (WaveGitState round-trip)

**R24/F1 signals:**
- `WaveGitState runtime round trip (roadmap milestone): git start + checkpoint survive a runtime write -> read and never leak into plan.md data` — validates runtime persistence and plan isolation.
- `change request runtime preserves git and strips it from plan definition` — validates git field survives runtime writes and doesn't leak into plan definition.

### wave-git-dispatch.test.ts (wave dispatch git start boundary capture)

**R24/F1 signals:**
- `fresh dispatch in a git repo captures wave.git.start exactly once` — validates wave-start boundary captured at dispatch time.
- `wave_git.checkpoints_enabled reflects the project config` — validates config-flag reflection in dispatch receipt.
- `active-runs short-circuit does not re-capture the start boundary even if HEAD moved` — validates capture idempotence (happens once per wave).
- `dispatch in a non-git cwd still succeeds and persists no wave.git` — validates graceful no-git case (no runtime field persisted).

### wave-checkpoint-lifecycle.test.ts (wave checkpoint lifecycle)

**F1 signals:**
- `checkpoints OFF: passed review completes the wave without a commit` — validates baseline (no commit when flag is off).
- `checkpoints ON: passed review with owned changes creates exactly one owned-only commit` — validates commit creation and owned-path scoping.
- `prepareWaveReview surfaces owned-path diffs as wave_changes (independent of the flag)` — validates R24 (diffs available regardless of checkpoint flag).
- `checkpoints ON but detached HEAD: skipped with a warning, wave still completes` — validates detached HEAD skip-with-warning (never blocks).
- `failing pre-commit hook: recordWaveReview(passed) throws and leaves the wave reviewing` — validates hook failure behavior (wave stays in reviewing state).
- `idempotent retry: re-committing the same wave makes no second commit` — validates idempotence via trailer.
- `collision warning: an owned path dirty before dispatch is flagged when committed` — validates pre-dirty warning in checkpoint.
- `no_changes: passed review with no owned-file changes records no_changes and no commit` — validates no-changes status.

### wave-checkpoint-tools.test.ts (omr_record_wave_review checkpoint receipt)

**R24/F1 signals:**
- `checkpoints ON with owned-file changes: receipt reports a created commit and payload carries the sha` — validates receipt-layer reporting of created commit.
- `checkpoints ON with no owned-file changes: receipt reports no_changes` — validates no_changes receipt text.
- `checkpoints ON but unusable git (detached HEAD): receipt reports skipped and the wave still completes` — validates skip receipt and wave completion.
- `checkpoints DISABLED: passed receipt is unchanged and payload carries no checkpoint field` — validates baseline receipt when flag is off.
- `omr_record_wave_review's input schema does not accept a reviewToken/review_token field` — validates no review-token surface (deliberately excluded from F1).

### project-init.test.ts (git_checkpoints config flag)

**F1 signals:**
- `loadProjectGitCheckpoints returns false when project config is absent` — validates default-off behavior (absent → false).
- `loadProjectGitCheckpoints returns false when git_checkpoints is explicitly false` — validates explicit opt-in requirement.
- `loadProjectGitCheckpoints returns true when git_checkpoints is explicitly true` — validates config-driven enable.
- `loadProjectGitCheckpoints returns false on any read/parse error` — validates safe fallback on config error (never throws).
- `project git_checkpoints is not affected by global config` — validates project-local scope (no global config leakage).
- `ensureConfig preserves git_checkpoints: true on re-init` — validates config persistence on re-initialization.
- `ensureConfig defaults git_checkpoints to false when absent` — validates default-off scaffolding.
- `rejects non-boolean git_checkpoints with exact error message` — validates config schema validation.
- `still rejects unknown orchestration keys` — validates config validation doesn't regress.
- `default config scaffolds git_checkpoints: false` — validates new-config baseline (opt-in default off).

---

## Deferred / follow-ups

The following items from RECOMMENDED-IMPROVEMENTS.md remain deferred with rationale:

- **R17** (xd:// transport hardening — orthogonal) — JSON tolerance and invocation examples are valuable for weaker models, but independent of R24/F1; no test harness requires them for the core feature.
- **R19** (per-role model tiering — pairs with R20) — documentation and future escalation hooks benefit from a unified rework-loop cap (R20) to justify stronger reviewer models.
- **R20** (rework-loop cap + budget dogfooding — wants durable rework-attempt history) — pairs naturally with execution budgets; deferred for joint implementation with budget persistence.
- **R22** (omr_task_briefing — separate LSP/parser contract) — one-call context pack requires separate specification of LSP symbol output; currently achieved via scoped tool calls in dispatch (good-enough).
- **F2** (retro analytics — separate product) — requires event ledger or equivalent; deferred as a distinct product module (`omr:rm-retro`).
- **F3** (predictive cost — pricing/history product) — requires durable token-count history and pricing engine; deferred as a separate product feature.
- **F4** (persistent workers across waves — hub/context policy) — cross-wave worker rehiring requires context-size guardrails and leasing discipline; deferred pending R12 refinement.
- **F1 per-milestone-branches option** (deliberately not implemented) — maintaining independent branches per milestone complicates current-branch-only scoping and adds little value; current-branch checkpoints are sufficient.

---

## Test results

- **`bun run check`** — Exit code: **0** (no TypeScript errors)
- **`bun test`** — **595 pass**, 0 fail, across 59 test files (21.28s)
