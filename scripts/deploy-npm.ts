#!/usr/bin/env bun
import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

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

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
	process.stdout.write(`$ ${[command, ...args].join(' ')}\n`)
	execFileSync(command, args, {
		stdio: 'inherit',
		env,
	})
}

function readPackageManifest(packageDir: string): PackageManifest {
	const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Partial<PackageManifest>
	if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
		throw new Error(`${packageDir}/package.json must include string name and version`)
	}
	return {name: manifest.name, version: manifest.version}
}

function isPublished(manifest: PackageManifest, env: NodeJS.ProcessEnv): boolean {
	try {
		execFileSync('npm', ['view', `${manifest.name}@${manifest.version}`, 'version'], {
			stdio: 'ignore',
			env,
		})
		return true
	} catch {
		return false
	}
}

function createNpmUserConfig(): string | undefined {
	const token = (process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN)?.trim()
	if (token === undefined || token === '') {
		if (dryRun) {
			return undefined
		}
		process.stderr.write('NPM_TOKEN or NODE_AUTH_TOKEN must be set for npm publish.\n')
		process.exit(1)
	}

	const dir = mkdtempSync(join(tmpdir(), 'oh-my-roadmap-npm-'))
	const userConfig = join(dir, '.npmrc')
	writeFileSync(
		userConfig,
		`registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`,
		{mode: 0o600},
	)
	return userConfig
}

let userConfig: string | undefined
try {
	userConfig = createNpmUserConfig()
	const env = userConfig === undefined ? process.env : {...process.env, NPM_CONFIG_USERCONFIG: userConfig}

	run('bun', ['run', 'verify'], env)
	run('bun', ['run', 'build'], env)

	if (!dryRun) {
		run('npm', ['whoami'], env)
	}

	for (const packageDir of PACKAGE_DIRS) {
		const manifest = readPackageManifest(packageDir)
		if (isPublished(manifest, env)) {
			process.stdout.write(`${manifest.name}@${manifest.version} already exists; skipping.\n`)
			continue
		}

		const publishArgs = ['publish', `./${packageDir}`, '--access', 'public']
		if (dryRun) {
			publishArgs.push('--dry-run')
		}
		run('npm', publishArgs, env)
	}
} finally {
	if (userConfig !== undefined) {
		rmSync(dirname(userConfig), {recursive: true, force: true})
	}
}
