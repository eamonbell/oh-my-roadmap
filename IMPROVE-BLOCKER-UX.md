# Improve Blocker UX

## Purpose

Capture the blocker UX problems found during the `workflow-overhaul` recovery session so a follow-up update can be planned intentionally.

The immediate user-facing issue is that roadmap-engineer exposes blocker lifecycle operations only as agent tools. From the TUI, the user cannot directly list, resolve, or defer blockers. They must prompt an agent to call tools such as `roadmap_engineer_list_blockers`, `roadmap_engineer_resolve_blocker`, and `roadmap_engineer_defer_blocker`, which is indirect, hard to discover, and error-prone when the implementation gate is closed.

## What Happened

- The active roadmap was no longer blocked by roadmap hash drift. `/roadmap:repair` ran as a no-op and recorded that roadmap revision, generated markdown, and the roadmap-milestone check were already aligned.
- The roadmap remained invalid because the active wave had open blocking blockers.
- The real actionable blocker was valid: `aidea-service` still had legacy `AgentID` and `SubAgentID` fields in `mdl/run_trace.go` and `mdl/run_event.go`, contrary to the active milestone's hard-delete/name-cutover requirement.
- Several non-actionable blockers were also open. Some were positive `PASS:` review findings or duplicate summary findings that had been recorded as blocking blockers.
- The user asked which commands to run, but the relevant blocker operations are tool calls, not slash commands available in the TUI.

## UX Problems

1. Blocker operations are not first-class TUI commands.
   - Users can see that blockers exist, but cannot directly run `/blocker:list`, `/blocker:resolve`, or `/blocker:defer`.
   - The practical workaround is to ask `/roadmap:resume` to call the right tools, which relies on agent interpretation.

2. Status output gives IDs but not an operator workflow.
   - `/roadmap:status` and `/roadmap:resume` show blocker IDs and validation errors.
   - They do not provide a clear next-step command that the user can execute directly from the TUI.

3. Failed wave review creates too many blockers.
   - `recordWaveReview` currently opens one blocking blocker per failed-review finding.
   - It does not distinguish positive findings, informational findings, duplicate findings, and actual blocking findings.
   - In the observed case, `PASS:` findings were stored as open blocking blockers.

4. Failed wave review is not idempotent.
   - Re-recording or repeating failed review state can create additional blockers for the same underlying issue.
   - This turns one actionable problem into several validation errors.

5. Blocker resolution is too manual.
   - To clean up blocker noise, the user must know which blockers are real, which are duplicates, and which should be deferred.
   - There is no guided flow for reviewing each blocker and choosing resolve/defer/keep-open.

6. The dashboard does not provide enough blocker controls.
   - `/roadmap:details` can show state and apply safe next actions, but blockers still require agent-mediated tool calls.
   - The user needs a direct control surface for common blocker lifecycle actions.

## Root Causes

- The extension has structured blocker tools but no slash-command wrappers for blocker lifecycle operations.
- The next-action system treats open blocking blockers as something to resolve/defer, but does not expose a safe, concrete action for doing that.
- Review findings are modeled as plain strings, so the system cannot reliably tell positive notes from blocking findings.
- `recordWaveReview` assumes every finding in a failed review should become an open blocking blocker.
- There is no duplicate-detection or source correlation for blocker creation.

## Planning Goals

- Make blocker lifecycle operations directly available from the TUI.
- Make blocker status output actionable without requiring tool-name knowledge.
- Prevent positive or duplicate review findings from becoming blocking blockers.
- Preserve real blockers as strict implementation gates.
- Keep the implementation simple and explicit; avoid broad workflow redesign.

## Candidate Improvements

### Add Blocker Slash Commands

Add command prompts for:

- `/blocker:list`
- `/blocker:resolve`
- `/blocker:defer`
- `/blocker:status`

These can initially be thin prompt wrappers around existing tools. They should:

- Read active state.
- List open blockers with ID, title, severity, scope, status, and short description.
- Ask for a blocker ID when needed.
- Call the corresponding blocker tool.
- Validate after mutation.

### Add Dashboard Controls

Extend `/roadmap:details` with blocker controls:

- View open blockers.
- Resolve selected blocker.
- Defer selected blocker.
- Copy or surface the blocker ID and suggested action.

Keep controls conservative: do not bulk-resolve blockers without explicit user confirmation.

### Improve Failed Review Recording

Change review recording so only actionable blocking findings create blockers.

Options to consider:

- Replace `findings: string[]` with structured findings:
  - `severity: "blocking" | "non_blocking" | "info" | "pass"`
  - `title`
  - `description`
  - optional `dedupeKey`
- For compatibility, keep plain string findings but classify obvious prefixes:
  - `BLOCKING:` opens a blocking blocker.
  - `PASS:` does not open a blocker.
  - Other strings default to blocking only when status is failed, or require reviewer to mark them.
- Store the full review summary as a note/event, but create blockers only for blocking findings.

### Add Duplicate Protection

Prevent repeated failed review recordings from opening duplicate blockers for the same wave/finding.

Possible simple rule:

- When opening review blockers, check existing open blockers for the same roadmap/milestone/wave/title/description.
- If one exists, reuse or report it instead of creating another.

### Add a Blocker Cleanup Flow

Add a command such as `/blocker:triage` or a dashboard action that:

- Lists all open blockers grouped by scope.
- Highlights likely duplicates.
- Highlights likely non-actionable `PASS:` blockers.
- Lets the user approve deferring duplicates and keep real blockers open.

This should still require explicit approval before changing blocker state.

## Acceptance Criteria for a UX Update

- A user can list, resolve, and defer blockers from the TUI without knowing agent tool names.
- `/roadmap:status` or `/roadmap:resume` points users to the correct blocker command when blockers close the gate.
- Failed review output no longer creates blocking blockers for positive `PASS:` findings.
- Repeating failed review recording does not multiply identical blockers.
- Real blockers still close validation and implementation gates until resolved or deferred.
- Tests cover blocker command prompts, blocker lifecycle tools, failed-review blocker creation, duplicate prevention, and validation after blocker cleanup.

## Open Questions

- Should blocker slash commands mutate state directly, or should they prompt an agent to call existing tools?
- Should `/roadmap:details` support interactive blocker selection, or should that wait until after slash commands exist?
- Should failed review require structured findings immediately, or should prefix-based compatibility be added first?
- What is the safest default for unclassified failed-review findings: blocking or non-blocking?
- Should duplicate blocker detection use exact title/description matching, source event IDs, or an explicit dedupe key?
