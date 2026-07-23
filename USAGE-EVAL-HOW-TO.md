# Agent Guide: Evaluating oh-my-roadmap from Exported OMP Sessions

## Purpose

Use these session bundles to evaluate **oh-my-roadmap (OMR)**—the OMP extension in `/Users/eamon/Development/Agents/omp-engineer`—and recommend
evidence-based improvements without loading entire transcripts into context.

OMR is a strict, state-driven workflow for roadmap planning, milestone planning, implementation waves, reviews, blockers, closeout evidence, ad-hoc
plans, reusable scout findings, and code-style guidance. The evaluation should determine whether its tools, prompts, skills, gates, and generated
agent roles caused agents to follow that workflow correctly and efficiently.

**Start with the indexes. Do not read a complete transcript unless targeted inspection cannot answer the question.** The indexes are navigation maps;
the copied JSONL transcripts are the source of truth for selected evidence.

This guide describes how to analyze the exported files. It does not describe how to run the export tool.

## Bundle layout

A bundle normally looks like this, where a bundle contains sessions for a new roadmap, milestone planning, or milestone implementing:

```text
<bundle>/
  <primary-transcript>.jsonl
  <primary-transcript>-index.md       # when Markdown output is present
  <primary-transcript>-index.json     # when JSON output is present
  <sub-agent-name>/
    <sub-agent-transcript>.jsonl
    <sub-agent-transcript>-index.md
    <sub-agent-transcript>-index.json
```

The primary transcript and its indexes are at the bundle root. Each sub-agent transcript is in its own inferred directory. A bundle may contain only
one index format, and a primary-only session may have no sub-agent directories.

Each transcript is copied byte-for-byte from OMP storage. Index locations therefore point into the copied transcript associated with that index.

## Evaluation target: oh-my-roadmap

### Intended workflow contract

For roadmap work, OMR's canonical lifecycle is:

```text
discovery
  -> roadmap_draft
  -> roadmap_approved
  -> milestone_planning
  -> milestone_approved
  -> implementing
  -> reviewing
  -> closeout
  -> complete
```

OMR also supports a roadmap-free ad-hoc lifecycle:

```text
adhoc_draft -> adhoc_approved -> implementing -> reviewing -> closeout -> complete
```

The plugin is intentionally strict:

- planning must be grounded in repository inspection, relevant documentation, and user interviews;
- roadmap approval requires recorded discovery, a finalized roadmap, a passed `roadmap-milestone-checker`, validation, and explicit user approval;
- milestone/change/ad-hoc approval requires concrete tasks, dependencies, waves, exclusive ownership, verification, a passed `wave-flow-checker`,
  validation, and explicit user approval;
- implementation is wave-oriented and delegated to workers; the primary orchestrator must not edit code;
- workers persist notes, reviewers verify completed waves, and blocking findings stop dependent work;
- closeout requires evidence for every acceptance criterion and verification command;
- direct file writes are gated outside legal implementation states;
- compact state/context tools should prevent agents from reading large `.omr` artifacts directly.

Judge observed behavior against this contract, not against a generic project-management workflow.

### OMR surfaces visible in transcripts

OMR behavior is broader than calls whose indexed tool name begins with `omr_`.

1. **Slash-command prompts** — user messages such as `/omr:rm-new`, `/omr:ms-plan`, `/omr:ms-implement`, `/omr:adhoc-*`, `/omr:chg-*`, and
   `/omr:blk-*` inject workflow instructions into the primary session.
2. **Logical OMR tools** — depending on the OMP version, these may appear directly as `omr_*` calls or as a `write` call whose path is `xd://omr_*`.
   Treat both forms as OMR calls. Inspect the full call arguments when the index only shows the `write` path.
3. **Built-in `ask`** — OMR requires the primary/planning agent to interview the user for material decisions and approvals. Workers and reviewers
   should record blockers instead of asking the user directly.
4. **Built-in `task`** — OMR dispatches specialized roles: `worker-light`, `worker`, `worker-heavy`, `reviewer`, `wave-flow-checker`,
   `roadmap-milestone-checker`, and `style-scout`.
5. **Built-in `hub`** — implementation orchestration uses peer/job coordination, waits, worker recovery, and rework through `hub`.
6. **Write-gate responses** — a failed `write`, `edit`, or other direct file-write call may be an intentional OMR gate decision even though its tool
   name is not `omr_*`.
7. **Plugin side effects** — usage tracking and optional Moshi notifications are extension events. A successful tool transcript does not prove those
   fire-and-forget side effects were delivered.

### Registered logical OMR tools

Use this inventory to classify calls and detect missing or inappropriate steps:

| Family                         | Tools                                                                                                                                                                                                                                          |
|--------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Roadmap lifecycle              | `omr_init`, `omr_update_roadmap`, `omr_repair_roadmap`                                                                                                                                                                                         |
| Focused state and context      | `omr_read_state`, `omr_search_context`, `omr_read_context`, `omr_read_events`, `omr_list_quality_gates`                                                                                                                                        |
| State transitions and closeout | `omr_transition`, `omr_prepare_closeout`                                                                                                                                                                                                       |
| Notes and blockers             | `omr_append_note`, `omr_open_blocker`, `omr_resolve_blocker`, `omr_defer_blocker`, `omr_list_blockers`                                                                                                                                         |
| Wave orchestration             | `omr_prepare_wave_dispatch`, `omr_record_worker_dispatch`, `omr_prepare_worker_redispatch`, `omr_record_worker_transport_failed`, `omr_record_worker_abandoned`, `omr_record_wave_result`, `omr_prepare_wave_review`, `omr_record_wave_review` |
| Validation and reporting       | `omr_validate`, `omr_next_action`, `omr_apply_next_action`, `omr_render_report`, `omr_submit_findings_report`                                                                                                                                  |
| Amendments and changes         | `omr_amend`, `omr_create_change_request`                                                                                                                                                                                                       |
| Ad-hoc plans                   | `omr_init_adhoc`, `omr_update_adhoc_plan`, `omr_adhoc_transition`                                                                                                                                                                              |
| Reusable discovery             | `omr_record_scout_finding`, `omr_list_scout_findings`                                                                                                                                                                                          |
| Code style                     | `omr_set_style`, `omr_style_guide`                                                                                                                                                                                                             |
| Visualization                  | `omr_render_dependency_graph`                                                                                                                                                                                                                  |

### Source anchors for recommendations

When source access is available, map evidence to the narrowest owning surface:

| Concern                                                      | Source area under `/Users/eamon/Development/Agents/omp-engineer`        |
|--------------------------------------------------------------|-------------------------------------------------------------------------|
| Tool names, schemas, descriptions, and result formatting     | `packages/extension/src/tools/register/`                                |
| Slash-command workflow prompts                               | `packages/extension/src/extension/commands/prompts.ts` and `catalog.ts` |
| Roadmap, milestone, and implementation rules                 | `packages/extension/skills/*/SKILL.md`                                  |
| Worker/reviewer/checker behavior                             | `packages/core/agent-templates/*/AGENT.md`                              |
| State transitions, persistence, validation, and write gating | `packages/core/src/store/`, `validation*`, and `gate.ts`                |
| Wave dispatch, worker leases, recovery, and review           | `packages/core/src/wave-orchestration/`                                 |
| State/context summaries and next-action guidance             | `packages/core/src/state-summary*`, `context*`, and `report/`           |
| Moshi behavior                                               | `packages/extension/src/extension/moshi-notifications.ts`               |

Do not recommend changing a tool schema when the evidence actually points to a slash-command prompt, skill, generated agent template, core state
invariant, or OMP runtime behavior.

## What each file is for

### `*-index.md`: fast human-readable triage

Read this first when exploring a session. It provides:

- session-level model, message, tool-call, error, token, and cost totals;
- one compact row per user/assistant message, tool call, or tool result;
- tool names, success/failure markers, intent labels, and selected details;
- source line ranges for targeted transcript reads.

Markers are:

- `→`: tool call
- `✓`: successful tool result
- `✗`: failed tool result

Use the Markdown index to identify suspicious or relevant regions, not as a complete account of the interaction.

### `*-index.json`: filtering, counting, and precise navigation

Use the JSON index when you need to search or aggregate entries, isolate calls to plugin tools, find failures, or extract exact source ranges.

Its top-level shape is:

```json
{
	"meta": {
		"...": "session rollups"
	},
	"entries": [
		{
			"...": "one navigable event"
		}
	]
}
```

### `*.jsonl`: authoritative transcript evidence

Read only selected records or narrow neighborhoods from this file. Inspect the transcript when the index summary is insufficient—for example, to see
full tool arguments, full results, surrounding reasoning, user intent, recovery behavior, or the exact error payload.

## JSON index field reference

### `meta`

| Field           | Meaning                                                                                                                                     |
|-----------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| `source`        | Absolute path of the copied transcript when the index was generated. If the bundle was moved, use the transcript next to the index instead. |
| `model`         | Model label recorded for the session.                                                                                                       |
| `messageCount`  | Number of indexed source messages.                                                                                                          |
| `toolCallCount` | Number of tool calls across all tools, not only the plugin under evaluation.                                                                |
| `errorCount`    | Number of tool results marked as errors across all tools.                                                                                   |
| `totalTokens`   | Sum of recorded assistant-message token usage.                                                                                              |
| `totalCost`     | Sum of recorded assistant-message cost.                                                                                                     |

### `entries[]`

| Field       | Meaning                                                                                                           |
|-------------|-------------------------------------------------------------------------------------------------------------------|
| `n`         | Zero-based source-message index. Several entries can share one `n`.                                               |
| `byteStart` | Zero-based byte offset of the source record.                                                                      |
| `byteEnd`   | Exclusive byte offset immediately after the source record. The byte interval is `[byteStart, byteEnd)`.           |
| `lineStart` | One-based first source line.                                                                                      |
| `lineEnd`   | One-based inclusive last source line.                                                                             |
| `kind`      | Usually `user`, `developer`, `assistant`, `tool-call`, or `tool-result`.                                          |
| `role`      | Original message role.                                                                                            |
| `tool`      | Tool name for a call or result.                                                                                   |
| `ok`        | `true` or `false` for a tool result; `null` otherwise.                                                            |
| `intent`    | The compact intent label supplied with the tool call and reused on its result when available.                     |
| `detail`    | Selected arguments or a short result summary. It is not the complete payload.                                     |
| `thinking`  | Whether the assistant message contained a thinking block. It does not expose that block's content.                |
| `tokens`    | Assistant-message token usage, attached once to avoid double counting when a message contains several tool calls. |
| `cost`      | Assistant-message cost, attached once for the same reason.                                                        |

Multiple tool calls in one assistant message share the same `n` and source range. Treat identical ranges as one source record, not duplicate
transcript content.

## Recommended OMR analysis workflow

### 1. Classify each bundle by invoked workflow

Use the initial user messages and early calls to identify the command and phase:

- roadmap creation/reopening: `/omr:rm-new`, `/omr:rm-reopen`;
- milestone planning: `/omr:ms-plan`;
- milestone/change implementation: `/omr:ms-implement`;
- post-implementation change: `/omr:chg-request`;
- closeout/status/blocker recovery: `/omr:ms-close`, `/omr:chg-close`, `/omr:*status`, `/omr:blk-*`;
- ad-hoc planning/implementation: `/omr:adhoc-*`;
- style learning: `/omr:learn-style`.

Do not combine all bundles into one undifferentiated call-count analysis. Each command has different required tools, agents, approvals, and terminal
conditions.

### 2. Inventory OMR activity without opening transcripts

For every primary and sub-agent JSON index, record:

- initiating workflow and apparent starting state;
- model and message count;
- logical OMR calls, including `write` calls to `xd://omr_*`;
- OMR call/result counts by tool;
- OMR failures (`kind == "tool-result"` and `ok == false`);
- `ask`, `task`, and `hub` activity relevant to the workflow;
- direct write/edit failures that may come from OMR's gate;
- repeated intents, repeated validations, repeated state reads, and high-token regions;
- which generated agent roles have sub-agent transcripts;
- whether `omr_submit_findings_report` occurred, and how many times.

The `meta` totals describe the whole transcript. Compute OMR-specific metrics from `entries[]`; do not treat `meta.toolCallCount` or `meta.errorCount`
as plugin-only.

### 3. Check the expected protocol for that workflow

Use these sequences as evaluation checkpoints, not as assumptions that the agent complied.

#### Roadmap planning

Look for:

```text
inspect repository/docs + interview user
  -> omr_init / record discovery
  -> omr_update_roadmap
  -> task(roadmap-milestone-checker)
  -> record_roadmap_milestone_check
  -> omr_validate
  -> explicit user approval
  -> approve_roadmap
```

Flag approval before a current passed checker result, missing discovery/research evidence, guessed external dependencies, tiny/filler milestone
outlines, missing user decisions, or milestone-level tasks/waves created during roadmap planning.

#### Milestone or change planning

Look for focused state/context orientation, repository inspection, explicit test-coverage discussion, concrete tasks before dependency/wave
construction, exact worker assignments, non-overlapping same-wave ownership, then:

```text
create/update plan
  -> task(wave-flow-checker)
  -> record_wave_flow_check
  -> omr_validate
  -> explicit user approval
  -> approve milestone/change
```

Also check whether the planner used `omr_list_scout_findings` before broad scouting and recorded durable new discoveries with
`omr_record_scout_finding`.

#### Ad-hoc planning

Expect `omr_init_adhoc` or `omr_update_adhoc_plan`, a `wave-flow-checker`, `omr_adhoc_transition(record_wave_flow_check)`, validation, user approval,
and `omr_adhoc_transition(approve)`. Ad-hoc plans should still have concrete tasks, waves, ownership, verification, and closeout evidence.

#### Wave implementation

Expect the primary agent to orchestrate rather than edit:

```text
focused omr_read_state + omr_validate
  -> start_implementation/start_implementing when needed
  -> omr_prepare_wave_dispatch
  -> task(exact assigned worker role)
  -> omr_record_worker_dispatch
  -> hub wait/coordination
  -> omr_record_wave_result
  -> omr_prepare_wave_review
  -> task(reviewer)
  -> omr_record_wave_review
  -> next wave or closeout_ready
```

Check these invariants:

- only the active wave is dispatched;
- worker role matches the plan's `worker-light`, `worker`, or `worker-heavy` assignment;
- every spawn is followed promptly by `omr_record_worker_dispatch`;
- the primary orchestrator does not write implementation files;
- workers append scoped notes and do not ask the user;
- workers do not run project builds/tests while siblings may be incomplete;
- the reviewer, not the worker or primary orchestrator, performs wave verification;
- dependent waves do not start before review passes;
- all waves continue in the same command turn unless a real terminal blocker, needs-input state, or error stops the run;
- `omr_submit_findings_report` appears exactly once at the terminal point, not after every wave.

#### Worker transport recovery and rework

Transport/socket/provider failures are orchestration interruptions, not implementation blockers. For relevant traces, check for:

```text
omr_record_worker_transport_failed
  -> hub op:list
  -> direct hub op:send to the existing peer
  -> bounded wait/resume
```

The agent should not mark the task failed/blocked merely because a job process exited while the peer remains live. Abandonment and replacement should
occur only after the peer is absent/non-revivable or the configured resume cap is exhausted, followed by `omr_record_worker_abandoned`,
`omr_prepare_worker_redispatch`, replacement spawn, and a dispatch record with `replacesAgentId`.

For worker-fixable review findings, expect the orchestrator to wake the original worker with narrow rework instructions and re-run review. A canonical
blocker should be reserved for a genuine user decision, scope ambiguity, or non-worker-fixable condition.

#### Closeout

Look for `omr_prepare_closeout`, evidence covering every acceptance criterion and verification command, worker-note review, review summary, risk
disposition, `record_closeout`, and the legal completion/close transition. Deferred evidence needs a reason and approver.

### 4. Evaluate context-efficiency behavior

OMR specifically intends to prevent large `.omr` reads. Find evidence for or against:

- narrow `omr_read_state` scopes (`phase`, `progress`, `quality_gates`, `active_wave`, `active_milestone`, and so on) instead of repeated `compact`
  reads;
- `omr_search_context` using `count`/`ids` before snippets or bodies for broad discovery;
- `omr_read_context` only for selected IDs;
- avoidance of direct full reads of `.omr/**/roadmap.md`, `plan.md`, `state.yml`, or long notes when focused tools could answer;
- use of compact receipts and `next_actions` instead of requesting full state after every transition;
- reuse of scout findings instead of rediscovering the same subsystem.

Repeated focused calls can be correct; repeated broad calls with no new decision are stronger evidence of friction.

### 5. Select evidence before reading transcript content

Prioritize:

- failed OMR results and the calls immediately preceding them;
- invalid transitions, stale quality gates, gate rejections, and the agent's recovery;
- approval moments and the checker/validation/user evidence preceding them;
- repeated calls with unchanged intent or payload;
- any primary-agent implementation edit during `/omr:ms-implement` or `/omr:adhoc-implement`;
- missing or mismatched worker dispatch records;
- transport errors, liveness decisions, abandonment, and redispatch;
- review failures and whether they led to rework or unnecessary blockers;
- full `.omr` artifact reads that bypass compact context tools;
- successful calls that materially reduced exploration or kept state consistent;
- final assistant messages and the single terminal findings report;
- differences between primary, worker, reviewer, and checker behavior.

Choose a small set of message numbers or source ranges. Merge identical and overlapping ranges before reading them.

### 6. Read narrow transcript neighborhoods

Start with the exact `lineStart`–`lineEnd` or `[byteStart, byteEnd)` range. Add only the preceding or following message when context is missing.

Byte offsets are byte positions, not character positions:

```python
with open(transcript_path, "rb") as transcript:
    transcript.seek(entry["byteStart"])
    record = transcript.read(entry["byteEnd"] - entry["byteStart"])
```

For OMP JSONL, the extracted value is the complete event envelope; the conversational message is normally in its `message` field. Parse only the
fields needed for evaluation instead of dumping a large tool result into context.

When correlating a call and result:

1. use index order, `n`, `tool`, and `intent` to identify the likely pair;
2. inspect the selected transcript records;
3. for `write` calls to `xd://omr_*`, decode the path as the logical tool name and inspect the JSON content for its arguments;
4. if ordering is ambiguous, correlate full records using tool-call identifiers.

### 7. Compare primary and specialized-agent evidence

The root transcript is the primary/planner/orchestrator session. Subdirectories may correspond to workers, reviewers, or checkers, but names are
inferred and can receive numeric collision suffixes. Confirm each role from transcript content.

Evaluate role-specific compliance:

- **Primary/planner** — interviews the user, owns approvals and state transitions, and does not prematurely delegate decisions.
- **Implementation orchestrator** — dispatches and coordinates but does not edit or review code itself.
- **Workers** — stay within assigned ownership, inspect style guidance, implement, and persist notes without asking the user.
- **Reviewer** — reviews the completed wave, runs verification, and returns actionable findings.
- **Wave-flow checker** — checks dependency, ownership, and verification-flow contradictions before approval, never during implementation.
- **Roadmap-milestone checker** — checks milestone boundaries and sequencing before roadmap approval.
- **Style scout** — derives per-language guidance from representative source and records only evidenced guidance.

### 8. Form findings from cited evidence

For every substantive finding, record:

| Evidence              | What to record                                                                             |
|-----------------------|--------------------------------------------------------------------------------------------|
| Workflow/session      | Command or phase plus primary/sub-agent transcript basename                                |
| Location              | Message `n` and `lineStart`–`lineEnd`; include byte offsets when useful                    |
| Expected OMR contract | The tool, prompt, skill, role, or invariant that should govern the behavior                |
| Observation           | What the call, result, or surrounding messages directly show                               |
| Impact                | Effect on correctness, state integrity, context use, latency, or user outcome              |
| Likely owning surface | Tool registration, command prompt, skill, agent template, core state logic, or OMP runtime |
| Recommendation        | The smallest concrete OMR change likely to improve the behavior                            |
| Confidence            | High, medium, or low, based on evidence quality and sample size                            |

Distinguish direct observations from inference. An error is evidence of a failed invocation, not automatically a plugin defect. Check arguments,
state, gate conditions, result guidance, recovery, and repetition.

## OMR evaluation dimensions

Assess each dimension only where the reviewed workflow provides evidence:

1. **Command-to-workflow adherence** — Did the injected `/omr:*` command prompt produce the required sequence and terminal behavior?
2. **State-machine guidance** — Did agents understand legal phases, transitions, quality gates, approvals, and `next_actions`, or repeatedly attempt
   invalid operations?
3. **Planning quality** — Were roadmap boundaries substantive, milestone tasks decision-complete, ownership exclusive, dependencies valid,
   verification explicit, and user decisions closed?
4. **Context efficiency** — Did focused state/search/read tools replace large `.omr` reads and redundant rediscovery?
5. **Tool contract quality** — Were tool names, descriptions, operation-specific schemas, receipts, errors, and next-action hints sufficient for
   correct calls?
6. **Write-gate behavior** — Did the gate prevent illegal edits while permitting legal worker/rework edits? Were rejection messages actionable?
7. **Delegation correctness** — Were checker, worker, and reviewer roles dispatched at the right phase with the exact planned role and ownership?
8. **Wave orchestration integrity** — Were dispatch leases, results, reviews, progress, and sequential waves recorded without duplicate live workers
   or skipped gates?
9. **Recovery quality** — Were transport failures separated from implementation blockers, live peers resumed, replacements safely gated, and rework
   routed back to the right worker?
10. **Blocker semantics** — Were canonical blockers reserved for real user decisions or external impediments rather than ordinary code corrections or
    transport failures?
11. **Closeout evidence** — Were acceptance, verification, worker notes, review, risks, and deferred-item approvals complete before closure?
12. **User interaction** — Did the primary agent use `ask` for material decisions and explicit approvals while preventing sub-agents from asking
    directly?
13. **Findings reporting** — Was one concise `omr_submit_findings_report` produced at the correct terminal point?
14. **Cross-role consistency** — Did primary agents, workers, reviewers, and checkers follow their distinct contracts across sessions?
15. **Outcome contribution** — Did OMR improve delivery quality and resumability enough to justify its state/tool overhead?

Useful derived measures include:

- OMR failures per logical tool and workflow phase;
- invalid-transition attempts per session;
- repeated state/context calls with no intervening state change;
- broad `.omr` reads that focused tools could have avoided;
- worker spawns lacking a nearby dispatch record;
- tasks/waves started before prerequisite approval or review;
- transport errors incorrectly converted into blockers;
- reviewer failures resolved through worker rework versus canonical blockers;
- findings-report count per command run;
- tokens/cost by workflow phase and agent role.

Treat these as diagnostic signals, not standalone quality scores.

## Recommendation standard

Recommendations must identify the actual OMR owning surface and be specific enough to implement. Prefer:

- the workflow and indexed evidence showing the problem;
- whether the cause is most likely a tool schema/description, result/error text, slash-command prompt, skill rule, generated agent template, core
  invariant, or runtime integration;
- the exact behavior to change;
- the expected agent behavior afterward;
- a regression test or future transcript signal that would validate the improvement;
- priority based on frequency, state-integrity risk, user impact, and context cost.

Examples of appropriately scoped recommendations:

- clarify one `omr_transition` operation's error/next-action text rather than broadly “improve state guidance”;
- change the `/omr:ms-implement` prompt or implementation skill when the orchestrator violates sequencing that the core tools already enforce
  correctly;
- change a worker template when workers repeatedly test too early or ask the user;
- change wave-orchestration state logic when duplicate live workers are actually permitted, rather than blaming the orchestrator prompt;
- change context-tool defaults when compliant agents still receive oversized or unhelpful results.

Do not recommend weakening a quality gate merely because it correctly rejected incomplete state. First decide whether the rejection exposed an
agent/prompt failure, a confusing contract, or an incorrect invariant.

## Suggested final report

1. **Executive summary** — overall OMR performance, strongest behavior, and highest-impact defect.
2. **Sample reviewed** — bundles, commands/phases, primary and sub-agent roles, models, and analysis limits.
3. **Workflow scorecard** — required checkpoints observed, missing, out of order, or not applicable for each session.
4. **Observed strengths** — successful state guidance, context reduction, delegation, recovery, review, or closeout behavior with indexed citations.
5. **Failure and friction patterns** — grouped by root cause and owning OMR surface, not merely chronology.
6. **Context and cost findings** — broad reads, redundant calls, oversized results, role/phase token concentration, and work avoided by OMR.
7. **State and orchestration integrity** — approvals, quality gates, write gating, worker leases, reviews, blockers, and recovery.
8. **Prioritized recommendations** — concrete source area, proposed behavior, expected impact, and validation signal.
9. **Evidence appendix** — workflow, transcript, role, message number, line/byte range, expected contract, and concise observation.

## Guardrails

- Do not read every transcript from beginning to end by default.
- Do not treat every `omr_*` failure as a defect; valid state/gate rejections are part of the product.
- Do not miss OMR calls transported as `write` to `xd://omr_*`.
- Do not treat every failed direct write as unrelated; inspect whether OMR's write gate produced the rejection.
- Do not attribute built-in model, repository, provider, or OMP runtime failures to OMR without evidence.
- Do not treat a worker job's terminal process status as proof that the underlying peer or task failed.
- Do not classify transport failures as implementation blockers.
- Do not assume a successful tool result was useful or that its required side effects were observed.
- Do not infer Moshi delivery from the OMR tool result; notification delivery is fire-and-forget and may need separate trace evidence.
- Do not treat `detail` as the complete tool call or result.
- Do not sum `tokens` or `cost` across duplicate entries without accounting for shared source messages.
- Do not assume `meta.source` remains valid after a bundle is moved; prefer the adjacent copied transcript.
- Do not infer a sub-agent role solely from its inferred output-directory name.
- Do not recommend prompt changes when the defect is in core state logic, or core changes when the agent simply violated an explicit prompt/skill.
- Do not cite an index summary as if it contained full reasoning or payload content.
- Do not make recommendations without precise indexed evidence or a clearly marked inference.
