export const ROADMAP_ROOT = ".roadmaps";

export const PHASES = [
  "discovery",
  "roadmap_draft",
  "roadmap_approved",
  "milestone_planning",
  "milestone_approved",
  "implementing",
  "reviewing",
  "closeout",
  "complete",
] as const;

export type Phase = (typeof PHASES)[number];

export interface Approval {
  by: string;
  at: string;
  summary: string;
}

export type EvidenceStatus = "open" | "passed" | "failed" | "deferred";

export interface EvidenceResult {
  item: string;
  status: EvidenceStatus;
  reason?: string;
  approver?: string;
  at?: string;
}

export interface RiskDisposition {
  risk: string;
  disposition: "resolved" | "deferred";
  reason?: string;
  approver?: string;
}

export interface CloseoutEvidence {
  roadmap_id: string;
  milestone_id: string;
  change_request_id?: string;
  status: "open" | "recorded" | "closed";
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
  status: Phase | "planned" | "blocked";
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

export interface TaskPlan {
  id: string;
  title: string;
  worker: string;
  status: "assigned" | "started" | "done" | "blocked";
  depends_on: string[];
  owned_files: string[];
  owned_modules: string[];
  shared_interfaces: string[];
}

export interface WavePlan {
  id: string;
  status: "pending" | "running" | "reviewing" | "blocked" | "complete";
  tasks: string[];
}

export interface MilestonePlan {
  roadmap_id: string;
  milestone_id: string;
  title: string;
  status: Phase;
  approvals: Approval[];
  open_questions: string[];
  verification_commands: string[];
  acceptance_criteria: string[];
  cleanup_policy: "approval-gated";
  tasks: TaskPlan[];
  waves: WavePlan[];
}

export interface ChangeRequest {
  roadmap_id: string;
  milestone_id: string;
  change_request_id: string;
  title: string;
  status: "draft" | "approved" | "implementing" | "reviewing" | "closed";
  requested_at: string;
  request: string;
  approvals: Approval[];
  verification_commands: string[];
  acceptance_criteria: string[];
  tasks: TaskPlan[];
  waves: WavePlan[];
  closeout?: CloseoutEvidence;
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
}
