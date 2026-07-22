> **Note (omp 17.0.0+):** the standalone `irc`, `job`, and `launch` tools were merged into a single `hub` tool. The peer-messaging ops shown below
> (`list`/`send`/`wait`/`inbox`) are unchanged — invoke them through `hub` (e.g. `hub` with `{"op":"list"}`). The underlying message bus is still
> called IRC internally (incoming messages arrive as `irc:incoming`), so that terminology persists at the bus level.

## Shared orchestration pattern

1. **Find the existing worker.**

```json
{
  "op": "list"
}
```

Use this to get the exact subagent id and status.

Expected useful statuses:

| Status    | Meaning for orchestration                                                                     |
|-----------|-----------------------------------------------------------------------------------------------|
| `running` | Agent is mid-turn. Message is injected at next step boundary.                                 |
| `idle`    | Agent finished but live session remains attached. Message wakes it into a real turn.          |
| `parked`  | Agent was idled out. Direct message revives it, then wakes it.                                |
| `aborted` | Not listed by normal IRC peer listing; terminal state. Cannot be resumed via wake-on-message. |

2. **Send a direct message, not broadcast.**

```json
{
  "op": "send",
  "to": "WorkerId",
  "message": "..."
}
```

Direct send matters because `to:"all"` only targets live peers (`running` / `idle`) and skips `parked` agents. It also risks waking unrelated agents.

3. **Use `await:true` only when the orchestrator is blocked on the answer.**

```json
{
  "op": "send",
  "to": "WorkerId",
  "message": "...",
  "await": true,
  "timeoutMs": 120000
}
```

If not blocked, fire-and-forget, then later use:

```json
{
  "op": "wait",
  "from": "WorkerId",
  "timeoutMs": 120000
}
```

or:

```json
{
  "op": "inbox"
}
```

4. **Interpret the receipt.**

| Receipt            | Orchestrator interpretation                                                              |
|--------------------|------------------------------------------------------------------------------------------|
| `injected`         | Worker was running; message will be seen at next step boundary.                          |
| `woken`            | Worker was idle; a real turn started.                                                    |
| `revived`          | Worker was parked; OMP revived the session, then started the turn.                       |
| `failed — <error>` | Could not deliver/revive. Escalate or create replacement only if recovery is impossible. |

---

# Case 1: Subagent hit a socket connection error and stopped

## Goal

Resume the same subagent so it continues from its own transcript instead of starting over.

This works when the failed subagent is now `idle` or `parked`. OMP task lifecycle keeps finished success/failure sessions registered as follow-up
targets unless they were hard-aborted. A socket/provider/network error usually means the worker stopped with failure and is now interrogable as an
existing agent. `[INFERENCE]`

## Orchestrator flow

### 1. List peers

```json
{
  "op": "list"
}
```

Find the worker that failed, e.g. `ApiMapper`.

### 2. Wake/revive it with explicit continuation instructions

```json
{
  "op": "send",
  "to": "ApiMapper",
  "message": "You stopped after a socket connection error. Resume from your existing transcript and continue the original assignment from the last completed step. Do not restart completed investigation. If a tool call failed due to the socket error, retry only that interrupted operation or choose the narrowest equivalent check. Report back with what you completed and any remaining blocker.",
  "await": true,
  "timeoutMs": 120000
}
```

Why this wording:

- “Resume from your existing transcript” tells the subagent to use its retained context.
- “Continue the original assignment” avoids changing scope.
- “Do not restart completed investigation” prevents duplicate work.
- “Retry only that interrupted operation” targets the socket failure, not a full redo.
- “Report back…” gives the orchestrator a deterministic handoff point.

### 3. Handle outcomes

If receipt is `woken`:

- The agent was live-idle.
- A real turn started immediately.

If receipt is `revived`:

- The agent had parked.
- OMP reopened the session through lifecycle revival, then started the turn.

If receipt is `injected`:

- The agent was still running.
- The message will appear at its next step boundary; do not resend immediately.

If no reply arrives but delivery succeeded:

```json
{
  "op": "wait",
  "from": "ApiMapper",
  "timeoutMs": 120000
}
```

If delivery failed:

- Check whether the agent was isolated or aborted.
- Isolated completed subagents may be parked without a reviver, because their workspace was merged/cleaned.
- Hard-aborted agents are terminal.
- In those cases, use `history://ApiMapper` / prior output to create a replacement only after confirming direct wake is impossible.

## Good message template

```text
You stopped after <exact failure>. Resume from your existing transcript and continue <original task> from the last completed step. Do not redo completed work. Retry only the interrupted operation if needed. If the failure is still blocking, report the precise blocker and the last safe state.
```

## Bad message

```text
Start over and redo the task.
```

That throws away the reason to use hub messaging: the worker already has state.

---

# Case 2: Review failed inspection; wake the original worker for rework

## Goal

Route review feedback back to the same worker that produced the work, because it has the implementation context.

This is exactly where `hub` messaging is better than spawning another subagent. The worker already knows:

- files touched,
- design decisions,
- constraints from the original assignment,
- partial tradeoffs,
- reviewer context if provided,
- likely test/verification state.

A new agent would need to rediscover all of that.

## Orchestrator flow

### 1. Preserve the review findings

The orchestrator should distill the review failure into concrete fixes:

- exact failing file/symbol/test when known,
- what invariant was violated,
- what must change,
- what must not change,
- required verification.

Avoid vague “review failed, fix it.”

### 2. List peers if needed

```json
{
  "op": "list"
}
```

Find the original worker id, e.g. `AuthWorker`.

### 3. Direct-message the worker with rework instructions

```json
{
  "op": "send",
  "to": "AuthWorker",
  "message": "Review failed inspection. Rework your prior changes instead of starting a new implementation. Findings: 1) src/server/auth.go returns 500 for missing bearer token; it must return 401. 2) The test only covers the happy path; add a behavior test for missing Authorization. Keep the original API shape unchanged. After edits, run only the targeted auth tests and report the result.",
  "await": true,
  "timeoutMs": 120000
}
```

### 4. Worker does the rework in its own context

The awakened worker receives the message as an `irc:incoming` item in its own transcript. If idle/parked, OMP starts a real turn for it. The worker
can then continue naturally with its retained state.

### 5. Orchestrator waits for response or keeps coordinating

If blocked:

```json
{
  "op": "wait",
  "from": "AuthWorker",
  "timeoutMs": 120000
}
```

If not blocked, continue coordinating other agents and later check:

```json
{
  "op": "inbox"
}
```

## Good rework message template

```text
Review failed inspection. Rework your prior changes; do not create a fresh approach unless required by the findings.

Findings:
1. <specific issue>
2. <specific issue>

Required fix:
- <exact behavioral correction>

Constraints:
- Keep <API/schema/file boundary> unchanged.
- Do not expand scope beyond these findings.

Verification:
- Run <targeted test/check>.
- Report changed files and verification output.
```

## If using `replyTo`

If the review failure came in as an IRC message with id `123`, thread the answer:

```json
{
  "op": "send",
  "to": "AuthWorker",
  "replyTo": "123",
  "message": "Review failed inspection. Please rework the previous patch. Findings: ..."
}
```

That keeps the message relationship explicit.

---

# Why the orchestration agent should not spawn a new subagent for these cases

Use the original worker when:

- the task requires continuity,
- the prior transcript matters,
- the issue is a correction to previous work,
- the agent stopped due to transient execution/provider failure,
- review feedback targets that worker’s own patch.

Spawn a new subagent only when:

- the original worker is terminal/aborted and cannot be revived,
- isolated execution left it non-revivable,
- the original worker’s context is known bad and should not be trusted,
- the rework is a genuinely new independent task.

Default decision: **wake the existing worker first**.

---

## Concrete orchestration examples

### A. Resume after socket failure

```json
{
  "op": "send",
  "to": "SchemaScanner",
  "message": "You stopped after a socket connection error while scanning schema usages. Resume from your existing transcript. Continue from the last completed file; do not rescan files you already finished unless needed to recover the interrupted tool result. Report completed files, remaining files, and any blocker.",
  "await": true,
  "timeoutMs": 120000
}
```

Possible receipt:

```text
SchemaScanner: revived
```

Interpretation: the subagent had parked; OMP revived it and started a real turn.

---

### B. Rework after failed review

```json
{
  "op": "send",
  "to": "PaymentsWorker",
  "message": "Review failed inspection. Rework your existing payment validation changes. Findings: 1) negative amount is rejected, but zero amount is still accepted; zero must be rejected. 2) the error message lacks field context. Fix only those issues. Preserve the existing handler signature and response shape. Run the targeted payment validation tests and report results.",
  "await": true,
  "timeoutMs": 120000
}
```

Possible receipt:

```text
PaymentsWorker: woken
```

Interpretation: the subagent was idle and is now running a real turn.

---

## Operational guardrails

- **Do not broadcast rework.** Use exact worker id.
- **Do not resend repeatedly to a running worker.** `running` recipients get the message at the next step boundary; duplicate sends create duplicate
  instructions.
- **Do not treat timeout as failure.** `wait` timeout is a normal result. The worker may still be running.
- **Use `history://<id>` when deciding whether a replacement is necessary.** IRC docs note transcripts are available for live and parked agents.
- **Keep rework messages narrow.** Review feedback should be actionable, not a broad re-brief.
- **Escalate only on failed delivery or terminal lifecycle.** If direct `send` returns `failed`, then inspect whether the agent was
  aborted/non-revivable before spawning a replacement.

---

## Minimal policy an orchestration agent could follow

```text
For transient failure or review rework:
1. hub list.
2. If original worker is listed as running/idle/parked, direct hub send with continuation/rework instructions.
3. If delivery receipt is injected/woken/revived, do not spawn replacement.
4. Await only if blocked; otherwise continue coordinating and later wait/inbox.
5. Spawn replacement only if original worker is aborted, non-revivable, or direct delivery fails.
```

That matches OMP’s lifecycle model: subagents are kept around specifically so orchestration can continue through `hub` instead of throwing away state.