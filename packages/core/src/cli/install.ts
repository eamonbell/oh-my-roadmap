import {spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {fileExists, readText, writeText} from '../files'
import {activeProfileFromEnv, ompPluginRoot, validateProfileName} from '../omp-paths'

// The published OMP extension package. OMP's plugin loader unions each plugin
// root's package.json#dependencies with its lockfile, so declaring the dependency
// and running an install is enough for OMP to auto-discover the extension.
export const EXTENSION_PACKAGE = '@oh-my-roadmap/plugin'

export type InstallScope = 'global' | 'project';

export interface InstallResult {
	scope: InstallScope;
	root: string;
	packageJsonPath: string;
	spec: string;
}

// A runner performs the actual dependency install in `root`. Injected in tests.
export type InstallRunner = (root: string) => Promise<void>;

// Global (user) plugins: <ompRoot>/plugins (top-level, e.g. ~/.omp/plugins, or
// ~/.omp/profiles/<profile>/plugins for a profile). Project plugins: <cwd>/.omp/plugins.
// A missing global profile falls back to the ambient OMP profile from the env.
export function resolvePluginRoot(scope: InstallScope, opts: { cwd: string; homeDir?: string | undefined; profile?: string | undefined }): string {
	if (scope === 'project') return path.join(opts.cwd, '.omp', 'plugins')
	const profile = opts.profile ?? activeProfileFromEnv()
	return ompPluginRoot({homeDir: opts.homeDir, profile})
}

async function ensureRootPackageJson(root: string): Promise<string> {
	const pkgPath = path.join(root, 'package.json')
	if (!(await fileExists(pkgPath))) {
		await writeText(pkgPath, `${JSON.stringify({name: 'omp-plugins', private: true, dependencies: {}}, null, 2)}\n`)
	}
	return pkgPath
}

// Merge the extension into the plugin root's package.json dependencies, preserving
// any other plugins already installed there.
export async function writePluginDependency(root: string, spec: string): Promise<string> {
	const pkgPath = await ensureRootPackageJson(root)
	const pkg = JSON.parse(await readText(pkgPath)) as { dependencies?: Record<string, string> } & Record<string, unknown>
	pkg.dependencies = {...pkg.dependencies, [EXTENSION_PACKAGE]: spec}
	await writeText(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
	return pkgPath
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {cwd, stdio: 'inherit'})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'null'}`))
		})
	})
}

// Prefer bun (OMP's own installer uses it); fall back to npm only when bun is absent.
const defaultRunner: InstallRunner = async (root) => {
	try {
		await runCommand('bun', ['install'], root)
		return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	await runCommand('npm', ['install'], root)
}

export async function installExtension(opts: {
	scope: InstallScope;
	cwd: string;
	profile?: string | undefined;
	homeDir?: string | undefined;
	spec?: string | undefined;
	runner?: InstallRunner | undefined;
}): Promise<InstallResult> {
	if (opts.profile !== undefined) validateProfileName(opts.profile)
	const root = resolvePluginRoot(opts.scope, opts)
	await fs.mkdir(path.join(root, 'node_modules'), {recursive: true})
	const spec = opts.spec ?? 'latest'
	const packageJsonPath = await writePluginDependency(root, spec)
	await (opts.runner ?? defaultRunner)(root)
	return {scope: opts.scope, root, packageJsonPath, spec}
}
