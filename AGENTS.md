## Project Guidance for AI Coding Agents

Keep the codebase simple, direct, and maintainable. Favor readable, obvious code over clever
abstractions or speculative architecture.

The primary rule: **build only what was asked for, in the simplest form that solves the problem well.**

## Core Engineering Principles

### Keep It Simple

- Prefer straightforward code over clever code.
- Do not introduce patterns, frameworks, abstractions, or helpers unless they clearly reduce complexity.
- Avoid designing for hypothetical future requirements.
- Do not add configurability, extension points, hooks, plugins, or generic systems unless explicitly requested.
- When there are multiple reasonable approaches, choose the one that is easiest to read and maintain.

Before adding complexity, ask:

> Would a senior engineer say this is overcomplicated?

If yes, simplify.

## Scope Control

### Build Only What Was Requested

- Do not add features beyond the request.
- Do not implement adjacent functionality because it seems useful.
- Do not create reusable systems for code that is only used once.
- Do not add defensive behavior for scenarios that cannot happen in the current design.

If a request is narrow, the implementation should stay narrow.

## Abstraction Rules

### Avoid Unnecessary Abstraction

- Do not create abstractions for single-use code.
- Do not introduce service layers, factories, managers, providers, registries, or builders without a concrete need.

Prefer concrete types and direct function calls.

When there is only one implementation and no meaningful boundary, use the concrete type directly.

## File Organization

### Keep Files Focused and Short

- Keep files under 200 lines when practical.
- Split large files by responsibility, not by arbitrary categories.
- Avoid files that mix unrelated concerns.
- If a file grows because a type has too many responsibilities, simplify the type before splitting files.
- Do not create many tiny files that make navigation harder.

A file over 200 lines is acceptable only when splitting it would reduce clarity.

## Function Design

### Prefer Small, Direct Functions

- Functions should do one clear thing.
- Avoid deeply nested logic.
- Do not extract a helper unless it improves readability or removes real duplication.
- Do not create helper functions just to make code look abstractly “clean.”

If a function can be 50 lines instead of 200, rewrite it.

## Final Standard

The best solution is usually boring: small, clear, direct, and easy to change when real requirements appear.

Do not optimize for imagined future flexibility. Optimize for correctness, readability, and the current request.