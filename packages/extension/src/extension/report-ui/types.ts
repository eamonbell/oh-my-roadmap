import type {ScrollView} from '@oh-my-pi/pi-tui'
import type {RoadmapDetailSummary} from 'oh-my-roadmap-core/roadmap-detail-summary/index'
import {TAB_NAMES} from './constants'

export type FocusArea = 'rail' | 'main';
export type TabName = (typeof TAB_NAMES)[number];

export type RenderRoadmapDetailsFrameOptions = {
	summary: RoadmapDetailSummary;
	width: number;
	height: number;
	scrollView: ScrollView;
	activeTabIndex?: number;
	focus?: FocusArea;
	message?: string;
};

export type RenderBodyOptions = {
	summary: RoadmapDetailSummary;
	contentWidth: number;
	bodyHeight: number;
	scrollView: ScrollView;
	activeTabIndex: number;
	focus: FocusArea;
	message: string;
};

export type ColumnLayout =
	| { mode: 'stacked'; contentWidth: number }
	| { mode: 'columns'; contentWidth: number; railWidth: number; mainWidth: number };
