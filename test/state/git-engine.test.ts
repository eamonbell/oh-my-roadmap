import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
	buildWaveChanges,
	captureWaveGitStart,
	commitWaveCheckpoint,
	resolveGitBoundary,
} from '@oh-my-roadmap/core/wave-orchestration/index'
import { createGitRepo, type GitRepoFixture } from '../git-fixture'

let repo: GitRepoFixture | null = null
const extraDirs: string[] = []

afterEach(() => {
	if (repo) repo.remove()
	repo = null
	for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function checkpointInput(overrides: Partial<Parameters<typeof commitWaveCheckpoint>[1]> = {}) {
	return {
		waveId: 'w01',
		waveGoal: 'Implement state storage.',
		taskIds: ['t01-state'],
		ownedPathspecs: ['src'],
		workflow: 'roadmap' as const,
		roadmapId: 'complex-refactor',
		milestoneId: 'm01-core',
		...overrides,
	}
}

describe('resolveGitBoundary', () => {
	test('fresh repo with a commit reports available, non-detached, real head', async () => {
		repo = createGitRepo({ initialCommit: true })
		const boundary = await resolveGitBoundary(repo.cwd)
		expect(boundary.available).toBe(true)
		expect(boundary.detached).toBe(false)
		expect(boundary.head).toBe(repo.head())
	})

	test('non-repo directory reports unavailable with a reason', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-nonrepo-'))
		extraDirs.push(dir)
		const boundary = await resolveGitBoundary(dir)
		expect(boundary.available).toBe(false)
		expect(boundary.head).toBeNull()
		expect(typeof boundary.reason).toBe('string')
	})

	test('unborn repo reports available with null head and not detached', async () => {
		repo = createGitRepo()
		const boundary = await resolveGitBoundary(repo.cwd)
		expect(boundary.available).toBe(true)
		expect(boundary.head).toBeNull()
		expect(boundary.detached).toBe(false)
	})

	test('detached HEAD is reported as detached', async () => {
		repo = createGitRepo({ initialCommit: true })
		const sha = repo.head()
		repo.git('checkout', '--detach', sha)
		const boundary = await resolveGitBoundary(repo.cwd)
		expect(boundary.available).toBe(true)
		expect(boundary.detached).toBe(true)
		expect(boundary.head).toBe(sha)
	})
})

describe('captureWaveGitStart', () => {
	test('records head and owned predirty paths', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		repo.commitAll('add a')
		// dirty an owned file and an unowned file
		repo.writeFile('src/a.ts', 'export const a = 2\n')
		repo.writeFile('other.ts', 'export const o = 1\n')

		const start = await captureWaveGitStart(repo.cwd, ['src'])
		expect(start).not.toBeNull()
		expect(start!.start_head).toBe(repo.head())
		expect(start!.predirty).toContain('src/a.ts')
		expect(start!.predirty).not.toContain('other.ts')
		expect(typeof start!.captured_at).toBe('string')
	})

	test('returns null when git is unavailable', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-nonrepo-'))
		extraDirs.push(dir)
		expect(await captureWaveGitStart(dir, ['src'])).toBeNull()
	})

	test('unborn repo records null start_head', async () => {
		repo = createGitRepo()
		const start = await captureWaveGitStart(repo.cwd, ['src'])
		expect(start).not.toBeNull()
		expect(start!.start_head).toBeNull()
	})
})

describe('buildWaveChanges', () => {
	test('reports added/modified/deleted/renamed scoped to owned pathspecs with text patches', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.writeFile('src/mod.ts', 'line1\nline2\n')
		repo.writeFile('src/del.ts', 'gone soon\n')
		repo.writeFile('src/ren.ts', 'rename me\n')
		repo.writeFile('unowned.ts', 'not owned\n')
		repo.commitAll('baseline')
		const startHead = repo.head()

		// modify, delete, rename, add — plus an unowned change that must be excluded
		repo.writeFile('src/mod.ts', 'line1\nline2\nline3\n')
		repo.removeFile('src/del.ts')
		repo.removeFile('src/ren.ts')
		repo.writeFile('src/ren2.ts', 'rename me\n')
		repo.writeFile('src/add.ts', 'brand new\n')
		repo.writeFile('unowned.ts', 'changed but not owned\n')

		const pkg = await buildWaveChanges(repo.cwd, startHead, ['src'])
		expect(pkg.available).toBe(true)
		expect(pkg.start_head).toBe(startHead)

		const byPath = new Map(pkg.files.map((f) => [f.path, f]))
		expect(byPath.has('unowned.ts')).toBe(false)
		expect(byPath.get('src/mod.ts')!.status).toBe('modified')
		expect(byPath.get('src/add.ts')!.status).toBe('added')
		expect(byPath.get('src/del.ts')!.status).toBe('deleted')

		const renamed = pkg.files.find((f) => f.status === 'renamed')
		expect(renamed).toBeDefined()
		expect(renamed!.path).toBe('src/ren2.ts')
		expect(renamed!.old_path).toBe('src/ren.ts')

		// text files carry a patch
		expect(byPath.get('src/mod.ts')!.patch).toContain('+line3')
		expect(pkg.additions).toBeGreaterThan(0)

		// files sorted lexically
		const paths = pkg.files.map((f) => f.path)
		expect([...paths].sort()).toEqual(paths)
	})

	test('binary files are metadata-only: no patch and no line counts', async () => {
		repo = createGitRepo({ initialCommit: true })
		// A genuine binary blob (embedded NUL + non-UTF8 high bytes) that git detects as binary.
		const binBefore = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x80, 0x00])
		const modPath = path.join(repo.cwd, 'src', 'img.bin')
		fs.mkdirSync(path.dirname(modPath), { recursive: true })
		fs.writeFileSync(modPath, binBefore)
		repo.commitAll('add binary baseline')
		const startHead = repo.head()

		// Modify the tracked binary and add a brand-new (untracked) binary in the owned path.
		fs.writeFileSync(modPath, Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x7f, 0x81]))
		const addPath = path.join(repo.cwd, 'src', 'new.bin')
		fs.writeFileSync(addPath, Buffer.from([0x00, 0x99, 0x88, 0x00, 0x01, 0x00, 0xfa]))

		const pkg = await buildWaveChanges(repo.cwd, startHead, ['src'])
		expect(pkg.available).toBe(true)

		const byPath = new Map(pkg.files.map((f) => [f.path, f]))
		const modified = byPath.get('src/img.bin')
		expect(modified).toBeDefined()
		expect(modified!.status).toBe('modified')
		expect(modified!.patch).toBeUndefined()
		expect(modified!.additions).toBeUndefined()
		expect(modified!.deletions).toBeUndefined()

		const added = byPath.get('src/new.bin')
		expect(added).toBeDefined()
		expect(added!.status).toBe('added')
		expect(added!.patch).toBeUndefined()
		expect(added!.additions).toBeUndefined()
		expect(added!.deletions).toBeUndefined()

		// Binary changes contribute nothing to the aggregate line counts.
		expect(pkg.additions).toBe(0)
		expect(pkg.deletions).toBe(0)
	})

	test('unavailable git returns available:false with a warning', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-nonrepo-'))
		extraDirs.push(dir)
		const pkg = await buildWaveChanges(dir, null, ['src'])
		expect(pkg.available).toBe(false)
		expect(pkg.files).toEqual([])
		expect(pkg.warnings.length).toBeGreaterThan(0)
	})

	test('unborn repo diffs new files against the empty tree', async () => {
		repo = createGitRepo()
		repo.writeFile('src/new.ts', 'hello\n')
		const pkg = await buildWaveChanges(repo.cwd, null, ['src'])
		expect(pkg.available).toBe(true)
		expect(pkg.files.map((f) => f.path)).toContain('src/new.ts')
		expect(pkg.files[0]!.status).toBe('added')
	})
})

describe('commitWaveCheckpoint', () => {
	test('creates a checkpoint scoped to owned pathspecs', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(result.status).toBe('created')
		expect(result.commit).toBe(repo.head())
		expect(result.paths).toContain('src/a.ts')
		// trailers present in the commit body
		const body = repo.git('log', '-1', '--format=%B', 'HEAD').stdout
		expect(body).toContain('OMR-Wave: w01')
		expect(body).toContain('OMR-Roadmap: complex-refactor')
		expect(body).toContain('OMR-Milestone: m01-core')
		expect(body).toContain('OMR-Tasks: ["t01-state"]')
	})

	test('leaves the user real index untouched (temp index isolation)', async () => {
		repo = createGitRepo({ initialCommit: true })
		// Stage a change in the REAL index that is NOT owned by the wave.
		repo.writeFile('staged.ts', 'export const s = 1\n')
		repo.git('add', 'staged.ts')
		const indexTreeBefore = repo.writeTree()

		// A separate owned change gets checkpointed.
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(result.status).toBe('created')

		// The real index tree is byte-for-byte unchanged: the checkpoint used a temp index.
		expect(repo.writeTree()).toBe(indexTreeBefore)
		// The real index still tracks staged.ts and never gained the owned src/a.ts.
		const tracked = repo.git('ls-files').stdout.trim().split('\n')
		expect(tracked).toContain('staged.ts')
		expect(tracked).not.toContain('src/a.ts')
	})

	test('honors an installed pre-commit hook (failing hook aborts the commit)', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.installPreCommitHook('#!/bin/sh\nexit 1\n')
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		await expect(commitWaveCheckpoint(repo.cwd, checkpointInput())).rejects.toThrow(/checkpoint commit failed/)
		// HEAD did not advance beyond the initial commit
		expect(repo.git('rev-list', '--count', 'HEAD').stdout.trim()).toBe('1')
	})

	test('honors a passing pre-commit hook', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.installPreCommitHook('#!/bin/sh\nexit 0\n')
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(result.status).toBe('created')
	})

	test('unborn repo produces a root commit', async () => {
		repo = createGitRepo()
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(result.status).toBe('created')
		expect(repo.git('rev-list', '--count', 'HEAD').stdout.trim()).toBe('1')
		expect(result.paths).toContain('src/a.ts')
	})

	test('no owned changes returns no_changes without committing', async () => {
		repo = createGitRepo({ initialCommit: true })
		const headBefore = repo.head()
		// change only an unowned path
		repo.writeFile('unowned.ts', 'x\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(result.status).toBe('no_changes')
		expect(repo.head()).toBe(headBefore)
	})

	test('is idempotent for the same waveId (no second commit, same sha)', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const first = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(first.status).toBe('created')
		const firstSha = repo.head()

		// A subsequent owned change plus a re-run for the SAME wave must not create a new commit.
		repo.writeFile('src/b.ts', 'export const b = 2\n')
		const second = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(second.status).toBe('created')
		expect(second.commit).toBe(firstSha)
		expect(repo.head()).toBe(firstSha)
		expect(repo.git('rev-list', '--count', 'HEAD').stdout.trim()).toBe('2')
	})

	test('warns when a predirty owned path is swept into the checkpoint', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput({ predirty: ['src/a.ts'] }))
		expect(result.status).toBe('created')
		expect(result.warnings.join('\n')).toContain('pre-existing uncommitted changes')
	})

	test('rejects ids containing control characters', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		await expect(
			commitWaveCheckpoint(repo.cwd, checkpointInput({ waveId: 'w01\nOMR-Wave: injected' })),
		).rejects.toThrow(/illegal NUL\/CR\/LF/)
	})

	test('skips on detached HEAD', async () => {
		repo = createGitRepo({ initialCommit: true })
		repo.git('checkout', '--detach', repo.head())
		repo.writeFile('src/a.ts', 'export const a = 1\n')
		const result = await commitWaveCheckpoint(repo.cwd, checkpointInput())
		expect(result.status).toBe('skipped')
		expect(result.reason).toBe('detached HEAD')
	})
})
