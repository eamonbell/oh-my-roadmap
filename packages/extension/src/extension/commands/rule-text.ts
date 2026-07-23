// Single-source canonical prose for the rule families that are duplicated between the
// runtime command prompts (prompts.ts) and the human-readable skill docs
// (packages/extension/skills/*/SKILL.md). Keeping the substantive rule text here means the
// prompt and the skill can never silently drift: prompts.ts interpolates these consts, and
// test/skill-rule-drift.test.ts asserts each SKILL.md still contains the canonical text
// (whitespace/markdown-normalized). Only two rule families are single-sourced here — the
// worker recovery/rework rule and the reviewer rework rule (both implementation-only) and the
// scout-recording rule (planner-only). Unrelated invariants stay where they live.
//
// Voice: bare tool/op names (no backticks) so the text drops straight into the prompt
// template. The skill copies may add markdown backticks/bold/bullets for readability; the
// drift test strips those before comparing, so formatting may differ but the words may not.

// The prompt's configured transport-resume cap defaults to this; the skill docs and the drift
// test document/verify the same default.
export const DEFAULT_TRANSPORT_RESUME_ATTEMPTS = 3

// (a) WORKER recovery/rework rule. Covers hub-messaging recovery/rework (wake the existing
// worker before spawning a replacement) and the transient-transport-failure resume-or-abandon
// sequence. R7: omr_record_worker_abandoned -> omr_prepare_worker_redispatch is a valid
// sequence (redispatch accepts abandoned as well as transport_failed runs), and
// history://<agentId> is session-scoped so persisted worker notes are the cross-session memory.
export function workerReworkRule(resumeCap: number = DEFAULT_TRANSPORT_RESUME_ATTEMPTS): string {
	return `Hub messaging recovery/rework pattern (prefer waking the existing worker over spawning a replacement):
- Before recovering or reworking a run, use the built-in hub tool op:list to get the worker's exact peer id and status (running, idle, parked, or aborted).
- Message the worker directly with op:send to that exact peer id; never broadcast with to:"all" (broadcast skips parked peers and can wake unrelated agents). Do not resend to a worker that is still running.
- Interpret the delivery receipt: injected = the worker is running and will see the message at its next step boundary, so do not resend; woken = it was idle and a real turn started; revived = it was parked and OMP revived it; failed = it could not be delivered.
- Use op:send await:true or op:wait only when you are blocked on the reply; do not treat a wait timeout as failure, because the worker may still be running.
- Spawn a replacement only when the worker is aborted or non-revivable, when op:list does not list it (for example after resuming in a new session where the old subagent no longer exists), or when delivery returns failed. history://<agentId> is session-scoped: it recovers a worker's transcript only within the session that spawned that agent and is unusable after resuming in a new session, so the worker's persisted notes are the cross-session memory of record.

Transient transport failure (bounded resume loop, liveness-gated abandonment):
- If a current-session worker job reports socket-close or another transient transport failure, call omr_record_worker_transport_failed, then run a bounded resume loop: hub op:list to find the worker's peer, hub op:send it a narrow resume message ("You stopped after a transport error. Resume from your existing transcript, continue from the last completed step, retry only the interrupted operation, do not redo completed work, and report back."), and wait up to 2 minutes for a reply. Re-resume the same worker up to the configured resume cap of ${resumeCap} attempts (transport_failures is the counter). Never abandon after a single failed resume.
- An acknowledgement is a liveness signal, not a licence to abandon. If the worker acks or resumes it is alive and working; do not then fire a separate op:wait for a final result and treat its timeout as death. A worker-heavy task will not finish inside a 2-minute window, so a 2-minute result silence is not death. If op:send await:true already returned a reply, consume that reply as the liveness signal — do NOT launch a second blocking op:wait for a message that will never come. After acking, keep monitoring with longer waits (op:wait minutes, or op:list activity-age checks), never a fixed short abandon window.
- op:list is the authority for liveness; the hub op:jobs snapshot is not. The op:jobs snapshot can report a crashed-then-resumed run as terminal failed (exit 1) while op:list shows the peer running, and can return an empty or non-text placeholder. A job "failed"/"exited" status means the spawned process exited — that is NOT the same as the task failing when the underlying agent/hub peer survives and resumed. Treat an empty or non-text job snapshot as no signal (never as death). Decide liveness from op:list peer status and activity age only; ignore a stale job terminal state after a transport failure, and never abandon on job output alone.
- Only after the resume cap of ${resumeCap} attempts is hit or the worker is confirmed unreachable: run a fresh hub op:list immediately before omr_record_worker_abandoned — if the peer is running or idle with recent activity, do not abandon. Then stop the peer with hub op:cancel (its job id) and confirm it is gone via op:list (do not leave it parked — parked peers linger for minutes and are auto-revived when messaged), call omr_record_worker_abandoned, then call omr_prepare_worker_redispatch. omr_record_worker_abandoned followed by omr_prepare_worker_redispatch is a valid sequence: prepare_worker_redispatch accepts an abandoned or transport_failed run and refuses only while a run is still running, so a replacement can never collide with a live peer. Spawn the replacement with the returned prompt (it carries continuation context, the prior worker's history://<agentId> transcript when the same session still holds it, and a live-peer coordination warning), then call omr_record_worker_dispatch with the new agentId and jobId and replacesAgentId set to the prior worker's agentId.
- A transport, socket, or provider error is an orchestration interruption, not an implementation blocker. Never call omr_record_wave_result with failed or blocked for a transport error; that path opens a canonical blocking blocker. Route transport errors only through omr_record_worker_transport_failed and then resume-or-abandon. Reserve omr_record_wave_result with failed or blocked for a real implementation failure or blocker the worker itself reports.`
}

// (b) REVIEWER rework rule. R2: record the reviewer identity with omr_record_reviewer_dispatch
// so a failed review can WAKE the same reviewer (via the re_review / prior_reviewer_agent_id /
// prior_findings returned by omr_prepare_wave_review) rather than respawn one; spawn a fresh
// reviewer only for a new session/aborted peer or when rework materially expanded scope.
// Mirrors the worker rule (continuity avoids re-reading the whole wave; fresh eyes only when
// scope grew beyond the flagged findings).
export const REVIEWER_REWORK_RULE = `Wave review and rework (wake the prior reviewer; spawn fresh only on a new session or expanded scope):
- When all active-wave workers are completed, call omr_prepare_wave_review and dispatch the returned reviewer package with the built-in task/subagent mechanism. Immediately after spawning the reviewer, call omr_record_reviewer_dispatch with its agentId and jobId so a failed review can wake that same reviewer instead of respawning one.
- When the reviewer returns findings, classify each blocking finding before recording the review: worker-fixable (a concrete code correction that needs no user decision) versus needs-user-decision (ambiguous acceptance, scope or approval, or risk disposition).
- For worker-fixable findings do not open a blocker: op:list and, if the original worker is still a peer, op:send it (replyTo the finding) narrow rework instructions naming the exact file/symbol/test, what must change, what must not change, and the verification to run; wait for its rework note. If op:list does not list the original worker (new session or aborted), spawn a fresh worker for that task seeded with the findings and the task's persisted worker notes (and history://<agentId> when reachable).
- When dispatching that rework worker, whether waking the original peer or spawning a fresh one, call omr_record_worker_dispatch with reworkOf set to the rework-queue item's id so the resulting run is recorded as a rework dispatch — this makes the redispatch auditable and authorizes owned-file self-verification and the write-gate exemption for that finding.
- Re-review by waking the prior reviewer, mirroring the worker rework rule. A failed omr_prepare_wave_review returns re_review: true with prior_reviewer_agent_id and prior_findings; op:list and, if that prior reviewer is still a peer (parked peers revive automatically when messaged), op:send it the re-review request referencing its prior_findings so it re-checks only the flagged fixes without re-reading the whole wave, then record that re-dispatch with omr_record_reviewer_dispatch. Spawn a FRESH reviewer only when prior_reviewer_agent_id is not listed (new session or aborted) or the rework materially expanded scope beyond the flagged findings, where fresh eyes are warranted. Repeat until the wave is clean.
- A rework worker dispatched to fix an open blocker is authorized to edit the files that blocker covers without first resolving it; the write-gate already permits edits for a task with an active worker run. Do NOT call omr_resolve_blocker merely to open the write-gate — resolve a blocker only when its rework is genuinely done.
- Call omr_record_wave_review with passed only when the wave is clean, and with failed only for findings that genuinely need a user decision.`

// (c) SCOUT-recording rule. R10: record durable repo-structure discoveries at the END of
// discovery/planning REGARDLESS of whether scouting was inline or delegated to scout agents —
// the trigger no longer waits on "after a scout agent returns", so inline scouting records too.
export const SCOUT_RECORDING_RULE = `Before dispatching broad scout agents for a subsystem, call omr_list_scout_findings filtered by subsystem and milestone when known, and pass any relevant prior summaries to the new scouts. At the end of discovery and planning, record a compact finding with omr_record_scout_finding covering durable repo-structure discoveries (test layout and runner, key module map, cross-cutting conventions), whether scouting was inline or delegated to scout agents and regardless of whether a scout agent was ever dispatched.`
