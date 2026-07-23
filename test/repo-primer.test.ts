import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { readYamlFile, writeYamlFile } from '@oh-my-roadmap/core/files'
import { repoPrimerPath } from '@oh-my-roadmap/core/paths'
import {
	refreshRepoPrimer,
	renderRepoPrimer,
	type RepoPrimer,
	type RepoPrimerRefreshResult,
} from '@oh-my-roadmap/core/repo-primer'

async function tempRepo(label: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`))
}

async function put(cwd: string, relative: string, content = ''): Promise<void> {
	const target = path.join(cwd, ...relative.split('/'))
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, content, 'utf8')
}

function primerOf(result: RepoPrimerRefreshResult): RepoPrimer {
	if (result.status === 'unavailable') throw new Error(result.warnings.join('\n'))
	return result.primer
}

describe('repository primer', () => {
	test('detects the bounded mixed ecosystem surface, explicit commands, guidance order, and confined workspaces', async () => {
		const cwd = await tempRepo('repo-primer-mixed')
		const outside = await tempRepo('repo-primer-outside')
		try {
			await put(cwd, 'package.json', JSON.stringify({
				packageManager: 'bun@1.3.14',
				workspaces: { packages: ['packages/*'] },
				scripts: { test: 'bun test', build: 'build', check: 'tsc', typecheck: 'tsc --noEmit' },
			}))
			await put(cwd, 'bun.lock')
			await put(cwd, 'yarn.lock')
			await put(cwd, 'pyproject.toml', '[project]\nname="fixture"\n')
			await put(cwd, 'uv.lock')
			await put(cwd, 'poetry.lock')
			await put(cwd, 'Cargo.toml', '[package]\nname="fixture"\n')
			await put(cwd, 'Cargo.lock')
			await put(cwd, 'go.mod', 'module fixture\n')
			await put(cwd, 'pom.xml', '<project/>\n')
			await put(cwd, 'build.gradle.kts', 'plugins {}\n')
			await put(cwd, 'Gemfile', 'source "https://rubygems.org"\n')
			await put(cwd, 'composer.json', '{}\n')
			await put(cwd, 'Makefile', 'test:\n\ttrue\nbuild:\n\ttrue\ncheck typecheck:\n\ttrue\n')
			await put(cwd, 'requirements.txt', 'example==1\n')
			await put(cwd, 'AGENTS.md', 'root guidance\n')
			await put(cwd, 'src/AGENTS.md', 'source guidance\n')
			await put(cwd, 'tests/.keep')
			await put(cwd, 'packages/a/package.json', JSON.stringify({
				packageManager: 'pnpm@10', scripts: { test: 'vitest', check: 'tsc' },
			}))
			await put(cwd, 'packages/a/yarn.lock')
			await put(cwd, 'packages/a/src/AGENTS.md', 'workspace source guidance\n')
			await put(cwd, 'packages/b/package.json', JSON.stringify({ scripts: { build: 'build' } }))
			await put(cwd, 'packages/b/package-lock.json')
			await put(cwd, 'packages/c/package.json', JSON.stringify({ scripts: { typecheck: 'tsc' } }))
			await put(outside, 'package.json', '{"name":"outside"}\n')
			await fs.symlink(outside, path.join(cwd, 'packages', 'escape'))

			const result = await refreshRepoPrimer(cwd)
			expect(result.status).toBe('created')
			const primer = primerOf(result)
			expect(primer.schema_version).toBe(1)
			expect(primer.source_fingerprint).toMatch(/^[a-f0-9]{64}$/)
			expect(primer.workspace_members).toEqual(['packages/a', 'packages/b', 'packages/c'])
			expect(primer.package_managers).toEqual([
				'bun', 'pnpm', 'npm', 'uv', 'poetry', 'cargo', 'go', 'maven', 'gradle', 'bundler', 'composer', 'make',
			])
			expect(primer.commands).toEqual([
				{ category: 'test', command: 'make test', source_path: 'Makefile' },
				{ category: 'build', command: 'make build', source_path: 'Makefile' },
				{ category: 'typecheck', command: 'make check', source_path: 'Makefile' },
				{ category: 'typecheck', command: 'make typecheck', source_path: 'Makefile' },
				{ category: 'test', command: 'bun run test', source_path: 'package.json' },
				{ category: 'build', command: 'bun run build', source_path: 'package.json' },
				{ category: 'typecheck', command: 'bun run check', source_path: 'package.json' },
				{ category: 'typecheck', command: 'bun run typecheck', source_path: 'package.json' },
				{ category: 'test', command: 'pnpm run test', source_path: 'packages/a/package.json' },
				{ category: 'typecheck', command: 'pnpm run check', source_path: 'packages/a/package.json' },
				{ category: 'build', command: 'npm run build', source_path: 'packages/b/package.json' },
				{ category: 'typecheck', command: 'bun run typecheck', source_path: 'packages/c/package.json' },
			])
			expect(primer.manifests.map((manifest) => manifest.path)).not.toContain('packages/escape/package.json')
			expect(primer.manifests).toEqual(expect.arrayContaining([
				expect.objectContaining({ path: 'package.json', ecosystem: 'javascript', kind: 'manifest' }),
				expect.objectContaining({ path: 'requirements.txt', ecosystem: 'python', kind: 'requirements' }),
				expect.objectContaining({ path: 'Makefile', ecosystem: 'generic', kind: 'build' }),
				expect.objectContaining({ path: 'Cargo.lock', ecosystem: 'rust', kind: 'lockfile' }),
			]))
			expect(primer.module_roots).toEqual(['packages', 'packages/a/src', 'src'])
			expect(primer.test_roots).toEqual(['tests'])
			expect(primer.guidance.map((item) => item.path)).toEqual([
				'AGENTS.md', 'packages/a/src/AGENTS.md', 'src/AGENTS.md',
			])
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
			await fs.rm(outside, { recursive: true, force: true })
		}
	})

	test('applies workspace, manifest, combined-root, and guidance caps in lexical order', async () => {
		const cwd = await tempRepo('repo-primer-caps')
		try {
			await put(cwd, 'package.json', JSON.stringify({ workspaces: ['units/*'], packageManager: 'npm' }))
			await put(cwd, 'AGENTS.md', 'r'.repeat(3_000))
			await put(cwd, 'units/u00/AGENTS.md', 'workspace-only guidance must be excluded')
			for (let index = 0; index < 55; index++) {
				const member = `units/u${String(index).padStart(2, '0')}`
				await put(cwd, `${member}/package.json`, JSON.stringify({ name: `u${index}` }))
				await put(cwd, `${member}/src/AGENTS.md`, `${index}`.repeat(3_000))
				await put(cwd, `${member}/test/.keep`)
			}

			const first = primerOf(await refreshRepoPrimer(cwd))
			expect(first.workspace_members).toHaveLength(50)
			expect(first.workspace_members[0]).toBe('units/u00')
			expect(first.workspace_members[49]).toBe('units/u49')
			expect(first.manifests).toHaveLength(50)
			expect(first.manifests[0]?.path).toBe('package.json')
			expect(first.manifests[49]?.path).toBe('units/u48/package.json')
			expect(first.module_roots.length + first.test_roots.length).toBe(40)
			expect([...first.module_roots, ...first.test_roots].sort()).toEqual(
				Array.from({ length: 20 }, (_, index) => [`units/u${String(index).padStart(2, '0')}/src`, `units/u${String(index).padStart(2, '0')}/test`]).flat().sort(),
			)
			expect(first.guidance).toHaveLength(20)
			expect(first.guidance[0]?.path).toBe('AGENTS.md')
			expect(first.guidance[1]?.path).toBe('units/u00/src/AGENTS.md')
			expect(first.guidance.map((item) => item.path)).not.toContain('units/u00/AGENTS.md')
			expect(first.guidance.reduce((total, item) => total + Buffer.byteLength(item.excerpt), 0)).toBeLessThanOrEqual(8 * 1024)
			expect(first.guidance.every((item) => Buffer.byteLength(item.excerpt) <= 2 * 1024)).toBe(true)
			expect(first.guidance[0]?.truncated).toBe(true)

			await put(cwd, 'units/u55/package.json', '{"name":"new-capped-candidate"}\n')
			const refreshed = await refreshRepoPrimer(cwd)
			expect(refreshed.status).toBe('refreshed')
			expect(primerOf(refreshed).workspace_members).toEqual(first.workspace_members)
			expect(primerOf(refreshed).source_fingerprint).not.toBe(first.source_fingerprint)
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})

	test('uses the exact JavaScript package-manager precedence and lockfile ambiguity rules', async () => {
		const singleLock = await tempRepo('repo-primer-single-lock')
		const unsupportedExplicit = await tempRepo('repo-primer-unsupported-manager')
		const ambiguousLocks = await tempRepo('repo-primer-ambiguous-locks')
		const workspaceMatrix = await tempRepo('repo-primer-workspace-manager-matrix')
		try {
			await put(singleLock, 'bun.lock')
			expect(primerOf(await refreshRepoPrimer(singleLock)).package_managers).toEqual(['bun'])

			await put(unsupportedExplicit, 'package.json', JSON.stringify({
				packageManager: 'deno@2',
				scripts: { test: 'test' },
			}))
			await put(unsupportedExplicit, 'package-lock.json')
			const unsupported = primerOf(await refreshRepoPrimer(unsupportedExplicit))
			expect(unsupported.package_managers).not.toContain('npm')
			expect(unsupported.commands).toEqual([])
			expect(unsupported.warnings).toContain('Unsupported packageManager in package.json: deno@2')

			await put(ambiguousLocks, 'package.json', JSON.stringify({ scripts: { test: 'test' } }))
			await put(ambiguousLocks, 'bun.lock')
			await put(ambiguousLocks, 'pnpm-lock.yaml')
			const ambiguous = primerOf(await refreshRepoPrimer(ambiguousLocks))
			expect(ambiguous.package_managers).toEqual([])
			expect(ambiguous.commands).toEqual([])
			expect(ambiguous.warnings).toContain('Multiple JavaScript lockfiles in .; package manager unresolved.')

			await put(workspaceMatrix, 'package.json', JSON.stringify({
				packageManager: 'bun',
				workspaces: ['units/*'],
			}))
			await put(workspaceMatrix, 'bun.lock')
			await put(workspaceMatrix, 'units/local-lock/pnpm-lock.yaml')
			await put(workspaceMatrix, 'units/ambiguous/bun.lock')
			await put(workspaceMatrix, 'units/ambiguous/yarn.lock')
			await put(workspaceMatrix, 'units/inherited/.keep')
			await put(workspaceMatrix, 'units/unsupported/package.json', JSON.stringify({
				packageManager: 'deno@2',
				scripts: { test: 'test' },
			}))
			await put(workspaceMatrix, 'units/unsupported/package-lock.json')
			await put(workspaceMatrix, 'units/explicit/package.json', JSON.stringify({
				packageManager: 'yarn@4',
				scripts: { test: 'test' },
			}))
			const matrix = primerOf(await refreshRepoPrimer(workspaceMatrix))
			expect(matrix.workspace_members).toEqual([
				'units/ambiguous', 'units/explicit', 'units/inherited', 'units/local-lock', 'units/unsupported',
			])
			expect(matrix.package_managers).toEqual(['bun', 'pnpm', 'yarn'])
			expect(matrix.commands).toEqual([
				{ category: 'test', command: 'yarn run test', source_path: 'units/explicit/package.json' },
			])
			expect(matrix.warnings).toContain('Multiple JavaScript lockfiles in units/ambiguous; package manager unresolved.')
			expect(matrix.warnings).toContain('Unsupported packageManager in units/unsupported/package.json: deno@2')
		} finally {
			await fs.rm(singleLock, { recursive: true, force: true })
			await fs.rm(unsupportedExplicit, { recursive: true, force: true })
			await fs.rm(ambiguousLocks, { recursive: true, force: true })
			await fs.rm(workspaceMatrix, { recursive: true, force: true })
		}
	})

	test('persists atomically, preserves bytes and generated_at when unchanged, refreshes drift, and falls back stale', async () => {
		const cwd = await tempRepo('repo-primer-lifecycle')
		try {
			await put(cwd, 'package.json', JSON.stringify({ packageManager: 'bun', scripts: { test: 'bun test' } }))
			await put(cwd, 'bun.lock')
			const created = await refreshRepoPrimer(cwd)
			expect(created.status).toBe('created')
			const createdPrimer = primerOf(created)
			const before = await fs.readFile(repoPrimerPath(cwd), 'utf8')
			const unchanged = await refreshRepoPrimer(cwd)
			expect(unchanged.status).toBe('unchanged')
			expect(primerOf(unchanged).generated_at).toBe(createdPrimer.generated_at)
			expect(await fs.readFile(repoPrimerPath(cwd), 'utf8')).toBe(before)

			const oldPrimer = { ...primerOf(unchanged), generated_at: '2000-01-01T00:00:00.000Z' }
			await writeYamlFile(repoPrimerPath(cwd), oldPrimer)
			await put(cwd, 'package.json', JSON.stringify({ packageManager: 'bun', scripts: { test: 'bun test', build: 'build' } }))
			const refreshed = await refreshRepoPrimer(cwd)
			expect(refreshed.status).toBe('refreshed')
			expect(primerOf(refreshed).generated_at).not.toBe(oldPrimer.generated_at)
			expect(primerOf(refreshed).commands).toContainEqual({ category: 'build', command: 'bun run build', source_path: 'package.json' })
			const lastGood = await fs.readFile(repoPrimerPath(cwd), 'utf8')

			await put(cwd, 'package.json', '{malformed')
			const stale = await refreshRepoPrimer(cwd)
			expect(stale.status).toBe('stale_fallback')
			expect(primerOf(stale).source_fingerprint).toBe(primerOf(refreshed).source_fingerprint)
			expect(stale.warnings[stale.warnings.length - 1]).toContain('Repository primer refresh failed')
			expect(await fs.readFile(repoPrimerPath(cwd), 'utf8')).toBe(lastGood)
			const entries = await fs.readdir(path.dirname(repoPrimerPath(cwd)))
			expect(entries.some((entry) => entry.includes('repo-primer.yml.') && entry.endsWith('.tmp'))).toBe(false)
			expect(await readYamlFile<RepoPrimer>(repoPrimerPath(cwd))).toEqual(primerOf(refreshed))
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})

	test('returns unavailable on an initial malformed scan and renders within a byte budget', async () => {
		const cwd = await tempRepo('repo-primer-unavailable')
		try {
			await put(cwd, 'package.json', '{malformed')
			const unavailable = await refreshRepoPrimer(cwd)
			expect(unavailable.status).toBe('unavailable')
			expect(unavailable).not.toHaveProperty('primer')
			expect(unavailable.warnings[0]).toContain('Cannot parse package.json')
			expect(await fs.stat(repoPrimerPath(cwd)).catch(() => undefined)).toBeUndefined()

			await put(cwd, 'package.json', JSON.stringify({ packageManager: 'npm' }))
			const primer = primerOf(await refreshRepoPrimer(cwd))
			const full = renderRepoPrimer(primer, 1_000_000)
			expect(full.truncated).toBe(false)
			expect(full.bytes).toBe(Buffer.byteLength(full.text))
			expect(JSON.parse(full.text)).toEqual(primer)
			const compact = renderRepoPrimer(primer, 80)
			expect(compact.truncated).toBe(true)
			expect(compact.bytes).toBeLessThanOrEqual(80)
			expect(compact.bytes).toBe(Buffer.byteLength(compact.text))
		} finally {
			await fs.rm(cwd, { recursive: true, force: true })
		}
	})
})
