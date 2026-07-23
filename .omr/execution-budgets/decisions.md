# Decision Register

## Use native handlers for budget slash commands

- Scope: roadmap
- Material: yes
- Approved by user: User explicitly chose native command handlers after reviewing prompt-backed versus native tradeoffs, retained the approved slash-command surface, selected one-dimension set semantics, default-user audit identity, and required all ceiling increases to use overrides.
- At: 2026-07-22T23:35:47.784Z

For ms-operator-surface, retain the approved /omr:budget-show, /omr:budget-set, and /omr:budget-override names, but implement them as native extension command handlers rather than prompt-backed commands. Remove the roadmap's command-prompt-template deliverable. This keeps the operator surface deterministic and immediate while preserving the approved slash-command scope. /omr:budget-set changes one dimension per call, may create/lower/clear ceilings, and rejects increases; increases require the audited /omr:budget-override raise path. Override audit defaults granted_by to `user` when no actor is supplied and requires a non-empty reason. Status, usage, and automatic findings-report budget surfacing remain in scope.
