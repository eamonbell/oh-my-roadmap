import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Minimal, hermetic git fixture for the git-engine tests. All identity/config is LOCAL to the
// created repo (never global), and nothing touches the network. Callers must remove() in afterEach.

export interface GitRepoFixture {
	cwd: string;
	git(...args: string[]): { code: number; stdout: string; stderr: string };
	writeFile(relPath: string, contents: string): void;
	removeFile(relPath: string): void;
	stageAll(): void;
	commitAll(message: string): void;
	head(): string;
	writeTree(): string;
	installPreCommitHook(script: string): void;
	remove(): void;
}

function run(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
	return {
		code: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	}
}

// Create a fresh repo with deterministic local identity and signing disabled. `initialCommit:false`
// leaves the branch unborn (no commits) for testing that path.
export function createGitRepo(opts: { initialCommit?: boolean } = {}): GitRepoFixture {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-git-fixture-'))
	run(cwd, ['-c', 'init.defaultBranch=main', 'init'])
	run(cwd, ['config', 'user.email', 'test@example.com'])
	run(cwd, ['config', 'user.name', 'Test'])
	run(cwd, ['config', 'commit.gpgsign', 'false'])
	// Guarantee a deterministic branch name even on older git that ignores -c init.defaultBranch.
	run(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

	const fixture: GitRepoFixture = {
		cwd,
		git: (...args: string[]) => run(cwd, args),
		writeFile(relPath: string, contents: string) {
			const full = path.join(cwd, relPath)
			fs.mkdirSync(path.dirname(full), { recursive: true })
			fs.writeFileSync(full, contents)
		},
		removeFile(relPath: string) {
			fs.rmSync(path.join(cwd, relPath), { force: true })
		},
		stageAll() {
			run(cwd, ['add', '-A'])
		},
		commitAll(message: string) {
			run(cwd, ['add', '-A'])
			const result = run(cwd, ['commit', '-m', message])
			if (result.code !== 0) {
				throw new Error(`fixture commit failed: ${result.stderr || result.stdout}`)
			}
		},
		head() {
			return run(cwd, ['rev-parse', 'HEAD']).stdout.trim()
		},
		writeTree() {
			return run(cwd, ['write-tree']).stdout.trim()
		},
		installPreCommitHook(script: string) {
			const hooksDir = path.join(cwd, '.git', 'hooks')
			fs.mkdirSync(hooksDir, { recursive: true })
			const hookPath = path.join(hooksDir, 'pre-commit')
			fs.writeFileSync(hookPath, script)
			fs.chmodSync(hookPath, 0o755)
		},
		remove() {
			fs.rmSync(cwd, { recursive: true, force: true })
		},
	}

	if (opts.initialCommit) {
		fixture.writeFile('README.md', '# fixture\n')
		fixture.commitAll('initial commit')
	}

	return fixture
}
