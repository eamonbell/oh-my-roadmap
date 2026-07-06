#!/usr/bin/env bun
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

// Publish order: core first (extension/cli depend on it). All packages ship at the same
// version — set it with `bun run release <version>` before deploying. `bun publish`
// substitutes the internal `workspace:*` deps with that concrete version at pack time
// (which `npm publish` cannot), and reads auth from the NPM_CONFIG_TOKEN env var.
const PACKAGE_DIRS = ['packages/core', 'packages/extension', 'packages/cli'] as const

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

for (const arg of args) {
	if (arg !== '--dry-run') {
		process.stderr.write(`Unknown option: ${arg}\n`)
		process.stderr.write('Usage: bun run deploy [--dry-run]\n')
		process.exit(1)
	}
}

interface PackageManifest {
	name: string
	version: string
}

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): void {
	process.stdout.write(`$ ${[command, ...commandArgs].join(' ')}\n`)
	execFileSync(command, commandArgs, {stdio: 'inherit', env})
}

function readPackageManifest(packageDir: string): PackageManifest {
	const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Partial<PackageManifest>
	if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
		throw new Error(`${packageDir}/package.json must include string name and version`)
	}
	return {name: manifest.name, version: manifest.version}
}

// A public package version already on the registry — `npm view` needs no auth.
function isPublished(manifest: PackageManifest): boolean {
	try {
		execFileSync('npm', ['view', `${manifest.name}@${manifest.version}`, 'version'], {stdio: 'ignore'})
		return true
	} catch {
		return false
	}
}

function resolveToken(): string | undefined {
	const token = (process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN)?.trim()
	if (token !== undefined && token !== '') return token
	if (dryRun) return undefined
	process.stderr.write('NPM_TOKEN or NODE_AUTH_TOKEN must be set for publish.\n')
	process.exit(1)
}

const token = resolveToken()
// bun reads registry auth from NPM_CONFIG_TOKEN (workspace-root scope). No secret is
// written to disk. Runs from the repo root; `--cwd` selects the package to publish.
const env: NodeJS.ProcessEnv = token === undefined ? process.env : {...process.env, NPM_CONFIG_TOKEN: token}

run('bun', ['run', 'verify'], env)
run('bun', ['run', 'build'], env)

for (const packageDir of PACKAGE_DIRS) {
	const manifest = readPackageManifest(packageDir)
	if (isPublished(manifest)) {
		process.stdout.write(`${manifest.name}@${manifest.version} already exists; skipping.\n`)
		continue
	}
	if (dryRun) {
		// Tokenless validation of the tarball (files filter + `workspace:*` substitution).
		run('bun', ['pm', 'pack', '--dry-run', '--cwd', packageDir], env)
		continue
	}
	run('bun', ['publish', '--cwd', packageDir, '--access', 'public'], env)
}
