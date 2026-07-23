import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { WaveChangeFile, WaveChangePackage } from './types'

// The well-known SHA-1 of the empty tree object. git knows this intrinsically, so it can be
// used as a diff/commit base for an unborn branch (no HEAD yet) without creating any object.
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

interface RunGitResult {
	code: number;
	stdout: string;
	stderr: string;
}

// Shell out to git with an argv array and shell:false so pathspecs/ids are never interpreted by a
// shell. Never rejects: a spawn error (e.g. git missing) resolves with a non-zero code so callers
// can treat "git unavailable" as a value rather than an exception. No timeouts are imposed.
function runGit(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<RunGitResult> {
	return new Promise((resolve) => {
		const child = spawn('git', args, {
			cwd,
			shell: false,
			env: opts.env ?? process.env,
		})
		const stdout: Buffer[] = []
		const stderr: Buffer[] = []
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
		child.on('error', (error) => {
			resolve({ code: 127, stdout: '', stderr: (error as Error).message })
		})
		child.on('close', (code) => {
			resolve({
				code: code ?? -1,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
			})
		})
	})
}

export interface GitBoundary {
	available: boolean;
	head: string | null;
	detached: boolean;
	reason?: string;
}

// Classify the git context of `cwd` without ever throwing for the "not a repo / git missing" case.
// available:false means there is no usable repository (or git is absent) and callers should degrade
// gracefully. head:null with available:true means an unborn branch (repo initialized, no commits).
export async function resolveGitBoundary(cwd: string): Promise<GitBoundary> {
	const insideWorkTree = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
	if (insideWorkTree.code !== 0 || insideWorkTree.stdout.trim() !== 'true') {
		const reason = insideWorkTree.stderr.trim() || 'not a git work tree'
		return { available: false, head: null, detached: false, reason }
	}

	// Unborn branch: HEAD points at a ref that has no commit yet. Detect this before deciding
	// detached, because an unborn branch is not detached.
	const headSha = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])
	if (headSha.code !== 0) {
		return { available: true, head: null, detached: false }
	}

	const symbolic = await runGit(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])
	const detached = symbolic.code !== 0
	return { available: true, head: headSha.stdout.trim(), detached }
}

// Split a NUL-delimited git output into tokens, dropping the trailing empty token.
function splitNul(output: string): string[] {
	const tokens = output.split('\0')
	if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop()
	return tokens
}

export async function captureWaveGitStart(
	cwd: string,
	ownedPathspecs: string[],
): Promise<import('../types').WaveGitStart | null> {
	const boundary = await resolveGitBoundary(cwd)
	if (!boundary.available) return null

	const predirty: string[] = []
	if (ownedPathspecs.length > 0) {
		const status = await runGit(cwd, ['status', '--porcelain', '-z', '--', ...ownedPathspecs])
		if (status.code === 0) {
			// Porcelain v1 -z: each entry is "XY <path>\0"; renames add an extra "\0<origPath>"
			// which we ignore (we only need the current owned paths reported dirty).
			const tokens = splitNul(status.stdout)
			for (let i = 0; i < tokens.length; i++) {
				const entry = tokens[i]
				if (!entry) continue
				const xy = entry.slice(0, 2)
				const filePath = entry.slice(3)
				// A rename/copy status ('R'/'C' in either column) is followed by the origin path
				// in the next NUL field; skip it.
				if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++
				if (filePath) predirty.push(filePath)
			}
		}
	}

	return {
		start_head: boundary.head,
		predirty,
		captured_at: new Date().toISOString(),
	}
}

interface TempIndex {
	dir: string;
	env: NodeJS.ProcessEnv;
}

// Create an isolated temp index so staging/writing never touches the user's real index. The caller
// MUST await `cleanup()` in a finally block.
async function createTempIndex(cwd: string, base: string | null): Promise<TempIndex & { cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omr-git-index-'))
	const indexFile = path.join(dir, 'index')
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: indexFile }
	// Seed the temp index from the base so that `git add -A` can stage deletions relative to it.
	if (base === null) {
		await runGit(cwd, ['read-tree', '--empty'], { env })
	} else {
		await runGit(cwd, ['read-tree', base], { env })
	}
	return {
		dir,
		env,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true })
		},
	}
}

function mapStatusLetter(letter: string): WaveChangeFile['status'] {
	switch (letter) {
		case 'A': return 'added'
		case 'M': return 'modified'
		case 'D': return 'deleted'
		case 'R': return 'renamed'
		case 'C': return 'renamed'
		case 'T': return 'type_changed'
		default: return 'modified'
	}
}

interface NumstatEntry {
	additions?: number;
	deletions?: number;
	binary: boolean;
}

function parseNumstatZ(output: string): Map<string, NumstatEntry> {
	const tokens = splitNul(output)
	const result = new Map<string, NumstatEntry>()
	for (let i = 0; i < tokens.length; i++) {
		const field = tokens[i]
		if (field === undefined) continue
		const firstTab = field.indexOf('\t')
		const secondTab = field.indexOf('\t', firstTab + 1)
		if (firstTab === -1 || secondTab === -1) continue
		const addRaw = field.slice(0, firstTab)
		const delRaw = field.slice(firstTab + 1, secondTab)
		const pathPart = field.slice(secondTab + 1)
		const binary = addRaw === '-' || delRaw === '-'
		const entry: NumstatEntry = binary
			? { binary: true }
			: { binary: false, additions: Number(addRaw), deletions: Number(delRaw) }
		if (pathPart === '') {
			// rename: <old> then <new> follow as separate NUL fields; key by the new path.
			const newPath = tokens[i + 2]
			i += 2
			if (newPath !== undefined) result.set(newPath, entry)
		} else {
			result.set(pathPart, entry)
		}
	}
	return result
}

interface NameStatusEntry {
	path: string;
	old_path?: string;
	status: WaveChangeFile['status'];
}

function parseNameStatusZ(output: string): NameStatusEntry[] {
	const tokens = splitNul(output)
	const entries: NameStatusEntry[] = []
	for (let i = 0; i < tokens.length; i++) {
		const statusToken = tokens[i]
		if (!statusToken) continue
		const letter = statusToken[0] ?? ''
		if (letter === 'R' || letter === 'C') {
			const oldPath = tokens[i + 1]
			const newPath = tokens[i + 2]
			i += 2
			entries.push({
				path: newPath ?? '',
				...(oldPath !== undefined ? { old_path: oldPath } : {}),
				status: mapStatusLetter(letter),
			})
		} else {
			const filePath = tokens[i + 1]
			i += 1
			entries.push({ path: filePath ?? '', status: mapStatusLetter(letter) })
		}
	}
	return entries
}

// Build an on-demand change package for a wave by diffing the recorded start point against the
// current worktree, scoped to the wave's owned pathspecs. Uses a temp index so previously-untracked
// files show up as additions and the user's real index is never touched. Diffs are NOT persisted.
export async function buildWaveChanges(
	cwd: string,
	startHead: string | null | undefined,
	ownedPathspecs: string[],
): Promise<WaveChangePackage> {
	const boundary = await resolveGitBoundary(cwd)
	if (!boundary.available) {
		return {
			available: false,
			files: [],
			additions: 0,
			deletions: 0,
			warnings: [`Git unavailable: ${boundary.reason ?? 'not a git work tree'}`],
		}
	}

	// null/undefined/unborn all diff against the empty tree.
	const base = startHead ? startHead : null
	const baseTree = base ?? EMPTY_TREE_OID
	const temp = await createTempIndex(cwd, base)
	try {
		if (ownedPathspecs.length > 0) {
			await runGit(cwd, ['add', '-A', '--', ...ownedPathspecs], { env: temp.env })
		}
		const nameStatus = await runGit(cwd, [
			'diff', '--cached', '--name-status', '--find-renames', '-z', baseTree, '--', ...ownedPathspecs,
		], { env: temp.env })
		const numstat = await runGit(cwd, [
			'diff', '--cached', '--numstat', '--find-renames', '-z', baseTree, '--', ...ownedPathspecs,
		], { env: temp.env })

		const statusEntries = parseNameStatusZ(nameStatus.stdout)
		const numstatMap = parseNumstatZ(numstat.stdout)

		const files: WaveChangeFile[] = []
		let totalAdditions = 0
		let totalDeletions = 0

		for (const entry of statusEntries) {
			const stats = numstatMap.get(entry.path)
			const file: WaveChangeFile = {
				path: entry.path,
				status: entry.status,
				...(entry.old_path ? { old_path: entry.old_path } : {}),
			}
			if (stats && !stats.binary) {
				if (stats.additions !== undefined) {
					file.additions = stats.additions
					totalAdditions += stats.additions
				}
				if (stats.deletions !== undefined) {
					file.deletions = stats.deletions
					totalDeletions += stats.deletions
				}
			}
			// Only text files get a patch; binary files (numstat '-'/'-') are metadata-only. If the
			// numstat entry cannot be resolved for a file we cannot confirm it is text, so we treat
			// it as metadata-only and attach no patch rather than risk emitting a "Binary files
			// differ" pseudo-patch.
			if (stats && !stats.binary) {
				const pathspecs = entry.old_path ? [entry.old_path, entry.path] : [entry.path]
				const patch = await runGit(cwd, [
					'diff', '--cached', '--find-renames', baseTree, '--', ...pathspecs,
				], { env: temp.env })
				if (patch.code === 0 && patch.stdout.length > 0) file.patch = patch.stdout
			}
			files.push(file)
		}

		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

		const warnings: string[] = []
		if (files.length === 0) warnings.push('No changes detected in owned pathspecs.')

		return {
			available: true,
			...(base !== null ? { start_head: base } : {}),
			files,
			additions: totalAdditions,
			deletions: totalDeletions,
			warnings,
		}
	} finally {
		await temp.cleanup()
	}
}

export interface CommitWaveCheckpointInput {
	waveId: string;
	waveGoal: string;
	taskIds: string[];
	ownedPathspecs: string[];
	predirty?: string[];
	workflow: 'roadmap' | 'change-request' | 'adhoc';
	roadmapId?: string;
	adhocId?: string;
	milestoneId?: string;
	changeRequestId?: string;
}

const CONTROL_CHARS = /[\0\r\n]/

function assertClean(label: string, value: string | undefined): void {
	if (value !== undefined && CONTROL_CHARS.test(value)) {
		throw new Error(`Wave git checkpoint: ${label} contains an illegal NUL/CR/LF character`)
	}
}

// Trailer lines that both compose the commit message and, as a subset, drive idempotency. Returns
// { workflowTrailers, identity } where identity is the minimal set that uniquely identifies this
// wave checkpoint for the crash-retry HEAD check.
function buildTrailers(input: CommitWaveCheckpointInput): { all: string[]; identity: string[] } {
	const workflowTrailers: string[] = [`OMR-Workflow: ${input.workflow}`]
	const identity: string[] = []

	if (input.workflow === 'roadmap' || input.workflow === 'change-request') {
		if (input.roadmapId !== undefined) {
			const t = `OMR-Roadmap: ${input.roadmapId}`
			workflowTrailers.push(t)
			identity.push(t)
		}
	}
	if (input.workflow === 'adhoc' && input.adhocId !== undefined) {
		const t = `OMR-Adhoc: ${input.adhocId}`
		workflowTrailers.push(t)
		identity.push(t)
	}
	if (input.workflow === 'roadmap' || input.workflow === 'change-request') {
		if (input.milestoneId !== undefined) {
			const t = `OMR-Milestone: ${input.milestoneId}`
			workflowTrailers.push(t)
			identity.push(t)
		}
	}
	if (input.workflow === 'change-request' && input.changeRequestId !== undefined) {
		const t = `OMR-Change-Request: ${input.changeRequestId}`
		workflowTrailers.push(t)
		identity.push(t)
	}

	const waveTrailer = `OMR-Wave: ${input.waveId}`
	const all = [
		...workflowTrailers,
		waveTrailer,
		`OMR-Tasks: ${JSON.stringify(input.taskIds)}`,
	]
	identity.push(waveTrailer)
	return { all, identity }
}

function buildCommitMessage(input: CommitWaveCheckpointInput): { message: string; identity: string[] } {
	const subject = `omr(${input.waveId}): ${input.waveGoal.replace(/\s+/g, ' ').trim()}`
	const { all, identity } = buildTrailers(input)
	return { message: `${subject}\n\n${all.join('\n')}\n`, identity }
}

// Create a post-wave checkpoint commit against a TEMP INDEX so hooks + signing stay authoritative
// and the user's real index/worktree state is untouched. Idempotency is a HEAD trailer check only.
export async function commitWaveCheckpoint(
	cwd: string,
	input: CommitWaveCheckpointInput,
): Promise<import('../types').WaveCheckpoint> {
	const at = new Date().toISOString()

	// Reject control characters in any id/value that would corrupt trailers or split the subject.
	assertClean('wave id', input.waveId)
	assertClean('roadmap id', input.roadmapId)
	assertClean('adhoc id', input.adhocId)
	assertClean('milestone id', input.milestoneId)
	assertClean('change request id', input.changeRequestId)
	for (const taskId of input.taskIds) assertClean('task id', taskId)

	const boundary = await resolveGitBoundary(cwd)
	if (!boundary.available) {
		return { status: 'skipped', reason: `git unavailable: ${boundary.reason ?? 'not a git work tree'}`, warnings: [], at }
	}
	if (boundary.detached) {
		return { status: 'skipped', reason: 'detached HEAD', warnings: [], at }
	}

	const unborn = boundary.head === null
	const { message, identity } = buildCommitMessage(input)

	// 1. Idempotency: if HEAD already carries this wave's identity trailers, a prior run committed
	//    it (crash-retry). Return the existing sha without committing again. Skip when unborn.
	if (!unborn) {
		const headBody = await runGit(cwd, ['log', '-1', '--format=%B', 'HEAD'])
		if (headBody.code === 0) {
			const lines = new Set(headBody.stdout.split('\n').map((line) => line.trim()))
			if (identity.every((line) => lines.has(line))) {
				return {
					status: 'created',
					...(boundary.head ? { commit: boundary.head } : {}),
					warnings: [],
					at,
				}
			}
		}
	}

	// 2. Seed a temp index from HEAD (or empty when unborn) and stage owned adds/mods/deletes/renames.
	const base = unborn ? null : 'HEAD'
	const temp = await createTempIndex(cwd, base)
	try {
		if (input.ownedPathspecs.length > 0) {
			await runGit(cwd, ['add', '-A', '--', ...input.ownedPathspecs], { env: temp.env })
		}

		// 3. Compare the staged tree against the base tree; identical means nothing to commit.
		const writeTree = await runGit(cwd, ['write-tree'], { env: temp.env })
		if (writeTree.code !== 0) {
			throw new Error(`Wave ${input.waveId} git checkpoint failed to write temp index tree: ${writeTree.stderr.trim()}`)
		}
		const stagedTree = writeTree.stdout.trim()
		let baseTree = EMPTY_TREE_OID
		if (!unborn) {
			const headTree = await runGit(cwd, ['rev-parse', 'HEAD^{tree}'])
			if (headTree.code === 0) baseTree = headTree.stdout.trim()
		}
		if (stagedTree === baseTree) {
			return { status: 'no_changes', warnings: [], at }
		}

		// 4. Commit against the temp index. Hooks + signing MUST run: no --no-verify / --no-gpg-sign.
		const commit = await runGit(cwd, ['commit', '-m', message], { env: temp.env })
		if (commit.code !== 0) {
			throw new Error(`Wave ${input.waveId} git checkpoint commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`)
		}

		// 5. Resolve the new commit and its committed paths.
		const newSha = await runGit(cwd, ['rev-parse', 'HEAD'])
		const commitSha = newSha.code === 0 ? newSha.stdout.trim() : undefined

		const names = await runGit(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', 'HEAD'], { env: temp.env })
		const paths = names.code === 0 ? splitNul(names.stdout) : []

		const warnings: string[] = []
		if (input.predirty && input.predirty.length > 0) {
			const predirtySet = new Set(input.predirty)
			const included = paths.filter((p) => predirtySet.has(p))
			if (included.length > 0) {
				warnings.push(`Checkpoint includes pre-existing uncommitted changes in: ${included.join(', ')}`)
			}
		}

		return {
			status: 'created',
			...(commitSha ? { commit: commitSha } : {}),
			paths,
			warnings,
			at,
		}
	} finally {
		await temp.cleanup()
	}
}
