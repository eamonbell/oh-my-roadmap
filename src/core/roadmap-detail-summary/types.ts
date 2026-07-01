import type {ApplyNextActionResult, NextActionPlan} from '../report/index'
import type {RoadmapBlocker} from '../types'
import type {UsageTotals} from '../usage'

export const NO_ACTIVE_ROADMAP_MESSAGE =
	'No active roadmap. Run /roadmap:new to start a gated roadmap workflow.'

export type RoadmapDetailSummary = EmptyRoadmapDetailSummary | ActiveRoadmapDetailSummary;

export interface EmptyRoadmapDetailSummary {
	kind: 'empty';
	message: string;
}

export interface ActiveRoadmapDetailSummary {
	kind: 'active';
	roadmap: {
		id: string;
		title: string;
		phase: string;
		label: string;
	};
	active: {
		milestone: RoadmapDetailReference | null;
		changeRequest: RoadmapDetailReference | null;
	};
	bypass: {
		active: boolean;
		label: string;
		reason?: string;
		requestedBy?: string;
	};
	qualityGate: RoadmapDetailQualityGate;
	validation: RoadmapDetailCheck;
	gate: RoadmapDetailCheck;
	roadmapHealth: RoadmapDetailHealth;
	nextAction: NextActionPlan;
	nextCommand: RoadmapDetailNextCommand;
	waves: RoadmapDetailWaves;
	activeExecution: RoadmapDetailActiveExecution | null;
	activeTasks: RoadmapDetailTask[];
	milestones: RoadmapDetailMilestone[];
	blockers: RoadmapDetailBlocker[];
	canonicalBlockers: RoadmapDetailCanonicalBlockers;
	recentEvents: RoadmapDetailEvent[];
	availableControls: RoadmapDetailControl[];
	usage: RoadmapDetailUsage | null;
}

export interface RoadmapDetailReference {
	id: string;
	title: string;
	status: string;
	label: string;
}

export interface RoadmapDetailNextCommand {
	command: string;
	description: string;
	label: string;
}

export interface RoadmapDetailQualityGate {
	gate: 'roadmap_milestone_check';
	status: 'pending' | 'passed' | 'failed' | 'stale';
	label: string;
	roadmapRevision: number;
	checkedRevision: number;
	roadmapContentHash: string;
	checkedContentHash: string;
	latestFinding?: string;
	eventId?: string;
	history: RoadmapDetailEvent[];
}

export interface RoadmapDetailHealth {
	status: 'healthy' | 'attention' | 'blocked';
	label: string;
	activePhase: string;
	validationStatus: RoadmapDetailCheck['status'];
	implementationGateStatus: RoadmapDetailCheck['status'];
	qualityGateStatus: RoadmapDetailQualityGate['status'];
	openBlockerCount: number;
}

export interface RoadmapDetailCheck {
	valid: boolean;
	status: 'valid' | 'invalid' | 'open' | 'closed';
	errors: RoadmapDetailIssue[];
	warnings: RoadmapDetailIssue[];
	issues: RoadmapDetailIssue[];
}

export interface RoadmapDetailIssue {
	severity: 'error' | 'warning';
	code: string;
	message: string;
	label: string;
	path?: string;
}

export interface RoadmapDetailWaves {
	total: number;
	counts: {
		pending: number;
		running: number;
		reviewing: number;
		blocked: number;
		complete: number;
	};
	active: RoadmapDetailWave | null;
}

export interface RoadmapDetailWave {
	id: string;
	status: string;
	goal: string;
	label: string;
}

export interface RoadmapDetailTask {
	id: string;
	worker: string;
	status: string;
	title: string;
	label: string;
}

export interface RoadmapDetailMilestone {
	id: string;
	title: string;
	status: string;
	label: string;
	detail: 'outline' | 'plan';
	waves: RoadmapDetailPlanWave[];
}

export interface RoadmapDetailPlanWave {
	id: string;
	status: string;
	goal: string;
	label: string;
	tasks: RoadmapDetailTask[];
}

export interface RoadmapDetailActiveExecution {
	activeWave: RoadmapDetailWave | null;
	progressStep: string;
	activeTasks: RoadmapDetailTask[];
	waveCounts: RoadmapDetailWaves['counts'];
	taskCounts: {
		assigned: number;
		started: number;
		done: number;
		blocked: number;
	};
}

export interface RoadmapDetailBlocker {
	source: 'canonical' | 'progress' | 'wave' | 'task';
	label: string;
	message: string;
	id?: string;
	status?: string;
	severity?: string;
}

export interface RoadmapDetailCanonicalBlockers {
	counts: {
		open: number;
		resolved: number;
		deferred: number;
	};
	open: RoadmapDetailCanonicalBlocker[];
}

export interface RoadmapDetailCanonicalBlocker {
	id: string;
	title: string;
	status: RoadmapBlocker['status'];
	severity: RoadmapBlocker['severity'];
	scope: {
		roadmapId: string;
		milestoneId?: string;
		changeRequestId?: string;
		taskId?: string;
		waveId?: string;
	};
	label: string;
}

export interface RoadmapDetailEvent {
	id: string;
	at: string;
	type: string;
	actor: string;
	summary: string;
	label: string;
}

export type RoadmapDetailControlAction = 'apply_next_action' | 'insert_tool_call' | 'insert_prompt';

export interface RoadmapDetailControl {
	key: string;
	label: string;
	action: RoadmapDetailControlAction;
	enabled: boolean;
	reason?: string;
	tool?: {
		name: string;
		input: Record<string, unknown>;
	};
	prompt?: string;
}

export type RoadmapDetailControlResult =
	| {
	action: 'applied_next_action';
	control: RoadmapDetailControl;
	result: ApplyNextActionResult;
}
	| {
	action: 'insert_prompt';
	control: RoadmapDetailControl;
	prompt: string;
};

export interface RoadmapDetailUsage {
	roadmap: RoadmapDetailUsageTotals;
	topAgents: RoadmapDetailUsageAgent[];
	topAgentsLabel: string;
	milestone?: {
		id: string;
		totals: RoadmapDetailUsageTotals;
		topAgents: RoadmapDetailUsageAgent[];
		topAgentsLabel: string;
	};
	changeRequest?: {
		id: string;
		totals: RoadmapDetailUsageTotals;
		topAgents: RoadmapDetailUsageAgent[];
		topAgentsLabel: string;
	};
}

export interface RoadmapDetailUsageTotals {
	raw: UsageTotals;
	label: string;
	costLabel: string;
	totalTokens: number;
}

export interface RoadmapDetailUsageAgent {
	agent: string;
	totals: RoadmapDetailUsageTotals;
	label: string;
}
