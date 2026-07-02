export type ContextArtifact = 'notes' | 'decisions' | 'risks' | 'roadmap' | 'plan';
export type ContextNoteKind = 'worker' | 'review' | 'orchestrator' | 'decision' | 'issue';
export type ContextNoteStatus = 'open' | 'resolved' | 'deferred';

export interface SearchContextInput {
	artifacts?: ContextArtifact[];
	query?: string;
	useRegex?: boolean;
	caseSensitive?: boolean;
	maxResults?: number;
	snippetChars?: number;
	includeBodies?: boolean;
	maxBodyChars?: number;
	milestoneIds?: string[];
	kinds?: ContextNoteKind[];
	statuses?: ContextNoteStatus[];
	blocking?: boolean;
	waveId?: string;
	taskId?: string;
	taskIds?: string[];
	workerId?: string;
}

export interface ReadContextInput {
	ids: string[];
	maxBodyChars?: number;
}

export interface ContextEntryResult {
	id: string;
	artifact: ContextArtifact;
	path: string;
	milestoneId?: string;
	title: string;
	metadata: Record<string, unknown>;
	snippet: string;
	snippetTruncated: boolean;
	body?: string;
	bodyTruncated?: boolean;
}

export interface ContextSearchResult {
	roadmapId?: string;
	total: number;
	returned: number;
	results: ContextEntryResult[];
}

export interface ContextReadResult {
	roadmapId?: string;
	requested: number;
	found: number;
	results: ContextEntryResult[];
	missingIds: string[];
}

export interface ContextEntry {
	id: string;
	artifact: ContextArtifact;
	path: string;
	milestoneId?: string;
	title: string;
	body: string;
	metadata: Record<string, unknown>;
	order: number;
}
