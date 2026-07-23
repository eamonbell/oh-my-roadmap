import type { ContextEntryResult } from '../context-types'
import type { NextActionHint } from '../report/index'
import type { ImplementationProgressStep, ImplementationWorkerName, RelevantCodeReference, ReviewerRun, ReviewFinding, ReworkQueueItem, RoadmapBlocker, ScoutFinding, SharedInterfaceContract, TaskPlan, VerificationBaseline, WavePlan, WorkerRun, } from '../types'

export interface WaveOrchestrationTargetInput {
	roadmapId?: string;
	milestoneId?: string;
	changeRequestId?: string;
}

export interface PlanDerivedManifest {
	owned_files: string[];
	owned_modules: string[];
	shared_interfaces: string[];
	dependencies: string[];
	reserved_sibling_scope: string[];
	relevant_existing_code: string[];
	relevant_documentation: string[];
}

export interface VerificationPreflightHint {
	commands: string[];
	cli_assumption_warnings: string[];
	guidance: string[];
}

export interface CappedContextItems<T> {
	items: T[];
	total: number;
	included: number;
	truncated: number;
}

export interface SeededContextWarning {
	kind: 'missing_source' | 'stale_source' | 'signature_mismatch' | 'outside_repo' | 'primer_unavailable' | 'primer_refresh_failed' | 'truncated';
	message: string;
	path?: string;
	task_id?: string;
	item?: string;
}

export interface ResolvedSharedInterfaceContract extends SharedInterfaceContract {
	current_source_mtime_ms: number;
}

export interface RenderedContextBlock {
	text: string;
	bytes: number;
	truncated: boolean;
}

export interface SeededRepoPrimerBlock extends RenderedContextBlock {
	generated_at: string;
	source_fingerprint: string;
}

export interface SeededContext {
	relevant_existing_code: CappedContextItems<RelevantCodeReference>;
	shared_interface_contracts: CappedContextItems<ResolvedSharedInterfaceContract>;
	scout_findings: CappedContextItems<ScoutFinding>;
	style_guidance: RenderedContextBlock;
	repo_primer?: SeededRepoPrimerBlock;
	warnings: CappedContextItems<SeededContextWarning>;
}

export interface WaveWorkerAssignment {
	task_id: string;
	title: string;
	worker: ImplementationWorkerName;
	owned_files: string[];
	owned_modules: string[];
	shared_interfaces: string[];
	dependencies: string[];
	seeded_context: SeededContext;
	manifest?: PlanDerivedManifest;
	verification_preflight?: VerificationPreflightHint;
	prompt: string;
}

export interface PrepareWaveDispatchResult {
	roadmap_id: string;
	milestone_id: string;
	change_request_id?: string;
	wave_id: string;
	wave_goal: string;
	progress_step: ImplementationProgressStep;
	assignments: WaveWorkerAssignment[];
	active_runs: WorkerRun[];
	instructions: string;
	next_actions?: NextActionHint[];
}

export interface RecordWorkerDispatchInput extends WaveOrchestrationTargetInput {
	taskId: string;
	agentId: string;
	jobId: string;
	replacesAgentId?: string;
}

// Reviewers are per-wave, not per-task, so there is no taskId here.
export interface RecordReviewerDispatchInput extends WaveOrchestrationTargetInput {
	agentId: string;
	jobId: string;
	replacesAgentId?: string;
}

export interface RecordReviewerDispatchResult {
	wave_id: string;
	run: ReviewerRun;
}

export interface PrepareWorkerRedispatchInput extends WaveOrchestrationTargetInput {
	taskId: string;
	agentId?: string;
	jobId?: string;
}

export interface PrepareWorkerRedispatchResult {
	roadmap_id: string;
	milestone_id: string;
	change_request_id?: string;
	wave_id: string;
	assignment: WaveWorkerAssignment;
	prior_run: {
		agent_id: string;
		job_id: string;
		transport_failures: number;
		last_error?: string;
	};
	instructions: string;
}

export interface RecordWorkerRunStatusInput extends WaveOrchestrationTargetInput {
	taskId: string;
	agentId?: string;
	jobId?: string;
	lastError?: string;
}

export interface RecordWorkerRunResult {
	task_id: string;
	wave_id: string;
	run: WorkerRun;
	progress_step: ImplementationProgressStep;
}

export interface RecordWaveResultInput extends WaveOrchestrationTargetInput {
	taskId: string;
	status: 'completed' | 'failed' | 'blocked';
	summary?: string;
	notes?: string[];
	blocker?: {
		title?: string;
		description?: string;
	};
}

export interface RecordWaveResultResult {
	task_id: string;
	status: TaskPlan['status'];
	wave_id: string;
	wave_status: WavePlan['status'];
	progress_step: ImplementationProgressStep;
	summary?: string;
	blocker?: RoadmapBlocker;
}

export interface RemainingWaveTaskContext {
	task_id: string;
	title: string;
	owned_files: string[];
	owned_modules: string[];
	shared_interfaces: string[];
	done_criteria: string[];
}

export interface RemainingWaveContext {
	wave_id: string;
	goal: string;
	exit_criteria: string[];
	tasks: RemainingWaveTaskContext[];
}

export interface PrepareWaveReviewResult {
	roadmap_id: string;
	milestone_id: string;
	change_request_id?: string;
	wave_id: string;
	reviewer: 'reviewer';
	// True when this wave already has a prior FAILED review; the orchestrator should wake
	// the same reviewer (prior_reviewer_agent_id) rather than spawn a fresh one.
	re_review: boolean;
	prior_reviewer_agent_id?: string;
	prior_findings?: string[];
	prompt: string;
	seeded_context: SeededContext;
	remaining_waves: RemainingWaveContext[];
	manifest?: PlanDerivedManifest;
	verification_preflight?: VerificationPreflightHint;
	tasks: Array<{
		task_id: string;
		title: string;
		worker: ImplementationWorkerName;
		owned_files: string[];
		owned_modules: string[];
		shared_interfaces: string[];
		done_criteria: string[];
	}>;
	worker_notes: ContextEntryResult[];
	verification_baseline?: VerificationBaseline;
	rework_queue?: ReworkQueueItem[];
	worker_command_receipts?: { task_id: string; agent_id?: string; commands: string[] }[];
}

export interface RecordWaveReviewInput extends WaveOrchestrationTargetInput {
	status: 'passed' | 'failed';
	summary: string;
	findings?: string[];
	structured_findings?: ReviewFinding[];
}

export interface RecordWaveReviewResult {
	wave_id: string;
	wave_status: WavePlan['status'];
	progress_step: ImplementationProgressStep;
	blockers: RoadmapBlocker[];
	next_actions?: NextActionHint[];
}
