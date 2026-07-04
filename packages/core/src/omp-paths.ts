import * as os from 'node:os'
import * as path from 'node:path'

// OMP profile model (verified against the OMP binary):
//   A profile swaps the base config root. Everything (plugins, agents, our omr
//   config) hangs off that root:
//     resolveOmpRoot(profile) = profile ? <base>/profiles/<profile> : <base>
//       where <base> = $PI_CONFIG_DIR || ~/.omp
//   The active profile is exposed to a running process (the OMP extension) via the
//   OMP_PROFILE env var, falling back to PI_PROFILE.

// Env vars OMP uses to signal the active profile, in precedence order.
const PROFILE_ENV_VARS = ['OMP_PROFILE', 'PI_PROFILE'] as const

// OMP's profile-name rules: lowercase alnum start, then alnum/._- up to 64 chars.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
// Windows reserved device names (with or without an extension), case-insensitive.
const RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i

export type OmpScope = 'project' | 'global';

// Options shared by the global path resolvers. `profile` undefined means the base
// root; callers that want the ambient profile pass `activeProfileFromEnv()`.
export interface OmpRootOptions {
	homeDir?: string | undefined;
	profile?: string | undefined;
}

// Validate a profile name against OMP's rules, returning the trimmed name.
// Throws with an actionable message when invalid.
export function validateProfileName(name: string): string {
	const trimmed = name.trim()
	if (
		!trimmed
		|| trimmed === 'default'
		|| trimmed === '.'
		|| trimmed === '..'
		|| trimmed.endsWith('.')
		|| !PROFILE_NAME_RE.test(trimmed)
		|| RESERVED_NAME_RE.test(trimmed)
	) {
		throw new Error(
			`Invalid OMP profile "${name}". Names must match ${PROFILE_NAME_RE.source}, ` +
			'cannot be "." "..", "default", cannot end with ".", and cannot be a reserved device name ' +
			'(CON, PRN, AUX, NUL, COM0-9, LPT0-9).',
		)
	}
	return trimmed
}

// The active profile, read from OMP_PROFILE (then PI_PROFILE). Returns undefined
// when neither is set. Validates so a malformed env value fails loudly.
export function activeProfileFromEnv(): string | undefined {
	for (const key of PROFILE_ENV_VARS) {
		const raw = process.env[key]
		if (raw && raw.trim()) return validateProfileName(raw)
	}
	return undefined
}

// Base OMP config directory name, honoring PI_CONFIG_DIR (default `.omp`).
function configDirName(): string {
	return process.env.PI_CONFIG_DIR || '.omp'
}

// The OMP root for a scope+profile. A profile relocates the whole root under
// `profiles/<profile>`; the base root is otherwise `<home>/<PI_CONFIG_DIR>`.
export function resolveOmpRoot(opts: OmpRootOptions = {}): string {
	const home = opts.homeDir ?? os.homedir()
	const base = path.join(home, configDirName())
	return opts.profile ? path.join(base, 'profiles', opts.profile) : base
}

// Global plugin root (where the OMP extension is installed): `<root>/plugins`.
export function ompPluginRoot(opts: OmpRootOptions = {}): string {
	return path.join(resolveOmpRoot(opts), 'plugins')
}

// Global agents directory OMP discovers user agents from: `<root>/agent/agents`.
export function ompAgentsDir(opts: OmpRootOptions = {}): string {
	return path.join(resolveOmpRoot(opts), 'agent', 'agents')
}

// Our omr global config directory: `<root>/oh-my-roadmap`.
export function ompOmrConfigDir(opts: OmpRootOptions = {}): string {
	return path.join(resolveOmpRoot(opts), 'oh-my-roadmap')
}

// Resolve the effective scope + profile from parsed CLI flags.
//   - --global and --project are mutually exclusive.
//   - --profile applies only to global scope (profiles are a user-level concept);
//     combining it with --project is an error.
//   - a bare --profile implies --global.
// Returns the validated profile (or undefined) and the resolved scope. When the
// scope is global and no explicit profile is given, the caller's downstream
// resolvers apply the ambient profile from the environment.
export function resolveScopeAndProfile(flags: {
	global?: boolean | undefined;
	project?: boolean | undefined;
	profile?: string | undefined;
}): { scope: OmpScope; profile: string | undefined } {
	if (flags.global && flags.project) {
		throw new Error('Choose either --global or --project, not both.')
	}
	if (flags.project && flags.profile) {
		throw new Error('--profile applies only to the global scope; drop --project or --profile.')
	}
	const profile = flags.profile !== undefined ? validateProfileName(flags.profile) : undefined
	const scope: OmpScope = flags.global ? 'global' : flags.project ? 'project' : profile ? 'global' : 'project'
	return {scope, profile: scope === 'global' ? profile : undefined}
}
