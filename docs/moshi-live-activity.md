# Moshi live-activity flows

These diagrams show how each OMR workflow drives its Moshi **live activity** — the single per-session inbox row that updates in place as the flow progresses. Every frame in a flow shares one `sessionId`, so the row is one continuously-updating activity, not separate notifications. The row **title** carries live progress: `planning N/6` during planning and `implementing NN%` during implementation.

**Legend**

- **Quiet** frames (`session_started` / `tool_running` / `tool_finished`) update the row in place — no device alert.
- **PUSH** frames (`approval_required` / `task_complete`) are high-priority device alerts; `approval_required` also flips the row `phase` to `waitingForApproval`.
- Planning stages are the canonical six — `start → explore → interview → plan → checker → approval` — but the counter only advances at the hard tool **checkpoints** (start = 1/6, plan = 4/6, checker = 5/6, approval = 6/6). `explore`/`interview` are agent activity (scout/context/discovery calls and the `ask` tool) counted in the denominator but not surfaced as their own frames.
- Implementation `%` denominator = `1 (start) + all worker tasks + all wave reviews + 1 (closeout)`; it advances as each worker yields and each wave review passes.

```mermaid
flowchart LR
  q["quiet — in-place row update"]:::quiet
  p["PUSH — device alert"]:::push
  classDef quiet fill:#eef2f7,stroke:#8a9bb0,color:#1c2733;
  classDef push fill:#f8d7da,stroke:#dc3545,color:#4a121a;
```

## New roadmap (planning-only)

A roadmap ends at approval and hands off to per-milestone flows; it has no implementation phase of its own.

```mermaid
flowchart TD
  A["omr_init<br/>omr.roadmap.created<br/>planning 1/6"]:::quiet
  B["explore + interview<br/>record_discovery · scouts · ask<br/>(activity — no stage bump)"]:::quiet
  C["omr_update_roadmap<br/>omr.roadmap.finalized<br/>planning 4/6"]:::quiet
  D{"record_roadmap_milestone_check"}
  E["omr.gate.roadmap_passed<br/>planning 5/6"]:::quiet
  F["omr.gate.roadmap_failed"]:::push
  G["approve_roadmap<br/>omr.roadmap.approved<br/>planning 6/6"]:::quiet
  H(["hand off to milestone planning"])

  A --> B --> C --> D
  D -->|passed| E
  D -->|failed| F
  F -. revise .-> C
  E --> G --> H

  classDef quiet fill:#eef2f7,stroke:#8a9bb0,color:#1c2733;
  classDef push fill:#f8d7da,stroke:#dc3545,color:#4a121a;
```

## Milestone plan + implement

```mermaid
flowchart TD
  subgraph PLAN["Planning (N/6)"]
    P1["start_milestone_planning<br/>planning 1/6"]:::quiet
    P2["create/update_milestone_plan<br/>omr.milestone.plan_created<br/>planning 4/6"]:::quiet
    P3{"record_wave_flow_check"}
    P4["omr.gate.wave_flow_passed<br/>planning 5/6"]:::quiet
    P3F["omr.gate.wave_flow_failed"]:::push
    P5["approve_milestone<br/>planning 6/6"]:::quiet
    P1 --> P2 --> P3
    P3 -->|passed| P4
    P3 -->|failed| P3F
    P3F -. revise .-> P2
    P4 --> P5
  end

  P5 --> I0["start_implementation<br/>implementing %"]:::quiet

  subgraph IMPL["Implementation timeline (per wave, loop — advances %)"]
    I1["omr_prepare_wave_dispatch"]:::quiet
    I2["omr_record_worker_dispatch<br/>omr.worker.spawned"]:::quiet
    I3{"omr_record_wave_result"}
    I4["omr.worker.yielded<br/>+1 unit"]:::quiet
    I3B["omr.worker.blocked"]:::push
    I5["omr_prepare_wave_review"]:::quiet
    I6{"omr_record_wave_review"}
    I7["omr.wave.review_passed<br/>+1 unit"]:::push
    I6B["omr.wave.review_blocked"]:::push
    I1 --> I2 --> I3
    I3 -->|done| I4
    I3 -->|blocked| I3B
    I3B -. redispatch .-> I1
    I4 --> I5 --> I6
    I6 -->|complete| I7
    I6 -->|blocked| I6B
    I7 -. next wave .-> I1
  end

  I0 --> I1
  I7 --> C1["start_reviewing → start_closeout → record_closeout<br/>closeout %"]:::quiet
  C1 --> C2["complete_milestone<br/>implementing 100%"]:::push

  classDef quiet fill:#eef2f7,stroke:#8a9bb0,color:#1c2733;
  classDef push fill:#f8d7da,stroke:#dc3545,color:#4a121a;
```

Also on this flow: `request_bypass` → `omr.bypass.requested` (PUSH); `clear_bypass` (quiet). Change requests reuse the same implementation timeline (`approve_change`/`update_change_request_plan` quiet, `close_change` PUSH).

## Ad-hoc plan + implement

`omr_init_adhoc` records the whole plan in one call, so the flow surfaces from `plan` (4/6) onward; explore/interview still occur via `ask`/scout beforehand.

```mermaid
flowchart TD
  A1["omr_init_adhoc<br/>omr.adhoc.created<br/>planning 4/6"]:::quiet
  A2{"adhoc record_wave_flow_check"}
  A3["omr.adhoc.wave_flow_passed<br/>planning 5/6"]:::quiet
  A2F["omr.adhoc.wave_flow_failed"]:::push
  A4["approve<br/>omr.adhoc.approved<br/>planning 6/6"]:::quiet
  A5["start_implementing<br/>implementing %"]:::quiet
  A6[["shared wave timeline<br/>dispatch → yield → review (advances %)"]]:::quiet
  A7["start_reviewing → record_closeout<br/>closeout %"]:::quiet
  A8{"complete / cancel"}
  A9["omr.adhoc.completed<br/>implementing 100%"]:::push
  A10["omr.adhoc.cancelled"]:::push

  A1 --> A2
  A2 -->|passed| A3
  A2 -->|failed| A2F
  A2F -. revise .-> A1
  A3 --> A4 --> A5 --> A6 --> A7 --> A8
  A8 -->|complete| A9
  A8 -->|cancel| A10

  classDef quiet fill:#eef2f7,stroke:#8a9bb0,color:#1c2733;
  classDef push fill:#f8d7da,stroke:#dc3545,color:#4a121a;
```

## Cross-cutting

While any OMR flow is active, two host events also fire (both PUSH): the `ask` tool → `omr.ask.input_required` (needs input — this is the "interview" signal during planning), and `agent_end` → an `omr.agent.stopped*` / `omr.adhoc.stopped*` summary of what the flow needs next. Their titles also carry the current `planning N/6` or `implementing NN%` progress.

## Debugging

Set `moshi.trace: true` in `.omr/config.yml` (or `OMR_MOSHI_TRACE=1`) to append a per-project decision trace to `.omr/logs/moshi.ndjson` — one JSON record per line for each considered / mapped / suppressed / sending / sent / failed step. Hand that file over when a notification does not behave as expected.
