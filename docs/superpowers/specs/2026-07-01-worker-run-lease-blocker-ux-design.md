# Worker-Run Lease And Blocker UX Design

## Goal

Prevent duplicate roadmap implementation workers after transport failures, and make blocker recovery commands discoverable from slash-command flows.

This update keeps the existing roadmap-engineer state model. Worker-run leases are persisted inside implementation progress runtime state for the active milestone or change request. Blockers remain canonical roadmap blockers in `blockers.yml`.

## Commands

Add thin slash-command prompt wrappers:

- `/blocker:list`
- `/blocker:status`
- `/blocker:resolve <blocker-id> <resolution>`
- `/blocker:defer <blocker-id> <reason>`

The commands prompt the agent to call existing blocker tools, then validate and report the next legal action. `/roadmap:status` and `/roadmap:resume` must show the exact recovery sequence when open blocking blockers close the gate:

1. `/blocker:list`
2. `/blocker:resolve <id> <resolution>` or `/blocker:defer <id> <reason>`
3. `/roadmap:resume`

## Worker-Run Lease

Extend `ImplementationProgress` with `worker_runs`.

Each run records:

- `task_id`
- `wave_id`
- `worker`
- `agent_id`
- `job_id`
- `owned_files`
- `owned_modules`
- `status`
- `started_at`
- `updated_at`
- optional `last_error`

Statuses are:

- Active: `running`, `transport_failed`
- Terminal: `abandoned`, `completed`, `blocked`, `failed`, `cancelled`

`failed` is terminal. A failed run does not block later redispatch once the failure is recorded.

## Core Rules

`roadmap_engineer_prepare_wave_dispatch` continues to return assignment prompts, but it must refuse assignments for tasks with active worker runs. When any active run exists for a task, the tool returns active-run details and instructions to poll or probe instead of redispatching.

`roadmap_engineer_record_worker_dispatch` records `agentId` and `jobId` immediately after spawn, marks the task started, and refuses overlap with:

- another active run for the same task
- another active run with overlapping owned files
- another active run with overlapping owned modules

`roadmap_engineer_record_worker_transport_failed` marks a running run as `transport_failed` with `last_error`. The task remains started, and redispatch remains blocked.

`roadmap_engineer_record_worker_abandoned` marks a `running` or `transport_failed` run as `abandoned` after the 2-minute probe timeout. After abandonment, only that task may be redispatched if dependencies and blockers allow it.

`roadmap_engineer_record_wave_result` closes the active run for the task as `completed`, `blocked`, or `failed` before updating task, wave, and blocker state.

## Transport Failure Flow

When the orchestrator sees socket-close or another transient worker job failure:

1. Call `roadmap_engineer_record_worker_transport_failed`.
2. Probe the original worker by job or IRC.
3. If it responds, collect the final result and call `roadmap_engineer_record_wave_result`.
4. If it does not respond after 2 minutes, call `roadmap_engineer_record_worker_abandoned`.
5. Redispatch only the abandoned task.

Transport failures do not open canonical blockers unless the worker reports a real implementation blocker.

## Review Blockers

Keep `findings: string[]` compatibility.

Review finding classification:

- `PASS:` opens no blocker.
- `INFO:` opens no blocker.
- `NON_BLOCKING:` opens no blocker.
- `NON-BLOCKING:` opens no blocker.
- `BLOCKING:` opens a blocking blocker with the prefix stripped.
- Unclassified failed-review findings remain blocking.

Before opening a review blocker, deduplicate by exact normalized scope, title, and description. Repeated failed review recordings must not create duplicate blockers for the same issue.

## Orchestrator Instructions

Update implementation orchestration prompts:

- Dispatch roadmap workers as background jobs.
- Record the worker run immediately after spawn.
- Never redispatch a task until the previous run is terminal.
- On first real blocker, record it, cancel sibling active runs, pause implementation, and report the recovery commands.
- On transport failure, follow the transport failure flow and do not create a human blocker.

## Tests

Add focused tests for:

- blocker slash commands and prompt contents
- worker-run lease creation
- active-run redispatch refusal
- overlapping ownership refusal
- terminal run cleanup
- abandoned-run redispatch
- transport-failure pause and recovery instructions
- review prefix filtering
- review blocker duplicate prevention

Run:

- `bun run check`
- `bun test`
