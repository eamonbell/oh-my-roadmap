# Slash Command Visibility Handoff

## Current Problem

The TUI behavior for roadmap-engineer slash commands is still not correct.

The user-visible symptom is that `/blocker:list` can produce an agent/report summary and then the summary disappears from the TUI. Earlier attempts also caused freezes, stranded prompts, or toast notifications instead of a persistent visible transcript entry.

The user explicitly does not want toast notifications for this command surface. They need the actual blocker report to remain visible in the TUI transcript.

## Relevant Context

The affected command surface is implemented mainly in:

- `src/extension/commands.ts`
- `test/commands.test.ts`
- `commands/prompts/*.md`

The original suspected root cause was that prompt-backed extension commands called `api.sendUserMessage(prompt)` from inside an extension slash-command handler. The outer slash command was handled locally, while the handler started a nested agent prompt. In the TUI this could leave the generated agent report unstable or hidden after completion.

An attempted fix queued prompts using `api.sendUserMessage(prompt, { deliverAs })`, with:

- `deliverAs: "steer"` while idle
- `deliverAs: "followUp"` while busy

This did not reliably fix `/blocker:list`; it also caused bad live behavior in at least one run.

## Current Dirty State

At the time this handoff file was written, `git status --short` showed:

```text
 M package.json
 M src/extension/commands.ts
 M test/commands.test.ts
?? commands/prompts/blocker-defer.md
?? commands/prompts/blocker-list.md
?? commands/prompts/blocker-resolve.md
?? commands/prompts/blocker-status.md
```

The `package.json` modification was already present before the latest command changes and should be inspected separately before reverting or committing.

## Changes Currently In Place

`src/extension/commands.ts` currently contains a local command-result path for blocker commands:

- `/blocker:list`
- `/blocker:status`
- `/blocker:resolve`
- `/blocker:defer`

Those commands were moved away from the prompt-backed `sendUserMessage` path and now call core blocker/store functions directly, then emit a visible custom transcript message through `api.sendMessage`.

The current custom message shape is intended to be:

```ts
api.sendMessage({
  customType: "roadmap-engineer.command-result",
  content,
  display: true,
  attribution: "agent",
});
```

`ctx.ui.notify(...)` usage was removed from `src/extension/commands.ts` during the attempted fix. Tests were also changed so mocked `ctx.ui.notify` throws if called.

New prompt snippet files were added under `commands/prompts/` for blocker commands. These are instruction snippets, not proven reliable command-dispatch fixes by themselves.

## Important Live Observation

Putting a colon command into the file-command/prompt-command surface was not sufficient.

In live testing, a file-backed `/blocker:list` command appeared in autocomplete, but submitting it did not reliably create the desired persistent agent turn. In one PTY session, sending newline selected/left the command as draft rather than executing it. Sending carriage return later executed the extension handler path.

This suggests the fix should not assume that simply placing `/blocker:list` instructions in `commands/prompts` will solve the TUI visibility issue.

## Tests That Were Passing

The following commands were run and passed after the attempted changes:

```text
bun test test/commands.test.ts
bun run check
bun test
```

Passing tests do not prove the TUI bug is fixed. The problem is specifically in live TUI command dispatch/rendering behavior.

## Live Verification Performed

The local plugin was reinstalled with:

```text
omp plugin install --local ~/Development/Agents/omp-engineer
```

Then `omp` was launched and `/blocker:list` was run.

At one point, the TUI displayed a `roadmap-engineer.command-result` transcript entry containing:

```text
No open blockers.

Recovery commands:
/blocker:resolve <id> <resolution>
/blocker:defer <id> <reason>
/roadmap:resume
```

However, the user later reported that the final output still showed the original issue: the agent returned the summary and then it disappeared. Treat the live behavior as not fixed.

## Likely Fault Lines

The next fix should inspect these areas before changing behavior again:

1. How OMP distinguishes extension slash commands from file-backed slash commands, especially names containing `:`.
2. Whether `api.sendMessage({ display: true })` custom messages are retained in the transcript across local-command completion and session state transitions.
3. Whether a local-only command result is persisted to the session JSONL before an agent turn exists.
4. Whether `api.sendUserMessage` from an extension command handler is fundamentally unsupported or requires a different delivery option/event boundary.
5. Whether `roadmap-engineer.command-result` is rendered by the TUI as a transient/local artifact rather than a durable transcript item.
6. Whether any remaining command paths outside `/blocker:*` still call `ctx.ui.notify` or emit transient UI feedback.

## Recommended Next Step

Start by reverting or isolating the recent changes in `src/extension/commands.ts` and writing a minimal reproduction around one command, preferably `/blocker:list`.

The reproduction should answer one question before any larger refactor:

Does the OMP TUI support a durable visible transcript entry from an extension slash-command handler without starting an agent turn?

If yes, use that mechanism directly for blocker reports.

If no, the correct fix likely belongs in OMP command dispatch/rendering or requires a sanctioned API for extension commands to enqueue a durable agent-visible command turn.

## User Requirement

The final behavior must satisfy all of the following:

- `/blocker:list` must leave the blocker report visible in the TUI.
- The report must not be replaced by or hidden behind toast notifications.
- The command must not freeze the TUI.
- The command must work after installing this plugin locally with `omp plugin install --local ~/Development/Agents/omp-engineer`.
- The fix must be verified in a live `omp` TUI session, not only by unit tests.
