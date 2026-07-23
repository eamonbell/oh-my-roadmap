# RECOMMENDED-IMPROVEMENTS — oh-my-roadmap (execution-budgets roadmap evaluation)

Evaluation of the full real-world run of oh-my-roadmap (OMR) on the "Execution budgets & cost
governance" feature request (`roadmap-request-execution-budgets.md`), from the eight exported
session bundles in `usage-transcripts/execution-budgets/`, the persisted roadmap artifacts in
`.omr/execution-budgets/`, the OMR source in `packages/`, and current published best practices
for agent orchestration (sources cited inline where they informed a recommendation).

---

## 1. Executive summary

**Overall: the workflow contract held.** Across 8 sessions / 33 transcripts / ~$36.07 / 935
requests, every approval was correctly gated (checker pass → record → validate → explicit user
approval, never inverted), the orchestrator never edited code, workers never asked the user,
worker roles always matched the plan, hub coordination used single blocking waits with zero
polling loops, dispatch/lease records were complete, closeout evidence was traceable
per-criterion, and exactly one findings report was submitted per run at the correct terminal
point. Recovery from a hard mid-wave user interrupt cost only ~$0.17 and produced a clean
`abandoned → replacesAgentId` audit chain with core-enforced double-dispatch prevention.

**The two dominant defect clusters are both self-inflicted by design choices, not model
misbehavior:**

1. **The review/rework loop is the single largest source of waste and state corruption.** The
   blanket worker test ban caused essentially *every* review failure in the roadmap (5 of 6 wave
   reviews that failed did so on defects the worker's own task-scoped verification command would
   have caught pre-yield), and each failure then fell into blocker machinery that auto-mints
   canonical blockers from review notes — including one Catch-22 where the blocker gate-blocked
   the very rework edit that fixed it, was deferred *by the worker* with a falsified
   `deferred_by: user` audit field, and is now permanently stuck in `deferred` because no
   un-defer/reopen path exists.

2. **Reviewer re-dispatch is asymmetric by omission.** Workers have a full lease state machine
   and explicit "prefer waking the existing worker" prose; reviewers have neither — the prompt
   says only "re-dispatch reviewer," no reviewer identity is persisted anywhere, and
   `omr_prepare_wave_review` returns no reuse hint. glm-5.2 read this literally and spawned
   fresh reviewers (the `Wave1ReviewerRework`/`Wave2ReviewerRework` dirs you observed);
   gpt-5.6 complied with the *spirit* only, and in milestone 2 the correct wake-the-reviewer
   behavior happened only after an explicit user interjection.

Both of the user's pre-stated hypotheses are **supported by the evidence**: milestones 1–2 were
too small to justify standalone plan+implement cycles (12 tasks / 7 waves across three
milestones), and worker-run targeted tests would have prevented most rework round-trips.

---

## 2. Sample reviewed

| Bundle                            | Command           | Primary model      | Msgs | Errors | Cost (primary)               |
|-----------------------------------|-------------------|--------------------|------|--------|------------------------------|
| new-roadmap                       | /omr:rm-new       | zai/glm-5.2        | 110  | 2      | $1.13                        |
| plan-milestone-1                  | /omr:ms-plan      | zai/glm-5.2        | 81   | 3      | $1.00                        |
| implement-milestone-1             | /omr:ms-implement | zai/glm-5.2        | 104  | 2      | $1.22 (+7 sub-agents ≈ $3.2) |
| plan-milestone-2                  | /omr:ms-plan      | zai/glm-5.2        | 69   | 2      | $0.84                        |
| implement-milestone-2-abandoned   | /omr:ms-implement | zai/glm-5.2        | 24   | 1      | $0.16 (user interrupt)       |
| implement-milestone-2-resumed     | /omr:rm-resume    | zai/glm-5.2        | 125  | 4      | $1.55 (+5 sub-agents ≈ $7.2) |
| plan-milestone-3                  | /omr:ms-plan      | openai/gpt-5.6-sol | 105  | 0      | $3.16                        |
| implement-milestone-3 (+ms-close) | /omr:ms-implement | openai/gpt-5.6-sol | 182  | 3      | $4.93 (+8 sub-agents ≈ $8.0) |

Roadmap rollup (`.omr/execution-budgets/usage.yml`): **$36.07 total, 935 requests, ~75M tokens**
(dominated by cache reads). By phase: roadmap planning $1.36, milestone planning $5.02,
implementation $27.37, closeout $2.13. By milestone: ms-budget-model $5.36, ms-enforcement
$10.07, ms-operator-surface $17.63.

Limits: one roadmap, one feature, two model families, n=1 per workflow type. Findings marked
high-confidence are backed by direct transcript quotes; medium/low are flagged.

---

## 3. Observed strengths (preserve these)

- **Approval gating worked 8/8 sessions.** No approval ever preceded a passed checker + clean
  validate + explicit `ask`. The one time validation fired pre-checker (plan-1, n56) it caught a
  real plan defect. The strict-gate design is earning its keep.
- **Checker agents are not rubber stamps.** The `roadmap-milestone-checker` independently
  verified 7 of the roadmap's evidence citations against real source with line-ranged reads
  (checker n23–34) — a genuine hallucination gate. Wave-flow checkers produced substantive
  structured findings in all four planning sessions; plan-3's checker verified a mid-planning
  amendment was actually reflected in the plan.
- **Resumability is genuinely robust** (implement-milestone-2): persisted lease state survived a
  hard interrupt; `prepare_wave_dispatch` returned `assignments: []` while the orphaned run was
  live (core-enforced double-dispatch prevention); `record_worker_abandoned` +
  `replacesAgentId` produced a clean audit chain; no usage double-counting.
- **Hub discipline:** across all implementation sessions, single blocking `op:wait` calls with
  real ids and timeouts; zero `op:jobs` polling loops.
- **Worker rework via hub wake worked exactly as designed** every time it was attempted:
  `op:list` → liveness → `op:send` with narrow, surgical instructions (exact file/symbol,
  MUST-NOT-CHANGE list) → woken worker fixed and noted.
- **Context discipline improved over the run and the compact tools work when used:** the
  gpt-5.6 orchestrator (implement-3) made *zero* direct `.omr` artifact reads, used scoped
  `omr_read_state` throughout, and used `search_context` in count → ids → read_context order.
  plan-2's checker completed a full review from essentially one scoped `read_state` call.
- **Error receipts frequently drove one-step self-recovery** (wave-advance corrective payload,
  closeout phase guidance, append_note schema echo). Where recovery was *not* one-step, the
  receipt text is the culprit — see R8/R12/R14.
- **Closeout rigor:** per-criterion evidence citing which wave review proved each item,
  deferrals with reasons and user approval, `worker_notes_reviewed: true`, single terminal
  findings report.
- **The `omr_amend` flow** (plan-3): a material mid-planning scope change was captured as a
  user-approved roadmap amendment and independently verified by the checker.

---

## 4. Recommendations

Ordered by impact. Each lists: evidence, owning surface, the concrete change, expected behavior
after, a validation signal for future transcripts, and impact/complexity/confidence.

### TIER 1 — Highest impact

---

#### R1. Overhaul the review-findings → blocker pipeline (state-integrity defect cluster)

**Impact: Critical · Complexity: Medium-High · Confidence: High**

This is four connected core defects observed end-to-end in real runs:

1. **Blocking review notes silently auto-mint canonical blockers.** `appendNoteImpl` creates a
   blocker for any `blocking: true` note (`packages/core/src/store/blockers.ts:217`). In
   implement-2, the reviewer's FAIL note created `blk_2d2fe190` while the orchestrator's own
   thinking explicitly (and wrongly) concluded *"I correctly did not open a canonical blocker
   for the worker-fixable finding"* (resumed primary n57). The skill says worker-fixable
   findings must NOT open blockers; core opens one anyway. Prompt and core directly contradict
   each other.
2. **`record_wave_review(failed)` converts every finding into an open blocker — including PASS
   findings.** In implement-3 wave-3, recording a failed review with mixed findings produced
   **6 open blockers, 4 of them from findings that said things like "bun run check passed."**
   (primary n113–n126, L188–L214). Cleanup cost 8+ tool calls (4 resolves of PASS-blockers,
   2 defers, 1 amend) and directly caused the R8 turn-stall.
3. **The blocker gate blocks the blocker's own fix (Catch-22).** In implement-2, the worker's
   rework edit was rejected: *"Open blocking blocker must be resolved or deferred: wave-1
   review: FAIL…"* (`packages/core/src/validation.ts:282`; EnforcementEval n82–83). The worker
   escaped by **deferring the blocker itself** — a lifecycle decision reserved for the
   user/primary — and core defaulted the actor: `deferred_by: user`
   (`packages/core/src/store/blockers.ts:139` — `input.deferredBy?.trim() || 'user'`). The
   audit trail now falsely says the user deferred it.
4. **Deferred blockers can never be resolved.** After the fix passed review 21/21, the primary
   tried `omr_resolve_blocker` → `"Blocker is not open"` (resumed primary n120–121). There is
   no un-defer/reopen operation. `blk_2d2fe190` sits permanently `deferred` in
   `.omr/execution-budgets/blockers.yml` even though the defect is verifiably fixed, and the
   primary's high-quality resolution evidence was discarded.

**Owning surfaces:** `packages/core/src/store/blockers.ts` (auto-mint at :217, actor default at
:139), `packages/core/src/wave-orchestration/review.ts` (`recordWaveReview` →
`reviewBlockingFindings`), `packages/core/src/validation.ts:282` (gate condition),
`resolveBlockerImpl` (open-only precondition).

**Proposed change (as a coherent redesign):**

- Introduce a **finding severity model** on review recording: `pass | advisory |
  blocking_worker_fixable | blocking_needs_user`. Only `blocking_needs_user` materializes a
  canonical blocker. `blocking_worker_fixable` findings become a structured **rework queue**
  on the wave (persisted in runtime.yml, visible in `next_actions` as "wake worker X for
  rework on task Y"), not blockers. The reviewer template already emits exactly these labels
  (`packages/core/agent-templates/reviewer/AGENT.md:36-40`) — core just needs to consume them
  instead of flattening everything into blockers.
- Blocking **notes** from sub-agents should *propose* a blocker (surfaced to the orchestrator
  in the note receipt / next_actions), not silently create one. Alternatively keep auto-create
  but only for `needs-user-decision` labeled notes.
- The write gate must **exempt rework edits on the task the finding names** while a
  worker-fixable rework is in flight (the rework-lease record from R12 gives it the signal),
  so a review finding can never block its own fix.
- `omr_resolve_blocker` should accept `deferred` blockers (fixed-after-defer is the *normal*
  path for worker-fixable findings), or add a `reopen` operation.
- Require an explicit `deferredBy`/`resolvedBy` actor; never default to `'user'`. Reject or
  attribute to the calling agent's id.

**Expected behavior after:** a failed wave review yields zero canonical blockers unless the
reviewer flagged a genuine user decision; rework proceeds without gate collisions; blocker
records reflect who actually acted; a fixed-after-defer blocker can be closed with evidence.

**Validation signal:** future transcripts show `blocker.opened` events only for
needs-user-decision findings; zero gate rejections during authorized rework; zero
"Blocker is not open" errors at closeout. (This roadmap produced 9 blockers, of which ~7 were
review-failure noise; the target is those 7 → 0.)

---

#### R2. Give reviewers the same wake-don't-respawn machinery workers have (the user-observed defect) ✅ Implemented (Wave 1)

**Impact: High · Complexity: Medium · Confidence: High**

**Evidence.** In implement-1 (glm-5.2), after each failed review the orchestrator correctly
woke the original *worker* via `op:send`, then spawned a **brand-new reviewer**
(`Wave1ReviewerRework` at primary n43/L75, `Wave2ReviewerRework` at n77/L127) while `op:list`
moments earlier showed the original reviewers idle/parked with the runtime even noting "Parked
agents are revived automatically when you message them." The orchestrator's thinking at L69
quotes its instruction verbatim: *"…wait for its rework note; **then re-dispatch reviewer** and
repeat until the wave is clean."* In implement-2, the same-reviewer wake happened **only after
the user interjected** ("send updated review instructions to WaveReviewer instead of spawning a
new reviewer", resumed primary n50); the primary then narrates "per the user's preference."
In implement-3 (gpt-5.6), the orchestrator did wake the same reviewer over hub (L156;
WaveTwoReview transcript #39–51 shows the second review pass in-session).

**Root cause (source-confirmed).** Asymmetry by omission across every surface:

- Prompt/skill text: "prefer waking the existing worker over spawning a replacement" with the
  full `op:list`/`op:send` procedure exists for workers
  (`packages/extension/src/extension/commands/prompts.ts:36-41`,
  `packages/extension/skills/implementation-orchestrator/SKILL.md:11-13`), but the reviewer
  instruction is just "re-dispatch reviewer" (`prompts.ts:55`, `SKILL.md:93-96`).
- State: `WorkerRun` leases track `agent_id`/`job_id`/`replaces_agent_id`
  (`packages/core/src/wave-orchestration/worker-runs.ts:98-121`); **nothing records which agent
  reviewed a wave**. `PrepareWaveReviewResult`
  (`packages/core/src/wave-orchestration/types.ts:116-134`) has no reviewer identity field.
- Tools: `omr_prepare_wave_review` is called once per wave (before the *first* review, never
  before re-review — both re-review prompts in implement-1 were hand-composed), and no
  `omr_prepare_reviewer_redispatch` counterpart exists
  (`packages/extension/src/tools/register/wave-tools.ts:152-166`).

**Cost.** Each fresh reviewer re-established context from scratch (Wave1ReviewerRework re-read
the same source and test files Wave1Reviewer had already read): ~$0.20/620K tokens across
implement-1's two waves, plus a split review audit trail — and it scales linearly with rework
rounds.

**Proposed change:**

1. **Prompt/skill (smallest fix, do first):** in `prompts.ts:55` and `SKILL.md:93-96`, mirror
   the worker rule: *"then `op:list` and, if the original reviewer is still a peer (parked
   agents revive automatically), `op:send` it the rework note reference and ask it to re-run
   verification against its prior findings; spawn a fresh reviewer only if it is no longer
   listed."*
2. **State/receipt (durable fix):** record a reviewer run when the review is dispatched (either
   extend `worker_runs` with a `role: reviewer` entry or add `reviewer_runs`), and make
   `omr_prepare_wave_review` return `re_review: true` + `prior_reviewer_agent_id` + prior
   findings when a failed review exists for the wave — so re-review goes through the tool
   (getting a consistent prompt) instead of being hand-composed.
3. Keep a **fresh-eyes escape hatch**: current published guidance is genuinely split here —
   Anthropic's Claude Code guidance favors fresh-context reviewers for unbiased review, while
   continuity avoids re-litigating settled findings and re-reading the whole wave
   ([code.claude.com/docs/en/best-practices](https://code.claude.com/docs/en/best-practices),
   [claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)).
   The defensible hybrid for OMR: **same reviewer for fix-verification of its own flagged
   findings; fresh reviewer if the rework materially expanded scope** (new files touched beyond
   the findings) — the tool receipt can say which applies since it knows the rework diff scope.

**Validation signal:** no more `*ReviewerRework` sibling directories in exported bundles; the
re-review appears as a continuation inside the original reviewer's transcript; re-review
context cost drops to roughly the cost of re-running the verification commands.

---

#### R3. Replace the blanket worker test ban with scoped self-verification + evidence handoff (the user's hypothesis — strongly supported)

**Impact: High · Complexity: Medium · Confidence: High**

**Evidence.** Workers ran zero tests/builds in all three implementation milestones (this is
compliance, not laziness — the rule is categorical in
`packages/core/agent-templates/worker{,-light,-heavy}/AGENT.md:45-47`, the dispatch prompt
builder `packages/core/src/wave-orchestration/dispatch.ts:81-85` (`WORKER_VERIFICATION_GUIDANCE`),
and `prompts.ts:213`: *"confirm your own work by reading code, not by running it"*). The
consequences, per milestone:

- **implement-1 wave-2** (single-worker wave — the "concurrent sibling" rationale was vacuous):
  3 blocking defects, all machine-catchable — a TS2375 compile error under
  `exactOptionalPropertyTypes`, a call to a **never-defined function** (`persistence.ts:563` →
  `writeMilestoneBudgetStateImpl`), and a failing round-trip test *in the worker's own new test
  file*. `bun run check` + `bun test test/budget.test.ts` catch all three. The worker's
  pre-yield thinking even reasoned about YAML `undefined` handling correctly at runtime while
  being blind to the type error — because reading was its only permitted check
  (WorkerBudgetModel L220).
- **implement-2**: both wave reviews failed on exactly what the task's own plan-listed
  verification command would have caught (wave-1: `bun test test/enforcement.test.ts` → 7/21
  failing, again a **single-task wave**; wave-2: a test-setup bug in the worker's own owned
  `test/budget-enforcement.test.ts`). The worker made three preemptive by-inspection test fixes
  and still missed one.
- **implement-3**: the milestone's only rework was a trivial assertion-string mismatch in
  `test/budget-commands.test.ts:103` — caught by the task's own listed
  `bun test test/budget-commands.test.ts` — and the rework instruction *re-imposed* the ban
  ("Do not run builds/tests; the reviewer will rerun…"), forcing a blind one-line fix plus a
  full reviewer round-trip to confirm it.

Aggregate avoidable cost across the roadmap: roughly **$2–3 and 40+ minutes** of
reviewer-fail → wake-worker → re-review cycles, plus the entire R1 blocker cascade in
implement-2, which only triggered because a review failed at all. Positive control:
WorkerElapsedTime ran `xd://lsp` diagnostics before yield (its #21) and shipped clean.

This also matches current published guidance: give every implementing agent a check it can run
and require iteration until pass before handoff, with evidence ("receipts, not 'done'") —
[code.claude.com/docs/en/best-practices](https://code.claude.com/docs/en/best-practices).

**Proposed change** (owning surfaces: worker templates + `dispatch.ts` prompt builder — the
builder knows wave topology, so the permission can be computed per dispatch):

1. **Mandatory, always:** run LSP diagnostics (`xd://lsp`) on every touched file before yield.
   Zero sibling risk; would alone have caught implement-1's TS2375/TS2552.
2. **Conditional targeted tests:** permit running exactly the task's own `verification_commands`
   restricted to the worker's owned test files when **any** of: (a) the wave has a single
   worker; (b) the dispatch manifest shows no ownership/interface dependence on incomplete
   siblings (disjoint files and no cross-imports — the planner already declares ownership);
   (c) the worker is executing a **rework** instruction (siblings are complete by definition —
   review already ran). Keep the ban on full-suite `bun test`, whole-project builds, and any
   command touching unowned files while siblings run.
3. **Evidence handoff:** require the worker note (`omr_append_note`) to state which commands ran
   and their results; have `prepareWaveReview` include those results in the reviewer package so
   the reviewer *verifies rather than re-discovers* — it re-runs the milestone-level commands
   once, not each worker's scoped suite from scratch. Guard against early-victory claims by
   requiring exact command + exit status + failure counts in the note.

**Expected behavior after:** first-pass review success becomes the norm; review becomes
integration verification instead of the first compile of the wave.

**Validation signal:** wave-review first-pass rate (this roadmap: 3 of 7 waves passed first
review) rises toward 100%; rework hub-sends per milestone drop toward 0; worker notes contain
command receipts.

---

#### R4. Record a verification baseline at implementation start; reviewers diff against it

**Impact: High · Complexity: Medium · Confidence: High**

**Evidence.** Three pre-existing failures (`styleGuideForFiles` global Go guidance,
`initScoped`/`resolvePluginRoot` under `.omp/profiles/omr` — likely environment contamination
from running under an OMP session, consistent with this project's own verify-constraints
memory) were re-discovered and re-litigated **in every full-suite review across the roadmap**:
implement-1's reviewers manually established HEAD baselines (Wave1Reviewer) and even stashed
wave changes to prove failures pre-existed (Wave2Reviewer); implement-2's closeout surfaced
them as carry-forward risk; implement-3 ran the full suite three times, judged the same 3
failures non-blocking in wave-1, repeated them in wave-2's blocker text, then **escalated them
to a terminal user decision in wave-3** (an `ask`, an `omr_amend` verification deferral, and 2
deferred blockers — `blk_b67e2eb1`, `blk_daef0d67` in `blockers.yml`) because that wave's exit
criteria demanded full-suite pass.

**Proposed change:**

- On `start_implementation`, run (or have the first reviewer run once) the plan's verification
  commands and persist a **baseline snapshot** (failing test names + counts) in the milestone
  runtime.
- Reviewer template (`packages/core/agent-templates/reviewer/AGENT.md`) + reviewer package:
  verdicts are **relative to baseline** — "no new failures, no lost passes" — with pre-existing
  failures listed as informational, not blocking. The clever-but-expensive stash/HEAD-compare
  behavior implement-1's reviewers invented becomes unnecessary.
- Planner skill: milestone acceptance phrased as "existing tests remain green" should compile to
  "no regressions vs baseline," and absolute full-suite-green claims belong to closeout with an
  explicit disposition step for baseline failures.

**Validation signal:** zero blockers/asks caused by failures that predate the milestone; each
pre-existing failure appears exactly once (in the baseline record) per milestone rather than
once per wave review.

---

#### R5. Add milestone-count parsimony to roadmap planning (the user's sizing hypothesis — supported) ✅ Implemented (Wave 1)

**Impact: High · Complexity: Low · Confidence: Medium-High**

**Evidence.** The roadmap produced 3 milestones holding **12 tasks / 7 waves total**
(ms-budget-model 3 tasks/2 waves — one wave being a single task; ms-enforcement 4/2;
ms-operator-surface 5/3). Each milestone cost a standalone planning session ($0.64–$2.26 + a
checker) plus a full implementation session's fixed overhead (skill load, orientation,
dispatch ceremony, review, closeout ≈ $1–5 of orchestrator spend each). ms-enforcement's
planning session spent much of its scouting re-reading files ms-budget-model had just
planned/delivered (budget.ts, gate.ts, dispatch.ts, context.ts), and its wave-1 depended
*only* on ms-budget-model deliverables — a merged "budget model + enforcement" milestone of
~7 tasks / 4 waves would have been a normal-sized plan and saved one full plan+implement cycle
(~$3–5 and roughly an hour). The roadmap-time deliberation shows why: the planner explicitly
weighed 2 vs 3 vs 4 milestones (new-roadmap thinking L102/L105) but the only sizing rule in the
stack is the *lower*-bound rule (`packages/extension/skills/roadmap-planner/SKILL.md:34-35`,
"fold single small edits into another milestone"), and the `roadmap-milestone-checker` template
(`packages/core/agent-templates/roadmap-milestone-checker/AGENT.md:12-16`) checks "too narrow"
but has **no fragmentation/parsimony check at all** — its own advisory findings even flagged
the enforcement↔operator-surface seam as scope-splitting, and nobody acted on it.
ms-operator-surface, by contrast, was defensibly standalone (3 interview rounds, a material
mid-planning amendment, genuinely open decisions).

This matches published guidance that multi-agent/multi-phase orchestration carries a large
fixed token overhead and should only be split where phases are genuinely independent
([anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system)).

**Proposed change:**

- `roadmap-planner/SKILL.md`: add a parsimony rule symmetric to the existing anti-narrow rule:
  *"Prefer the smallest number of milestones that keeps each one independently plannable and
  reviewable. Every milestone costs a full planning session and a full implementation run;
  a milestone likely to yield fewer than ~3 waves or ~5 tasks, or whose boundary would force
  the next milestone to re-discover the same subsystems, should be merged with its neighbor.
  A single milestone is a legitimate roadmap shape."* Include the expected-waves/tasks estimate
  per milestone in the roadmap outline so the checker can evaluate it.
- `roadmap-milestone-checker/AGENT.md`: add the symmetric check — flag likely-undersized
  milestones and seam-heavy adjacent pairs (scope items that cross-reference each other's
  deferred UX) as merge candidates, mirroring the existing "too narrow" question.
- Optionally, `/omr:ms-plan` could act as a late safety net: if the drafted plan comes out at
  ≤2 waves / ≤3 tasks, prompt the planner to surface "this milestone is small enough to merge
  with the next — propose an amendment?" to the user before approval.

**Validation signal:** future roadmaps for comparable feature sizes produce fewer, larger
milestones; per-milestone plans average ≥3 waves; total plan-session count per roadmap drops.

---

### TIER 2 — Protocol friction: receipts, next-actions, and tool contracts

These are all cheap fixes with reproducible evidence. Individually small; together they account
for most of the "wasted call + recovery turn" tax and one full run stall.

---

#### R6. Fix the wave-boundary two-step trap (100% reproducible, both models) ✅ Implemented (Wave 1)

**Impact: Medium · Complexity: Low · Confidence: High**

Every single wave boundary in the roadmap hit the same error: after
`omr_record_wave_review(passed)`, calling `omr_prepare_wave_dispatch` fails with *"Active wave
wave-N is already complete"* (implement-1 primary #52/L88; implement-3 n50/L91 — identical
string, different models). The error text's corrective payload enabled one-step recovery, but
it's a guaranteed 2-call tax per wave. **Fix in core:** either have `recordWaveReview(passed)`
auto-advance the active wave pointer when a next wave exists, or put the exact
advance-transition payload in the `record_wave_review` receipt's next-action (it already says
"Advance to next wave" — it just omits the payload the error message includes).
Owning surface: `packages/core/src/wave-orchestration/review.ts` (`passedWaveNextActions`) or
the transition receipt in `report/next-action.ts`. **Signal:** zero "already complete" errors.

#### R7. Reconcile `omr_prepare_worker_redispatch` with the abandonment path ✅ Implemented (Wave 1)

**Impact: Medium · Complexity: Low · Confidence: High**

On resume, the skill steers abandoned runs to `prepare_worker_redispatch` with continuation
context, but the tool only accepts `transport_failed` runs and refused: *"no transport_failed
worker run to redispatch"* (implement-2 resumed n15–16). The agent had to fall back to
`prepare_wave_dispatch` (which worked and carried `replacesAgentId`). Either accept
`abandoned` runs in `prepareWorkerRedispatch` (`packages/core/src/wave-orchestration/dispatch.ts:287+`)
or fix the skill text and the error message to say "after `record_worker_abandoned`, call
`omr_prepare_wave_dispatch`". Related: the skill's "inspect `history://<agentId>`" guidance is
**unfollowable across sessions** ("Unknown agent", n20–21) — note in the skill that
`history://` is session-scoped and that persisted worker notes are the cross-session memory.

#### R8. Make `omr_next_action` phase-aware and never stale (two observed stalls/detours)

**Impact: Medium-High · Complexity: Medium · Confidence: High**

Two distinct failures:

- **new-roadmap:** `omr_init` accepted a `discovery: {recorded: true, findings: […]}` payload
  but did not record discovery; `record_roadmap_milestone_check` then failed ("requires phase
  roadmap_draft; current phase is discovery"), and `omr_next_action` answered *"Resolve
  validation errors: Roadmap milestone check is pending"* — recommending the exact action just
  rejected as illegal. The agent called it a "chicken-and-egg problem" and guessed
  `record_discovery`, re-sending the same payload verbatim (~$0.15–0.20 of recovery turns,
  primary n86–96). Fix both ends: `omr_init` should either apply the supplied discovery or
  reject the field loudly; next-action computation should recommend `record_discovery` when
  phase=discovery with a finalized draft.
- **implement-3 wave-3:** after the user-approved deferrals, `prepare_wave_review` still said
  "Active wave wave-3 is blocked", `omr_next_action` returned a stale "Resolve blocker: …" for
  an already-disposed blocker, and the primary emitted an **empty assistant message and ended
  the turn** — the run stalled until the user nudged it (n127–n132, L214–L229). The recovery
  (`update_wave_status: complete`) was never hinted anywhere. Fix: blocker resolve/defer
  receipts and next_actions must state how to unblock the wave ("all blocking findings
  disposed — set wave status via omr_transition update_wave_status, or prepare re-review").

Owning surfaces: `packages/core/src/report/next-action.ts` (the `resolving_blockers` case at
:322-329 carries only the stale `blocked_reason` text), `omr_init` registration, defer/resolve
receipts. **Signal:** zero next_action recommendations that are illegal in the current phase;
zero turn-ending stalls awaiting input the workflow already collected.

#### R9. Fix the self-overlap false positive in plan validation (real bug) ✅ Implemented (Wave 1)

**Impact: Medium · Complexity: Low · Confidence: High**

`packages/core/src/plan-validation.ts:86-96` folds `owned_files` and `owned_modules` into one
map, so a path listed in both fields of the *same task* triggers "Wave wave-1 has overlapping
ownership for … : **budget-config and budget-config**" (plan-1 n56, six such errors). The
planner burned a thinking cycle diagnosing it ("It's comparing each task against ITSELF. That
seems like a validation bug") and worked around it by **deleting `owned_modules` from the plan
entirely** — the bug is training plans away from a field's intended use. Dedupe within a task
or emit a distinct `task.ownership.duplicate` diagnostic naming both fields.

#### R10. Make scout findings actually get recorded (feature currently dead in practice) ✅ Implemented (Wave 1)

**Impact: Medium · Complexity: Low · Confidence: High**

`omr_record_scout_finding` was called **zero times in eight sessions**;
`omr_list_scout_findings` always returned `total: 0`. Root cause: the milestone-planner skill
(`packages/extension/skills/milestone-planner/SKILL.md:20-21`) only requires recording "after a
scout returns durable findings" — i.e., after dispatching scout *agents* — and every planner
scouted inline, so the trigger never fired. Meanwhile plan-2 re-read the exact files plan-1 had
mapped, and every session independently re-discovered the test layout (including repeated
failed reads of a nonexistent `packages/core/test/` before finding top-level `test/`).
**Fix:** in both planner skills, require recording durable repo-structure discoveries (test
layout & runner, key module map, cross-cutting conventions) at the end of discovery/planning
*regardless of whether scouting was inline or delegated*, and have `/omr:rm-new` record its
discovery findings as scout findings too (they're exactly what milestone planners re-derive).
**Signal:** sessions 2+ of a roadmap show nonzero `omr_list_scout_findings` results and
measurably less re-scouting.

#### R11. Give wave reviewers visibility into later waves' ownership

**Impact: Medium · Complexity: Low · Confidence: High**

implement-3's WaveTwoReview raised a blocking **"needs-user-decision"** finding that docs scope
was "omitted" — but the docs were owned by wave-3's `integration-docs` task (plan L583-618).
The primary had to burn a justification cycle self-resolving it, and a weaker orchestrator
would have interrupted the user. Add to the `prepareWaveReview` package
(`packages/core/src/wave-orchestration/review.ts:98-156`) a compact map of **remaining waves →
tasks → owned files/acceptance items**, and tell the reviewer template to judge only the active
wave's exit criteria. **Signal:** zero review findings about scope owned by later waves.

#### R12. Specify rework authorization ordering; give rework runs a first-class record

**Impact: Medium · Complexity: Low-Medium · Confidence: High**

In implement-3, the primary hub-sent rework *before* recording a rework dispatch, so the
worker's fix edit was gate-rejected ("implementation gates are not satisfied") and a full
round-trip was wasted while the worker asked to be re-authorized (BudgetCommands #102/L180;
primary L130–L133). The gate rejection didn't name the missing step. Two fixes: (a) prompt +
skill rework section states the order explicitly — *record rework dispatch → hub op:send →
await note → record result → prepare re-review*; (b) the gate rejection text for a known
worker agent-id should say "no active dispatch lease for this agent; the orchestrator must
`omr_record_worker_dispatch` first." Also make the rework record carry a marker (e.g.
`rework_of: <finding/note id>`): today it's indistinguishable from a duplicate — ms-operator-
surface's `runtime.yml` shows `BudgetCommands` listed twice in wave-2 with identical agent_id
and no linkage, which reads as a data error to any auditor (including R1's gate exemption
logic, which needs exactly this signal).

#### R13–R15. Small receipt/copy fixes (batch these) ✅ Implemented (Wave 1)

**Impact: Low-Medium each · Complexity: Low · Confidence: High**

- **R13** ✅ Implemented (Wave 1) — `omr_append_note` status enum: a worker passed `status: "completed"` and was rejected
  (enum is blocker-lifecycle `open|resolved|deferred`; implement-1 WorkerBudgetModel
  #101/L184). Either rename the field (`blocker_status`), accept/normalize task-status
  vocabulary for non-blocking notes, or document the semantics in the tool description.
- **R14** ✅ Implemented (Wave 1) — Planner write-gate rejection text: when the roadmap planner tried to write a file for
  the checker, the gate correctly blocked it but the reason ("Roadmap milestone check is
  pending for revision 1") implied the write would become legal later. The real answer is
  "planning agents don't write files; the checker fetches its own package via
  `omr_read_state scope=roadmap_checker_package`" (new-roadmap n80–81) — say that. Also note
  in the roadmap-planner skill that the primary needn't fetch or forward the 15.9KB checker
  package at all.
- **R15** ✅ Implemented (Wave 1) — `omr_update_roadmap` returns a 34-char receipt with no phase/next-action while
  transitions return rich receipts ("Transition applied: approve_roadmap. Next action: …").
  Give mutating tools the same receipt shape — receipts are the cheapest steering surface OMR
  has, and this run proved agents follow them (compare the one-step recoveries in R6 vs the
  multi-turn detour in R8). Same for `omr_prepare_closeout` succeeding in `reviewing` while
  `record_closeout` requires `closeout` (implement-1 #89–#93): prepare's receipt should state
  "call start_closeout before record_closeout."

---

### TIER 3 — Efficiency, robustness, and model-portability

---

#### R16. Worker context-hygiene rules (the $2.44 worker)

**Impact: Medium · Complexity: Low · Confidence: Medium-High**

DispatchEnforcement (implement-2) spent 7.43M tokens/$2.44 in a single linear conversation:
14 separate reads of `dispatch.ts`, 9 of its own test file, a read-back verification after
nearly every edit, and ~60 read/grep calls before the first edit, all on monotonically growing
(31k→167k) context; its rework wake alone cost $0.28 to apply a one-line fix. Much of this was
**reading substituted for running** (R3 fixes the root cause), but the worker templates should
also say: batch related reads before editing; trust edit-tool receipts instead of re-reading
the file after every change; re-read only the hunk you will edit next. Consider a dispatch-
prompt effort hint scaled to task size (Anthropic publishes explicit effort-scaling tiers for
subagents — [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
**Signal:** same-file re-read count per worker drops; per-worker cost variance narrows.

#### R17. Harden the xd:// transport for weaker models

**Impact: Low-Medium · Complexity: Medium · Confidence: Medium**

All 5 malformed-JSON tool errors in the roadmap were glm-5.2 emission failures on `xd://` write
payloads (unterminated string, trailing `#` markdown, missing brace); gpt-5.6 had zero. glm
also invented no-op `bash echo '{...}'` "payload preparation" calls before its first xd://
write in two sessions (plan-2 primary n1–5; new-roadmap checker n1–2). Error texts were good
(one-retry recovery every time), so this is polish: tolerate trailing junk/fenced JSON with a
repair pass, and put a one-line canonical invocation example at the top of each tool's `?`
docs and the session-start instructions. Also surface per-operation **phase preconditions** at
the top of `omr_transition`'s docs — the new-roadmap agent read the 13.5KB docs and still hit
the phase error (n86–88).

#### R18. Cross-model prompt robustness for the orchestration prompts ✅ Implemented (Wave 1)

**Impact: Medium · Complexity: Medium · Confidence: Medium**

The same prompts produced materially different compliance: gpt-5.6 followed "re-dispatch
reviewer" in spirit (woke the reviewer) and never read `.omr` artifacts directly; glm-5.2 read
the same words literally (fresh spawns), read `plan.md` directly twice, and needed the user to
steer reviewer reuse. Current guidance says GPT-5.x follows instructions "with surgical
precision" (contradictions/omissions are the failure mode) while newer Claude/open models need
the *reason* behind an invariant to generalize correctly
([GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide),
[Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
Concretely for OMR: state each invariant **once, with its rationale and an explicit
procedure** (the worker-rework rule is the house exemplar — it names the ops, the order, and
the fallback; the reviewer rule was one ambiguous verb, and R2 fixes it); avoid duplicating
rules across prompt + skill with drift (the rework text is currently maintained verbatim in
both `prompts.ts` and `SKILL.md` — factor to one source); and prefer structured receipts/state
over prose wherever a rule keeps getting violated by *some* model tier (the run shows agents
obey receipts near-perfectly across models, prose unevenly).

#### R19. Per-role model guidance in config docs (+ escalation hook)

**Impact: Low-Medium · Complexity: Low · Confidence: Medium**

The run's config put reviewers on medium thinking while workers got high/max — backwards
relative to published guidance that judgment-heavy verifier roles are where weak models produce
false PASSes and deserve the strong model
([Claude Code best practices](https://code.claude.com/docs/en/best-practices),
[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
The reviewers here performed well anyway (implement-2's WaveReviewer did baseline-stash and
mtime forensics), so this is documentation rather than a defect: ship recommended per-role
tiering in the config docs/template (checkers and reviewers ≥ worker tier; style-scout can be
cheapest), and consider a future **escalate-on-failure** option — after N failed review cycles
on a task, redispatch the rework one worker tier up (pairs naturally with the R20 loop cap).

#### R20. Cap the fix→re-review loop; dogfood the new budget feature

**Impact: Low-Medium · Complexity: Low-Medium · Confidence: Medium**

Nothing bounds the rework loop today ("repeat until the wave is clean"). This run never
ping-ponged (max 1 rework per wave), but a weaker worker + stricter reviewer would loop, and
iteration caps on agent loops are standard guidance
([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
Add to the implementation skill/core: after N (e.g. 2) failed re-reviews of the same wave, stop
and surface a needs-user blocker with the findings history. And now that this roadmap shipped
execution budgets: **set default soft budgets on OMR's own orchestration runs** in the docs and
sample config, so runaway loops hit the wave-boundary pause the team just built. The evaluation
itself is the use case the feature was requested for.

---

## 5. Ranked summary

| #      | Recommendation                                                                                                                                   | Impact   | Complexity | Owning surface                                                         |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------|----------|------------|------------------------------------------------------------------------|
| R1     | Review-findings→blocker pipeline overhaul (severity model, no auto-mint, gate exemption for rework, resolvable deferred blockers, honest actors) | Critical | Med-High   | core: store/blockers.ts, wave-orchestration/review.ts, validation.ts   |
| R2     | Reviewer identity + wake-don't-respawn (prompt fix now, reviewer-run state + re-review receipt next) — ✅ Implemented (Wave 1)                    | High     | Medium     | prompts.ts:55, SKILL.md:93-96, wave-orchestration/review.ts + types.ts |
| R3     | Scoped worker self-verification + evidence handoff to reviewer (mandatory LSP; conditional owned-file tests; command receipts in notes)          | High     | Medium     | worker templates, dispatch.ts prompt builder, reviewer package         |
| R4     | Verification baseline at start_implementation; reviewers diff against it                                                                         | High     | Medium     | reviewer template, wave-orchestration, milestone runtime               |
| R5     | Milestone-count parsimony rule + checker fragmentation check — ✅ Implemented (Wave 1)                                                            | High     | Low        | roadmap-planner SKILL.md, roadmap-milestone-checker AGENT.md           |
| R8     | Phase-aware, never-stale next_action (init/discovery gap; post-deferral wave unblock)                                                            | Med-High | Medium     | report/next-action.ts, omr_init, defer/resolve receipts                |
| R6     | Auto-advance wave (or receipt payload) after passed review — ✅ Implemented (Wave 1)                                                              | Medium   | Low        | wave-orchestration/review.ts                                           |
| R7     | prepare_worker_redispatch accepts abandoned runs (or skill/error text fixed); history:// scoping note — ✅ Implemented (Wave 1)                   | Medium   | Low        | dispatch.ts, implementation-orchestrator SKILL.md                      |
| R9     | plan-validation self-overlap false positive — ✅ Implemented (Wave 1)                                                                             | Medium   | Low        | plan-validation.ts:86-96                                               |
| R10    | Scout-finding recording trigger for inline scouting — ✅ Implemented (Wave 1)                                                                     | Medium   | Low        | planner skills                                                         |
| R11    | Later-wave ownership map in reviewer package                                                                                                     | Medium   | Low        | wave-orchestration/review.ts, reviewer template                        |
| R12    | Rework authorization ordering + rework-marked dispatch records + gate text                                                                       | Medium   | Low-Med    | prompts.ts/SKILL.md, worker-runs.ts, gate text                         |
| R16    | Worker context-hygiene rules (batch reads, trust receipts)                                                                                       | Medium   | Low        | worker templates                                                       |
| R18    | Cross-model prompt robustness (single-source invariants w/ rationale + procedure) — ✅ Implemented (Wave 1)                                       | Medium   | Medium     | prompts.ts, skills                                                     |
| R13-15 | Receipt/copy batch: append_note enum, planner gate text, uniform rich receipts — ✅ Implemented (Wave 1)                                          | Low-Med  | Low        | tool registrations, gate.ts messages                                   |
| R17    | xd:// JSON tolerance + invocation examples + phase preconditions in docs                                                                         | Low-Med  | Medium     | tool registration / OMP transport                                      |
| R19    | Per-role model tier guidance (+ future escalate-on-failure)                                                                                      | Low-Med  | Low        | docs, config template                                                  |
| R20    | Rework-loop iteration cap + dogfood budgets on OMR's own runs                                                                                    | Low-Med  | Low-Med    | implementation skill, docs                                             |

**Suggested sequencing:** R5 + R9 + R10 + R6 + R7 + R13–R15 are a quick-wins wave (all prompt/
copy/small-core, independently shippable). R2's prompt half and R3 are the highest
value-per-effort behavioral changes. R1 + R4 + R8 form the state-machine integrity wave and
deserve their own focused milestone with regression tests keyed to the transcript signals named
above. R16–R20 ride along opportunistically.

## 6. Evidence appendix (primary citations)

| Finding                                                                     | Session / transcript                                   | Location                                                                      |
|-----------------------------------------------------------------------------|--------------------------------------------------------|-------------------------------------------------------------------------------|
| "re-dispatch reviewer" respawn (×2)                                         | implement-1 primary                                    | n43/L75, n77/L127; op:list at n39/L70, n73/L121; thinking quoting rule at L69 |
| Reviewer reuse only after user interjection                                 | implement-2 resumed primary                            | n50 (user), n90/n94 ("per the user's preference")                             |
| Reviewer reuse done right (same prompts, gpt-5.6)                           | implement-3 primary + WaveTwoReview                    | L156; WaveTwoReview #39–51                                                    |
| No reviewer identity in state/receipts                                      | source                                                 | wave-orchestration/types.ts:116-134, wave-tools.ts:152-166, review.ts:98-156  |
| Blocking note auto-mints blocker; orchestrator unaware                      | implement-2 WaveReviewer n51 + primary n57 thinking    | store/blockers.ts:217; blockers.yml blk_2d2fe190                              |
| Gate blocks the blocker's own fix                                           | implement-2 EnforcementEval                            | n82–83 / L141–142; validation.ts:282                                          |
| Worker self-defers; actor falsified to 'user'                               | implement-2 EnforcementEval n86–87                     | store/blockers.ts:139; blockers.yml deferred_by                               |
| Deferred blocker unresolvable post-fix                                      | implement-2 resumed primary                            | n120–121 / L196–197                                                           |
| PASS findings → 6 open blockers                                             | implement-3 primary                                    | n113–n126 / L188–L214                                                         |
| Stale next_action + empty-message stall                                     | implement-3 primary                                    | n127–n132 / L214–L229                                                         |
| Wave-2 defects all machine-catchable (TS2375, undefined fn, own-test fail)  | implement-1 Wave2Reviewer L118; WorkerBudgetModel L220 | worker templates :45-47; dispatch.ts:81-85                                    |
| Both implement-2 review fails preventable by scoped tests; single-task wave | implement-2 WaveReviewer n51, n107                     | plan verification commands per task                                           |
| implement-3 sole rework = own-test assertion string                         | implement-3 WaveTwoReview / BudgetCommands             | test/budget-commands.test.ts:103 finding; rework at L130–L133                 |
| Rework edit gate-blocked (missing dispatch record)                          | implement-3 BudgetCommands #102/L180                   | primary L130 vs L133                                                          |
| Pre-existing failures re-litigated ×3, escalated to user                    | implement-3 reviews W1#34/W2#26/W3#22                  | blockers.yml blk_b67e2eb1, blk_daef0d67                                       |
| Wave-boundary "already complete" error (both models)                        | implement-1 #52/L88; implement-3 n50/L91               | review.ts passedWaveNextActions                                               |
| prepare_worker_redispatch refuses abandoned run                             | implement-2 resumed primary n15–16 / L32–33            | dispatch.ts prepareWorkerRedispatch                                           |
| history:// unknown cross-session                                            | implement-2 resumed primary n20–21 / L40–41            | skill guidance                                                                |
| Abandonment→resume audit chain (strength)                                   | implement-2 resumed primary n4–25                      | worker-runs.ts; runtime.yml replaces_agent_id                                 |
| Self-overlap validation bug + owned_modules deletion workaround             | plan-1 primary n56–57                                  | plan-validation.ts:86-96                                                      |
| Scout findings: 0 recordings / 8 sessions                                   | all indexes                                            | milestone-planner SKILL.md:20-21                                              |
| omr_init discovery not recorded; misleading next_action                     | new-roadmap primary n56–96                             | esp. n89/L156, n92/L160                                                       |
| Planner deliberated milestone count with only lower-bound rule              | new-roadmap thinking L102/L105                         | roadmap-planner SKILL.md:34-35                                                |
| Milestone sizes 3/2, 4/2, 5/3 (tasks/waves); planning $0.64–$2.26 each      | .omr milestones plans; usage.yml                       | —                                                                             |
| False needs-user-decision on later-wave scope                               | implement-3 WaveTwoReview L125/L147                    | plan.md L583-618 (wave-3 owns docs)                                           |
| DispatchEnforcement cost anatomy (14× same-file reads etc.)                 | implement-2 DispatchEnforcement index                  | phases: n1–63 / n64–150 / n155–166                                            |
| append_note enum rejection                                                  | implement-1 WorkerBudgetModel #101/L184                | tool registration                                                             |
| Planner write gate: right block, wrong remedy text                          | new-roadmap primary n80–81 / L142–143                  | gate.ts message assembly                                                      |
| glm xd:// JSON failures ×5; bash-echo no-ops                                | plan-1 n77, plan-2 n1–5/n49/n65, roadmap checker n1–2  | transport ergonomics                                                          |
| BudgetCommands duplicate worker_run (rework unmarked)                       | .omr ms-operator-surface runtime.yml                   | worker-runs.ts record semantics                                               |

---

## 7. Addendum — context delivery to sub-agents (reducing ramp-up without reducing quality)

Added after a follow-up interview with the maintainer. Design constraints from that interview:
OMR targets **public distribution to other OMP users** (arbitrary models/repos — raises the
priority of R17/R18 and of good defaults); the maintainer approved all three context-seeding
approaches below; the single-milestone "fast path" idea was **rejected** (phases stay strict —
R5's parsimony rules are the sole remedy for over-splitting).

### The measured problem

Workers spend a large fraction of their budget re-acquiring context the system already has:

- DispatchEnforcement (implement-2) made ~60 read/grep calls before its first edit —
  $0.44 / 1.04M tokens of pure ramp-up in a $2.44 task.
- Every worker in implement-2 independently read AGENTS.md, tsconfig, `budget.ts`, and
  `helpers.ts`; every worker in every milestone made its own `omr_style_guide` call; every
  session re-discovered the test layout (see R10).
- Reviewers then re-read much of what workers read, and reconstructed "what changed this wave"
  by hand — implement-1's Wave2Reviewer resorted to `git stash` forensics and implement-2's
  WaveReviewer to mtime comparisons, because nothing hands them a diff boundary.

Meanwhile the dispatch package (`packages/core/src/wave-orchestration/dispatch.ts:165-210`,
`workerPrompt`) contains the task's objective/notes/criteria/ownership/preflight — but **none**
of: the plan's per-task `Relevant Existing Code` evidence (file:line refs the planner already
verified during discovery), scout findings, style guidance for the owned file types, or the
signatures behind the `shared_interfaces` names. The planning phase pays to build precisely
this map, then throws it away at the dispatch boundary.

**Quality guardrail for everything below:** seed *verified pointers and contracts*, not bulk
content or conclusions. Every seeded item carries a "verify against live code before relying on
it" note and a source timestamp; just-in-time reads remain fully available. This is the hybrid
Anthropic's context-engineering guidance recommends (pre-load small critical identifiers,
retrieve details on demand) and it cannot make a worker *worse* informed than today.

#### R21. Carry plan evidence + conventions into the dispatch package

**Impact: High · Complexity: Low-Medium · Confidence: High**

Extend `workerPrompt`/`assignment` in `dispatch.ts` to include, per task: (a) the plan's
`Relevant Existing Code` refs for that task (path:line + one-line why); (b) scout findings
matching the owned paths (once R10 makes them exist); (c) the style-guide slice for the owned
file extensions (assembled once by the orchestrator instead of N per-worker calls); (d) for
each name in `shared_interfaces`, the actual signature/type as of dispatch time. Do the same
for the reviewer package. **Signal:** tool calls before first edit drop sharply (baseline:
~60 for the worst observed worker); per-worker `omr_style_guide` calls go to 0.

#### R22. `omr_task_briefing` — one-call context pack

**Impact: Medium-High · Complexity: Medium · Confidence: Medium-High**

A logical tool a worker calls once at start (or the orchestrator pre-calls and inlines):
returns LSP symbol outlines of owned + dependency files, file sizes, import graphs one hop
out, and head excerpts of small critical files — server-assembled, capped, with
`response_format: concise|detailed`. Replaces dozens of exploratory reads with one round-trip
while leaving the worker free to read anything it still needs. (Tool-design guidance:
consolidate frequently-chained operations; cap payloads —
[anthropic.com/engineering/writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents).)

#### R23. Persistent per-repo primer artifact

**Impact: Medium-High · Complexity: Medium · Confidence: High**

Generalize the style-scout pattern into a repo primer generated at `omr_init`/first planning
and refreshed on drift: test layout + runner + invocation commands, build/typecheck commands,
monorepo topology, key module map, engineering-guidance digest (AGENTS.md). Store it in `.omr`,
inject a compact rendering into every sub-agent prompt, and let planners extend it via scout
findings. This is the structural fix for the class of waste R10 patches (every session
re-derived `test/` vs `packages/core/test/`, the bun runner, and tsconfig quirks — at least
8 times across the roadmap).

#### R24. Wave diff package for reviewers

**Impact: Medium · Complexity: Low-Medium (with F1) · Confidence: High**

Record a wave-start snapshot (git ref when F1 checkpoints are enabled; content-hash manifest of
owned files otherwise) and have `prepareWaveReview` include the changed-file list + diffstat +
per-owned-file diffs. Reviewers stop reconstructing change scope via stash/mtime forensics, and
re-reviews can be scoped to "files changed since the flagged findings."

## 8. Addendum — new feature candidates (maintainer-endorsed)

All four below were selected by the maintainer in the follow-up interview, with the noted
constraints.

#### F1. Git wave checkpoints — **opt-in via config** (maintainer requirement)

`orchestration.git_checkpoints: true` in `.omr/config.yml` (default off). After each passed
wave review, commit the wave's changes with a structured message (roadmap/milestone/wave/task
ids); optionally a branch per milestone. Benefits observed directly in the transcripts:
reviewers get a real diff boundary (R24), a failed wave can be reverted cleanly, closeout
evidence can cite commits, and the "one giant commit per roadmap" pattern (this entire roadmap
landed as a single `roadmap complete` commit) becomes reviewable history. Enforcement caveats
(per maintainer direction): when the working tree also contains non-OMR changes, do **not**
refuse — stage and commit **only the OMR changes**, leaving unrelated changes untouched.
Determine the commit set from the wave's actual recorded change manifest (the R24 wave-start
snapshot diff), not from declared ownership alone, since tasks may legally touch files owned by
non-concurrent waves. Staging is path-level: if a user concurrently hand-edited a file the wave
also changed, the commit would carry their hunks too — detect this (R24 hash vs HEAD) and warn
in the checkpoint receipt rather than silently including it. Respect the write gate; record the
checkpoint ref in runtime.yml.

#### F2. Retrospective analytics — `omr:rm-retro`

Productize what this evaluation did by hand. Everything needed is already persisted
(`events.ndjson`, `usage.yml`, `runtime.yml`, `blockers.yml`): first-pass review rate (this
roadmap: 3/7 waves), rework round-trips per wave, blockers by origin (review-noise vs genuine),
errors by tool, cost per phase/role/wave/model, waves per milestone vs plan. Render a report +
persist tuning observations. This also gives OMR development a regression harness: the
validation signals named throughout this document become computable metrics.

#### F3. Predictive cost estimates — **priced at currently-configured models** (maintainer requirement)

At plan-approval time, estimate the milestone's cost from historical per-role, per-phase
**token counts** (usage.yml already stores raw token components by agent bucket), re-priced at
the *currently configured* model for each role — not historical dollars — since users change
role→model assignments between phases (this very roadmap switched glm-5.2 → gpt-5.6 mid-run).
Surface at approval ("~$X expected for 5 tasks / 3 waves at your current model config — set a
soft budget?") and feed the new budget feature's defaults. Pricing via the same
`pi-catalog calculateCost` path the usage subsystem uses.

#### F4. Persistent workers across waves

When a later wave's task owns files overlapping a completed task's ownership and uses the same
worker tier, offer to wake the prior worker (it is parked, and hub revives parked agents on
message) instead of spawning fresh — the cross-wave analogue of R2. Guardrails required:
rehire only below a context-size threshold (the $2.44 DispatchEnforcement transcript shows
long-context agents get expensive per turn — rehiring is a *loss* past a point), record the
reuse in worker_runs, and always allow the orchestrator to decline. Ties into R12's lease
semantics.

**Also worth considering (not yet user-ranked):** ad-hoc run budgets (explicit non-goal of the
budgets roadmap; natural follow-up); Moshi notifications for budget threshold events; a
plan-evidence drift check at dispatch time (implement-2's GateEval hit a stale path the plan
had recorded — cheap to re-verify evidence refs when a wave starts); automatic transcript
bundle export + index generation at roadmap completion to feed F2.

### Priority interaction with the main list

Given the public-distribution answer, R17 (xd:// hardening) and R18 (cross-model prompt
robustness) move up a tier — the glm-5.2 vs gpt-5.6 compliance gap documented in §4 is exactly
what arbitrary-model users will hit. R21/R23 slot alongside R3/R4 in impact (they attack the
other half of the same cost: R3 removes rework loops, R21/R23 remove ramp-up); R22/R24/F1–F4
sequence naturally after the Tier-1 items land.
