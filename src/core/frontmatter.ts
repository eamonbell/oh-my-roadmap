import YAML from 'yaml'

export interface MarkdownDocument<T extends Record<string, unknown>> {
	data: T;
	body: string;
}

export function parseMarkdownDocument<T extends Record<string, unknown>>(
	text: string,
): MarkdownDocument<T> {
	if (!text.startsWith('---\n')) {
		throw new Error('Markdown document is missing YAML frontmatter')
	}

	const end = text.indexOf('\n---', 4)
	if (end === -1) {
		throw new Error('Markdown document has unterminated YAML frontmatter')
	}

	const yamlText = text.slice(4, end)
	const body = text.slice(end + 4).replace(/^\n/, '')
	const data = YAML.parse(yamlText)
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error('YAML frontmatter must be an object')
	}

	return {data: data as T, body}
}

export function serializeMarkdownDocument<T extends Record<string, unknown>>(
	data: T,
	body: string,
): string {
	return `---\n${YAML.stringify(data).trimEnd()}\n---\n\n${body.trimEnd()}\n`
}

export function parseYaml<T>(text: string): T {
	const data = YAML.parse(text)
	if (!data || typeof data !== 'object') {
		throw new Error('YAML document must be an object')
	}
	return data as T
}

export function serializeYaml(data: unknown): string {
	return `${YAML.stringify(data).trimEnd()}\n`
}
