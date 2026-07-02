import type {
	ChangeRequest,
	CloseoutEvidence,
	ImplementationProgressStep,
	MilestonePlan,
	RoadmapBlocker,
	RoadmapBlockerSeverity,
	RoadmapBlockerStatus,
	RoadmapEvent,
	RoadmapMilestoneCheck,
	RoadmapMilestoneOutline,
	RoadmapState,
	TaskPlan,
	WaveFlowCheck,
	WaveFlowCheckStatus,
	WavePlan
} from '../types'

export interface InitRoadmapInput {
	roadmapId: string;
	title: string;
	summary?: string;
	discovery?: Partial<RoadmapState['discovery']>;
}

export interface CreateMilestonePlanInput {
	milestoneId: string;
	title: string;
	verificationCommands: string[];
	acceptanceCriteria: string[];
	userInterview?: string[];
	relevantExistingCode?: string[];
	relevantDocumentation?: string[];
	decisions?: string[];
	dependencyAnalysis?: string[];
	tasks: MilestonePlan['tasks'];
	waves: MilestonePlan['waves'];
	openQuestions?: string[];
}

export interface UpdateRoadmapInput {
	goal: string;
	successCriteria: string[];
	constraints: string[];
	nonGoals: string[];
	context: string[];
	evidence: string[];
	risks: string[];
	milestones: RoadmapMilestoneOutline[];
}

export interface AppendNoteInput {
	kind: 'worker' | 'review' | 'orchestrator' | 'decision' | 'issue';
	roadmapId?: string;
	milestoneId?: string;
	waveId?: string;
	taskId?: string;
	workerId?: string;
	blocking?: boolean;
	status?: 'open' | 'resolved' | 'deferred';
	title: string;
	body: string;
}

export interface CreateChangeRequestInput {
	changeRequestId: string;
	title: string;
	request: string;
	verificationCommands: string[];
	acceptanceCriteria: string[];
	userInterview?: string[];
	relevantExistingCode?: string[];
	relevantDocumentation?: string[];
	decisions?: string[];
	dependencyAnalysis?: string[];
	tasks: ChangeRequest['tasks'];
	waves: ChangeRequest['waves'];
}

export interface UpdateImplementationProgressInput {
	activeWaveId?: string;
	step: ImplementationProgressStep;
	activeTaskIds?: string[];
	blockedReason?: string;
}

export interface WaveFlowCheckInput {
	status: WaveFlowCheckStatus;
	checkedBy?: string;
	summary?: string;
	findings?: string[];
}

export interface ListQualityGatesInput {
	roadmapId?: string;
	gate?: 'roadmap_milestone_check' | 'wave_flow_check';
	status?: WaveFlowCheckStatus;
	limit?: number;
}

export interface ListQualityGatesResult {
	current?: WaveFlowCheck | RoadmapMilestoneCheck;
	history: RoadmapEvent[];
}

export interface RepairRoadmapInput {
	reason: string;
	actor?: string;
	summary?: string;
	roadmapMilestoneCheck?: WaveFlowCheckInput;
}

export interface RepairRoadmapResult {
	roadmap_id: string;
	previous_revision: number;
	current_revision: number;
	previous_content_hash: string;
	current_content_hash: string;
	content_hash_changed: boolean;
	roadmap_doc_rewritten: boolean;
	gate_action: 'unchanged' | 'reset_pending' | 'recorded_passed';
	repair_event_id: string;
	quality_gate_event_id?: string;
}

export interface OpenBlockerInput {
	roadmapId?: string;
	milestoneId?: string;
	changeRequestId?: string;
	taskId?: string;
	waveId?: string;
	severity?: RoadmapBlockerSeverity;
	title: string;
	description: string;
	createdBy?: string;
	notePath?: string;
}

export interface ResolveBlockerInput {
	roadmapId?: string;
	blockerId: string;
	resolvedBy?: string;
	resolution: string;
}

export interface DeferBlockerInput {
	roadmapId?: string;
	blockerId: string;
	deferredBy?: string;
	deferReason: string;
}

export interface ListBlockersInput {
	roadmapId?: string;
	milestoneId?: string;
	changeRequestId?: string;
	taskId?: string;
	waveId?: string;
	status?: RoadmapBlockerStatus;
	severity?: RoadmapBlockerSeverity;
	limit?: number;
}

export interface ListBlockersResult {
	roadmapId?: string;
	total: number;
	returned: number;
	blockers: RoadmapBlocker[];
}

export interface TransitionInput {
	operation:
		| 'record_discovery'
		| 'approve_roadmap'
		| 'reopen_roadmap'
		| 'record_roadmap_milestone_check'
		| 'start_milestone_planning'
		| 'create_milestone_plan'
		| 'approve_milestone'
		| 'update_milestone_plan'
		| 'start_implementation'
		| 'start_reviewing'
		| 'start_closeout'
		| 'complete_milestone'
		| 'request_bypass'
		| 'clear_bypass'
		| 'approve_change'
		| 'update_change_request_plan'
		| 'close_change'
		| 'update_task_status'
		| 'update_wave_status'
		| 'update_implementation_progress'
		| 'record_closeout'
		| 'record_wave_flow_check';
	approver?: string;
	summary?: string;
	reason?: string;
	discovery?: Partial<RoadmapState['discovery']>;
	milestone?: CreateMilestonePlanInput;
	changeRequest?: CreateChangeRequestInput;
	taskId?: string;
	taskStatus?: TaskPlan['status'];
	waveId?: string;
	waveStatus?: WavePlan['status'];
	progress?: UpdateImplementationProgressInput;
	closeout?: CloseoutEvidence;
	waveFlowCheck?: WaveFlowCheckInput;
	roadmapMilestoneCheck?: WaveFlowCheckInput;
}

export interface AmendmentInput {
	scope: 'roadmap' | 'milestone';
	title: string;
	body: string;
	material: boolean;
	approvedBy?: string;
	approvalSummary?: string;
}
