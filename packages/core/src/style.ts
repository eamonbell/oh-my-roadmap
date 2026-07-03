import {loadMergedConfig, type StyleGuide} from './project-init'

// File extension → language id used to key style guidance in config.
const EXTENSION_LANGUAGES: Record<string, string> = {
	ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
	js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
	go: 'go', py: 'python', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin',
	c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
	php: 'php', swift: 'swift', scala: 'scala', sh: 'shell', bash: 'shell', zsh: 'shell',
	sql: 'sql', css: 'css', scss: 'scss', less: 'less', html: 'html', vue: 'vue',
	json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown',
}

// Distinct language ids for the given file paths, sorted for stable output.
export function detectLanguages(files: string[]): string[] {
	const languages = new Set<string>()
	for (const file of files) {
		const ext = file.split('.').pop()?.toLowerCase() ?? ''
		const language = EXTENSION_LANGUAGES[ext]
		if (language) languages.add(language)
	}
	return Array.from(languages).sort((a, b) => a.localeCompare(b))
}

export interface StyleGuideEntry {
	language: string;
	guide: StyleGuide;
}

// Merged (global + project) style guidance for the languages of the given files.
// Returns an empty array when no guidance is recorded for those languages.
export async function styleGuideForFiles(cwd: string, files: string[], homeDir?: string): Promise<StyleGuideEntry[]> {
	let style: Record<string, StyleGuide> | undefined
	try {
		style = (await loadMergedConfig(cwd, homeDir)).style
	} catch {
		return []
	}
	if (!style) return []

	const entries: StyleGuideEntry[] = []
	for (const language of detectLanguages(files)) {
		const guide = style[language]
		if (guide) entries.push({language, guide})
	}
	return entries
}

// Render style entries as compact guidance for a worker prompt/tool result.
export function renderStyleGuide(entries: StyleGuideEntry[]): string {
	if (entries.length === 0) return 'No recorded code-style guidance for these files.'
	return entries
		.map(({language, guide}) => {
			const lines = [`## ${language}`]
			if (guide.summary) lines.push(guide.summary)
			for (const rule of guide.guidelines) lines.push(`- ${rule}`)
			return lines.join('\n')
		})
		.join('\n\n')
}
