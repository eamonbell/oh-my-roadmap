#!/usr/bin/env bun
// Stamp one shared version across every package in the monorepo. All packages publish
// together at the same version; internal deps use the `workspace:*` protocol (resolved
// to this version at publish time), so only each manifest's top-level `version` field
// needs updating — there are no internal version refs to keep in sync.
//
// Usage: bun run release <version>   e.g. bun run release 1.4.1
import {execFileSync} from 'node:child_process'
import {readFileSync, rmSync, writeFileSync} from 'node:fs'

const version = process.argv[2]?.trim()
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
	process.stderr.write('Usage: bun run release <version>   e.g. bun run release 1.4.1\n')
	process.exit(1)
}

const MANIFESTS = [
	'package.json',
	'packages/core/package.json',
	'packages/cli/package.json',
	'packages/extension/package.json',
] as const

for (const file of MANIFESTS) {
	const text = readFileSync(file, 'utf8')
	// Only the top-level (single-tab-indented) `version` field; deps carry no version keys.
	const updated = text.replace(/^(\t"version":\s*")[^"]+(")/m, `$1${version}$2`)
	if (updated === text) {
		process.stderr.write(`No top-level version field updated in ${file}\n`)
		process.exit(1)
	}
	writeFileSync(file, updated)
	process.stdout.write(`  ${file} -> ${version}\n`)
}

// Regenerate the lockfile so its recorded workspace versions match — `bun publish`
// substitutes `workspace:*` from the lockfile, and a plain `bun install` does not
// refresh workspace package versions, so a clean regen is required for correctness.
process.stdout.write('Regenerating bun.lock...\n')
rmSync('bun.lock', {force: true})
execFileSync('bun', ['install'], {stdio: 'inherit'})
process.stdout.write(`\nAll packages set to ${version}. Review the diff, then \`bun run deploy\`.\n`)
