#!/usr/bin/env node
import {createRequire} from 'node:module'
import * as clack from '@clack/prompts'
import {Command, CommanderError} from 'commander'
import {
	type AgentConfig,
	type AgentRole,
	applyScoped,
	initProject,
	initScoped,
	type OmpScope,
	type ProjectInitResult,
	resolveScopeAndProfile,
	ROLE_NAMES,
	setAgentTemplateSourceProvider,
	THINKING_LEVELS,
} from '@oh-my-roadmap/core'
import {EXTENSION_PACKAGE, installExtension, resolvePluginRoot} from '@oh-my-roadmap/core/cli/install'
import {
	checkForUpdates,
	CLI_PACKAGE,
	compareVersions,
	fetchLatestVersion,
	readInstalledExtensionVersion,
	readLastCheck,
	recordCheck,
	shouldCheck,
	updateCli,
	updateExtension,
} from '@oh-my-roadmap/core/cli/update'

import workerLight from '@oh-my-roadmap/core/agent-templates/worker-light/AGENT.md' with {type: 'text'}
import worker from '@oh-my-roadmap/core/agent-templates/worker/AGENT.md' with {type: 'text'}
import workerHeavy from '@oh-my-roadmap/core/agent-templates/worker-heavy/AGENT.md' with {type: 'text'}
import reviewer from '@oh-my-roadmap/core/agent-templates/reviewer/AGENT.md' with {type: 'text'}
import waveFlowChecker from '@oh-my-roadmap/core/agent-templates/wave-flow-checker/AGENT.md' with {type: 'text'}
import roadmapMilestoneChecker from '@oh-my-roadmap/core/agent-templates/roadmap-milestone-checker/AGENT.md' with {type: 'text'}
import styleScout from '@oh-my-roadmap/core/agent-templates/style-scout/AGENT.md' with {type: 'text'}

const EMBEDDED_TEMPLATES: Record<AgentRole, string> = {
	'worker-light': workerLight,
	'worker': worker,
	'worker-heavy': workerHeavy,
	'reviewer': reviewer,
	'wave-flow-checker': waveFlowChecker,
	'roadmap-milestone-checker': roadmapMilestoneChecker,
	'style-scout': styleScout,
}

setAgentTemplateSourceProvider((name) => EMBEDDED_TEMPLATES[name])

const require = createRequire(import.meta.url)
const {version: VERSION} = require('../package.json') as { version: string }

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

interface ScopeFlags {
	global?: boolean;
	project?: boolean;
	profile?: string;
}

function out(message: string): void {
	process.stdout.write(message)
}

function reportResult(verb: string, result: ProjectInitResult): void {
	out(`${verb} ${result.configPath}\n`)
	for (const agentPath of Object.values(result.agentPaths)) {
		out(`  wrote ${agentPath}\n`)
	}
}

function emptyAgents(): Record<AgentRole, AgentConfig> {
	return Object.fromEntries(ROLE_NAMES.map((role) => [role, {}])) as Record<AgentRole, AgentConfig>
}

// Unwrap a @clack prompt result, aborting cleanly on Ctrl-C / cancel.
function ensure<T>(value: T | symbol): T {
	if (clack.isCancel(value)) {
		clack.cancel('Aborted.')
		process.exit(1)
	}
	return value as T
}

async function promptScope(): Promise<OmpScope> {
	return ensure(
		await clack.select({
			message: 'Scope',
			initialValue: 'project' as OmpScope,
			options: [
				{value: 'project' as OmpScope, label: 'project', hint: '.omr/config.yml + .omp/agents in this folder'},
				{value: 'global' as OmpScope, label: 'global', hint: 'user-level ~/.omp config + agents'},
			],
		}),
	)
}

// Prompt for an OMP profile; blank keeps the default (base) root.
async function promptProfile(): Promise<string | undefined> {
	const answer = ensure(
		await clack.text({message: 'OMP profile (blank = default)', placeholder: 'default', defaultValue: ''}),
	).trim()
	return answer ? answer : undefined
}

async function promptModels(): Promise<Record<AgentRole, AgentConfig>> {
	clack.note(
		'Leave a model blank to inherit OMP defaults. Enter model ids exactly as OMP expects them.',
		'Configure a model + reasoning level per agent role',
	)
	const agents = {} as Record<AgentRole, AgentConfig>
	for (const role of ROLE_NAMES) {
		const model = ensure(
			await clack.text({message: `${role} — model (blank = inherit)`, defaultValue: ''}),
		).trim()
		const thinking = ensure(
			await clack.select({
				message: `${role} — reasoning`,
				initialValue: 'inherit',
				options: THINKING_LEVELS.map((level) => ({value: level as string, label: level})),
			}),
		)
		const config: AgentConfig = {}
		if (model) config.model = model
		if (thinking && thinking !== 'inherit') config.thinking = thinking
		agents[role] = config
	}
	return agents
}

// Resolve scope + profile from flags, prompting for the scope when nothing was
// specified and we're interactive (used by init/install).
async function resolveTarget(flags: ScopeFlags, promptWhenUnset: boolean): Promise<{ scope: OmpScope; profile: string | undefined }> {
	const unset = !flags.global && !flags.project && flags.profile === undefined
	if (unset && promptWhenUnset && interactive) {
		const scope = await promptScope()
		const profile = scope === 'global' ? await promptProfile() : undefined
		return {scope, profile}
	}
	return resolveScopeAndProfile(flags)
}

async function runInit(cwd: string, flags: ScopeFlags): Promise<void> {
	const {scope, profile} = await resolveTarget(flags, /* promptWhenUnset */ true)

	// Non-interactive project init scaffolds the default config; interactive init
	// writes the prompted per-role models.
	const agents = interactive ? await promptModels() : emptyAgents()
	if (scope === 'project' && !interactive) {
		reportResult('Created', await initProject(cwd))
	} else {
		const result = await initScoped({scope, cwd, agents, profile})
		reportResult(result.createdConfig ? 'Created' : 'Updated', result)
		if (scope === 'global') {
			out(`  scaffolded a model-free .omr/config.yml in ${cwd}\n`)
			if (profile) out(`  targeted OMP profile "${profile}"\n`)
		}
	}
	await maybeNoticeUpdate()
}

async function runApply(cwd: string, flags: ScopeFlags): Promise<void> {
	const {scope, profile} = resolveScopeAndProfile(flags)
	reportResult('Applied', await applyScoped({scope, cwd, profile}))
	await maybeNoticeUpdate()
}

async function runInstall(cwd: string, flags: ScopeFlags): Promise<void> {
	const {scope, profile} = await resolveTarget(flags, /* promptWhenUnset */ true)
	const target = profile ? `${scope} (profile "${profile}")` : scope
	out(`Installing ${EXTENSION_PACKAGE} into the ${target} OMP plugin root...\n`)
	const result = await installExtension({scope, cwd, profile})
	out(`Installed ${EXTENSION_PACKAGE}@${result.spec} at ${result.root}\n`)
	out('OMP will auto-discover it on next launch (confirm with: omp -p \'/extensions\').\n')
}

async function runUpdate(cwd: string, flags: ScopeFlags & { check?: boolean }): Promise<void> {
	// Updates default to the global plugin root (where the extension normally lives).
	const noScope = !flags.global && !flags.project && flags.profile === undefined
	const {scope, profile} = resolveScopeAndProfile(noScope ? {global: true} : flags)

	const pluginRoot = resolvePluginRoot(scope, {cwd, profile})
	const installed = await readInstalledExtensionVersion(pluginRoot)
	if (installed === undefined) {
		const hint = profile ? `omr install --global --profile ${profile}` : `omr install --${scope}`
		const where = profile ? `profile "${profile}"` : scope
		throw new Error(`${EXTENSION_PACKAGE} is not installed for ${where} (${pluginRoot}). Run \`${hint}\` first.`)
	}

	// The CLI and extension are released together; compare each against the registry.
	const check = await checkForUpdates({cli: VERSION, extension: installed})
	for (const pkg of check.packages) {
		const status = pkg.hasUpdate ? 'update available' : 'up to date'
		out(`${pkg.name}: ${pkg.current} -> ${pkg.latest} (${status})\n`)
	}

	if (!check.hasUpdate) {
		out('Everything is up to date.\n')
		return
	}
	if (flags.check) {
		out('Run \'omr update\' to apply.\n')
		return
	}
	if (interactive) {
		const confirmed = ensure(await clack.confirm({message: 'Apply updates?', initialValue: false}))
		if (!confirmed) {
			out('Aborted.\n')
			return
		}
	}

	const updated: string[] = []
	const cliPkg = check.packages.find((pkg) => pkg.name === CLI_PACKAGE)
	if (cliPkg?.hasUpdate) {
		await updateCli(cliPkg.latest)
		updated.push(CLI_PACKAGE)
	}
	const extPkg = check.packages.find((pkg) => pkg.name === EXTENSION_PACKAGE)
	if (extPkg?.hasUpdate) {
		await updateExtension({scope, cwd, profile, spec: extPkg.latest})
		updated.push(EXTENSION_PACKAGE)
	}
	out(`Updated: ${updated.join(', ') || '(none)'}\n`)
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

function buildProgram(cwd: string): Command {
	const program = new Command()
	program
	.name('omr')
	.description('oh-my-roadmap project scaffolding: config + agent generation, extension install/update')
	.version(VERSION, '-v, --version', 'Print the version')
	.showHelpAfterError()

	program
	.command('init')
	.description('Prompt for models + reasoning and scaffold config + agents')
	.option('--global', 'user-level config + agents under ~/.omp')
	.option('--project', 'config at .omr/config.yml, agents at .omp/agents (default)')
	.option('--profile <name>', 'target a specific OMP profile (implies --global)')
	.action((flags: ScopeFlags) => runInit(cwd, flags))

	program
	.command('apply')
	.description('Regenerate agent definitions from an existing config')
	.option('--global', 'regenerate the global (~/.omp) agents')
	.option('--project', 'regenerate the project (.omp/agents) agents (default)')
	.option('--profile <name>', 'target a specific OMP profile (implies --global)')
	.action((flags: ScopeFlags) => runApply(cwd, flags))

	program
	.command('install')
	.description('Install the oh-my-roadmap extension into OMP\'s plugin root')
	.option('--global', 'install into the user-level plugin root')
	.option('--project', 'install into the project plugin root (default)')
	.option('--profile <name>', 'install into a specific OMP profile (implies --global)')
	.action((flags: ScopeFlags) => runInstall(cwd, flags))

	program
	.command('update')
	.description('Check npm for a newer CLI + extension and update (extension defaults to --global)')
	.option('--check', 'only report available updates')
	.option('--global', 'update the extension in the user-level plugin root (default)')
	.option('--project', 'update the extension in the project plugin root')
	.option('--profile <name>', 'update the extension in a specific OMP profile')
	.action((flags: ScopeFlags & { check?: boolean }) => runUpdate(cwd, flags))

	return program
}

async function main(argv: string[]): Promise<number> {
	const cwd = process.cwd()
	const program = buildProgram(cwd)
	program.exitOverride()

	if (argv.length === 0) {
		program.outputHelp()
		return 1
	}

	try {
		await program.parseAsync(argv, {from: 'user'})
		return 0
	} catch (error) {
		// Commander throws for --help/--version/parse errors; output is already written.
		if (error instanceof CommanderError) {
			return error.exitCode
		}
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`omr: ${message}\n`)
		return 1
	}
}

main(process.argv.slice(2)).then((code) => {
	process.exit(code)
})
