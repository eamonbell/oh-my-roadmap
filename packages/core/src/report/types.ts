import type {LoadedState} from '../types'

export type NextActionStatus =
	| 'ready'
	| 'blocked'
	| 'needs_input'
	| 'approval_required'
	| 'agent_required'
	| 'stale';

export interface NextActionScope {
	roadmap_id?: string;
	milestone_id?: string;
	change_request_id?: string;
	task_id?: string;
	wave_id?: string;
}

export interface NextActionPlan {
	id: string;
	label: string;
	description: string;
	status: NextActionStatus;
	safe_to_apply: boolean;
	blockers: string[];
	missing_inputs: string[];
	scope: NextActionScope;
	tool?: {
		name: string;
		input: Record<string, unknown>;
	};
}

export interface ApplyNextActionResult {
	action: string;
	plan: NextActionPlan;
	state: LoadedState;
}
