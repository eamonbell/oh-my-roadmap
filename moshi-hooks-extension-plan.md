## Context

The task is to add opt-in Moshi notifications to the `@oh-my-roadmap/plugin` extension package, enabled only by top-level OMR config, with support for OMP profiles. The intended end state is: when `moshi.enabled: true` is present in the merged OMR config for the current project/profile, the extension sends low-volume OMR lifecycle updates to the local `moshi-hook` daemon; when it is absent or false, the extension has zero notification behavior. The plan uses only supported surfaces verified during planning: OMP extension events/tool wrappers, OMR state/config APIs, and Moshi’s documented local socket `session.update` protocol.

Evidence grounding:

- The extension package entrypoint is `packages/extension/src/main.ts`; `packages/extension/package.json` declares it under `omp.extensions` and also declares the existing roadmap gate hook at `./hooks/pre/roadmap-gate.ts`.
- OMP extension events are available through `ExtensionAPI.on(...)`, including `agent_end`, `tool_execution_start`, and `tool_execution_end` (`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts` lines 948-1024). The existing extension already uses `message_end` and `tool_execution_end` in `packages/extension/src/extension/usage-tracking.ts` lines 5-33.
- Current Moshi tap docs at `rjyo/homebrew-moshi@c77d4b79b073e2563c1aea87e1e1188b61d03d73` state that supported agents include OMP and Pi, hidden subcommands include `omp-hook`, and `moshi-hook serve` owns the daemon socket ([`docs/usage.md`](https://github.com/rjyo/homebrew-moshi/blob/c77d4b79b073e2563c1aea87e1e1188b61d03d73/docs/usage.md#L10-L10), [`docs/usage.md`](https://github.com/rjyo/homebrew-moshi/blob/c77d4b79b073e2563c1aea87e1e1188b61d03d73/docs/usage.md#L134-L134)). The same docs list OMP managed hook locations including `$PI_CONFIG_DIR/agent/hooks/post/moshi-hooks.ts` and `~/.omp/agent/hooks/post/moshi-hooks.ts` ([`docs/usage.md`](https://github.com/rjyo/homebrew-moshi/blob/c77d4b79b073e2563c1aea87e1e1188b61d03d73/docs/usage.md#L191-L204)).
- Moshi’s OMP product behavior is deliberately low-volume: session load is stored silently, user prompt publishes/updates `session_started`, agent loop end publishes `task_complete`, and default OMP tool activity is not installed because OMP tool hooks are synchronous and should stay opt-in ([`docs/hooks.md`](https://github.com/rjyo/homebrew-moshi/blob/c77d4b79b073e2563c1aea87e1e1188b61d03d73/docs/hooks.md#L96-L107)). This plan preserves that default and adds only OMR-specific lifecycle updates from the extension.
- Moshi’s local socket API is documented as newline-delimited JSON over a Unix socket, owner-only filesystem auth, one logical exchange per connection, with `session.update` for hook-to-daemon state changes and unknown fields ignored ([`docs/api.md`](https://github.com/rjyo/homebrew-moshi/blob/c77d4b79b073e2563c1aea87e1e1188b61d03d73/docs/api.md#L59-L119)). Supported categories include `approval_required`, `task_complete`, `session_started`, `session_ended`, `tool_running`, and `tool_finished` ([`docs/hooks.md`](https://github.com/rjyo/homebrew-moshi/blob/c77d4b79b073e2563c1aea87e1e1188b61d03d73/docs/hooks.md#L17-L24)).
- OMP profiles are real root relocations: `--profile` is extracted before normal launch parsing and `OMP_PROFILE` / `PI_PROFILE` are honored (`node_modules/@oh-my-pi/pi-coding-agent/src/cli/profile-bootstrap.ts` lines 1-33 and 81-130; `node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts` lines 230-248). `getConfigAgentDirName()` returns `<config>/profiles/<profile>/agent` when active (`node_modules/@oh-my-pi/pi-utils/src/dirs.ts` lines 202-211). OMR already installs the extension into profile plugin roots via `omr install --global --profile <name>` (`packages/core/src/cli/install.ts` lines 24-31 and 73-88), with tests in `test/omp-paths.test.ts` lines 176-191.

## Approach

### 1. Add top-level OMR Moshi config

Concrete edit: update `packages/core/src/project-init.ts` so merged OMR config accepts a new optional top-level `moshi` object.

Exact public types:

```ts
export interface MoshiConfig {
	enabled: boolean;
	socket_path?: string;
}

export interface RoadmapProjectConfig {
	agents: Record<AgentRole, AgentConfig>;
	orchestration: OrchestrationConfig;
	disabled?: boolean;
	style?: Record<string, StyleGuide>;
	moshi?: MoshiConfig;
}
```

Parser behavior:

- `moshi` missing means disabled and should not be written into newly scaffolded configs.
- `moshi.enabled` is optional inside the object and defaults to `false`; notifications are sent only when it is exactly `true` after global/project merge.
- `moshi.socket_path` is optional. When present it must be a non-empty string after trimming. Store the trimmed value.
- Reject unknown keys under `moshi` with the exact error prefix `moshi contains unsupported key` using the existing `rejectUnknownKeys` style.
- Reject non-object `moshi` with `moshi must be an object`.
- Reject non-boolean `moshi.enabled` with `moshi.enabled must be a boolean`.
- Reject empty/non-string `moshi.socket_path` with `moshi.socket_path must be a non-empty string`.

Merge behavior:

- Preserve existing top-level merge precedence: global config is base, project config overrides (`loadMergedConfig` already does this for `agents`, `disabled`, and `style`).
- Merge `moshi` shallowly when either side defines it: `{...(base.moshi ?? {}), ...(override.moshi ?? {})}`. This lets a profile-global config enable Moshi while project config overrides only `socket_path`, and lets project config disable with `moshi.enabled: false`.
- Preserve `moshi` in `ensureConfig()`, `buildConfigFromAgents()`, `initScoped()`, and reruns the same way `disabled` and `style` are preserved.
- Export `MoshiConfig` and, if useful for the extension, `loadMoshiConfig(cwd, homeDir?, profile?)` from `packages/core/src/project-init.ts` and the barrel `packages/core/src/index.ts`. If `loadMoshiConfig` is added, it must return `(await loadMergedConfig(...)).moshi ?? {enabled:false}` and must not swallow parse errors; invalid config should fail loudly like existing config.

No existing equivalent was found for Moshi config. Reuse the existing strict config parser helpers in `project-init.ts`: `requirePlainObject`, `rejectUnknownKeys`, `objectKeys`, `loadMergedConfig`, and the existing profile-aware `homeConfigDir`/`activeProfileFromEnv` behavior.

Profile requirement: do not add a separate profile-specific Moshi config path. The existing merged OMR config model already supports profile-global config at `<ompRoot>/profiles/<profile>/oh-my-roadmap/config.yml` through `homeConfigDir(homeDir, profile)` and `loadMergedConfig`.

### 2. Add a documented Moshi local-socket sender

Concrete edit: add `packages/extension/src/extension/moshi-notifications.ts`.

The sender must talk to Moshi’s documented local socket protocol, not to the retired `/api/v1/agent-events` endpoint and not to the cloud `/api/webhook` endpoint. Do not read or store Moshi user tokens, `hostSecret`, or `hostId` in OMR config.

Exact frame shape to send, one JSON object plus `\n`:

```ts
interface MoshiSessionUpdateFrame {
	type: 'session.update';
	source: 'omp';
	sessionId: string;
	eventName: string;
	phase: string;
	category: 'approval_required' | 'task_complete' | 'session_started' | 'session_ended' | 'tool_running' | 'tool_finished';
	cwd: string;
	projectName: string;
	title: string;
	message: string;
	requestedAt: string;
	modelName?: string;
	toolName?: string;
	contextPercent?: number;
}
```

Field rules:

- `type` is always `session.update`.
- `source` is always `omp`, matching Moshi’s OMP source in the docs.
- `sessionId` is resolved in this order: `ctx.sessionManager.getSessionFile()` if it returns a non-empty string, then `ctx.sessionManager.getSessionId()` if available and non-empty, then `ctx.cwd`. This copies the defensive session-id strategy from the installed user hook at `/Users/eamon/.omp/agent/hooks/post/moshi-hooks.ts` lines 52-68 while using the documented socket frame.
- `projectName` is `path.basename(ctx.cwd)` or `ctx.cwd` if basename is empty.
- `modelName` is optional and should use the first non-empty string among known model fields: `displayName`, `display_name`, `name`, `id`, `modelId`. The installed user hook uses the same first-string pattern (`moshi-hooks.ts` lines 40-50).
- `contextPercent` is optional. Include `Math.round(ctx.getContextUsage().percent)` only when `ctx.getContextUsage()` is available and returns a finite number.
- For notify-only approval/question events, do not send `actionId`, `pendingActionId`, `expiresAt`, or `hostId`. Moshi docs reserve those for harnesses that can route decisions back to the running host; this plan does not implement remote approve/deny/answer routing.

Socket path resolution:

1. `config.moshi.socket_path`, when configured.
2. `process.env.MOSHI_SOCKET_PATH`, when non-empty.
3. Platform default from Moshi docs:
   - macOS: `path.join(os.homedir(), 'Library/Application Support/Moshi/moshi-hook.sock')`.
   - Linux: `path.join(process.env.XDG_RUNTIME_DIR, 'moshi-hook.sock')` only when `XDG_RUNTIME_DIR` is set.
4. If no socket path can be resolved, return without throwing.

Failure behavior:

- If `moshi.enabled !== true`, do nothing.
- If the socket is missing, connection is refused, write fails, or the daemon does not ack within `500ms`, swallow the error and optionally log at debug/warn through `api.logger`. Moshi notification failure must never fail or delay an OMR tool result beyond the timeout.
- Use `node:net` `createConnection(socketPath)`, not shell commands, `curl`, or `moshi-hook status` during normal notifications.
- Write one frame per connection. Resolve on first `data`, `end`, or timeout. Destroy the socket on finish. This matches the one-logical-exchange local socket lifetime documented by Moshi.

Testing hook: export a pure `buildMoshiSessionUpdate(ctxLike, event)` function and a `sendMoshiFrame(socketPath, frame, timeoutMs)` function so tests can validate payload and socket behavior without a real Moshi daemon.

### 3. Map only high-signal OMR events to Moshi categories

Concrete edit: in `packages/extension/src/tools/register.ts`, wrap registered OMR tools so successful tool execution can trigger an OMR-specific Moshi notification after the existing `withDiagnosticTiming` call returns a result. The wrapper must still return the original `AgentToolResult` unchanged. Notification errors must be swallowed.

Implement `notifyMoshiForRoadmapToolResult(ctx, toolName, params, result)` in `moshi-notifications.ts`. It should inspect only known OMR tool names and known result details. Unknown tools or malformed details return without sending.

Exact mapping:

| Trigger | Event name | Category | Phase | Title | Message contents |
| --- | --- | --- | --- | --- | --- |
| `omr_prepare_wave_dispatch` success | `omr.wave.dispatch_prepared` | `tool_running` | `omr_wave_dispatch` | `OMR wave dispatch ready` | Roadmap/milestone/change ids when present, `wave_id`, assignment count, active-run count. |
| `omr_record_worker_dispatch` success with no `run.replaces_agent_id` | `omr.worker.spawned` | `tool_running` | `omr_workers_running` | `OMR worker spawned` | `task_id`, `wave_id`, `run.worker`, `run.agent_id`, `run.job_id`. |
| `omr_record_worker_dispatch` success with `run.replaces_agent_id` | `omr.worker.respawned` | `tool_running` | `omr_workers_running` | `OMR worker respawned` | Same as spawn plus `replaces_agent_id`. |
| `omr_prepare_worker_redispatch` success | `omr.worker.redispatch_prepared` | `tool_running` | `omr_worker_redispatch` | `OMR worker redispatch ready` | `assignment.task_id`, `wave_id`, `prior_run.agent_id`, `prior_run.transport_failures`. |
| `omr_record_wave_result` success with `status: 'done'` | `omr.worker.yielded` | `tool_finished` | `omr_worker_yield` | `OMR worker yielded` | `task_id`, `wave_id`, result status, `progress_step`, summary when present. |
| `omr_record_wave_result` success with `blocker` or non-done status | `omr.worker.blocked` | `approval_required` | `omr_needs_input` | `OMR worker needs attention` | `task_id`, `wave_id`, blocker id/title when present, summary when present. No action ids. |
| `omr_prepare_wave_review` success | `omr.wave.review_started` | `tool_running` | `omr_wave_review` | `OMR wave review starting` | `wave_id`, task count, reviewer name. |
| `omr_record_wave_review` success with `wave_status: 'complete'` | `omr.wave.review_passed` | `task_complete` | `omr_wave_review` | `OMR wave passed review` | `wave_id`, `progress_step`, next-action label when present. |
| `omr_record_wave_review` success with blockers | `omr.wave.review_blocked` | `approval_required` | `omr_needs_input` | `OMR wave review blocked` | `wave_id`, blocker ids/titles. No action ids. |
| `omr_transition` success where operation is `update_implementation_progress` | `omr.progress.updated` | `tool_running` except `ready_for_next_wave`/`closeout_ready` use `task_complete` | `omr_progress` | `OMR progress updated` | New `progress.step`, active wave id, active task ids, blocked reason. |
| `omr_transition` success where operation is `request_bypass` | `omr.bypass.requested` | `approval_required` | `omr_needs_input` | `OMR bypass requested` | Transition summary and reason. |
| `omr_transition` success where operation is `record_closeout`, `start_closeout`, or `complete_milestone` | `omr.closeout.updated` / `omr.milestone.completed` | `task_complete` | `omr_closeout` | `OMR closeout updated` / `OMR milestone complete` | Transition summary and scope. |

Do not emit notifications for read-only/status/report tools (`omr_read_state`, `omr_search_context`, `omr_read_context`, status/detail/report tools) unless they produce one of the high-signal state changes above. Do not emit every OMR `tool_execution_start`/`tool_execution_end`; that would recreate the verbosity Moshi docs explicitly avoid for OMP tool activity.

Deduplication:

- Keep a small in-memory `Map<string, number>` in `moshi-notifications.ts`, keyed by `sessionId + eventName + title + message`.
- Suppress duplicate sends for the same key within `5000ms`.
- Prune entries older than `60000ms` on each send attempt.

### 4. Notify asks and main-agent stops only when OMR context is active

Concrete edit: add `registerRoadmapMoshiNotifications(api: ExtensionAPI)` in `moshi-notifications.ts` and call it from `packages/extension/src/main.ts` after `registerRoadmapUsageTracking(api)`.

Event handlers:

1. `api.on('tool_execution_start', ...)`
   - If `event.toolName !== 'ask'`, return.
   - If `moshi.enabled !== true`, return.
   - If no active OMR roadmap/ad-hoc plan exists, return. Determine this by importing `loadState` and `loadAdhocActive` from `@oh-my-roadmap/core/store/index`: active roadmap exists when `state.active && state.roadmap`; active ad-hoc exists when `loadAdhocActive(ctx.cwd)` returns a pointer.
   - Send:
     - `eventName: 'omr.ask.input_required'`
     - `category: 'approval_required'`
     - `phase: 'omr_needs_input'`
     - `title: 'OMR needs input'`
     - `message`: first question text from `event.args.questions[0].question` if present, otherwise `OMR asked the user for input.`
   - Do not include `actionId`, `pendingActionId`, `expiresAt`, or `hostId`.

2. `api.on('agent_end', ...)`
   - If `moshi.enabled !== true`, return.
   - If no active OMR roadmap/ad-hoc plan exists, return.
   - Call `nextActionPlan(ctx.cwd)`.
   - Send one OMR-specific stop summary:
     - If `next.status` is `blocked`, `needs_input`, or `approval_required`, use category `approval_required`, eventName `omr.agent.stopped_needs_input`, phase `omr_needs_input`, title `OMR stopped: ${next.label}`, and include `next.description`, blockers, and missing inputs in the message.
     - Otherwise use category `task_complete`, eventName `omr.agent.stopped`, phase `omr_agent_stopped`, title `OMR agent stopped`, and message `Next action: ${next.label} (${next.status}). ${next.description}`.
   - This is intentionally OMR-specific and may coexist with Moshi’s generated generic OMP `AgentEnd` hook. The generic hook says a turn ended; this message says what OMR needs next.

Do not register or modify `packages/extension/hooks/pre/roadmap-gate.ts`; the existing gate remains only for pausing OMR tools/agents. Do not modify `packages/extension/package.json` hook metadata; OMR-specific notifications live in the extension package and therefore work when the plugin is installed into a profile root.

### 5. Keep profile install self-contained

Concrete edit: no change is required to `installExtension()` for the core install path. The implementation must preserve current profile behavior:

- `omr install --global --profile work` installs `@oh-my-roadmap/plugin` into `<home>/.omp/profiles/work/plugins`.
- `omr init --global --profile work` writes profile-global config to `<home>/.omp/profiles/work/oh-my-roadmap/config.yml` and generated agents to `<home>/.omp/profiles/work/agent/agents`.
- A profile can opt in with profile-global config:

```yaml
moshi:
  enabled: true
```

- A project can opt in or override for all profiles that run in that project with project config:

```yaml
moshi:
  enabled: true
  socket_path: "/Users/eamon/Library/Application Support/Moshi/moshi-hook.sock"
```

- A project can disable a profile-global opt-in with:

```yaml
moshi:
  enabled: false
```

Do not make `omr install` run `moshi-hook install`, `moshi-hook pair`, or `moshi-hook serve`; those are external Moshi setup operations and would be state-changing side effects outside the OMR package install contract. Do not write Moshi-managed hook files from OMR. OMR profile support is self-contained because the extension itself sends documented socket frames when loaded inside that profile.

### 6. Update README usage text

Concrete edit: update `README.md` in the existing install/config sections; do not create a new documentation file.

Add a short `## Moshi notifications` section after the existing install/profile config material:

- State prerequisites exactly:
  - Install/pair/run Moshi’s daemon: `moshi-hook pair --token <pairing-token>` and `moshi-hook serve` or `brew services start moshi-hook`.
  - Install OMR into the desired OMP profile with `omr install --global --profile <name>` when using profiles.
  - Enable per project or per profile with `moshi.enabled: true` in `.omr/config.yml` or `<ompRoot>/profiles/<profile>/oh-my-roadmap/config.yml`.
- State the integration uses Moshi’s local socket `session.update` protocol and does not require Moshi API tokens in OMR config.
- Include the exact YAML snippets from Step 5.
- State notify-only limitation: approval/question notifications do not approve, deny, or answer from Moshi; they tell the user to return to OMP.
- State that OMR sends only OMR-specific notifications and does not duplicate Moshi’s generated generic OMP lifecycle hook.

## Critical files & anchors

- `packages/core/src/project-init.ts` — `RoadmapProjectConfig`, `parseConfig`, `mergeConfigs`, `ensureConfig`, `buildConfigFromAgents`; this is the only config schema/load/merge surface to change.
- `packages/extension/src/extension/moshi-notifications.ts` — new focused module for Moshi socket payloads, socket transport, OMR event mapping, dedupe, and extension event handlers.
- `packages/extension/src/tools/register.ts` — existing universal tool wrapper; add the post-result Moshi notification call here so individual tool registrations stay simple.
- `packages/extension/src/main.ts` — extension bootstrap; call `registerRoadmapMoshiNotifications(api)` here.
- `test/project-init.test.ts` and `test/omp-paths.test.ts` — existing config/profile coverage to extend; add a new `test/moshi-notifications.test.ts` for socket payload behavior and event mapping.

## Verification

Run commands from the repository root.

### Unit tests to add or update

1. `test/project-init.test.ts`
   - Update default config expectations: newly created `.omr/config.yml` does not include `moshi`.
   - Add `preserves configured moshi on rerun`:
     - Seed `.omr/config.yml` with `moshi.enabled: true` and `moshi.socket_path: /tmp/moshi.sock`.
     - Run `initProject(cwd)`.
     - Expect `moshi` unchanged in parsed YAML.
   - Add invalid cases:
     - `moshi: true` -> `moshi must be an object`.
     - `moshi:
    enabled: yes` -> `moshi.enabled must be a boolean`.
     - `moshi:
    socket_path: ""` -> `moshi.socket_path must be a non-empty string`.
     - `moshi:
    extra: true` -> `moshi contains unsupported key: extra`.
   - Add merge case using `loadMergedConfig(cwd, home)`:
     - Global config has `moshi.enabled: true` and `socket_path: /tmp/global.sock`.
     - Project config has `moshi.socket_path: /tmp/project.sock`.
     - Expect merged `{enabled: true, socket_path: '/tmp/project.sock'}`.
     - Then set project `moshi.enabled: false`; expect merged enabled false.

2. `test/omp-paths.test.ts`
   - Extend the profile config test to include `moshi.enabled: true` in profile-global config and confirm `loadMergedConfig(cwd, home, 'work')` reads it from `<home>/.omp/profiles/work/oh-my-roadmap/config.yml`.
   - Do not add any test that runs `moshi-hook install`; profile support is OMR-extension self-contained.

3. New `test/moshi-notifications.test.ts`
   - Use a temporary Unix socket server created with `node:net`.
   - Test `sendMoshiFrame` writes exactly one newline-delimited JSON object with `type: 'session.update'`, `source: 'omp'`, expected `category`, `eventName`, `sessionId`, `cwd`, `projectName`, and no `actionId`, `pendingActionId`, `expiresAt`, or `hostId` for notify-only approval events.
   - Test disabled config path: with `moshi` absent or `enabled:false`, `notifyMoshiForRoadmapToolResult` does not connect to the fake socket.
   - Test missing socket path / refused connection does not throw.
   - Test mapping functions for:
     - `omr_prepare_wave_dispatch` -> `omr.wave.dispatch_prepared`, category `tool_running`.
     - `omr_record_worker_dispatch` with `replaces_agent_id` -> `omr.worker.respawned`, category `tool_running`.
     - `omr_record_wave_result` done -> `omr.worker.yielded`, category `tool_finished`.
     - `omr_record_wave_result` blocked with blocker -> `omr.worker.blocked`, category `approval_required`.
     - `omr_record_wave_review` complete -> `omr.wave.review_passed`, category `task_complete`.
     - `omr_record_wave_review` blocked -> `omr.wave.review_blocked`, category `approval_required`.
   - Test dedupe suppresses a repeated identical event within 5 seconds and allows a different message.

4. Existing wave/tool tests
   - Run `bun test test/state/wave-orchestration.test.ts` after adding notifications to confirm core orchestration results remain unchanged.
   - Run `bun test test/tools/action-tools.test.ts test/tools/roadmap-tools.test.ts test/tools/context-tools.test.ts` if any shared tool wrapper types change.

### Commands

- Typecheck: `bun run check`.
- Focused tests after implementation:

```sh
bun test test/project-init.test.ts test/omp-paths.test.ts test/moshi-notifications.test.ts test/state/wave-orchestration.test.ts
```

- If tool wrapper changes affect registered tools broadly, also run:

```sh
bun test test/tools/action-tools.test.ts test/tools/roadmap-tools.test.ts test/tools/context-tools.test.ts
```

### Manual smoke check with real Moshi daemon

Prerequisites: Moshi daemon is paired and running (`moshi-hook status --json` reports `paired: true` and a `socketPath`), and the extension is installed into the profile being tested.

1. Enable in a throwaway project or profile config:

```yaml
moshi:
  enabled: true
```

2. Start OMP in that project/profile, run an OMR implementation flow until `omr_prepare_wave_dispatch` and `omr_record_worker_dispatch` execute.
3. Expected observable result: Moshi inbox updates the active OMP session row with OMR-specific titles such as `OMR wave dispatch ready` and `OMR worker spawned`.
4. Trigger an OMR blocker or an `ask` during active OMR work.
5. Expected observable result: Moshi shows a notify-only input-needed/approval-required row; no remote approve/deny/answer action is claimed or required.

## Assumptions & contingencies

- Decision: use Moshi’s documented local socket `session.update` protocol, not `/api/webhook`, not the retired `/api/v1/agent-events`, and not undocumented custom OMR event names through `moshi-hook omp-hook`. Reason: the socket API and categories are documented in the current Moshi tap docs, and it avoids storing user tokens or host secrets in OMR.
- Decision: support OMP profiles by keeping Moshi notification code inside the OMR extension package. A profile works when the extension is installed into that profile root and the merged OMR config for that profile has `moshi.enabled: true`. Do not require a profile-specific Moshi-generated OMP hook.
- Decision: approvals/questions are notify-only. The plan must not include `pendingActionId`, `expiresAt`, or `hostId`, and must not advertise remote approve/deny/answer because no documented OMP-to-Moshi decision route was found for OMR-specific decisions.
- Decision: notification verbosity is fixed and OMR-specific. Do not add per-event config unless implementation discovers an unavoidable need; a single `enabled` flag plus optional `socket_path` is enough for the requested opt-in.
- If the Moshi local socket docs prove false at execution time, do not fall back to the legacy `/api/v1/agent-events` endpoint. Disable sending, keep config parsing/tests, and document the blocked prerequisite as “Moshi local socket `session.update` unavailable”.
- If `ctx.sessionManager.getSessionId()` is not available on the runtime object, use `getSessionFile()` or `ctx.cwd`; do not add a dependency on private OMP session internals.
- If Linux has no `XDG_RUNTIME_DIR`, do not invent a default socket path. Require `moshi.socket_path` or `MOSHI_SOCKET_PATH`.
