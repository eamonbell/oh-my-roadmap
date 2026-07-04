import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {setProjectStyle, type StyleGuide} from '@oh-my-roadmap/core/project-init'
import {renderStyleGuide, styleGuideForFiles} from '@oh-my-roadmap/core/style'
import {textResult, type ToolRegistrationContext} from './shared'

export function registerStyleTools(ctx: ToolRegistrationContext): void {
	const {z, register} = ctx

	register({
		name: 'omr_set_style',
		label: 'Record Code Style',
		description: 'Record per-language code-style guidance into the project .omr/config.yml (used by omr:learn-style). Calling again for a language replaces its guidance.',
		approval: 'exec',
		parameters: z.object({
			language: z.string().describe('Lowercase language id, e.g. typescript, go, python.'),
			summary: z.string().optional().describe('Optional one-line overview of the language style.'),
			guidelines: z.array(z.string()).describe('Compact imperative style rules, e.g. "Naming: camelCase functions".'),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const {language, summary, guidelines} = params as { language: string; summary?: string; guidelines: string[] }
			const guide: StyleGuide = {guidelines}
			if (summary) guide.summary = summary
			await setProjectStyle(ctx.cwd, language, guide)
			return textResult(`Recorded ${guidelines.length} ${language} style guideline${guidelines.length === 1 ? '' : 's'}.`, {
				language,
				guideline_count: guidelines.length,
			})
		},
	} as ToolDefinition)

	register({
		name: 'omr_style_guide',
		label: 'Code Style Guide',
		description: 'Return compact code-style guidance for the languages of the given files, drawn from the project/global config. Guidance is advisory; empty when none is recorded.',
		approval: 'read',
		parameters: z.object({
			files: z.array(z.string()).describe('File paths the worker will edit; language is detected by extension.'),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const {files} = params as { files: string[] }
			const entries = await styleGuideForFiles(ctx.cwd, files)
			return textResult(renderStyleGuide(entries), {
				languages: entries.map((entry) => entry.language),
			})
		},
	} as ToolDefinition)
}
