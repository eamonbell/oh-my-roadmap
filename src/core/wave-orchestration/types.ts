import type {ImplementationProgressStep, ImplementationWorkerName, RoadmapBlocker, TaskPlan, WavePlan, WorkerRun,} from '../types'

export interface WaveOrchestrationTargetInput {
	roadmapId?: string;
	milestoneId?: string;
	changeRequestId?: string;
}

export interface WaveWorkerAssignment {
	task_id: string;
	title: string;
	worker: ImplementationWorkerName;
	owned_files: string[];
	owned_modules: string[];
	shared_interfaces: string[];
	dependencies: string[];
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
}

export interface RecordWorkerDispatchInput extends WaveOrchestrationTargetInput {
	taskId: string;
	agentId: string;
	jobId: string;
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
	blocker?: RoadmapBlocker;
}

export interface PrepareWaveReviewResult {
	roadmap_id: string;
	milestone_id: string;
	change_request_id?: string;
	wave_id: string;
	reviewer: 'reviewer';
	prompt: string;
	tasks: Array<{
		task_id: string;
		title: string;
		worker: ImplementationWorkerName;
		owned_files: string[];
		owned_modules: string[];
		shared_interfaces: string[];
	}>;
}

export interface RecordWaveReviewInput extends WaveOrchestrationTargetInput {
	status: 'passed' | 'failed';
	summary: string;
	findings?: string[];
}

export interface RecordWaveReviewResult {
	wave_id: string;
	wave_status: WavePlan['status'];
	progress_step: ImplementationProgressStep;
	blockers: RoadmapBlocker[];
}
