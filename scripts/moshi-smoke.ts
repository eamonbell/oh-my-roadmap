// Live smoke test for Moshi notifications — talks to the real moshi-hook daemon
// over its local socket using the extension's own sender. Does NOT launch OMP.
//
// Usage:
//   bun scripts/moshi-smoke.ts                 # send one synthetic frame
//   bun scripts/moshi-smoke.ts --mapped        # walk one row through a workflow arc
//   bun scripts/moshi-smoke.ts /path/to.sock   # override the socket path
//   MOSHI_SOCKET_PATH=... bun scripts/moshi-smoke.ts
//
// Then look at Moshi's inbox: the row's title/state should update as frames arrive.
import * as fs from 'node:fs'
import {loadMoshiConfig} from '../packages/core/src/project-init'
import {
	buildMoshiSessionUpdate,
	mapRoadmapToolResult,
	resolveMoshiSocketPath,
	sendMoshiFrame,
} from '../packages/extension/src/extension/moshi-notifications'

const cwd = process.cwd()
const args = process.argv.slice(2)
const mapped = args.includes('--mapped')
const socketArg = args.find((a) => !a.startsWith('--'))

// A single stable session so every frame collapses into one live-activity row.
const ctx = {cwd, sessionManager: {getSessionFile: () => `${cwd}/smoke-session.jsonl`}, model: {id: 'smoke-test'}}

const config = await loadMoshiConfig(cwd)
console.log('merged moshi config:', JSON.stringify(config), '| enabled:', config.enabled === true)

const socketPath = socketArg ?? resolveMoshiSocketPath(config)
if (!socketPath) {
	console.error('No socket path resolved. Pass one as an arg or set MOSHI_SOCKET_PATH.')
	process.exit(1)
}
console.log('socket path:', socketPath, '| exists:', fs.existsSync(socketPath))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

if (!mapped) {
	// Single synthetic frame.
	const frame = buildMoshiSessionUpdate(ctx, {
		eventName: 'omr.smoke.test',
		category: 'task_complete',
		phase: 'omr_smoke',
		title: 'OMR smoke test',
		message: `Sent from moshi-smoke.ts at ${new Date().toISOString()}`,
	})
	console.log('frame:', JSON.stringify(frame))
	const start = Date.now()
	await sendMoshiFrame(socketPath, frame, 2000)
	console.log(`sendMoshiFrame returned after ${Date.now() - start}ms (never throws by design)`)
	console.log('Check Moshi\'s inbox for a row titled "OMR smoke test".')
	process.exit(0)
}

// --mapped: feed representative tool results through the real mapping so you can watch
// one row walk a milestone plan+implement arc. Quiet frames update the row; the blocked
// result and completions are the high-priority pushes.
const samples: Array<{tool: string; params: unknown; result: unknown}> = [
	{tool: 'omr_init', params: {}, result: {details: {roadmap_id: 'rm_smoke', title: 'Smoke roadmap', phase: 'discovery'}}},
	{tool: 'omr_transition', params: {}, result: {details: {operation: 'create_milestone_plan', summary: 'Created milestone plan m1', scope: {roadmap_id: 'rm_smoke', milestone_id: 'm1'}}}},
	{tool: 'omr_transition', params: {waveFlowCheck: {status: 'passed'}}, result: {details: {operation: 'record_wave_flow_check', scope: {roadmap_id: 'rm_smoke', milestone_id: 'm1'}}}},
	{tool: 'omr_transition', params: {}, result: {details: {operation: 'start_implementation', scope: {roadmap_id: 'rm_smoke', milestone_id: 'm1'}}}},
	{tool: 'omr_prepare_wave_dispatch', params: {}, result: {details: {roadmap_id: 'rm_smoke', milestone_id: 'm1', wave_id: 'w1', assignments: [{}, {}], active_runs: []}}},
	{tool: 'omr_record_worker_dispatch', params: {}, result: {details: {task_id: 't1', wave_id: 'w1', run: {worker: 'worker', agent_id: 'a1', job_id: 'j1'}}}},
	{tool: 'omr_record_wave_result', params: {}, result: {details: {task_id: 't1', wave_id: 'w1', status: 'blocked', blocker: {id: 'b1', title: 'needs a decision'}}}},
	{tool: 'omr_record_wave_review', params: {}, result: {details: {wave_id: 'w1', wave_status: 'complete', progress_step: 'ready_for_next_wave', blockers: []}}},
	{tool: 'omr_transition', params: {}, result: {details: {operation: 'complete_milestone', summary: 'Milestone complete', scope: {roadmap_id: 'rm_smoke', milestone_id: 'm1'}}}},
]

for (const sample of samples) {
	const event = mapRoadmapToolResult(sample.tool, sample.params, sample.result)
	if (!event) {
		console.log(`- ${sample.tool}: (no notification)`)
		continue
	}
	const frame = buildMoshiSessionUpdate(ctx, event)
	await sendMoshiFrame(socketPath, frame, 2000)
	const push = event.category === 'approval_required' || event.category === 'task_complete'
	console.log(`- ${sample.tool} -> ${event.eventName} [${event.category}${push ? ' PUSH' : ' quiet'}] "${event.title}"`)
	await sleep(700)
}
console.log('Done. Watch the single Moshi row walk from "OMR roadmap created" to "OMR milestone complete".')
