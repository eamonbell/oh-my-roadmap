export const ROADMAP_ROOT = '.omr'

export const PHASES = [
	'discovery',
	'roadmap_draft',
	'roadmap_approved',
	'milestone_planning',
	'milestone_approved',
	'implementing',
	'reviewing',
	'closeout',
	'complete',
] as const

export type Phase = (typeof PHASES)[number];

export interface Approval {
	by: string;
	at: string;
	summary: string;
}

export type EvidenceStatus = 'open' | 'passed' | 'failed' | 'deferred';

export interface EvidenceResult {
	item: string;
	status: EvidenceStatus;
	reason?: string;
	approver?: string;
	at?: string;
}

export interface RiskDisposition {
	risk: string;
	disposition: 'resolved' | 'deferred';
	reason?: string;
	approver?: string;
}

export interface CloseoutEvidence {
	roadmap_id: string;
	milestone_id: string;
	change_request_id?: string;
	status: 'open' | 'recorded' | 'closed';
	acceptance_results: EvidenceResult[];
	verification_results: EvidenceResult[];
	worker_notes_reviewed: boolean;
	review_summary: string;
	unresolved_risks: RiskDisposition[];
	closed_by?: string;
	closed_at?: string;
}

export interface ActivePointer {
	roadmap_id: string;
	milestone_id?: string;
	change_request_id?: string;
	updated_at: string;
	// Lockout markers. Set when omr is disabled/enabled while this roadmap is active;
	// consumed by resume to trigger a drift check, then cleared.
	paused_at?: string;
	resumed_at?: string;
}

export interface DiscoveryState {
	recorded: boolean;
	external_research_required: boolean;
	external_research_recorded: boolean;
	findings: string[];
}

export interface BypassState {
	active: boolean;
	reason: string;
	requested_by: string;
	requested_at: string;
}

export interface MilestoneSummary {
	id: string;
	title: string;
	status: Phase | 'planned' | 'blocked';
}

export interface RoadmapMilestoneOutline extends MilestoneSummary {
	goal: string;
	scope: string[];
	non_goals: string[];
	evidence: string[];
	dependencies: string[];
	risks: string[];
	acceptance_intent: string[];
	verification_intent: string[];
}

export interface RoadmapState {
	roadmap_id: string;
	title: string;
	phase: Phase;
	created_at: string;
	updated_at: string;
	roadmap_finalized: boolean;
	roadmap_revision: number;
	roadmap_content_hash: string;
	roadmap_milestone_check: RoadmapMilestoneCheck;
	goal: string;
	success_criteria: string[];
	constraints: string[];
	non_goals: string[];
	context: string[];
	evidence: string[];
	risks: string[];
	discovery: DiscoveryState;
	approvals: Approval[];
	open_questions: string[];
	milestones: RoadmapMilestoneOutline[];
	active_milestone_id?: string;
	active_change_request_id?: string;
	bypass?: BypassState;
}

export type RoadmapBlockerSeverity = 'blocking' | 'non_blocking';
export type RoadmapBlockerStatus = 'open' | 'resolved' | 'deferred';

export interface RoadmapBlocker {
	id: string;
	roadmap_id: string;
	milestone_id?: string;
	change_request_id?: string;
	task_id?: string;
	wave_id?: string;
	severity: RoadmapBlockerSeverity;
	status: RoadmapBlockerStatus;
	title: string;
	description: string;
	created_by: string;
	created_at: string;
	resolved_by?: string;
	resolved_at?: string;
	resolution?: string;
	deferred_by?: string;
	deferred_at?: string;
	defer_reason?: string;
	note_path?: string;
}

export interface ScoutFinding {
	id: string;
	roadmap_id: string;
	subsystem: string;
	milestone_ids: string[];
	source_paths: string[];
	summary: string;
	findings: string[];
	created_by: string;
	created_at: string;
	stale?: boolean;
}

export const IMPLEMENTATION_WORKER_NAMES = ['worker-light', 'worker', 'worker-heavy'] as const

export type ImplementationWorkerName = (typeof IMPLEMENTATION_WORKER_NAMES)[number];

export const WAVE_FLOW_CHECK_STATUSES = ['pending', 'passed', 'failed'] as const

export type WaveFlowCheckStatus = (typeof WAVE_FLOW_CHECK_STATUSES)[number];

export interface WaveFlowCheck {
	status: WaveFlowCheckStatus;
	checked_by: string;
	checked_at: string;
	summary: string;
	findings: string[];
}

export interface RoadmapMilestoneCheck extends WaveFlowCheck {
	roadmap_revision: number;
	roadmap_content_hash: string;
	event_id: string;
}

export interface RelevantCodeReferenceInput {
	path: string;
	line?: number;
	symbol?: string;
	note: string;
}

export interface RelevantCodeReference extends RelevantCodeReferenceInput {
	captured_at: string;
	source_mtime_ms: number;
}

export interface SharedInterfaceContractInput {
	name: string;
	signature: string;
	source_path: string;
	line?: number;
	planned: boolean;
	planned_by_task_id?: string;
}

export interface SharedInterfaceContract extends SharedInterfaceContractInput {
	captured_at?: string;
	source_mtime_ms?: number;
}

export interface TaskPlanInput {
	id: string;
	title: string;
	objective: string;
	implementation_notes: string[];
	done_criteria: string[];
	verification_commands: string[];
	worker: ImplementationWorkerName;
	status: 'assigned' | 'started' | 'done' | 'blocked';
	depends_on: string[];
	owned_files: string[];
	owned_modules: string[];
	shared_interfaces: string[];
	relevant_existing_code: RelevantCodeReferenceInput[];
	shared_interface_contracts: SharedInterfaceContractInput[];
}

export interface TaskPlan extends Omit<TaskPlanInput, 'relevant_existing_code' | 'shared_interface_contracts'> {
	relevant_existing_code: RelevantCodeReference[];
	shared_interface_contracts: SharedInterfaceContract[];
}

export interface WavePlan {
	id: string;
	goal: string;
	exit_criteria: string[];
	review_checkpoint: string;
	status: 'pending' | 'running' | 'reviewing' | 'blocked' | 'complete';
	tasks: string[];
}

export const IMPLEMENTATION_PROGRESS_STEPS = [
	'not_started',
	'dispatching',
	'workers_running',
	'wave_review',
	'resolving_blockers',
	'ready_for_next_wave',
	'closeout_ready',
] as const

export type ImplementationProgressStep = (typeof IMPLEMENTATION_PROGRESS_STEPS)[number];

export const WORKER_RUN_STATUSES = [
	'running',
	'transport_failed',
	'abandoned',
	'completed',
	'blocked',
	'failed',
	'cancelled',
] as const

export type WorkerRunStatus = (typeof WORKER_RUN_STATUSES)[number];

export interface WorkerRun {
	task_id: string;
	wave_id: string;
	worker: ImplementationWorkerName;
	agent_id: string;
	job_id: string;
	owned_files: string[];
	owned_modules: string[];
	status: WorkerRunStatus;
	started_at: string;
	updated_at: string;
	transport_failures: number;
	last_error?: string;
	replaces_agent_id?: string;
	// Id of the review finding / rework-queue item this dispatch addresses, when the run was
	// spawned to resolve a worker-fixable review finding rather than to do fresh task work.
	rework_of?: string;
}

// Reviewers have a much simpler lifecycle than workers: a reviewer is either the current
// active reviewer for a wave, or it has handed off (completed) — typically because a
// re-review replaced it. There is no transport/abandon probe flow for reviewers, so this
// deliberately does NOT reuse WorkerRunStatus.
export const REVIEWER_RUN_STATUSES = ['active', 'completed'] as const

export type ReviewerRunStatus = (typeof REVIEWER_RUN_STATUSES)[number];

export interface ReviewerRun {
	wave_id: string;
	agent_id: string;
	job_id: string;
	status: ReviewerRunStatus;
	started_at: string;
	updated_at: string;
	replaces_agent_id?: string;
}

// Review findings model. Reviewers classify each finding by severity so the orchestrator can
// route worker-fixable findings into the rework queue instead of raising hard blockers, and
// distinguish advisory notes from findings that require the user.
export type ReviewFindingSeverity =
	| 'pass'
	| 'advisory'
	| 'blocking_worker_fixable'
	| 'blocking_needs_user';

export interface ReviewFinding {
	severity: ReviewFindingSeverity;
	text: string;
	task_id?: string;
}

// Worker-fixable review findings become rework-queue items rather than blockers, so they can be
// dispatched back to a worker and tracked to resolution.
export interface ReworkQueueItem {
	id: string;
	task_id: string;
	wave_id: string;
	finding_text: string;
	source_finding_severity: ReviewFindingSeverity;
	status: 'pending' | 'in_progress' | 'resolved';
	created_at: string;
	created_by: string;
	resolved_at?: string;
}

// Verification baseline captured at implementation start; reviewers diff current verification
// results against it to separate pre-existing failures from regressions introduced by a wave.
export interface VerificationBaselineCommandResult {
	command: string;
	exit_status?: number;
	failing_tests: string[];
	failure_count: number;
}

export interface VerificationBaseline {
	captured_at: string;
	captured_by: string;
	command_results: VerificationBaselineCommandResult[];
}

export interface ImplementationProgress {
	active_wave_id?: string;
	step: ImplementationProgressStep;
	active_task_ids: string[];
	worker_runs: WorkerRun[];
	reviewer_runs: ReviewerRun[];
	blocked_reason?: string;
	updated_at: string;
	rework_queue?: ReworkQueueItem[];
	verification_baseline?: VerificationBaseline;
}

export interface TaskRuntime {
	id: string;
	status: TaskPlan['status'];
}

export interface WaveGitStart {
	start_head: string | null;   // HEAD sha at fresh dispatch; null = unborn repo
	predirty: string[];          // owned paths already dirty at dispatch (collision-warning source)
	captured_at: string;
}

export interface WaveCheckpoint {
	status: 'created' | 'no_changes' | 'skipped';
	commit?: string;
	paths?: string[];
	reason?: string;             // when skipped, e.g. 'git unavailable' | 'detached HEAD'
	warnings: string[];
	at: string;
}

export interface WaveGitState {
	start?: WaveGitStart;
	checkpoint?: WaveCheckpoint;
}

export interface WaveRuntime {
	id: string;
	status: WavePlan['status'];
	git?: WaveGitState;
}

export interface PlanRuntime {
	tasks: TaskRuntime[];
	waves: WaveRuntime[];
	progress: ImplementationProgress;
	wave_flow_check: WaveFlowCheck;
}

export type MilestoneRuntime = PlanRuntime;
export type ChangeRequestRuntime = PlanRuntime;

export interface MilestonePlan {
	roadmap_id: string;
	milestone_id: string;
	title: string;
	status: Phase;
	approvals: Approval[];
	open_questions: string[];
	verification_commands: string[];
	acceptance_criteria: string[];
	cleanup_policy: 'approval-gated';
	user_interview: string[];
	relevant_existing_code: string[];
	relevant_documentation: string[];
	decisions: string[];
	dependency_analysis: string[];
	tasks: TaskPlan[];
	waves: WavePlan[];
	progress: ImplementationProgress;
	wave_flow_check: WaveFlowCheck;
}

export interface ChangeRequest {
	roadmap_id: string;
	milestone_id: string;
	change_request_id: string;
	title: string;
	status: 'draft' | 'approved' | 'implementing' | 'reviewing' | 'closed';
	requested_at: string;
	request: string;
	approvals: Approval[];
	verification_commands: string[];
	acceptance_criteria: string[];
	user_interview: string[];
	relevant_existing_code: string[];
	relevant_documentation: string[];
	decisions: string[];
	dependency_analysis: string[];
	tasks: TaskPlan[];
	waves: WavePlan[];
	progress: ImplementationProgress;
	wave_flow_check: WaveFlowCheck;
	closeout?: CloseoutEvidence;
}

// Ad-hoc plans: a lightweight, roadmap-free plan that reuses the full task/wave/worker/
// reviewer/closeout machinery. Minimal lifecycle (no change requests, reopen, or amendments).
export const ADHOC_STATUSES = [
	'adhoc_draft',
	'adhoc_approved',
	'implementing',
	'reviewing',
	'closeout',
	'complete',
] as const

export type AdhocStatus = (typeof ADHOC_STATUSES)[number];

export interface AdhocPlan {
	adhoc_id: string;
	title: string;
	status: AdhocStatus;
	created_at: string;
	updated_at: string;
	request: string;
	approvals: Approval[];
	open_questions: string[];
	verification_commands: string[];
	acceptance_criteria: string[];
	cleanup_policy: 'approval-gated';
	user_interview: string[];
	relevant_existing_code: string[];
	relevant_documentation: string[];
	decisions: string[];
	dependency_analysis: string[];
	tasks: TaskPlan[];
	waves: WavePlan[];
	progress: ImplementationProgress;
	wave_flow_check: WaveFlowCheck;
	closeout?: CloseoutEvidence;
}

export type AdhocRuntime = PlanRuntime;

export interface AdhocPointer {
	adhoc_id: string;
	updated_at: string;
	paused_at?: string;
	resumed_at?: string;
}

export interface ValidationIssue {
	code: string;
	message: string;
	path?: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

export interface LoadedState {
	active?: ActivePointer;
	roadmap?: RoadmapState;
	milestone?: MilestonePlan;
	changeRequest?: ChangeRequest;
	closeout?: CloseoutEvidence;
	usage?: import('./usage').RoadmapUsageSummary;
	// Active ad-hoc plan (roadmap-free path). Mutually exclusive with `active`/roadmap.
	adhocActive?: AdhocPointer;
	adhoc?: AdhocPlan;
}

export interface RoadmapEventScope {
	roadmap_id: string;
	milestone_id?: string;
	change_request_id?: string;
	wave_id?: string;
	task_id?: string;
	blocker_id?: string;
	gate?: string;
}

export interface RoadmapEvent {
	id: string;
	schema_version: 1;
	at: string;
	actor: string;
	type: string;
	operation?: string;
	scope: RoadmapEventScope;
	summary: string;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
	details?: Record<string, unknown>;
}
