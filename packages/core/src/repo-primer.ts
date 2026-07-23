import * as crypto from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { readYamlFile, writeYamlFile } from './files'
import { repoPrimerPath } from './paths'

export type RepoPackageManager =
	| 'bun'
	| 'pnpm'
	| 'yarn'
	| 'npm'
	| 'uv'
	| 'poetry'
	| 'cargo'
	| 'go'
	| 'maven'
	| 'gradle'
	| 'bundler'
	| 'composer'
	| 'make'

export interface RepoPrimerManifest {
	path: string
	ecosystem: 'javascript' | 'python' | 'rust' | 'go' | 'java' | 'ruby' | 'php' | 'generic'
	kind: 'manifest' | 'lockfile' | 'build' | 'requirements'
	sha256: string
}

export interface RepoPrimerCommand {
	category: 'test' | 'build' | 'typecheck'
	command: string
	source_path: string
}

export interface RepoPrimerGuidance {
	path: string
	sha256: string
	excerpt: string
	truncated: boolean
}

export interface RepoPrimer {
	schema_version: 1
	generated_at: string
	source_fingerprint: string
	package_managers: RepoPackageManager[]
	manifests: RepoPrimerManifest[]
	workspace_members: string[]
	commands: RepoPrimerCommand[]
	test_roots: string[]
	module_roots: string[]
	guidance: RepoPrimerGuidance[]
	warnings: string[]
}

export type RepoPrimerRefreshResult =
	| { status: 'created' | 'refreshed' | 'unchanged' | 'stale_fallback'; primer: RepoPrimer; warnings: string[] }
	| { status: 'unavailable'; warnings: string[] }

interface FileSpec {
	ecosystem: RepoPrimerManifest['ecosystem']
	kind: RepoPrimerManifest['kind']
}

const FILE_SPECS: Readonly<Record<string, FileSpec>> = {
	'package.json': { ecosystem: 'javascript', kind: 'manifest' },
	'bun.lock': { ecosystem: 'javascript', kind: 'lockfile' },
	'bun.lockb': { ecosystem: 'javascript', kind: 'lockfile' },
	'pnpm-lock.yaml': { ecosystem: 'javascript', kind: 'lockfile' },
	'yarn.lock': { ecosystem: 'javascript', kind: 'lockfile' },
	'package-lock.json': { ecosystem: 'javascript', kind: 'lockfile' },
	'pyproject.toml': { ecosystem: 'python', kind: 'manifest' },
	'uv.lock': { ecosystem: 'python', kind: 'lockfile' },
	'poetry.lock': { ecosystem: 'python', kind: 'lockfile' },
	'requirements.txt': { ecosystem: 'python', kind: 'requirements' },
	'Cargo.toml': { ecosystem: 'rust', kind: 'manifest' },
	'Cargo.lock': { ecosystem: 'rust', kind: 'lockfile' },
	'go.mod': { ecosystem: 'go', kind: 'manifest' },
	'go.work': { ecosystem: 'go', kind: 'manifest' },
	'go.sum': { ecosystem: 'go', kind: 'lockfile' },
	'pom.xml': { ecosystem: 'java', kind: 'build' },
	'build.gradle': { ecosystem: 'java', kind: 'build' },
	'build.gradle.kts': { ecosystem: 'java', kind: 'build' },
	'settings.gradle': { ecosystem: 'java', kind: 'build' },
	'settings.gradle.kts': { ecosystem: 'java', kind: 'build' },
	'gradle.lockfile': { ecosystem: 'java', kind: 'lockfile' },
	Gemfile: { ecosystem: 'ruby', kind: 'manifest' },
	'Gemfile.lock': { ecosystem: 'ruby', kind: 'lockfile' },
	'composer.json': { ecosystem: 'php', kind: 'manifest' },
	'composer.lock': { ecosystem: 'php', kind: 'lockfile' },
	Makefile: { ecosystem: 'generic', kind: 'build' },
}

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const FILE_NAMES = Object.keys(FILE_SPECS).sort(lexical)
const MODULE_NAMES = new Set(['src', 'lib', 'packages', 'apps', 'crates', 'cmd', 'internal'])
const TEST_NAMES = new Set(['test', 'tests', 'spec', '__tests__'])
const MANAGER_ORDER: RepoPackageManager[] = [
	'bun', 'pnpm', 'yarn', 'npm', 'uv', 'poetry', 'cargo', 'go', 'maven', 'gradle', 'bundler', 'composer', 'make',
]
const JS_LOCKS: Readonly<Record<string, Extract<RepoPackageManager, 'bun' | 'pnpm' | 'yarn' | 'npm'>>> = {
	'bun.lock': 'bun',
	'bun.lockb': 'bun',
	'pnpm-lock.yaml': 'pnpm',
	'yarn.lock': 'yarn',
	'package-lock.json': 'npm',
}
const CATEGORY_ORDER: Record<RepoPrimerCommand['category'], number> = { test: 0, build: 1, typecheck: 2 }
const WALK_EXCLUDES = new Set(['.git', '.omr', 'node_modules'])

function slash(value: string): string {
	return value.split(path.sep).join('/')
}

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function hash(value: string | Uint8Array): string {
	return crypto.createHash('sha256').update(value).digest('hex')
}

function addFingerprintPart(hasher: crypto.Hash, kind: string, value: string | Uint8Array): void {
	const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
	hasher.update(`${kind}:${bytes.byteLength}:`)
	hasher.update(bytes)
	hasher.update('\n')
}

async function confinedStat(rootReal: string, candidate: string): Promise<{ real: string; stat: Stats } | undefined> {
	try {
		const real = await fs.realpath(candidate)
		if (!inside(rootReal, real)) return undefined
		return { real, stat: await fs.stat(real) }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

function segmentPattern(segment: string): RegExp {
	const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
	return new RegExp(`^${escaped}$`)
}

async function expandWorkspacePattern(root: string, rootReal: string, rawPattern: string): Promise<string[]> {
	if (rawPattern.trim() === '' || path.isAbsolute(rawPattern)) throw new Error(`Invalid workspace pattern: ${rawPattern}`)
	const segments = rawPattern.replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(Boolean)
	if (segments.some((segment) => segment === '..')) throw new Error(`Workspace pattern escapes the repository: ${rawPattern}`)
	const matches = new Set<string>()
	const visited = new Set<string>()

	async function visit(current: string, index: number): Promise<void> {
		const checked = await confinedStat(rootReal, current)
		if (!checked?.stat.isDirectory()) return
		const visitKey = `${checked.real}\0${index}`
		if (visited.has(visitKey)) return
		visited.add(visitKey)
		if (index === segments.length) {
			matches.add(slash(path.relative(root, current)))
			return
		}
		const segment = segments[index]
		if (segment === '**') {
			await visit(current, index + 1)
			const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name))
			for (const entry of entries) {
				if (WALK_EXCLUDES.has(entry.name)) continue
				await visit(path.join(current, entry.name), index)
			}
			return
		}
		const matcher = segmentPattern(segment ?? '')
		const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name))
		for (const entry of entries) {
			if (!matcher.test(entry.name)) continue
			await visit(path.join(current, entry.name), index + 1)
		}
	}

	await visit(root, 0)
	return [...matches].filter(Boolean).sort(lexical)
}

function packageObject(text: string, sourcePath: string): Record<string, unknown> {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (error) {
		throw new Error(`Cannot parse ${sourcePath}: ${(error as Error).message}`)
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${sourcePath} must contain a JSON object`)
	return value as Record<string, unknown>
}

function workspacePatterns(pkg: Record<string, unknown>): string[] {
	const value = pkg.workspaces
	if (value === undefined) return []
	const patterns = Array.isArray(value)
		? value
		: value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>).packages
			: undefined
	if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== 'string')) {
		throw new Error('package.json workspaces must be a string array or an object with a string-array packages field')
	}
	return patterns as string[]
}

async function existingCandidate(
	root: string,
	rootReal: string,
	relativePath: string,
	warnings: string[],
): Promise<{ path: string; content: Buffer } | undefined> {
	const absolute = path.join(root, ...relativePath.split('/'))
	let present = false
	try {
		await fs.lstat(absolute)
		present = true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	if (!present) return undefined
	const checked = await confinedStat(rootReal, absolute)
	if (!checked) {
		warnings.push(`Ignored repository-escaping path: ${relativePath}`)
		return undefined
	}
	if (!checked.stat.isFile()) {
		warnings.push(`Ignored non-file manifest candidate: ${relativePath}`)
		return undefined
	}
	return { path: relativePath, content: await fs.readFile(checked.real) }
}

async function existingDirectory(root: string, rootReal: string, relativePath: string, warnings: string[]): Promise<boolean> {
	const checked = await confinedStat(rootReal, path.join(root, ...relativePath.split('/')))
	if (!checked) {
		try {
			await fs.lstat(path.join(root, ...relativePath.split('/')))
			warnings.push(`Ignored repository-escaping path: ${relativePath}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		return false
	}
	return checked.stat.isDirectory()
}

async function nestedGuidancePaths(root: string, rootReal: string, roots: string[], warnings: string[]): Promise<string[]> {
	const found = new Set<string>()
	for (const relativeRoot of roots) {
		const start = path.join(root, ...relativeRoot.split('/'))
		const ancestry = new Set<string>()
		async function walk(current: string): Promise<void> {
			const checked = await confinedStat(rootReal, current)
			if (!checked?.stat.isDirectory()) return
			if (ancestry.has(checked.real)) return
			ancestry.add(checked.real)
			try {
				const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name))
				for (const entry of entries) {
					if (WALK_EXCLUDES.has(entry.name)) continue
					const child = path.join(current, entry.name)
					const relative = slash(path.relative(root, child))
					if (entry.name === 'AGENTS.md') {
						const candidate = await existingCandidate(root, rootReal, relative, warnings)
						if (candidate) found.add(relative)
					}
					await walk(child)
				}
			} finally {
				ancestry.delete(checked.real)
			}
		}
		await walk(start)
	}
	return [...found].sort(lexical)
}

function resolveJsManager(
	pkg: Record<string, unknown>,
	presentNames: string[],
	sourcePath: string,
	warnings: string[],
	inherited?: Extract<RepoPackageManager, 'bun' | 'pnpm' | 'yarn' | 'npm'>,
): Extract<RepoPackageManager, 'bun' | 'pnpm' | 'yarn' | 'npm'> | undefined {
	if (pkg.packageManager !== undefined) {
		if (typeof pkg.packageManager !== 'string') throw new Error(`${sourcePath} packageManager must be a string`)
		const match = /^(bun|pnpm|yarn|npm)(?:@.+)?$/.exec(pkg.packageManager)
		if (!match) {
			warnings.push(`Unsupported packageManager in ${sourcePath}: ${pkg.packageManager}`)
			return undefined
		}
		return match[1] as Extract<RepoPackageManager, 'bun' | 'pnpm' | 'yarn' | 'npm'>
	}
	const locks = presentNames.filter((name) => JS_LOCKS[name] !== undefined)
	if (locks.length === 1) return JS_LOCKS[locks[0] as keyof typeof JS_LOCKS]
	if (locks.length > 1) {
		warnings.push(`Multiple JavaScript lockfiles in ${path.posix.dirname(sourcePath) === '.' ? '.' : path.posix.dirname(sourcePath)}; package manager unresolved.`)
		return undefined
	}
	return inherited
}

function scriptCommands(pkg: Record<string, unknown>, manager: RepoPackageManager, sourcePath: string): RepoPrimerCommand[] {
	if (!['bun', 'pnpm', 'yarn', 'npm'].includes(manager)) return []
	const scripts = pkg.scripts
	if (scripts === undefined) return []
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error(`${sourcePath} scripts must be an object`)
	const commands: RepoPrimerCommand[] = []
	for (const [script, category] of [
		['test', 'test'], ['build', 'build'], ['check', 'typecheck'], ['typecheck', 'typecheck'],
	] as const) {
		if (typeof (scripts as Record<string, unknown>)[script] === 'string') {
			commands.push({ category, command: `${manager} run ${script}`, source_path: sourcePath })
		}
	}
	return commands
}

function makeCommands(text: string): RepoPrimerCommand[] {
	const targets = new Set<string>()
	for (const line of text.split(/\r?\n/)) {
		if (/^[^\s.#][^:=]*:/.test(line) && !line.includes('=')) {
			const names = line.slice(0, line.indexOf(':')).trim().split(/\s+/)
			for (const name of names) targets.add(name)
		}
	}
	const commands: RepoPrimerCommand[] = []
	for (const [target, category] of [
		['test', 'test'], ['build', 'build'], ['check', 'typecheck'], ['typecheck', 'typecheck'],
	] as const) {
		if (targets.has(target)) commands.push({ category, command: `make ${target}`, source_path: 'Makefile' })
	}
	return commands
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return ''
	const bytes = Buffer.from(text)
	if (bytes.byteLength <= maxBytes) return text
	let end = maxBytes
	while (end > 0) {
		const result = bytes.subarray(0, end).toString('utf8')
		if (!result.endsWith('\uFFFD')) return result
		end--
	}
	return ''
}

function isRepoPrimer(value: unknown): value is RepoPrimer {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const primer = value as Partial<RepoPrimer>
	return primer.schema_version === 1
		&& typeof primer.generated_at === 'string'
		&& typeof primer.source_fingerprint === 'string'
		&& Array.isArray(primer.package_managers)
		&& Array.isArray(primer.manifests)
		&& Array.isArray(primer.workspace_members)
		&& Array.isArray(primer.commands)
		&& Array.isArray(primer.test_roots)
		&& Array.isArray(primer.module_roots)
		&& Array.isArray(primer.guidance)
		&& Array.isArray(primer.warnings)
}

async function generatePrimer(cwd: string): Promise<RepoPrimer> {
	const root = path.resolve(cwd)
	const rootReal = await fs.realpath(root)
	const warnings: string[] = []
	const candidateNames = new Set<string>()
	const retainedContents = new Map<string, Buffer>()

	const rootPackageCandidate = await existingCandidate(root, rootReal, 'package.json', warnings)
	let rootPackage: Record<string, unknown> | undefined
	let patterns: string[] = []
	if (rootPackageCandidate) {
		rootPackage = packageObject(rootPackageCandidate.content.toString('utf8'), 'package.json')
		patterns = workspacePatterns(rootPackage)
	}

	const workspacesByRealPath = new Map<string, string>()
	for (const pattern of patterns) {
		for (const member of await expandWorkspacePattern(root, rootReal, pattern)) {
			candidateNames.add(`workspace:${member}`)
			const real = await fs.realpath(path.join(root, ...member.split('/')))
			const previous = workspacesByRealPath.get(real)
			if (previous === undefined || lexical(member, previous) < 0) workspacesByRealPath.set(real, member)
		}
	}
	const workspaceCandidates = [...workspacesByRealPath.values()].sort(lexical)
	const workspaceMembers = workspaceCandidates.slice(0, 50)

	const manifestCandidatePaths: string[] = []
	for (const name of FILE_NAMES) {
		const candidate = await existingCandidate(root, rootReal, name, warnings)
		if (candidate) manifestCandidatePaths.push(name)
	}
	for (const workspace of workspaceCandidates) {
		for (const name of FILE_NAMES) {
			const relative = `${workspace}/${name}`
			const candidate = await existingCandidate(root, rootReal, relative, warnings)
			if (candidate) manifestCandidatePaths.push(relative)
		}
	}
	for (const manifestPath of manifestCandidatePaths) candidateNames.add(`manifest:${manifestPath}`)
	const retainedManifestPaths = manifestCandidatePaths.slice(0, 50)
	const manifests: RepoPrimerManifest[] = []
	for (const manifestPath of retainedManifestPaths) {
		const candidate = await existingCandidate(root, rootReal, manifestPath, warnings)
		if (!candidate) continue
		retainedContents.set(`manifest:${manifestPath}`, candidate.content)
		const name = path.posix.basename(manifestPath)
		const spec = FILE_SPECS[name]
		if (!spec) continue
		manifests.push({ path: manifestPath, ecosystem: spec.ecosystem, kind: spec.kind, sha256: hash(candidate.content) })
	}

	const rootCandidates = ['', ...workspaceMembers]
	const combinedRoots: string[] = []
	for (const parent of rootCandidates) {
		for (const name of [...MODULE_NAMES, ...TEST_NAMES]) {
			const relative = parent ? `${parent}/${name}` : name
			if (await existingDirectory(root, rootReal, relative, warnings)) {
				candidateNames.add(`root:${relative}`)
				combinedRoots.push(relative)
			}
		}
	}
	const retainedRoots = [...new Set(combinedRoots)].sort(lexical).slice(0, 40)
	const moduleRoots = retainedRoots.filter((item) => MODULE_NAMES.has(path.posix.basename(item)))
	const testRoots = retainedRoots.filter((item) => TEST_NAMES.has(path.posix.basename(item)))

	const rootGuidance = await existingCandidate(root, rootReal, 'AGENTS.md', warnings)
	if (rootGuidance) candidateNames.add('guidance:AGENTS.md')
	const nestedRoots = retainedRoots
	const nestedGuidance = await nestedGuidancePaths(root, rootReal, nestedRoots, warnings)
	for (const guidancePath of nestedGuidance) candidateNames.add(`guidance:${guidancePath}`)
	const guidancePaths = [...(rootGuidance ? ['AGENTS.md'] : []), ...nestedGuidance.filter((item) => item !== 'AGENTS.md')].slice(0, 20)
	const guidance: RepoPrimerGuidance[] = []
	let guidanceBytesRemaining = 8 * 1024
	for (const guidancePath of guidancePaths) {
		const candidate = await existingCandidate(root, rootReal, guidancePath, warnings)
		if (!candidate) continue
		retainedContents.set(`guidance:${guidancePath}`, candidate.content)
		const full = candidate.content.toString('utf8')
		const allowance = Math.min(2 * 1024, guidanceBytesRemaining)
		const excerpt = utf8Prefix(full, allowance)
		const excerptBytes = Buffer.byteLength(excerpt)
		guidanceBytesRemaining -= excerptBytes
		guidance.push({ path: guidancePath, sha256: hash(candidate.content), excerpt, truncated: excerptBytes < candidate.content.byteLength })
	}

	const retainedByPath = new Map<string, Buffer>()
	for (const [key, content] of retainedContents) retainedByPath.set(key.slice(key.indexOf(':') + 1), content)
	const packageManagers = new Set<RepoPackageManager>()
	const commands: RepoPrimerCommand[] = []
	const rootNames = retainedManifestPaths.filter((item) => !item.includes('/')).map((item) => path.posix.basename(item))
	const rootJsManager = resolveJsManager(rootPackage ?? {}, rootNames, 'package.json', warnings)
	if (rootJsManager) {
		packageManagers.add(rootJsManager)
		if (rootPackage) commands.push(...scriptCommands(rootPackage, rootJsManager, 'package.json'))
	}
	for (const workspace of workspaceMembers) {
		const packagePath = `${workspace}/package.json`
		const packageContent = retainedByPath.get(packagePath)
		const pkg = packageContent ? packageObject(packageContent.toString('utf8'), packagePath) : {}
		const localNames = retainedManifestPaths
			.filter((item) => path.posix.dirname(item) === workspace)
			.map((item) => path.posix.basename(item))
		const manager = resolveJsManager(pkg, localNames, packagePath, warnings, rootJsManager)
		if (manager) {
			packageManagers.add(manager)
			if (packageContent) commands.push(...scriptCommands(pkg, manager, packagePath))
		}
	}

	const retainedNames = new Set(manifests.map((manifest) => path.posix.basename(manifest.path)))
	if (retainedNames.has('uv.lock')) packageManagers.add('uv')
	if (retainedNames.has('poetry.lock')) packageManagers.add('poetry')
	if (retainedNames.has('Cargo.toml') || retainedNames.has('Cargo.lock')) packageManagers.add('cargo')
	if (retainedNames.has('go.mod') || retainedNames.has('go.work') || retainedNames.has('go.sum')) packageManagers.add('go')
	if (retainedNames.has('pom.xml')) packageManagers.add('maven')
	if ([...retainedNames].some((name) => name.startsWith('build.gradle') || name.startsWith('settings.gradle') || name === 'gradle.lockfile')) packageManagers.add('gradle')
	if (retainedNames.has('Gemfile') || retainedNames.has('Gemfile.lock')) packageManagers.add('bundler')
	if (retainedNames.has('composer.json') || retainedNames.has('composer.lock')) packageManagers.add('composer')
	if (retainedNames.has('Makefile')) {
		packageManagers.add('make')
		const makefile = retainedByPath.get('Makefile')
		if (makefile) commands.push(...makeCommands(makefile.toString('utf8')))
	}

	commands.sort((a, b) => lexical(a.source_path, b.source_path)
		|| CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
		|| lexical(a.command, b.command))
	const orderedManagers = MANAGER_ORDER.filter((manager) => packageManagers.has(manager))
	const fingerprinter = crypto.createHash('sha256')
	for (const name of [...candidateNames].sort(lexical)) addFingerprintPart(fingerprinter, 'candidate', name)
	for (const [name, content] of [...retainedContents].sort(([a], [b]) => lexical(a, b))) {
		addFingerprintPart(fingerprinter, name, content)
	}

	return {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		source_fingerprint: fingerprinter.digest('hex'),
		package_managers: orderedManagers,
		manifests,
		workspace_members: workspaceMembers,
		commands,
		test_roots: testRoots,
		module_roots: moduleRoots,
		guidance,
		warnings,
	}
}

export async function refreshRepoPrimer(cwd: string): Promise<RepoPrimerRefreshResult> {
	const target = repoPrimerPath(cwd)
	let existing: RepoPrimer | undefined
	let artifactExisted = false
	try {
		await fs.lstat(target)
		artifactExisted = true
		const loaded = await readYamlFile<unknown>(target)
		if (isRepoPrimer(loaded)) existing = loaded
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			// A malformed prior artifact is not a source-scan failure and can be replaced by a fresh primer.
			existing = undefined
		}
	}

	try {
		const generated = await generatePrimer(cwd)
		if (existing?.source_fingerprint === generated.source_fingerprint) {
			return { status: 'unchanged', primer: existing, warnings: existing.warnings }
		}
		await writeYamlFile(target, generated)
		return {
			status: artifactExisted ? 'refreshed' : 'created',
			primer: generated,
			warnings: generated.warnings,
		}
	} catch (error) {
		const warning = `Repository primer refresh failed: ${(error as Error).message}`
		if (existing) return { status: 'stale_fallback', primer: existing, warnings: [...existing.warnings, warning] }
		return { status: 'unavailable', warnings: [warning] }
	}
}

export function renderRepoPrimer(primer: RepoPrimer, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
	const serialized = JSON.stringify(primer)
	const fullBytes = Buffer.byteLength(serialized)
	const limit = Math.max(0, Math.floor(maxBytes))
	if (fullBytes <= limit) return { text: serialized, bytes: fullBytes, truncated: false }
	const marker = '\n[truncated]'
	const markerBytes = Buffer.byteLength(marker)
	const text = limit >= markerBytes
		? `${utf8Prefix(serialized, limit - markerBytes)}${marker}`
		: utf8Prefix(marker, limit)
	return { text, bytes: Buffer.byteLength(text), truncated: true }
}
