import {spawn} from 'node:child_process'
import * as path from 'node:path'
import {fileExists, readText, writeText} from '../files'
import {homeConfigDir} from '../project-init'
import {EXTENSION_PACKAGE, type InstallScope, installExtension, resolvePluginRoot} from './install'

export const CLI_PACKAGE = '@oh-my-roadmap/cli'
// Re-exported for callers that import the extension package name from here.
export {EXTENSION_PACKAGE} from './install'

export interface PackageUpdate {
	name: string;
	current: string;
	latest: string;
	hasUpdate: boolean;
}

export interface UpdateCheck {
	packages: PackageUpdate[];
	hasUpdate: boolean;
}

// Resolve a package's latest published version. Injected in tests.
export type VersionFetcher = (packageName: string) => Promise<string>;

// npm registry exposes the dist-tag document at /<pkg>/latest.
export const fetchLatestVersion: VersionFetcher = async (packageName) => {
	const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`)
	if (!response.ok) throw new Error(`registry lookup for ${packageName} failed: ${response.status}`)
	const body = (await response.json()) as { version?: string }
	if (!body.version) throw new Error(`registry returned no version for ${packageName}`)
	return body.version
}

// Compare dot-separated numeric versions; prerelease/build suffixes are ignored.
// Returns negative when a < b, 0 when equal, positive when a > b.
export function compareVersions(a: string, b: string): number {
	const normalize = (value: string): number[] =>
		value
		.split('-')[0]!
		.split('.')
		.map((part) => Number.parseInt(part, 10) || 0)
	const left = normalize(a)
	const right = normalize(b)
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

export async function checkForUpdates(
	current: { cli: string; extension: string },
	fetcher: VersionFetcher = fetchLatestVersion,
): Promise<UpdateCheck> {
	const entries: Array<{ name: string; current: string }> = [
		{name: CLI_PACKAGE, current: current.cli},
		{name: EXTENSION_PACKAGE, current: current.extension},
	]

	const packages = await Promise.all(
		entries.map(async ({name, current: currentVersion}): Promise<PackageUpdate> => {
			const latest = await fetcher(name)
			return {name, current: currentVersion, latest, hasUpdate: compareVersions(latest, currentVersion) > 0}
		}),
	)

	return {packages, hasUpdate: packages.some((entry) => entry.hasUpdate)}
}

// The extension version installed in a plugin root: the version recorded in the
// installed package, falling back to the declared dependency spec, else undefined
// (meaning the extension is not installed in that root).
export async function readInstalledExtensionVersion(pluginRoot: string): Promise<string | undefined> {
	const installedPkg = path.join(pluginRoot, 'node_modules', EXTENSION_PACKAGE, 'package.json')
	if (await fileExists(installedPkg)) {
		try {
			const pkg = JSON.parse(await readText(installedPkg)) as { version?: string }
			if (pkg.version) return pkg.version
		} catch {
			// fall through to the declared spec
		}
	}
	const rootPkg = path.join(pluginRoot, 'package.json')
	if (!(await fileExists(rootPkg))) return undefined
	try {
		const pkg = JSON.parse(await readText(rootPkg)) as { dependencies?: Record<string, string> }
		return pkg.dependencies?.[EXTENSION_PACKAGE]
	} catch {
		return undefined
	}
}

// The CLI self-update: `npm install -g @oh-my-roadmap/cli@<version>`. Injected in tests.
export type CliUpdateRunner = (version: string) => Promise<void>;

const defaultCliUpdateRunner: CliUpdateRunner = (version) =>
	new Promise((resolve, reject) => {
		const child = spawn('npm', ['install', '-g', `${CLI_PACKAGE}@${version}`], {stdio: 'inherit'})
		child.on('error', reject)
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install -g ${CLI_PACKAGE} exited with code ${code ?? 'null'}`))))
	})

export async function updateCli(version: string, runner: CliUpdateRunner = defaultCliUpdateRunner): Promise<void> {
	await runner(version)
}

// Update the extension in the selected scope/profile plugin root by re-installing
// it there (it is not a global npm package). Errors with an actionable message
// when that root has never had the extension installed.
export async function updateExtension(opts: {
	scope: InstallScope;
	cwd: string;
	homeDir?: string | undefined;
	profile?: string | undefined;
	spec?: string | undefined;
	installer?: typeof installExtension | undefined;
}): Promise<void> {
	const root = resolvePluginRoot(opts.scope, opts)
	if ((await readInstalledExtensionVersion(root)) === undefined) {
		const where = opts.profile ? `profile "${opts.profile}"` : opts.scope
		const installHint = opts.profile
			? `omr install --global --profile ${opts.profile}`
			: `omr install --${opts.scope}`
		throw new Error(
			`${EXTENSION_PACKAGE} is not installed for ${where} (${root}). Run \`${installHint}\` first.`,
		)
	}
	const install = opts.installer ?? installExtension
	await install({
		scope: opts.scope,
		cwd: opts.cwd,
		homeDir: opts.homeDir,
		profile: opts.profile,
		spec: opts.spec ?? 'latest',
	})
}

// Throttle the "update available" notice printed on init/apply. State lives next to
// the (profile-scoped) global config so it is shared across projects.
const CHECK_STATE_FILE = 'update-check.json'
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

function checkStatePath(homeDir?: string, profile?: string): string {
	return path.join(homeConfigDir(homeDir, profile), CHECK_STATE_FILE)
}

export async function readLastCheck(homeDir?: string, profile?: string): Promise<number> {
	const statePath = checkStatePath(homeDir, profile)
	if (!(await fileExists(statePath))) return 0
	try {
		const state = JSON.parse(await readText(statePath)) as { checkedAt?: number }
		return typeof state.checkedAt === 'number' ? state.checkedAt : 0
	} catch {
		return 0
	}
}

export async function recordCheck(now: number, homeDir?: string, profile?: string): Promise<void> {
	await writeText(checkStatePath(homeDir, profile), `${JSON.stringify({checkedAt: now})}\n`)
}

export function shouldCheck(lastCheck: number, now: number, intervalMs: number = DEFAULT_INTERVAL_MS): boolean {
	return now - lastCheck >= intervalMs
}
