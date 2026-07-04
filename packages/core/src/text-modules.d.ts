// Markdown imported with `with { type: 'text' }` resolves to the file's raw contents
// as a string. The bundler (bun) inlines it into the output; the bun runtime provides
// the text directly. This keeps agent-template prompts authored as .md while letting
// them travel with the code instead of being copied/read from disk at runtime.
declare module '*.md' {
	const content: string
	export default content
}
