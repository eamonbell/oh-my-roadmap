# Tools

The roadmap-engineer custom tools are registered from `src/main.ts` and implemented in `src/tools/register.ts`.

This package intentionally does not place a `tools/<name>/index.ts` custom-tool factory here because OMP would discover it in addition to the extension factory, creating duplicate tool registrations.
