#!/usr/bin/env node
import {applyProject, initProject, type ProjectInitResult} from '@oh-my-roadmap/core'

const VERSION = '0.8.0'

const HELP = `omr-cli ${VERSION} — oh-my-roadmap project scaffolding

Usage:
  omr-cli init     Create .roadmaps/config.yml (when missing) and generate .omp/agents/*.md
  omr-cli apply    Regenerate .omp/agents/*.md from the existing .roadmaps/config.yml

Options:
  -h, --help       Show this help
  -v, --version    Print the version
`

function reportResult(verb: string, result: ProjectInitResult): void {
	process.stdout.write(`${verb} ${result.configPath}\n`)
	for (const agentPath of Object.values(result.agentPaths)) {
		process.stdout.write(`  wrote ${agentPath}\n`)
	}
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0]

	if (command === undefined || command === '-h' || command === '--help') {
		process.stdout.write(HELP)
		return command === undefined ? 1 : 0
	}
	if (command === '-v' || command === '--version') {
		process.stdout.write(`${VERSION}\n`)
		return 0
	}

	const cwd = process.cwd()
	try {
		switch (command) {
			case 'init': {
				const result = await initProject(cwd)
				reportResult(result.createdConfig ? 'Created' : 'Updated', result)
				return 0
			}
			case 'apply': {
				const result = await applyProject(cwd)
				reportResult('Applied', result)
				return 0
			}
			default:
				process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
				return 1
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`omr-cli ${command} failed: ${message}\n`)
		return 1
	}
}

main(process.argv.slice(2)).then((code) => {
	process.exit(code)
})
