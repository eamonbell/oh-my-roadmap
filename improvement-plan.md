# roadmap-engineer: reliability, planning-boundary, and lifecycle improvements

## Context

`roadmap-engineer` is a solo-daily-driver OMP extension that runs large coding tasks as a gated
lifecycle (`discovery → roadmap → milestone plan → implementation waves → review → closeout →
complete`). Review of two captured QA sessions (`qa-runs/sessions/`) plus a code sweep surfaced
concrete failures, the worst of which is reproduced in the logs:

**The duplicate-worker bug (confirmed empirically, then re-verified against the full transcript
set in `qa-runs/sessions/2026-07-02T01-16-31…`).** The task `runtime-managed-tool-execution` (a
`worker-heavy`) spawned three workers: `RuntimeManagedTools` → socket error (`01:17:56`, mid-
*exploration*) → `transport_failed` → IRC resume (**the worker acked at `01:18:11` and resumed**) →
but the orchestrator then fired a **separate `op:wait` for a *final result*, hit a 2-min timeout, and
abandoned + redispatched**; `RuntimeManagedToolsRetry` → the *same* premature abandonment on its own
transport failure — **yet Retry actually recovered in place and completed the whole task** (8 files,
`go test ./orchestrate` green, `record_wave_result: completed` at `01:38`); `RuntimeManagedToolsFinal`
→ spawned as a needless replacement, read `runtime.go` and **saw Retry's half-finished edit** (hash
`#FB94`→`#1B78`, Retry's `WorkflowModelBuilder` insert already present), then the orchestrator ran
`irc op:list`, found **Retry still alive and editing**, and hand-stood-down Final (*"to avoid
collision"*). Root causes (verified in code + transcripts):
1. **Abandonment is gated on a fixed chat-silence window, not on liveness.** The skill sends one
   resume, then does a *separate* `op:wait` (2 min) for a **final result** — but a `worker-heavy`
   task cannot finish in 2 min, so it is abandoned while alive and progressing. The resume itself
   **succeeded both times**; the defect is conflating "responded with an ack" (alive) with
   "delivered a final result," and treating 2-min silence as death. `RuntimeManagedToolsRetry`,
   abandoned this way, went on to **complete the task** — the positive control that in-place
   re-resume works. Compounding this: there is **no `op:list` liveness re-check immediately before
   `record_worker_abandoned`** (it goes straight from wait-timeout → abandon), and the `job` tool
   **actively misleads** — it reported the crashed run as terminal `failed (exit 1)` at the same
   instant `op:list` showed the peer `running, active 3m45s ago`. (The original "abandons after the
   first *failed resume*" framing was wrong: no resume failed; a redundant post-`await:true` `op:wait`
   burned the timeout.)
2. `recordWorkerAbandoned` (`worker-runs.ts:158-193`) is **state-only** and never stops the live
   IRC peer, so an "abandoned" worker collides with its replacement. Empirically this was worse than
   a passive collision: the orchestrator **told the abandoned worker to resume while simultaneously
   spawning the replacement** (double-dispatch of a live peer), and abandoned peers **lingered as
   `parked`** (auto-revivable — *"parked agents are revived automatically when you message them"*)
   for 6–11 min, up to 4 stale peers late in the run. Destructive file corruption was averted **only
   by an emergent worker-to-worker IRC "probe the prior owner" handshake that exists in no skill.**
3. There is **no pre-spawn liveness guard** and **no retry counter/cap** — the ownership guard
   (`assertNoActiveOwnershipOverlap`) only fires *after* the duplicate is already spawned. Concrete
   proof of the near-miss: `RuntimeManagedToolsFinal` read `runtime.go` mid-refactor and got a hash
   containing `RuntimeManagedToolsRetry`'s in-flight `WorkflowModelBuilder` insert — it was
   inspecting *in order to edit* and was seconds from a 3-way collision when Main stood it down.
4. When a worker genuinely can't recover, its **already-done work is lost** — the replacement
   starts cold with no pointer to the partial edits (which, since workers run on the active
   branch with no worktree, are already on disk). **But note the empirically observed failure mode:**
   both `RuntimeManagedTools` and `RuntimeManagedToolsRetry` crashed **during the discovery/read
   phase, before any edit** — so partial-work-loss is the *rarer* case; the *common* loss is the
   **read/exploration context**. `read history://RuntimeManagedTools` returned nothing actionable
   (the prior worker had no edits), so the replacement re-ran a ~20-file discovery sweep from scratch
   (~127k cache-read tokens). Continuation context must therefore be **phase-aware** (do not assume
   disk edits exist) and should also carry a digest of *what was inspected*, not just `history://`.

Related pains: implementation-time blockers caused by ownership/boundary problems the planning
checkers miss (only *same-wave literal overlap* is enforced in code); inability to start a new
roadmap after completing one; and corruption-fragile history.

**Newly-surfaced operational gaps (from the full transcript re-review — see Part 7):** the `job`
tool is unreliable for liveness (reports crashed-then-resumed runs as terminal `failed`, and once
returned an empty/non-text placeholder); there is **no durable result handoff** (a *completed*
worker terminated before its result was collected — orchestrator got *"Unknown or terminated
agent"* and had to reconstruct the wave result from a roadmap note via 3 `search_context` calls);
an **edit-gate deadlock** (a rework worker was blocked from editing by the *very open blocker it was
dispatched to fix*, forcing a `resolve_blocker` just to open the gate); and **stale-note hygiene**
(a stood-down worker left a durable `issue/deferred` note on the shared `notes.md` for a task that
then *completed*, so closeout/review sees a deferred issue on a done task). Transport instability is
**frequent, not a one-off** — 4 socket-close failures in the single run (the last, on a rework
worker, was handled *correctly* — resumed, waited 5 min, finished — a second positive control).

**Goal:** make worker recovery robust (never duplicate a live worker; tolerate repeated socket
errors; hand partial work to replacements); stop cross-wave file editing from raising blockers by
relaxing ownership to same-wave-only exclusivity and letting the checker agents best-effort
sequencing (with decision-completeness enforced); add corruption resilience and a new-roadmap path;
and add two low-cost capabilities.

**Confirmed decisions:** transport fix = prompt **+ code**; corruption resilience, new-roadmap
lifecycle, and capabilities included. Missing `decisions`/`dependency_analysis` = **error** (block
approval). Resume cap = **tunable via config, default 3**. Planning sequencing = **checker agents
do their best (best-effort), and only genuine hard blocks stop approval** — do not add new
hard-blocking sequencing invariants to code.

**Ownership model change (new):** editing a file **touched by another wave** must **not** be a
blocker. Because waves run strictly sequentially (only one wave `running` at a time), a worker in a
later/earlier wave editing a file another wave owns is safe and is a normal staged-refactor pattern
(e.g. wave 1 adds code in `package1`, wave 2 removes references in `package2`, wave 3 deletes the
dead code in `package1`). The **only** ownership that stays exclusive is **same-wave concurrent**
ownership (two workers running at once must not edit the same file). So: relax the worker/reviewer
ownership rules to permit cross-wave file edits, and drop the plan-time cross-wave/shared-ownership
checks — while keeping same-wave exclusivity (plan-time and dispatch-time) intact. This directly
removes the boundary blockers reported in real use.

**Context efficiency (new):** scope context to the caller's purpose and stop pretty-printing tool
output. A reviewer checking one wave should not pull the full milestone or roadmap. Applies to all
roles across the lifecycle.

Scope note: worker-tier differentiation, planner/orchestrator model-config, write-time ownership
enforcement, and the stale handoff doc are **out of scope** (not selected).

---

## Part 1 — Transport-failure robustness + duplicate-worker prevention + continuation context

### 1a. Attempt counter + lineage on `WorkerRun`
- `src/core/types.ts:213-225` — add `transport_failures: number` (required) and
  `replaces_agent_id?: string`. Keep single `last_error` (most-recent); no unbounded history.
- `src/core/store/shared.ts` — add `valueNumber(value, fallback=0)` (mirrors `valueString`).
- **Serialization touch-point (load-bearing):** `src/core/store/format.ts` `normalizeWorkerRun`
  (123-150) reconstructs runs field-by-field, so add `transport_failures: valueNumber(raw…,0)`
  and the optional `replaces_agent_id`, or they are silently dropped on reload. (The write path
  `runtimeFromPlan` passes whole objects through, so writing needs no change.)
- `worker-runs.ts` — `recordWorkerDispatch` (80-120) inits `transport_failures: 0` and sets
  `replaces_agent_id` from `input.replacesAgentId` when present; `recordWorkerTransportFailed`
  (122-156) sets `transport_failures: (current.transport_failures ?? 0) + 1`.
- Optional: add `transport_failures` to the event snapshot in `src/core/store/events.ts`
  `progressSnapshot` for observability.

### 1b. Guarded `prepareWorkerRedispatch` + continuation context
- New core fn in `src/core/wave-orchestration/dispatch.ts` (after `prepareWaveDispatch`), plus
  input/result types in `wave-orchestration/types.ts` and exports in `index.ts`. Logic:
  1. `assertImplementationReady`; load `activePlanContext`; `requireTaskInActiveWave`.
  2. **Core guard:** if any active run for the task is `running`, **throw** (`Task <id> still has
     a running worker; stop and abandon it before redispatch`). This is the code backstop that
     structurally prevents a replacement while the old peer may be live.
  3. Find the prior `transport_failed` run (disambiguate by optional `agentId`/`jobId`); capture
     `agent_id`, `transport_failures`, `last_error`; **atomically flip it to `abandoned`** reusing
     the `recordWorkerAbandoned` pattern (drop from `active_task_ids`).
  4. Reload context; build assignment with continuation context; return `{ assignment, prior_run,
     instructions }`.
- Modify `workerPrompt` (`dispatch.ts:19-48`) + `assignment` (50-61) to accept an optional
  `continuation = { priorAgentId, transportFailures, lastError }`. When present, append a
  **CONTINUATION CONTEXT** section: read `history://<priorAgentId>` first; prior attempt
  count/last error; *any partial work is already on the active branch — inspect current file state
  (git status/diff, read owned files) before editing; do not redo completed work; continue from
  the last incomplete step.* `prepareWaveDispatch`'s existing call passes no continuation.
- **Phase-aware wording (empirical):** in the captured run, both failures hit during the *discovery*
  phase, so `history://<priorAgentId>` returned nothing actionable and no disk edits existed —
  yet the replacement paid a full ~20-file re-discovery (~127k cache-read tokens). The CONTINUATION
  CONTEXT text must therefore **not assume disk edits exist**: phrase it as *"if the prior attempt
  made edits they are on the branch — inspect before editing; if it had not started editing, its
  `history://` transcript is your read/exploration head-start so you need not re-discover from
  scratch."* (This favors preferring in-place re-resume — §1e — over cold redispatch whenever the
  peer is still live, since re-resume preserves the read context entirely.)
- **Live-peer coordination step (empirical, load-bearing):** collision was averted only by an
  emergent worker-to-worker IRC handshake that is in **no** skill. The CONTINUATION CONTEXT must
  explicitly warn the replacement that *a prior owner `<priorAgentId>` may still be live* and
  instruct it to **confirm via `irc op:list` / `op:send` that the prior peer is stopped before
  editing any owned file** — do not rely on roadmap state saying "abandoned" (state said abandoned
  while the peer was demonstrably editing).
- Register tool `roadmap_engineer_prepare_worker_redispatch` in
  `src/tools/register/wave-tools.ts` (mirror `record_worker_dispatch`; params
  `taskId`, optional `agentId`/`jobId`).

### 1c. Lineage on dispatch
- `RecordWorkerDispatchInput` (`wave-orchestration/types.ts`) + the `record_worker_dispatch`
  schema (`wave-tools.ts:39-43`) — add optional `replacesAgentId`. Records provenance only.

### 1d. Tunable resume cap (config)
- Extend config schema in `src/core/project-init.ts` `parseConfig` (currently
  `rejectUnknownKeys(root, ['agents'], …)`): allow top-level `orchestration:
  { transport_resume_attempts: number }` (default **3**), validated as a positive integer; add to
  `defaultConfig`/`writeInitialConfig` and to the generated `config.yml`.
- Surface the value at prompt-build time: load config in `src/extension/commands/messages.ts`
  `sendCommandPrompt` (has `ctx.cwd`) and pass the resolved cap into `commandPrompt`
  (`prompts.ts`); interpolate `N` into the milestone:implement transport bullets. Default to 3
  when no config file exists (keeps tests green).

### 1e. Orchestrator instructions (prompt) — the recovery protocol
Edit the "Transient transport failure" block in `src/extension/commands/prompts.ts` and the
matching bullets in `skills/implementation-orchestrator/SKILL.md` to encode:
- On a socket/transport error: `record_worker_transport_failed`, then a **bounded resume loop** —
  `irc op:list` → `op:send` the **same** worker a narrow resume message → wait up to 2 min;
  re-resume the same worker up to the configured cap (default 3; `transport_failures` is the
  counter). **Never abandon after a single failed resume.**
- **An acknowledgement is a liveness signal, NOT a licence to abandon (the core bug fix).** In the
  captured run both workers *acked and resumed* within seconds, but the orchestrator then fired a
  **separate `op:wait` for a final result**, hit the 2-min timeout, and abandoned a live, working
  worker. State explicitly: (a) a `worker-heavy` task **will not** finish inside the 2-min window,
  so a 2-min *result* silence is **not** death; (b) if `op:send await:true` already returned a
  reply, **consume that reply as the liveness signal — do NOT launch a second blocking `op:wait`**
  for a message that will never come; (c) after acking, keep monitoring with longer waits
  (`op:wait` minutes, or `op:list` activity-age checks), never a fixed short abandon window.
- **`op:list` is the authority for liveness; the `job` tool is not.** The `job`/`job list` tool
  reported the crashed-then-resumed run as terminal `failed (exit 1)` while `op:list` showed the
  peer `running`, and once returned an empty/non-text placeholder. Instruct: **decide liveness from
  `op:list` peer status + activity age only; ignore a stale `job` terminal state after a transport
  failure**, and never abandon on `job` output alone.
- **Mandatory liveness re-check immediately before abandoning.** Only after the cap is hit **or**
  the worker is confirmed unreachable: run a **fresh `irc op:list` immediately before**
  `record_worker_abandoned` — if the peer is `running`/`idle` with recent activity, **do not
  abandon** (in the run, the orchestrator went straight from wait-timeout → abandon with no
  re-check, abandoning a peer it had just seen alive). Then **stop the peer (TaskStop) and confirm
  it is gone via `op:list`** — do not leave it `parked` (parked peers linger for minutes and are
  auto-revived when messaged) → `record_worker_abandoned` →
  `roadmap_engineer_prepare_worker_redispatch` → spawn the replacement with the returned prompt
  (carries continuation context + prior `history://<agentId>` + the live-peer coordination warning
  from §1b) → `record_worker_dispatch` with the new ids and `replacesAgentId`.
- State that `prepare_worker_redispatch` refuses while a run is still `running`, so a replacement
  can never collide with a live peer. Keep the existing "transport error is never a blocker" rule.
- **Resolve the skill's self-contradiction:** the current guidance says both *"abandon if no
  response within 2 min"* and *"do not treat a wait timeout as a failure"* (the orchestrator flagged
  the confusion, and later in the same run correctly waited 5 min and let a worker finish). Delete
  the fixed-2-min-abandon rule in favor of the liveness-gated protocol above so the two rules no
  longer compete.
(SKILL.md references "the configured resume cap (default 3)" generically since it can't
interpolate; the generated prompt carries the concrete number.)

---

## Part 2 — Ownership model + best-effort checkers (fewer hard blocks)

Two coupled changes: (a) allow cross-wave file editing so it stops causing blockers, and (b) keep
sequencing as best-effort checker-agent judgment rather than new hard code gates.

### 2a. Relax the ownership model to same-wave-only exclusivity
The real collision risk is two workers **running concurrently** (same wave) editing the same file;
files owned by other (non-concurrent) waves are safe to edit. Make ownership advisory across waves,
exclusive only within a wave:
- **Worker prompt** (`src/core/wave-orchestration/dispatch.ts` `workerPrompt`/`assignment`,
  19-61): inject a computed **"Reserved by concurrent sibling tasks in THIS wave (do not edit)"**
  list from the other `ctx.activeTasks`' `owned_files`/`owned_modules`. Replace "Work only on this
  task's scope" with: you own X; you may also edit files owned by **other waves** if your task
  requires it (those waves are already complete or not yet started); do **not** edit the reserved
  same-wave files above; only append a blocking note if you need something genuinely outside the
  plan or ambiguous.
- **Worker skills** (`skills/worker*/SKILL.md`, all three): relax "Edit only files/modules assigned
  to your task. If unowned files/modules are required, stop and append a blocking note" →
  permit editing files owned by other waves; block only for same-wave reserved files or a genuine
  out-of-plan/ambiguous need.
- **Reviewer skill** (`skills/reviewer/SKILL.md`): "ownership violation" = editing a **same-wave**
  sibling's reserved files; editing a file owned by another wave is **not** a violation.
- **Design doc** (`docs/design.md` Orchestration Rules): update the ownership statement to
  same-wave exclusivity; cross-wave edits are permitted because waves run sequentially.
- Same-wave overlap stays enforced at plan time (`plan-validation.ts:86-98`) and dispatch time
  (`assertNoActiveOwnershipOverlap`, which already only checks concurrently-active runs). No code
  change needed there.

### 2b. Keep sequencing best-effort; add only the decision-completeness hard block
The checker **agents** should do their best to sequence correctly; only genuine hard blocks stop
approval. So **do not** add new hard-blocking sequencing invariants (no
`wave.verification.future_artifact`, no `task.shared.unowned`, no cross-wave ownership check) and no
`warnings` plumbing.
- **Keep the existing genuine hard blocks** in `plan-validation.ts` (cycles, unknown/self deps,
  dependency order, **same-wave** overlap, single-active-wave, wave order, required fields).
- **Add one hard block — decision-completeness (user-selected):**
  `plan.decisions.missing` / `plan.dependency_analysis.missing` = **ERROR** in
  `validateMilestonePlan` (after the `open_questions` check ~249) so an underspecified plan stops
  before workers guess. **Ripple:** update `test/state/helpers.ts` `milestoneInput()` and any plan
  fixtures to set both, or existing lifecycle/wave tests fail — do it in the same change.
- **Sharpen the checker skills** to set the hard-fail bar:
  - `skills/wave-flow-checker/SKILL.md`: best-effort sequencing; **hard-fail only** on genuine
    blocks — dependency cycles, unknown/out-of-order deps, **same-wave** ownership collisions, or a
    wave that literally cannot build/verify until a later wave lands. State explicitly that
    **cross-wave editing of the same file is not a collision** (waves are sequential). Softer
    concerns (verification referencing a later-wave artifact, ownership tidiness) are advisory
    notes, not failures.
  - `skills/roadmap-milestone-checker/SKILL.md`: same framing at milestone grain — best-effort
    sequencing, hard-fail only on genuine unbuildable-until-later or contradictory sequencing.

---

## Part 3 — Corruption resilience

- **Event log.** `src/core/events.ts` `parseEvents` (60-65) — wrap per-line `JSON.parse` in
  try/catch, **skip** malformed lines, and count/return-or-log skips so one torn line can't break
  all history reads. Make `appendRoadmapEvent` crash-safe: replace the plain `appendText`
  (`files.ts:33`, non-atomic) with an atomic read-modify-write via `writeText` (temp+rename) under
  the existing store lock — or add an `appendTextAtomic` helper. (Logs are lock-serialized and
  bounded in practice; if they grow large this can be revisited.)
- **Malformed-note gate escape.** `src/core/validation.ts:21` — add `'notes.malformed'` to
  `BYPASSABLE_GATE_ERROR_CODES` so a single bad note frontmatter no longer wedges all file writes
  with no `/bypass` relief.

---

## Part 4 — New-roadmap lifecycle

`initRoadmapImpl` (`src/core/store/roadmap.ts:116-119`) hard-throws while any active pointer
exists, and nothing clears it after `complete`.
- Add `clearActivePointer(cwd)` to the store (delete `activePointerPath` via `fs.rm`), exported
  from `src/core/store/index.ts`.
- In `/roadmap:new` (`initRoadmapImpl` or the command flow): if the current active roadmap's phase
  is **`complete`** and there is no active change request, **auto-archive** it — clear the active
  pointer (roadmap dir/files are preserved as history), append a `roadmap.archived` event, then
  proceed with creation. If the active roadmap is **not** complete, keep the existing throw (never
  clobber in-progress work). Update the `next-action.ts:245` / `prompts.ts:15` guidance text to
  match ("starting a new roadmap archives the completed one").

---

## Part 5 — Capabilities (low-cost, reuse existing scaffolding)

- **`/roadmap:usage`** — a non-interactive usage summary + optional export. Reuse `src/core/usage.ts`
  and `usageLines` (`src/core/report/shared.ts:54`, already rendered in the `/roadmap:details`
  Usage tab). Register in `catalog.ts`/`register.ts` like the other prompt-backed commands, or as a
  direct read-only command that prints the summary (JSON/markdown).
- **Milestone dependency graph** — emit a Mermaid graph of the active milestone's task DAG,
  reusing the graph already built by `validateDependencyCycles` (`plan-validation.ts:186-207`).
  Expose as a small tool/command (e.g. `roadmap_engineer_render_dependency_graph` or a
  `/milestone:graph` command) returning Mermaid text; optionally add a tab to `report-ui`.

---

## Part 6 — Context/token efficiency across the lifecycle

Every tool serializes its agent-visible result as **pretty-printed** JSON
(`JSON.stringify(x, null, 2)`), and `read_state` `compact` dumps every task + full progress + up to
130 section refs; roles then re-fetch overlapping context (the reviewer: `read_state`×2 +
`search_context`×2 ≈ several thousand lines). Fix by scoping to purpose and compacting output — no
information the agent needs is removed, just fetched in smaller, targeted pieces.

### 6a. Compact tool serialization (all tools)
Replace `JSON.stringify(result, null, 2)` with compact `JSON.stringify(result)` at every
`textResult(...)` site that pretty-prints (`context-tools`, `wave-tools`, `transition-tools`,
`roadmap-tools`, `blocker-tools`, report/findings tools). The structured object still rides in
`details` for the UI; only the agent-facing text shrinks (~2-3x fewer tokens). In `read_state`, run
the embedded section search with a minimal snippet size since `sectionRefs` discards snippet bodies
anyway (`state-summary.ts:19-26`) — stop computing thrown-away text.

### 6b. Purpose-scoped reads — add an `active_wave` scope
Add `active_wave` to the `read_state` scope enum (`context-tools.ts:18`), `StateReadScope`, and
`summarizeState` (`state-summary.ts:4,156`). It returns only: `active`, the active wave (from
`progress.active_wave_id`) with **just that wave's tasks** (not the whole milestone), the progress
cursor, the wave's blockers, and worker/review note refs filtered by `waveId`. A reviewer/worker
scoped to one wave gets exactly that. (Plan-section refs aren't wave-filterable today —
`matchesFilters` only filters `notes` by `waveId` (`context.ts:137`) — so `active_wave` embeds note
refs, not plan-section refs.)

### 6c. Reviewer package carries the wave's worker notes
`prepareWaveReview` (`review.ts`) already returns the wave's tasks/exit/acceptance/verification; add
the active wave's **worker notes** (refs + bodies) to the returned package so the reviewer needs
~0–1 extra context calls instead of a broad search. Reuse `searchContext` with
`{artifacts:['notes'], kinds:['worker'], waveId}` inside `prepareWaveReview`.

### 6d. Scope-to-purpose guidance in role skills + preamble
- **Reviewer skill:** use `read_state` scope `active_wave`; `search_context` filtered by `waveId` +
  `kinds:['worker','review']`; expand only specific ids with `read_context`; do not re-read what is
  already in the dispatch prompt or review package (removes the `read_state`×2 + broad-search
  pattern).
- **Worker skills:** task detail is already in the prompt; if state is needed use
  `active_wave`/`active_milestone` and `search_context` filtered by `taskId`/`waveId` — never the
  full compact dump.
- **Planner/orchestrator:** `roadmap` scope for roadmap work, `active_milestone` for
  milestone/implementation; avoid full-roadmap dumps when a focused scope answers the question.
- **Shared preamble** (`prompts.ts:106-107`): list `active_wave` and state the rule — pick the
  narrowest scope that answers your question.

## Part 7 — Operational gaps surfaced by the transcript re-review

These are distinct from Part 1 (they are not the resume protocol itself) and each is backed by a
concrete event in `qa-runs/sessions/2026-07-02T01-16-31…`.

### 7a. Durable result handoff (no lost completions)
A worker (`RuntimeManagedToolsRetry`) *completed* the task but had already **terminated** when the
orchestrator asked for its report (`Unknown or terminated agent "…"`), forcing the orchestrator to
reconstruct the wave result from a roadmap note via 3 parallel `search_context` calls. Completion
must not depend on a post-`yield` IRC turn (which also **raced with the stop and was aborted** —
`stopReason:"aborted"`, 0 tokens). Change the contract so the **worker writes its structured result
to state** (extend the existing worker note, or a dedicated result field the orchestrator reads via
`record_wave_result`/a read tool) — the orchestrator collects the result from state, not from a live
IRC reply. Minimally: `record_wave_result` should be able to source the summary from the worker's
resolved note when the peer is gone, and the orchestrator prompt should direct it there instead of
re-searching.

### 7b. Edit-gate deadlock on rework
During review rework, worker `RuntimeEventScopeFix` was **blocked from editing by the very open
blocker `blk_…` it was dispatched to fix** — the orchestrator had to `resolve_blocker` purely to open
the gate, then IRC-authorize the edit. The edit gate (keyed on open blockers) creates a chicken-and-
egg for worker-fixable rework. Fix: the gate must **permit edits by the worker assigned to the
blocker's rework** (scope the gate to files/tasks *not* under active rework, or treat a dispatched
rework assignment as authorization) so a rework worker can edit the files it was sent to fix without
prematurely resolving the blocker. (Locate the gate in `src/core/validation.ts` / the write-gate
path; align with the `BYPASSABLE_GATE_ERROR_CODES` work in Part 3.)

### 7c. Stand-down / abandonment note hygiene
`RuntimeManagedToolsFinal` was stood down and left a durable `kind:"issue", status:"deferred"` note
on the shared `notes.md`; the task then **completed** via Retry, so closeout/review now sees a
`deferred` issue against a done task. Also two workers appended to one `notes.md` concurrently (a
shared-write path). Fix: a stood-down/abandoned worker should **not** leave a dangling `issue/
deferred` note (or the stand-down/redispatch flow should reconcile/retract it when the task later
resolves). Consider marking such notes with the abandoned `agent_id` so closeout can filter notes
belonging to superseded runs.

### 7d. `job list` observability
`job list` intermittently returned an empty/non-text placeholder (a `"see attached image"`
placeholder; the orchestrator filed `report_tool_issue`) and equated "spawned process exited on
transport crash" with "task failed." Beyond the prompt guidance in §1e (prefer `op:list`), the
`job`/`job list` tool itself should (a) never emit a non-text placeholder for a status snapshot, and
(b) distinguish "process exited" from "task failed" when the underlying agent/IRC peer survives.
(Investigate the job-status source feeding the orchestrator's `job` tool.)

## Critical files
- Transport: `src/core/types.ts`, `src/core/store/format.ts`, `src/core/store/shared.ts`,
  `src/core/wave-orchestration/{worker-runs,dispatch,types,index}.ts`,
  `src/tools/register/wave-tools.ts`, `src/extension/commands/{prompts,messages}.ts`,
  `skills/implementation-orchestrator/SKILL.md`, `src/core/project-init.ts` (config).
- Ownership + checkers: `src/core/wave-orchestration/dispatch.ts` (worker prompt),
  `skills/worker*/SKILL.md`, `skills/reviewer/SKILL.md`, `skills/wave-flow-checker/SKILL.md`,
  `skills/roadmap-milestone-checker/SKILL.md`, `docs/design.md`, `src/core/plan-validation.ts`
  (decision-completeness error only), `test/state/helpers.ts`.
- Resilience: `src/core/events.ts`, `src/core/files.ts`, `src/core/validation.ts`.
- Lifecycle: `src/core/store/roadmap.ts`, `src/core/store/index.ts`,
  `src/core/report/next-action.ts`, `src/extension/commands/prompts.ts`.
- Capabilities: `src/core/usage.ts`, `src/core/report/shared.ts`, `src/core/plan-validation.ts`,
  `src/extension/commands/{catalog,register}.ts`.
- Context efficiency: `src/tools/register/*.ts` (compact `textResult` serialization),
  `src/core/state-summary.ts` + `src/tools/register/context-tools.ts` (`active_wave` scope),
  `src/core/wave-orchestration/review.ts` (reviewer package notes),
  `skills/{reviewer,worker*,implementation-orchestrator,milestone-planner,roadmap-planner}/SKILL.md`,
  `src/extension/commands/prompts.ts` (preamble scope rule).
- Operational gaps (Part 7): `src/core/wave-orchestration/{review,worker-runs}.ts` +
  `src/extension/commands/prompts.ts` (durable result handoff / collect from state), the write-gate
  path in `src/core/validation.ts` (rework edit-gate deadlock), note-writing in the store +
  stand-down flow (stale `issue/deferred` note reconciliation), and the `job`/`job list` status
  source feeding the orchestrator (placeholder + process-exit-vs-task-failed).

## Sequencing
1. Part 1 (types+serialization → worker-runs → prepareWorkerRedispatch+prompt → config → prompt/SKILL).
2. Part 2 (worker prompt reserved-siblings section → worker/reviewer/checker skills + design.md →
   decision-completeness error → **fixture updates**).
3. Part 3, Part 4 (independent).
4. Part 6 (context efficiency: compact serialization → `active_wave` scope → reviewer package →
   skill/preamble guidance).
5. Part 7 (operational gaps: durable result handoff + edit-gate deadlock are the higher-value pair;
   note hygiene and `job list` observability are independent and can land any time after Part 1).
6. Part 5 (capabilities tail).
7. Tests throughout.

## Verification
- `bun run check` (tsc) and `bun test` green.
- **New/updated tests:**
  - `test/state/wave-orchestration.test.ts`: `transport_failures` increments and survives reload
    (covers `normalizeWorkerRun`); `prepareWorkerRedispatch` **rejects while a run is running**;
    `prepareWorkerRedispatch` flips `transport_failed→abandoned` and returns a prompt containing
    `CONTINUATION CONTEXT`, `history://<agentId>`, and the prior `transport_failures`;
    `record_worker_dispatch` records `replaces_agent_id`.
  - `test/commands.test.ts` (milestone:implement): assert the bounded resume-loop wording, the
    stop-peer-before-abandon ordering, `roadmap_engineer_prepare_worker_redispatch`, and
    continuation/`history://`; confirm the configured cap renders (default 3). **Also assert the
    reframed protocol:** the prompt states an ack is a liveness signal (not grounds to abandon),
    that a 2-min *result* silence is not death, to consume the `await:true` reply instead of a
    second `op:wait`, that `op:list` (not `job`) is the liveness authority, and to re-run `op:list`
    immediately before abandoning. Assert **no** "abandon after 2 min" / "abandon after first failed
    resume" wording survives.
  - `test/state/lifecycle.test.ts`: `decisions`/`dependency_analysis` missing → error; present →
    validates. Confirm no new sequencing/ownership hard blocks were added (a plan whose task
    edits a file owned by another wave still validates and approves).
  - Worker-prompt test (`test/state/wave-orchestration.test.ts` or dispatch test): the assignment
    prompt lists same-wave siblings' files as reserved and states other-wave files are editable.
  - New tests for `clearActivePointer`/auto-archive (new roadmap after `complete`), tolerant
    `parseEvents` (a torn line is skipped, valid events still returned), and `notes.malformed`
    now bypassable.
  - Context efficiency: tool output is compact (no indented JSON) while `details` is unchanged;
    `read_state` scope `active_wave` returns only the active wave + its tasks (not the full
    milestone/roadmap); `prepareWaveReview` package includes the wave's worker notes. Add/extend
    tests in `test/tools/*` and any state-summary/context test.
  - Rough before/after token check: capture the reviewer's opening context calls on a sample
    milestone and confirm a meaningful reduction (target the several-thousand-line opener down to
    a wave-scoped fraction) with the wave's tasks + worker notes still present.
  - Part 7: `record_wave_result` can source its summary from the resolved worker note when the peer
    is gone (7a); the write-gate permits the assigned rework worker to edit its blocker's files
    without a prior `resolve_blocker` (7b); a stood-down/abandoned worker's `issue/deferred` note is
    reconciled/retracted once the task resolves (7c).
- **Behavioral walkthrough:** reason through the generated milestone:implement prompt for
  (a) one socket failure → resume same worker; (b) N=cap failures → stop peer, abandon,
  `prepare_worker_redispatch`, replacement prompt carries continuation context; (c) resumed
  session where `irc list` is empty → abandon + redispatch with continuation. Confirm no path
  spawns a replacement while a run is `running`.
- **Regression walkthrough for the captured bug (must hold):** a worker that hits a socket error,
  **acks the resume, then stays silent on a *final result* for 2 min while `op:list` still shows it
  `running`** is **NOT** abandoned — the prompt must keep monitoring (longer wait / activity-age),
  consume the `await:true` reply instead of firing a second `op:wait`, treat the ack as liveness,
  ignore a stale `job failed` status in favor of `op:list`, and require a fresh `op:list` re-check
  immediately before any `record_worker_abandoned`. Confirm the replacement prompt tells the worker
  a prior peer may be live and to confirm it is stopped before editing.
- **Part 7 walkthroughs:** (7a) a completed worker whose peer is gone → orchestrator collects the
  result from the worker's resolved note, not a live IRC reply; (7b) a rework worker can edit the
  files under the blocker it was dispatched to fix without first resolving the blocker; (7c) a
  stood-down worker's `issue/deferred` note does not survive as a dangling issue once the task
  resolves.
- Consistency grep: transport protocol wording matches across `prompts.ts`, `SKILL.md`, and the
  `dispatch.ts` instruction strings; config cap default (3) consistent; **no residual
  "abandon after 2 min" / "abandon after first failed resume" wording remains** in `prompts.ts` or
  any `SKILL.md`.
