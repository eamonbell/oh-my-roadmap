# Worker-Run Lease Blocker UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist worker-run leases so transport failures do not cause duplicate roadmap workers, and expose blocker recovery through slash-command prompts.

**Architecture:** Extend the existing milestone/change runtime progress object with `worker_runs`, then add wave-orchestration helpers and registered tools that mutate the same runtime path as task and wave state. Keep blocker commands as prompt wrappers around existing blocker tools, and keep review blocker filtering in `wave-orchestration.ts`.

**Tech Stack:** TypeScript, Bun test runner, existing roadmap-engineer extension APIs, YAML-backed runtime state.

---

### Task 1: Blocker Command Prompt Wrappers

**Files:**
- Modify: `src/extension/commands.ts`
- Modify: `commands/prompts/roadmap-status.md`
- Modify: `commands/prompts/roadmap-resume.md`
- Test: `test/commands.test.ts`

- [ ] **Step 1: Write command tests**

Add tests that assert `/blocker:list`, `/blocker:status`, `/blocker:resolve`, and `/blocker:defer` are registered and their prompts mention the matching blocker tools, validation, and `/roadmap:resume`.

- [ ] **Step 2: Implement command wrappers**

Add the four command names to `COMMANDS`, add command-specific prompt text for each blocker command, and update roadmap status/resume prompt files to show `/blocker:list`, `/blocker:resolve <id> <resolution>`, `/blocker:defer <id> <reason>`, and `/roadmap:resume`.

- [ ] **Step 3: Run command tests**

Run: `bun test test/commands.test.ts`
Expected: command prompt tests pass.

### Task 2: Worker-Run Runtime State

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/store.ts`
- Test: `test/state.test.ts`

- [ ] **Step 1: Write state normalization tests**

Add tests that create a milestone, record a worker dispatch, reload state, and assert `progress.worker_runs` persists with status, job ID, agent ID, owned files, and timestamps.

- [ ] **Step 2: Add worker-run types**

Add `WorkerRunStatus`, `WorkerRun`, and `worker_runs: WorkerRun[]` to `ImplementationProgress`.

- [ ] **Step 3: Normalize runtime worker runs**

Update `normalizeProgress` so missing `worker_runs` becomes `[]`, existing valid worker runs are preserved, and optional `last_error` is retained.

- [ ] **Step 4: Run state tests**

Run: `bun test test/state.test.ts`
Expected: new normalization coverage passes with existing state tests.

### Task 3: Worker-Run Lease Tools

**Files:**
- Modify: `src/core/wave-orchestration.ts`
- Modify: `src/tools/register.ts`
- Test: `test/state.test.ts`
- Test: `test/tools.test.ts`

- [ ] **Step 1: Write lease behavior tests**

Add tests for dispatch recording, active same-task redispatch refusal, active owned-file overlap refusal, active owned-module overlap refusal, transport-failed redispatch refusal, abandoned redispatch allowance, and wave-result terminal cleanup.

- [ ] **Step 2: Implement core helpers**

Add exported functions:

- `recordWorkerDispatch`
- `recordWorkerTransportFailed`
- `recordWorkerAbandoned`

Update `prepareWaveDispatch` to return `active_runs` and poll/probe instructions when active runs exist, instead of assignments for those tasks. Update `recordWaveResult` to close the active run as `completed`, `blocked`, or `failed`.

- [ ] **Step 3: Register tools**

Register:

- `roadmap_engineer_record_worker_dispatch`
- `roadmap_engineer_record_worker_transport_failed`
- `roadmap_engineer_record_worker_abandoned`

Add schemas for `agentId`, `jobId`, `taskId`, `lastError`, and optional target IDs.

- [ ] **Step 4: Run state and tool tests**

Run: `bun test test/state.test.ts test/tools.test.ts`
Expected: lease behavior and tool registration tests pass.

### Task 4: Review Blocker Filtering And Deduplication

**Files:**
- Modify: `src/core/wave-orchestration.ts`
- Test: `test/state.test.ts`

- [ ] **Step 1: Write review tests**

Add tests showing `PASS:`, `INFO:`, `NON_BLOCKING:`, and `NON-BLOCKING:` findings do not open blockers; `BLOCKING:` strips the prefix; unclassified failed-review findings remain blocking; repeated failed review recording does not duplicate the same blocker.

- [ ] **Step 2: Implement finding classification**

Replace `reviewFindings` with a classifier that returns only blocking descriptions and strips `BLOCKING:`.

- [ ] **Step 3: Implement exact duplicate prevention**

Before opening a review blocker, list existing blockers for the same roadmap/milestone/change/wave and reuse exact normalized title/description matches.

- [ ] **Step 4: Run review tests**

Run: `bun test test/state.test.ts`
Expected: review blocker behavior passes.

### Task 5: Orchestrator Prompt Updates And Full Verification

**Files:**
- Modify: `src/extension/commands.ts`
- Modify: `skills/implementation-orchestrator/SKILL.md`
- Test: `test/commands.test.ts`

- [ ] **Step 1: Update implementation instructions**

Update `/milestone:implement` and implementation-orchestrator skill text to require background jobs, immediate worker-run recording, no redispatch until terminal, transport failure probe flow, sibling cancellation on real blockers, and recovery command reporting.

- [ ] **Step 2: Run full verification**

Run: `bun run check`
Expected: TypeScript exits successfully.

Run: `bun test`
Expected: all tests pass.
