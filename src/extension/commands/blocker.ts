import type {CustomCommandAPI, RegisteredCommand} from '@oh-my-pi/pi-coding-agent'
import type {AutocompleteItem} from '@oh-my-pi/pi-tui'
import {ExtensionCommandContext} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'

/*
export function registerGreet(pi: CustomCommandAPI): {
	name: string,
	options: { description?: string, getArgumentCompletions?: RegisteredCommand['getArgumentCompletions'], handler: RegisteredCommand['handler'] }
} {
	return {
		name: 'omr-greet', options: {
			description: 'Do the thing',
			getArgumentCompletions: (): AutocompleteItem[] => {
				return [
					{
						label: 'one',
						value: 'one',
						description: 'one',
						hint: 'one'
					}
				]
			},
			async(args: string[], ctx: ExtensionCommandContext) {
				/!*const range = args[0] || "HEAD~10..HEAD";
				const log = await pi.exec("git", ["log", "--oneline", range], {
					cwd: pi.cwd,
				});
				if (log.code !== 0) {
					ctx.ui.notify("git log failed: " + log.stderr, "error");
					return;
				}*!/

				return `Say hello to the user ${args[0]} time(s)`
			},
		}
	}
}*/
