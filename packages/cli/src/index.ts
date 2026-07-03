#!/usr/bin/env node
import * as readline from 'node:readline/promises'
import {
	applyProject,
	initProject,
	initScoped,
	ROLE_NAMES,
	THINKING_LEVELS,
	type AgentConfig,
	type AgentRole,
	type InitScope,
	type ProjectInitResult,
} from 'oh-my-roadmap-core'
import {EXTENSION_PACKAGE, installExtension, type InstallScope} from 'oh-my-roadmap-core/cli/install'
import {
	CLI_PACKAGE,
	applyUpdates,
	checkForUpdates,
	compareVersions,
	fetchLatestVersion,
	readLastCheck,
	recordCheck,
	shouldCheck,
} from 'oh-my-roadmap-core/cli/update'

const VERSION = '0.9.0'

const HELP = `omr ${VERSION} — oh-my-roadmap project scaffolding

Usage:
  omr init [--global|--project]     Prompt for models + reasoning and scaffold config + agents
  omr apply                         Regenerate .omp/agents/*.md from the existing .omr/config.yml
  omr install [--global|--project]  Install the oh-my-roadmap extension into OMP's plugin root
  omr update [--check]              Check npm for newer CLI + extension and update

Scopes:
  --project  (default)  Config at .omr/config.yml, agents at .omp/agents/
  --global              Config + agents under ~/.omp; a model-free .omr/config.yml is also scaffolded

Options:
  -h, --help       Show this help
  -v, --version    Print the version
`

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

function reportResult(verb: string, result: ProjectInitResult): void {
	process.stdout.write(`${verb} ${result.configPath}\n`)
	for (const agentPath of Object.values(result.agentPaths)) {
		process.stdout.write(`  wrote ${agentPath}\n`)
	}
}

function scopeFlag(rest: string[]): InitScope | undefined {
	if (rest.includes('--global')) return 'global'
	if (rest.includes('--project')) return 'project'
	return undefined
}

function emptyAgents(): Record<AgentRole, AgentConfig> {
	return Object.fromEntries(ROLE_NAMES.map((role) => [role, {}])) as Record<AgentRole, AgentConfig>
}

async function withReadline<T>(fn: (rl: readline.Interface) => Promise<T>): Promise<T> {
	const rl = readline.createInterface({input: process.stdin, output: process.stdout})
	try {
		return await fn(rl)
	} finally {
		rl.close()
	}
}

async function promptScope(rl: readline.Interface): Promise<InitScope> {
	for (;;) {
		const answer = (await rl.question('Scope [project/global] (project): ')).trim().toLowerCase()
		if (answer === '' || answer === 'project' || answer === 'p') return 'project'
		if (answer === 'global' || answer === 'g') return 'global'
		process.stdout.write('Please enter "project" or "global".\n')
	}
}

async function promptModels(rl: readline.Interface): Promise<Record<AgentRole, AgentConfig>> {
	process.stdout.write('\nConfigure a model + reasoning level per agent role.\n')
	process.stdout.write('Leave blank to inherit OMP defaults. Enter model ids exactly as OMP expects them.\n')
	process.stdout.write(`Reasoning levels: ${THINKING_LEVELS.join(', ')}\n\n`)

	const agents = {} as Record<AgentRole, AgentConfig>
	for (const role of ROLE_NAMES) {
		const model = (await rl.question(`  ${role} — model (blank = inherit): `)).trim()
		let thinking = ''
		for (;;) {
			thinking = (await rl.question(`  ${role} — reasoning (blank = inherit): `)).trim()
			if (thinking === '' || (THINKING_LEVELS as readonly string[]).includes(thinking)) break
			process.stdout.write(`    Invalid reasoning level. Choose one of: ${THINKING_LEVELS.join(', ')}\n`)
		}
		const config: AgentConfig = {}
		if (model) config.model = model
		if (thinking) config.thinking = thinking
		agents[role] = config
	}
	return agents
}

async function runInit(cwd: string, rest: string[]): Promise<number> {
	const flagScope = scopeFlag(rest)

	if (!interactive) {
		const scope = flagScope ?? 'project'
		if (scope === 'project') {
			reportResult('Created', await initProject(cwd))
			return 0
		}
		const result = await initScoped({scope: 'global', cwd, agents: emptyAgents()})
		reportResult(result.createdConfig ? 'Created' : 'Updated', result)
		return 0
	}

	return withReadline(async (rl) => {
		const scope = flagScope ?? (await promptScope(rl))
		const agents = await promptModels(rl)
		const result = await initScoped({scope, cwd, agents})
		reportResult(result.createdConfig ? 'Created' : 'Updated', result)
		if (scope === 'global') {
			process.stdout.write(`  scaffolded a model-free .omr/config.yml in ${cwd}\n`)
		}
		return 0
	})
}

async function runInstall(cwd: string, rest: string[]): Promise<number> {
	const scope: InstallScope = scopeFlag(rest) ?? (interactive ? await withReadline(promptScope) : 'project')
	process.stdout.write(`Installing ${EXTENSION_PACKAGE} into the ${scope} OMP plugin root...\n`)
	const result = await installExtension({scope, cwd})
	process.stdout.write(`Installed ${EXTENSION_PACKAGE}@${result.spec} at ${result.root}\n`)
	process.stdout.write('OMP will auto-discover it on next launch (confirm with: omp -p \'/extensions\').\n')
	return 0
}

async function runUpdate(rest: string[]): Promise<number> {
	const checkOnly = rest.includes('--check')
	// The CLI and extension are versioned together; use the CLI version as the
	// baseline for both when reporting available updates.
	const check = await checkForUpdates({cli: VERSION, extension: VERSION})
	for (const pkg of check.packages) {
		const status = pkg.hasUpdate ? 'update available' : 'up to date'
		process.stdout.write(`${pkg.name}: ${pkg.current} -> ${pkg.latest} (${status})\n`)
	}

	if (!check.hasUpdate) {
		process.stdout.write('Everything is up to date.\n')
		return 0
	}
	if (checkOnly) {
		process.stdout.write("Run 'omr update' to apply.\n")
		return 0
	}
	if (interactive) {
		const confirmed = await withReadline(async (rl) =>
			(await rl.question('Apply updates? [y/N]: ')).trim().toLowerCase().startsWith('y'),
		)
		if (!confirmed) {
			process.stdout.write('Aborted.\n')
			return 0
		}
	}
	const updated = await applyUpdates(check)
	process.stdout.write(`Updated: ${updated.join(', ') || '(none)'}\n`)
	return 0
}

// Throttled, best-effort "update available" notice on init/apply. Only when interactive,
// never fatal — a failed network check must not break scaffolding.
async function maybeNoticeUpdate(): Promise<void> {
	if (!interactive) return
	try {
		const now = Date.now()
		if (!shouldCheck(await readLastCheck(), now)) return
		await recordCheck(now)
		const latest = await fetchLatestVersion(CLI_PACKAGE)
		if (compareVersions(latest, VERSION) > 0) {
			process.stderr.write(`\nomr ${latest} is available (current ${VERSION}). Run 'omr update'.\n`)
		}
	} catch {
		// best-effort only
	}
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0]
	const rest = argv.slice(1)

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
				const code = await runInit(cwd, rest)
				await maybeNoticeUpdate()
				return code
			}
			case 'apply': {
				reportResult('Applied', await applyProject(cwd))
				await maybeNoticeUpdate()
				return 0
			}
			case 'install':
				return await runInstall(cwd, rest)
			case 'update':
				return await runUpdate(rest)
			default:
				process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
				return 1
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`omr ${command} failed: ${message}\n`)
		return 1
	}
}

main(process.argv.slice(2)).then((code) => {
	process.exit(code)
})
