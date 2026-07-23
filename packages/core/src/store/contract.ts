import type {
	ChangeRequest,
	ImplementationProgressStep,
	LoadedState,
	MilestonePlan,
	RoadmapBlocker,
	RoadmapBlockerSeverity,
	RoadmapBlockerStatus,
	RoadmapEvent,
	RoadmapEventScope,
	RoadmapMilestoneCheck,
	RoadmapMilestoneOutline,
	RoadmapState,
	TaskPlan,
	TaskPlanInput,
	WaveFlowCheck,
	WaveFlowCheckStatus,
	WavePlan
} from '../types'
import type { CloseoutEvidenceInput } from '../closeout'

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
	tasks: TaskPlanInput[];
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
	tasks: TaskPlanInput[];
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

export type TransitionReturnScope = 'receipt' | 'state';

type TransitionBase<Operation extends string> = {
	operation: Operation;
	returnScope?: TransitionReturnScope;
};

export type TransitionInput =
	| (TransitionBase<'record_discovery'> & { discovery?: Partial<RoadmapState['discovery']> })
	| (TransitionBase<'approve_roadmap'> & { approver?: string; summary?: string })
	| (TransitionBase<'reopen_roadmap'> & { reason: string })
	| (TransitionBase<'record_roadmap_milestone_check'> & { roadmapMilestoneCheck: WaveFlowCheckInput })
	| TransitionBase<'start_milestone_planning'>
	| (TransitionBase<'create_milestone_plan'> & { milestone: CreateMilestonePlanInput })
	| (TransitionBase<'approve_milestone'> & { approver?: string; summary?: string })
	| (TransitionBase<'update_milestone_plan'> & { milestone: CreateMilestonePlanInput })
	| TransitionBase<'start_implementation'>
	| TransitionBase<'start_reviewing'>
	| TransitionBase<'start_closeout'>
	| TransitionBase<'complete_milestone'>
	| (TransitionBase<'request_bypass'> & { reason: string; approver?: string })
	| TransitionBase<'clear_bypass'>
	| (TransitionBase<'approve_change'> & { approver?: string; summary?: string })
	| (TransitionBase<'update_change_request_plan'> & { changeRequest: CreateChangeRequestInput })
	| TransitionBase<'close_change'>
	| (TransitionBase<'update_task_status'> & { taskId: string; taskStatus: TaskPlan['status'] })
	| (TransitionBase<'update_wave_status'> & { waveId: string; waveStatus: WavePlan['status'] })
	| (TransitionBase<'update_implementation_progress'> & { progress: UpdateImplementationProgressInput })
	| (TransitionBase<'record_closeout'> & { closeout: CloseoutEvidenceInput })
	| (TransitionBase<'record_wave_flow_check'> & { waveFlowCheck: WaveFlowCheckInput });

export interface TransitionReceipt {
	operation: TransitionInput['operation'];
	event_id: string;
	event_type: string;
	summary: string;
	scope: RoadmapEventScope;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
}

export interface TransitionResult {
	state: LoadedState;
	receipt: TransitionReceipt;
}

export interface AmendmentInput {
	scope: 'roadmap' | 'milestone';
	title: string;
	body: string;
	material: boolean;
	approvedBy?: string;
	approvalSummary?: string;
}
