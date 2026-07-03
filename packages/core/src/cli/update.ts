import {spawn} from 'node:child_process'
import * as path from 'node:path'
import {fileExists, readText, writeText} from '../files'
import {homeConfigDir} from '../project-init'

export const CLI_PACKAGE = '@oh-my-roadmap/cli'
export const EXTENSION_PACKAGE = 'oh-my-roadmap'

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
	const body = (await response.json()) as {version?: string}
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
	current: {cli: string; extension: string},
	fetcher: VersionFetcher = fetchLatestVersion,
): Promise<UpdateCheck> {
	const entries: Array<{name: string; current: string}> = [
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

// Runs `npm install -g <pkg>@latest` for each package with an update. Injected in tests.
export type UpdateRunner = (packageName: string, version: string) => Promise<void>;

const defaultUpdateRunner: UpdateRunner = (packageName, version) =>
	new Promise((resolve, reject) => {
		const child = spawn('npm', ['install', '-g', `${packageName}@${version}`], {stdio: 'inherit'})
		child.on('error', reject)
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install -g ${packageName} exited with code ${code ?? 'null'}`))))
	})

export async function applyUpdates(check: UpdateCheck, runner: UpdateRunner = defaultUpdateRunner): Promise<string[]> {
	const updated: string[] = []
	for (const entry of check.packages) {
		if (!entry.hasUpdate) continue
		await runner(entry.name, entry.latest)
		updated.push(entry.name)
	}
	return updated
}

// Throttle the "update available" notice printed on init/apply. State lives next to
// the global config so it is shared across projects.
const CHECK_STATE_FILE = 'update-check.json'
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

function checkStatePath(homeDir?: string): string {
	return path.join(homeConfigDir(homeDir), CHECK_STATE_FILE)
}

export async function readLastCheck(homeDir?: string): Promise<number> {
	const statePath = checkStatePath(homeDir)
	if (!(await fileExists(statePath))) return 0
	try {
		const state = JSON.parse(await readText(statePath)) as {checkedAt?: number}
		return typeof state.checkedAt === 'number' ? state.checkedAt : 0
	} catch {
		return 0
	}
}

export async function recordCheck(now: number, homeDir?: string): Promise<void> {
	await writeText(checkStatePath(homeDir), `${JSON.stringify({checkedAt: now})}\n`)
}

export function shouldCheck(lastCheck: number, now: number, intervalMs: number = DEFAULT_INTERVAL_MS): boolean {
	return now - lastCheck >= intervalMs
}
